# AutonomyOS

Operating system for **CH Business Services** — the automation stack that turns visitors into customers for small-to-midsize companies.

## What's in here

| Path | What it is |
| --- | --- |
| `site/` | The company website + live pipeline dashboard (TanStack Start, served on port 3000, published via `bun run publish`) |
| `data/` | Lead lists from Hunter's city/niche sweeps (`leads-batch1.md`, `leads-batch2.md`) |
| `playbooks/` | Outreach playbook used by the Outreach Agent / Closer |
| `content/` | SEO & social content engine assets |
| `WORKFLOW.md` | Team code workflow — read before making changes |

## Pipeline (target: $10K/week)

1. **Continuous lead gen** — Hunter runs weekly sweeps of new cities/niches
2. **Automated outreach** — LinkedIn and SMS sequences fire automatically (pending Pro upgrade)
3. **Auto-close** — Negotiator handles replies and objections; Payment Agent collects via Stripe
4. **Social engine** — weekly content auto-published to LinkedIn, IG, X
5. **Dashboard** — real-time pipeline tracking toward the $10K/week target (live at `/dashboard`)

## Dev notes

- Site: `cd site && bun install && bun run publish` (publishes to port 3000)
- Generated files (`src/routeTree.gen.ts`, `dist/`, `node_modules/`, `.run/`) are git-ignored — regenerate on build
- Branch workflow: members push feature branches → open PRs → lead reviews and merges (see `WORKFLOW.md`)
