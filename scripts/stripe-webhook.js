// scripts/stripe-webhook.js — Phase 5: the machine's revenue loop.
//
// A zero-dependency Node HTTP server (node:http + node:crypto only — no SDK,
// no framework) that receives Stripe webhook events and turns a payment into
// a closed deal:
//
//   POST /webhook/stripe   — verify Stripe-Signature (HMAC-SHA256, t=…&v1=…
//                            scheme) with STRIPE_WEBHOOK_SECRET; on
//                            `checkout.session.completed`, resolve the lead
//                            from session.client_reference_id OR
//                            session.metadata.lead_id, set status='closed_won'
//                            and append a `payment_received` lead_events row.
//   GET  /health           — 200 "ok" (used by process managers / uptime
//                            checks; the port is STRIPE_WEBHOOK_PORT or --port,
//                            default 8787).
//
// Response contract (why each status):
//   400 — bad request (missing/invalid signature, malformed JSON). Stripe
//         treats 4xx as permanent and stops retrying — correct, because a
//         bad signature or unparseable body will never fix itself.
//   200 — valid signed event that is NOT actionable (non-checkout event,
//         unknown/missing lead, duplicate session, no lead reference). Stripe
//         stops retrying; there is nothing to retry.
//   500 — server-side failure on a VALID event (DB down / secret not
//         configured). Stripe retries with exponential backoff, which is
//         exactly what we want — the event is good, the machine just needs
//         another shot.
//
// Graceful shutdown on SIGTERM/SIGINT: stop accepting, drain, close the DB
// pool, exit 0.
//
// Env (all secrets env-only — never in code):
//   STRIPE_WEBHOOK_SECRET         whsec_… signing secret from the Stripe
//                                 dashboard (required for /webhook/stripe)
//   STRIPE_WEBHOOK_TOLERANCE_SEC  signature timestamp tolerance (default 300)
//   DATABASE_URL                  Neon connection string; the server still
//                                 starts without it (health works) but valid
//                                 events 500 until it is set
//   STRIPE_WEBHOOK_PORT / --port  listen port (default 8787)
//
// Usage:
//   node scripts/stripe-webhook.js            # defaults, reads scripts/.env
//   node scripts/stripe-webhook.js --port 9000
//
// The eventual blueprint has n8n as the orchestrator: n8n's
// /webhook/payment-received endpoint can forward here (same payload, same
// Stripe-Signature header) or replace this handler entirely — see
// scripts/README.md Phase 5 for the wiring options.
'use strict';

const http = require('http');
const core = require('./stripe-core');

const SCRIPT_DIR = __dirname;
const DEFAULT_PORT = 8787;

// ---------------------------------------------------------------------------
// Raw body reader — accumulate chunks, cap the size, never parse early.
// (Stripe signs the RAW body; JSON.parse before verification would break the
// HMAC for any payload whose whitespace differs from what Stripe sent.)
// ---------------------------------------------------------------------------
function readRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve({ ok: false, reason: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ ok: true, data: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false, reason: 'connection error' }));
  });
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Request → response for the whole server. `deps`:
//   secret        webhook signing secret (string; falls back to env)
//   toleranceSec  signature tolerance (number; falls back to env / default)
//   log           (msg) => void — default console.log with [stripe] prefix
//   connect       async () => { q, release } — per-event DB connection.
//                 Without it (or when it throws) a valid event 500s so
//                 Stripe retries. Tests inject a mock or a txn client.
// ---------------------------------------------------------------------------
async function handleRequest(req, res, deps) {
  const log = deps.log || ((m) => console.log(`  [stripe] ${m}`));
  const pathname = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && pathname === '/health') {
    send(res, 200, 'ok');
    return;
  }
  if (req.method !== 'POST' || pathname !== '/webhook/stripe') {
    send(res, 404, 'not found');
    return;
  }

  const secret = deps.secret || process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) {
    log('STRIPE_WEBHOOK_SECRET not configured — 500 so Stripe retries once it is set');
    send(res, 500, 'webhook secret not configured');
    return;
  }

  const body = await readRawBody(req, core.MAX_BODY_BYTES);
  if (!body.ok) {
    log(`raw body read failed: ${body.reason}`);
    send(res, 413, 'payload too large');
    return;
  }

  const signature = req.headers['stripe-signature'];
  const verified = core.verifySignature(
    secret,
    body.data,
    signature,
    deps.toleranceSec || process.env.STRIPE_WEBHOOK_TOLERANCE_SEC
  );
  if (!verified.ok) {
    log(`signature rejected: ${verified.reason}`);
    send(res, 400, 'invalid signature');
    return;
  }

  let event;
  try {
    event = JSON.parse(body.data);
  } catch {
    log('malformed JSON body — 400');
    send(res, 400, 'invalid JSON');
    return;
  }
  if (!event || typeof event !== 'object') {
    log('event is not an object — 400');
    send(res, 400, 'invalid event');
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    log(`event ${event.type || '(no type)'} ignored (200)`);
    send(res, 200, 'ignored');
    return;
  }

  const session = event.data && event.data.object;
  if (!session || typeof session !== 'object') {
    log('checkout.session.completed without data.object — 200');
    send(res, 200, 'ignored');
    return;
  }

  // Resolve the lead: client_reference_id (set by payment.js via
  // ?client_reference_id=<id> on the payment-link URL) or metadata.lead_id
  // (set when the checkout session was created via the Stripe API).
  const ref =
    session.client_reference_id ||
    (session.metadata && session.metadata.lead_id) ||
    null;

  if (!deps.connect) {
    log('no DB connection available — 500 so Stripe retries');
    send(res, 500, 'db unavailable');
    return;
  }

  let conn;
  try {
    conn = await deps.connect();
    const result = await core.closeFromPayment(conn.q, ref, session);
    if (!result.found) {
      log(`no lead for ref=${ref} — 200, no state change (Stripe stops retrying)`);
      send(res, 200, 'unknown lead');
      return;
    }
    if (result.duplicate) {
      log(`session ${session.id} already processed — 200, no state change`);
      send(res, 200, 'duplicate');
      return;
    }
    if (!result.updated) {
      log(`lead ${result.lead && result.lead.id} update no-op — 200`);
      send(res, 200, 'no-op');
      return;
    }
    log(
      `CLOSED-WON: lead ${result.lead && result.lead.id} (${result.lead && result.lead.business_name}) ` +
        `payment_received event #${result.eventId} ` +
        `amount ${result.payload.amount_total} ${result.payload.currency}`
    );
    send(res, 200, 'ok');
  } catch (err) {
    log(`DB error processing event: ${err.message} — 500 so Stripe retries`);
    send(res, 500, 'db error');
  } finally {
    if (conn && typeof conn.release === 'function') conn.release();
  }
}

// ---------------------------------------------------------------------------
// Server factory (exported so tests can bind an ephemeral port and inject a
// mock DB / txn client; the CLI path uses main() below).
// ---------------------------------------------------------------------------
function createServer(deps) {
  const d = deps || {};
  return http.createServer((req, res) => {
    handleRequest(req, res, d).catch((err) => {
      d.log && d.log(`unhandled error: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.end();
    });
  });
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------
function parsePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) return Number(argv[i + 1]);
  }
  const fromEnv = Number(process.env.STRIPE_WEBHOOK_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

function main() {
  core.loadEnvFile(`${SCRIPT_DIR}/.env`);
  const { Pool } = require('pg'); // dev dependency, only needed when writing
  const port = parsePort(process.argv.slice(2));
  const log = (m) => console.log(`  [stripe] ${m}`);

  let pool = null;
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.delete('channel_binding');
    u.searchParams.delete('sslmode');
    pool = new Pool({
      connectionString: u.toString(),
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    log(`DB pool ready (leads table via DATABASE_URL)`);
  } else {
    log('WARNING: DATABASE_URL not set — /health works, valid webhook events will 500 until it is set');
  }

  const server = createServer({
    secret: process.env.STRIPE_WEBHOOK_SECRET,
    toleranceSec: process.env.STRIPE_WEBHOOK_TOLERANCE_SEC,
    log,
    connect: pool
      ? async () => {
          const client = await pool.connect();
          return { q: client.query.bind(client), release: () => client.release() };
        }
      : null,
  });

  server.listen(port, '0.0.0.0', () => {
    log(`webhook listening on :${port} — POST /webhook/stripe, GET /health`);
    log(`STRIPE_WEBHOOK_SECRET ${process.env.STRIPE_WEBHOOK_SECRET ? 'set' : 'NOT set'}`);
  });

  const shutdown = (signal) => {
    log(`${signal} received — draining and shutting down`);
    server.close(() => {
      if (pool) pool.end().catch(() => {}).finally(() => process.exit(0));
      else process.exit(0);
    });
    // Safety net: if a keep-alive connection won't drain, exit anyway.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = { createServer, handleRequest, readRawBody, send, main, DEFAULT_PORT };
