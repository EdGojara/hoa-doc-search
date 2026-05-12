-- ============================================================================
-- 024_events.sql — Community Events module
-- ----------------------------------------------------------------------------
-- One migration covers all three sessions of the events build:
--
--   events                  — master event record (planning + execution)
--   event_vendors           — many-to-many: which vendors did what at this event
--   event_signatures        — waiver signature + auto-becomes the attendance row
--   invoices_received       — add linked_event_id so caterer invoices roll up
--
-- Design notes:
--   - event_signatures is the SINGLE check-in artifact: legal waiver + attendance
--     in one row. Avoids the "did they sign?" / "are they here?" double-entry.
--   - waiver_text is snapshotted onto each signature (waiver_text_at_signing) so
--     edits to the master template don't invalidate prior signatures.
--   - signature_png is base64 PNG drawn on the canvas pad. Could move to storage
--     bucket later; inline is fine at expected volume.
--   - public_signup_enabled gates whether the /event/:slug URL works publicly.
--     Off by default — staff has to enable per event.
--   - Apply AFTER 023. Idempotent.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid if not yet present

-- ----------------------------------------------------------------------------
-- 1. events — master record
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id       UUID NOT NULL REFERENCES management_companies(id),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  -- Identity / display
  name                        TEXT NOT NULL,                       -- "Summer Pool Party 2026"
  slug                        TEXT NOT NULL,                       -- "lpf-pool-party-2026-06-15" — used in public URL + QR
  event_type                  TEXT,                                -- 'pool_party' | 'holiday' | 'annual_meeting' | 'workshop' | 'other'
  description                 TEXT,                                -- internal notes / public-facing blurb (use for both for now)
  location                    TEXT,                                -- "Pool deck", "Clubhouse", "8201 Pine Forest Ln"

  -- Scheduling
  scheduled_start_at          TIMESTAMPTZ NOT NULL,
  scheduled_end_at            TIMESTAMPTZ,
  actual_start_at             TIMESTAMPTZ,                         -- filled in when event goes live
  actual_end_at               TIMESTAMPTZ,

  -- Planning estimates
  estimated_attendance        INTEGER,                             -- planned headcount
  max_attendance              INTEGER,                             -- hard cap (optional)
  budget_estimated            NUMERIC(10, 2),                      -- top-line budget; per-vendor estimates in event_vendors

  -- Status
  status                      TEXT NOT NULL DEFAULT 'planned'
                                CHECK (status IN ('planned', 'live', 'completed', 'cancelled')),

  -- Waiver setup
  waiver_required             BOOLEAN NOT NULL DEFAULT TRUE,
  waiver_title                TEXT,                                -- default "Event Waiver — {event_name}"
  waiver_text                 TEXT,                                -- full legal text shown to signer
  requires_minor_consent      BOOLEAN NOT NULL DEFAULT TRUE,       -- ask if signer is signing for a minor

  -- Public access
  public_signup_enabled       BOOLEAN NOT NULL DEFAULT FALSE,      -- gate /event/:slug
  qr_image_data               TEXT,                                -- cached data: URL of the QR PNG

  -- Audit
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (management_company_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_events_community
  ON events(management_company_id, community_id, scheduled_start_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status
  ON events(management_company_id, status, scheduled_start_at DESC);

DROP TRIGGER IF EXISTS trg_events_updated_at ON events;
CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. event_vendors — which vendors did what
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_vendors (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id                    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  vendor_id                   UUID REFERENCES vendors(id) ON DELETE SET NULL,   -- nullable so we can record vendors not yet in master
  vendor_name_snapshot        TEXT,                                              -- captured name in case vendor row changes/deleted

  service_role                TEXT NOT NULL,                                     -- 'catering' | 'dj' | 'photography' | 'security' | 'bounce_house' | 'cleanup' | 'rental' | 'entertainment' | 'other'
  service_description         TEXT,                                              -- "5 large pizzas + soft drinks" or "DJ + sound system 6pm-10pm"

  estimated_cost              NUMERIC(10, 2),
  actual_cost                 NUMERIC(10, 2),
  payment_status              TEXT NOT NULL DEFAULT 'pending'
                                CHECK (payment_status IN ('pending', 'deposit_paid', 'paid', 'refunded')),

  notes                       TEXT,
  ordered_at                  DATE,                                              -- when we contracted/ordered
  delivery_date               DATE,                                              -- when service occurs

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_vendors_event ON event_vendors(event_id);
CREATE INDEX IF NOT EXISTS idx_event_vendors_vendor ON event_vendors(vendor_id);
CREATE INDEX IF NOT EXISTS idx_event_vendors_role ON event_vendors(service_role);

DROP TRIGGER IF EXISTS trg_event_vendors_updated_at ON event_vendors;
CREATE TRIGGER trg_event_vendors_updated_at
  BEFORE UPDATE ON event_vendors
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. event_signatures — legal waiver + attendance in one row
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_signatures (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id                    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Who signed
  signer_name                 TEXT NOT NULL,
  signer_email                TEXT,
  signer_phone                TEXT,
  signer_address              TEXT,                                  -- their HOA address if homeowner; otherwise leave blank
  is_homeowner                BOOLEAN NOT NULL DEFAULT FALSE,
  guest_of_address            TEXT,                                  -- if guest, which homeowner's address invited them

  -- Minor consent (if event involves minors)
  is_minor                    BOOLEAN NOT NULL DEFAULT FALSE,
  parent_guardian_name        TEXT,
  parent_guardian_signature_png TEXT,

  -- The signature itself
  signature_png               TEXT NOT NULL,                          -- base64 data URL of canvas drawing
  signed_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Provenance for legal validity
  waiver_text_at_signing      TEXT NOT NULL,                          -- snapshot — what the signer actually agreed to
  ip_address                  TEXT,
  user_agent                  TEXT,
  device_type                 TEXT,                                   -- 'phone' | 'tablet' | 'paper_uploaded' | 'desktop'

  -- Attendance tracking (this row IS the check-in)
  checked_in_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_out_at              TIMESTAMPTZ,

  -- For uploads of physical paper waivers
  paper_waiver_image_url      TEXT,                                   -- if signature came from a paper upload, link to scan
  source                      TEXT NOT NULL DEFAULT 'electronic'
                                CHECK (source IN ('electronic', 'paper_uploaded')),

  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_signatures_event ON event_signatures(event_id, signed_at DESC);

-- ----------------------------------------------------------------------------
-- 4. invoices_received — add event link
-- ----------------------------------------------------------------------------

ALTER TABLE invoices_received
  ADD COLUMN IF NOT EXISTS linked_event_id UUID REFERENCES events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_linked_event
  ON invoices_received(linked_event_id) WHERE linked_event_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 5. v_event_costs — aggregated cost view (estimated vs actual, w/ invoice rollup)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_event_costs AS
SELECT
  e.id                            AS event_id,
  e.community_id,
  e.name                          AS event_name,
  e.scheduled_start_at,
  e.status,
  e.budget_estimated,
  COALESCE(ev.total_estimated, 0) AS vendors_estimated_total,
  COALESCE(ev.total_actual, 0)    AS vendors_actual_total,
  COALESCE(inv.invoice_total, 0)  AS invoices_total,
  -- "actual" preference: vendor actual_cost if set, else invoice total
  GREATEST(COALESCE(ev.total_actual, 0), COALESCE(inv.invoice_total, 0)) AS actual_total_estimate
FROM events e
LEFT JOIN (
  SELECT event_id,
         SUM(COALESCE(estimated_cost, 0)) AS total_estimated,
         SUM(COALESCE(actual_cost, 0))    AS total_actual
  FROM event_vendors
  GROUP BY event_id
) ev ON ev.event_id = e.id
LEFT JOIN (
  SELECT linked_event_id AS event_id,
         SUM(COALESCE(total_amount, 0)) AS invoice_total
  FROM invoices_received
  WHERE linked_event_id IS NOT NULL
  GROUP BY linked_event_id
) inv ON inv.event_id = e.id;

-- ----------------------------------------------------------------------------
-- 6. v_event_attendance — per-event headcount
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_event_attendance AS
SELECT
  e.id          AS event_id,
  e.community_id,
  e.name        AS event_name,
  e.scheduled_start_at,
  COUNT(s.id)                                         AS signatures_count,
  COUNT(s.id) FILTER (WHERE s.is_homeowner)           AS homeowner_count,
  COUNT(s.id) FILTER (WHERE NOT s.is_homeowner)       AS guest_count,
  COUNT(s.id) FILTER (WHERE s.is_minor)               AS minor_count
FROM events e
LEFT JOIN event_signatures s ON s.event_id = e.id
GROUP BY e.id, e.community_id, e.name, e.scheduled_start_at;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verify:
--   SELECT id, name, slug, status, scheduled_start_at FROM events LIMIT 3;
--   SELECT * FROM v_event_costs LIMIT 3;
--   SELECT * FROM v_event_attendance LIMIT 3;
-- ----------------------------------------------------------------------------
