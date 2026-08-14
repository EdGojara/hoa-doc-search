BEGIN;

-- ============================================================================
-- 365_owner_vault.sql  (Ed 2026-08-14)
-- ----------------------------------------------------------------------------
-- The OWNER'S PRIVATE multi-entity accounting vault. Bedrock (S-corp) + Ed's
-- other companies, reconstructed from bank/credit-card statements + QuickBooks
-- Payroll, for the audit and going forward.
--
-- ISOLATION (paramount): every table here is reachable ONLY through the
-- owner-gated /api/vault endpoints (requireOwner — Ed's login specifically, not
-- merely "an admin"). It is NEVER surfaced to staff, the portals, or any AI /
-- search index. No `authenticated` grant is issued — normal client roles must
-- not be able to read it at all.
--
-- Record ownership: OWNER-PRIVATE. Not an association_record, not a Bedrock
-- workpaper — Ed's personal/corporate books. Kept out of any termination export.
-- ============================================================================

-- The companies (Bedrock S-corp + the others).
CREATE TABLE IF NOT EXISTS vault_entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  entity_type     TEXT NOT NULL DEFAULT 's_corp'
                    CHECK (entity_type IN ('s_corp','c_corp','llc','partnership','sole_prop','individual')),
  ein             TEXT,
  fiscal_year_end TEXT NOT NULL DEFAULT '12-31',   -- MM-DD
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chart of accounts, per entity.
CREATE TABLE IF NOT EXISTS vault_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      UUID NOT NULL REFERENCES vault_entities(id) ON DELETE CASCADE,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  account_type   TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  normal_balance TEXT NOT NULL DEFAULT 'debit' CHECK (normal_balance IN ('debit','credit')),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_id, account_number)
);

-- The real-world money sources (bank + credit-card accounts), per entity.
CREATE TABLE IF NOT EXISTS vault_bank_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     UUID NOT NULL REFERENCES vault_entities(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'checking' CHECK (kind IN ('checking','savings','credit_card','loan','other')),
  institution   TEXT,
  last4         TEXT,
  gl_account_id UUID REFERENCES vault_accounts(id) ON DELETE SET NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Statement imports (a bank/CC statement PDF → extracted transactions).
CREATE TABLE IF NOT EXISTS vault_statement_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES vault_entities(id) ON DELETE CASCADE,
  bank_account_id UUID REFERENCES vault_bank_accounts(id) ON DELETE SET NULL,
  filename        TEXT,
  storage_path    TEXT,                          -- private owner-vault path
  period_start    DATE,
  period_end      DATE,
  opening_balance_cents BIGINT,
  closing_balance_cents BIGINT,
  extracted_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','extracted','reviewed','error')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The ledger. Cash-basis: each row is a money movement on a bank/CC account,
-- coded to a GL category account. amount_cents is SIGNED (negative = money out).
CREATE TABLE IF NOT EXISTS vault_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           UUID NOT NULL REFERENCES vault_entities(id) ON DELETE CASCADE,
  bank_account_id     UUID REFERENCES vault_bank_accounts(id) ON DELETE SET NULL,
  statement_import_id UUID REFERENCES vault_statement_imports(id) ON DELETE SET NULL,
  txn_date            DATE NOT NULL,
  description         TEXT,
  amount_cents        BIGINT NOT NULL,
  category_account_id UUID REFERENCES vault_accounts(id) ON DELETE SET NULL,
  memo                TEXT,
  source              TEXT NOT NULL DEFAULT 'bank' CHECK (source IN ('bank','credit_card','payroll','manual','transfer')),
  reconciled          BOOLEAN NOT NULL DEFAULT FALSE,
  needs_review        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vault_txn_entity_date ON vault_transactions(entity_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_vault_txn_category ON vault_transactions(category_account_id);

-- Access log — every entry to the vault, for hygiene + audit defensibility.
CREATE TABLE IF NOT EXISTS vault_access_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT,
  action     TEXT,
  detail     TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grants: service_role ONLY (the API uses the service key). Deliberately NO
-- `authenticated` grant — this data must be unreachable by normal client roles.
-- (Scar: new tables silently unwritable without an explicit service_role grant.)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  vault_entities, vault_accounts, vault_bank_accounts,
  vault_statement_imports, vault_transactions, vault_access_log
  TO service_role;

COMMIT;
