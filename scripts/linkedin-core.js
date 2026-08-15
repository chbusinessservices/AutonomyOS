// scripts/linkedin-core.js — Phase 3 LinkedIn outreach: testable core.
//
// Pure logic for the outreach engine, split out of linkedin-outreach.js so
// unit tests can exercise it WITHOUT Playwright or a browser:
//   • message-template rendering (deterministic, no LLM in this phase)
//   • daily-cap state (per-day state file + DB cross-check)
//   • the SQL the script runs (leads fetch, contacted transition + event,
//     today's outreach count) behind a query-function seam
//
// SQL helpers take `q` — a single-connection query function of the shape
//   (text, params) => Promise<{ rows, rowCount }>
// linkedin-outreach.js passes `client.query.bind(client)` (one pg client so
// BEGIN/COMMIT/ROLLBACK stay on one connection); tests pass a client query
// bound inside BEGIN … ROLLBACK so nothing survives the test.
'use strict';

const PLACEHOLDER_RE = /\{\{([a-zA-Z_]+)\}\}/g;

// Friendly completion for "Your online presence {{website_status}}" — the
// closed domain from the hunter audit ('none' | 'weak' | 'good') mapped to
// phrasing that reads naturally inside the templates.
function websiteStatusPhrase(status) {
  switch ((status || '').trim().toLowerCase()) {
    case 'none':  return 'is missing entirely';
    case 'weak':  return "isn't converting visitors into calls yet";
    case 'good':  return 'is up and running';
    default:      return 'could do more for you';
  }
}

// Render one template against a lead. Deterministic and safe:
//   • {{business_name}} {{city}} {{niche}} → trimmed lead fields ('' when NULL)
//   • {{website_status}} → friendly phrase (see websiteStatusPhrase)
//   • unknown placeholders are left untouched (never silently dropped)
//   • result is truncated to maxChars (LinkedIn connection notes cap at 300)
function renderTemplate(templateText, lead, maxChars) {
  const vals = {
    business_name: String(lead.business_name ?? '').trim(),
    city: String(lead.city ?? '').trim(),
    niche: String(lead.niche ?? '').trim(),
    website_status: websiteStatusPhrase(lead.website_status),
  };
  let out = templateText.replace(PLACEHOLDER_RE, (m, key) =>
    Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : m
  );
  if (maxChars && out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

// Deterministic variant pick: the same lead always gets the same template on
// re-runs (stable across crashes), and templates round-robin by lead id so a
// batch spreads across variants. Lead ids are BIGINT (strings from pg) — the
// numeric fit is fine for id < 2^53, which this pipeline's ids are.
function pickTemplate(templates, lead) {
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error('no message templates configured');
  }
  const idx = Math.abs(Number(lead.id)) % templates.length;
  return templates[idx];
}

// Build the full action plan: one entry per lead with the chosen variant and
// the rendered message. `personalize` is the Phase 4 AI hook — today it is
// the identity (deterministic templates); Phase 4 swaps in an LLM call behind
// the same signature (lead, message) => message without touching this loop.
async function buildPlan(leads, templates, opts) {
  const maxChars = (opts && opts.noteMaxChars) || 300;
  const personalize = (opts && opts.personalize) || (async (_lead, msg) => msg);
  const plan = [];
  for (const lead of leads) {
    const tpl = pickTemplate(templates, lead);
    let message = renderTemplate(tpl.text, lead, maxChars);
    message = await personalize(lead, message); // Phase 4 hook (default: no-op)
    if (maxChars && message.length > maxChars) {
      message = `${message.slice(0, maxChars - 1)}…`;
    }
    plan.push({ lead, variant: tpl.id, message });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Daily-cap state (per-day state file + DB cross-check)
// ---------------------------------------------------------------------------
// State file shape (scripts/.linkedin-run-state.json, gitignored):
//   { "date": "2026-08-10", "sent": 3, "lead_ids": ["181","182","183"],
//     "updated_at": "2026-08-10T04:00:00.000Z" }
// Days are UTC (matches the DB's now() and the GitHub cron's UTC schedule).
function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Tolerate missing/corrupt state: treat it as a fresh day. Never throws.
function parseState(raw) {
  const fresh = { date: todayStr(), sent: 0, lead_ids: [] };
  if (typeof raw !== 'string' || !raw.trim()) return fresh;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return fresh;
    return {
      date: typeof o.date === 'string' ? o.date : todayStr(),
      sent: Number.isInteger(o.sent) && o.sent >= 0 ? o.sent : 0,
      lead_ids: Array.isArray(o.lead_ids) ? o.lead_ids.map(String) : [],
    };
  } catch {
    return fresh;
  }
}

// How many sends count against today's cap. Takes the max of the state file
// and the DB — so a crashed run that wrote the DB but not the state file (or
// a deleted state file) still cannot exceed the cap. A stale state file (old
// date) contributes nothing.
function usedToday(state, dbCountToday) {
  const fresh = state && state.date === todayStr();
  return Math.max(fresh ? state.sent : 0, Number.isFinite(dbCountToday) ? dbCountToday : 0);
}

function remainingToday(state, dbCountToday, cap) {
  return Math.max(0, cap - usedToday(state, dbCountToday));
}

// Apply `n` completed sends to the state (new day → fresh id list; otherwise
// accumulate). Returns a NEW state object; caller persists it.
function consumeState(state, n, leadIds) {
  const date = todayStr();
  const ids = new Set(state && Array.isArray(state.lead_ids) && state.date === date
    ? state.lead_ids
    : []);
  for (const id of leadIds || []) ids.add(String(id));
  const was = state && state.date === date ? state.sent : 0;
  return {
    date,
    sent: was + n,
    lead_ids: [...ids],
    updated_at: new Date().toISOString(),
  };
}

// How many leads the plan may act on this run: the cap's remaining budget,
// narrowed by an optional CLI --limit (used for smoke tests).
function planSize(remaining, limit) {
  if (limit != null && limit >= 0) return Math.min(remaining, limit);
  return remaining;
}

// ---------------------------------------------------------------------------
// SQL helpers (all take a single-connection query function `q`)
// ---------------------------------------------------------------------------
const SELECT_PENDING_SQL = `
  SELECT id, business_name, city, niche, website_status, status
  FROM leads
  WHERE status = $1
  ORDER BY id ASC
  LIMIT $2`;

// Oldest leads in the given status, capped at `limit`.
async function fetchPendingLeads(q, status, limit) {
  const { rows } = await q(SELECT_PENDING_SQL, [status, limit]);
  return rows;
}

// Run fn inside a transaction on the caller's single-connection query fn.
// The helper functions below deliberately do NOT manage their own
// transactions — the caller decides (the script wraps a send in one
// transaction; tests call the *Statements forms inside BEGIN…ROLLBACK so
// nothing can leak). Nested BEGIN/COMMIT on a shared client is how test rows
// end up committed by accident.
async function withTransaction(q, fn) {
  await q('BEGIN');
  try {
    const result = await fn();
    await q('COMMIT');
    return result;
  } catch (err) {
    await q('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Statements only — caller owns the transaction (see withTransaction).
// Atomically flip one lead to 'contacted' and log the outreach_sent event.
// Guarded: only transitions from `fromStatus`; if another process already
// advanced the lead this is a clean no-op (returns updated:false, logs
// nothing). Returns { updated, eventId }.
async function markContactedStatements(q, leadId, fromStatus, payload) {
  const upd = await q(
    `UPDATE leads SET status = 'contacted' WHERE id = $1 AND status = $2`,
    [leadId, fromStatus]
  );
  if (upd.rowCount === 0) return { updated: false, eventId: null };
  const ev = await q(
    `INSERT INTO lead_events (lead_id, event_type, payload)
     VALUES ($1, 'outreach_sent', $2)
     RETURNING id`,
    [leadId, payload]
  );
  return { updated: true, eventId: ev.rows[0].id };
}

// Transactional wrapper used by the script (one send = one transaction).
function markContacted(q, leadId, fromStatus, payload) {
  return withTransaction(q, () => markContactedStatements(q, leadId, fromStatus, payload));
}

// Sends logged since UTC midnight — the DB side of the daily-cap cross-check.
async function countOutreachSentToday(q, dateStr) {
  const res = await q(
    `SELECT count(*)::int AS n FROM lead_events
     WHERE event_type = 'outreach_sent' AND created_at >= $1::timestamptz`,
    [dateStr]
  );
  return res.rows[0].n;
}

// Row counts used by dry-run verification ("DB unchanged") and by tests.
async function countLeads(q) {
  const res = await q(`SELECT count(*)::int AS n FROM leads`);
  return res.rows[0].n;
}
async function countEvents(q) {
  const res = await q(`SELECT count(*)::int AS n FROM lead_events`);
  return res.rows[0].n;
}

module.exports = {
  websiteStatusPhrase,
  renderTemplate,
  pickTemplate,
  buildPlan,
  todayStr,
  parseState,
  usedToday,
  remainingToday,
  consumeState,
  planSize,
  fetchPendingLeads,
  withTransaction,
  markContacted,
  markContactedStatements,
  countOutreachSentToday,
  countLeads,
  countEvents,
};
