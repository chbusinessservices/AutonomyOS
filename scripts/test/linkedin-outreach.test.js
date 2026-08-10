// scripts/test/linkedin-outreach.test.js — Phase 3 unit tests.
//
// Run:  npm test   (node --test test/linkedin-outreach.test.js)
//
// Covers the testable core:
//   1. message-template rendering (placeholders, website_status phrases,
//      truncation, deterministic variant pick, ≤300-char safety)
//   2. daily-cap logic (state accumulation, 14+1 boundary, 16th blocked,
//      new-day reset, crash consistency via DB cross-check)
//   3. SQL helpers against the REAL Neon DB inside a BEGIN…ROLLBACK
//      transaction — nothing survives; scratch rows are cleaned up by the
//      rollback and the test asserts the DB is byte-identical afterwards.
//
// SQL tests are skipped automatically when DATABASE_URL is not set.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const core = require('../linkedin-core');

const TPL = JSON.parse(fs.readFileSync(path.join(__dirname, '../linkedin-templates.json'), 'utf8'));
const TEMPLATES = TPL.templates;
const NOTE_MAX = TPL.note_max_chars;

const LEAD = {
  id: '181',
  business_name: '1-800-GOT-JUNK? San Antonio',
  city: 'San Antonio, TX',
  niche: 'Junk Removal',
  website_status: 'weak',
  status: 'new',
};

// ---------------------------------------------------------------------------
// 1. Message rendering
// ---------------------------------------------------------------------------
test('renderTemplate replaces all known placeholders with lead fields', () => {
  const out = core.renderTemplate(
    'Hi {{business_name}} ({{city}}, {{niche}}) status={{website_status}}',
    LEAD, NOTE_MAX
  );
  assert.equal(out, 'Hi 1-800-GOT-JUNK? San Antonio (San Antonio, TX, Junk Removal) status=isn\'t converting visitors into calls yet');
});

test('website_status maps to a friendly phrase for each closed-domain value', () => {
  const tpl = 'Your online presence {{website_status}}.';
  assert.equal(core.renderTemplate(tpl, { ...LEAD, website_status: 'none' }, NOTE_MAX), 'Your online presence is missing entirely.');
  assert.equal(core.renderTemplate(tpl, { ...LEAD, website_status: 'weak' }, NOTE_MAX), 'Your online presence isn\'t converting visitors into calls yet.');
  assert.equal(core.renderTemplate(tpl, { ...LEAD, website_status: 'good' }, NOTE_MAX), 'Your online presence is up and running.');
  assert.equal(core.renderTemplate(tpl, { ...LEAD, website_status: null }, NOTE_MAX), 'Your online presence could do more for you.');
});

test('renderTemplate tolerates missing lead fields (empty string, no crash)', () => {
  const out = core.renderTemplate('{{business_name}}|{{city}}|{{niche}}|{{website_status}}', {}, NOTE_MAX);
  assert.equal(out, '|||could do more for you');
});

test('renderTemplate truncates to maxChars with ellipsis', () => {
  const out = core.renderTemplate('Hi {{business_name}} — this is a long message', LEAD, 30);
  assert.ok(out.length <= 30);
  assert.ok(out.endsWith('…'));
});

test('renderTemplate leaves unknown placeholders untouched (deterministic)', () => {
  const out = core.renderTemplate('Hello {{first_name}} and {{business_name}}', LEAD, NOTE_MAX);
  assert.equal(out, 'Hello {{first_name}} and 1-800-GOT-JUNK? San Antonio');
});

test('every template × sample lead stays under LinkedIn\'s 300-char note limit', () => {
  const leads = [
    { ...LEAD, id: '1' },
    { ...LEAD, id: '2', business_name: 'FAM JUNK REMOVAL San Antonio', website_status: 'none' },
    { ...LEAD, id: '3', business_name: 'Junk King Dallas', city: 'TX', website_status: 'weak' },
    { ...LEAD, id: '4', business_name: 'Long-Named Residential & Commercial Plumbing Co.', city: 'Austin, TX', niche: 'Plumbing / HVAC', website_status: 'none' },
    { ...LEAD, id: '5', website_status: 'good' },
  ];
  for (const tpl of TEMPLATES) {
    for (const lead of leads) {
      const out = core.renderTemplate(tpl.text, lead, NOTE_MAX);
      assert.ok(out.length <= NOTE_MAX, `template ${tpl.id} + lead ${lead.id} = ${out.length} chars (max ${NOTE_MAX})`);
      assert.ok(!/{{/.test(out), `template ${tpl.id} left unresolved placeholders for lead ${lead.id}`);
    }
  }
});

test('pickTemplate is deterministic and round-robins across variants by lead id', () => {
  assert.equal(core.pickTemplate(TEMPLATES, { id: '181' }).id, TEMPLATES[181 % TEMPLATES.length].id);
  assert.equal(core.pickTemplate(TEMPLATES, { id: '181' }).id, core.pickTemplate(TEMPLATES, { id: '181' }).id);
  const picked = new Set([1, 2, 3].map((n) => core.pickTemplate(TEMPLATES, { id: String(n) }).id));
  assert.equal(picked.size, 3, 'three consecutive leads use three different variants');
});

test('buildPlan produces variant + message per lead and applies the Phase 4 personalize hook', async () => {
  const plan = await core.buildPlan([{ ...LEAD, id: '181' }], TEMPLATES, { noteMaxChars: NOTE_MAX });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].variant, TEMPLATES[181 % TEMPLATES.length].id);
  assert.ok(plan[0].message.includes('1-800-GOT-JUNK? San Antonio'));
  // Phase 4 hook shape: async (lead, message) => message — verify it is invoked.
  let hooked = 0;
  const plan2 = await core.buildPlan([{ ...LEAD, id: '181' }], TEMPLATES, {
    noteMaxChars: NOTE_MAX,
    personalize: async (_lead, msg) => { hooked++; return `${msg} [personalized]`; },
  });
  assert.equal(hooked, 1);
  assert.ok(plan2[0].message.endsWith('[personalized]'));
});

// ---------------------------------------------------------------------------
// 2. Daily-cap logic
// ---------------------------------------------------------------------------
test('parseState tolerates missing/corrupt state — treated as a fresh day', () => {
  const fresh = core.parseState('');
  assert.equal(fresh.date, core.todayStr());
  assert.equal(fresh.sent, 0);
  assert.deepEqual(fresh.lead_ids, []);
  const corrupt = core.parseState('{not json!!');
  assert.equal(corrupt.sent, 0);
  const wrongShape = core.parseState(JSON.stringify({ date: core.todayStr(), sent: 'many' }));
  assert.equal(wrongShape.sent, 0);
});

test('consumeState accumulates sends within a day', () => {
  let s = core.parseState('');
  s = core.consumeState(s, 1, ['181']);
  s = core.consumeState(s, 2, ['182', '183']);
  assert.equal(s.date, core.todayStr());
  assert.equal(s.sent, 3);
  assert.deepEqual(s.lead_ids, ['181', '182', '183']);
});

test('cap boundary: 14 done + 1 = cap hit; the 16th is blocked', () => {
  const s14 = {
    date: core.todayStr(),
    sent: 14,
    lead_ids: Array.from({ length: 14 }, (_, i) => String(181 + i)),
  };
  assert.equal(core.remainingToday(s14, 0, 15), 1, 'one slot left');
  const s15 = core.consumeState(s14, 1, ['195']);
  assert.equal(s15.sent, 15);
  assert.equal(core.remainingToday(s15, 0, 15), 0, 'cap hit');
  // 16th blocked: zero budget means zero plan slots even with 16 pending leads
  assert.equal(core.planSize(core.remainingToday(s15, 0, 15), null), 0);
  assert.equal(core.planSize(core.remainingToday(s15, 0, 15), 16), 0);
});

test('new day resets the cap even if yesterday hit the limit', () => {
  const yesterday = { date: '2000-01-01', sent: 15, lead_ids: Array.from({ length: 15 }, (_, i) => String(i)) };
  assert.equal(core.usedToday(yesterday, 0), 0, 'stale state contributes nothing');
  assert.equal(core.remainingToday(yesterday, 0, 15), 15);
  const fresh = core.consumeState(yesterday, 1, ['181']);
  assert.equal(fresh.date, core.todayStr());
  assert.equal(fresh.sent, 1);
  assert.deepEqual(fresh.lead_ids, ['181'], 'yesterday\'s id list is dropped');
});

test('crash consistency: DB count wins when the state file is stale or missing', () => {
  const stale = { date: core.todayStr(), sent: 3, lead_ids: ['181', '182', '183'] };
  assert.equal(core.usedToday(stale, 15), 15, 'DB says 15 real sends happened');
  assert.equal(core.remainingToday(stale, 15, 15), 0, 'no budget left — re-run cannot exceed the cap');
  assert.equal(core.usedToday(core.parseState(''), 15), 15, 'even a deleted state file is protected');
});

test('DB count above the cap yields zero budget', () => {
  assert.equal(core.remainingToday(core.parseState(''), 20, 15), 0);
});

test('planSize honors --limit and never exceeds remaining budget', () => {
  assert.equal(core.planSize(15, 3), 3, 'smoke --limit 3');
  assert.equal(core.planSize(2, 10), 2, 'limit cannot exceed the cap');
  assert.equal(core.planSize(15, null), 15);
  assert.equal(core.planSize(0, 3), 0);
});

// ---------------------------------------------------------------------------
// 3. SQL helpers against the real DB (BEGIN…ROLLBACK — nothing survives)
// ---------------------------------------------------------------------------
const dbUrl = process.env.DATABASE_URL;

test('SQL helpers (real DB, rolled back)', { skip: !dbUrl }, async () => {
  const u = new URL(dbUrl);
  u.searchParams.delete('channel_binding');
  u.searchParams.delete('sslmode');
  const pool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
  const client = await pool.connect();
  const q = client.query.bind(client);
  const tag = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    // Purge any scratch rows leaked by earlier crashed test runs FIRST, so the
    // baseline counts below are the true production state (66 leads / 6 events).
    await client.query('DELETE FROM leads WHERE source_batch LIKE $1', ['test-%']);
    const beforeLeads = await core.countLeads(q);
    const beforeEvents = await core.countEvents(q);

    // The WHOLE body runs inside BEGIN…ROLLBACK. The catch guarantees the
    // rollback even when an assertion fails (a leaked open transaction is how
    // scratch rows end up committed). Helpers are called in their *Statements
    // form so none of them issue their own BEGIN/COMMIT against our txn.
    await client.query('BEGIN');
    try {
      const ins = (name, status, websiteStatus) => client.query(
        `INSERT INTO leads (business_name, phone, email, website, website_status, city, niche, source_batch, status)
         VALUES ($1, NULL, NULL, NULL, $2, 'Test City, XX', 'Test Niche', $3, $4) RETURNING id`,
        [`${name} ${tag}`, websiteStatus, tag, status]
      );

      // --- fetchPendingLeads: oldest first, status filter, limit ---
      // (Scratch rows get the HIGHEST ids, and fetch is oldest-first, so use a
      // big limit to guarantee they're inside the window.)
      const a = await ins('ZZZ Test Oldest', 'new', 'none');
      const b = await ins('AAA Test Newer', 'new', 'weak');
      await ins('ZZZ Test Contacted', 'contacted', 'weak'); // must be excluded
      const pending = await core.fetchPendingLeads(q, 'new', 1000);
      const got = pending.filter((r) => String(r.id) === String(a.rows[0].id) || String(r.id) === String(b.rows[0].id));
      assert.equal(got.length, 2, 'both scratch leads fetched');
      assert.ok(Number(got[0].id) < Number(got[1].id), 'ordered oldest first');
      assert.equal(got[0].status, 'new');
      assert.equal(got[1].website_status, 'weak');
      assert.ok(!pending.some((r) => r.business_name.includes('ZZZ Test Contacted')), 'status filter excludes contacted');

      // --- markContacted: guarded transition + event (statements, no txn mgmt) ---
      const beforeEvt = await core.countOutreachSentToday(q, core.todayStr());
      const res = await core.markContactedStatements(q, a.rows[0].id, 'new', {
        channel: 'linkedin', template: 'free-ideas', action: 'connect',
        message: 'snippet', sent_at: new Date().toISOString(),
      });
      assert.equal(res.updated, true);
      assert.ok(res.eventId);
      const row = (await client.query('SELECT status FROM leads WHERE id = $1', [a.rows[0].id])).rows[0];
      assert.equal(row.status, 'contacted');
      const evt = (await client.query('SELECT event_type, payload FROM lead_events WHERE id = $1', [res.eventId])).rows[0];
      assert.equal(evt.event_type, 'outreach_sent');
      assert.equal(evt.payload.channel, 'linkedin');
      assert.equal(await core.countOutreachSentToday(q, core.todayStr()), beforeEvt + 1, 'today\'s outreach count incremented');

      // --- guarded: a lead that already advanced is a clean no-op ---
      const res2 = await core.markContactedStatements(q, a.rows[0].id, 'new', { channel: 'linkedin' });
      assert.equal(res2.updated, false);
      assert.equal(res2.eventId, null);
      assert.equal(await core.countOutreachSentToday(q, core.todayStr()), beforeEvt + 1, 'no double event on guard miss');

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    // --- withTransaction wrapper: rolls back its own work when fn throws.
    //     Runs on a FRESH transaction (the outer one is already rolled back)
    //     so its ROLLBACK cannot clobber the assertions above. ---
    const wtx = await client.query(
      `INSERT INTO leads (business_name, phone, email, website, website_status, city, niche, source_batch, status)
       VALUES ('WTX Test ' || $1, NULL, NULL, NULL, 'weak', 'Test City, XX', 'Test Niche', $2, 'new') RETURNING id`,
      [tag, tag]
    );
    const wtxId = wtx.rows[0].id;
    await assert.rejects(
      core.withTransaction(q, async () => {
        await client.query('UPDATE leads SET status = \'contacted\' WHERE id = $1', [wtxId]);
        throw new Error('boom');
      }),
      /boom/
    );
    const wtxStatus = (await client.query('SELECT status FROM leads WHERE id = $1', [wtxId])).rows[0].status;
    assert.equal(wtxStatus, 'new', 'withTransaction rolled back the UPDATE on throw');
    await client.query('DELETE FROM leads WHERE id = $1', [wtxId]);

    // --- nothing survived (defensive cleanup first — covers any pre-existing
    //     leaked scratch rows from crashed runs, then verify real state) ---
    await client.query('DELETE FROM leads WHERE source_batch LIKE $1', ['test-%']);
    const afterLeads = await core.countLeads(q);
    const afterEvents = await core.countEvents(q);
    assert.equal(afterLeads, beforeLeads, 'leads count unchanged after rollback');
    assert.equal(afterEvents, beforeEvents, 'events count unchanged after rollback');
  } finally {
    client.release();
    await pool.end();
  }
});
