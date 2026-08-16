// scripts/test/stripe.test.js — Phase 5 tests for the payments arm.
//
// Run:  npm test   (node --test test/linkedin-outreach.test.js test/ai.test.js
//                   test/stripe.test.js)
//
// Fully offline EXCEPT the final SQL test, which runs against the REAL Neon
// DB inside BEGIN…ROLLBACK (nothing survives) and is skipped automatically
// when DATABASE_URL is not set — same pattern as the Phase 3 SQL test.
//
// Coverage:
//   1. verifySignature — real HMAC computed over a fixture body passes;
//      wrong key / missing header / stale timestamp are rejected.
//   2. HTTP surface (real node:http server on an ephemeral port, mock DB):
//      /health 200; missing/invalid signature → 400; malformed JSON → 400;
//      happy-path checkout.session.completed → 200 + lead closed_won +
//      payment_received event (via client_reference_id AND metadata.lead_id);
//      unknown lead → 200 + no change; duplicate session → 200 + no double
//      event; non-checkout event ignored; no secret → 500.
//   3. payment.js — link building from env (+ ?client_reference_id), event
//      logging, same-day idempotency, per-product separation, no-URL and
//      pure-builder fallbacks.
//   4. SQL helpers against real Neon (BEGIN…ROLLBACK).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');

const core = require('../stripe-core');
const webhook = require('../stripe-webhook');
const payment = require('../payment');

const TEST_SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Fixtures + signing helpers
// ---------------------------------------------------------------------------
// Compute a REAL Stripe-scheme signature over the JSON body: header
// "t=<unix>,v1=<hex hmac of '<t>.<rawBody>'>" — exactly what Stripe sends.
function signFixture(bodyObj, secret = TEST_SECRET, tSec = nowSec()) {
  const body = JSON.stringify(bodyObj);
  const v1 = crypto.createHmac('sha256', secret).update(`${tSec}.${body}`).digest('hex');
  return { body, header: `t=${tSec},v1=${v1}` };
}

function sessionFixture(overrides) {
  return {
    id: `cs_test_${Math.floor(Math.random() * 1e9)}`,
    object: 'checkout.session',
    client_reference_id: '1',
    amount_total: 250000,
    currency: 'usd',
    payment_status: 'paid',
    created: nowSec(),
    ...overrides,
  };
}
function completedEvent(session) {
  return {
    id: `evt_test_${Math.floor(Math.random() * 1e9)}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: session },
  };
}

// ---------------------------------------------------------------------------
// Mock DB — an in-memory stand-in for the real `q` query function. Handles
// exactly the SQL the Phase 5 code issues (BEGIN/COMMIT/ROLLBACK are no-ops).
// ---------------------------------------------------------------------------
function makeMockDb() {
  const leads = [{ id: '1', business_name: 'Test Co', status: 'negotiating' }];
  const events = [];
  let nextEventId = 1;
  const q = async (sql, params = []) => {
    const s = String(sql).trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
    if (s.startsWith('SELECT 1 AS x FROM lead_events')) {
      const dup = events.some((e) => e.payload && e.payload.session_id === String(params[0]));
      return { rows: dup ? [{ x: 1 }] : [] };
    }
    if (s.startsWith('SELECT id, business_name, status FROM leads')) {
      const lead = leads.find((l) => String(l.id) === String(params[0]));
      return { rows: lead ? [{ id: lead.id, business_name: lead.business_name, status: lead.status }] : [] };
    }
    if (s.startsWith('UPDATE leads SET status')) {
      const lead = leads.find((l) => String(l.id) === String(params[0]));
      if (!lead) return { rowCount: 0 };
      lead.status = 'closed_won';
      return { rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO lead_events')) {
      // Event type is a SQL literal (VALUES ($1, 'payment_received', $2)) and
      // the payload is param 2 of [leadId, payload] — i.e. params[1].
      const m = s.match(/'([a-z_]+)'\s*,\s*\$2/);
      const id = nextEventId++;
      events.push({ id, lead_id: params[0], event_type: m ? m[1] : 'unknown', payload: params[1], created_at: new Date().toISOString() });
      return { rows: [{ id }] };
    }
    if (s.startsWith('SELECT id FROM lead_events')) {
      const found = events.find(
        (e) =>
          String(e.lead_id) === String(params[0]) &&
          e.event_type === 'payment_link_sent' &&
          e.payload && e.payload.product === params[1]
      );
      return { rows: found ? [{ id: found.id }] : [] };
    }
    throw new Error(`mock q: unhandled SQL: ${s.slice(0, 80)}`);
  };
  return { q, leads, events };
}

// Boot a real node:http server on an ephemeral port, run fn(baseUrl), close.
async function withServer(deps, fn) {
  const server = webhook.createServer(deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
    if (server.closeAllConnections) server.closeAllConnections();
  }
}

function mockDeps() {
  const db = makeMockDb();
  const deps = {
    secret: TEST_SECRET,
    log: () => {},
    connect: async () => ({ q: db.q, release: () => {} }),
  };
  return { db, deps };
}

// ---------------------------------------------------------------------------
// 1. verifySignature
// ---------------------------------------------------------------------------
test('verifySignature: a real HMAC over the fixture body passes', () => {
  const { body, header } = signFixture(completedEvent(sessionFixture()));
  const res = core.verifySignature(TEST_SECRET, body, header);
  assert.equal(res.ok, true, JSON.stringify(res));
});

test('verifySignature: wrong secret / wrong v1 is rejected', () => {
  const { body, header } = signFixture(completedEvent(sessionFixture()));
  assert.equal(core.verifySignature('whsec_wrong', body, header).ok, false);
  // Same t, tampered signature
  const tampered = header.replace(/v1=[0-9a-f]{10}/, 'v1=0000000000');
  assert.equal(core.verifySignature(TEST_SECRET, body, tampered).ok, false);
});

test('verifySignature: missing header, missing secret, missing v1 rejected', () => {
  const { body } = signFixture(completedEvent(sessionFixture()));
  assert.equal(core.verifySignature(TEST_SECRET, body, undefined).ok, false);
  assert.equal(core.verifySignature('', body, 't=1,v1=ab').ok, false);
  assert.equal(core.verifySignature(TEST_SECRET, body, 't=123').ok, false);
});

test('verifySignature: stale timestamp outside tolerance is rejected', () => {
  const { body, header } = signFixture(completedEvent(sessionFixture()), TEST_SECRET, nowSec() - 3600);
  assert.equal(core.verifySignature(TEST_SECRET, body, header).ok, false);
});

// ---------------------------------------------------------------------------
// 2. HTTP surface (real server, mock DB)
// ---------------------------------------------------------------------------
test('GET /health responds 200 ok', async () => {
  await withServer(mockDeps().deps, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
});

test('POST /webhook/stripe without Stripe-Signature → 400', async () => {
  await withServer(mockDeps().deps, async (base) => {
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /webhook/stripe with an invalid signature → 400', async () => {
  await withServer(mockDeps().deps, async (base) => {
    const { body } = signFixture(completedEvent(sessionFixture()));
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body,
    });
    assert.equal(res.status, 400);
  });
});

test('POST malformed JSON with a valid signature → 400', async () => {
  await withServer(mockDeps().deps, async (base) => {
    const raw = '{ this is not json';
    const v1 = crypto.createHmac('sha256', TEST_SECRET).update(`${nowSec()}.${raw}`).digest('hex');
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${nowSec()},v1=${v1}` },
      body: raw,
    });
    assert.equal(res.status, 400);
  });
});

test('happy path: signed checkout.session.completed → 200, lead closed_won + payment_received event', async () => {
  const { db, deps } = mockDeps();
  const session = sessionFixture();
  await withServer(deps, async (base) => {
    const { body, header } = signFixture(completedEvent(session));
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
  assert.equal(db.leads[0].status, 'closed_won');
  assert.equal(db.events.length, 1);
  const ev = db.events[0];
  assert.equal(ev.event_type, 'payment_received');
  assert.equal(ev.lead_id, '1');
  assert.equal(ev.payload.session_id, session.id);
  assert.equal(ev.payload.amount_total, 250000);
  assert.equal(ev.payload.currency, 'usd');
  assert.ok(ev.payload.paid_at, 'paid_at present');
});

test('lead resolution via metadata.lead_id (no client_reference_id) works', async () => {
  const { db, deps } = mockDeps();
  const session = sessionFixture({ client_reference_id: null, metadata: { lead_id: '1' } });
  await withServer(deps, async (base) => {
    const { body, header } = signFixture(completedEvent(session));
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body,
    });
    assert.equal(res.status, 200);
  });
  assert.equal(db.leads[0].status, 'closed_won');
  assert.equal(db.events.length, 1);
});

test('unknown lead → 200 and NO state change (Stripe stops retrying)', async () => {
  const { db, deps } = mockDeps();
  const session = sessionFixture({ client_reference_id: '99999' });
  await withServer(deps, async (base) => {
    const { body, header } = signFixture(completedEvent(session));
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body,
    });
    assert.equal(res.status, 200);
  });
  assert.equal(db.leads[0].status, 'negotiating', 'lead untouched');
  assert.equal(db.events.length, 0, 'no event for unknown lead');
});

test('non-checkout event (e.g. invoice.paid) → 200, no writes', async () => {
  const { db, deps } = mockDeps();
  await withServer(deps, async (base) => {
    const { body, header } = signFixture({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } });
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body,
    });
    assert.equal(res.status, 200);
  });
  assert.equal(db.leads[0].status, 'negotiating');
  assert.equal(db.events.length, 0);
});

test('duplicate session (Stripe retry) → 200, still exactly one payment_received event', async () => {
  const { db, deps } = mockDeps();
  const session = sessionFixture();
  const { body, header } = signFixture(completedEvent(session));
  await withServer(deps, async (base) => {
    const first = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body,
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body,
    });
    assert.equal(second.status, 200);
    assert.equal(await second.text(), 'duplicate');
  });
  assert.equal(db.leads[0].status, 'closed_won');
  assert.equal(db.events.length, 1, 'no double event on retry');
});

test('webhook without STRIPE_WEBHOOK_SECRET → 500 (Stripe retries)', async () => {
  const { deps } = mockDeps();
  delete deps.secret;
  await withServer(deps, async (base) => {
    const { body, header } = signFixture(completedEvent(sessionFixture()));
    const res = await fetch(`${base}/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body,
    });
    assert.equal(res.status, 500);
  });
});

// ---------------------------------------------------------------------------
// 3. payment.js — link building + idempotent event logging
// ---------------------------------------------------------------------------
const LINK_URLS = ['STRIPE_PAYMENT_LINK_PREMIUM_SITE', 'STRIPE_PAYMENT_LINK_STARTER_SITE', 'STRIPE_PAYMENT_LINK_DEFAULT'];
test.afterEach(() => {
  for (const k of LINK_URLS) delete process.env[k];
});

test('sendPaymentLink builds the URL from env + logs one payment_link_sent (idempotent same day)', async () => {
  process.env.STRIPE_PAYMENT_LINK_PREMIUM_SITE = 'https://buy.stripe.com/test_premium';
  const { q, events } = makeMockDb();
  const lead = { id: '42', business_name: 'Test Co' };
  const first = await payment.sendPaymentLink(lead, 'premium_site', { query: q });
  assert.ok(first, 'link returned');
  assert.equal(first.url, 'https://buy.stripe.com/test_premium?client_reference_id=42');
  assert.equal(first.product, 'premium_site');
  assert.equal(first.logged, true);
  assert.ok(first.eventId);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'payment_link_sent');
  assert.equal(events[0].payload.product, 'premium_site');
  assert.equal(events[0].payload.stripe_url, first.url);

  // Same lead + product, same day → same event, no second row.
  const second = await payment.sendPaymentLink(lead, 'premium_site', { query: q });
  assert.equal(second.logged, false);
  assert.equal(second.eventId, first.eventId);
  assert.equal(events.length, 1, 'idempotent within the day');
});

test('sendPaymentLink: different product the same day logs a separate event', async () => {
  process.env.STRIPE_PAYMENT_LINK_PREMIUM_SITE = 'https://buy.stripe.com/a';
  process.env.STRIPE_PAYMENT_LINK_STARTER_SITE = 'https://buy.stripe.com/b';
  const { q, events } = makeMockDb();
  const lead = { id: '7' };
  await payment.sendPaymentLink(lead, 'premium_site', { query: q });
  await payment.sendPaymentLink(lead, 'starter_site', { query: q });
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((e) => e.payload.product)).size, 2);
});

test('sendPaymentLink: unknown product falls back to STRIPE_PAYMENT_LINK_<UPPER> then DEFAULT', async () => {
  process.env.STRIPE_PAYMENT_LINK_CUSTOM_BUILD = 'https://buy.stripe.com/custom';
  const { q } = makeMockDb();
  const out = await payment.sendPaymentLink({ id: '3' }, 'custom-build', { query: q });
  assert.equal(out.url, 'https://buy.stripe.com/custom?client_reference_id=3');

  // No env for the product → DEFAULT env var is the fallback.
  process.env.STRIPE_PAYMENT_LINK_DEFAULT = 'https://buy.stripe.com/fallback';
  const out2 = await payment.sendPaymentLink({ id: '3' }, 'unmapped-product', { query: q });
  assert.equal(out2.url, 'https://buy.stripe.com/fallback?client_reference_id=3');
});

test('sendPaymentLink: no URL configured → null, no event logged', async () => {
  const { q, events } = makeMockDb();
  const out = await payment.sendPaymentLink({ id: '3' }, 'premium_site', { query: q });
  assert.equal(out, null);
  assert.equal(events.length, 0);
});

test('sendPaymentLink: pure builder mode (no query fn) returns URL, logged:false', async () => {
  process.env.STRIPE_PAYMENT_LINK_PREMIUM_SITE = 'https://buy.stripe.com/pure';
  const out = await payment.sendPaymentLink({ id: '9' }, 'premium_site', {});
  assert.equal(out.url, 'https://buy.stripe.com/pure?client_reference_id=9');
  assert.equal(out.logged, false);
  assert.equal(out.eventId, null);
});

// ---------------------------------------------------------------------------
// 4. SQL helpers against the real DB (BEGIN…ROLLBACK — nothing survives)
// ---------------------------------------------------------------------------
const dbUrl = process.env.DATABASE_URL;
test('stripe SQL helpers (real DB, rolled back)', { skip: !dbUrl }, async () => {
  const u = new URL(dbUrl);
  u.searchParams.delete('channel_binding');
  u.searchParams.delete('sslmode');
  const pool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
  const client = await pool.connect();
  const q = client.query.bind(client);
  const tag = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    // Baseline: purge any scratch rows leaked by crashed runs first, then
    // capture the true production counts (66 leads / 6 events).
    await client.query('DELETE FROM leads WHERE source_batch LIKE $1', ['test-%']);
    const beforeLeadsCount = (await client.query('SELECT count(*)::int AS n FROM leads')).rows[0].n;
    const beforeEventsCount = (await client.query('SELECT count(*)::int AS n FROM lead_events')).rows[0].n;

    await client.query('BEGIN');
    try {
      const ins = await client.query(
        `INSERT INTO leads (business_name, phone, email, website, website_status, city, niche, source_batch, status)
         VALUES ('Stripe Test ' || $1, NULL, NULL, NULL, 'none', 'Test City, XX', 'Test Niche', $2, 'negotiating') RETURNING id`,
        [tag, tag]
      );
      const id = ins.rows[0].id;

      // findLeadById: numeric hit, numeric miss, non-numeric ref.
      assert.equal((await core.findLeadById(q, id)).id, id);
      assert.equal(await core.findLeadById(q, '99999999999999'), null);
      assert.equal(await core.findLeadById(q, 'not-a-number'), null);

      // paymentEventExists: false before, true after the close.
      const session = {
        id: `cs_test_${tag}`,
        amount_total: 125000,
        currency: 'usd',
        payment_status: 'paid',
        created: nowSec(),
      };
      assert.equal(await core.paymentEventExists(q, session.id), false);
      const out = await core.markClosedWonStatements(q, id, session);
      assert.equal(out.updated, true);
      assert.ok(out.eventId);
      assert.equal(out.payload.session_id, session.id);
      assert.equal(out.payload.amount_total, 125000);
      assert.equal(out.payload.currency, 'usd');
      assert.ok(out.payload.paid_at);
      const lead = (await client.query('SELECT status FROM leads WHERE id = $1', [id])).rows[0];
      assert.equal(lead.status, 'closed_won');
      assert.equal(await core.paymentEventExists(q, session.id), true);
      const evt = (await client.query(
        `SELECT event_type, payload FROM lead_events WHERE id = $1`,
        [out.eventId]
      )).rows[0];
      assert.equal(evt.event_type, 'payment_received');
      assert.equal(evt.payload.session_id, session.id);

      // todayStr + paymentLinkSentToday (uses the same lead)
      const sent = await core.paymentLinkSentToday(q, id, 'premium_site');
      assert.equal(sent, null);
      const pl = await client.query(
        `INSERT INTO lead_events (lead_id, event_type, payload)
         VALUES ($1, 'payment_link_sent', '{"product":"premium_site","stripe_url":"https://buy.stripe.com/x"}') RETURNING id`,
        [id]
      );
      assert.equal(await core.paymentLinkSentToday(q, id, 'premium_site'), pl.rows[0].id);
      assert.equal(await core.paymentLinkSentToday(q, id, 'starter_site'), null, 'product-scoped');
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    // closeFromPayment transactional wrapper — runs its own BEGIN…COMMIT on a
    // FRESH transaction (outer one already rolled back), then we clean up the
    // scratch row by hand so nothing survives.
    const ins2 = await client.query(
      `INSERT INTO leads (business_name, phone, email, website, website_status, city, niche, source_batch, status)
       VALUES ('Stripe TX Test ' || $1, NULL, NULL, NULL, 'none', 'Test City, XX', 'Test Niche', $2, 'negotiating') RETURNING id`,
      [tag, tag]
    );
    const id2 = ins2.rows[0].id;
    const res = await core.closeFromPayment(q, String(id2), { id: `cs_test_tx_${tag}`, amount_total: 999, currency: 'usd', created: nowSec() });
    assert.equal(res.found, true);
    assert.equal(res.duplicate, false);
    assert.equal(res.updated, true);
    const status2 = (await client.query('SELECT status FROM leads WHERE id = $1', [id2])).rows[0].status;
    assert.equal(status2, 'closed_won');
    // Duplicate call on the same session → no-op, no second event.
    const dup = await core.closeFromPayment(q, String(id2), { id: `cs_test_tx_${tag}`, amount_total: 999, currency: 'usd' });
    assert.equal(dup.duplicate, true);
    const evts = (await client.query(
      `SELECT count(*)::int AS n FROM lead_events WHERE lead_id = $1 AND event_type = 'payment_received'`,
      [id2]
    )).rows[0].n;
    assert.equal(evts, 1, 'duplicate session does not double-log');
    // Unknown lead → found:false, no event.
    const miss = await core.closeFromPayment(q, '99999999999999', { id: 'cs_test_miss', amount_total: 1, currency: 'usd' });
    assert.equal(miss.found, false);
    await client.query('DELETE FROM leads WHERE id = $1', [id2]);

    // Nothing survived.
    await client.query('DELETE FROM leads WHERE source_batch LIKE $1', ['test-%']);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM leads')).rows[0].n, beforeLeadsCount, 'leads count unchanged');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM lead_events')).rows[0].n, beforeEventsCount, 'events count unchanged');
  } finally {
    client.release();
    await pool.end();
  }
});
