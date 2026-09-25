-- ============================================================================
-- 464_budget_monthly_plan.sql
-- ----------------------------------------------------------------------------
-- Record ownership: association_record. A budget line's monthly plan and the
-- components behind it are part of the association's budget.
--
-- WHY: the monthly plan is the operating planning layer (Budget Phase 2, Ed
-- 2026-09-25). A line needs a deliberate Jan-Dec plan, a record of HOW it was
-- phased and what that timing can honestly claim, and (optionally) the
-- components behind it: a recurring allowance plus a project, a contract, etc.
--
-- CHANGE:
--   * budget_line_items: phasing_method, phasing_settings, schedule_basis,
--     description. Empty on every existing row; no row is updated.
--   * budget_line_components: frozen detail behind a line. GL account and fund
--     come from the parent line (not stored). Optional links to a live
--     vendor_project / vendor_contract; the project's later changes never move
--     the budgeted months.
--   * Components must explain 100% of the line: when a line has components, the
--     components' Jan-Dec sum equals the line's Jan-Dec exactly (checked at
--     commit).
--   * The Phase 0 approved-budget lock now covers components too.
--   * save_budget_line_plan(): the one atomic write path for a line's months,
--     phasing and components, draft budgets only.
-- schedule_basis: documented (from a source document's own schedule),
-- calculated (derived by rule; a contract spread is an assumption until
-- confirmed, recorded in settings), manual (typed by a person).
-- GL, journals, approved budgets, AR, AP, ownership: unchanged.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m464_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || coalesce(fund_id::text, '') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items) AS bl_h,
  (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text || coalesce(approved_at::text, ''), '|' ORDER BY id), '')) FROM community_budgets) AS bh_h,
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) AS jel_h,
  (SELECT md5(coalesce(string_agg(id::text || account_number || account_type || coalesce(fund_id::text, ''), '|' ORDER BY id), '')) FROM chart_of_accounts) AS coa_h;

-- 1) Line phasing metadata -----------------------------------------------------
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS phasing_method text
  CHECK (phasing_method IS NULL OR phasing_method IN ('even', 'manual', 'prior_budget', 'prior_actual', 'contract', 'project', 'weighted'));
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS phasing_settings jsonb;
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS schedule_basis text
  CHECK (schedule_basis IS NULL OR schedule_basis IN ('documented', 'calculated', 'manual'));
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS description text;
COMMENT ON COLUMN budget_line_items.phasing_method IS 'How the 12 months were planned. NULL = as imported / before Phase 2.';
COMMENT ON COLUMN budget_line_items.schedule_basis IS 'What the monthly timing can claim: documented (source document schedule), calculated (derived by rule; contract spreads carry settings.assumption until confirmed), manual.';

-- 2) Components ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_line_components (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_line_id              uuid NOT NULL REFERENCES budget_line_items(id) ON DELETE CASCADE,
  budget_id                   uuid NOT NULL REFERENCES community_budgets(id) ON DELETE RESTRICT,
  name                        text NOT NULL CHECK (btrim(name) <> ''),
  kind                        text NOT NULL CHECK (kind IN ('recurring', 'project', 'contract', 'other')),
  vendor_project_id           uuid REFERENCES vendor_projects(id) ON DELETE RESTRICT,
  vendor_contract_id          uuid REFERENCES vendor_contracts(id) ON DELETE RESTRICT,
  vendor_name                 text,
  monthly_amounts_cents       bigint[] NOT NULL CHECK (array_length(monthly_amounts_cents, 1) = 12),
  annual_amount_cents         bigint NOT NULL DEFAULT 0,
  planned_start               date,
  planned_end                 date,
  project_stage_at_budget     text,
  project_cost_at_budget_cents bigint,
  schedule_basis              text NOT NULL DEFAULT 'manual' CHECK (schedule_basis IN ('documented', 'calculated', 'manual')),
  schedule_settings           jsonb,
  assumptions                 text,
  display_order               integer NOT NULL DEFAULT 100,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start)
);
COMMENT ON TABLE budget_line_components IS 'association_record: frozen detail behind a budget line (recurring allowance, project, contract). When a line has components they explain 100% of its months. GL account and fund are the parent line''s.';
CREATE INDEX IF NOT EXISTS idx_budget_line_components_line ON budget_line_components (budget_line_id, display_order);
CREATE INDEX IF NOT EXISTS idx_budget_line_components_budget ON budget_line_components (budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_line_components_project ON budget_line_components (vendor_project_id) WHERE vendor_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budget_line_components_contract ON budget_line_components (vendor_contract_id) WHERE vendor_contract_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_line_components TO service_role;
GRANT SELECT ON budget_line_components TO authenticated;
DROP TRIGGER IF EXISTS trg_budget_line_components_updated_at ON budget_line_components;
CREATE TRIGGER trg_budget_line_components_updated_at BEFORE UPDATE ON budget_line_components
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Annual is always the sum of the months; budget_id always the line's budget.
CREATE OR REPLACE FUNCTION budget_line_components_normalize() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE lb uuid;
BEGIN
  SELECT budget_id INTO lb FROM budget_line_items WHERE id = NEW.budget_line_id;
  IF lb IS NULL THEN RAISE EXCEPTION 'budget line not found'; END IF;
  IF NEW.budget_id IS DISTINCT FROM lb THEN RAISE EXCEPTION 'component budget does not match its line''s budget'; END IF;
  NEW.annual_amount_cents := (SELECT coalesce(sum(v), 0) FROM unnest(NEW.monthly_amounts_cents) v);
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_budget_line_components_normalize ON budget_line_components;
CREATE TRIGGER trg_budget_line_components_normalize BEFORE INSERT OR UPDATE ON budget_line_components
  FOR EACH ROW EXECUTE FUNCTION budget_line_components_normalize();

-- 3) Approved-budget lock extends to components (same rule and unlock as 462).
CREATE OR REPLACE FUNCTION budget_line_components_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE st text; fy integer;
BEGIN
  IF budget_unlock_in_progress() THEN RETURN coalesce(NEW, OLD); END IF;
  SELECT status, fiscal_year INTO st, fy FROM community_budgets WHERE id = coalesce(NEW.budget_id, OLD.budget_id);
  IF st IN ('approved', 'active') THEN
    RAISE EXCEPTION 'the FY% budget is approved and locked; its components cannot be added, changed or removed (reopen it first, with a reason)', fy;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.budget_id <> OLD.budget_id THEN
    SELECT status INTO st FROM community_budgets WHERE id = OLD.budget_id;
    IF st IN ('approved', 'active') THEN RAISE EXCEPTION 'a component cannot be moved out of a locked budget'; END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$fn$;
DROP TRIGGER IF EXISTS trg_budget_line_components_lock_guard ON budget_line_components;
CREATE TRIGGER trg_budget_line_components_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_line_components
  FOR EACH ROW EXECUTE FUNCTION budget_line_components_lock_guard();

-- 4) Completeness: a line with components is 100% explained by them (at commit).
CREATE OR REPLACE FUNCTION budget_line_components_tie(p_line_id uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE lm bigint[]; n int; bad text;
BEGIN
  SELECT monthly_amounts_cents INTO lm FROM budget_line_items WHERE id = p_line_id;
  IF lm IS NULL THEN RETURN; END IF;                                  -- line deleted (components cascaded)
  SELECT count(*) INTO n FROM budget_line_components WHERE budget_line_id = p_line_id;
  IF n = 0 THEN RETURN; END IF;                                       -- components are optional
  SELECT string_agg(to_char(make_date(2000, x.i::int, 1), 'Mon') || ' line ' || x.l || ' vs components ' || coalesce(y.c, 0), '; ' ORDER BY x.i) INTO bad
  FROM unnest(lm) WITH ORDINALITY x(l, i)
  LEFT JOIN (SELECT u.i, sum(u.v) c FROM budget_line_components bc, unnest(bc.monthly_amounts_cents) WITH ORDINALITY u(v, i)
             WHERE bc.budget_line_id = p_line_id GROUP BY u.i) y ON y.i = x.i
  WHERE x.l <> coalesce(y.c, 0);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'components must explain 100%% of the budget line (in cents: %)', bad;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION budget_line_components_tie_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'budget_line_items' THEN
    PERFORM budget_line_components_tie(NEW.id);
  ELSE
    PERFORM budget_line_components_tie(coalesce(NEW.budget_line_id, OLD.budget_line_id));
    IF TG_OP = 'UPDATE' AND NEW.budget_line_id <> OLD.budget_line_id THEN PERFORM budget_line_components_tie(OLD.budget_line_id); END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_budget_line_components_tie ON budget_line_components;
CREATE CONSTRAINT TRIGGER trg_budget_line_components_tie AFTER INSERT OR UPDATE OR DELETE ON budget_line_components
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budget_line_components_tie_trg();
DROP TRIGGER IF EXISTS trg_budget_line_items_components_tie ON budget_line_items;
CREATE CONSTRAINT TRIGGER trg_budget_line_items_components_tie AFTER UPDATE OF monthly_amounts_cents ON budget_line_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION budget_line_components_tie_trg();

-- 5) The one write path for a line's plan (months + phasing + components).
--    p_components: NULL = leave components as they are; [] = remove them;
--    [..] = replace them. Draft budgets only.
CREATE OR REPLACE FUNCTION save_budget_line_plan(
  p_line_id uuid, p_monthly bigint[], p_phasing_method text, p_phasing_settings jsonb,
  p_schedule_basis text, p_description text, p_notes text, p_components jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE l budget_line_items%ROWTYPE; st text; fy int; c jsonb; n int := 0; ord int := 0;
BEGIN
  SELECT * INTO l FROM budget_line_items WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'budget line not found'; END IF;
  SELECT status, fiscal_year INTO st, fy FROM community_budgets WHERE id = l.budget_id;
  IF st <> 'draft' THEN RAISE EXCEPTION 'the FY% budget is % and cannot be edited; only draft budgets can', fy, st; END IF;
  IF p_monthly IS NULL OR array_length(p_monthly, 1) IS DISTINCT FROM 12 THEN RAISE EXCEPTION 'a line needs 12 monthly values'; END IF;
  IF p_components IS NOT NULL THEN
    IF jsonb_typeof(p_components) <> 'array' THEN RAISE EXCEPTION 'components must be a list'; END IF;
    DELETE FROM budget_line_components WHERE budget_line_id = l.id;
    FOR c IN SELECT * FROM jsonb_array_elements(p_components) LOOP
      ord := ord + 10;
      INSERT INTO budget_line_components (budget_line_id, budget_id, name, kind, vendor_project_id, vendor_contract_id, vendor_name,
        monthly_amounts_cents, planned_start, planned_end, project_stage_at_budget, project_cost_at_budget_cents,
        schedule_basis, schedule_settings, assumptions, display_order)
      VALUES (l.id, l.budget_id, c->>'name', c->>'kind', nullif(c->>'vendor_project_id', '')::uuid, nullif(c->>'vendor_contract_id', '')::uuid, c->>'vendor_name',
        ARRAY(SELECT (v)::bigint FROM jsonb_array_elements_text(c->'monthly_amounts_cents') v),
        nullif(c->>'planned_start', '')::date, nullif(c->>'planned_end', '')::date, c->>'project_stage_at_budget', nullif(c->>'project_cost_at_budget_cents', '')::bigint,
        coalesce(c->>'schedule_basis', 'manual'), c->'schedule_settings', c->>'assumptions', ord);
      n := n + 1;
    END LOOP;
  END IF;
  UPDATE budget_line_items SET
    monthly_amounts_cents = p_monthly,
    annual_amount_cents = (SELECT coalesce(sum(v), 0) FROM unnest(p_monthly) v),
    phasing_method = p_phasing_method,
    phasing_settings = p_phasing_settings,
    schedule_basis = p_schedule_basis,
    description = nullif(btrim(coalesce(p_description, '')), ''),
    notes = nullif(btrim(coalesce(p_notes, '')), '')
  WHERE id = l.id;
  -- Check completeness now for a clear message (the deferred trigger re-checks at commit).
  PERFORM budget_line_components_tie(l.id);
  RETURN jsonb_build_object('line_id', l.id, 'annual_amount_cents', (SELECT coalesce(sum(v), 0) FROM unnest(p_monthly) v),
    'components', (SELECT count(*) FROM budget_line_components WHERE budget_line_id = l.id));
END;
$$;
REVOKE ALL ON FUNCTION save_budget_line_plan(uuid, bigint[], text, jsonb, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_budget_line_plan(uuid, bigint[], text, jsonb, text, text, text, jsonb) TO service_role;

-- 6) Guards: nothing existing changed.
DO $guard$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM _m464_before;
  IF b.bl_h <> (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || coalesce(fund_id::text, '') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items) THEN RAISE EXCEPTION 'guard: budget lines changed'; END IF;
  IF b.bh_h <> (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text || coalesce(approved_at::text, ''), '|' ORDER BY id), '')) FROM community_budgets) THEN RAISE EXCEPTION 'guard: budgets changed'; END IF;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) THEN RAISE EXCEPTION 'guard: journal entries changed'; END IF;
  IF b.jel_h <> (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) THEN RAISE EXCEPTION 'guard: journal lines changed'; END IF;
  IF b.coa_h <> (SELECT md5(coalesce(string_agg(id::text || account_number || account_type || coalesce(fund_id::text, ''), '|' ORDER BY id), '')) FROM chart_of_accounts) THEN RAISE EXCEPTION 'guard: chart of accounts changed'; END IF;
  IF EXISTS (SELECT 1 FROM budget_line_items WHERE phasing_method IS NOT NULL OR schedule_basis IS NOT NULL OR phasing_settings IS NOT NULL OR description IS NOT NULL) THEN RAISE EXCEPTION 'guard: existing lines got phasing data'; END IF;
  IF EXISTS (SELECT 1 FROM budget_line_components) THEN RAISE EXCEPTION 'guard: components were created'; END IF;
  --@@END@@
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';
