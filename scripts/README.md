# Lead extraction engine (Phase 2)

Headless Google Maps sweeps that find local service businesses with **missing
or weak websites** and upsert them into the Neon `leads` table — the machine's
continuous lead-gen. No human in the loop.

```
scripts/
├── extract-leads.js   Playwright sweep + upsert + lead_created events
├── config.json        Weekly scope (cities × niches) + defaults
├── package.json       Deps: playwright, pg (that's it)
└── README.md          This file
```

Parsing rules (phone → E.164, city cleanup, `website_status` mapping) are NOT
duplicated here — they live in [`../db/normalize.js`](../db/normalize.js),
the same module `db/seed.js` uses. Change a rule once, both writers follow.

## How it works

For each `(city, niche)` combo from config:

1. Opens `google.com/maps/search/<niche> in <city>` in headless Chromium,
   dismisses the consent banner if shown.
2. Scrolls the Maps results feed (the real scroll container, not the window —
   Maps lazy-loads) collecting cards: name, phone (regex on card text), and
   the card's outbound links.
3. Classifies each business:
   - **no link** → `website_status: none` (best leads)
   - **social-only link** (Facebook/Instagram/…) → `none`, but the profile URL
     is kept in `website` (schema convention: FB-only leads keep their FB URL)
   - **real website** → lightweight homepage audit (mobile UA fetch): template
     hosts (Wix/Hibu/Weebly/GoDaddy…), cheap TLDs (`.biz/.site/.best`),
     fetch failures, and tiny (<300 byte) placeholder pages → `weak`;
     anything that audits clean → `good` (skipped by default — not a target)
4. Upserts `ON CONFLICT (business_name, city) DO UPDATE` — re-sweeping a
   market never duplicates, identical rows are no-ops, `status` is never
   touched. Every genuinely **new** lead gets a `lead_events.lead_created`
   row (payload `{source, batch, method}`) in the same transaction.
5. Prints a per-city summary (extracted / new / updated / unchanged).

Partial results survive: if one combo trips Google's anti-bot wall, earlier
combos keep their inserts and the job reports the failure. The job exits
non-zero only if **nothing** was extracted anywhere.

## Run locally

```sh
cd scripts
npm install
npx playwright install chromium          # once; ~170MB into ~/.cache/ms-playwright
export DATABASE_URL="$(cat /home/team/shared/.neon-db-url)"   # never commit this
```

Smoke test first — dry run, one city, one niche, tiny limit (no DB writes):

```sh
node extract-leads.js --cities "San Antonio, TX" --niches "Junk Removal" --limit 3 --dry-run
```

Then a real (tiny) write:

```sh
node extract-leads.js --cities "San Antonio, TX" --niches "Junk Removal" --limit 3 --batch sweep-smoke
```

Re-run the same command to prove dedupe: expect `inserted 0, updated 0,
unchanged 3`.

### CLI options

| Flag | Meaning |
| --- | --- |
| `--cities "A, B"` | override config cities (comma-separated) |
| `--niches "X, Y"` | override config niches |
| `--limit N` | max businesses per (city, niche) combo |
| `--dry-run` | extract + classify only; print JSON rows, no DB |
| `--batch NAME` | `source_batch` label (default `sweep-YYYYMMDD`) |
| `--config PATH` | alternative config file |
| `--no-audit` | skip homepage audits (every URL → `weak`) |
| `--include-good` | also upsert converting sites (`good`) |
| `--retries N` | per-combo retries (default 2) |
| `--concurrency N` | homepage-audit parallelism (default 3) |
| `--verbose` | per-card detail |

Exit codes: `0` ran (partial failures OK), `1` nothing extracted / fatal,
`2` bad usage.

## Configure the weekly scope

Edit [`config.json`](./config.json) — `cities`, `niches`, and defaults. The
cron run (below) uses this file with no overrides. On-demand runs pass
`workflow_dispatch` inputs which override it.

## The cron (GitHub Actions)

[`.github/workflows/lead-sweep.yml`](../.github/workflows/lead-sweep.yml):

- **Schedule:** `0 11 * * 1` — Monday **11:00 UTC** = **06:00 US Central**
  in daylight time (05:00 in winter). GitHub cron runs are UTC-only; to move
  the time edit the `cron` line + the comment. (No inputs on scheduled runs —
  they use `config.json`.)
- **On-demand:** `workflow_dispatch` with `cities`, `niches`, `limit`,
  `batch`, `include_good` inputs — useful for sweeps between Mondays.
- **Steps:** checkout → Node 20 → `npm ci` → `npx playwright install --with-deps chromium` → run the script with `DATABASE_URL` from the repo secret → post the summary to the run page.
- **Required secret:** `DATABASE_URL` (Neon connection string). Set it once in
  repo → Settings → Secrets and variables → Actions.
- **Failure behavior:** per-combo retries in the script; the job fails only on
  total failure (zero extracted). Partial results are kept and reported.
  A `concurrency` group prevents overlapping runs.

## Notes / gotchas learned

- Maps is public data, not account-authenticated — no login, no per-account
  risk. Pacing is modest (700ms scroll waits) but Google can still show a
  captcha from datacenter IPs; retries + per-combo isolation handle it, and a
  full weekly sweep is only a handful of combos.
- The classic Maps lazy-load gotcha: you must scroll the results **feed's**
  scroll container (`div.m6QErb`), not the window — the script walks up from
  `[role="feed"]` like the Hunter's skill.
- First ~20 results per niche are usually established businesses **with**
  sites; no-website businesses sit deeper, so don't set `--limit` too low for
  real sweeps (config default: 40).
- No emails are extracted (Maps cards don't publish them; never guessed —
  schema allows NULL). Phones are the outreach channel.
- Node ≥ 18 (tested on 20/22). Memory-light: one browser context at a time,
  audits capped at 3 parallel fetches.
