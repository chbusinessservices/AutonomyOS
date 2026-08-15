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

---

# LinkedIn outreach engine (Phase 3)

The machine's outbound arm: picks fresh leads from Neon (`status='new'`,
oldest first) and sends a personalized LinkedIn connection request (or DM
when already connected) with human-mimicking pacing and a **hard daily cap**.
Every successful send flips the lead to `'contacted'` and appends a
`lead_events('outreach_sent')` row in one transaction.

```
scripts/
 linkedin-outreach.js   Playwright runner (search → connect/DM → cap → events)
 linkedin-core.js       Testable core: template rendering, cap state, SQL helpers
 linkedin-templates.json  Message variants + placeholders (deterministic, no LLM)
 linkedin-config.json   cap 15, delay 15–45s, status filter 'new'
 test/linkedin-outreach.test.js  Unit tests (node --test)
```

## Status: dry-run verified, real mode gated

- No LinkedIn credentials exist and the owner has **not** decided
  automated-vs-manual — so this phase ships code + verified dry-run + unit
  tests only. The script **refuses** real mode without credentials.
- Never attempt a real login/send until the owner decides and the selectors in
  `linkedin-outreach.js` (`LI_SELECTORS`) are verified against live LinkedIn —
  they are best-effort scaffolding and WILL drift.

## Configure

Copy `.env.example` → `.env` (never commit real values) or export:

| Env | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon connection string (required — dry-run reads the DB too). On this machine: `export DATABASE_URL=$(cat /home/team/shared/.neon-db-url)` |
| `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD` | Real-mode creds (env only, never in code) |
| `LINKEDIN_SESSION_DIR` | Alternative: path to a persistent browser context you logged into once by hand |
| `LINKEDIN_DAILY_CAP` | Override the daily cap (default 15 from config) |
| `LINKEDIN_DRY_RUN=1` | **Kill switch** — forces dry-run no matter what |
| `LINKEDIN_STATE_FILE` | Override the cap-state file path |

Defaults live in [`linkedin-config.json`](./linkedin-config.json): cap 15,
delay 15–45s between actions, 2–5s before Send, status filter `new`,
`headless: true`. Precedence: CLI flag > env > config.

## Run

```sh
npm install          # scripts/ — playwright + pg only
npm test             # unit tests (rendering, cap logic, SQL helpers)
export DATABASE_URL=$(cat /home/team/shared/.neon-db-url)

# preview the plan — safe, no login, no writes, still respects the cap
npm run outreach:dry -- --limit 3        # or: node linkedin-outreach.js --dry-run --limit 3

# real mode (only after owner decision + selector verification!)
export LINKEDIN_EMAIL=... LINKEDIN_PASSWORD=...
node linkedin-outreach.js                 # default: cap 15, status 'new'
node linkedin-outreach.js --limit 3       # smoke: at most 3, still ≤ cap
```

## Cap semantics (the non-negotiable)

- Hard per-day budget, default 15 (LinkedIn-safe band is 15–20/day).
- Persisted per UTC day in `scripts/.linkedin-run-state.json` (gitignored).
- **Crash-proof:** the run also counts today's `outreach_sent` rows in the DB
  and uses the MAX of the two, so a crash between the DB write and the state
  file write (or a deleted state file) can never push past the cap.
- The state file is rewritten after **every** successful send — a mid-run
  crash resumes from the true count on the next run.
- A new UTC day resets the budget; held-back leads are picked up oldest-first.
- A failed send (no matching profile, LinkedIn hiccup) does **not** consume a
  slot — the lead stays `'new'` for the next run. Retry/backoff is per-action
  (config `retries`, `retry_base_ms`).

## Message templates

[`linkedin-templates.json`](./linkedin-templates.json) — 3 variants, plain
placeholder substitution, no LLM in this phase. Placeholders:
`{{business_name}}`, `{{city}}`, `{{niche}}`, and `{{website_status}}` which
renders a friendly phrase from the audit domain (`'none'` → "is missing
entirely", `'weak'` → "isn't converting visitors into calls yet", `'good'` →
"is up and running"). The variant is picked deterministically by lead id
(same lead → same variant on re-runs). Messages are truncated defensively at
300 chars (LinkedIn's connection-note limit).

**Phase 4 hook:** `buildPlan()` in `linkedin-core.js` calls
`personalize(lead, message)` — today the identity. Swap in a DeepSeek/OpenAI
call behind that signature for AI personalization without touching the action
loop, cap logic, or SQL.

## Account-safety notes

- Keep `daily_cap` at 15–20. The 15–45s random delays between actions and the
  paced typing before Send are what keep the account from looking like a bot.
- One browser session at a time; no concurrency. Runs take a while by design
  (15 leads × ~30s pacing ≈ 8–10 min).
- The script only visits the profile it intends to message — no bulk scraping
  of result lists beyond the first 5 candidates.

## ⚠ LinkedIn ToS risk

Automated outreach violates LinkedIn's User Agreement (their anti-bot and
anti-scraping terms). Real-mode use carries real risk of the account being
restricted or banned, and the owner has not yet decided automated vs manual.
This phase ships the engine **disabled by default** (dry-run only, no creds).
Enable it only after: (1) the owner explicitly opts in, (2) selectors are
verified live, and (3) the team accepts the account-ban risk on record.
