-- 176: Check printing substrate — bank_accounts check config + check_register
--
-- Per Ed 2026-06-06: "i want ability to print checks in trustEd"
-- Per Ed's First Citizens Bank statement screenshot for Quail Ridge
-- Operating account (ending 4536), last issued check was #28 on May 22, 2026.
-- Seeding next_check_number=29 so the sequencer continues cleanly from
-- Vantaca-issued check numbering — NO GAP in the audit sequence.
--
-- ARCHITECTURE:
--   bank_accounts (existing, mig 169 + check fields added here)
--     → check_register (NEW — one row per check ever printed)
--       → ap_payments (existing, mig 175) — the JE link
--
-- WHY APPEND-ONLY check_register:
-- Gaps in check# sequence are a fraud red flag at audit. Even voided
-- checks STAY in the register with status='voided' + reason. The
-- physical paper voucher gets retained per state law (TX = 3 years
-- before escheatment); the system mirrors that retention indefinitely.
--
-- IDEMPOTENT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Extend bank_accounts with check-printing config
-- ---------------------------------------------------------------------------
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS next_check_number INTEGER NOT NULL DEFAULT 1000;

-- check stock format: where on the 8.5x11 page the check sits
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS check_stock_format TEXT
  CHECK (check_stock_format IS NULL OR check_stock_format IN (
    'std_top',          -- check on top half, stub on bottom (most common HOA)
    'std_middle',       -- check in middle
    'std_bottom',       -- check at bottom, stubs above (Vantaca default per Ed)
    'voucher_top',      -- check on top, 2 voucher copies below
    'three_per_page'    -- 3 checks per page (lighter-duty)
  )) DEFAULT 'std_top';

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS check_stock_vendor TEXT;        -- 'deluxe', 'harland', 'costco', 'other'
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS check_stock_micr_pre_encoded BOOLEAN NOT NULL DEFAULT TRUE;
-- pre_encoded=true means we order MICR-encoded stock from a vendor (path A,
-- recommended); false means we render MICR ourselves (path B, requires
-- MICR toner cartridge and dedicated printer).

-- Approval / signing
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS dual_sig_threshold_cents BIGINT;
-- null = no dual-sig requirement; integer = checks at-or-above this amount
-- require two signatures (currently single-approver-Ed for everything, so null).

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS signature_image_path TEXT;       -- primary signer
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS signature_image_path_secondary TEXT;  -- secondary signer (for dual-sig)

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS authorized_signers JSONB NOT NULL DEFAULT '[]'::jsonb;
-- [{name: "Ed Gojara", title: "Property Manager", image_path: "...", is_active: true}, ...]

-- Account number — full account # for MICR encoding when pre_encoded=false,
-- and for positive-pay file generation. Stored encrypted at app layer; this
-- column holds the base64 ciphertext. account_last4 stays as before for
-- display/audit (already on the table).
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number_encrypted TEXT;

-- Positive pay
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_format TEXT
  CHECK (positive_pay_format IS NULL OR positive_pay_format IN (
    'csv_standard', 'bai2', 'nacha', 'first_citizens', 'newfirst', 'columbia',
    'boa_cashpro', 'chase', 'wells_fargo', 'custom'
  ));
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_submission_method TEXT
  CHECK (positive_pay_submission_method IS NULL OR positive_pay_submission_method IN (
    'sftp', 'portal_upload', 'email', 'api', 'manual'
  ));
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_credentials_ref TEXT;  -- key into secret store (not raw creds)

-- Statement format hint — used by bank statement extractor for bank-specific
-- pattern recognition (VANTACA PAYOUT etc.). Phase 2 enhancement.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS statement_format_hint TEXT;

-- ---------------------------------------------------------------------------
-- 2) check_register — append-only check disbursement log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS check_register (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                    UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  bank_account_id                 UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,

  check_number                    TEXT NOT NULL,
  issue_date                      DATE NOT NULL,
  payee_name                      TEXT NOT NULL,                  -- name as printed on the check face
  amount_cents                    BIGINT NOT NULL CHECK (amount_cents > 0),
  amount_in_words                 TEXT NOT NULL,                  -- legal line ("Four Hundred Seventy-Six and 30/100")
  memo                            TEXT,

  -- Status lifecycle
  status                          TEXT NOT NULL DEFAULT 'issued'
                                    CHECK (status IN (
                                      'issued',         -- printed, mailed; bank may or may not have seen it
                                      'outstanding',    -- alias for issued (some users prefer the term)
                                      'cleared',        -- bank statement shows it cleared
                                      'voided',         -- voided before clearing — paper retained physically
                                      'stop_payment',   -- stop payment issued at bank
                                      'stale'           -- 180+ days outstanding (state-specific stale-date)
                                    )),

  -- Void handling — append-only; never DELETE
  voided_at                       TIMESTAMPTZ,
  voided_by_user_id               UUID,
  voided_reason                   TEXT,

  -- Clearance tracking
  cleared_date                    DATE,                            -- when bank rec saw it clear
  cleared_via_bank_statement_id   UUID REFERENCES bank_statement_imports(id) ON DELETE SET NULL,
  stop_payment_at                 TIMESTAMPTZ,
  stop_payment_reason             TEXT,

  -- Linkages
  ap_payment_id                   UUID REFERENCES ap_payments(id) ON DELETE SET NULL,
  posting_journal_entry_id        UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  bank_reconciliation_id          UUID REFERENCES bank_reconciliations(id) ON DELETE SET NULL,

  -- Source artifacts
  check_pdf_storage_path          TEXT,                            -- the rendered check PDF
  print_run_id                    UUID,                            -- groups all checks in a single print run

  printed_at                      TIMESTAMPTZ,
  printed_by_user_id              UUID,
  reprinted_count                 INTEGER NOT NULL DEFAULT 0,      -- track reprints (each reprint = void of original + new check#)

  notes                           TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Critical uniqueness — no two checks can share a (bank_account, check#) pair.
  -- This is the audit-grade no-gap discipline. Even voids stay in the register
  -- with their original number; they just have status='voided'.
  UNIQUE (bank_account_id, check_number)
);

CREATE INDEX IF NOT EXISTS idx_check_register_account_status
  ON check_register (bank_account_id, status, issue_date DESC);

CREATE INDEX IF NOT EXISTS idx_check_register_outstanding
  ON check_register (bank_account_id, issue_date)
  WHERE status IN ('issued', 'outstanding');

CREATE INDEX IF NOT EXISTS idx_check_register_ap_payment
  ON check_register (ap_payment_id) WHERE ap_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_check_register_print_run
  ON check_register (print_run_id) WHERE print_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_check_register_updated_at ON check_register;
CREATE TRIGGER trg_check_register_updated_at
  BEFORE UPDATE ON check_register
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) Race-safe check number sequencer function
-- ---------------------------------------------------------------------------
-- Atomically reserves the next check number for a bank account. Used by
-- the check printer engine right before rendering. Increments
-- bank_accounts.next_check_number under SELECT ... FOR UPDATE so two
-- concurrent print runs don't grab the same number.
CREATE OR REPLACE FUNCTION reserve_next_check_number(p_bank_account_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_check_number INTEGER;
BEGIN
  -- Lock the row, read, increment, return the OLD value (what we reserved)
  UPDATE bank_accounts
  SET next_check_number = next_check_number + 1
  WHERE id = p_bank_account_id
  RETURNING next_check_number - 1 INTO v_check_number;

  IF v_check_number IS NULL THEN
    RAISE EXCEPTION 'bank_account_not_found: %', p_bank_account_id;
  END IF;

  RETURN v_check_number;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 4) Seed Quail Ridge Operating bank account
-- ---------------------------------------------------------------------------
-- Per Ed's First Citizens statement screenshot:
--   - Account: CAB Interest Checking ending in 4536
--   - Account holder: BEDROCK ASSOC MGMT LLC AGENT / QUAIL RIDGE HOA INC
--   - Last issued check #28 cleared May 22, 2026 → next check = #29
-- We seed the account row if it doesn't already exist (idempotent guard).
DO $$
DECLARE
  v_qr_community_id UUID;
  v_first_citizens_bank_id UUID;
  v_existing UUID;
BEGIN
  SELECT id INTO v_qr_community_id FROM communities WHERE name ILIKE 'quail%ridge%' LIMIT 1;
  SELECT id INTO v_first_citizens_bank_id FROM banks
    WHERE management_company_id = '00000000-0000-0000-0000-000000000001'::uuid
      AND name = 'First Citizens Bank'
    LIMIT 1;

  IF v_qr_community_id IS NULL THEN
    RAISE NOTICE '[176] Quail Ridge community not found — skipping bank_account seed';
    RETURN;
  END IF;
  IF v_first_citizens_bank_id IS NULL THEN
    RAISE NOTICE '[176] First Citizens Bank not found in banks table — run migration 173 first';
    RETURN;
  END IF;

  -- Check if account already exists (by community + last4)
  SELECT id INTO v_existing FROM bank_accounts
    WHERE community_id = v_qr_community_id AND account_last4 = '4536' LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Already exists — just ensure check config is set
    UPDATE bank_accounts SET
      bank_id = COALESCE(bank_id, v_first_citizens_bank_id),
      next_check_number = GREATEST(COALESCE(next_check_number, 29), 29),
      check_stock_format = COALESCE(check_stock_format, 'std_top'),
      check_stock_micr_pre_encoded = COALESCE(check_stock_micr_pre_encoded, TRUE),
      statement_format_hint = COALESCE(statement_format_hint, 'first_citizens')
    WHERE id = v_existing;
    RAISE NOTICE '[176] Quail Ridge Operating already exists — check config patched';
  ELSE
    INSERT INTO bank_accounts (
      management_company_id, community_id, bank_id,
      account_nickname, bank_name, account_last4,
      account_type, gl_account_number, is_active,
      next_check_number, check_stock_format, check_stock_micr_pre_encoded,
      statement_format_hint,
      notes
    ) VALUES (
      '00000000-0000-0000-0000-000000000001'::uuid,
      v_qr_community_id, v_first_citizens_bank_id,
      'Quail Ridge Operating', 'First Citizens Bank', '4536',
      'operating', '10100', TRUE,
      29,                         -- per Ed's statement: last issued #28
      'std_top', TRUE,
      'first_citizens',
      'CAB Interest Checking at First Citizens. 0.05% APY. Statement shows VANTACA PAYOUT entries (homeowner payments via Vantaca Pay settlement) — extract Vantaca Pay settlement report to attribute per-homeowner.'
    );
    RAISE NOTICE '[176] Quail Ridge Operating bank account seeded (next check #29)';
  END IF;
END$$;

COMMIT;
