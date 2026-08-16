// scripts/stripe-core.js — Phase 5: shared Stripe logic for the payments arm.
//
// Everything both `stripe-webhook.js` (the HTTP handler) and `payment.js`
// (the payment-link helper) need lives here so the two stay thin and the
// logic is testable without any Stripe keys or network access:
//
//   • verifySignature()   — Stripe-Signature header verification, manual
//                           HMAC-SHA256 with node:crypto (no SDK dependency).
//                           Scheme: `t=<unix>,v1=<hex>`; the signed payload
//                           is `"<t>.<rawBody>"`. Also enforces the standard
//                           timestamp tolerance (STRIPE_WEBHOOK_TOLERANCE_SEC,
//                           default 300s) so replayed events are rejected.
//   • closeFromPayment*() — the money event: resolve a lead from
//                           client_reference_id / metadata.lead_id, flip it to
//                           'closed_won', append a `payment_received`
//                           lead_events row (payload: session_id, amount_total,
//                           currency, paid_at). Idempotent per session_id
//                           (Stripe retries duplicates), and unknown leads are
//                           a clean no-op — never an error.
//   • loadEnvFile()       — dependency-light env loader (mirrors
//                           extract-leads.js / linkedin-outreach.js; no dotenv).
//
// House style, kept from Phases 2–4: query-function injection seam (`q`) so
// tests pass a mock or a transaction-bound client; verbose `[stripe]` logging;
// never throw to the caller — degrade, log, and return a result.
//
// DB conventions (db/schema.sql): statuses new → contacted → replied →
// negotiating → closed_won | closed_lost; event types ... payment_link_sent,
// payment_received (the only one that sets closed_won).
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_TOLERANCE_SEC = 300; // Stripe's standard webhook tolerance
const MAX_BODY_BYTES = 1024 * 1024; // Stripe events are tiny; 1 MB is generous

// ---------------------------------------------------------------------------
// Env plumbing (dependency-light; no dotenv — mirrors Phases 2–4)
// ---------------------------------------------------------------------------
// Loads `path` into process.env, never overwriting values that are already
// set. Tolerates a missing file. Returns nothing.
function loadEnvFile(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Logging (house style: verbose [x] prefix, `verbose` gate)
// ---------------------------------------------------------------------------
function stripeLog(verbose, msg) {
  if (verbose) console.log(`  [stripe] ${msg}`);
}

// ---------------------------------------------------------------------------
// Stripe-Signature verification (manual, node:crypto — no SDK)
// ---------------------------------------------------------------------------
// Header format: "t=<unix-seconds>,v1=<hex-hmac>" (v0 may also be present for
// old endpoints; we only validate v1). The HMAC input is "<t>.<rawBody>" —
// which is why handlers MUST read the raw body before any JSON parsing.
// Returns { ok: true } or { ok: false, reason } — never throws.
function verifySignature(secret, payload, header, toleranceSec) {
  if (!secret || !header) {
    return { ok: false, reason: 'missing secret or Stripe-Signature header' };
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    return { ok: false, reason: 'empty body' };
  }
  const parts = {};
  for (const pair of String(header).split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    parts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: 'header missing t= or v1=' };
  if (!/^\d+$/.test(t)) return { ok: false, reason: 't is not a unix timestamp' };
  // Timestamp tolerance: reject replays / stale captures. The clock skew
  // window is configurable (STRIPE_WEBHOOK_TOLERANCE_SEC) but defaults to
  // Stripe's own 300s.
  const tol = Number.isFinite(Number(toleranceSec)) && Number(toleranceSec) > 0
    ? Number(toleranceSec)
    : DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(t)) > tol) {
    return { ok: false, reason: `timestamp ${t} outside ${tol}s tolerance` };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${payload}`)
    .digest('hex');
  const a = Buffer.from(v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) {
    return { ok: false, reason: 'signature length mismatch' };
  }
  const ok = crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, reason: 'HMAC does not match' };
}

// ---------------------------------------------------------------------------
// SQL helpers (all take a single-connection query function `q`, matching the
// linkedin-core.js pattern; the *Statements forms do NOT manage transactions
// so tests can run them inside BEGIN…ROLLBACK)
// ---------------------------------------------------------------------------
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

// Is there already a payment_received event for this session? Stripe retries
// webhooks that got no 2xx, so the same session can arrive twice — the second
// delivery must be a no-op, not a second closed_won event.
async function paymentEventExists(q, sessionId) {
  const res = await q(
    `SELECT 1 AS x FROM lead_events
     WHERE event_type = 'payment_received' AND payload->>'session_id' = $1
     LIMIT 1`,
    [String(sessionId ?? '')]
  );
  return (res.rows && res.rows.length > 0);
}

// Lead lookup by client_reference_id / metadata.lead_id. Lead ids are BIGINT;
// anything non-numeric cannot match (returns null). Handles either a numeric
// string or a number.
async function findLeadById(q, ref) {
  const s = String(ref ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const res = await q('SELECT id, business_name, status FROM leads WHERE id = $1::bigint', [s]);
  return res.rows && res.rows.length > 0 ? res.rows[0] : null;
}

// Statements only — caller owns the transaction. Flips the lead to
// 'closed_won' and appends the payment_received event in one unit. Returns
// { updated, eventId, payload }; updated:false when the lead is gone (should
// not happen after findLeadById, but cheap to be safe).
async function markClosedWonStatements(q, leadId, session) {
  const upd = await q(`UPDATE leads SET status = 'closed_won' WHERE id = $1`, [leadId]);
  if (upd.rowCount === 0) return { updated: false, eventId: null, payload: null };
  // Stripe timestamps are unix seconds (session.created). paid_at defaults to
  // now when the fixture/event omits it.
  const paidAt = Number.isFinite(Number(session.created))
    ? new Date(Number(session.created) * 1000).toISOString()
    : new Date().toISOString();
  const payload = {
    session_id: String(session.id ?? ''),
    amount_total: session.amount_total != null ? Number(session.amount_total) : null,
    currency: String(session.currency ?? '').toLowerCase() || null,
    paid_at: paidAt,
  };
  if (session.payment_status) payload.payment_status = String(session.payment_status);
  const ev = await q(
    `INSERT INTO lead_events (lead_id, event_type, payload)
     VALUES ($1, 'payment_received', $2) RETURNING id`,
    [leadId, payload]
  );
  return { updated: true, eventId: ev.rows[0].id, payload };
}

// The money event, end to end (transactional wrapper used by the webhook on a
// fresh pooled connection). Resolves the lead, dedupes, closes, logs.
// Returns one of:
//   { found: false }                     — no matching lead (or bad ref)
//   { found: true, duplicate: true }     — session already processed
//   { found: true, updated, eventId, payload, lead } — closed + logged
async function closeFromPayment(q, ref, session) {
  // Session-id dedupe first: a retried delivery must never double-log.
  if (await paymentEventExists(q, session && session.id)) {
    return { found: true, duplicate: true };
  }
  const lead = await findLeadById(q, ref);
  if (!lead) return { found: false };
  const out = await withTransaction(q, () => markClosedWonStatements(q, lead.id, session));
  return { found: true, duplicate: false, lead, ...out };
}

// ---------------------------------------------------------------------------
// Payment-link event helpers (used by payment.js; also exported for tests)
// ---------------------------------------------------------------------------
// UTC day string — matches the DB's now() and the pipeline's day boundary
// convention (see linkedin-core.js todayStr()).
function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// A payment_link_sent row for this lead+product since UTC midnight?
async function paymentLinkSentToday(q, leadId, productKey) {
  const res = await q(
    `SELECT id FROM lead_events
     WHERE lead_id = $1 AND event_type = 'payment_link_sent'
       AND payload->>'product' = $2 AND created_at >= $3::timestamptz
     LIMIT 1`,
    [leadId, productKey, todayStr()]
  );
  return res.rows && res.rows.length > 0 ? res.rows[0].id : null;
}

module.exports = {
  DEFAULT_TOLERANCE_SEC,
  MAX_BODY_BYTES,
  loadEnvFile,
  stripeLog,
  verifySignature,
  withTransaction,
  paymentEventExists,
  findLeadById,
  markClosedWonStatements,
  closeFromPayment,
  todayStr,
  paymentLinkSentToday,
};
