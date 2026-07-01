-- ============================================================================
-- 254_insurance_policy_of_record.sql  (Ed 2026-07-01)
-- ----------------------------------------------------------------------------
-- The community's IN-FORCE insurance program of record — the SINGLE SOURCE OF
-- TRUTH for "what coverage does this association currently carry." The existing
-- insurance module (insurance_comparisons / insurance_quotes) handles INCOMING
-- renewal QUOTES for board comparison; it does NOT hold the current bound
-- program. This adds that: what the RFP is generated FROM and what quotes get
-- compared AGAINST. "The system maintains all of the information for the
-- association" (Ed).
--
--   insurance_programs   one row per policy term (renews annually). The program
--                        of record: entity, statement of values, notes, source
--                        policy PDFs. association_record (the HOA's own record).
--   insurance_policies   one row per coverage LINE in a program (Property, GL,
--                        D&O, Umbrella, Crime, ...). Limits/deductibles/terms as
--                        JSONB (varies by line). Links to the source PDF in
--                        library_documents.
--
-- Record ownership: association_record. The extracted structured JSON is a
-- byproduct workpaper, but the coverage FACTS + the source policy PDFs are the
-- association's records (handed over on termination).
--
-- Grants included (scar: new tables the API writes to need explicit
-- service_role grants). category on library_documents is free-text since
-- migration 124, so uploaded policies file under category='insurance_policy'.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS insurance_programs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'expired', 'draft', 'superseded')),
  policy_period_start  date,
  policy_period_end    date,
  named_insured        text,
  association_type     text,
  units_or_lots        integer,
  property_location    text,
  mailing_address      text,
  total_premium_cents  bigint,
  entity               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- full extracted entity block
  statement_of_values  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{description,value,construction,year_built,square_feet}]
  notes                jsonb NOT NULL DEFAULT '[]'::jsonb,   -- curated underwriting notes
  source_document_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- library_documents ids of the source policy PDFs
  source               text NOT NULL DEFAULT 'extracted'
                         CHECK (source IN ('extracted', 'manual')),
  record_ownership     text NOT NULL DEFAULT 'association_record',
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insurance_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id           uuid NOT NULL REFERENCES insurance_programs(id) ON DELETE CASCADE,
  community_id         uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  coverage_line        text NOT NULL,          -- 'Property','General Liability','Directors & Officers',...
  carrier              text,
  policy_number        text,
  effective_date       date,
  expiration_date      date,
  annual_premium_cents bigint,
  limits               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label,amount}]
  deductibles          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label,amount}]
  key_terms            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["Replacement Cost", ...]
  source_document_id   uuid REFERENCES library_documents(id) ON DELETE SET NULL,
  sort_order           integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_programs_community ON insurance_programs(community_id);
CREATE INDEX IF NOT EXISTS idx_insurance_programs_active    ON insurance_programs(community_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_insurance_policies_program   ON insurance_policies(program_id);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_community ON insurance_policies(community_id);

-- updated_at maintenance (existing helper)
DROP TRIGGER IF EXISTS trg_insurance_programs_updated ON insurance_programs;
CREATE TRIGGER trg_insurance_programs_updated BEFORE UPDATE ON insurance_programs
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_insurance_policies_updated ON insurance_policies;
CREATE TRIGGER trg_insurance_policies_updated BEFORE UPDATE ON insurance_policies
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Grants (scar: new tables need explicit service_role grants; API writes here)
GRANT SELECT, INSERT, UPDATE, DELETE ON insurance_programs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON insurance_policies TO service_role;
GRANT SELECT ON insurance_programs TO authenticated;
GRANT SELECT ON insurance_policies TO authenticated;

COMMIT;
