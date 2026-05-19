-- Per-community letter fees + payment routing config.
-- ---------------------------------------------------------------------------
-- Different communities have different admin-fee schedules ($25 vs $35 letter
-- fees, etc.) and different payment routing (some use a master payment URL,
-- some have their own; the check-payee name is the legal HOA name but mailing
-- addresses vary). This puts those values on the community row so the letter
-- generator reads them at render time.
--
-- Letter fees are SEPARATE from fines (community_category_fine_schedule in
-- Bundle 3). A certified §209 letter can carry a $35 admin fee + a $0 fine
-- (no fine assessed yet) OR a $35 admin fee + a $100 fine (when the violation
-- has already been certified and the cure window passed). The two values are
-- additive at the bundle level.
--
-- Stored as cents (integer) to avoid floating-point and to match the existing
-- fine_amount convention in community_category_fine_schedule.

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS letter_fee_courtesy_1_cents     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS letter_fee_courtesy_2_cents     INTEGER NOT NULL DEFAULT 2500,   -- $25 default
  ADD COLUMN IF NOT EXISTS letter_fee_certified_209_cents  INTEGER NOT NULL DEFAULT 3500,   -- $35 default
  ADD COLUMN IF NOT EXISTS letter_fee_fine_assessed_cents  INTEGER NOT NULL DEFAULT 0,      -- fine notice itself is free; the fine is the fine
  ADD COLUMN IF NOT EXISTS letter_payment_url              TEXT NULL,                       -- e.g. 'home.bedrocktx.com'
  ADD COLUMN IF NOT EXISTS letter_pay_to_name              TEXT NULL,                       -- check payee (defaults to legal_name)
  ADD COLUMN IF NOT EXISTS letter_pay_to_address           TEXT NULL,                       -- PO Box / street for checks
  ADD COLUMN IF NOT EXISTS letter_cure_days_courtesy_1     INTEGER NOT NULL DEFAULT 20,     -- Ed's spec: 20/20/30
  ADD COLUMN IF NOT EXISTS letter_cure_days_courtesy_2     INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS letter_cure_days_certified_209  INTEGER NOT NULL DEFAULT 30;     -- statute-anchored

-- letter_sender_name + letter_sender_title already exist from migration 056.
