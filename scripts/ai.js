// scripts/ai.js — Phase 4: the machine's brain.
//
// Direct DeepSeek chat/completions calls for (a) personalizing the LinkedIn
// pitch and (b) negotiating inbound replies, both behind the same hard rules:
//
//   • env-key-driven — the key lives in DEEPSEEK_API_KEY only, never in code
//   • fully fallback-safe — no key, API error, timeout, or malformed response
//     ALWAYS degrades to the rendered template / a canned reply; these
//     functions never throw
//   • hard deadline — ~10s AbortSignal.timeout + a belt-and-braces timer (a
//     fetch impl that ignores the signal still cannot hang the machine) —
//     same pattern as the extract-leads.js homepage audit
//   • verbose logging — every decision logged with a [ai] prefix (gated on
//     the `verbose` option, house style)
//   • injection seam — setFetchImpl() lets tests swap the network call for a
//     mock; the production default is global fetch (Node ≥ 18)
//
// Real API shape (owner's key, added later as a business secret):
//   POST https://api.deepseek.com/chat/completions
//   Authorization: Bearer $DEEPSEEK_API_KEY
//   body: { model: "deepseek-chat", messages: [...], max_tokens: 150, temperature: 0.7 }
//   → choices[0].message.content
'use strict';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const HARD_TIMEOUT_MS = 10000; // ~10s hard deadline (house style)
const DEADLINE_BUFFER_MS = 1500; // for impls that ignore the abort signal
const MAX_PITCH_CHARS = 300; // LinkedIn connection-note limit
const MAX_REPLY_CHARS = 400; // inbound replies stay short; DMs allow 2000
const INTENTS = ['interested', 'objection', 'price_question', 'not_interested', 'other'];

// ---------------------------------------------------------------------------
// Injection seam — tests replace fetchImpl with a mock; never hits the network.
// ---------------------------------------------------------------------------
const DEFAULT_FETCH = (...args) => fetch(...args);
let fetchImpl = DEFAULT_FETCH;
function setFetchImpl(fn) {
  fetchImpl = typeof fn === 'function' ? fn : DEFAULT_FETCH;
}
function getFetchImpl() {
  return fetchImpl;
}

// ---------------------------------------------------------------------------
// Logging + small utils
// ---------------------------------------------------------------------------
function aiLog(verbose, msg) {
  if (verbose) console.log(`  [ai] ${msg}`);
}

// Defensive truncation: hard cap with an ellipsis, never splits a word badly
// enough to matter — mirrors renderTemplate()'s cap in linkedin-core.js.
function truncate(text, maxChars) {
  let out = String(text ?? '').trim();
  if (maxChars && out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

function leadName(lead) {
  return String((lead && lead.business_name) || '').trim();
}

// Lead facts for the prompt. website_status maps to the same friendly phrase
// the templates use, so the model sees exactly what the human would read.
function leadFacts(lead) {
  return {
    business_name: leadName(lead) || '(unknown)',
    city: String((lead && lead.city) || '').trim() || '(unknown)',
    niche: String((lead && lead.niche) || '').trim() || '(unknown)',
    website_status: String((lead && lead.website_status) || '').trim() || 'unknown',
  };
}

// ---------------------------------------------------------------------------
// The DeepSeek call. Returns trimmed completion text, or null on ANY failure
// (no key / HTTP error / network error / timeout / bad JSON / empty content).
// Never throws.
// ---------------------------------------------------------------------------
async function callDeepSeek(messages, opts) {
  const verbose = !!(opts && opts.verbose);
  const timeoutMs = (opts && opts.timeoutMs) || HARD_TIMEOUT_MS;
  const deadlineMs = (opts && opts.deadlineMs) || (timeoutMs + DEADLINE_BUFFER_MS);
  if (!process.env.DEEPSEEK_API_KEY) {
    aiLog(verbose, 'no DEEPSEEK_API_KEY set — skipping API call');
    return null;
  }
  aiLog(verbose, `POST ${DEEPSEEK_URL} (model ${DEEPSEEK_MODEL}, timeout ${timeoutMs}ms)`);
  let res;
  try {
    res = await withHardDeadline(
      fetchImpl(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages,
          max_tokens: 150,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      deadlineMs,
      verbose
    );
  } catch (err) {
    aiLog(verbose, `API call failed (${err.message}) — falling back`);
    return null;
  }
  if (!res) {
    aiLog(verbose, 'no response (hard deadline) — falling back');
    return null;
  }
  if (!res.ok) {
    aiLog(verbose, `API error HTTP ${res.status} — falling back`);
    return null;
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    aiLog(verbose, `malformed JSON response (${err.message}) — falling back`);
    return null;
  }
  const content =
    json && json.choices && json.choices[0] &&
    json.choices[0].message && json.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    aiLog(verbose, 'empty completion — falling back');
    return null;
  }
  return content.trim();
}

// Belt-and-braces deadline: resolves null if the wrapped promise does not
// settle in time. AbortSignal.timeout is the primary mechanism; this timer
// catches fetch impls (e.g. mocks) that ignore the signal entirely.
function withHardDeadline(promise, ms, verbose) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => {
      aiLog(verbose, `hard deadline (${ms}ms) hit — falling back`);
      finish(null);
    }, ms);
    Promise.resolve(promise).then(
      (v) => finish(v),
      (err) => {
        aiLog(verbose, `request rejected (${err && err.message ? err.message : err}) — falling back`);
        finish(null);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// System prompts (business positioning, honest + outcome-focused, no hype)
// ---------------------------------------------------------------------------
const SYSTEM_PERSONALIZE = [
  'You are the outreach writer for CH Business Services, a web agency that builds',
  'conversion-optimized websites for local service businesses whose current online',
  'presence is missing or weak. Your goal is outcomes: more calls, more jobs, more',
  'bookings for the lead — never hype, never fake urgency, never fake scarcity.',
  'Write one short, honest, low-pressure LinkedIn connection note. Rules:',
  '1) Keep it under 300 characters.',
  '2) Use the lead\'s real business name, city, and what they do.',
  '3) Reference their website situation truthfully from the lead data.',
  '4) End with one simple question. No exclamation-mark piles, no salesy adjectives,',
  'no empty claims.',
].join(' ');

const SYSTEM_NEGOTIATE = [
  'You are the negotiator for CH Business Services, a web agency that builds',
  'conversion-optimized websites for local service businesses. A lead replied to',
  'our outreach. Classify their intent into EXACTLY one of:',
  'interested | objection | price_question | not_interested | other.',
  'Then draft a short, honest reply (max 400 characters) that references the',
  'lead\'s business by name and directly answers or acknowledges what they said.',
  'No hype, no fake urgency, no pressure tactics, no invented scarcity.',
  'Respond ONLY with JSON on one line:',
  '{"intent": "<one of the five>", "reply": "<your reply text>"}',
].join(' ');

function personalizePrompt(lead, baseMessage) {
  const f = leadFacts(lead);
  return [
    'Lead data:',
    `- business_name: ${f.business_name}`,
    `- city: ${f.city}`,
    `- niche: ${f.niche}`,
    `- website_status: ${f.website_status}`,
    '  (none = no website at all, weak = site exists but is not converting visitors',
    '  into calls, good = working site)',
    '',
    'Draft base message:',
    '"""',
    baseMessage,
    '"""',
    '',
    'Rewrite the base message into a personalized LinkedIn note for THIS lead.',
    'Output only the final note text — no preamble, no quotes, no JSON.',
  ].join('\n');
}

function negotiatePrompt(lead, conversationTail) {
  const f = leadFacts(lead);
  return [
    'Lead data:',
    `- business_name: ${f.business_name}`,
    `- city: ${f.city}`,
    `- niche: ${f.niche}`,
    `- website_status: ${f.website_status}`,
    '',
    'The lead\'s latest reply (conversation tail):',
    '"""',
    conversationTail,
    '"""',
    '',
    'Classify the intent and draft your reply per the system rules. JSON only.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API 1: personalizeLead(lead, baseMessage, opts)
//   → personalized pitch ≤ 300 chars, or the rendered base message on ANY
//     failure (no key / API error / timeout / malformed). Never throws.
// ---------------------------------------------------------------------------
async function personalizeLead(lead, baseMessage, opts) {
  const verbose = !!(opts && opts.verbose);
  const fallback = truncate(baseMessage, MAX_PITCH_CHARS);
  if (!process.env.DEEPSEEK_API_KEY) {
    aiLog(verbose, 'personalizeLead: no DEEPSEEK_API_KEY → template fallback');
    return fallback;
  }
  const content = await callDeepSeek(
    [
      { role: 'system', content: SYSTEM_PERSONALIZE },
      { role: 'user', content: personalizePrompt(lead, baseMessage) },
    ],
    opts
  );
  if (content == null) {
    aiLog(verbose, 'personalizeLead: API unavailable → template fallback');
    return fallback;
  }
  // Defensive cleanup: strip a single layer of wrapping quotes the model
  // sometimes adds despite the instruction.
  let pitch = content;
  if (
    pitch.length >= 2 &&
    ((pitch[0] === '"' && pitch[pitch.length - 1] === '"') ||
      (pitch[0] === "'" && pitch[pitch.length - 1] === "'"))
  ) {
    pitch = pitch.slice(1, -1).trim();
  }
  pitch = truncate(pitch, MAX_PITCH_CHARS);
  aiLog(verbose, `personalizeLead: AI pitch ready (${pitch.length} chars)`);
  return pitch;
}

// ---------------------------------------------------------------------------
// Public API 2: generateReply(conversation, lead, opts)
//   → { intent, reply }. Intent is one of INTENTS. With a key the model
//   classifies + drafts; without (or on any failure) a canned reply is chosen
//   by a keyword classifier. Never throws.
//   conversation: { tail } or an array of messages (last item = latest reply).
// ---------------------------------------------------------------------------
function conversationTail(conversation) {
  if (!conversation) return '';
  if (Array.isArray(conversation)) return String(conversation[conversation.length - 1] ?? '').trim();
  if (typeof conversation === 'object') {
    const t = conversation.tail || conversation.latest || conversation.lastMessage || '';
    return String(t).trim();
  }
  return String(conversation).trim();
}

// Keyword classifier — the no-key / fallback path. Simple and honest; the
// model does the nuanced version when the key is present.
function classifyIntent(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  if (/\b(not interested|no thanks|no thank you|don'?t need|don'?t want|stop|unsubscribe|not for us|not for me|(we'?re|we are) (all )?set|pass (on )?this|no,? thanks|never mind)\b/.test(t)) return 'not_interested';
  if (/\b(how much|price|pricing|cost|quote|budget|expensive|afford|cheap|what do you charge|investment)\b/.test(t)) return 'price_question';
  if (/\b(interested|yes|sure|let'?s (do|talk|chat)|sounds (good|great)|tell me more|more info|book|schedule|go ahead|when (can|should) we)\b/.test(t)) return 'interested';
  if (/\b(but|however|already have|we have a (site|website|guy|team)|worried|skeptical|not sure|concerned|too (busy|expensive|risky)|no time|we got (scammed|burned)|tried (that|before))\b/.test(t)) return 'objection';
  return 'other';
}

// Canned replies — honest, low-pressure, reference the lead by name. No prices
// are invented (owner sets pricing later); price questions get a scope-based
// answer instead.
function cannedReply(lead, tail) {
  const intent = classifyIntent(tail);
  const name = leadName(lead);
  const first = name.split(/\s+/)[0] || 'there';
  let reply;
  switch (intent) {
    case 'interested':
      reply = `Great to hear, ${first}! I'll send over a couple of quick ideas for ${name} and we can take it from there — no pressure at all.`;
      break;
    case 'price_question':
      reply = `Happy to share that, ${first}. Pricing depends on scope, so I'd rather give ${name} a real ballpark — tell me what you'd need the site to do and I'll send numbers this week. Fair?`;
      break;
    case 'not_interested':
      reply = `Understood, ${first} — thanks for letting me know. If ${name} ever needs a website that books jobs on its own, my door is open. All the best!`;
      break;
    case 'objection':
      reply = `Totally fair, ${first}. A quick call with no obligation usually clears things up — and if it's not a fit, no hard feelings. Open to 10 minutes this week?`;
      break;
    default:
      reply = `Thanks for the reply, ${first}. Happy to answer any questions about what a conversion-focused site for ${name} could look like — just tell me what would help.`;
  }
  return { intent, reply: truncate(reply, MAX_REPLY_CHARS) };
}

function parseNegotiateJson(content) {
  // Tolerate ```json fences and surrounding whitespace.
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object') return null;
    const intent = INTENTS.includes(o.intent) ? o.intent : 'other';
    if (typeof o.reply !== 'string' || !o.reply.trim()) return null;
    return { intent, reply: truncate(o.reply, MAX_REPLY_CHARS) };
  } catch {
    return null;
  }
}

async function generateReply(conversation, lead, opts) {
  const verbose = !!(opts && opts.verbose);
  const tail = conversationTail(conversation);
  const canned = cannedReply(lead, tail);
  if (!process.env.DEEPSEEK_API_KEY) {
    aiLog(verbose, `generateReply: no DEEPSEEK_API_KEY → canned reply (intent: ${canned.intent})`);
    return canned;
  }
  const content = await callDeepSeek(
    [
      { role: 'system', content: SYSTEM_NEGOTIATE },
      { role: 'user', content: negotiatePrompt(lead, tail) },
    ],
    opts
  );
  if (content == null) {
    aiLog(verbose, `generateReply: API unavailable → canned reply (intent: ${canned.intent})`);
    return canned;
  }
  const parsed = parseNegotiateJson(content);
  if (!parsed) {
    aiLog(verbose, `generateReply: malformed model output → canned reply (intent: ${canned.intent})`);
    return canned;
  }
  aiLog(verbose, `generateReply: model reply ready (intent: ${parsed.intent})`);
  return parsed;
}

module.exports = {
  personalizeLead,
  generateReply,
  classifyIntent,
  cannedReply,
  conversationTail,
  setFetchImpl,
  getFetchImpl,
  callDeepSeek,
  truncate,
  DEEPSEEK_URL,
  DEEPSEEK_MODEL,
  HARD_TIMEOUT_MS,
  MAX_PITCH_CHARS,
  MAX_REPLY_CHARS,
  INTENTS,
};
