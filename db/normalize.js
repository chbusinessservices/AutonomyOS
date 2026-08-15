// db/normalize.js — shared field-normalization rules for the CH lead pipeline.
//
// THE single source of truth for parsing rules. Imported by:
//   • db/seed.js              — Hunter's markdown sweep batches → lead rows
//   • scripts/extract-leads.js — Google Maps sweeps (weekly GitHub Actions cron)
//
// If a parsing rule changes (phone formats, city cleanup, website_status
// mapping), change it HERE so both writers stay in lockstep.

'use strict';

// "(512) 615-8256" → "+15126158256" (US/CA). NULL when no digits or an
// unexpected format (flag via warnings instead of corrupting).
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null; // unexpected format
}

// Keep the audited URL as-is; "none" / "n/a" → NULL. Trailing audit notes in
// parentheses ("(Wix)", "(down — fetch returns empty)") ride along after the
// URL — strip the trailing parenthetical so only the URL is stored.
function normalizeWebsite(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || /^(none|n\/a|no website)$/i.test(s)) return null;
  s = s.replace(/\s*\(.*?\)\s*$/, '').trim(); // trailing audit note
  return s || null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s || /^n\/?a$/i.test(s)) return null;
  s = s.replace(/\s*\(.*?\)\s*$/, '').trim(); // trailing audit note
  return s || null;
}

// "Raleigh, NC (Cary)" → "Raleigh, NC". Keeps "City, ST" shape.
function normalizeCity(raw) {
  if (!raw) return null;
  return raw.replace(/\s*\(.*?\)\s*/g, '').trim();
}

// Map free-text audit verdicts / listing observations to the closed domain:
//   "no website" / "facebook only" / social-only      → 'none'
//   anything else with a URL (template, down, outdated,
//     placeholder, no form, …)                        → 'weak'
//   a verified converting site (audit passed)         → 'good'
// 'good' is reserved — target lists are for missing/weak sites; callers
// (extract-leads.js) skip 'good' rows by default so the pipeline stays clean.
function classifyWebsiteStatus(statusText, websiteUrl) {
  const t = (statusText || '').trim().toLowerCase();
  if (t === 'good') return 'good';
  if (/no website|facebook only|social[- ]only/.test(t)) return 'none';
  if (websiteUrl) return 'weak';
  return 'none';
}

module.exports = {
  normalizePhone,
  normalizeWebsite,
  normalizeEmail,
  normalizeCity,
  classifyWebsiteStatus,
};
