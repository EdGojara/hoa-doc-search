-- ============================================================================
-- 542_positive_pay_submissions.sql  (Ed 2026-10-22)
-- ----------------------------------------------------------------------------
-- Positive Pay submission tracking. Until now trustEd could build NewFirst's
-- issued-check file but kept no record of what was sent, so every check we cut
-- reached NewFirst as an exception (9/23 through 10/22/2026) and nothing could
-- say which checks had been submitted, accepted or rejected.
--
-- 1) bank_accounts.positive_pay_enabled
--    Only accounts on the bank's Positive Pay Addendum go in the file. The four
--    NewFirst operating accounts on the Addendum (Kat to Melody Hess, 2026-09-08;
--    Melody confirmed 2026-09-09) are enabled here.
--    The first issue date the file covers is ONE cutoff for the bank, kept in the
--    existing banks.positive_pay_settings (export_from), set once after the
--    historical checks are resolved with NewFirst. Until it is set nothing exports,
--    and checks issued before it are never exported by trustEd.
--
-- 2) positive_pay_submissions: one row per file prepared for a bank. Status:
--      prepared            file built; NOT sent, NOT accepted
--      uploaded            Kat (or a person) uploaded it; still NOT accepted
--      accepted            the bank confirmed every row (confirmation recorded)
--      partially_accepted  the bank confirmed some rows (confirmation recorded)
--      rejected            the bank rejected the file (confirmation recorded)
--      cancelled           never uploaded; its checks are free again
--    Building or downloading a file never sets uploaded or accepted.
--
-- 3) positive_pay_submission_items: one row per check per submission. A check
--    is in at most ONE live submission (included or accepted), enforced by a
--    partial unique index, so it cannot be sent twice. A rejected or released
--    row frees the check for the next file.
--
-- Record ownership: workpaper (Bedrock's bank-control log across associations);
-- every item carries community_id so a community's rows export with its books.
-- Account numbers are never stored here: the file is rebuilt from the items and
-- the encrypted account number, and must reproduce the recorded SHA-256.
-- ============================================================================
BEGIN;

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN bank_accounts.positive_pay_enabled IS 'On the bank''s Positive Pay Addendum: checks drawn on it belong in the issued-check file. Read by lib/accounting/positive_pay_submissions.js.';

-- The four NewFirst operating accounts on the Addendum.
UPDATE bank_accounts SET positive_pay_enabled = true
 WHERE bank_id = '16e07b6a-8902-4d1a-980e-db78938b98b3'
   AND id IN ('2dd4bf0b-0e71-4da0-b8a7-269845ddf54c',   -- Canyon Gate Operating Checking (5313)
              '52cf2b77-4277-4b11-9e3f-60177f419f5f',   -- Still Creek Operating Checking (1777)
              '13d7c91d-955c-43a1-bee6-a77c8b5a84de',   -- LOPF Operating Checking (2449)
              '829b287e-3d9f-4a4e-9eab-4ba437a329be')   -- Waterview Operating Checking (5961)
   AND positive_pay_enabled = false;

CREATE TABLE IF NOT EXISTS positive_pay_submissions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id                     uuid NOT NULL REFERENCES banks(id) ON DELETE RESTRICT,
  status                      text NOT NULL DEFAULT 'prepared'
                                CHECK (status IN ('prepared', 'uploaded', 'accepted', 'partially_accepted', 'rejected', 'cancelled')),
  file_name                   text NOT NULL,
  file_sha256                 text NOT NULL,
  check_count                 integer NOT NULL CHECK (check_count > 0),
  total_cents                 bigint NOT NULL CHECK (total_cents > 0),
  prepared_by                 text NOT NULL,              -- 'kat' or the person's name
  prepared_by_user_id         uuid,
  prepared_at                 timestamptz NOT NULL DEFAULT now(),
  uploaded_at                 timestamptz,
  uploaded_by_user_id         uuid,
  uploaded_by_name            text,
  outcome_recorded_at         timestamptz,
  outcome_recorded_by_user_id uuid,                       -- null when Kat recorded it
  outcome_recorded_by_name    text,
  bank_reference              text,                       -- the bank's import / confirmation id, when it gives one
  outcome_evidence            text,                       -- what the person saw (import summary, receipt, email)
  cancelled_reason            text,
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('accepted', 'partially_accepted', 'rejected') OR (outcome_recorded_at IS NOT NULL AND length(trim(coalesce(outcome_recorded_by_name, ''))) > 0 AND length(trim(coalesce(outcome_evidence, ''))) > 0)),
  CHECK (status <> 'cancelled' OR length(trim(coalesce(cancelled_reason, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS idx_pp_submissions_bank_status ON positive_pay_submissions (bank_id, status, prepared_at DESC);

CREATE TABLE IF NOT EXISTS positive_pay_submission_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      uuid NOT NULL REFERENCES positive_pay_submissions(id) ON DELETE RESTRICT,
  check_register_id  uuid NOT NULL REFERENCES check_register(id) ON DELETE RESTRICT,
  community_id       uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  bank_account_id    uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  check_number       text NOT NULL,
  issue_date         date NOT NULL,
  payee_sent         text NOT NULL,                       -- exactly as written to the file
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  row_number         integer NOT NULL CHECK (row_number > 0),
  status             text NOT NULL DEFAULT 'included'
                       CHECK (status IN ('included', 'accepted', 'rejected', 'released')),
  rejection_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, check_register_id),
  UNIQUE (submission_id, row_number),
  CHECK (status <> 'rejected' OR length(trim(coalesce(rejection_reason, ''))) > 0)
);
-- Duplicate-submission guard: one live submission per check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pp_items_one_live_per_check
  ON positive_pay_submission_items (check_register_id) WHERE status IN ('included', 'accepted');
CREATE INDEX IF NOT EXISTS idx_pp_items_submission ON positive_pay_submission_items (submission_id);
CREATE INDEX IF NOT EXISTS idx_pp_items_account_check ON positive_pay_submission_items (bank_account_id, check_number);

DROP TRIGGER IF EXISTS trg_pp_submissions_updated_at ON positive_pay_submissions;
CREATE TRIGGER trg_pp_submissions_updated_at BEFORE UPDATE ON positive_pay_submissions FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_pp_items_updated_at ON positive_pay_submission_items;
CREATE TRIGGER trg_pp_items_updated_at BEFORE UPDATE ON positive_pay_submission_items FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE ON positive_pay_submissions TO service_role;
GRANT SELECT, INSERT, UPDATE ON positive_pay_submission_items TO service_role;

COMMIT;
