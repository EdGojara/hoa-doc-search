-- 173: Banks master table — management-company-level bank registry
--
-- WHY (per Ed 2026-06-06):
-- Bank-level info (name, routing#, address, contact) is shared across
-- every account a manager holds at that bank. Today bank_accounts
-- carries a denormalized bank_name text field — fine at 7 communities,
-- waste at franchise scale, and forces re-typing routing numbers when
-- a bank changes their wire routing.
--
-- Bedrock's actual bank inventory:
--   - First Citizens Bank (ABA 104002894) — used by Quail Ridge
--   - NewFirst National Bank (ABA 113104796) — August Meadows once set up
--   - Columbia Bank — phasing out; accounts transitioning to NewFirst
--
-- ARCHITECTURE:
--   banks (mgmt-co level, shared across communities)
--     ↓ FK
--   bank_accounts (per-community, links to bank via bank_id)
--
-- RECORD OWNERSHIP: workpaper. Banking relationships are Bedrock's
-- operational config, not an association_record. The downstream
-- bank_statement_imports + reconciliations remain association_record.

BEGIN;

CREATE TABLE IF NOT EXISTS banks (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,

  -- Address (printed on check face)
  address_line1            TEXT,
  address_line2            TEXT,
  city                     TEXT,
  state                    TEXT,
  postal_code              TEXT,

  -- Routing numbers
  -- aba_check: routing used for paper check MICR encoding
  -- aba_deposit: routing for incoming wires / ACH (some banks publish a
  --   different one). Usually same as aba_check; differs at a minority
  --   of banks.
  aba_check                TEXT,
  aba_deposit              TEXT,

  branch                   TEXT,
  beneficiary_name         TEXT,                      -- for FBO custodial arrangements

  -- Operational contact
  contact_name             TEXT,
  contact_phone            TEXT,
  contact_email            TEXT,

  -- Workflow state
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  -- When is_active=false because we're transitioning out (vs. closed):
  transition_status        TEXT
                             CHECK (transition_status IS NULL OR transition_status IN (
                               'active', 'transitioning_out', 'closed'
                             )),
  transition_notes         TEXT,

  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (management_company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_banks_mgmt_co_active
  ON banks (management_company_id, name) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_banks_updated_at ON banks;
CREATE TRIGGER trg_banks_updated_at
  BEFORE UPDATE ON banks
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- Add bank_id FK to existing bank_accounts (created in migration 169).
-- Existing bank_name text field stays for now (back-compat during transition).
-- ---------------------------------------------------------------------------
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS bank_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_accounts_bank_fk'
  ) THEN
    ALTER TABLE bank_accounts
      ADD CONSTRAINT bank_accounts_bank_fk
      FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_bank_accounts_bank
  ON bank_accounts (bank_id) WHERE bank_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Seed Bedrock's three banks (Ed 2026-06-06).
-- Uses ON CONFLICT (mgmt_co, name) so re-running is safe.
-- ---------------------------------------------------------------------------
INSERT INTO banks (
  management_company_id, name, aba_check, aba_deposit,
  is_active, transition_status, notes
) VALUES
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'First Citizens Bank',
    '104002894', '104002894',
    TRUE, 'active',
    'Routing per Vantaca bank record. Quail Ridge primary banking relationship.'
  ),
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'NewFirst National Bank',
    '113104796', '113104796',
    TRUE, 'active',
    'Routing per Vantaca bank record. August Meadows once accounts are set up.'
  ),
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'Columbia Bank',
    NULL, NULL,
    TRUE, 'transitioning_out',
    'Phasing out. Existing community accounts migrating to NewFirst National Bank.'
  )
ON CONFLICT (management_company_id, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill bank_id on existing bank_accounts where bank_name matches.
-- Case-insensitive substring match handles variants like 'First Citizens'
-- vs 'First Citizens Bank'.
-- ---------------------------------------------------------------------------
UPDATE bank_accounts ba
SET bank_id = b.id
FROM banks b
WHERE ba.bank_id IS NULL
  AND ba.bank_name IS NOT NULL
  AND ba.management_company_id = b.management_company_id
  AND (
    LOWER(TRIM(ba.bank_name)) = LOWER(b.name)
    OR LOWER(b.name) LIKE LOWER(TRIM(ba.bank_name)) || '%'
    OR LOWER(TRIM(ba.bank_name)) LIKE LOWER(b.name) || '%'
  );

COMMIT;
