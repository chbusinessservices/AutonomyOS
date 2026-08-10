#!/usr/bin/env node
/**
 * db/seed.js — CH Business Services lead pipeline seeder (Phase 1)
 *
 * Parses Hunter's sweep batch markdown files (data/leads-batch*.md) into
 * normalized lead rows and upserts them into the Neon `leads` table,
 * keyed by (business_name, city) so re-running is always safe:
 *   - new businesses are inserted,
 *   - existing rows are updated ONLY when a field actually changed
 *     (status is never touched — pipeline state survives re-seeds),
 *   - identical re-runs change nothing.
 *
 * Usage:
 *   DATABASE_URL=<neon connection string> node db/seed.js
 *
 * The schema is applied automatically the first time (tables missing).
 * See db/README.md. Never hardcode DATABASE_URL — read it from the env.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const BATCH_FILES = [
  { file: 'leads-batch1.md', batch: 'batch1' },
  { file: 'leads-batch2.md', batch: 'batch2' },
];

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

// Summary table row: | # | Business | City/State | Niche | Phone | Website status |
function parseSummaryTable(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator row
    const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    const num = Number(cells[0]);
    if (!Number.isInteger(num) || num < 1) continue; // header row
    rows.push({
      num,
      businessName: cells[1],
      cityRaw: cells[2],
      niche: cells[3] || null,
      phoneRaw: cells[4] || null,
      statusText: cells[5] || '',
    });
  }
  return rows;
}

// Detailed entries: "**1. Business** — Niche — City, ST" headers followed by
// "- Phone: … · Email: … · Website: …" / "- Website: URL (note)" lines.
function parseDetailedEntries(md) {
  const region = md.split('## Detailed Entries')[1] || '';
  const headerRe = /^\*\*(\d+)\.\s+(.+?)\*\*\s*—\s*(.+?)\s*—\s*(.+?)\s*$/gm;
  const headers = [];
  let m;
  while ((m = headerRe.exec(region))) {
    headers.push({
      num: Number(m[1]),
      start: m.index,
      end: headerRe.lastIndex,
      detailName: m[2].trim(),
      detailNiche: m[3].trim() || null,
      detailCity: m[4].trim() || null,
    });
  }

  return headers.map((h, i) => {
    const block = region.slice(h.end, i + 1 < headers.length ? headers[i + 1].start : undefined);
    let phone = null;
    let email = null;
    let website = null;
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('- ')) continue;
      const body = t.slice(2).trim();
      const pm = /^Phone:\s*(.+)$/i.exec(body);
      if (pm) {
        // rest may bundle "Email:" and "Website:" after the phone, split by '·'
        for (const part of pm[1].split('·').map((p) => p.trim())) {
          if (/^Email:/i.test(part)) email = part.replace(/^Email:\s*/i, '').trim();
          else if (/^Website:/i.test(part)) website = part.replace(/^Website:\s*/i, '').trim();
          else if (!phone) phone = part;
        }
        continue;
      }
      const em = /^Email:\s*(.+)$/i.exec(body);
      if (em) { email = em[1].trim(); continue; }
      const wm = /^Website:\s*(.+)$/i.exec(body);
      if (wm) { website = wm[1].trim(); continue; }
    }
    return { ...h, phone, email, website };
  });
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// "(512) 615-8256" → "+15126158256" (US/CA). NULL when no digits.
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null; // unexpected format — flag via warnings instead of corrupting
}

// Keep the audited URL as-is; "none" / "n/a" → NULL. Hunter's notes like
// "(Wix)" or "(down — fetch returns empty)" ride along after the URL — strip
// the trailing parenthetical so only the URL is stored.
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

// Map the summary's free-text status column to the closed domain:
//   "No website" / "Facebook only" / social-only → 'none'
//   everything else (template, down, outdated, no form, …) → 'weak'
//   'good' is reserved — a converting site is never in these target lists.
function classifyWebsiteStatus(statusText, websiteUrl) {
  const t = (statusText || '').toLowerCase();
  if (/no website|facebook only|social[- ]only/.test(t)) return 'none';
  if (websiteUrl) return 'weak';
  return 'none';
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function parseBatchFile(file, batch, warnings) {
  const md = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  const summary = parseSummaryTable(md);
  const details = parseDetailedEntries(md);

  if (summary.length !== details.length) {
    warnings.push(
      `[${batch}] summary rows (${summary.length}) != detailed entries (${details.length}) — check file`,
    );
  }

  return summary.map((s) => {
    const d = details.find((x) => x.num === s.num) || {};
    if (!d.num) {
      warnings.push(`[${batch}] no detailed entry found for #${s.num} (${s.businessName})`);
    }
    if (!s.cityRaw) warnings.push(`[${batch}] #${s.num} missing city`);

    const website = normalizeWebsite(d.website);
    const row = {
      // Summary table name wins (cleaner — e.g. summary "Bizzy Bee Plumbing,
      // Inc." vs detail "Bizzy Bee Plumbing, Inc. (Cary)"); detail as fallback.
      business_name: (s.businessName || d.detailName).trim(),
      city: normalizeCity(s.cityRaw),
      niche: (d.detailNiche || s.niche) || null,
      phone: normalizePhone(d.phone || s.phoneRaw),
      email: normalizeEmail(d.email),
      website,
      website_status: classifyWebsiteStatus(s.statusText, website),
      source_batch: batch,
    };
    if (!row.phone) warnings.push(`[${batch}] #${s.num} ${row.business_name}: phone unparseable (raw: ${s.phoneRaw})`);
    if (row.website && !/^https?:\/\//i.test(row.website)) {
      warnings.push(`[${batch}] #${s.num} ${row.business_name}: website not a URL (${row.website})`);
    }
    return row;
  });
}

async function ensureSchema(pool) {
  const { rows } = await pool.query("SELECT to_regclass('public.leads') AS t");
  if (rows[0] && rows[0].t) return false;
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  return true;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('FATAL: DATABASE_URL is not set. Export it (see db/.env.example).');
    process.exit(1);
  }

  // pg handles postgres:// URLs, but drop libpq-only params it doesn't know.
  const u = new URL(dbUrl);
  u.searchParams.delete('channel_binding');
  u.searchParams.delete('sslmode');
  const pool = new Pool({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false }, // Neon requires SSL
    max: 2,
  });

  try {
    const applied = await ensureSchema(pool);
    console.log(applied ? 'Schema applied (leads table did not exist).' : 'Schema already present — skipping apply.');

    const warnings = [];
    const allRows = [];
    for (const b of BATCH_FILES) {
      const rows = parseBatchFile(b.file, b.batch, warnings);
      allRows.push(...rows);
      console.log(`Parsed ${b.file}: ${rows.length} leads (${b.batch})`);
    }
    console.log(`Total parsed: ${allRows.length}`);

    const upsertSql = `
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

    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    try {
      await client.query('BEGIN');
      for (const row of allRows) {
        const res = await client.query(upsertSql, [
          row.business_name, row.phone, row.email, row.website,
          row.website_status, row.city, row.niche, row.source_batch,
        ]);
        const r = res.rows[0];
        if (!r) { unchanged += 1; continue; } // conflict existed, data identical → skipped by WHERE
        if (r.inserted) inserted += 1;
        else updated += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(`Upsert result → inserted: ${inserted}, updated: ${updated}, unchanged: ${unchanged}`);

    if (warnings.length) {
      console.log(`\n⚠  ${warnings.length} parser warning(s):`);
      for (const w of warnings) console.log(`  - ${w}`);
    } else {
      console.log('\nNo parser warnings — every row parsed cleanly.');
    }
  } finally {
    await pool.end();
  }
}

module.exports = { parseBatchFile, parseSummaryTable, parseDetailedEntries,
  normalizePhone, normalizeWebsite, normalizeEmail, normalizeCity,
  classifyWebsiteStatus };

if (require.main === module) {
  main().catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
}
