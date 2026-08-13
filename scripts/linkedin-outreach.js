// scripts/linkedin-outreach.js — Phase 3: the machine's outbound arm.
//
// Picks fresh leads from Neon (status 'new', oldest first) and sends them a
// personalized LinkedIn connection request (or DM when already connected)
// with human-mimicking pacing and a HARD daily cap. Every successful send
// flips the lead to 'contacted' and appends a lead_events 'outreach_sent'
// row in one transaction.
//
// Safety (the non-negotiables):
//   • HARD daily cap — default 15 (scripts/linkedin-config.json), overridable
//     with LINKEDIN_DAILY_CAP. Persisted per-day in scripts/.linkedin-run-state.json
//     (gitignored) AND cross-checked against today's lead_events count in the
//     DB; the run uses the MAX of the two, so a crash between DB write and
//     state-file write (or a deleted state file) can never push past the cap.
//   • Human pacing — random 15–45s between actions (config), 2–5s before
//     hitting Send. Delays apply in real mode only.
//   • Dry-run everywhere by default — no creds on this machine, so this phase
//     ships verified dry-run + unit tests. Real mode refuses to run without
//     LINKEDIN_EMAIL / LINKEDIN_PASSWORD (or LINKEDIN_SESSION_DIR).
//   • Kill switch — LINKEDIN_DRY_RUN=1 forces dry-run even if flags say real.
//   • Credentials come from env or a saved-session path ONLY; never in code.
//
// Usage:
//   node scripts/linkedin-outreach.js [options]
//
// Options:
//   --dry-run            build + print the action plan; NO login, NO send,
//                        NO state/DB writes (still reads the DB + state file)
//   --limit N            act on at most N leads (smoke tests: --limit 3;
//                        still capped by the daily budget)
//   --status S           lead status filter (default: config status_filter,
//                        normally 'new')
//   --config PATH        config file (default: scripts/linkedin-config.json)
//   --state PATH         state file (default: config state_file)
//   --verbose            per-lead detail
//   -h, --help           this help
//
// Env:
//   DATABASE_URL          Neon connection string (required, dry-run included)
//   LINKEDIN_EMAIL        account email (real mode only)
//   LINKEDIN_PASSWORD     account password (real mode only)
//   LINKEDIN_SESSION_DIR  saved persistent browser context (alternative to
//                         email/password — log in once by hand, reuse session)
//   LINKEDIN_DAILY_CAP    override the daily cap
//   LINKEDIN_DRY_RUN=1    kill switch: forces dry-run
//   LINKEDIN_STATE_FILE   override the state-file path
//   PLAYWRIGHT_BROWSERS_PATH  where Playwright browsers live (see README)
//   DEEPSEEK_API_KEY      OPTIONAL Phase 4: enables AI personalization of the
//                         message (scripts/ai.js). Only used in REAL mode —
//                         dry-run always uses the deterministic templates,
//                         so previews stay fast, free, and stable. Without
//                         the key (or on API error/timeout) the rendered
//                         template is used — the run never fails on AI.
//
// Exit codes: 0 = ran (even if some sends failed), 1 = fatal (no creds /
//             missing DATABASE_URL / DB down), 2 = bad usage.
//
// ⚠ LinkedIn ToS: automated outreach violates LinkedIn's User Agreement and
// can get the account restricted/banned. This script is the owner's
// decision-to-be; it ships dry-run + tests ONLY (see scripts/README.md).
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { chromium } = require('playwright');
const core = require('./linkedin-core');

const SCRIPT_DIR = __dirname;
const DEFAULT_CONFIG = path.join(SCRIPT_DIR, 'linkedin-config.json');
const DEFAULT_TEMPLATES = path.join(SCRIPT_DIR, 'linkedin-templates.json');

// ---------------------------------------------------------------------------
// Env / config plumbing (dependency-light; no dotenv — mirrors extract-leads)
// ---------------------------------------------------------------------------
function loadEnvFile(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
function parseArgs(argv) {
  const opts = {
    dryRun: false, limit: null, status: null, config: DEFAULT_CONFIG,
    state: null, templates: DEFAULT_TEMPLATES, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--limit': opts.limit = parseInt(next(), 10); break;
      case '--status': opts.status = next(); break;
      case '--config': opts.config = next(); break;
      case '--state': opts.state = next(); break;
      case '--templates': opts.templates = next(); break;
      case '--verbose': opts.verbose = true; break;
      case '-h': case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 55).join('\n'));
        process.exit(0);
      default:
        console.error(`Unknown option: ${a} (see --help)`);
        process.exit(2);
    }
  }
  return opts;
}
function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`FATAL: cannot read ${p}: ${err.message}`);
    process.exit(1);
  }
}
function connectPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('FATAL: DATABASE_URL is not set (see scripts/.env.example). Dry-run reads the DB too.');
    process.exit(1);
  }
  const u = new URL(dbUrl);
  u.searchParams.delete('channel_binding');
  u.searchParams.delete('sslmode');
  return new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
}

// ---------------------------------------------------------------------------
// Human-mimicking pacing + retry/backoff (real mode only)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

async function withRetry(fn, retries, baseMs, label) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoff = baseMs * (2 ** attempt) + randInt(0, 1500);
        console.log(`  ↻ ${label} failed (${err.message}) — retry ${attempt + 1}/${retries} in ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// LinkedIn actions (real mode; NEVER executed this phase — selectors are
// best-effort scaffolding and MUST be verified against live LinkedIn before
// enabling; see scripts/README.md account-safety notes)
// ---------------------------------------------------------------------------
const LI_SELECTORS = {
  results: 'li.reusable-search__result-container',
  resultName: '.app-aware-link span[aria-hidden="true"], .entity-result__title-text',
  connectButton: 'button[aria-label*="Connect" i]',
  addNote: 'button[aria-label="Add a note"]',
  noteTextarea: 'textarea#custom-message, textarea[name="message"]',
  sendNow: 'button[aria-label="Send now"]',
  messageButton: 'button[aria-label*="Message" i], button:has-text("Message")',
  dmBox: 'div.msg-form__contenteditable',
  dmSend: 'button.msg-form__send-button',
};

async function findProfile(page, lead) {
  const q = `${lead.business_name} ${lead.city}`.trim();
  await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`, {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForSelector(LI_SELECTORS.results, { timeout: 30000 });
  const firstToken = String(lead.business_name).toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
  const results = page.locator(LI_SELECTORS.results);
  const n = await results.count();
  for (let i = 0; i < Math.min(n, 5); i++) {
    const name = (await results.nth(i).innerText().catch(() => '')).toLowerCase();
    if (!firstToken || name.includes(firstToken)) {
      const link = results.nth(i).locator('a[href*="/in/"]').first();
      await link.click();
      await page.waitForLoadState('domcontentloaded');
      return true;
    }
  }
  return false; // no plausible match — caller treats as "skip, don't burn a cap slot"
}

async function sendConnectionRequest(page, message) {
  // Connect with note
  const connect = page.locator(LI_SELECTORS.connectButton).first();
  await connect.click();
  await page.waitForSelector(LI_SELECTORS.addNote, { timeout: 15000 });
  await page.locator(LI_SELECTORS.addNote).click();
  const note = page.locator(LI_SELECTORS.noteTextarea).first();
  await note.waitFor({ state: 'visible', timeout: 15000 });
  await note.fill(message);
  await page.locator(LI_SELECTORS.sendNow).first().click();
  return 'connect';
}

async function sendDirectMessage(page, message) {
  const dm = page.locator(LI_SELECTORS.dmBox).first();
  await dm.waitFor({ state: 'visible', timeout: 20000 });
  await dm.click();
  await page.keyboard.type(message, { delay: randInt(12, 40) });
  await page.locator(LI_SELECTORS.dmSend).first().click();
  return 'dm';
}

// One lead, one action: find profile → connect (with note) or DM if already
// connected. Returns the action performed.
async function sendOutreach(page, lead, message, cfg) {
  const found = await withRetry(() => findProfile(page, lead), cfg.retries, cfg.retry_base_ms, `search ${lead.business_name}`);
  if (!found) throw new Error('no matching LinkedIn profile found');
  await sleep(randInt(cfg.send_delay_min_sec, cfg.send_delay_max_sec) * 1000);
  const connectVisible = await page.locator(LI_SELECTORS.connectButton).first().isVisible().catch(() => false);
  const messageVisible = await page.locator(LI_SELECTORS.messageButton).first().isVisible().catch(() => false);
  if (connectVisible) return sendConnectionRequest(page, message);
  if (messageVisible) return sendDirectMessage(page, message);
  throw new Error('neither Connect nor Message available (already connected / pending?)');
}

// ---------------------------------------------------------------------------
// State file persistence (atomic: write tmp + rename)
// ---------------------------------------------------------------------------
function readState(p) {
  try {
    return core.parseState(fs.readFileSync(p, 'utf8'));
  } catch {
    return core.parseState(''); // missing file = fresh day
  }
}
function writeState(p, state) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  loadEnvFile(path.join(SCRIPT_DIR, '.env'));
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadJson(opts.config);
  const templates = loadJson(opts.templates);

  // Precedence: flag > kill-switch env > config
  const dryRun = opts.dryRun || process.env.LINKEDIN_DRY_RUN === '1';
  const cap = parseInt(process.env.LINKEDIN_DAILY_CAP, 10) || cfg.daily_cap;
  const statusFilter = opts.status || cfg.status_filter;
  const statePath = opts.state
    || process.env.LINKEDIN_STATE_FILE
    || path.resolve(SCRIPT_DIR, cfg.state_file);
  const batchLabel = `linkedin-${core.todayStr()}`;

  console.log(`LinkedIn outreach — cap ${cap}/day, filter: ${statusFilter}, dry-run: ${dryRun}`);
  console.log(`                  state: ${statePath}`);
  if (dryRun) console.log('                  ⚠ DRY RUN — no login, no sends, no writes');

  const pool = connectPool();
  const client = await pool.connect();
  const q = client.query.bind(client);
  let plan = [];
  let state = null;
  let used = 0;
  try {
    // --- cap check: max(state file for today, DB events for today) ---
    state = readState(statePath);
    const dbToday = await core.countOutreachSentToday(q, core.todayStr());
    used = core.usedToday(state, dbToday);
    const remaining = core.remainingToday(state, dbToday, cap);
    console.log(`                  already sent today: ${used} (state ${state.date === core.todayStr() ? state.sent : 'stale'} + DB ${dbToday}); budget left: ${remaining}`);

    // --- fetch fresh leads, oldest first, up to the cap (fetch a little
    //     extra so the report can show how many the cap held back) ---
    const fetchN = Math.max(remaining, opts.limit ?? 0, 1);
    const pending = await core.fetchPendingLeads(q, statusFilter, fetchN);
    const allowed = core.planSize(remaining, opts.limit);
    const targets = pending.slice(0, allowed);

    // --- Phase 4 hook: AI personalization (scripts/ai.js). Only in real
    //     mode with a key — dry-run always renders deterministic templates
    //     (fast, free, stable previews). The hook is called per lead as
    //     (lead, message) => message and every failure inside it falls back
    //     to the rendered template, so this can never break a run. ---
    const planOpts = { noteMaxChars: templates.note_max_chars };
    if (process.env.DEEPSEEK_API_KEY && !dryRun) {
      const ai = require('./ai');
      planOpts.personalize = (lead, msg) => ai.personalizeLead(lead, msg, { verbose: opts.verbose });
      console.log('                  AI personalization: ON (DEEPSEEK_API_KEY set)');
    } else if (dryRun) {
      console.log('                  AI personalization: off (dry-run — deterministic templates)');
    } else {
      console.log('                  AI personalization: off (no DEEPSEEK_API_KEY — deterministic templates)');
    }
    plan = await core.buildPlan(targets, templates.templates, planOpts);

    if (dryRun) {
      console.log(`\n================= ACTION PLAN (dry run) =================`);
      console.log(`Leads in '${statusFilter}': ${pending.length} fetched | cap allows ${allowed} | plan: ${plan.length}`);
      for (const [i, item] of plan.entries()) {
        const l = item.lead;
        console.log(`\n[${i + 1}/${plan.length}] lead #${l.id} — ${l.business_name} (${l.city}, ${l.niche || 'n/a'})`);
        console.log(`    status: ${l.status} → contacted | variant: ${item.variant} | action: connect (or dm if connected)`);
        console.log(`    message (${item.message.length} chars): ${item.message}`);
      }
      if (pending.length > allowed) {
        console.log(`\n  ⏸ ${pending.length - allowed} lead(s) held back by the daily cap (would be picked up on the next day's run).`);
      }
      console.log(`\nDRY RUN — nothing was sent, no status changes, no events, state file untouched.`);
      return 0;
    }

    // --- real mode: credentials gate ---
    const hasSession = !!process.env.LINKEDIN_SESSION_DIR;
    const hasCreds = !!process.env.LINKEDIN_EMAIL && !!process.env.LINKEDIN_PASSWORD;
    if (!hasSession && !hasCreds) {
      console.error('FATAL: real mode needs credentials. Set LINKEDIN_EMAIL + LINKEDIN_PASSWORD, or LINKEDIN_SESSION_DIR (saved browser session). Refusing to run — use --dry-run to preview the plan.');
      return 1;
    }
    if (plan.length === 0) {
      console.log('No leads within today\'s budget — nothing to do. Exiting cleanly.');
      return 0;
    }

    const browser = hasSession
      ? await chromium.launchPersistentContext(process.env.LINKEDIN_SESSION_DIR, { headless: cfg.headless })
      : await chromium.launch({ headless: cfg.headless });
    try {
      const page = hasSession ? browser.pages()[0] || await browser.newPage() : await browser.newPage();
      let sent = 0, failed = 0, lastState = state;
      for (const [i, item] of plan.entries()) {
        const l = item.lead;
        console.log(`\n[${i + 1}/${plan.length}] lead #${l.id} — ${l.business_name} (${l.city})`);
        try {
          const action = await withRetry(
            () => sendOutreach(page, l, item.message, cfg),
            cfg.retries, cfg.retry_base_ms, `outreach ${l.business_name}`
          );
          const res = await core.markContacted(q, l.id, l.status, {
            channel: 'linkedin',
            template: item.variant,
            action,
            message: item.message.slice(0, 80),
            sent_at: new Date().toISOString(),
          });
          if (!res.updated) {
            console.log(`  ⚠ lead #${l.id} already advanced by another process — skipped (no double-send accounting)`);
            continue;
          }
          lastState = core.consumeState(lastState, 1, [String(l.id)]);
          writeState(statePath, lastState); // persist after EVERY send (crash-safe cap)
          sent += 1;
          console.log(`  ✓ ${action} sent (event #${res.eventId}); state now ${lastState.sent}/${cap} for ${lastState.date}`);
        } catch (err) {
          failed += 1;
          console.log(`  ✗ failed — ${err.message} (lead left '${l.status}', cap slot NOT consumed)`);
        }
        if (i < plan.length - 1) {
          const d = randInt(cfg.delay_min_sec, cfg.delay_max_sec);
          console.log(`  … pacing: ${d}s until next action`);
          await sleep(d * 1000);
        }
      }
      console.log(`\n================= OUTREACH SUMMARY =================`);
      console.log(`sent ${sent}, failed ${failed}, budget used ${lastState.sent}/${cap} for ${lastState.date}`);
      console.log(`state file: ${statePath}`);
      return sent > 0 ? 0 : 1;
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => {
    console.error('Outreach failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
