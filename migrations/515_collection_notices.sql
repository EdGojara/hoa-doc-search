-- ============================================================================
-- 515_collection_notices.sql  (Ed 2026-10-12)
-- ----------------------------------------------------------------------------
-- Certified collections notices (Tex. Prop. Code 209.0064), inside Receivables.
-- Amanda prepares batches, Kat verifies the money, an authorized staff user
-- approves, the office prints and mails, staff record the USPS tracking numbers.
--
-- Reuses what exists; builds no parallel ledger or mail system:
--   * balances / statements   homeowner_transactions via the current-owner views
--                             and lib/statements/assessment_statement.js
--   * eligibility             community_billing_policies (certified_209_notice_days),
--                             payment_plans, ar_account_collections,
--                             property_enforcement_states, the AR aging computation
--   * fees                    communities.certified_collection_fee_cents (owner-
--                             recoverable, mig 394), contract_owner_charges (Bedrock's
--                             contract rate), ar_charge_types 'certified_collection'
--                             (GL mapping, mig 394), billing_pending_items (Bedrock
--                             billing staging, mig 296)
--   * GL                      postJournalEntry; immutable PDFs in storage
--
-- Record ownership:
--   collection_notice_templates  mixed: the issued wording is association_record;
--                                drafting history / counsel questions are workpaper
--   collection_notice_batches    workpaper (Bedrock production process)
--   collection_notices           association_record (the issued notice, its statement
--                                snapshot, PDF and mailing evidence)
-- Nothing existing changes except: billing_pending_items.source gains
-- 'collection_notice', and communities gains collection_fee_autopost (default OFF:
-- no homeowner fee is charged until the owner turns it on per community).
-- ============================================================================
BEGIN;

ALTER TABLE communities ADD COLUMN IF NOT EXISTS collection_fee_autopost boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN communities.collection_fee_autopost IS 'When true AND certified_collection_fee_cents > 0, a collections certified notice carries the homeowner fee on its statement and the fee posts (Dr AR / Cr the certified_collection charge type account) when the notice is confirmed mailed. Default off. (mig 515)';

-- ---------------------------------------------------------------------------
-- 1) Templates (the wording is the association's; counsel questions travel with it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_notice_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  name                text NOT NULL,
  subject_line        text NOT NULL DEFAULT 'PAST DUE ASSESSMENTS',
  paragraphs          jsonb NOT NULL,              -- ordered text paragraphs with {{merge_fields}}
  required_elements   jsonb NOT NULL,              -- [{label, pattern}] the rendered letter must contain
  cure_days           integer NOT NULL DEFAULT 45 CHECK (cure_days >= 45),   -- 209.0064(b)(3): at least 45 days
  include_office_copy boolean NOT NULL DEFAULT true,
  min_balance_cents   bigint NOT NULL DEFAULT 0 CHECK (min_balance_cents >= 0),
  recent_payment_days integer NOT NULL DEFAULT 10 CHECK (recent_payment_days >= 0),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  counsel_status      text NOT NULL DEFAULT 'questions_open' CHECK (counsel_status IN ('questions_open', 'counsel_approved')),
  counsel_questions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_note         text,
  approved_by         text,
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  record_ownership    text NOT NULL DEFAULT 'mixed' CHECK (record_ownership = 'mixed'),
  UNIQUE (community_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_template_approved ON collection_notice_templates (community_id) WHERE status = 'approved';

-- ---------------------------------------------------------------------------
-- 2) Batches and notices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_notice_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  status           text NOT NULL DEFAULT 'prepared'
                   CHECK (status IN ('prepared', 'verified', 'verification_failed', 'approved', 'printed', 'mailed', 'cancelled')),
  notice_date      date NOT NULL,                  -- the date on the letters = the mailing date
  template_id      uuid NOT NULL REFERENCES collection_notice_templates(id) ON DELETE RESTRICT,
  prepared_by      text NOT NULL,
  prepared_at      timestamptz NOT NULL DEFAULT now(),
  verification     jsonb,
  verified_by      text,
  verified_at      timestamptz,
  approved_by      text,
  approved_at      timestamptz,
  printed_by       text,
  printed_at       timestamptz,
  batch_pdf_path   text,
  batch_pdf_sha256 text,
  cancelled_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  record_ownership text NOT NULL DEFAULT 'workpaper' CHECK (record_ownership = 'workpaper')
);
CREATE INDEX IF NOT EXISTS idx_collection_batches_status ON collection_notice_batches (community_id, status);

CREATE TABLE IF NOT EXISTS collection_notices (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                    uuid NOT NULL REFERENCES collection_notice_batches(id) ON DELETE RESTRICT,
  community_id                uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id                 uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenure_id                   uuid NOT NULL REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  status                      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'printed', 'mailed', 'cancelled')),
  notice_date                 date NOT NULL,
  deadline_date               date NOT NULL,
  cure_days                   integer NOT NULL CHECK (cure_days >= 45),
  account_number              text,
  owner_name                  text,
  mailing_address             jsonb,
  ledger_balance_cents        bigint NOT NULL,     -- the homeowner ledger at the snapshot
  fee_cents                   bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),   -- homeowner certified-letter fee on THIS notice (posts on mailing)
  amount_due_cents            bigint NOT NULL,     -- ledger + fee = the notice amount = the statement total
  bedrock_fee_cents           bigint,              -- Bedrock's contract rate billed to the association (may differ from fee_cents)
  statement_snapshot          jsonb NOT NULL,
  snapshot_sha256             text NOT NULL,
  snapshot_as_of              timestamptz NOT NULL,
  eligibility                 jsonb,
  template_id                 uuid NOT NULL REFERENCES collection_notice_templates(id) ON DELETE RESTRICT,
  template_version            integer NOT NULL,
  pdf_path                    text,
  pdf_sha256                  text,
  certified_tracking_number   text,
  regular_mail_confirmed      boolean NOT NULL DEFAULT false,
  mailed_date                 date,
  mailed_by                   text,
  mailed_recorded_at          timestamptz,
  fee_homeowner_txn_id        uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  fee_journal_entry_id        uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  bedrock_billing_item_id     uuid REFERENCES billing_pending_items(id) ON DELETE RESTRICT,
  cancelled_reason            text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  record_ownership            text NOT NULL DEFAULT 'association_record' CHECK (record_ownership = 'association_record'),
  CHECK (amount_due_cents = ledger_balance_cents + fee_cents),
  CHECK (deadline_date >= notice_date + cure_days),
  CHECK (status <> 'mailed' OR (certified_tracking_number IS NOT NULL AND mailed_date IS NOT NULL AND mailed_date = notice_date))
);
-- One open notice per account; a tracking number is used once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_notice_open ON collection_notices (community_id, property_id) WHERE status IN ('draft', 'approved', 'printed');
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_notice_tracking ON collection_notices (certified_tracking_number) WHERE certified_tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collection_notices_property ON collection_notices (property_id, notice_date DESC);
CREATE INDEX IF NOT EXISTS idx_collection_notices_batch ON collection_notices (batch_id);

-- Fee idempotency: one homeowner fee row, one GL entry and one Bedrock billing item per notice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_collection_notice_fee
  ON homeowner_transactions ((raw_row_jsonb->>'collection_notice_id')) WHERE raw_row_jsonb->>'source' = 'collection_notice_fee';
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_collection_notice ON journal_entries (community_id, source_reference) WHERE source_reference LIKE 'collnotice:%';
ALTER TABLE billing_pending_items DROP CONSTRAINT IF EXISTS billing_pending_items_source_check;
ALTER TABLE billing_pending_items ADD CONSTRAINT billing_pending_items_source_check CHECK (source IN ('manual', 'email', 'collection_notice'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_pending_collection_notice ON billing_pending_items (source_ref) WHERE source = 'collection_notice';

ALTER TABLE collection_notice_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_notice_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON collection_notice_templates, collection_notice_batches, collection_notices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON collection_notice_templates, collection_notice_batches, collection_notices TO service_role;

-- ---------------------------------------------------------------------------
-- 3) Seed: each association's CURRENT in-use wording (the Vantaca certified
--    collections packet), as a DRAFT with the counsel questions attached. Nothing
--    can be approved for mailing until the owner approves a template.
-- ---------------------------------------------------------------------------
INSERT INTO collection_notice_templates (community_id, version, name, paragraphs, required_elements, counsel_questions, source_note)
SELECT c.id, 1, 'Certified delinquency notice (current wording)',
  jsonb_build_array(
    'PLEASE REMIT THE AMOUNT INDICATED ABOVE OR EVIDENCE THAT THE SAME HAS BEEN PAID BY: {{deadline_date}}',
    'Dear Owner(s):',
    '{{association_name}} is writing to you to notify you of the past due balance on the assessment account for your property. Please see enclosed an account statement specifying each delinquent amount and the total amount of the payment required to make the account current.',
    'If the delinquent balance described herein is not paid within {{cure_days_words}} ({{cure_days}}) days, the Association intends to turn this matter over to an attorney for further handling. If this becomes necessary, you will be responsible for the reasonable attorneys'' fees and other reasonable costs incurred, and such fees and costs will be charged to your assessment account. If you are unable to pay the full balance by the date on this notice, you have the right to request a payment plan. You must mail your payment to: {{payment_address}}. Please make checks payable to "{{payable_to}}".',
    'Pursuant to Sec. 209.007 of the Texas Property Code, before the Association renders a decision regarding suspension of your amenity access and use of the common areas in connection with your failure to timely pay assessments, you have the right to request a hearing before the Board of Directors regarding this matter. If you desire a hearing, written notice of your request must be received at the address set forth herein within {{cure_days_words}} ({{cure_days}}) days from your receipt of this letter. Upon receipt of your written request, notice of the date, time, and location of the hearing will be forwarded to you. Please note that if you do not pay the delinquent balance in full, enter into a payment plan agreement, or request a hearing in writing within {{cure_days_words}} ({{cure_days}}) days from the date this notice was mailed, the Association intends thereafter to pursue its legal remedies regarding this matter.',
    'Please be advised that, if you do not timely pay the delinquent balance, you will be responsible for all reasonable attorney''s fees and reasonable costs incurred by the Association, and such fees and costs will be charged to your assessment account. These fees can represent a substantial expense.',
    'Please be advised that you may have special rights or relief related to this action under federal law, including the Servicemembers Civil Relief Act (50 U.S.C. app. Section 501 et seq.), if the owner is serving on active military duty.',
    'Thank you for your cooperation in this matter. Please contact the Association at {{phone}} if you have any questions.'
  ),
  jsonb_build_array(
    jsonb_build_object('label', 'Amount due', 'pattern', '\$[0-9,]+\.[0-9]{2}'),
    jsonb_build_object('label', 'Deadline date', 'pattern', 'BY: [A-Z][a-z]+ [0-9]{1,2}, [0-9]{4}'),
    jsonb_build_object('label', 'Each delinquent amount / total to make current (209.0064(b)(1))', 'pattern', 'each delinquent amount and the total amount'),
    jsonb_build_object('label', 'Payment plan availability (209.0064(b)(2))', 'pattern', 'payment plan'),
    jsonb_build_object('label', 'Cure period of at least 45 days (209.0064(b)(3))', 'pattern', '\([0-9]+\) days'),
    jsonb_build_object('label', 'Attorney fees and costs warning', 'pattern', 'attorney'),
    jsonb_build_object('label', 'Servicemembers Civil Relief Act notice', 'pattern', 'Servicemembers Civil Relief Act')
  ),
  jsonb_build_array(
    'Hearing window: one sentence runs the 45 days from the owner''s RECEIPT of the letter, the next from the date the notice was MAILED. Which governs?',
    '209.0064(b)(2) requires a description of the options to avoid referral, including the availability of a payment plan. Is "you have the right to request a payment plan" sufficient, and should owners who defaulted on a plan in the last two years (209.0062(c)) receive different wording?',
    '209.0064(b)(1): the letter relies on the enclosed account statement for each delinquent amount and the total. Confirm the enclosure satisfies the requirement.',
    'The statement includes the certified-letter fee for this notice. Confirm the association may charge it on the same notice.',
    'This letter is also the 209.006 notice before amenity suspension. Confirm the combined notice meets 209.006 for suspension.'
  ),
  'Seeded verbatim from the certified collections packet Bedrock currently prints from Vantaca (Quail Ridge example, October 2026), with merge fields for the association, amount, dates, payment address and phone. Not new legal language. The Vantaca example''s deadline year error (10/16/2025 on an October 5, 2026 notice) is prevented by computing every date from the notice date.'
FROM communities c
WHERE NOT EXISTS (SELECT 1 FROM collection_notice_templates x WHERE x.community_id = c.id);

COMMIT;
