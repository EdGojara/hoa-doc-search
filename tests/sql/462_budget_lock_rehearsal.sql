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

DO $t$
DECLARE
  cid uuid; bid uuid; l record; other_acct uuid; h0 text; h1 text; hdr0 text; je0 text; jl0 text; ok boolean; msg text; n int; r jsonb;
  res text := '';
BEGIN
  SELECT id INTO cid FROM communities WHERE name = 'Lakes of Pine Forest';
  SELECT id INTO bid FROM community_budgets WHERE community_id = cid AND fiscal_year = 2026;
  IF bid IS NULL THEN RAISE EXCEPTION 'no LOPF FY2026 budget'; END IF;
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)), count(*) INTO h0, n FROM budget_line_items WHERE budget_id = bid;
  SELECT md5(id::text || status || coalesce(approved_at::text,'') || coalesce(source_filename,'')) INTO hdr0 FROM community_budgets WHERE id = bid;
  SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) INTO je0 FROM journal_entries;
  SELECT count(*)::text || ':' || sum(debit_cents)::text || ':' || sum(credit_cents)::text INTO jl0 FROM journal_entry_lines;
  res := res || format('lines=%s; ', n);
  SELECT * INTO l FROM budget_line_items WHERE budget_id = bid ORDER BY id LIMIT 1;
  SELECT id INTO other_acct FROM chart_of_accounts WHERE community_id = cid AND id NOT IN (SELECT account_id FROM budget_line_items WHERE budget_id = bid) LIMIT 1;

  -- each blocked mutation must fail with the lock message
  ok := false; BEGIN UPDATE budget_line_items SET annual_amount_cents = annual_amount_cents + 1 WHERE id = l.id; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; msg := SQLERRM; END;
  IF NOT ok THEN RAISE EXCEPTION 'line UPDATE not blocked'; END IF; res := res || 'line update BLOCKED ("' || msg || '"); ';
  ok := false; BEGIN UPDATE budget_line_items SET monthly_amounts_cents = monthly_amounts_cents WHERE budget_id = bid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'months UPDATE not blocked'; END IF; res := res || 'months update BLOCKED; ';
  ok := false; BEGIN INSERT INTO budget_line_items (budget_id, account_id, annual_amount_cents, monthly_amounts_cents) VALUES (bid, other_acct, 1200, ARRAY[100,100,100,100,100,100,100,100,100,100,100,100]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'line INSERT not blocked'; END IF; res := res || 'line insert BLOCKED; ';
  ok := false; BEGIN DELETE FROM budget_line_items WHERE budget_id = bid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'line DELETE not blocked'; END IF; res := res || 'line delete BLOCKED; ';
  ok := false; BEGIN UPDATE community_budgets SET notes = 'x' WHERE id = bid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'header UPDATE not blocked'; END IF; res := res || 'header edit BLOCKED; ';
  ok := false; BEGIN UPDATE community_budgets SET status = 'draft' WHERE id = bid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'direct un-approve not blocked'; END IF; res := res || 'direct un-approve BLOCKED; ';
  ok := false; BEGIN DELETE FROM community_budgets WHERE id = bid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; msg := SQLERRM; END;
  IF NOT ok THEN RAISE EXCEPTION 'header DELETE not blocked'; END IF; res := res || 'budget delete BLOCKED ("' || msg || '"); ';
  ok := false; BEGIN PERFORM reopen_community_budget(bid, '  ', 'test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%reason%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'reopen without reason allowed'; END IF; res := res || 'reopen w/o reason REFUSED; ';
  IF budget_unlock_in_progress() THEN RAISE EXCEPTION 'unlock flag leaked'; END IF;

  -- sanctioned path: reopen (logged) -> edit -> restore -> re-approve (logged) -> locked again
  r := reopen_community_budget(bid, 'rehearsal', 'rehearsal@test');
  IF budget_unlock_in_progress() THEN RAISE EXCEPTION 'unlock flag left on after reopen'; END IF;
  IF (SELECT status FROM community_budgets WHERE id = bid) <> 'draft' THEN RAISE EXCEPTION 'reopen did not return to draft'; END IF;
  IF NOT EXISTS (SELECT 1 FROM community_budget_events WHERE budget_id = bid AND event = 'reopened' AND reason = 'rehearsal') THEN RAISE EXCEPTION 'reopen not logged'; END IF;
  UPDATE budget_line_items SET annual_amount_cents = annual_amount_cents + 1 WHERE id = l.id;
  UPDATE budget_line_items SET annual_amount_cents = l.annual_amount_cents WHERE id = l.id;
  UPDATE community_budgets SET status = 'approved' WHERE id = bid;
  IF NOT EXISTS (SELECT 1 FROM community_budget_events WHERE budget_id = bid AND event = 'approved') THEN RAISE EXCEPTION 'approval not logged'; END IF;
  ok := false; BEGIN UPDATE budget_line_items SET annual_amount_cents = annual_amount_cents + 1 WHERE id = l.id; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%locked%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'not re-locked after approve'; END IF;
  res := res || 'reopen->edit->re-approve OK, logged, re-locked; ';
  ok := false; BEGIN UPDATE community_budget_events SET reason = 'x' WHERE budget_id = bid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%permanent%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'events not append-only'; END IF; res := res || 'event log append-only; ';

  -- nothing moved
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h1 FROM budget_line_items WHERE budget_id = bid;
  IF h1 <> h0 THEN RAISE EXCEPTION 'LOPF lines/months changed'; END IF;
  IF je0 <> (SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) FROM journal_entries) THEN RAISE EXCEPTION 'JE changed'; END IF;
  IF jl0 <> (SELECT count(*)::text || ':' || sum(debit_cents)::text || ':' || sum(credit_cents)::text FROM journal_entry_lines) THEN RAISE EXCEPTION 'journal lines changed'; END IF;
  res := res || 'LOPF lines hash ' || h0 || ' unchanged; GL unchanged';
  RAISE EXCEPTION 'REHEARSAL_OK %', res;
END
$t$;
