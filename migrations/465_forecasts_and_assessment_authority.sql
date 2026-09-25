-- ============================================================================
-- 465_forecasts_and_assessment_authority.sql        *** DRAFT — NOT APPLIED ***
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (forecasts presented to the board,
-- governing-document assessment rules, adopted assessment rates).
--
-- WHY (Forecast Phase 3B, Ed 2026-09-25):
--   Approved budget = what the board adopted (unchanged by anything here).
--   Actual          = the GL (never copied into a working forecast).
--   Forecast        = current best estimate of where the year finishes.
--
-- CHANGE:
--   * budget_forecasts: one WORKING forecast per community + fiscal year, plus
--     immutable SNAPSHOTS (by as-of month, optionally labelled).
--   * forecast_lines: method + settings + REMAINING months only (months at or
--     before the as-of month must be 0 in a working forecast); snapshots also
--     freeze the actual months so history reproduces exactly.
--   * forecast_line_components: project / contract / known_invoice / recurring
--     / adjustment, with provenance and optional links to the source record.
--     When a line has components they explain 100% of its remaining months.
--   * forecast_events: append-only log (created, refresh, method change,
--     override, component change, snapshot).
--   * community_assessment_authority: the community's source-backed rule for
--     how far the board can raise assessments and what happens above that.
--     Only a VERIFIED rule (document + citation + excerpt + verifier) may be
--     used to draw a conclusion. No global default cap.
--   * community_assessment_rate_history: adopted annual assessment by year.
-- Nothing existing is changed; no rows are created.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m465_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items) AS bl_h,
  (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) AS bh_h,
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) AS jel_h;

CREATE OR REPLACE FUNCTION forecast_unlock_in_progress() RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('trusted.forecast_snapshot', true), '') = 'on'
$fn$;

-- 1) Forecast headers -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_forecasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  fiscal_year   integer NOT NULL,
  budget_id     uuid NOT NULL REFERENCES community_budgets(id) ON DELETE RESTRICT,
  as_of_month   integer NOT NULL CHECK (as_of_month BETWEEN 0 AND 12),
  status        text NOT NULL DEFAULT 'working' CHECK (status IN ('working', 'snapshot')),
  label         text,
  snapshot_of   uuid REFERENCES budget_forecasts(id) ON DELETE RESTRICT,
  created_by    text,
  updated_by    text,
  frozen_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'snapshot') = (frozen_at IS NOT NULL)),
  CHECK (status = 'working' OR snapshot_of IS NOT NULL)
);
COMMENT ON TABLE budget_forecasts IS 'association_record: forecast of where the fiscal year will finish, measured against an approved budget. One working forecast per community/year; snapshots are immutable.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_forecasts_one_working ON budget_forecasts (community_id, fiscal_year) WHERE status = 'working';
CREATE INDEX IF NOT EXISTS idx_budget_forecasts_community ON budget_forecasts (community_id, fiscal_year, as_of_month);
GRANT SELECT, INSERT, UPDATE ON budget_forecasts TO service_role;
GRANT SELECT ON budget_forecasts TO authenticated;
DROP TRIGGER IF EXISTS trg_budget_forecasts_updated_at ON budget_forecasts;
CREATE TRIGGER trg_budget_forecasts_updated_at BEFORE UPDATE ON budget_forecasts FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

CREATE OR REPLACE FUNCTION budget_forecasts_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE b record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'forecasts are not deleted (forecast %)', OLD.id;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'snapshot' AND NOT forecast_unlock_in_progress() THEN
    RAISE EXCEPTION 'forecast snapshots are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.community_id <> OLD.community_id OR NEW.fiscal_year <> OLD.fiscal_year OR NEW.budget_id <> OLD.budget_id OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'a forecast''s community, year, budget and status cannot change';
  END IF;
  SELECT community_id, fiscal_year, status INTO b FROM community_budgets WHERE id = NEW.budget_id;
  IF b.community_id <> NEW.community_id OR b.fiscal_year <> NEW.fiscal_year THEN
    RAISE EXCEPTION 'forecast must be measured against the same community''s budget for the same fiscal year';
  END IF;
  IF b.status NOT IN ('approved', 'active') THEN
    RAISE EXCEPTION 'forecasts are measured against an approved budget (this one is %)', b.status;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'snapshot' AND NOT forecast_unlock_in_progress() THEN
    RAISE EXCEPTION 'snapshots are created only by snapshot_budget_forecast()';
  END IF;
  -- Refresh: months that become actual must not still carry forecast amounts.
  IF TG_OP = 'UPDATE' AND NEW.as_of_month > OLD.as_of_month AND (
       EXISTS (SELECT 1 FROM forecast_lines fl, generate_series(1, NEW.as_of_month) g WHERE fl.forecast_id = NEW.id AND fl.remaining_months[g] <> 0)
    OR EXISTS (SELECT 1 FROM forecast_line_components fc, generate_series(1, NEW.as_of_month) g WHERE fc.forecast_id = NEW.id AND fc.months[g] <> 0)) THEN
    RAISE EXCEPTION 'refresh: clear forecast amounts in months through % (now actual) before moving the as-of month', NEW.as_of_month;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_budget_forecasts_guard ON budget_forecasts;
CREATE TRIGGER trg_budget_forecasts_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_forecasts FOR EACH ROW EXECUTE FUNCTION budget_forecasts_guard();

-- 2) Forecast lines ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forecast_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_id      uuid NOT NULL REFERENCES budget_forecasts(id) ON DELETE RESTRICT,
  account_id       uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  fund_id          uuid REFERENCES account_funds(id) ON DELETE RESTRICT,
  method           text NOT NULL DEFAULT 'remaining_budget'
                   CHECK (method IN ('remaining_budget', 'run_rate', 'prior_year_pattern', 'recurring', 'manual', 'components', 'assessment_recognition')),
  settings         jsonb,
  remaining_months bigint[] NOT NULL CHECK (array_length(remaining_months, 1) = 12),
  actual_months    bigint[] CHECK (actual_months IS NULL OR array_length(actual_months, 1) = 12),
  schedule_basis   text NOT NULL DEFAULT 'calculated' CHECK (schedule_basis IN ('documented', 'calculated', 'manual')),
  confidence       text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  explanation      text,
  override_reason  text,
  updated_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (method <> 'manual' OR coalesce(btrim(override_reason), '') <> '')
);
COMMENT ON TABLE forecast_lines IS 'association_record: one account/fund line of a forecast. Working lines hold only remaining months (actuals come from the GL); snapshot lines also freeze actual months.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_forecast_lines_account ON forecast_lines (forecast_id, account_id, coalesce(fund_id, '00000000-0000-0000-0000-000000000000'::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON forecast_lines TO service_role;
GRANT SELECT ON forecast_lines TO authenticated;
DROP TRIGGER IF EXISTS trg_forecast_lines_updated_at ON forecast_lines;
CREATE TRIGGER trg_forecast_lines_updated_at BEFORE UPDATE ON forecast_lines FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

CREATE OR REPLACE FUNCTION forecast_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE f budget_forecasts%ROWTYPE; a record; i int;
BEGIN
  SELECT * INTO f FROM budget_forecasts WHERE id = coalesce(NEW.forecast_id, OLD.forecast_id);
  IF f.status = 'snapshot' AND NOT forecast_unlock_in_progress() THEN
    RAISE EXCEPTION 'forecast snapshots are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.forecast_id <> OLD.forecast_id OR NEW.account_id <> OLD.account_id) THEN
    RAISE EXCEPTION 'change the method or months of a line, not its forecast or account';
  END IF;
  SELECT community_id, account_type INTO a FROM chart_of_accounts WHERE id = NEW.account_id;
  IF a.community_id <> f.community_id THEN RAISE EXCEPTION 'account belongs to another community'; END IF;
  IF a.account_type NOT IN ('revenue', 'expense') THEN RAISE EXCEPTION 'forecast lines are for revenue and expense accounts'; END IF;
  IF f.status = 'working' THEN
    IF NEW.actual_months IS NOT NULL THEN RAISE EXCEPTION 'working forecasts read actual months from the GL; they are not stored'; END IF;
    FOR i IN 1..f.as_of_month LOOP
      IF NEW.remaining_months[i] <> 0 THEN
        RAISE EXCEPTION 'month % is at or before the as-of month; it is actual, not forecast', i;
      END IF;
    END LOOP;
  ELSE
    IF NEW.actual_months IS NULL THEN RAISE EXCEPTION 'snapshot lines must freeze their actual months'; END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_forecast_lines_guard ON forecast_lines;
CREATE TRIGGER trg_forecast_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON forecast_lines FOR EACH ROW EXECUTE FUNCTION forecast_lines_guard();

-- 3) Components --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forecast_line_components (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_line_id          uuid NOT NULL REFERENCES forecast_lines(id) ON DELETE CASCADE,
  forecast_id               uuid NOT NULL REFERENCES budget_forecasts(id) ON DELETE RESTRICT,
  kind                      text NOT NULL CHECK (kind IN ('project', 'contract', 'known_invoice', 'recurring', 'adjustment')),
  label                     text NOT NULL CHECK (btrim(label) <> ''),
  months                    bigint[] NOT NULL CHECK (array_length(months, 1) = 12),
  schedule_basis            text NOT NULL CHECK (schedule_basis IN ('documented', 'calculated', 'manual')),
  is_assumption             boolean NOT NULL DEFAULT false,
  assumption_confirmed_by   text,
  assumption_confirmed_at   timestamptz,
  budget_line_component_id  uuid REFERENCES budget_line_components(id) ON DELETE RESTRICT,
  vendor_project_id         uuid REFERENCES vendor_projects(id) ON DELETE RESTRICT,
  vendor_contract_id        uuid REFERENCES vendor_contracts(id) ON DELETE RESTRICT,
  ap_invoice_id             uuid REFERENCES ap_invoices(id) ON DELETE RESTRICT,
  expected_date             date,
  explanation               text,
  evidence                  jsonb,
  display_order             integer NOT NULL DEFAULT 100,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (schedule_basis = 'documented' AND is_assumption)),
  CHECK (kind <> 'known_invoice' OR ap_invoice_id IS NOT NULL),
  CHECK (kind <> 'project' OR vendor_project_id IS NOT NULL OR budget_line_component_id IS NOT NULL)
);
COMMENT ON TABLE forecast_line_components IS 'association_record: what makes up a forecast line''s remaining months, with provenance and links to the project / contract / invoice it came from. An assumption is never documented; confirming it records who and when.';
CREATE INDEX IF NOT EXISTS idx_forecast_line_components_line ON forecast_line_components (forecast_line_id, display_order);
CREATE INDEX IF NOT EXISTS idx_forecast_line_components_project ON forecast_line_components (vendor_project_id) WHERE vendor_project_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON forecast_line_components TO service_role;
GRANT SELECT ON forecast_line_components TO authenticated;
DROP TRIGGER IF EXISTS trg_forecast_line_components_updated_at ON forecast_line_components;
CREATE TRIGGER trg_forecast_line_components_updated_at BEFORE UPDATE ON forecast_line_components FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

CREATE OR REPLACE FUNCTION forecast_line_components_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE f budget_forecasts%ROWTYPE; lf uuid; i int;
BEGIN
  SELECT * INTO f FROM budget_forecasts WHERE id = coalesce(NEW.forecast_id, OLD.forecast_id);
  IF f.status = 'snapshot' AND NOT forecast_unlock_in_progress() THEN
    RAISE EXCEPTION 'forecast snapshots are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT forecast_id INTO lf FROM forecast_lines WHERE id = NEW.forecast_line_id;
  IF lf IS DISTINCT FROM NEW.forecast_id THEN RAISE EXCEPTION 'component forecast does not match its line'; END IF;
  IF f.status = 'working' THEN
    FOR i IN 1..f.as_of_month LOOP
      IF NEW.months[i] <> 0 THEN RAISE EXCEPTION 'component has an amount in month %, which is already actual', i; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_forecast_line_components_guard ON forecast_line_components;
CREATE TRIGGER trg_forecast_line_components_guard BEFORE INSERT OR UPDATE OR DELETE ON forecast_line_components FOR EACH ROW EXECUTE FUNCTION forecast_line_components_guard();

-- Components explain 100% of the line's remaining months (checked at commit).
CREATE OR REPLACE FUNCTION forecast_components_tie(p_line_id uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE lm bigint[]; n int; bad text;
BEGIN
  SELECT remaining_months INTO lm FROM forecast_lines WHERE id = p_line_id;
  IF lm IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO n FROM forecast_line_components WHERE forecast_line_id = p_line_id;
  IF n = 0 THEN RETURN; END IF;
  SELECT string_agg(x.i || ': line ' || x.l || ' vs components ' || coalesce(y.c, 0), '; ' ORDER BY x.i) INTO bad
  FROM unnest(lm) WITH ORDINALITY x(l, i)
  LEFT JOIN (SELECT u.i, sum(u.v) c FROM forecast_line_components fc, unnest(fc.months) WITH ORDINALITY u(v, i)
             WHERE fc.forecast_line_id = p_line_id GROUP BY u.i) y ON y.i = x.i
  WHERE x.l <> coalesce(y.c, 0);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'forecast components must explain 100%% of the remaining months (month: %)', bad; END IF;
END;
$fn$;
CREATE OR REPLACE FUNCTION forecast_components_tie_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'forecast_lines' THEN PERFORM forecast_components_tie(NEW.id);
  ELSE PERFORM forecast_components_tie(coalesce(NEW.forecast_line_id, OLD.forecast_line_id)); END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_forecast_components_tie ON forecast_line_components;
CREATE CONSTRAINT TRIGGER trg_forecast_components_tie AFTER INSERT OR UPDATE OR DELETE ON forecast_line_components
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION forecast_components_tie_trg();
DROP TRIGGER IF EXISTS trg_forecast_lines_components_tie ON forecast_lines;
CREATE CONSTRAINT TRIGGER trg_forecast_lines_components_tie AFTER UPDATE OF remaining_months ON forecast_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION forecast_components_tie_trg();

-- 4) Events (append-only) ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forecast_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_id  uuid NOT NULL REFERENCES budget_forecasts(id) ON DELETE RESTRICT,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  event        text NOT NULL CHECK (event IN ('created', 'refresh', 'method_change', 'override', 'component_change', 'snapshot')),
  line_id      uuid,
  account_id   uuid,
  detail       jsonb,
  actor        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE forecast_events IS 'association_record: every forecast change and snapshot, who and when. Append-only.';
CREATE INDEX IF NOT EXISTS idx_forecast_events_forecast ON forecast_events (forecast_id, created_at);
GRANT SELECT, INSERT ON forecast_events TO service_role;
GRANT SELECT ON forecast_events TO authenticated;
CREATE OR REPLACE FUNCTION forecast_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forecast events are permanent (event %)', OLD.id; END; $fn$;
DROP TRIGGER IF EXISTS trg_forecast_events_append_only ON forecast_events;
CREATE TRIGGER trg_forecast_events_append_only BEFORE UPDATE OR DELETE ON forecast_events FOR EACH ROW EXECUTE FUNCTION forecast_events_append_only();

CREATE OR REPLACE FUNCTION forecast_log() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE f budget_forecasts%ROWTYPE; actor text; ev text;
BEGIN
  IF forecast_unlock_in_progress() THEN RETURN NULL; END IF;       -- snapshot copies log once, in the function
  actor := nullif(current_setting('trusted.actor', true), '');
  IF TG_TABLE_NAME = 'budget_forecasts' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO forecast_events (forecast_id, community_id, event, detail, actor)
      VALUES (NEW.id, NEW.community_id, 'created', jsonb_build_object('as_of_month', NEW.as_of_month, 'budget_id', NEW.budget_id), coalesce(actor, NEW.created_by));
    ELSIF NEW.as_of_month <> OLD.as_of_month THEN
      INSERT INTO forecast_events (forecast_id, community_id, event, detail, actor)
      VALUES (NEW.id, NEW.community_id, 'refresh', jsonb_build_object('from_as_of', OLD.as_of_month, 'to_as_of', NEW.as_of_month), coalesce(actor, NEW.updated_by));
    END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'forecast_lines' THEN
    SELECT * INTO f FROM budget_forecasts WHERE id = coalesce(NEW.forecast_id, OLD.forecast_id);
    ev := CASE WHEN TG_OP <> 'DELETE' AND NEW.method = 'manual' THEN 'override' ELSE 'method_change' END;
    IF TG_OP = 'UPDATE' AND NEW.method = OLD.method AND NEW.remaining_months = OLD.remaining_months
       AND NEW.settings IS NOT DISTINCT FROM OLD.settings AND NEW.override_reason IS NOT DISTINCT FROM OLD.override_reason THEN
      RETURN NULL;
    END IF;
    INSERT INTO forecast_events (forecast_id, community_id, event, line_id, account_id, detail, actor)
    VALUES (f.id, f.community_id, ev, coalesce(NEW.id, OLD.id), coalesce(NEW.account_id, OLD.account_id),
            jsonb_build_object('op', lower(TG_OP),
              'old', CASE WHEN TG_OP <> 'INSERT' THEN jsonb_build_object('method', OLD.method, 'remaining_months', OLD.remaining_months, 'reason', OLD.override_reason) END,
              'new', CASE WHEN TG_OP <> 'DELETE' THEN jsonb_build_object('method', NEW.method, 'remaining_months', NEW.remaining_months, 'reason', NEW.override_reason) END),
            coalesce(actor, CASE WHEN TG_OP = 'DELETE' THEN OLD.updated_by ELSE NEW.updated_by END));
    RETURN NULL;
  END IF;
  -- components
  SELECT * INTO f FROM budget_forecasts WHERE id = coalesce(NEW.forecast_id, OLD.forecast_id);
  INSERT INTO forecast_events (forecast_id, community_id, event, line_id, detail, actor)
  VALUES (f.id, f.community_id, 'component_change', coalesce(NEW.forecast_line_id, OLD.forecast_line_id),
          jsonb_build_object('op', lower(TG_OP), 'kind', coalesce(NEW.kind, OLD.kind), 'label', coalesce(NEW.label, OLD.label),
            'old_months', CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD.months) END, 'new_months', CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW.months) END), actor);
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_budget_forecasts_log ON budget_forecasts;
CREATE TRIGGER trg_budget_forecasts_log AFTER INSERT OR UPDATE ON budget_forecasts FOR EACH ROW EXECUTE FUNCTION forecast_log();
DROP TRIGGER IF EXISTS trg_forecast_lines_log ON forecast_lines;
CREATE TRIGGER trg_forecast_lines_log AFTER INSERT OR UPDATE OR DELETE ON forecast_lines FOR EACH ROW EXECUTE FUNCTION forecast_log();
DROP TRIGGER IF EXISTS trg_forecast_line_components_log ON forecast_line_components;
CREATE TRIGGER trg_forecast_line_components_log AFTER INSERT OR UPDATE OR DELETE ON forecast_line_components FOR EACH ROW EXECUTE FUNCTION forecast_log();

-- 5) Snapshot: the only way to create an immutable copy.
--    p_actual: {"<line_id>": [12 actual months], ...} computed from the GL by the
--    forecast engine at snapshot time; every working line must be present.
CREATE OR REPLACE FUNCTION snapshot_budget_forecast(p_forecast_id uuid, p_label text, p_actor text, p_actual jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE f budget_forecasts%ROWTYPE; sid uuid; l forecast_lines%ROWTYPE; nl uuid; am bigint[];
BEGIN
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'a snapshot needs who is taking it'; END IF;
  SELECT * INTO f FROM budget_forecasts WHERE id = p_forecast_id FOR UPDATE;
  IF NOT FOUND OR f.status <> 'working' THEN RAISE EXCEPTION 'only a working forecast can be snapshotted'; END IF;
  PERFORM set_config('trusted.forecast_snapshot', 'on', true);
  INSERT INTO budget_forecasts (community_id, fiscal_year, budget_id, as_of_month, status, label, snapshot_of, created_by, frozen_at)
  VALUES (f.community_id, f.fiscal_year, f.budget_id, f.as_of_month, 'snapshot', nullif(btrim(coalesce(p_label, '')), ''), f.id, btrim(p_actor), now())
  RETURNING id INTO sid;
  FOR l IN SELECT * FROM forecast_lines WHERE forecast_id = f.id LOOP
    IF p_actual IS NULL OR NOT (p_actual ? l.id::text) THEN RAISE EXCEPTION 'actual months missing for line %', l.id; END IF;
    am := ARRAY(SELECT (v)::bigint FROM jsonb_array_elements_text(p_actual -> l.id::text) v);
    IF array_length(am, 1) IS DISTINCT FROM 12 THEN RAISE EXCEPTION 'actual months for line % need 12 values', l.id; END IF;
    INSERT INTO forecast_lines (forecast_id, account_id, fund_id, method, settings, remaining_months, actual_months, schedule_basis, confidence, explanation, override_reason, updated_by)
    VALUES (sid, l.account_id, l.fund_id, l.method, l.settings, l.remaining_months, am, l.schedule_basis, l.confidence, l.explanation, l.override_reason, btrim(p_actor))
    RETURNING id INTO nl;
    INSERT INTO forecast_line_components (forecast_line_id, forecast_id, kind, label, months, schedule_basis, is_assumption, assumption_confirmed_by, assumption_confirmed_at,
      budget_line_component_id, vendor_project_id, vendor_contract_id, ap_invoice_id, expected_date, explanation, evidence, display_order)
    SELECT nl, sid, kind, label, months, schedule_basis, is_assumption, assumption_confirmed_by, assumption_confirmed_at,
      budget_line_component_id, vendor_project_id, vendor_contract_id, ap_invoice_id, expected_date, explanation, evidence, display_order
    FROM forecast_line_components WHERE forecast_line_id = l.id;
  END LOOP;
  PERFORM set_config('trusted.forecast_snapshot', 'off', true);
  INSERT INTO forecast_events (forecast_id, community_id, event, detail, actor) VALUES
    (f.id, f.community_id, 'snapshot', jsonb_build_object('snapshot_id', sid, 'as_of_month', f.as_of_month, 'label', p_label), btrim(p_actor)),
    (sid, f.community_id, 'snapshot', jsonb_build_object('snapshot_of', f.id, 'as_of_month', f.as_of_month, 'label', p_label), btrim(p_actor));
  RETURN sid;
END;
$$;
REVOKE ALL ON FUNCTION snapshot_budget_forecast(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION snapshot_budget_forecast(uuid, text, text, jsonb) TO service_role;

-- 6) Assessment authority (source-backed, community-specific) -----------------------
CREATE TABLE IF NOT EXISTS community_assessment_authority (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  effective_from                date NOT NULL,
  effective_to                  date,
  board_max_increase_pct        numeric(6,3) CHECK (board_max_increase_pct IS NULL OR board_max_increase_pct >= 0),
  increase_basis                text NOT NULL DEFAULT 'prior_year_assessment' CHECK (increase_basis IN ('prior_year_assessment', 'prior_year_budget', 'other')),
  above_cap_permitted           boolean,
  member_approval_threshold_pct numeric(6,3) CHECK (member_approval_threshold_pct IS NULL OR member_approval_threshold_pct BETWEEN 0 AND 100),
  member_approval_basis         text CHECK (member_approval_basis IS NULL OR member_approval_basis IN ('all_members', 'votes_cast', 'quorum_present', 'owners_of_record', 'other')),
  quorum_note                   text,
  procedural_steps              jsonb,
  source_document_id            uuid REFERENCES library_documents(id) ON DELETE RESTRICT,
  source_citation               text,
  source_excerpt                text,
  status                        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'superseded')),
  verified_by                   text,
  verified_at                   timestamptz,
  notes                         text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (status <> 'verified' OR (source_document_id IS NOT NULL AND coalesce(btrim(source_citation), '') <> ''
         AND coalesce(btrim(source_excerpt), '') <> '' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (above_cap_permitted IS NOT TRUE OR status <> 'verified' OR member_approval_basis IS NOT NULL)
);
COMMENT ON TABLE community_assessment_authority IS 'association_record: the governing-document rule for how far the board may raise assessments and what is required above that. Only VERIFIED rows (document + citation + excerpt + verifier) may be used to draw a conclusion. No global default.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_authority_current ON community_assessment_authority (community_id) WHERE status = 'verified' AND effective_to IS NULL;
GRANT SELECT, INSERT, UPDATE ON community_assessment_authority TO service_role;
GRANT SELECT ON community_assessment_authority TO authenticated;
DROP TRIGGER IF EXISTS trg_assessment_authority_updated_at ON community_assessment_authority;
CREATE TRIGGER trg_assessment_authority_updated_at BEFORE UPDATE ON community_assessment_authority FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

CREATE TABLE IF NOT EXISTS community_assessment_rate_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  fiscal_year         integer NOT NULL,
  owner_class         text NOT NULL DEFAULT 'homeowner' CHECK (owner_class IN ('builder', 'homeowner')),
  annual_amount_cents bigint NOT NULL CHECK (annual_amount_cents >= 0),
  effective_date      date,
  approved_by_body    text CHECK (approved_by_body IS NULL OR approved_by_body IN ('board', 'members')),
  source_document_id  uuid REFERENCES library_documents(id) ON DELETE RESTRICT,
  source_citation     text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, fiscal_year, owner_class)
);
COMMENT ON TABLE community_assessment_rate_history IS 'association_record: the adopted annual assessment per unit by fiscal year (the base for increase-% calculations).';
GRANT SELECT, INSERT, UPDATE ON community_assessment_rate_history TO service_role;
GRANT SELECT ON community_assessment_rate_history TO authenticated;
DROP TRIGGER IF EXISTS trg_assessment_rate_history_updated_at ON community_assessment_rate_history;
CREATE TRIGGER trg_assessment_rate_history_updated_at BEFORE UPDATE ON community_assessment_rate_history FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- 7) Guards ----------------------------------------------------------------------------
DO $guard$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM _m465_before;
  IF b.bl_h <> (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items)
  OR b.bh_h <> (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) THEN RAISE EXCEPTION 'guard: budgets changed'; END IF;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries)
  OR b.jel_h <> (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) THEN RAISE EXCEPTION 'guard: GL changed'; END IF;
  IF EXISTS (SELECT 1 FROM budget_forecasts) OR EXISTS (SELECT 1 FROM community_assessment_authority) OR EXISTS (SELECT 1 FROM community_assessment_rate_history) THEN
    RAISE EXCEPTION 'guard: rows were created';
  END IF;
  --@@END@@
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';
