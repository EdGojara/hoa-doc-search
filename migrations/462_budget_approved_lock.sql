-- ============================================================================
-- 462_budget_approved_lock.sql
-- ----------------------------------------------------------------------------
-- Record ownership: an approved budget is an association_record (the board's
-- adopted budget); the event log is association_record too.
--
-- WHY: "Finalized" was only a UI word for status = 'approved'. POST /budgets
-- overwrote an approved budget in place (deleting and re-inserting every line,
-- flattening seasonal months to annual/12) and DELETE removed it. Nothing in the
-- database stopped that. (Budget Phase 0, Ed 2026-09-25.)
--
-- CHANGE (smallest guard; no versioning yet):
--   * An approved/active budget and its lines cannot be updated, inserted into,
--     or deleted. A budget is written as 'draft' and flipped to 'approved' last,
--     so uploads and the planner still work (draft -> approved is allowed).
--   * The only way to change an approved budget: reopen_community_budget(id,
--     reason, by), an explicit, logged step that returns it to 'draft'.
--   * community_budget_events: append-only log of approvals and reopens.
-- No existing budget row, month, or amount is changed.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m462_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || coalesce(fund_id::text, '') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items) AS lines_h,
  (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) AS hdr_h,
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h;

-- 1) Append-only event log.
CREATE TABLE IF NOT EXISTS community_budget_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id    uuid NOT NULL REFERENCES community_budgets(id) ON DELETE RESTRICT,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  fiscal_year  integer NOT NULL,
  event        text NOT NULL CHECK (event IN ('approved', 'reopened')),
  actor        text,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE community_budget_events IS 'association_record: when a budget was approved (locked) or reopened, by whom and why. Append-only.';
CREATE INDEX IF NOT EXISTS idx_community_budget_events_budget ON community_budget_events (budget_id, created_at);
GRANT SELECT, INSERT ON community_budget_events TO service_role;
GRANT SELECT ON community_budget_events TO authenticated;

CREATE OR REPLACE FUNCTION community_budget_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'budget events are permanent (event %)', OLD.id;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_community_budget_events_append_only ON community_budget_events;
CREATE TRIGGER trg_community_budget_events_append_only BEFORE UPDATE OR DELETE ON community_budget_events
  FOR EACH ROW EXECUTE FUNCTION community_budget_events_append_only();

-- 2) The lock.
CREATE OR REPLACE FUNCTION budget_unlock_in_progress() RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('trusted.budget_unlock', true), '') = 'on'
$fn$;

CREATE OR REPLACE FUNCTION community_budgets_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF budget_unlock_in_progress() THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'active') THEN
      RAISE EXCEPTION 'the FY% budget is approved and locked; it cannot be deleted (reopen it first, with a reason)', OLD.fiscal_year;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved', 'active') THEN
    RAISE EXCEPTION 'the FY% budget is approved and locked; it cannot be changed in place (reopen it first, with a reason)', OLD.fiscal_year;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_community_budgets_lock_guard ON community_budgets;
CREATE TRIGGER trg_community_budgets_lock_guard BEFORE UPDATE OR DELETE ON community_budgets
  FOR EACH ROW EXECUTE FUNCTION community_budgets_lock_guard();

CREATE OR REPLACE FUNCTION budget_line_items_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE st text; fy integer;
BEGIN
  IF budget_unlock_in_progress() THEN RETURN coalesce(NEW, OLD); END IF;
  SELECT status, fiscal_year INTO st, fy FROM community_budgets WHERE id = coalesce(NEW.budget_id, OLD.budget_id);
  IF st IN ('approved', 'active') THEN
    RAISE EXCEPTION 'the FY% budget is approved and locked; its lines cannot be added, changed or removed (reopen it first, with a reason)', fy;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.budget_id <> OLD.budget_id THEN
    SELECT status INTO st FROM community_budgets WHERE id = OLD.budget_id;
    IF st IN ('approved', 'active') THEN RAISE EXCEPTION 'a line cannot be moved out of a locked budget'; END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$fn$;
DROP TRIGGER IF EXISTS trg_budget_line_items_lock_guard ON budget_line_items;
CREATE TRIGGER trg_budget_line_items_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_line_items
  FOR EACH ROW EXECUTE FUNCTION budget_line_items_lock_guard();

-- 3) Log every approval (insert as approved, or draft -> approved).
CREATE OR REPLACE FUNCTION community_budgets_log_approval() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status IN ('approved', 'active') AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('approved', 'active')) THEN
    INSERT INTO community_budget_events (budget_id, community_id, fiscal_year, event, actor)
    VALUES (NEW.id, NEW.community_id, NEW.fiscal_year, 'approved', NEW.approved_by_user_id::text);
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_community_budgets_log_approval ON community_budgets;
CREATE TRIGGER trg_community_budgets_log_approval AFTER INSERT OR UPDATE OF status ON community_budgets
  FOR EACH ROW EXECUTE FUNCTION community_budgets_log_approval();

-- 4) The one sanctioned way to change an approved budget: reopen, logged.
CREATE OR REPLACE FUNCTION reopen_community_budget(p_budget_id uuid, p_reason text, p_by text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE b community_budgets%ROWTYPE;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_by), '') = '' THEN
    RAISE EXCEPTION 'reopening an approved budget needs a reason and who is doing it';
  END IF;
  SELECT * INTO b FROM community_budgets WHERE id = p_budget_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'budget % not found', p_budget_id; END IF;
  IF b.status NOT IN ('approved', 'active') THEN RAISE EXCEPTION 'the FY% budget is not approved (status %)', b.fiscal_year, b.status; END IF;
  PERFORM set_config('trusted.budget_unlock', 'on', true);
  UPDATE community_budgets SET status = 'draft', approved_at = NULL WHERE id = b.id;
  INSERT INTO community_budget_events (budget_id, community_id, fiscal_year, event, actor, reason)
  VALUES (b.id, b.community_id, b.fiscal_year, 'reopened', btrim(p_by), btrim(p_reason));
  PERFORM set_config('trusted.budget_unlock', 'off', true);
  RETURN jsonb_build_object('reopened', true, 'budget_id', b.id, 'fiscal_year', b.fiscal_year, 'previous_status', b.status);
END;
$$;
REVOKE ALL ON FUNCTION reopen_community_budget(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reopen_community_budget(uuid, text, text) TO service_role;

-- 5) Guards: nothing existing changed.
DO $guard$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM _m462_before;
  IF b.lines_h <> (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || coalesce(fund_id::text, '') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items)
  OR b.hdr_h <> (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) THEN
    RAISE EXCEPTION 'guard: budget rows changed';
  END IF;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) THEN
    RAISE EXCEPTION 'guard: GL changed';
  END IF;
  --@@END@@
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';
