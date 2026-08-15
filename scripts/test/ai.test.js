// scripts/test/ai.test.js — Phase 4 unit tests for the AI negotiation module.
//
// Run:  npm test   (node --test test/linkedin-outreach.test.js test/ai.test.js)
//
// All API calls are MOCKED via ai.setFetchImpl() — nothing in this file ever
// touches the network or a real DeepSeek key. Tests cover:
//   1. personalizeLead happy path (completion parsed from choices[0].message.content)
//   2. no DEEPSEEK_API_KEY → template fallback
//   3. API HTTP 500 → template fallback
//   4. timeout (abort signal + hard-deadline backstop) → template fallback
//   5. >300-char model output is truncated
//   6. malformed JSON / empty completion → template fallback
//   7. generateReply intent mapping (all five intents via the no-key canned
//      path) and the model path (JSON parsed from the completion)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ai = require('../ai');

const TPL = JSON.parse(fs.readFileSync(path.join(__dirname, '../linkedin-templates.json'), 'utf8'));
const NOTE_MAX = TPL.note_max_chars;

const LEAD = {
  id: '181',
  business_name: '1-800-GOT-JUNK? San Antonio',
  city: 'San Antonio, TX',
  niche: 'Junk Removal',
  website_status: 'weak',
  status: 'new',
};
const BASE = ai.truncate(TPL.templates[0].text, NOTE_MAX); // rendered 'free-ideas' template

// ---------------------------------------------------------------------------
// Mock plumbing — every test below runs through ai.setFetchImpl().
// ---------------------------------------------------------------------------
const REAL_FETCH = ai.getFetchImpl();

test.afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  ai.setFetchImpl(null); // restore the real fetch; nothing is ever called
  assert.equal(ai.getFetchImpl(), REAL_FETCH, 'fetchImpl restored after each test');
});

// Returns a mock fetch that resolves a DeepSeek-shaped response with the given
// completion content. Records the last request it saw for assertions.
function mockOkFetch(content, requests) {
  return async (url, opts) => {
    if (requests) requests.push({ url, opts });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// personalizeLead
// ---------------------------------------------------------------------------
test('personalizeLead happy path: completion parsed from choices[0].message.content', async () => {
  const requests = [];
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(mockOkFetch('Hi 1-800-GOT-JUNK? San Antonio — I have 3 ideas to get you more junk-removal calls. Open to a chat?', requests));
  const out = await ai.personalizeLead(LEAD, BASE);
  assert.equal(out, 'Hi 1-800-GOT-JUNK? San Antonio — I have 3 ideas to get you more junk-removal calls. Open to a chat?');
  assert.ok(out.length <= 300);
  // Request shape: right URL, bearer header from env, DeepSeek body shape
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, ai.DEEPSEEK_URL);
  assert.equal(requests[0].opts.method, 'POST');
  assert.equal(requests[0].opts.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(requests[0].opts.body);
  assert.equal(body.model, ai.DEEPSEEK_MODEL);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[1].content.includes('1-800-GOT-JUNK? San Antonio'), 'lead fields in prompt');
  assert.ok(body.messages[1].content.includes(BASE), 'base template in prompt');
});

test('personalizeLead without DEEPSEEK_API_KEY returns the rendered template', async () => {
  let called = false;
  ai.setFetchImpl(async () => { called = true; throw new Error('must not be called'); });
  const out = await ai.personalizeLead(LEAD, BASE);
  assert.equal(out, BASE, 'exact template, no AI call');
  assert.equal(called, false);
});

test('personalizeLead falls back to the template on HTTP 500', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(async () => ({ ok: false, status: 500 }));
  const out = await ai.personalizeLead(LEAD, BASE);
  assert.equal(out, BASE);
});

test('personalizeLead falls back to the template on network rejection', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(async () => { throw new Error('ECONNRESET'); });
  const out = await ai.personalizeLead(LEAD, BASE);
  assert.equal(out, BASE);
});

test('personalizeLead falls back on timeout (AbortSignal fires)', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const requests = [];
  // A well-behaved fetch impl: it honors the abort signal, then never
  // resolves on its own. AbortSignal.timeout should reject the call.
  ai.setFetchImpl(async (url, opts) => {
    requests.push(opts.signal);
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      // never resolves otherwise
    });
  });
  const out = await ai.personalizeLead(LEAD, BASE, { timeoutMs: 150, deadlineMs: 2000 });
  assert.equal(out, BASE, 'timeout → template fallback');
  assert.equal(requests.length, 1);
  assert.ok(requests[0] instanceof AbortSignal, 'AbortSignal.timeout passed to fetch');
  assert.equal(requests[0].aborted, true, 'signal aborted after the deadline');
});

test('personalizeLead falls back on timeout (signal-ignoring impl — hard deadline backstop)', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  // Hostile mock: ignores the abort signal AND never settles. Only the
  // belt-and-braces deadline timer can end this — proves no hang.
  ai.setFetchImpl(() => new Promise(() => {}));
  const out = await ai.personalizeLead(LEAD, BASE, { timeoutMs: 60000, deadlineMs: 300 });
  assert.equal(out, BASE, 'hard deadline → template fallback');
});

test('personalizeLead truncates model output longer than 300 chars', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const long = 'x'.repeat(500);
  ai.setFetchImpl(mockOkFetch(long));
  const out = await ai.personalizeLead(LEAD, BASE);
  assert.ok(out.length <= 300);
  assert.ok(out.endsWith('…'));
});

test('personalizeLead falls back on malformed JSON and on empty completion', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(async () => ({ ok: true, status: 200, async json() { throw new Error('bad json'); } }));
  assert.equal(await ai.personalizeLead(LEAD, BASE), BASE, 'bad JSON → fallback');
  ai.setFetchImpl(async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: '   ' } }] }; } }));
  assert.equal(await ai.personalizeLead(LEAD, BASE), BASE, 'blank completion → fallback');
  ai.setFetchImpl(async () => ({ ok: true, status: 200, async json() { return {}; } }));
  assert.equal(await ai.personalizeLead(LEAD, BASE), BASE, 'missing choices → fallback');
});

test('personalizeLead never throws even when the mock explodes', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(() => { throw new Error('sync boom'); });
  const out = await ai.personalizeLead(LEAD, BASE);
  assert.equal(out, BASE);
});

// ---------------------------------------------------------------------------
// generateReply
// ---------------------------------------------------------------------------
test('generateReply without a key classifies every intent and returns the canned shape', async () => {
  let called = false;
  ai.setFetchImpl(async () => { called = true; throw new Error('must not be called'); });
  const cases = [
    ['Sounds good, let\'s do it!', 'interested'],
    ['But we already have a website and a guy who handles it', 'objection'],
    ['How much would this cost?', 'price_question'],
    ['No thanks, not interested.', 'not_interested'],
    ['What time zone are you in?', 'other'],
  ];
  for (const [tail, expected] of cases) {
    const r = await ai.generateReply({ tail }, LEAD);
    assert.deepEqual(Object.keys(r).sort(), ['intent', 'reply'], `shape for "${tail}"`);
    assert.equal(r.intent, expected, `intent for "${tail}"`);
    assert.ok(typeof r.reply === 'string' && r.reply.length > 0);
    assert.ok(r.reply.length <= ai.MAX_REPLY_CHARS);
    assert.ok(r.reply.includes('San Antonio') || r.reply.includes('1-800-GOT-JUNK'), 'reply references the lead');
  }
  assert.equal(called, false, 'no network when key missing');
});

test('generateReply accepts an array conversation and uses the last message as tail', async () => {
  const r = await ai.generateReply(['Hi, we saw your note', 'Sure, tell me more'], LEAD);
  assert.equal(r.intent, 'interested');
});

test('generateReply model path: JSON parsed from the completion', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const requests = [];
  ai.setFetchImpl(mockOkFetch('{"intent": "price_question", "reply": "Happy to, John — tell me what the site needs to do and I will send a real ballpark for 1-800-GOT-JUNK? San Antonio this week."}', requests));
  const r = await ai.generateReply({ tail: 'How much?' }, LEAD);
  assert.equal(r.intent, 'price_question');
  assert.ok(r.reply.includes('San Antonio'));
  const body = JSON.parse(requests[0].opts.body);
  assert.ok(body.messages[1].content.includes('How much?'), 'conversation tail in prompt');
});

test('generateReply model path: fenced JSON is tolerated', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(mockOkFetch('```json\n{"intent": "interested", "reply": "Yes — let us talk this week."}\n```'));
  const r = await ai.generateReply({ tail: 'Yes!' }, LEAD);
  assert.equal(r.intent, 'interested');
  assert.equal(r.reply, 'Yes — let us talk this week.');
});

test('generateReply model path: malformed output falls back to canned', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(mockOkFetch('I think they are interested!'));
  const r = await ai.generateReply({ tail: 'sure, sounds good' }, LEAD);
  assert.equal(r.intent, 'interested', 'canned classifier still maps the tail');
  assert.ok(r.reply.length > 0);
});

test('generateReply falls back to canned on API error and unknown intent value', async () => {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  ai.setFetchImpl(async () => ({ ok: false, status: 429 }));
  const r = await ai.generateReply({ tail: 'how much?' }, LEAD);
  assert.equal(r.intent, 'price_question');
  ai.setFetchImpl(mockOkFetch('{"intent": "maybe", "reply": "hello"}'));
  const r2 = await ai.generateReply({ tail: 'hmm' }, LEAD);
  assert.equal(r2.intent, 'other', 'unknown intent normalizes to other');
});

// ---------------------------------------------------------------------------
// classifyIntent / cannedReply direct
// ---------------------------------------------------------------------------
test('classifyIntent covers the closed domain and never throws on garbage', () => {
  assert.equal(ai.classifyIntent(''), 'other');
  assert.equal(ai.classifyIntent(null), 'other');
  assert.equal(ai.classifyIntent(undefined), 'other');
  assert.equal(ai.classifyIntent('we are all set, thanks'), 'not_interested');
  assert.equal(ai.classifyIntent('yes we are interested'), 'interested');
  assert.equal(ai.classifyIntent('how much do you charge'), 'price_question');
  assert.equal(ai.classifyIntent('but we already have a website'), 'objection');
  assert.equal(ai.classifyIntent('do you serve Austin too?'), 'other');
});

test('cannedReply truncates long replies and handles a nameless lead', () => {
  const r = ai.cannedReply({}, 'no thanks');
  assert.equal(r.intent, 'not_interested');
  assert.ok(r.reply.includes('there'), 'falls back to a neutral greeting');
  const longTail = 'interested '.repeat(50);
  const r2 = ai.cannedReply(LEAD, longTail);
  assert.ok(r2.reply.length <= ai.MAX_REPLY_CHARS);
});
