# Pipeline database (Phase 1)

PostgreSQL schema + seed for the CH Business Services lead pipeline on
**Neon** (`project blue-cake-70898140`). This is the database the machine
(GitHub Actions cron, n8n, outreach agents, Stripe webhooks) will read and
write — see the schema comments in `schema.sql` for the machine-facing
contract (status transitions, event types, normalization rules).

## Files

| File | Purpose |
| --- | --- |
| `schema.sql` | Idempotent DDL: `leads` + `lead_events` tables, indexes, `updated_at` trigger |
| `seed.js` | Parses `../data/leads-batch1.md` + `../data/leads-batch2.md` and upserts into `leads` |
| `package.json` | `pg` dependency; `npm run seed` |
| `.env.example` | `DATABASE_URL` placeholder — copy to `.env`, never commit the real value |

## Requirements

- Node.js ≥ 18 (tested on 22)
- A Neon connection string in `DATABASE_URL`. On the work machine it lives at
  `/home/team/shared/.neon-db-url` — never commit it, never paste it into a
  PR or issue.

```sh
npm install            # in db/ — installs pg
export DATABASE_URL=$(cat /home/team/shared/.neon-db-url)   # work machine
npm run seed           # applies schema if missing, then upserts all rows
```

That's it — `seed.js` applies `schema.sql` automatically on first run
(no `psql` needed). To apply the schema standalone, run the same command
or `node -e "require('pg')"`-free equivalent; the seed is the supported path.

## What the seed does

1. Parses the summary table **and** detailed entries of each batch markdown
   file and merges them by row number (status text from the summary, URLs and
   emails from the detailed entries).
2. Normalizes every field:
   - `phone` → E.164 (`(512) 615-8256` → `+15126158256`) so SMS/`tel:` work
   - `email` → lowercase; `n/a` → `NULL`
   - `website` → trimmed URL or `NULL` ("none" / social-only still keeps the
     FB/IG URL in `website` for reference)
   - `city` → `"City, ST"` (suburb parentheticals stripped:
     `Raleigh, NC (Cary)` → `Raleigh, NC`)
   - `website_status` → `'none'` | `'weak'` (`'good'` reserved — these target
     lists never contain converting sites)
3. Upserts with `ON CONFLICT (business_name, city) DO UPDATE` — inserts new
   businesses, refreshes contact data only when it actually changed, and
   **never touches `status`** (pipeline state survives re-seeds). Re-running
   is always safe.

## Verification queries

```sql
SELECT count(*) FROM leads;                                   -- expect 60
SELECT source_batch, count(*) FROM leads GROUP BY source_batch ORDER BY 1;
SELECT website_status, count(*) FROM leads GROUP BY website_status ORDER BY 1;
SELECT city, count(*) FROM leads GROUP BY city ORDER BY 2 DESC;
SELECT count(*) FROM leads WHERE email IS NOT NULL;           -- published emails
```

## Machine write conventions (Phase 2+)

- New lead (GitHub Actions cron / n8n `lead-created`): insert `leads` +
  `lead_events(lead_id, 'lead_created', '{"source":"github-actions"}')` in
  one transaction.
- State transition: `UPDATE leads SET status = $1 WHERE id = $2` then append
  `lead_events(..., 'status_changed', '{"from":…,"to":…}')`.
- Stripe webhook `payment-received`: set `status='closed_won'` and log
  `payment_received` with `{stripe_session_id, amount, currency}`.
- Dashboard alignment: `site/src/lead-data.ts` fields (`name`, `city`,
  `niche`, `phone`) map to `leads.business_name`, `city`, `niche`, `phone`.
  `phone` is now E.164, which also fixes the dashboard's current
  `tel:+(512)…` broken links once it reads from the DB.
