#!/usr/bin/env node
/**
 * scripts/extract-leads.js — Phase 2: automated lead extraction (Google Maps)
 *
 * Headless Playwright sweep of Google Maps for local service businesses with
 * missing or weak websites, upserted into the Neon `leads` table with a
 * `lead_created` event per NEW lead. This is the machine's continuous
 * lead-gen: a GitHub Actions cron (see .github/workflows/lead-sweep.yml)
 * runs it every Monday, and humans can fire it on-demand via
 * `workflow_dispatch` or locally.
 *
 * Design:
 *   • config-driven — cities + niches from scripts/config.json, overridable
 *     via CLI flags (comma-separated) for on-demand / smoke runs
 *   • per-combo extraction with scroll-into-feed (the classic Maps lazy-load
 *     gotcha), modest pacing, and per-combo retries with backoff
 *   • reuses db/normalize.js for ALL parsing rules (phone → E.164, city
 *     cleanup, website_status classification) so seed + extractor agree
 *   • upserts ON CONFLICT (business_name, city) DO UPDATE — re-sweeping a
 *     market never duplicates; identical rows are no-ops
 *   • lead_events.lead_created written in the same transaction as the insert,
 *     only for genuinely new leads (payload: source, batch, method)
 *   • partial results survive: one (city, niche) combo failing never discards
 *     the combos already extracted; job only fails if NOTHING was extracted
 *
 * Usage:
 *   node scripts/extract-leads.js [options]
 *
 * Options:
 *   --cities "San Antonio, TX | Fort Worth, TX"  override config cities
 *              (separate multiple "City, ST" with ' | ' or ';', or repeat
 *               the flag: --cities "San Antonio, TX" --cities "Fort Worth, TX")
 *   --niches  "Junk Removal | Roofing"           override config niches
 *              (or comma-separated when each value has no inner comma)
 *   --limit N            max businesses extracted per (city, niche) combo
 *                        (smoke tests: --limit 3)
 *   --dry-run            extract + normalize + audit only; print JSON rows to
 *                        stdout, never touch the database
 *   --batch NAME         source_batch label (default: sweep-YYYYMMDD)
 *   --config PATH        config file (default: scripts/config.json)
 *   --no-audit           skip homepage audits; every URL is classified 'weak'
 *   --include-good       also upsert leads whose site audits as converting
 *                        (default: skip them — they aren't targets)
 *   --retries N          retries per (city, niche) combo (default 2)
 *   --concurrency N      homepage-audit fetch concurrency (default 3)
 *   --verbose            log extraction detail per combo
 *
 * Exit codes: 0 = ran (even if some combos failed but others produced rows),
 *             1 = fatal / nothing extracted at all, 2 = bad usage.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const { chromium } = require('playwright');

const { normalizePhone, normalizeWebsite, normalizeCity, classifyWebsiteStatus } =
  require('../db/normalize');

const SCRIPT_DIR = __dirname;
const DEFAULT_CONFIG = path.join(SCRIPT_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Env / config plumbing (dependency-light; no dotenv)
// ---------------------------------------------------------------------------

// Load scripts/.env if present and DATABASE_URL is not already set.
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

// Split a --cities/--niches value into a list. Multi-item inputs are
// unambiguous when separated by ';' or ' | ' — each item keeps any internal
// comma, so `--cities "San Antonio, TX | Fort Worth, TX"` yields two whole
// "City, ST" values (and the `--cities "San Antonio, TX;Fort Worth, TX"`
// form works too). For a plain comma-separated list (no ';'/'|') we fall back
// to splitting on commas, but merge adjacent "City, ST" pairs so the single
// `--cities "San Antonio, TX"` stays ONE value instead of two bogus ones
// ("San Antonio" + "TX"). A plain list like `--niches "Junk Removal, Roofing"`
// still splits into two. Repeated `--cities`/`--niches` flags append (also
// supported by parseArgs).
const STATE_RE = /^(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/i;
function splitList(value) {
  const parts = value.split(/[|;]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts; // explicit delimiter → each item stays whole
  const tokens = value.split(',').map((s) => s.trim()).filter(Boolean);
  const merged = [];
  for (const t of tokens) {
    if (STATE_RE.test(t) && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}, ${t}`;
    } else {
      merged.push(t);
    }
  }
  return merged;
}
function parseArgs(argv) {
  const opts = {
    cities: null, niches: null, limit: null, dryRun: false, batch: null,
    config: DEFAULT_CONFIG, audit: true, includeGood: false,
    retries: 2, concurrency: 3, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--cities': (opts.cities = opts.cities || []).push(...splitList(next())); break;
      case '--niches': (opts.niches = opts.niches || []).push(...splitList(next())); break;
      case '--limit': opts.limit = parseInt(next(), 10); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--batch': opts.batch = next(); break;
      case '--config': opts.config = next(); break;
      case '--no-audit': opts.audit = false; break;
      case '--include-good': opts.includeGood = true; break;
      case '--retries': opts.retries = parseInt(next(), 10); break;
      case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
      case '--verbose': opts.verbose = true; break;
      case '-h': case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 60).join('\n'));
        process.exit(0);
      default:
        console.error(`Unknown option: ${a} (see --help)`);
        process.exit(2);
    }
  }
  return opts;
}

function loadConfig(opts) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  } catch (err) {
    if (opts.config !== DEFAULT_CONFIG) {
      console.error(`FATAL: cannot read config ${opts.config}: ${err.message}`);
      process.exit(2);
    }
    // default config missing → fall back to CLI-only mode
  }
  const cities = opts.cities || cfg.cities || [];
  const niches = opts.niches || cfg.niches || [];
  if (!cities.length || !niches.length) {
    console.error('FATAL: no cities/niches. Configure scripts/config.json or pass --cities/--niches.');
    process.exit(2);
  }
  return {
    cities,
    niches,
    limit: opts.limit ?? cfg.limit ?? 40,
    batch: opts.batch || cfg.batch || `sweep-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
    audit: opts.audit && (cfg.audit ?? true),
    includeGood: opts.includeGood || !!cfg.includeGood,
    retries: opts.retries,
    concurrency: opts.concurrency,
    verbose: opts.verbose,
  };
}

// ---------------------------------------------------------------------------
// Google Maps extraction
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Non-website link hosts: social profiles / booking tools / aggregators. A
// business whose ONLY outbound link is one of these has no website of its own
// (schema convention: keep the URL but set website_status='none').
const SOCIAL_HOST_RE =
  /(^|\.)(facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|yelp\.com|tiktok\.com|youtube\.com|calendly\.com|booking\.google|book\.yep|nextdoor\.com|angieslist\.com|bbb\.org)$/i;

// DIY-template hosts → 'weak' without needing an audit fetch.
const TEMPLATE_HOST_RE =
  /(^|\.)(wixsite\.com|weebly\.com|godaddysites\.com|business\.site|webs\.com|hibuwebsites\.com|wordpress\.com|webnode\.|site123\.|squarespace\.com|strikingly\.com|wix\.com)$/i;

// Cheap TLDs the Hunter flagged as likely-weak (kept narrow: .biz/.site/.best).
const CHEAP_TLD_RE = /\.(biz|site|best)$/i;

// Maps wraps outbound URLs in google.com/url?q=… — unwrap.
function unwrapMapsUrl(href) {
  if (!href) return null;
  const m = /^https?:\/\/www\.google\.com\/url\?q=([^&]+)/i.exec(href);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return href;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// The scroll+extract routine — same proven pattern as the Hunter's skill:
// walk up from [role="feed"] to the real scroll container (Maps renders
// several div.m6QErb; the first isn't always the scrollable one), scroll it in
// rounds with ≤1s waits, dedupe by name. Passed to page.evaluate as a real
// function (a string would evaluate to an un-callable expression).
async function extractFeed(limit) {
  const out = [];
  const seen = new Set();
  const feed = document.querySelector('[role="feed"]');
  let sc = feed;
  for (let i = 0; i < 10 && sc && sc !== document.documentElement; i++) {
    if (sc.scrollHeight > sc.clientHeight + 50) break;
    sc = sc.parentElement;
  }
  let stable = 0;
  const collect = () => {
    document.querySelectorAll('[role="feed"] [role="article"]').forEach((el) => {
      const nameEl = el.querySelector('.fontHeadlineSmall');
      const name = nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim() : '';
      if (!name || seen.has(name)) return;
      seen.add(name);
      const txt = el.textContent.replace(/\s+/g, ' ').trim();
      const phoneMatch = txt.match(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/);
      const links = Array.from(el.querySelectorAll('a'))
        .map((a) => a.href)
        .filter((h) => h && !h.includes('google.com/maps'));
      out.push({
        name,
        phone: phoneMatch ? phoneMatch[0] : '',
        links: Array.from(new Set(links)),
        text: txt.slice(0, 220),
      });
    });
  };
  for (let round = 0; round < 14 && out.length < limit; round++) {
    collect();
    const before = out.length;
    if (sc) sc.scrollTop = sc.scrollHeight;
    await new Promise((r) => setTimeout(r, 700));
    if (out.length >= limit) break;
    if (out.length === before) { stable += 1; if (stable >= 3) break; } else stable = 0;
  }
  collect();
  return out.slice(0, limit);
}

// Try to dismiss the cookie consent banner if Google shows one.
async function dismissConsent(page) {
  for (const sel of ['button:has-text("Reject all")', 'button:has-text("Accept all")']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(800);
        return;
      }
    } catch { /* not present */ }
  }
}

// Race any promise against a hard timer so a wedged Chrome can never stall the
// sweep (observed: ctx.close()/browser.close() hanging on a stuck Maps page —
// the CDP reply never comes, no socket timeout applies).
function withHardTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function extractCombo(browser, city, niche, limit, verbose) {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000); // nothing may hang forever on one call
  const url = `https://www.google.com/maps/search/${encodeURIComponent(`${niche} in ${city}`)}`;
  try {
    if (verbose) console.log(`    [goto] ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (verbose) console.log('    [goto] loaded, title:', (await page.title().catch(() => '?')));

    await dismissConsent(page);

    // Wait for the results feed (poll — Maps sometimes takes a while).
    // NOTE: use count(), not isVisible() — headless-shell reports these
    // cards as not "visible" even when they are in the DOM.
    let found = false;
    for (let i = 0; i < 24 && !found; i++) {
      found = (await page.locator('[role="feed"] [role="article"]').count().catch(() => 0)) > 0;
      if (!found) await page.waitForTimeout(1000);
    }
    if (verbose) console.log(`    [feed] found=${found}`);
    if (!found) {
      const body = (await page.locator('body').innerText().catch(() => '')) || '';
      if (/unusual traffic|captcha|are you a robot/i.test(body)) {
        throw new Error('Google anti-bot check (unusual traffic / captcha)');
      }
      throw new Error('no results feed appeared');
    }
    const cards = await page.evaluate(extractFeed, limit);
    if (verbose) console.log(`  [extract] ${city} / ${niche}: ${cards.length} cards`);
    return cards;
  } finally {
    await withHardTimeout(ctx.close(), 10000, 'context close').catch((err) => {
      console.error(`  [ctx] ${err.message} — continuing (results already extracted)`);
    });
  }
}

// ---------------------------------------------------------------------------
// Website audit (lightweight, for classification only)
// ---------------------------------------------------------------------------

const AUDIT_TIMEOUT = 10000;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function fetchHead(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    // HARD overall deadline — this is the fix for the Phase 2 audit stall.
    // Node's `timeout` socket option (the old approach) only fires on socket
    // IDLE *after* connect, so it NEVER fires during TCP connect/DNS: an
    // unreachable host that silently drops SYNs (dead server, firewall,
    // no-route IP) stalled the audit worker — and with it the whole sweep —
    // forever. AbortSignal.timeout aborts the request at ANY phase (DNS and
    // connect included), and the timer below is a belt-and-braces backstop so
    // this promise settles within AUDIT_TIMEOUT no matter what. A failed
    // audit degrades gracefully: auditUrl returns {ok:false} → the lead gets
    // classified 'weak' and the sweep moves on (partial results kept).
    const deadline = setTimeout(() => {
      req.destroy(new Error(`audit deadline exceeded (${AUDIT_TIMEOUT}ms connect+headers)`));
    }, AUDIT_TIMEOUT);
    const settle = (fn, v) => { clearTimeout(deadline); fn(v); };
    const req = mod.get(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(AUDIT_TIMEOUT),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length > 200000) {
          req.destroy();
          settle(resolve, { status: res.statusCode, len: 200001, headers: res.headers });
        }
      });
      res.on('end', () => settle(resolve, { status: res.statusCode, len: Buffer.concat(chunks).length, headers: res.headers }));
      res.on('error', (err) => settle(reject, err));
    });
    req.on('error', (err) => settle(reject, err));
  });
}

// Follow up to 3 redirects (http/https only) and return {status, len}.
async function auditUrl(url) {
  let u = url;
  for (let hop = 0; hop < 4; hop++) {
    let r;
    try { r = await fetchHead(u); } catch (err) { return { ok: false, reason: `fetch failed (${err.message})` }; }
    if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
      u = new URL(r.headers.location, u).toString();
      continue;
    }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, len: r.len };
  }
  return { ok: false, reason: 'too many redirects' };
}

// Audits a website URL → free-text verdict consumed by classifyWebsiteStatus.
async function auditWebsite(url) {
  const host = hostOf(url);
  if (TEMPLATE_HOST_RE.test(host)) return 'DIY template site';
  if (CHEAP_TLD_RE.test(host)) return 'cheap-TLD template site';
  const r = await auditUrl(url);
  if (!r.ok) return `website down/broken (${r.reason || `fetch status ${r.status}`})`;
  if (r.len < 300) return 'placeholder/broken site (tiny page)';
  return 'good';
}

// ---------------------------------------------------------------------------
// Card → lead row
// ---------------------------------------------------------------------------

function cardToLead(card, city, niche, cfg, auditVerdicts, verboseLog) {
  const name = card.name;
  if (!name) return null;

  const phone = normalizePhone(card.phone);
  const links = (card.links || []).map(unwrapMapsUrl).filter(Boolean);
  const social = links.find((h) => SOCIAL_HOST_RE.test(hostOf(h)));
  const web = links.find((h) => !SOCIAL_HOST_RE.test(hostOf(h)));

  let website = normalizeWebsite(web);
  let statusText;
  if (!web) {
    website = normalizeWebsite(social); // keep FB/IG URL; status stays 'none'
    statusText = social ? 'facebook only' : 'no website';
  } else {
    statusText = cfg.audit ? auditVerdicts.get(website) : 'un-audited (has site)';
  }
  const website_status = classifyWebsiteStatus(statusText, website);

  if (cfg.verbose && verboseLog && (!phone || !website)) {
    verboseLog(`  [audit] ${name}: phone=${phone ? 'ok' : 'MISSING'} web=${website ? 'ok' : 'none'} → ${website_status}`);
  }
  return {
    business_name: name,
    city: normalizeCity(city),
    niche,
    phone,
    email: null,
    website,
    website_status,
    source_batch: cfg.batch,
  };
}

// ---------------------------------------------------------------------------
// DB write (upsert + lead_created events in one transaction)
// ---------------------------------------------------------------------------

function connectPool() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('FATAL: DATABASE_URL is not set (see scripts/.env.example).');
    process.exit(1);
  }
  const u = new URL(dbUrl);
  u.searchParams.delete('channel_binding');
  u.searchParams.delete('sslmode');
  return new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
}

const UPSERT_SQL = `
  INSERT INTO leads (business_name, phone, email, website, website_status,
                     city, niche, source_batch)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (business_name, city) DO UPDATE SET
    phone          = EXCLUDED.phone,
    email          = EXCLUDED.email,
    website        = EXCLUDED.website,
    website_status = EXCLUDED.website_status,
    niche          = EXCLUDED.niche,
    source_batch   = EXCLUDED.source_batch,
    updated_at     = now()
  WHERE leads.phone          IS DISTINCT FROM EXCLUDED.phone
     OR leads.email          IS DISTINCT FROM EXCLUDED.email
     OR leads.website        IS DISTINCT FROM EXCLUDED.website
     OR leads.website_status IS DISTINCT FROM EXCLUDED.website_status
     OR leads.niche          IS DISTINCT FROM EXCLUDED.niche
     OR leads.source_batch   IS DISTINCT FROM EXCLUDED.source_batch
  RETURNING (xmax = 0) AS inserted, id, business_name, city
`;

async function writeLeads(pool, rows, eventSource) {
  const client = await pool.connect();
  let inserted = 0, updated = 0, unchanged = 0;
  const insertedRows = [];
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const res = await client.query(UPSERT_SQL, [
        row.business_name, row.phone, row.email, row.website,
        row.website_status, row.city, row.niche, row.source_batch,
      ]);
      const r = res.rows[0];
      if (!r) { unchanged += 1; continue; }
      if (r.inserted) {
        inserted += 1;
        insertedRows.push({ id: r.id, business_name: r.business_name, city: r.city });
        await client.query(
          `INSERT INTO lead_events (lead_id, event_type, payload)
           VALUES ($1, 'lead_created', $2)`,
          [r.id, JSON.stringify({ source: eventSource, batch: row.source_batch, method: 'google-maps' })],
        );
      } else {
        updated += 1;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted, updated, unchanged, insertedRows };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  loadEnvFile(path.join(SCRIPT_DIR, '.env'));
  const cfg = loadConfig(opts);

  console.log(`Lead sweep — cities: ${cfg.cities.join(', ')}`);
  console.log(`             niches: ${cfg.niches.join(', ')}`);
  console.log(`             limit/combo: ${cfg.limit}, batch: ${cfg.batch}, audit: ${cfg.audit ? 'on' : 'off'}`);
  if (opts.dryRun) console.log('             DRY RUN — no database writes.\n');
  else console.log(`             database: ${opts.dryRun ? 'none' : 'live (Neon)'}\n`);

  // Global audit-verdict cache (shared across combos, avoids refetching).
  const auditVerdicts = new Map();
  const auditQueue = [];
  const auditWorker = async () => {
    while (auditQueue.length) {
      const { url, done } = auditQueue.shift();
      const t0 = Date.now();
      let v;
      try { v = await auditWebsite(url); } catch (e) { v = 'website down/broken (audit error)'; }
      if (cfg.verbose) console.log(`    [audit] ${url} → ${v} (${Date.now() - t0}ms)`);
      auditVerdicts.set(url, v);
      done();
    }
  };
  const withAudit = (url) =>
    new Promise((resolve) => {
      if (!url) return resolve(null);
      const cached = auditVerdicts.get(url);
      if (cached) return resolve(cached);
      auditQueue.push({ url, done: () => resolve(auditVerdicts.get(url)) });
    });

  const browser = await chromium.launch({ headless: true });
  const pool = opts.dryRun ? null : connectPool();

  const totals = { new: 0, updated: 0, unchanged: 0, skippedGood: 0, missingPhone: 0 };
  const failures = [];
  const perCity = new Map();
  const dryRows = [];
  let browserWedge = false;

  try {
    for (const city of cfg.cities) {
      for (const niche of cfg.niches) {
        const key = `${niche} in ${city}`;
        let cards = [];
        let lastErr = null;
        for (let attempt = 0; attempt <= cfg.retries; attempt++) {
          if (attempt > 0) {
            const wait = 2000 * attempt;
            console.log(`  [retry ${attempt}/${cfg.retries}] ${key} in ${wait / 1000}s…`);
            await new Promise((r) => setTimeout(r, wait));
          }
          try {
            cards = await extractCombo(browser, city, niche, cfg.limit, cfg.verbose);
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!cards.length) {
          failures.push(`${key} — ${lastErr ? lastErr.message : '0 results after retries'}`);
          continue;
        }

        // Audit unique websites (only when audit enabled).
        if (cfg.audit) {
          const uniques = [];
          for (const card of cards) {
            const web = (card.links || []).map(unwrapMapsUrl)
              .filter(Boolean)
              .find((h) => !SOCIAL_HOST_RE.test(hostOf(h)));
            if (web && !uniques.includes(web)) uniques.push(web);
          }
          // Queue the URLs FIRST, then start the workers. auditWorker exits as
          // soon as the queue is empty, so starting workers before work exists
          // (the pre-fix behaviour) deadlocked the drain forever — withAudit's
          // done() could never be called and the sweep stalled right here.
          const auditPromises = uniques.map(withAudit);
          const workers = [];
          for (let i = 0; i < cfg.concurrency; i++) workers.push(auditWorker());
          await Promise.all(auditPromises);
          await Promise.all(workers); // drain audit queue
        }

        const rows = [];
        const stats = { new: 0, updated: 0, unchanged: 0, good: 0 };
        for (const card of cards) {
          const row = cardToLead(card, city, niche, cfg, auditVerdicts, (m) => console.log(m));
          if (!row) continue;
          if (row.website_status === 'good' && !cfg.includeGood) { stats.good += 1; continue; }
          if (!row.phone) totals.missingPhone += 1;
          rows.push(row);
        }
        console.log(`\n${key}: ${cards.length} businesses, ${rows.length} candidate leads (${stats.good} converting sites skipped)`);

        if (opts.dryRun) {
          dryRows.push(...rows.map((r) => ({ ...r, _combo: key })));
          continue;
        }

        const res = await writeLeads(pool, rows, 'github-actions');
        stats.new = res.inserted; stats.updated = res.updated; stats.unchanged = res.unchanged;
        totals.new += res.inserted; totals.updated += res.updated; totals.unchanged += res.unchanged;
        totals.skippedGood += stats.good;
        const cc = perCity.get(city) || { new: 0, updated: 0, unchanged: 0, extracted: 0 };
        cc.extracted += cards.length;
        cc.new += res.inserted; cc.updated += res.updated; cc.unchanged += res.unchanged;
        perCity.set(city, cc);
        console.log(`  → inserted ${res.inserted}, updated ${res.updated}, unchanged ${res.unchanged}, lead_created events ${res.inserted}`);
        for (const ir of res.insertedRows) {
          console.log(`    NEW: #${ir.id} ${ir.business_name} (${ir.city})`);
        }
      }
    }
  } finally {
    await withHardTimeout(browser.close(), 8000, 'browser close').catch((err) => {
      console.error(`  [browser] ${err.message}`);
      browserWedge = true; // wedged Chrome keeps its CDP pipe open → force exit below
    });
    if (pool) await pool.end();
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log('\n================= SWEEP SUMMARY =================');
  if (opts.dryRun) {
    console.log(`DRY RUN — ${dryRows.length} rows extracted (no DB writes).`);
    console.log(JSON.stringify(dryRows, null, 2));
  } else {
    console.log('Per city:');
    for (const [city, cc] of perCity) {
      console.log(`  ${city}: extracted ${cc.extracted} | new ${cc.new} | updated ${cc.updated} | unchanged ${cc.unchanged}`);
    }
    console.log(`\nTotals → new: ${totals.new}, updated: ${totals.updated}, unchanged: ${totals.unchanged}`);
    console.log(`skipped converting sites: ${totals.skippedGood}, missing-phone leads kept: ${totals.missingPhone}`);
  }
  if (failures.length) {
    console.log(`\n⚠  ${failures.length} combo(s) failed (partial results kept):`);
    for (const f of failures) console.log(`  - ${f}`);
  }

  // Exit semantics: 0 unless NOTHING was extracted anywhere.
  if (failures.length && (!dryRows.length || (totals.new + totals.updated + totals.unchanged) === 0)) {
    process.exitCode = 1;
  }

  // A wedged Chrome process holds the CDP pipes open, which would keep this
  // process alive forever after main() returns — force the exit instead.
  if (browserWedge) process.exit(process.exitCode || 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Sweep failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

// Export the audit primitives + CLI/value parser so tests/harnesses can
// exercise the timeout behaviour and multi-value parsing directly (requiring
// this file no longer runs the sweep).
module.exports = { fetchHead, auditUrl, auditWebsite, parseArgs, splitList };
