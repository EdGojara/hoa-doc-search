-- ============================================================================
-- 506_working_forecasts.sql  (Ed 2026-10-10, Financial Intelligence slice 1)
-- ----------------------------------------------------------------------------
-- Persistence for the NEXT-YEAR WORKING FORECAST (management forecast, not the
-- board budget). The model itself is computed deterministically from the books
-- and the approved base-year budget (lib/forecast/working_forecast.js) and is
-- never stored as truth; these tables keep only what PEOPLE decide:
--
--   working_forecasts              one working management forecast per
--                                  community / target year, measured from an
--                                  approved base-year budget; carries the policy
--                                  assumptions (e.g. expense inflation %).
--   working_forecast_adjustments   a human driver entry on one line (one-time
--                                  removal, omitted recurring cost, contract /
--                                  known change, rate, volatility) with a written
--                                  assumption, evidence, confidence, source and
--                                  actor. Append-only; the latest per line+driver
--                                  applies.
--   working_forecast_overrides     a human / board override of the model's line
--                                  recommendation. Stores the model value AT THE
--                                  TIME (and the model hash), the override, the
--                                  written reason, actor and time. Append-only;
--                                  the model recommendation is never overwritten.
--
--   vendor_contracts (EXTENDED, not duplicated; table from 015, used by the
--                                  living budget and 464/465 components): executed-
--                                  contract evidence for forecasting. Adds execution
--                                  status (detected / likely_executed /
--                                  verified_executed) with confidence and reason,
--                                  verification provenance, source email message /
--                                  library document / version, notice date, periodic
--                                  amount + frequency, dated rate schedule, unit
--                                  pricing, one-time fees, extracted assumptions, and
--                                  the one GL account (and fund) the contract drives.
--                                  Machine paths can only reach likely_executed;
--                                  verified_executed is set only by
--                                  verify_vendor_contract() by a named person, against
--                                  the exact document hash. Replacing the document
--                                  resets verification.
--   vendor_contract_events         append-only history of contract status / document
--                                  changes and verifications.
--
-- 465's budget_forecasts is the IN-YEAR forecast against the same year's
-- approved budget; it cannot hold a forward plan, so this is additive, not a
-- parallel copy. Record ownership: workpaper (Bedrock's management forecast)
-- until a board budget is adopted from it. Changes no existing row.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS working_forecasts (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL,
  fiscal_year      integer NOT NULL,
  base_fiscal_year integer NOT NULL,
  base_budget_id   uuid NOT NULL,
  kind             text NOT NULL DEFAULT 'management_forecast',
  status           text NOT NULL DEFAULT 'working',
  policy           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       text NOT NULL,
  updated_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT working_forecasts_pkey PRIMARY KEY (id),
  CONSTRAINT working_forecasts_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecasts_budget_fk FOREIGN KEY (base_budget_id) REFERENCES community_budgets(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecasts_kind_check CHECK (kind IN ('management_forecast')),
  CONSTRAINT working_forecasts_status_check CHECK (status IN ('working')),
  CONSTRAINT working_forecasts_years_check CHECK (base_fiscal_year = fiscal_year - 1)
);
COMMENT ON TABLE working_forecasts IS 'workpaper: next-year management working forecast (not the board budget). The model is computed from the books; this row holds policy assumptions.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_working_forecasts_one ON working_forecasts (community_id, fiscal_year, kind) WHERE status = 'working';
DROP TRIGGER IF EXISTS trg_working_forecasts_updated_at ON working_forecasts;
CREATE TRIGGER trg_working_forecasts_updated_at BEFORE UPDATE ON working_forecasts FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

CREATE OR REPLACE FUNCTION working_forecasts_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE b record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'working forecasts are not deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.community_id <> OLD.community_id OR NEW.fiscal_year <> OLD.fiscal_year OR NEW.base_budget_id <> OLD.base_budget_id OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'a working forecast''s community, year, base budget and kind cannot change';
  END IF;
  SELECT community_id, fiscal_year, status INTO b FROM community_budgets WHERE id = NEW.base_budget_id;
  IF b.community_id <> NEW.community_id OR b.fiscal_year <> NEW.base_fiscal_year THEN
    RAISE EXCEPTION 'the base budget must be this community''s budget for the base year';
  END IF;
  IF b.status NOT IN ('approved', 'active') THEN RAISE EXCEPTION 'the base budget must be approved (it is %)', b.status; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_working_forecasts_guard ON working_forecasts;
CREATE TRIGGER trg_working_forecasts_guard BEFORE INSERT OR UPDATE OR DELETE ON working_forecasts FOR EACH ROW EXECUTE FUNCTION working_forecasts_guard();

CREATE TABLE IF NOT EXISTS working_forecast_adjustments (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  forecast_id  uuid NOT NULL,
  community_id uuid NOT NULL,
  account_id   uuid NOT NULL,
  fund_id      uuid,
  driver       text NOT NULL,
  amount_cents bigint NOT NULL,
  assumption   text NOT NULL,
  evidence     jsonb,
  confidence   text NOT NULL DEFAULT 'medium',
  source       text NOT NULL DEFAULT 'management',
  actor        text NOT NULL,
  -- The line's base (cents) and the as-of date it was computed at, when a normalization
  -- was recorded. If the books later change that base (for example a reclassification
  -- to reserve), the engine flags the normalization for review instead of removing
  -- the same cost twice.
  base_cents   bigint,
  base_as_of   date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT working_forecast_adjustments_pkey PRIMARY KEY (id),
  CONSTRAINT working_forecast_adjustments_forecast_fk FOREIGN KEY (forecast_id) REFERENCES working_forecasts(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_adjustments_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_adjustments_account_fk FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_adjustments_fund_fk FOREIGN KEY (fund_id) REFERENCES account_funds(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_adjustments_driver_check CHECK (driver IN ('one_time', 'omitted_recurring', 'contract', 'rate', 'volatility')),
  CONSTRAINT working_forecast_adjustments_assumption_check CHECK (length(btrim(assumption)) >= 10 AND length(btrim(actor)) > 0),
  CONSTRAINT working_forecast_adjustments_confidence_check CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT working_forecast_adjustments_source_check CHECK (source IN ('management', 'board', 'contract', 'historical_model', 'system')),
  -- Normalization signs (effect on the line amount): a one-time removal is never positive,
  -- a recurring amount omitted from the base year is never negative.
  CONSTRAINT working_forecast_adjustments_sign_check CHECK ((driver <> 'one_time' OR amount_cents <= 0) AND (driver <> 'omitted_recurring' OR amount_cents >= 0)),
  CONSTRAINT working_forecast_adjustments_base_check CHECK (driver NOT IN ('one_time', 'omitted_recurring') OR (base_cents IS NOT NULL AND base_as_of IS NOT NULL))
);
COMMENT ON TABLE working_forecast_adjustments IS 'workpaper: human driver entries on working-forecast lines, with assumption, evidence, confidence, source and actor. Append-only; latest per line+driver applies.';
CREATE INDEX IF NOT EXISTS idx_working_forecast_adjustments_line ON working_forecast_adjustments (forecast_id, account_id, created_at);

CREATE TABLE IF NOT EXISTS working_forecast_overrides (
  id                         uuid NOT NULL DEFAULT gen_random_uuid(),
  forecast_id                uuid NOT NULL,
  community_id               uuid NOT NULL,
  account_id                 uuid NOT NULL,
  fund_id                    uuid,
  model_recommendation_cents bigint NOT NULL,
  model_sha256               text NOT NULL,
  override_cents             bigint,
  reason                     text NOT NULL,
  actor                      text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT working_forecast_overrides_pkey PRIMARY KEY (id),
  CONSTRAINT working_forecast_overrides_forecast_fk FOREIGN KEY (forecast_id) REFERENCES working_forecasts(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_overrides_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_overrides_account_fk FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_overrides_fund_fk FOREIGN KEY (fund_id) REFERENCES account_funds(id) ON DELETE RESTRICT,
  CONSTRAINT working_forecast_overrides_reason_check CHECK (length(btrim(reason)) >= 10 AND length(btrim(actor)) > 0),
  CONSTRAINT working_forecast_overrides_sha_check CHECK (model_sha256 ~ '^[0-9a-f]{64}$')
);
COMMENT ON TABLE working_forecast_overrides IS 'workpaper: human / board overrides of working-forecast line recommendations. The model value at the time is kept alongside the override, reason, actor and time. Append-only; override_cents NULL clears it.';
CREATE INDEX IF NOT EXISTS idx_working_forecast_overrides_line ON working_forecast_overrides (forecast_id, account_id, created_at);

-- Append-only + same-community guard for both decision tables.
CREATE OR REPLACE FUNCTION working_forecast_decisions_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE fc uuid; ac uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'working forecast decisions are permanent; record a new one instead'; END IF;
  SELECT community_id INTO fc FROM working_forecasts WHERE id = NEW.forecast_id;
  SELECT community_id INTO ac FROM chart_of_accounts WHERE id = NEW.account_id;
  IF fc IS DISTINCT FROM NEW.community_id OR ac IS DISTINCT FROM NEW.community_id THEN
    RAISE EXCEPTION 'forecast, account and decision must belong to the same community';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_working_forecast_adjustments_guard ON working_forecast_adjustments;
CREATE TRIGGER trg_working_forecast_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON working_forecast_adjustments FOR EACH ROW EXECUTE FUNCTION working_forecast_decisions_guard();
DROP TRIGGER IF EXISTS trg_working_forecast_overrides_guard ON working_forecast_overrides;
CREATE TRIGGER trg_working_forecast_overrides_guard BEFORE INSERT OR UPDATE OR DELETE ON working_forecast_overrides FOR EACH ROW EXECUTE FUNCTION working_forecast_decisions_guard();

-- ---------------------------------------------------------------- executed-contract evidence
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS execution_status text;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS execution_confidence numeric(4,3);
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS execution_reason text;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS verified_by text;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS verification_source text;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS source_message_id text;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS source_document_id uuid;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS document_version integer NOT NULL DEFAULT 1;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS termination_notice_date date;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS periodic_amount numeric(14,2);
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS periodic_frequency text;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS rate_schedule jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS unit_pricing jsonb;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS one_time_fees jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS extracted_assumptions text;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS forecast_account_id uuid;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS forecast_fund_id uuid;
ALTER TABLE vendor_contracts ADD COLUMN IF NOT EXISTS intake_source text;
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_source_document_fk;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_source_document_fk FOREIGN KEY (source_document_id) REFERENCES library_documents(id) ON DELETE RESTRICT;
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_forecast_account_fk;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_forecast_account_fk FOREIGN KEY (forecast_account_id) REFERENCES chart_of_accounts(id) ON DELETE RESTRICT;
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_forecast_fund_fk;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_forecast_fund_fk FOREIGN KEY (forecast_fund_id) REFERENCES account_funds(id) ON DELETE RESTRICT;
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_execution_status_check;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_execution_status_check CHECK (execution_status IS NULL OR execution_status IN ('detected', 'likely_executed', 'verified_executed'));
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_execution_confidence_check;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_execution_confidence_check CHECK (execution_confidence IS NULL OR (execution_confidence >= 0 AND execution_confidence <= 1));
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_periodic_frequency_check;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_periodic_frequency_check CHECK (periodic_frequency IS NULL OR periodic_frequency IN ('monthly', 'quarterly', 'semiannual', 'annual'));
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_intake_source_check;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_intake_source_check CHECK (intake_source IS NULL OR intake_source IN ('manual', 'upload', 'email', 'bid'));
ALTER TABLE vendor_contracts DROP CONSTRAINT IF EXISTS vendor_contracts_verified_provenance_check;
ALTER TABLE vendor_contracts ADD CONSTRAINT vendor_contracts_verified_provenance_check CHECK (execution_status IS DISTINCT FROM 'verified_executed'
  OR (coalesce(btrim(verified_by), '') <> '' AND verified_at IS NOT NULL AND coalesce(btrim(verification_source), '') <> '' AND file_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_vendor_contracts_forecast_account ON vendor_contracts (forecast_account_id) WHERE forecast_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vendor_contract_events (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  vendor_contract_id uuid NOT NULL,
  event              text NOT NULL,
  from_status        text,
  to_status          text,
  file_hash          text,
  document_version   integer,
  actor              text NOT NULL,
  detail             jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_contract_events_pkey PRIMARY KEY (id),
  CONSTRAINT vendor_contract_events_contract_fk FOREIGN KEY (vendor_contract_id) REFERENCES vendor_contracts(id) ON DELETE RESTRICT,
  CONSTRAINT vendor_contract_events_event_check CHECK (event IN ('recorded', 'status_change', 'verified', 'document_replaced', 'bound'))
);
COMMENT ON TABLE vendor_contract_events IS 'association_record: append-only history of a contract''s execution status, document versions, verifications and GL binding.';
CREATE INDEX IF NOT EXISTS idx_vendor_contract_events_contract ON vendor_contract_events (vendor_contract_id, created_at);
CREATE OR REPLACE FUNCTION vendor_contract_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'contract events are permanent'; END $fn$;
DROP TRIGGER IF EXISTS trg_vendor_contract_events_append_only ON vendor_contract_events;
CREATE TRIGGER trg_vendor_contract_events_append_only BEFORE UPDATE OR DELETE ON vendor_contract_events FOR EACH ROW EXECUTE FUNCTION vendor_contract_events_append_only();

-- Guard: verified_executed only via verify_vendor_contract(); replacing the document
-- resets verification and bumps the version; the GL binding stays in the community.
CREATE OR REPLACE FUNCTION vendor_contracts_execution_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE ac uuid;
BEGIN
  IF NEW.forecast_account_id IS NOT NULL THEN
    SELECT community_id INTO ac FROM chart_of_accounts WHERE id = NEW.forecast_account_id;
    IF ac IS DISTINCT FROM NEW.community_id THEN RAISE EXCEPTION 'the forecast account must belong to the contract''s community'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.file_hash IS DISTINCT FROM NEW.file_hash AND OLD.file_hash IS NOT NULL THEN
    NEW.document_version := OLD.document_version + 1;
    IF OLD.execution_status = 'verified_executed' THEN
      NEW.execution_status := 'likely_executed'; NEW.verified_by := NULL; NEW.verified_at := NULL; NEW.verification_source := NULL;
    END IF;
    INSERT INTO vendor_contract_events (vendor_contract_id, event, from_status, to_status, file_hash, document_version, actor, detail)
    VALUES (NEW.id, 'document_replaced', OLD.execution_status, NEW.execution_status, NEW.file_hash, NEW.document_version, coalesce(nullif(current_setting('trusted.actor', true), ''), 'system'), jsonb_build_object('previous_hash', OLD.file_hash));
  END IF;
  IF NEW.execution_status = 'verified_executed' AND (TG_OP = 'INSERT' OR OLD.execution_status IS DISTINCT FROM 'verified_executed')
     AND coalesce(current_setting('trusted.contract_verify', true), '') <> 'on' THEN
    RAISE EXCEPTION 'a contract is marked verified_executed only through verify_vendor_contract() by a named person';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_vendor_contracts_execution_guard ON vendor_contracts;
CREATE TRIGGER trg_vendor_contracts_execution_guard BEFORE INSERT OR UPDATE ON vendor_contracts FOR EACH ROW EXECUTE FUNCTION vendor_contracts_execution_guard();

-- Human verification against the exact document version.
CREATE OR REPLACE FUNCTION verify_vendor_contract(p_contract_id uuid, p_file_hash text, p_actor text, p_source text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $fn$
DECLARE c vendor_contracts%ROWTYPE;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'verification needs who is verifying'; END IF;
  IF length(coalesce(btrim(p_source), '')) < 10 THEN RAISE EXCEPTION 'verification needs its basis (10+ characters: what was checked, e.g. signatures and dates on the signed copy)'; END IF;
  SELECT * INTO c FROM vendor_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contract not found'; END IF;
  IF c.file_hash IS NULL THEN RAISE EXCEPTION 'a contract can be verified only against an attached document'; END IF;
  IF c.file_hash <> p_file_hash THEN RAISE EXCEPTION 'the document changed since it was reviewed (version %); review the current version', c.document_version; END IF;
  PERFORM set_config('trusted.contract_verify', 'on', true);
  UPDATE vendor_contracts SET execution_status = 'verified_executed', verified_by = btrim(p_actor), verified_at = now(), verification_source = btrim(p_source) WHERE id = p_contract_id;
  PERFORM set_config('trusted.contract_verify', '', true);
  INSERT INTO vendor_contract_events (vendor_contract_id, event, from_status, to_status, file_hash, document_version, actor, detail)
  VALUES (p_contract_id, 'verified', c.execution_status, 'verified_executed', c.file_hash, c.document_version, btrim(p_actor), jsonb_build_object('basis', btrim(p_source)));
  RETURN jsonb_build_object('verified', true, 'document_version', c.document_version);
END $fn$;
REVOKE ALL ON FUNCTION verify_vendor_contract(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION verify_vendor_contract(uuid, text, text, text) TO service_role;
ALTER TABLE vendor_contract_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vendor_contract_events FROM anon, authenticated;
GRANT SELECT, INSERT ON vendor_contract_events TO service_role;

ALTER TABLE working_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_forecast_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_forecast_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON working_forecasts, working_forecast_adjustments, working_forecast_overrides FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON working_forecasts TO service_role;
GRANT SELECT, INSERT ON working_forecast_adjustments, working_forecast_overrides TO service_role;

COMMIT;
