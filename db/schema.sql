-- ============================================================================
-- db/schema.sql — CH Business Services lead pipeline schema (Phase 1)
-- Target: Neon Postgres. Idempotent — safe to run repeatedly (CREATE IF NOT
-- EXISTS / DROP + CREATE trigger pattern). Does NOT drop existing data.
--
-- Consumers of this schema (the machine):
--   • GitHub Actions cron  → INSERT new leads from sweep batch markdown files
--   • n8n /webhook/lead-created → INSERT lead + lead_events row in one txn
--   • Outreach / Negotiator → UPDATE leads.status, append lead_events rows
--   • Stripe webhook /webhook/payment-received → set status='closed_won' +
--     log payment event
--   • Dashboard (site/src/routes/dashboard.tsx) → later reads this table
--     instead of static site/src/lead-data.ts (lead-data fields: name, city,
--     niche, phone — mapped to business_name, city, niche, phone below).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- leads — one row per business in the pipeline. Upserted by (business_name,
-- city) so re-sweeps of the same market never create duplicates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_name  TEXT NOT NULL,
  -- E.164 normalized (e.g. '+15126158256') so SMS/tel links work directly.
  -- NULL when the business publishes no phone.
  phone          TEXT,
  -- Lowercased; only published emails (hunter never guesses). NULL if n/a.
  email          TEXT,
  -- Audited homepage URL as captured by the hunter; NULL when the business
  -- has no web property at all. For "Facebook only" leads this holds the
  -- Facebook page URL while website_status='none' (no own site to convert on).
  website        TEXT,
  -- Audit verdict (hunter's homepage audit → normalized):
  --   'none' — no website at all (or social-only presence)
  --   'weak' — site exists but doesn't convert (down/placeholder/template/
  --            outdated/no contact form/no mobile)
  --   'good' — converting site (none in seed data; reserved for future sweeps)
  website_status TEXT NOT NULL DEFAULT 'weak'
                CHECK (website_status IN ('none', 'weak', 'good')),
  -- Normalized to "City, ST" (e.g. 'Austin, TX'); suburb parentheticals are
  -- stripped so city grouping stays clean ('Raleigh, NC (Cary)' → 'Raleigh, NC').
  city           TEXT NOT NULL,
  -- Service category from the sweep, e.g. 'Plumbing', 'HVAC / Plumbing'.
  niche          TEXT,
  -- Sweep that produced this lead: 'batch1', 'batch2', … (no CHECK — new
  -- batches arrive from the weekly GitHub Actions cron).
  source_batch   TEXT NOT NULL,
  -- Pipeline state, driven by the machine (n8n/Stripe webhooks):
  --   new → contacted → replied → negotiating → closed_won | closed_lost
  -- (Dashboard's current stage labels engaged/proposal map to replied/
  -- negotiating; dashboard migration is a later step.)
  status         TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'contacted', 'replied',
                                  'negotiating', 'closed_won', 'closed_lost')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leads_business_name_city_key UNIQUE (business_name, city)
);

-- Common access paths for the machine: filter by stage, group by city,
-- count per batch.
CREATE INDEX IF NOT EXISTS leads_status_idx      ON leads (status);
CREATE INDEX IF NOT EXISTS leads_city_idx        ON leads (city);
CREATE INDEX IF NOT EXISTS leads_source_batch_idx ON leads (source_batch);

-- ---------------------------------------------------------------------------
-- lead_events — append-only audit / state-transition log, one row per machine
-- action. The machine should ALWAYS write an event here when it changes a
-- lead, so every state transition is reconstructable.
--
-- Suggested event_type values (documented convention, not enforced):
--   lead_created   payload: { source: 'github-actions' | 'n8n' | 'manual', batch }
--   status_changed payload: { from, to }
--   outreach_sent  payload: { channel: 'linkedin'|'sms'|'email'|'instagram',
--                             template, message_id }
--   reply_received payload: { snippet, intent }
--   payment_link_sent payload: { stripe_url }
--   payment_received payload: { stripe_session_id, amount, currency } — written
--                             by the Stripe /webhook/payment-received handler,
--                             which also flips leads.status to 'closed_won'.
--   note_added     payload: { text } — human/AI annotations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     BIGINT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Event log is almost always read per-lead, newest first (e.g. "last
-- interaction before the Negotiator replies").
CREATE INDEX IF NOT EXISTS lead_events_lead_id_created_at_idx
  ON lead_events (lead_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance — keeps leads.updated_at honest when the machine
-- updates status/contact data. Idempotent (DROP + CREATE).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_leads_updated_at ON leads;
CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
