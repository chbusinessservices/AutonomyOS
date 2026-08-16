// scripts/payment.js — Phase 5: payment-link helper (the "send the invoice"
// half of the revenue loop).
//
// sendPaymentLink(lead, productKey, opts) builds a Stripe Payment Link URL
// from env config — NO Stripe API calls, NO secret keys. Stripe payment links
// are static buy URLs, so "sending" one is just choosing the right URL and
// remembering that we did:
//
//   1. Resolve the product's env var: STRIPE_PAYMENT_LINK_<PRODUCT> from a
//      small product map (or the uppercased product key), falling back to
//      STRIPE_PAYMENT_LINK_DEFAULT.
//   2. Append ?client_reference_id=<lead.id> — Stripe forwards that query
//      parameter to the checkout session, so the webhook
//      (stripe-webhook.js) can resolve which lead paid without the Stripe
//      API. (API-created checkout sessions can use metadata.lead_id instead;
//      the webhook accepts both.)
//   3. Record a `payment_link_sent` lead_events row (payload: product,
//      stripe_url, sent_at) — idempotent per lead+product per UTC day, so a
//      re-run of a send loop cannot double-log the same link.
//
// Returns { url, product, logged, eventId } — or null when no URL is
// configured (graceful: the caller can log a warning and move on; house rule
// is never throw to the caller for a recoverable situation). With no `query`
// fn passed it still returns the built URL with logged:false (pure link
// builder mode).
//
// Env:
//   STRIPE_PAYMENT_LINK_PREMIUM_SITE / _STARTER_SITE / _AI_RECEPTIONIST ...
//   STRIPE_PAYMENT_LINK_DEFAULT   fallback when the product has no env var
//   DATABASE_URL                  CLI mode only (resolves the lead by id)
//
// CLI (convenience for the closer agent):
//   node scripts/payment.js --lead 181 --product premium_site
'use strict';

const core = require('./stripe-core');

// Small product map: productKey → env var holding the buy URL. Anything not
// listed falls back to STRIPE_PAYMENT_LINK_<UPPER_SNAKE(productKey)>, then
// STRIPE_PAYMENT_LINK_DEFAULT.
const PRODUCT_ENV = {
  premium_site: 'STRIPE_PAYMENT_LINK_PREMIUM_SITE',
  starter_site: 'STRIPE_PAYMENT_LINK_STARTER_SITE',
  ai_receptionist: 'STRIPE_PAYMENT_LINK_AI_RECEPTIONIST',
};
const DEFAULT_PRODUCT = 'premium_site';

function productEnvKey(productKey) {
  const key = String(productKey || DEFAULT_PRODUCT).trim().toLowerCase();
  if (PRODUCT_ENV[key]) return PRODUCT_ENV[key];
  return `STRIPE_PAYMENT_LINK_${key.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
}

// Append the lead reference to a payment-link URL. Stripe forwards
// client_reference_id query params onto the created checkout session.
function buildLinkUrl(baseUrl, leadId) {
  const sep = String(baseUrl).includes('?') ? '&' : '?';
  return `${baseUrl}${sep}client_reference_id=${encodeURIComponent(String(leadId))}`;
}

// Resolve the configured URL for a product: env var for the product, else the
// default env var, else null. Never throws.
function resolveLinkUrl(productKey) {
  const envKey = productEnvKey(productKey);
  const url = process.env[envKey] || process.env.STRIPE_PAYMENT_LINK_DEFAULT || null;
  return { envKey, url };
}

// sendPaymentLink(lead, productKey, opts)
//   opts.query     single-connection query fn (for the idempotent event log).
//                  Omit for pure link building.
//   opts.verbose   [stripe] logging
// Returns { url, product, logged, eventId } | null (no URL configured / no
// lead id). logged:false on a same-day repeat (existing eventId returned).
async function sendPaymentLink(lead, productKey, opts) {
  const verbose = !!(opts && opts.verbose);
  const query = opts && opts.query;
  const product = String(productKey || DEFAULT_PRODUCT).trim().toLowerCase() || DEFAULT_PRODUCT;

  if (!lead || lead.id == null) {
    core.stripeLog(verbose, `sendPaymentLink: no lead id — cannot build a tracked link`);
    return null;
  }
  const { envKey, url } = resolveLinkUrl(product);
  if (!url) {
    core.stripeLog(
      verbose,
      `sendPaymentLink: no URL configured for product "${product}" (${envKey}) and no STRIPE_PAYMENT_LINK_DEFAULT — link not sent`
    );
    return null;
  }
  const finalUrl = buildLinkUrl(url, lead.id);
  if (!query) {
    core.stripeLog(verbose, `sendPaymentLink: built ${finalUrl} (no query fn — event not logged)`);
    return { url: finalUrl, product, logged: false, eventId: null };
  }

  // Idempotency: one payment_link_sent per lead+product per UTC day. A second
  // call the same day returns the existing event, no new row.
  const existing = await core.paymentLinkSentToday(query, lead.id, product);
  if (existing != null) {
    core.stripeLog(verbose, `sendPaymentLink: already logged today for lead ${lead.id} (event #${existing}) — link still returned`);
    return { url: finalUrl, product, logged: false, eventId: existing };
  }
  const payload = { product, stripe_url: finalUrl, sent_at: new Date().toISOString() };
  const ev = await query(
    `INSERT INTO lead_events (lead_id, event_type, payload)
     VALUES ($1, 'payment_link_sent', $2) RETURNING id`,
    [lead.id, payload]
  );
  core.stripeLog(verbose, `sendPaymentLink: logged payment_link_sent #${ev.rows[0].id} for lead ${lead.id} (${finalUrl})`);
  return { url: finalUrl, product, logged: true, eventId: ev.rows[0].id };
}

// ---------------------------------------------------------------------------
// CLI: node scripts/payment.js --lead <id> [--product <key>] [--verbose]
// Resolves the lead from Neon, prints the tracked payment-link URL.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { product: DEFAULT_PRODUCT, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--lead' && argv[i + 1]) out.lead = argv[i + 1];
    else if (argv[i] === '--product' && argv[i + 1]) out.product = argv[i + 1];
    else if (argv[i] === '--verbose') out.verbose = true;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

async function main() {
  core.loadEnvFile(`${__dirname}/.env`);
  const { Pool } = require('pg');
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/payment.js --lead <id> [--product <key>] [--verbose]');
    return;
  }
  if (!args.lead || !/^\d+$/.test(String(args.lead))) {
    console.error('Usage: node scripts/payment.js --lead <numeric lead id> [--product <key>] [--verbose]');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set (see scripts/.env.example).');
    process.exit(1);
  }
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.delete('channel_binding');
  u.searchParams.delete('sslmode');
  const pool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 2 });
  try {
    const lead = (await pool.query('SELECT id, business_name FROM leads WHERE id = $1::bigint', [args.lead])).rows[0];
    if (!lead) {
      console.error(`No lead with id ${args.lead}.`);
      process.exitCode = 1;
      return;
    }
    const q = pool.query.bind(pool);
    const result = await sendPaymentLink(lead, args.product, { query: q, verbose: args.verbose });
    if (!result) {
      console.error(`No payment link configured for product "${args.product}" — set STRIPE_PAYMENT_LINK_${productEnvKey(args.product)} or STRIPE_PAYMENT_LINK_DEFAULT.`);
      process.exitCode = 1;
      return;
    }
    console.log(result.url);
    console.log(args.verbose ? JSON.stringify(result, null, 2) : `(logged=${result.logged}, event#${result.eventId || '—'})`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = {
  PRODUCT_ENV,
  DEFAULT_PRODUCT,
  productEnvKey,
  buildLinkUrl,
  resolveLinkUrl,
  sendPaymentLink,
};
