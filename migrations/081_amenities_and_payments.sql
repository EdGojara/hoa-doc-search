-- ============================================================================
-- 081_amenities_and_payments.sql
-- ----------------------------------------------------------------------------
-- Foundation for homeowner-facing amenity bookings (clubhouse rentals first)
-- AND the universal Stripe payments ledger every future revenue surface
-- writes into.
--
-- WHY THIS EXISTS:
--   Bedrock currently takes clubhouse rental payments by check (separate checks
--   per fee item, hand-delivered to clubhouse). This migration sets up the
--   schema so homeowners can book + pay online — while preserving the paper
--   path for tech-resistant homeowners (intake_method='staff_in_person' writes
--   to the same record).
--
--   Same schema serves future revenue: ARC fees, key fob purchases, builder
--   review fees, pool key replacements, future amenity bookings. ONE
--   payments table for everything Stripe-collected (per the single-source-of-truth
--   discipline). See project_payment_rails.md.
--
-- ANTI-COMMINGLING — THE FIDUCIARY RULE:
--   HOA funds and Bedrock management-company funds NEVER share a Stripe
--   account, even temporarily. Bedrock holds HOA money in trust per the
--   management agreement; commingling creates fiduciary exposure that an
--   auditor will flag immediately. This schema is built for Stripe Connect
--   where each HOA has its OWN connected account; payments split at charge
--   time so HOA-portion fees settle to the HOA's bank and Bedrock-portion
--   fees settle to Bedrock's bank without ever co-mingling.
--
--   - communities.stripe_connected_account_id  → routes HOA-side fees
--   - payments.payee + payments.connected_account_id  → records who got paid
--   - amenity_fee_schedule.payee  → defines per-fee-item routing upfront
--
-- TECH-OPTIONAL INTAKE:
--   Per feedback_tech_optional_intake.md, every customer-facing module has
--   both online and staff-assisted intake paths writing to the SAME record.
--   amenity_rentals.intake_method captures which path was used.
--   amenity_rentals.agreement_paper_pdf_path stores the scanned signed paper
--   contract when staff records an in-person rental.
--
-- APPLY AFTER 080. IDEMPOTENT.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Communities table extensions — Stripe Connect routing + amenity kill switch
-- ----------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS stripe_connected_account_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_onboarding_status     TEXT
    CHECK (stripe_onboarding_status IS NULL OR stripe_onboarding_status IN
      ('not_started', 'in_progress', 'restricted', 'enabled', 'rejected')),
  ADD COLUMN IF NOT EXISTS stripe_onboarded_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amenity_bookings_active      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS hoa_legal_name               TEXT,
  ADD COLUMN IF NOT EXISTS hoa_address                  TEXT;

COMMENT ON COLUMN communities.stripe_connected_account_id IS
  'Stripe Connect Express acct_xxx ID for this HOA. HOA-side fees route here; NULL means online bookings cannot run (kill switch). Set by Ed during per-community onboarding.';
COMMENT ON COLUMN communities.amenity_bookings_active IS
  'Kill switch for the online amenity-booking flow at this community. Off by default so a new community cannot accept online bookings until config is complete.';
COMMENT ON COLUMN communities.hoa_legal_name IS
  'Full legal name of the HOA (e.g., "Waterview Estates Owners Association, Inc."). Used on contracts, decision letters, and Stripe descriptors.';

-- ----------------------------------------------------------------------------
-- 2) amenities — clubhouse, pool, park, playground, court, etc.
--    Multi-purpose. Same schema serves "what's at this community" for the
--    future map module AND "what's available to rent" for booking module.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amenities (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                    UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  amenity_type                    TEXT NOT NULL
                                    CHECK (amenity_type IN ('clubhouse', 'pool', 'park', 'playground',
                                                            'sport_court', 'fitness', 'dog_park',
                                                            'walking_trail', 'gate', 'mailroom', 'other')),
  name                            TEXT NOT NULL,            -- e.g., "Waterview Clubhouse"
  description                     TEXT,
  street_address                  TEXT,
  capacity                        INTEGER,

  -- Public-info card (homeowner amenity map module — Task #18 area)
  hours_text                      TEXT,                     -- "M-F 6am-10pm, Sa 8am-10pm, Su 10am-8pm"
  hours_structured                JSONB,                    -- [{day:'mon', open:'06:00', close:'22:00'}, ...]
  contact_name                    TEXT,                     -- e.g., pool company name
  contact_phone                   TEXT,
  contact_email                   TEXT,
  rules_url                       TEXT,                     -- public link to rules / pool company info
  photo_storage_path              TEXT,                     -- supabase storage path
  lat                             NUMERIC(10, 7),
  lng                             NUMERIC(10, 7),
  seasonal_open_month             INTEGER CHECK (seasonal_open_month BETWEEN 1 AND 12),
  seasonal_close_month            INTEGER CHECK (seasonal_close_month BETWEEN 1 AND 12),

  -- Rental config (NULL when not rentable, e.g., a park or pool)
  is_rentable                     BOOLEAN NOT NULL DEFAULT FALSE,
  rental_eligibility              TEXT CHECK (rental_eligibility IS NULL OR rental_eligibility IN
                                              ('community_members_only', 'open_to_public', 'invited')),
  rental_requires_assessments_current  BOOLEAN NOT NULL DEFAULT TRUE,
  rental_min_lead_time_days       INTEGER,
  rental_max_lead_time_days       INTEGER,
  rental_max_attendees            INTEGER,
  rental_end_time_weekday         TIME,
  rental_end_time_weekend         TIME,
  rental_cancellation_window_hours  INTEGER DEFAULT 48,
  rental_annual_cap_per_member    INTEGER,                  -- e.g., 4 weekend/holiday rentals per year
  rental_agreement_text           TEXT,                     -- full contract content; can be Markdown or plain
  rental_agreement_version        TEXT,                     -- e.g., "2025-01" — bumped when language changes
  rental_agreement_pdf_path       TEXT,                     -- canonical PDF in supabase storage

  status                          TEXT NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'inactive', 'seasonal_closed', 'maintenance')),
  display_order                   INTEGER NOT NULL DEFAULT 100,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness on amenity name per community.
-- (LOWER() can't appear inside an inline UNIQUE constraint — must be a separate index.)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_amenities_name_ci
  ON amenities (community_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_amenities_community
  ON amenities(community_id, status, display_order);
CREATE INDEX IF NOT EXISTS idx_amenities_rentable
  ON amenities(community_id, is_rentable)
  WHERE is_rentable = TRUE;

DROP TRIGGER IF EXISTS trg_amenities_updated_at ON amenities;
CREATE TRIGGER trg_amenities_updated_at
  BEFORE UPDATE ON amenities
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 3) amenity_fee_schedule — per-fee-item config for rentable amenities
--    Each fee line specifies amount, refundability, who gets paid, required vs optional.
--    For Waterview clubhouse:
--      rental:             $150  refundable=FALSE  payee=community_association
--      cleaning:           $70   refundable=FALSE  payee=management_company
--      processing:         $25   refundable=FALSE  payee=management_company
--      security_deposit:   $400  refundable=TRUE   payee=community_association
--      av_equipment:       $50   refundable=TRUE   payee=community_association  required=FALSE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amenity_fee_schedule (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amenity_id               UUID NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
  fee_type                 TEXT NOT NULL
                             CHECK (fee_type IN ('rental', 'cleaning', 'processing',
                                                 'security_deposit', 'av_equipment_deposit',
                                                 'pet_deposit', 'late_fee', 'damage_repair', 'other')),
  label                    TEXT NOT NULL,            -- display string on checkout
  amount_cents             INTEGER NOT NULL CHECK (amount_cents >= 0),
  refundable               BOOLEAN NOT NULL DEFAULT FALSE,
  required                 BOOLEAN NOT NULL DEFAULT TRUE,
  payee                    TEXT NOT NULL
                             CHECK (payee IN ('community_association', 'management_company', 'vendor')),
  payee_display_name       TEXT NOT NULL,            -- e.g., "Waterview Estates Owners Association, Inc."
  notes                    TEXT,
  display_order            INTEGER NOT NULL DEFAULT 100,
  effective_from           DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to             DATE,                     -- NULL = currently active
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_amenity_fees_active
  ON amenity_fee_schedule(amenity_id, fee_type, effective_from DESC)
  WHERE effective_to IS NULL;

DROP TRIGGER IF EXISTS trg_amenity_fees_updated_at ON amenity_fee_schedule;
CREATE TRIGGER trg_amenity_fees_updated_at
  BEFORE UPDATE ON amenity_fee_schedule
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 4) amenity_rentals — bookings, online OR staff-recorded paper
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amenity_rentals (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amenity_id               UUID NOT NULL REFERENCES amenities(id) ON DELETE RESTRICT,
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  reference_number         TEXT UNIQUE,                       -- e.g., 'WVE-CLB-2026-0001'

  -- Renter identity (manually entered OR auto-resolved against contacts/properties)
  renter_name              TEXT NOT NULL,
  renter_email             TEXT NOT NULL,
  renter_phone_cell        TEXT,
  renter_phone_home        TEXT,
  renter_phone_work        TEXT,
  renter_address           TEXT,
  property_id              UUID REFERENCES properties(id) ON DELETE SET NULL,
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Event details
  event_date               DATE NOT NULL,
  arrival_time             TIME NOT NULL,
  departure_time           TIME NOT NULL,
  event_description        TEXT,
  attendee_count           INTEGER,
  optional_addons          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- e.g., {av_equipment: true}

  -- Intake path (tech-optional rule)
  intake_method            TEXT NOT NULL DEFAULT 'online_portal'
                             CHECK (intake_method IN ('online_portal', 'staff_in_person',
                                                      'staff_phone', 'staff_email', 'paper_mail')),
  intake_recorded_by       TEXT,                              -- staff name when staff-recorded; NULL online

  -- Contract acknowledgment
  agreement_version        TEXT,                              -- which version of the contract was active
  agreement_text_hash      TEXT,                              -- SHA of agreement text at signing
  agreement_acknowledged_at  TIMESTAMPTZ,
  agreement_signature_method  TEXT
                             CHECK (agreement_signature_method IS NULL OR agreement_signature_method IN
                                    ('inline_checkbox', 'paper_signature_on_file', 'docusign')),
  agreement_signature_ip   TEXT,
  agreement_signature_user_agent  TEXT,
  agreement_paper_pdf_path TEXT,                              -- supabase storage path of scanned signed paper

  -- Workflow state
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'pending_payment', 'confirmed',
                                               'completed', 'cancelled', 'refunded', 'no_show')),
  confirmed_at             TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,

  -- Cancellation
  cancelled_at             TIMESTAMPTZ,
  cancelled_by             TEXT,
  cancellation_reason      TEXT,

  -- Post-rental inspection (schema-ready; UI ships v1)
  inspection_completed_at  TIMESTAMPTZ,
  inspection_completed_by  TEXT,
  inspection_passed        BOOLEAN,
  inspection_notes         TEXT,
  inspection_checklist     JSONB,                             -- [{item, passed, note}, ...]
  deposit_returned_at      TIMESTAMPTZ,
  deposit_withholding_cents  INTEGER DEFAULT 0,
  deposit_withholding_reason  TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Calendar queries: find rentals for a given amenity in a date range
CREATE INDEX IF NOT EXISTS idx_amenity_rentals_calendar
  ON amenity_rentals(amenity_id, event_date, arrival_time)
  WHERE status IN ('pending_payment', 'confirmed', 'completed');
CREATE INDEX IF NOT EXISTS idx_amenity_rentals_community_queue
  ON amenity_rentals(community_id, status, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_amenity_rentals_renter_history
  ON amenity_rentals(LOWER(renter_email), event_date DESC);
CREATE INDEX IF NOT EXISTS idx_amenity_rentals_property
  ON amenity_rentals(property_id)
  WHERE property_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_amenity_rentals_updated_at ON amenity_rentals;
CREATE TRIGGER trg_amenity_rentals_updated_at
  BEFORE UPDATE ON amenity_rentals
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 5) payments — UNIVERSAL Stripe ledger
--    Every Stripe-collected payment from every module writes here.
--    Product is identified by (product_type, product_id) — polymorphic.
--    For Stripe Connect: connected_account_id distinguishes HOA-side payments
--    (settled to HOA bank) from platform-side payments (settled to Bedrock).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,

  -- Polymorphic product link
  product_type             TEXT NOT NULL
                             CHECK (product_type IN ('amenity_rental', 'arc_application',
                                                     'builder_application', 'key_fob',
                                                     'pool_key', 'gate_remote', 'other')),
  product_id               UUID,                              -- FK to amenity_rentals.id, etc. (loose)
  fee_type                 TEXT,                              -- 'rental', 'cleaning', 'processing', etc.

  -- Payee routing (anti-commingling)
  payee                    TEXT NOT NULL
                             CHECK (payee IN ('community_association', 'management_company', 'vendor')),
  payee_display_name       TEXT NOT NULL,
  connected_account_id     TEXT,                              -- Stripe Connect acct_xxx if HOA-side

  -- Amount
  amount_cents             INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency                 TEXT NOT NULL DEFAULT 'USD',
  refundable               BOOLEAN NOT NULL DEFAULT FALSE,

  -- Method (online OR paper)
  method                   TEXT NOT NULL
                             CHECK (method IN ('stripe_checkout', 'check', 'money_order',
                                               'cashiers_check', 'cash', 'ach', 'wire', 'other')),
  method_reference         TEXT,                              -- check #, money order #, etc.

  -- Processor (Stripe today; designed swap-friendly)
  processor                TEXT
                             CHECK (processor IS NULL OR processor IN ('stripe', 'square', 'propay', 'other')),
  processor_payment_id     TEXT,                              -- stripe payment_intent_id
  processor_session_id     TEXT,                              -- stripe checkout session_id
  processor_fee_cents      INTEGER,                           -- what processor took (for reconciliation)
  processor_metadata       JSONB,                             -- full event payload from webhook

  -- Status (driven by webhook + staff actions)
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'succeeded', 'failed',
                                               'refunded', 'partially_refunded', 'cancelled')),
  paid_at                  TIMESTAMPTZ,
  refunded_at              TIMESTAMPTZ,
  refunded_amount_cents    INTEGER NOT NULL DEFAULT 0,
  refund_reason            TEXT,
  failure_reason           TEXT,

  -- Audit
  initiated_by             TEXT,                              -- 'homeowner_portal' or staff name
  notes                    TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_product
  ON payments(product_type, product_id);
CREATE INDEX IF NOT EXISTS idx_payments_community_status
  ON payments(community_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_processor_id
  ON payments(processor, processor_payment_id)
  WHERE processor_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_session
  ON payments(processor_session_id)
  WHERE processor_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_payee_settlement
  ON payments(payee, connected_account_id, paid_at DESC)
  WHERE status = 'succeeded';

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 6) View — v_amenity_rental_queue: admin tab snapshot
--    Includes payment status totals so reviewer sees at a glance.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_amenity_rental_queue AS
SELECT
  ar.id,
  ar.community_id,
  c.name                                   AS community_name,
  c.slug                                   AS community_slug,
  ar.amenity_id,
  a.name                                   AS amenity_name,
  a.amenity_type,
  ar.reference_number,
  ar.renter_name,
  ar.renter_email,
  ar.event_date,
  ar.arrival_time,
  ar.departure_time,
  ar.attendee_count,
  ar.event_description,
  ar.intake_method,
  ar.intake_recorded_by,
  ar.status,
  ar.confirmed_at,
  ar.cancelled_at,
  ar.completed_at,
  ar.inspection_passed,
  ar.deposit_returned_at,
  ar.deposit_withholding_cents,
  -- Payment rollups
  COALESCE((SELECT SUM(amount_cents) FROM payments p
            WHERE p.product_type='amenity_rental'
              AND p.product_id = ar.id
              AND p.status='succeeded'), 0)  AS total_paid_cents,
  COALESCE((SELECT SUM(amount_cents) FROM payments p
            WHERE p.product_type='amenity_rental'
              AND p.product_id = ar.id
              AND p.status='pending'), 0)    AS total_pending_cents,
  COALESCE((SELECT SUM(refunded_amount_cents) FROM payments p
            WHERE p.product_type='amenity_rental'
              AND p.product_id = ar.id), 0)  AS total_refunded_cents,
  ar.created_at,
  ar.updated_at
FROM amenity_rentals ar
JOIN communities c ON c.id = ar.community_id
JOIN amenities a   ON a.id = ar.amenity_id;

-- ----------------------------------------------------------------------------
-- 7) View — v_amenity_availability: open slots per amenity per date
--    Used by the booking form to grey out conflicting slots.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_amenity_busy_slots AS
SELECT
  amenity_id,
  event_date,
  arrival_time,
  departure_time,
  status,
  reference_number
FROM amenity_rentals
WHERE status IN ('pending_payment', 'confirmed', 'completed');

-- ----------------------------------------------------------------------------
-- 8) Grants
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  amenities,
  amenity_fee_schedule,
  amenity_rentals,
  payments
  TO anon, authenticated, service_role;

GRANT SELECT ON v_amenity_rental_queue TO service_role, authenticated;
GRANT SELECT ON v_amenity_busy_slots TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9) Comments
-- ----------------------------------------------------------------------------
COMMENT ON TABLE amenities IS
  'Multi-purpose amenity registry per community. Same table powers (1) the homeowner amenity map (pool/park/clubhouse pins with hours + contact), and (2) the rentable amenities list (clubhouses today). is_rentable=TRUE plus a non-empty amenity_fee_schedule = bookable.';
COMMENT ON TABLE amenity_fee_schedule IS
  'Per-fee-item config: amount, refundability, required-vs-optional, payee. Payee column is load-bearing — it determines whether the fee routes to the HOA''s connected Stripe account or to Bedrock''s platform account at charge time. Anti-commingling.';
COMMENT ON TABLE amenity_rentals IS
  'Booking record. intake_method tracks online-vs-paper origin (tech-optional rule). agreement_paper_pdf_path holds scanned signed paper contracts so staff-recorded rentals carry the same evidence as inline-checkbox online ones.';
COMMENT ON TABLE payments IS
  'Universal Stripe ledger. Every fee item on every product writes here. payee + connected_account_id distinguishes HOA-portion (settled to HOA bank via Stripe Connect) from platform-portion (settled to Bedrock). Webhook fires status transitions.';

COMMIT;

-- ============================================================================
-- VERIFY (after migration):
--   SELECT count(*) FROM amenities;          -- 0
--   SELECT count(*) FROM amenity_rentals;    -- 0
--   SELECT count(*) FROM payments;           -- 0
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='communities' AND column_name LIKE 'stripe%';
--   -- Should return: stripe_connected_account_id, stripe_onboarding_status, stripe_onboarded_at
-- ============================================================================
