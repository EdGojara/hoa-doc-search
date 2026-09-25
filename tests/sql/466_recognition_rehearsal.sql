-- ============================================================================
-- 466_recognition_schedules_controls.sql          *** DRAFT — NOT APPLIED ***
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (the HOA's books: schedules, the months
-- they recognize, the journal entries they generate, and their audit trail).
--
-- WHY (Phase 3C, Ed 2026-09-25):
--   billing / payment event -> balance-sheet position -> recognition schedule
--   -> monthly P&L. The forecast must read P&L timing from the schedule, never
--   infer it from billing, invoice or payment dates.
--
-- EXTENDS the live recognition engine (migrations 235 + 253); no parallel silo.
-- Gaps closed:
--   * posting was NOT atomic (JE header, lines and the posting row were three
--     separate writes; the JE was written before the idempotency row, so two
--     concurrent runs could both post a journal) -> post_recognition_period()
--     does all of it in one transaction under a row lock, and the GL itself
--     refuses a second recognition JE for the same schedule/month attempt.
--   * no explicit month rows -> recognition_schedule_periods is the single
--     source of truth for "how much in which month" (ties to the total, exact).
--   * no reversal path -> reverse_recognition_posting(): offsetting JE, original
--     voided exactly like voidJournalEntry(), reversal row appended; nothing is
--     deleted or edited.
--   * no audit trail -> recognition_events (append-only).
--   * no locks -> an approved/active schedule's amounts, accounts and months are
--     fixed; postings are append-only; recognition above the total is refused.
--   * CASCADE deletes on schedules/postings -> RESTRICT.
--   * forecast integration: forecast method 'recognition_schedule' (additive
--     change to the 465 method list only; 465 objects otherwise untouched).
--
-- BACKFILL: the 3 existing schedules get their period rows (calculated with the
-- engine's exact rules) and account ids; the 11 existing postings are verified
-- against those rows and kept as-is. No journal entry is created or changed.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m466_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items) AS bl_h,
  (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) AS bh_h,
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) AS jel_h,
  (SELECT md5(coalesce(string_agg(id::text || schedule_id::text || period_month::text || amount_cents::text || coalesce(journal_entry_id::text, ''), '|' ORDER BY id), '')) FROM recognition_postings) AS rp_h,
  (SELECT count(*) FROM recognition_schedules) AS rs_n;

-- 0) GL source + idempotency ------------------------------------------------------
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_module_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_module_check
  CHECK (source_module IN (
    'manual','assessment_billing','payment_intake','bank_reconciliation',
    'vantaca_import','ar_snapshot','reserve_transfer','closing_entry',
    'opening_entry','reversal','system','ap_invoice','certified_letter_fee',
    'ap_billback','recognition'
  ));
-- One recognition journal per schedule/month/attempt: a retry can never post twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_je_recognition_source_ref
  ON journal_entries (community_id, source_reference) WHERE source_module = 'recognition';

CREATE OR REPLACE FUNCTION recognition_flag(p_name text) RETURNS boolean
LANGUAGE sql STABLE AS $fn$ SELECT coalesce(current_setting('trusted.' || p_name, true), '') = 'on' $fn$;

-- 1) Schedules: provenance, accounts by id, method, basis, approval ----------------
ALTER TABLE recognition_schedules
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS source_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS balance_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS recognition_account_id uuid REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS fund_id uuid REFERENCES account_funds(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS recognition_method text NOT NULL DEFAULT 'straight_line_monthly',
  ADD COLUMN IF NOT EXISTS schedule_basis text NOT NULL DEFAULT 'calculated',
  ADD COLUMN IF NOT EXISTS explanation text,
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE recognition_schedules DROP CONSTRAINT IF EXISTS recognition_schedules_source_type_check;
ALTER TABLE recognition_schedules ADD CONSTRAINT recognition_schedules_source_type_check
  CHECK (source_type IN ('ap_invoice', 'assessment_billing', 'conversion_balance', 'contract', 'manual', 'legacy'));
ALTER TABLE recognition_schedules DROP CONSTRAINT IF EXISTS recognition_schedules_recognition_method_check;
ALTER TABLE recognition_schedules ADD CONSTRAINT recognition_schedules_recognition_method_check
  CHECK (recognition_method IN ('straight_line_monthly', 'daily', 'documented_schedule', 'manual'));
ALTER TABLE recognition_schedules DROP CONSTRAINT IF EXISTS recognition_schedules_schedule_basis_check;
ALTER TABLE recognition_schedules ADD CONSTRAINT recognition_schedules_schedule_basis_check
  CHECK (schedule_basis IN ('documented', 'calculated', 'manual'));
ALTER TABLE recognition_schedules DROP CONSTRAINT IF EXISTS recognition_schedules_status_check;
ALTER TABLE recognition_schedules ADD CONSTRAINT recognition_schedules_status_check
  CHECK (status IN ('draft', 'active', 'fully_recognized', 'cancelled'));
ALTER TABLE recognition_schedules DROP CONSTRAINT IF EXISTS recognition_schedules_cancel_audit;
ALTER TABLE recognition_schedules ADD CONSTRAINT recognition_schedules_cancel_audit
  CHECK (status <> 'cancelled' OR (coalesce(btrim(cancel_reason), '') <> '' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL));
ALTER TABLE recognition_schedules DROP CONSTRAINT IF EXISTS recognition_schedules_community_id_fkey;
ALTER TABLE recognition_schedules ADD CONSTRAINT recognition_schedules_community_id_fkey
  FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_recog_sched_recognition_account ON recognition_schedules (recognition_account_id) WHERE recognition_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recog_sched_source ON recognition_schedules (source_type, source_id) WHERE source_id IS NOT NULL;

-- 2) Period rows: the schedule's months (single source of truth) -------------------
CREATE TABLE IF NOT EXISTS recognition_schedule_periods (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id      uuid NOT NULL REFERENCES recognition_schedules(id) ON DELETE CASCADE,
  period_month     date NOT NULL CHECK (extract(day FROM period_month) = 1),
  scheduled_cents  bigint NOT NULL CHECK (scheduled_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_month)
);
COMMENT ON TABLE recognition_schedule_periods IS 'association_record: the amount a recognition schedule moves to the income statement in each month. Sums exactly to the schedule total; fixed once the schedule is approved.';
GRANT SELECT, INSERT, UPDATE, DELETE ON recognition_schedule_periods TO service_role;
GRANT SELECT ON recognition_schedule_periods TO authenticated;

-- Exact-to-the-cent calculated months; mirrors lib/accounting/recognition_schedule.js
-- and the live engine (straight-line with last-month stub; daily = differences of
-- cumulative-day roundings).
CREATE OR REPLACE FUNCTION recognition_calculated_periods(p_total bigint, p_start date, p_term int, p_monthly bigint, p_method text, p_pstart date, p_pend date)
RETURNS TABLE (period_month date, scheduled_cents bigint)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE k int; m date; me date; tot_days int; d int; cum bigint; prev bigint := 0; last bigint;
BEGIN
  IF p_total IS NULL OR p_total <= 0 OR p_term IS NULL OR p_term <= 0 THEN RAISE EXCEPTION 'recognition needs a positive total and term'; END IF;
  IF p_method = 'daily' THEN
    IF p_pstart IS NULL OR p_pend IS NULL OR p_pend < p_pstart THEN RAISE EXCEPTION 'daily recognition needs period_start <= period_end'; END IF;
    tot_days := (p_pend - p_pstart) + 1;
    FOR k IN 0 .. p_term - 1 LOOP
      m := (date_trunc('month', p_start) + make_interval(months => k))::date;
      me := (m + interval '1 month' - interval '1 day')::date;
      IF least(me, p_pend) < p_pstart THEN cum := 0;
      ELSE d := least((least(me, p_pend) - p_pstart) + 1, tot_days); cum := round(d::numeric * p_total / tot_days)::bigint; END IF;
      period_month := m; scheduled_cents := cum - prev; prev := cum; RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;
  IF p_monthly IS NULL OR p_monthly < 0 THEN RAISE EXCEPTION 'straight-line recognition needs a monthly amount'; END IF;
  last := p_total - p_monthly * (p_term - 1);
  IF last < 0 THEN RAISE EXCEPTION 'monthly amount % is too large for total % over % months', p_monthly, p_total, p_term; END IF;
  FOR k IN 0 .. p_term - 1 LOOP
    period_month := (date_trunc('month', p_start) + make_interval(months => k))::date;
    scheduled_cents := CASE WHEN k = p_term - 1 THEN last ELSE p_monthly END;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

-- 3) Postings: append-only, explicit reversals -------------------------------------
ALTER TABLE recognition_postings
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'recognition',
  ADD COLUMN IF NOT EXISTS reverses_posting_id uuid REFERENCES recognition_postings(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversed_by_posting_id uuid REFERENCES recognition_postings(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_reference text,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS actor text;
ALTER TABLE recognition_postings DROP CONSTRAINT IF EXISTS recognition_postings_kind_check;
ALTER TABLE recognition_postings ADD CONSTRAINT recognition_postings_kind_check CHECK (
  (kind = 'recognition' AND amount_cents > 0 AND reverses_posting_id IS NULL)
  OR (kind = 'reversal' AND amount_cents < 0 AND reverses_posting_id IS NOT NULL AND reversed_by_posting_id IS NULL AND coalesce(btrim(reason), '') <> '' AND actor IS NOT NULL));
ALTER TABLE recognition_postings DROP CONSTRAINT IF EXISTS recognition_postings_schedule_id_period_month_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recognition_postings_effective
  ON recognition_postings (schedule_id, period_month) WHERE kind = 'recognition' AND reversed_by_posting_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recognition_postings_one_reversal
  ON recognition_postings (reverses_posting_id) WHERE reverses_posting_id IS NOT NULL;
ALTER TABLE recognition_postings DROP CONSTRAINT IF EXISTS recognition_postings_schedule_id_fkey;
ALTER TABLE recognition_postings ADD CONSTRAINT recognition_postings_schedule_id_fkey
  FOREIGN KEY (schedule_id) REFERENCES recognition_schedules(id) ON DELETE RESTRICT;
ALTER TABLE recognition_postings DROP CONSTRAINT IF EXISTS recognition_postings_journal_entry_id_fkey;
ALTER TABLE recognition_postings ADD CONSTRAINT recognition_postings_journal_entry_id_fkey
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE RESTRICT;
ALTER TABLE recognition_postings ALTER COLUMN journal_entry_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recognition_postings_schedule ON recognition_postings (schedule_id, period_month);
CREATE INDEX IF NOT EXISTS idx_recognition_postings_je ON recognition_postings (journal_entry_id);

-- 4) Events (append-only) --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recognition_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id      uuid NOT NULL REFERENCES recognition_schedules(id) ON DELETE RESTRICT,
  community_id     uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  event            text NOT NULL CHECK (event IN ('created', 'approved', 'posted', 'reversed', 'cancelled', 'completed', 'reopened', 'backfilled')),
  period_month     date,
  posting_id       uuid REFERENCES recognition_postings(id) ON DELETE RESTRICT,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  amount_cents     bigint,
  detail           jsonb,
  actor            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE recognition_events IS 'association_record: every recognition schedule change, posting and reversal, who and when. Append-only.';
CREATE INDEX IF NOT EXISTS idx_recognition_events_schedule ON recognition_events (schedule_id, created_at);
GRANT SELECT, INSERT ON recognition_events TO service_role;
GRANT SELECT ON recognition_events TO authenticated;
CREATE OR REPLACE FUNCTION recognition_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'recognition events are permanent (event %)', OLD.id; END; $fn$;
DROP TRIGGER IF EXISTS trg_recognition_events_append_only ON recognition_events;
CREATE TRIGGER trg_recognition_events_append_only BEFORE UPDATE OR DELETE ON recognition_events FOR EACH ROW EXECUTE FUNCTION recognition_events_append_only();

-- 5) Backfill the existing schedules (before the guards exist) ------------------------
UPDATE recognition_schedules s SET
  balance_account_id = coa.id,
  fund_id = coa.fund_id,
  source_type = 'legacy',
  recognition_method = CASE WHEN s.recognition_basis = 'daily' THEN 'daily' ELSE 'straight_line_monthly' END,
  schedule_basis = 'calculated',
  recognition_account_id = (SELECT c2.id FROM recognition_schedule_segments g JOIN chart_of_accounts c2 ON c2.community_id = s.community_id AND c2.account_number = g.income_account_number
                            WHERE g.schedule_id = s.id AND (SELECT count(*) FROM recognition_schedule_segments g2 WHERE g2.schedule_id = s.id) = 1)
FROM chart_of_accounts coa
WHERE coa.community_id = s.community_id AND coa.account_number = s.balance_account_number AND s.balance_account_id IS NULL;

INSERT INTO recognition_schedule_periods (schedule_id, period_month, scheduled_cents)
SELECT s.id, p.period_month, p.scheduled_cents
FROM recognition_schedules s
CROSS JOIN LATERAL recognition_calculated_periods(s.recognize_amount_cents, s.start_month, s.term_months, s.monthly_amount_cents, s.recognition_method, s.period_start, s.period_end) p
WHERE NOT EXISTS (SELECT 1 FROM recognition_schedule_periods x WHERE x.schedule_id = s.id);

UPDATE recognition_postings SET actor = 'legacy engine' WHERE actor IS NULL;

INSERT INTO recognition_events (schedule_id, community_id, event, detail, actor)
SELECT s.id, s.community_id, 'backfilled',
       jsonb_build_object('periods', (SELECT count(*) FROM recognition_schedule_periods WHERE schedule_id = s.id),
                          'postings', (SELECT count(*) FROM recognition_postings WHERE schedule_id = s.id),
                          'recognized_cents', (SELECT coalesce(sum(amount_cents), 0) FROM recognition_postings WHERE schedule_id = s.id)),
       'migration 466'
FROM recognition_schedules s;

DO $bf$
DECLARE bad text;
BEGIN
  SELECT string_agg(s.description, '; ') INTO bad FROM recognition_schedules s WHERE s.balance_account_id IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'backfill: balance account not resolved for %', bad; END IF;
  SELECT string_agg(s.description, '; ') INTO bad FROM recognition_schedules s
   WHERE (SELECT coalesce(sum(scheduled_cents), -1) FROM recognition_schedule_periods WHERE schedule_id = s.id) <> s.recognize_amount_cents;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'backfill: periods do not tie for %', bad; END IF;
  SELECT string_agg(p.id::text, ', ') INTO bad FROM recognition_postings p
   LEFT JOIN recognition_schedule_periods rp ON rp.schedule_id = p.schedule_id AND rp.period_month = p.period_month
   LEFT JOIN journal_entries j ON j.id = p.journal_entry_id
   WHERE rp.id IS NULL OR rp.scheduled_cents <> p.amount_cents OR j.id IS NULL OR j.total_debits_cents <> p.amount_cents;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'backfill: existing postings do not match their schedule months: %', bad; END IF;
  SELECT string_agg(s.description, '; ') INTO bad FROM recognition_schedules s
   WHERE (SELECT coalesce(sum(amount_cents), 0) FROM recognition_postings WHERE schedule_id = s.id) > s.recognize_amount_cents;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'backfill: over-recognized %', bad; END IF;
END
$bf$;

-- 6) Schedule guard: resolve accounts, lock once approved, controlled transitions ----
CREATE OR REPLACE FUNCTION recognition_schedules_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE a record; unlocked boolean := recognition_flag('recognition_unlock');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recognition schedules are not deleted; cancel it instead (schedule %)', OLD.id;
  END IF;
  -- Resolve the balance account by number (legacy callers) or id, and validate it.
  IF NEW.balance_account_id IS NULL THEN
    SELECT id INTO NEW.balance_account_id FROM chart_of_accounts WHERE community_id = NEW.community_id AND account_number = NEW.balance_account_number;
  END IF;
  SELECT community_id, account_number, account_type, fund_id INTO a FROM chart_of_accounts WHERE id = NEW.balance_account_id;
  IF a IS NULL OR a.community_id <> NEW.community_id THEN RAISE EXCEPTION 'balance-sheet account % not found in this community', NEW.balance_account_number; END IF;
  NEW.balance_account_number := a.account_number;
  IF TG_OP = 'INSERT' OR NEW.balance_account_id IS DISTINCT FROM OLD.balance_account_id THEN
    IF NEW.schedule_type = 'prepaid_expense' AND a.account_type <> 'asset' THEN RAISE EXCEPTION 'a prepaid expense draws down an asset account (% is %)', a.account_number, a.account_type; END IF;
    IF NEW.schedule_type = 'deferred_revenue' AND a.account_type <> 'liability' THEN RAISE EXCEPTION 'deferred revenue draws down a liability account (% is %)', a.account_number, a.account_type; END IF;
    NEW.fund_id := coalesce(NEW.fund_id, a.fund_id);
  END IF;
  IF NEW.recognition_account_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.recognition_account_id IS DISTINCT FROM OLD.recognition_account_id) THEN
    SELECT community_id, account_type INTO a FROM chart_of_accounts WHERE id = NEW.recognition_account_id;
    IF NOT FOUND OR a.community_id <> NEW.community_id THEN RAISE EXCEPTION 'recognition account belongs to another community'; END IF;
    IF NEW.schedule_type = 'prepaid_expense' AND a.account_type <> 'expense' THEN RAISE EXCEPTION 'a prepaid expense is recognized into an expense account'; END IF;
    IF NEW.schedule_type = 'deferred_revenue' AND a.account_type <> 'revenue' THEN RAISE EXCEPTION 'deferred revenue is recognized into a revenue account'; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('fully_recognized', 'cancelled') AND NOT unlocked THEN RAISE EXCEPTION 'a schedule starts as draft or active'; END IF;
    IF NEW.status = 'active' AND NEW.recognition_method IN ('documented_schedule', 'manual') THEN
      RAISE EXCEPTION 'a documented or manual schedule is created as draft, its months entered, then approved';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE (a schedule is never deleted; see DELETE above)
  IF OLD.status <> 'draft' AND NOT unlocked AND (
       NEW.community_id <> OLD.community_id OR NEW.schedule_type <> OLD.schedule_type
    OR NEW.balance_account_id IS DISTINCT FROM OLD.balance_account_id OR NEW.recognition_account_id IS DISTINCT FROM OLD.recognition_account_id
    OR NEW.fund_id IS DISTINCT FROM OLD.fund_id OR NEW.recognize_amount_cents <> OLD.recognize_amount_cents
    OR NEW.start_month <> OLD.start_month OR NEW.term_months <> OLD.term_months OR NEW.monthly_amount_cents <> OLD.monthly_amount_cents
    OR NEW.recognition_basis <> OLD.recognition_basis OR NEW.recognition_method <> OLD.recognition_method
    OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
    OR NEW.source_type <> OLD.source_type OR NEW.source_id IS DISTINCT FROM OLD.source_id) THEN
    RAISE EXCEPTION 'an approved schedule''s amounts, accounts and months are fixed; cancel it and create a new one';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status = 'active' THEN
      IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN RAISE EXCEPTION 'approving a schedule records who approved it and when'; END IF;
    ELSIF NEW.status = 'cancelled' AND OLD.status IN ('draft', 'active') THEN
      NULL;  -- cancel_audit CHECK requires reason + who + when
    ELSIF (OLD.status = 'active' AND NEW.status = 'fully_recognized') OR (OLD.status = 'fully_recognized' AND NEW.status = 'active') THEN
      IF NOT unlocked THEN RAISE EXCEPTION 'completion is set by the posting and reversal functions'; END IF;
    ELSE
      RAISE EXCEPTION 'a schedule cannot move from % to %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_recognition_schedules_guard ON recognition_schedules;
CREATE TRIGGER trg_recognition_schedules_guard BEFORE INSERT OR UPDATE OR DELETE ON recognition_schedules FOR EACH ROW EXECUTE FUNCTION recognition_schedules_guard();

-- Calculated schedules get their months automatically (legacy callers keep working);
-- a draft's calculated months follow its terms until approval.
CREATE OR REPLACE FUNCTION recognition_schedules_after() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE actor text := nullif(current_setting('trusted.actor', true), ''); ev text; prev text := current_setting('trusted.recognition_periods', true);
BEGIN
  IF NEW.recognition_method IN ('straight_line_monthly', 'daily') AND (
       TG_OP = 'INSERT'
    OR (NEW.status = 'draft' AND (NEW.recognize_amount_cents <> OLD.recognize_amount_cents OR NEW.start_month <> OLD.start_month OR NEW.term_months <> OLD.term_months
        OR NEW.monthly_amount_cents <> OLD.monthly_amount_cents OR NEW.recognition_method <> OLD.recognition_method
        OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end))) THEN
    PERFORM set_config('trusted.recognition_periods', 'on', true);
    DELETE FROM recognition_schedule_periods WHERE schedule_id = NEW.id;
    INSERT INTO recognition_schedule_periods (schedule_id, period_month, scheduled_cents)
    SELECT NEW.id, p.period_month, p.scheduled_cents
    FROM recognition_calculated_periods(NEW.recognize_amount_cents, NEW.start_month, NEW.term_months, NEW.monthly_amount_cents, NEW.recognition_method, NEW.period_start, NEW.period_end) p;
    PERFORM set_config('trusted.recognition_periods', coalesce(prev, ''), true);
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO recognition_events (schedule_id, community_id, event, amount_cents, detail, actor)
    VALUES (NEW.id, NEW.community_id, 'created', NEW.recognize_amount_cents,
            jsonb_build_object('status', NEW.status, 'type', NEW.schedule_type, 'method', NEW.recognition_method, 'basis', NEW.schedule_basis, 'source_type', NEW.source_type, 'source_id', NEW.source_id),
            coalesce(actor, NEW.created_by));
  ELSIF NEW.status <> OLD.status THEN
    ev := CASE WHEN NEW.status = 'active' AND OLD.status = 'draft' THEN 'approved'
               WHEN NEW.status = 'active' THEN 'reopened'
               WHEN NEW.status = 'fully_recognized' THEN 'completed'
               ELSE 'cancelled' END;
    INSERT INTO recognition_events (schedule_id, community_id, event, detail, actor)
    VALUES (NEW.id, NEW.community_id, ev, jsonb_build_object('from', OLD.status, 'to', NEW.status, 'reason', NEW.cancel_reason),
            coalesce(actor, CASE ev WHEN 'approved' THEN NEW.approved_by WHEN 'cancelled' THEN NEW.cancelled_by END));
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_recognition_schedules_after ON recognition_schedules;
CREATE TRIGGER trg_recognition_schedules_after AFTER INSERT OR UPDATE ON recognition_schedules FOR EACH ROW EXECUTE FUNCTION recognition_schedules_after();

-- Periods are editable only while the schedule is a draft.
CREATE OR REPLACE FUNCTION recognition_periods_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM recognition_schedules WHERE id = coalesce(NEW.schedule_id, OLD.schedule_id);
  IF st IS DISTINCT FROM 'draft' AND NOT recognition_flag('recognition_periods') THEN
    RAISE EXCEPTION 'the months of an approved schedule are fixed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND NEW.schedule_id <> OLD.schedule_id THEN RAISE EXCEPTION 'a period cannot move to another schedule'; END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_recognition_periods_guard ON recognition_schedule_periods;
CREATE TRIGGER trg_recognition_periods_guard BEFORE INSERT OR UPDATE OR DELETE ON recognition_schedule_periods FOR EACH ROW EXECUTE FUNCTION recognition_periods_guard();

-- Segments (income-statement split) are fixed once anything has been posted.
CREATE OR REPLACE FUNCTION recognition_segments_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM recognition_postings WHERE schedule_id = coalesce(NEW.schedule_id, OLD.schedule_id)) AND NOT recognition_flag('recognition_unlock') THEN
    RAISE EXCEPTION 'the income-statement split is fixed once recognition has posted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_recognition_segments_guard ON recognition_schedule_segments;
CREATE TRIGGER trg_recognition_segments_guard BEFORE INSERT OR UPDATE OR DELETE ON recognition_schedule_segments FOR EACH ROW EXECUTE FUNCTION recognition_segments_guard();
ALTER TABLE recognition_schedule_segments DROP CONSTRAINT IF EXISTS recognition_schedule_segments_schedule_id_fkey;
ALTER TABLE recognition_schedule_segments ADD CONSTRAINT recognition_schedule_segments_schedule_id_fkey
  FOREIGN KEY (schedule_id) REFERENCES recognition_schedules(id) ON DELETE CASCADE;

-- Months tie to the total for every non-draft schedule (checked at commit).
CREATE OR REPLACE FUNCTION recognition_periods_tie(p_schedule_id uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE s record; tot bigint; n int;
BEGIN
  SELECT status, recognize_amount_cents INTO s FROM recognition_schedules WHERE id = p_schedule_id;
  IF s IS NULL OR s.status = 'draft' THEN RETURN; END IF;
  SELECT count(*), coalesce(sum(scheduled_cents), 0) INTO n, tot FROM recognition_schedule_periods WHERE schedule_id = p_schedule_id;
  IF n = 0 OR tot <> s.recognize_amount_cents THEN
    RAISE EXCEPTION 'schedule months total % but the schedule total is % (they must tie exactly)', tot, s.recognize_amount_cents;
  END IF;
END;
$fn$;
CREATE OR REPLACE FUNCTION recognition_periods_tie_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'recognition_schedules' THEN PERFORM recognition_periods_tie(NEW.id);
  ELSE PERFORM recognition_periods_tie(coalesce(NEW.schedule_id, OLD.schedule_id)); END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_recognition_schedules_tie ON recognition_schedules;
CREATE CONSTRAINT TRIGGER trg_recognition_schedules_tie AFTER INSERT OR UPDATE ON recognition_schedules
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recognition_periods_tie_trg();
DROP TRIGGER IF EXISTS trg_recognition_periods_tie ON recognition_schedule_periods;
CREATE CONSTRAINT TRIGGER trg_recognition_periods_tie AFTER INSERT OR UPDATE OR DELETE ON recognition_schedule_periods
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recognition_periods_tie_trg();

-- Posting rows: only the posting/reversal functions write them; every row is
-- verified against its schedule month and its journal entry.
CREATE OR REPLACE FUNCTION recognition_postings_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE s recognition_schedules%ROWTYPE; sched bigint; done bigint; j record; bal bigint; orig recognition_postings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recognition postings are permanent; reverse instead (posting %)', OLD.id; END IF;
  IF NOT recognition_flag('recognition_post') THEN RAISE EXCEPTION 'recognition is posted only by post_recognition_period() / reverse_recognition_posting()'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.schedule_id <> OLD.schedule_id OR NEW.period_month <> OLD.period_month OR NEW.amount_cents <> OLD.amount_cents
       OR NEW.journal_entry_id <> OLD.journal_entry_id OR NEW.kind <> OLD.kind OR NEW.reverses_posting_id IS DISTINCT FROM OLD.reverses_posting_id
       OR OLD.reversed_by_posting_id IS NOT NULL OR NEW.reversed_by_posting_id IS NULL THEN
      RAISE EXCEPTION 'a posting is only ever marked once as reversed';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM recognition_schedules WHERE id = NEW.schedule_id;
  SELECT community_id, status, source_module, source_reference, total_debits_cents, reverses_je_id INTO j FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF j IS NULL OR j.community_id <> s.community_id OR j.status <> 'posted' THEN RAISE EXCEPTION 'posting must link a posted journal entry of the same community'; END IF;
  IF j.total_debits_cents <> abs(NEW.amount_cents) THEN RAISE EXCEPTION 'journal total % does not equal the posting %', j.total_debits_cents, abs(NEW.amount_cents); END IF;
  SELECT coalesce(sum(CASE WHEN (s.schedule_type = 'deferred_revenue') = (NEW.kind = 'recognition') THEN debit_cents ELSE credit_cents END), 0)
    INTO bal FROM journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id AND account_id = s.balance_account_id;
  IF bal <> abs(NEW.amount_cents) THEN RAISE EXCEPTION 'journal does not move the balance-sheet account by the posting amount'; END IF;
  SELECT coalesce(sum(amount_cents), 0) INTO done FROM recognition_postings WHERE schedule_id = NEW.schedule_id;
  IF NEW.kind = 'recognition' THEN
    IF s.status <> 'active' THEN RAISE EXCEPTION 'only an active schedule recognizes'; END IF;
    SELECT scheduled_cents INTO sched FROM recognition_schedule_periods WHERE schedule_id = NEW.schedule_id AND period_month = NEW.period_month;
    IF sched IS NULL THEN RAISE EXCEPTION 'month % is not in this schedule', NEW.period_month; END IF;
    IF NEW.amount_cents <> sched THEN RAISE EXCEPTION 'posting % differs from the scheduled % for %', NEW.amount_cents, sched, NEW.period_month; END IF;
    IF done + NEW.amount_cents > s.recognize_amount_cents THEN RAISE EXCEPTION 'recognition would exceed the schedule total (% + % > %)', done, NEW.amount_cents, s.recognize_amount_cents; END IF;
    IF j.source_module <> 'recognition' OR j.source_reference NOT LIKE 'recognition:' || NEW.schedule_id || ':' || to_char(NEW.period_month, 'YYYY-MM') || ':%' THEN
      RAISE EXCEPTION 'journal is not the recognition entry for this schedule and month';
    END IF;
  ELSE
    SELECT * INTO orig FROM recognition_postings WHERE id = NEW.reverses_posting_id;
    IF orig.schedule_id <> NEW.schedule_id OR orig.period_month <> NEW.period_month OR orig.kind <> 'recognition' OR NEW.amount_cents <> -orig.amount_cents THEN
      RAISE EXCEPTION 'a reversal mirrors exactly one recognition posting';
    END IF;
    IF j.source_module <> 'reversal' OR j.reverses_je_id IS DISTINCT FROM orig.journal_entry_id THEN RAISE EXCEPTION 'reversal must link the journal that reverses the original'; END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_recognition_postings_guard ON recognition_postings;
CREATE TRIGGER trg_recognition_postings_guard BEFORE INSERT OR UPDATE OR DELETE ON recognition_postings FOR EACH ROW EXECUTE FUNCTION recognition_postings_guard();

-- 7) Posting: one month, atomically ---------------------------------------------------
CREATE OR REPLACE FUNCTION post_recognition_period(p_schedule_id uuid, p_period_month date, p_actor text, p_posting_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  s recognition_schedules%ROWTYPE; m date := date_trunc('month', p_period_month)::date; amt bigint; done bigint; pd date;
  per record; bal record; is_rev boolean; seq int; srcref text; ref text; je_id uuid; pid uuid;
  accts uuid[] := '{}'; amts bigint[] := '{}'; labels text[] := '{}'; seg record; segsum bigint := 0; i int; a record; ln int := 0; remaining_after bigint;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'recognition posting needs who is posting it'; END IF;
  SELECT * INTO s FROM recognition_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'schedule % not found', p_schedule_id; END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'schedule is % (only an active schedule posts)', s.status; END IF;
  SELECT scheduled_cents INTO amt FROM recognition_schedule_periods WHERE schedule_id = s.id AND period_month = m;
  IF amt IS NULL THEN RAISE EXCEPTION 'month % is not in this schedule', to_char(m, 'YYYY-MM'); END IF;
  IF amt = 0 THEN RAISE EXCEPTION 'nothing is scheduled for %', to_char(m, 'YYYY-MM'); END IF;
  IF EXISTS (SELECT 1 FROM recognition_postings WHERE schedule_id = s.id AND period_month = m AND kind = 'recognition' AND reversed_by_posting_id IS NULL) THEN
    RAISE EXCEPTION 'already recognized: % for %', s.description, to_char(m, 'YYYY-MM');
  END IF;
  SELECT coalesce(sum(amount_cents), 0) INTO done FROM recognition_postings WHERE schedule_id = s.id;
  IF done + amt > s.recognize_amount_cents THEN RAISE EXCEPTION 'recognition would exceed the schedule total'; END IF;
  pd := coalesce(p_posting_date, m);
  IF date_trunc('month', pd)::date <> m THEN RAISE EXCEPTION 'the posting date must fall in the recognition month %', to_char(m, 'YYYY-MM'); END IF;
  SELECT id, fiscal_year INTO per FROM accounting_periods
   WHERE community_id = s.community_id AND period_start <= pd AND period_end >= pd AND status IN ('open', 'reopened')
   ORDER BY period_start LIMIT 1;
  IF per IS NULL THEN RAISE EXCEPTION 'no open accounting period for % (closed periods take an adjusting entry)', pd; END IF;
  SELECT id, account_number, fund_id, is_active, is_summary INTO bal FROM chart_of_accounts WHERE id = s.balance_account_id;
  IF NOT coalesce(bal.is_active, false) OR coalesce(bal.is_summary, false) THEN RAISE EXCEPTION 'balance-sheet account % cannot take postings', bal.account_number; END IF;
  is_rev := s.schedule_type = 'deferred_revenue';

  -- Income-statement side: segments (rounding/stub absorbed by the largest), else the recognition account.
  FOR seg IN SELECT g.income_account_number, g.label, g.monthly_amount_cents FROM recognition_schedule_segments g WHERE g.schedule_id = s.id
             ORDER BY g.monthly_amount_cents DESC, g.id LOOP
    SELECT id INTO a FROM chart_of_accounts WHERE community_id = s.community_id AND account_number = seg.income_account_number;
    IF a IS NULL THEN RAISE EXCEPTION 'segment account % not in this community', seg.income_account_number; END IF;
    accts := accts || a.id; amts := amts || seg.monthly_amount_cents; labels := labels || coalesce(seg.label, seg.income_account_number);
    segsum := segsum + seg.monthly_amount_cents;
  END LOOP;
  IF array_length(accts, 1) IS NULL THEN
    IF s.recognition_account_id IS NULL THEN RAISE EXCEPTION 'schedule has no income-statement account'; END IF;
    accts := ARRAY[s.recognition_account_id]; amts := ARRAY[amt]; labels := ARRAY['recognition'];
  ELSE
    amts[1] := amts[1] + (amt - segsum);
    IF amts[1] < 0 THEN RAISE EXCEPTION 'segment split cannot absorb this month''s amount'; END IF;
  END IF;
  FOR i IN 1 .. array_length(accts, 1) LOOP
    SELECT community_id, account_number, account_type, fund_id, is_active, is_summary INTO a FROM chart_of_accounts WHERE id = accts[i];
    IF a.community_id <> s.community_id OR NOT coalesce(a.is_active, false) OR coalesce(a.is_summary, false) THEN RAISE EXCEPTION 'income-statement account % cannot take postings', a.account_number; END IF;
    IF a.account_type <> (CASE WHEN is_rev THEN 'revenue' ELSE 'expense' END) THEN RAISE EXCEPTION 'account % is not a % account', a.account_number, (CASE WHEN is_rev THEN 'revenue' ELSE 'expense' END); END IF;
    IF a.fund_id IS DISTINCT FROM bal.fund_id THEN RAISE EXCEPTION 'cross-fund recognition (% vs %) needs an interfund bridge; not posted', a.account_number, bal.account_number; END IF;
  END LOOP;

  SELECT count(*) + 1 INTO seq FROM recognition_postings WHERE schedule_id = s.id AND period_month = m AND kind = 'recognition';
  srcref := 'recognition:' || s.id || ':' || to_char(m, 'YYYY-MM') || ':' || seq;
  ref := next_je_reference(s.community_id, per.fiscal_year);
  INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference,
                               total_debits_cents, total_credits_cents, status, notes)
  VALUES (s.community_id, per.id, pd, ref,
          s.description || ' — ' || CASE WHEN is_rev THEN 'revenue recognition' ELSE 'amortization' END || ' (' || to_char(m, 'YYYY-MM') || ')',
          'recognition', srcref, amt, amt, 'posted', 'Recognition schedule ' || s.id || '; posted by ' || btrim(p_actor))
  RETURNING id INTO je_id;
  FOR i IN 1 .. array_length(accts, 1) LOOP
    CONTINUE WHEN amts[i] = 0;
    ln := ln + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo)
    SELECT je_id, ln, accts[i], c.fund_id, CASE WHEN is_rev THEN 0 ELSE amts[i] END, CASE WHEN is_rev THEN amts[i] ELSE 0 END,
           s.description || ' — ' || labels[i]
    FROM chart_of_accounts c WHERE c.id = accts[i];
  END LOOP;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo)
  VALUES (je_id, ln + 1, bal.id, bal.fund_id, CASE WHEN is_rev THEN amt ELSE 0 END, CASE WHEN is_rev THEN 0 ELSE amt END,
          s.description || ' — ' || CASE WHEN is_rev THEN 'unearned recognized' ELSE 'prepaid drawdown' END);

  PERFORM set_config('trusted.recognition_post', 'on', true);
  INSERT INTO recognition_postings (schedule_id, period_month, journal_entry_id, amount_cents, kind, source_reference, actor)
  VALUES (s.id, m, je_id, amt, 'recognition', srcref, btrim(p_actor)) RETURNING id INTO pid;
  PERFORM set_config('trusted.recognition_post', 'off', true);
  INSERT INTO recognition_events (schedule_id, community_id, event, period_month, posting_id, journal_entry_id, amount_cents, detail, actor)
  VALUES (s.id, s.community_id, 'posted', m, pid, je_id, amt, jsonb_build_object('reference', ref, 'source_reference', srcref), btrim(p_actor));

  SELECT s.recognize_amount_cents - coalesce(sum(amount_cents), 0) INTO remaining_after FROM recognition_postings WHERE schedule_id = s.id;
  IF remaining_after = 0 THEN
    PERFORM set_config('trusted.recognition_unlock', 'on', true);
    UPDATE recognition_schedules SET status = 'fully_recognized' WHERE id = s.id;
    PERFORM set_config('trusted.recognition_unlock', 'off', true);
  END IF;
  RETURN pid;
END;
$$;

-- 8) Reversal: explicit, audited, never destructive ------------------------------------
CREATE OR REPLACE FUNCTION reverse_recognition_posting(p_posting_id uuid, p_reason text, p_actor text, p_reversal_date date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE p recognition_postings%ROWTYPE; s recognition_schedules%ROWTYPE; o journal_entries%ROWTYPE; rd date; per record; ref text; rev_id uuid; rid uuid;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reversal needs a reason'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'a reversal needs who is reversing'; END IF;
  SELECT * INTO p FROM recognition_postings WHERE id = p_posting_id FOR UPDATE;
  IF NOT FOUND OR p.kind <> 'recognition' THEN RAISE EXCEPTION 'only a recognition posting can be reversed'; END IF;
  IF p.reversed_by_posting_id IS NOT NULL THEN RAISE EXCEPTION 'posting % is already reversed', p_posting_id; END IF;
  SELECT * INTO s FROM recognition_schedules WHERE id = p.schedule_id FOR UPDATE;
  SELECT * INTO o FROM journal_entries WHERE id = p.journal_entry_id FOR UPDATE;
  IF o.status <> 'posted' THEN RAISE EXCEPTION 'the original journal % is %', o.reference, o.status; END IF;
  rd := coalesce(p_reversal_date, current_date);
  SELECT id, fiscal_year INTO per FROM accounting_periods
   WHERE community_id = s.community_id AND period_start <= rd AND period_end >= rd AND status IN ('open', 'reopened') ORDER BY period_start LIMIT 1;
  IF per IS NULL THEN RAISE EXCEPTION 'no open accounting period for reversal date %', rd; END IF;
  ref := next_je_reference(s.community_id, per.fiscal_year);
  -- Same shape as voidJournalEntry(): offsetting entry + original flipped to voided.
  INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference,
                               total_debits_cents, total_credits_cents, reverses_je_id, status, notes)
  VALUES (s.community_id, per.id, rd, ref, 'VOID: ' || o.reference || ' — ' || btrim(p_reason), 'reversal', o.id::text,
          o.total_debits_cents, o.total_credits_cents, o.id, 'posted',
          'Reverses ' || o.reference || ' posted ' || o.posting_date || '. Recognition reversal by ' || btrim(p_actor) || ': ' || btrim(p_reason))
  RETURNING id INTO rev_id;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo, property_id, vendor_id, bank_account_id)
  SELECT rev_id, l.line_number, l.account_id, l.fund_id, l.credit_cents, l.debit_cents, btrim('Reversal of ' || o.reference || ': ' || coalesce(l.memo, '')), l.property_id, l.vendor_id, l.bank_account_id
  FROM journal_entry_lines l WHERE l.journal_entry_id = o.id;
  UPDATE journal_entries SET status = 'voided', voided_at = now(), void_reason = btrim(p_reason), void_reversal_je_id = rev_id WHERE id = o.id;

  PERFORM set_config('trusted.recognition_post', 'on', true);
  INSERT INTO recognition_postings (schedule_id, period_month, journal_entry_id, amount_cents, kind, reverses_posting_id, source_reference, reason, actor)
  VALUES (s.id, p.period_month, rev_id, -p.amount_cents, 'reversal', p.id, 'recognition-reversal:' || p.id, btrim(p_reason), btrim(p_actor))
  RETURNING id INTO rid;
  UPDATE recognition_postings SET reversed_by_posting_id = rid WHERE id = p.id;
  PERFORM set_config('trusted.recognition_post', 'off', true);
  INSERT INTO recognition_events (schedule_id, community_id, event, period_month, posting_id, journal_entry_id, amount_cents, detail, actor)
  VALUES (s.id, s.community_id, 'reversed', p.period_month, rid, rev_id, -p.amount_cents,
          jsonb_build_object('reverses_posting_id', p.id, 'original_journal', o.reference, 'reversal_journal', ref, 'reason', btrim(p_reason)), btrim(p_actor));
  IF s.status = 'fully_recognized' THEN
    PERFORM set_config('trusted.recognition_unlock', 'on', true);
    UPDATE recognition_schedules SET status = 'active' WHERE id = s.id;
    PERFORM set_config('trusted.recognition_unlock', 'off', true);
  END IF;
  RETURN rid;
END;
$$;
REVOKE ALL ON FUNCTION post_recognition_period(uuid, date, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reverse_recognition_posting(uuid, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION post_recognition_period(uuid, date, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION reverse_recognition_posting(uuid, text, text, date) TO service_role;

-- 9) Status view (recognized / remaining / next / overdue) ------------------------------
DROP VIEW IF EXISTS v_recognition_schedule_status;
CREATE VIEW v_recognition_schedule_status AS
SELECT s.id AS schedule_id, s.community_id, s.schedule_type, s.description, s.status, s.recognition_method, s.schedule_basis,
       s.source_type, s.source_id, s.source_document_id, s.balance_account_id, s.recognition_account_id, s.fund_id,
       s.period_start, s.period_end,
       s.recognize_amount_cents AS total_cents,
       coalesce(pp.recognized, 0) AS recognized_cents,
       s.recognize_amount_cents - coalesce(pp.recognized, 0) AS remaining_cents,
       per.n_periods, per.scheduled_sum_cents, (per.scheduled_sum_cents = s.recognize_amount_cents) AS periods_tie,
       nx.next_month AS next_recognition_month,
       od.overdue_months, od.overdue_cents
FROM recognition_schedules s
LEFT JOIN LATERAL (SELECT sum(amount_cents) AS recognized FROM recognition_postings WHERE schedule_id = s.id) pp ON true
LEFT JOIN LATERAL (SELECT count(*) AS n_periods, coalesce(sum(scheduled_cents), 0) AS scheduled_sum_cents FROM recognition_schedule_periods WHERE schedule_id = s.id) per ON true
LEFT JOIN LATERAL (SELECT min(rp.period_month) AS next_month FROM recognition_schedule_periods rp
                   WHERE rp.schedule_id = s.id AND rp.scheduled_cents > 0
                     AND NOT EXISTS (SELECT 1 FROM recognition_postings x WHERE x.schedule_id = s.id AND x.period_month = rp.period_month AND x.kind = 'recognition' AND x.reversed_by_posting_id IS NULL)) nx ON true
LEFT JOIN LATERAL (SELECT count(*) AS overdue_months, coalesce(sum(rp.scheduled_cents), 0) AS overdue_cents FROM recognition_schedule_periods rp
                   WHERE s.status = 'active' AND rp.schedule_id = s.id AND rp.scheduled_cents > 0 AND rp.period_month <= date_trunc('month', (now() AT TIME ZONE 'America/Chicago'))::date
                     AND NOT EXISTS (SELECT 1 FROM recognition_postings x WHERE x.schedule_id = s.id AND x.period_month = rp.period_month AND x.kind = 'recognition' AND x.reversed_by_posting_id IS NULL)) od ON true;
GRANT SELECT ON v_recognition_schedule_status TO service_role, authenticated;

-- 10) Forecast integration (additive to 465's method list only) -------------------------
ALTER TABLE forecast_lines DROP CONSTRAINT IF EXISTS forecast_lines_method_check;
ALTER TABLE forecast_lines ADD CONSTRAINT forecast_lines_method_check
  CHECK (method IN ('remaining_budget', 'run_rate', 'prior_year_pattern', 'recurring', 'manual', 'components', 'assessment_recognition', 'recognition_schedule'));
-- A recognition_schedule line names its schedules (settings.recognition_schedule_ids);
-- each must exist, be approved, belong to the forecast's community and recognize
-- into this line's account.
CREATE OR REPLACE FUNCTION forecast_lines_recognition_check() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE f record; acct text; sid text; s record; ok boolean;
BEGIN
  IF NEW.method <> 'recognition_schedule' THEN RETURN NEW; END IF;
  IF coalesce(jsonb_typeof(NEW.settings -> 'recognition_schedule_ids'), '') <> 'array' OR jsonb_array_length(NEW.settings -> 'recognition_schedule_ids') = 0 THEN
    RAISE EXCEPTION 'a recognition_schedule forecast line names its schedules (settings.recognition_schedule_ids)';
  END IF;
  SELECT community_id INTO f FROM budget_forecasts WHERE id = NEW.forecast_id;
  SELECT account_number INTO acct FROM chart_of_accounts WHERE id = NEW.account_id;
  FOR sid IN SELECT jsonb_array_elements_text(NEW.settings -> 'recognition_schedule_ids') LOOP
    SELECT id, community_id, status, recognition_account_id INTO s FROM recognition_schedules WHERE id = sid::uuid;
    IF s IS NULL OR s.community_id <> f.community_id THEN RAISE EXCEPTION 'recognition schedule % not found for this community', sid; END IF;
    IF s.status NOT IN ('active', 'fully_recognized') THEN RAISE EXCEPTION 'recognition schedule % is % (approve it first)', sid, s.status; END IF;
    ok := s.recognition_account_id = NEW.account_id
       OR EXISTS (SELECT 1 FROM recognition_schedule_segments g WHERE g.schedule_id = s.id AND g.income_account_number = acct);
    IF NOT ok THEN RAISE EXCEPTION 'recognition schedule % does not recognize into account %', sid, acct; END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_forecast_lines_recognition_check ON forecast_lines;
CREATE TRIGGER trg_forecast_lines_recognition_check BEFORE INSERT OR UPDATE ON forecast_lines FOR EACH ROW EXECUTE FUNCTION forecast_lines_recognition_check();

-- 11) Guards ----------------------------------------------------------------------------
DO $guard$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM _m466_before;
  IF b.bl_h <> (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items)
  OR b.bh_h <> (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) THEN RAISE EXCEPTION 'guard: budgets changed'; END IF;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries)
  OR b.jel_h <> (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) THEN RAISE EXCEPTION 'guard: GL changed'; END IF;
  IF b.rp_h <> (SELECT md5(coalesce(string_agg(id::text || schedule_id::text || period_month::text || amount_cents::text || coalesce(journal_entry_id::text, ''), '|' ORDER BY id), '')) FROM recognition_postings)
  OR b.rs_n <> (SELECT count(*) FROM recognition_schedules) THEN RAISE EXCEPTION 'guard: existing schedules/postings changed'; END IF;
  IF EXISTS (SELECT 1 FROM recognition_events WHERE event <> 'backfilled') THEN RAISE EXCEPTION 'guard: unexpected recognition events'; END IF;
  --@@END@@
END
$guard$;


CREATE FUNCTION pg_temp.gl(p_account uuid) RETURNS bigint LANGUAGE sql AS $fn$
  SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
  FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id
  WHERE l.account_id = p_account AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL))
$fn$;

DO $t$
DECLARE
  lopf uuid; mc uuid; lbid uuid; h0 text; h1 text; je0 text; jel0 text;
  cid uuid; fop uuid; a1000 uuid; a1300 uuid; a1400 uuid; a2000 uuid; a2205 uuid; a4000 uuid; a5600 uuid; p1 uuid;
  jb uuid; ji uuid; sa uuid; si uuid; sr uuid; sd uuid; sx uuid; pid uuid; rid uuid; oj uuid; rj uuid;
  l2205 uuid; l4000 uuid; l5600 uuid; lsid uuid; lfid uuid; lpost bigint;
  m int; n int; x bigint; ok boolean; res text := '';
BEGIN
  SELECT id, management_company_id INTO lopf, mc FROM communities WHERE name = 'Lakes of Pine Forest';
  SELECT id INTO lbid FROM community_budgets WHERE community_id = lopf AND fiscal_year = 2026;
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h0 FROM budget_line_items WHERE budget_id = lbid;
  SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) INTO je0 FROM journal_entries WHERE community_id = lopf;
  SELECT count(*)::text || ':' || sum(l.debit_cents)::text || ':' || sum(l.credit_cents)::text INTO jel0 FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = lopf;
  PERFORM set_config('trusted.actor', 'rehearsal@test', true);

  -- synthetic community + books
  INSERT INTO communities (name, management_company_id) VALUES ('REHEARSAL 466 (synthetic)', mc) RETURNING id INTO cid;
  INSERT INTO account_funds (community_id, fund_code, fund_name, fund_type) VALUES (cid, 'OP', 'Operating', 'operating') RETURNING id INTO fop;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '1000', 'Operating Cash', 'asset', 'debit', fop, true, false) RETURNING id INTO a1000;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '1300', 'Accounts Receivable', 'asset', 'debit', fop, true, false) RETURNING id INTO a1300;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '1400', 'Prepaid Insurance', 'asset', 'debit', fop, true, false) RETURNING id INTO a1400;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '2000', 'Accounts Payable', 'liability', 'credit', fop, true, false) RETURNING id INTO a2000;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '2205', 'Unearned Assessments', 'liability', 'credit', fop, true, false) RETURNING id INTO a2205;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '4000', 'Assessment Income', 'revenue', 'credit', fop, true, false) RETURNING id INTO a4000;
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, fund_id, is_active, is_summary) VALUES (cid, '5600', 'Insurance', 'expense', 'debit', fop, true, false) RETURNING id INTO a5600;
  INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status, period_type)
  SELECT cid, 2026, g, make_date(2026, g, 1), (make_date(2026, g, 1) + interval '1 month' - interval '1 day')::date, 'open', 'monthly' FROM generate_series(1, 12) g;
  SELECT id INTO p1 FROM accounting_periods WHERE community_id = cid AND period_number = 1;

  -- 1) annual assessment billed once, recognized monthly
  INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
  VALUES (cid, p1, '2026-01-01', 'REH-BILL-2026', '2026 annual assessment billed (deferred)', 'assessment_billing', 38969800, 38969800, 'posted') RETURNING id INTO jb;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents) VALUES (jb, 1, a1300, fop, 38969800, 0), (jb, 2, a2205, fop, 0, 38969800);
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognize_amount_cents, start_month, term_months, monthly_amount_cents, period_start, period_end, source_type, source_journal_entry_id, created_by)
  VALUES (cid, 'deferred_revenue', '2026 annual assessments (synthetic)', '2205', 38969800, '2026-01-01', 12, 3247483, '2026-01-01', '2026-12-31', 'assessment_billing', jb, 'rehearsal@test') RETURNING id INTO sa;
  INSERT INTO recognition_schedule_segments (schedule_id, income_account_number, label, monthly_amount_cents) VALUES (sa, '4000', 'Assessment Income', 3247483);
  SELECT count(*), sum(scheduled_cents) INTO n, x FROM recognition_schedule_periods WHERE schedule_id = sa;
  IF n <> 12 OR x <> 38969800 OR (SELECT scheduled_cents FROM recognition_schedule_periods WHERE schedule_id = sa AND period_month = '2026-12-01') <> 3247487 THEN RAISE EXCEPTION 'assessment periods wrong'; END IF;
  FOR m IN 1 .. 9 LOOP PERFORM post_recognition_period(sa, make_date(2026, m, 1), 'rehearsal@test'); END LOOP;
  IF (SELECT sum(amount_cents) FROM recognition_postings WHERE schedule_id = sa) <> 29227347 THEN RAISE EXCEPTION 'assessment recognized wrong'; END IF;
  IF -pg_temp.gl(a4000) <> 29227347 OR -pg_temp.gl(a2205) <> 9742453 THEN RAISE EXCEPTION 'assessment GL wrong: 4000 % 2205 %', -pg_temp.gl(a4000), -pg_temp.gl(a2205); END IF;
  IF (SELECT remaining_cents FROM v_recognition_schedule_status WHERE schedule_id = sa) <> 9742453 THEN RAISE EXCEPTION 'view remaining wrong'; END IF;
  res := res || '1 assessment $389,698.00 billed once: 12 months tie (11 x $32,474.83 + $32,474.87), Jan-Sep recognized $292,273.47 in 4000, 2205 remaining $97,424.53 = schedule remaining; ';

  -- 2) prepaid insurance: draft -> approved -> amortized
  INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
  VALUES (cid, p1, '2026-01-01', 'REH-INS-2026', 'Annual GL premium paid (prepaid)', 'manual', 2400000, 2400000, 'posted') RETURNING id INTO ji;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents) VALUES (ji, 1, a1400, fop, 2400000, 0), (ji, 2, a2000, fop, 0, 2400000);
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, period_start, period_end, status, source_type, source_journal_entry_id, schedule_basis, created_by)
  VALUES (cid, 'prepaid_expense', 'GL policy 2026 (synthetic)', '1400', a5600, 2400000, '2026-01-01', 12, 200000, '2026-01-01', '2026-12-31', 'draft', 'manual', ji, 'documented', 'rehearsal@test') RETURNING id INTO si;
  ok := false; BEGIN PERFORM post_recognition_period(si, '2026-01-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%only an active schedule%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'draft schedule posted'; END IF;
  ok := false; BEGIN UPDATE recognition_schedules SET status = 'active' WHERE id = si; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%who approved%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'approval without approver allowed'; END IF;
  UPDATE recognition_schedules SET status = 'active', approved_by = 'rehearsal@test', approved_at = now() WHERE id = si;
  ok := false; BEGIN UPDATE recognition_schedules SET recognize_amount_cents = 2500000 WHERE id = si; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%fixed%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'approved schedule edited'; END IF;
  ok := false; BEGIN UPDATE recognition_schedule_periods SET scheduled_cents = 1 WHERE schedule_id = si AND period_month = '2026-12-01'; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%fixed%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'approved months edited'; END IF;
  FOR m IN 1 .. 9 LOOP PERFORM post_recognition_period(si, make_date(2026, m, 1), 'rehearsal@test'); END LOOP;
  IF pg_temp.gl(a5600) <> 1800000 OR pg_temp.gl(a1400) <> 600000 THEN RAISE EXCEPTION 'insurance GL wrong: 5600 % 1400 %', pg_temp.gl(a5600), pg_temp.gl(a1400); END IF;
  IF (SELECT remaining_cents FROM v_recognition_schedule_status WHERE schedule_id = si) <> 600000 THEN RAISE EXCEPTION 'insurance remaining wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recognition_events WHERE schedule_id = si AND event = 'approved' AND actor = 'rehearsal@test') THEN RAISE EXCEPTION 'approval not logged'; END IF;
  res := res || '2 insurance $24,000 prepaid 1/1: after Sep 5600 expense $18,000, 1400 prepaid $6,000 = schedule remaining; draft cannot post, approval needs approver, approved amounts/months fixed; ';

  -- 3) rounding
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, created_by)
  VALUES (cid, 'deferred_revenue', 'Rounding 1000.00 / 3 (synthetic)', '2205', a4000, 100000, '2026-01-01', 3, 33333, 'rehearsal@test') RETURNING id INTO sr;
  IF (SELECT string_agg(scheduled_cents::text, ',' ORDER BY period_month) FROM recognition_schedule_periods WHERE schedule_id = sr) <> '33333,33333,33334' THEN RAISE EXCEPTION 'straight-line rounding wrong'; END IF;
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, recognition_basis, recognition_method, period_start, period_end, created_by)
  VALUES (cid, 'deferred_revenue', 'Daily 1000.01 (synthetic)', '2205', a4000, 100001, '2026-02-01', 13, 7692, 'daily', 'daily', '2026-02-15', '2027-02-14', 'rehearsal@test') RETURNING id INTO sd;
  IF (SELECT sum(scheduled_cents) FROM recognition_schedule_periods WHERE schedule_id = sd) <> 100001 THEN RAISE EXCEPTION 'daily rounding wrong'; END IF;
  res := res || '3 rounding: $1,000.00/3 = 333.33+333.33+333.34; daily $1,000.01 over 2/15-2/14 ties exactly; ';

  -- 4) duplicates refused (function, direct row, and the GL itself)
  ok := false; BEGIN PERFORM post_recognition_period(si, '2026-09-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already recognized%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'duplicate month posted'; END IF;
  ok := false; BEGIN INSERT INTO recognition_postings (schedule_id, period_month, journal_entry_id, amount_cents) VALUES (si, '2026-10-01', ji, 200000); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%posted only by%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'direct posting row allowed'; END IF;
  ok := false; BEGIN
    INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference, total_debits_cents, total_credits_cents, status)
    SELECT cid, p1, '2026-01-01', 'REH-DUP', 'dup', 'recognition', source_reference, 200000, 200000, 'posted' FROM recognition_postings WHERE schedule_id = si AND period_month = '2026-09-01';
  EXCEPTION WHEN unique_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'GL accepted a second recognition journal for the same month'; END IF;
  res := res || '4 duplicate month REFUSED (function, direct row, and GL unique source ref); ';

  -- 5) above total / outside schedule refused
  ok := false; BEGIN PERFORM post_recognition_period(si, '2027-01-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%not in this schedule%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'month outside schedule posted'; END IF;
  ok := false; BEGIN
    PERFORM set_config('trusted.recognition_periods', 'on', true);
    UPDATE recognition_schedule_periods SET scheduled_cents = 900000 WHERE schedule_id = si AND period_month = '2026-10-01';
    PERFORM set_config('trusted.recognition_periods', 'off', true);
    PERFORM post_recognition_period(si, '2026-10-01', 'rehearsal@test');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%exceed the schedule total%'; END;
  PERFORM set_config('trusted.recognition_periods', 'off', true);
  IF NOT ok THEN RAISE EXCEPTION 'recognition above total allowed'; END IF;
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, status, recognition_method, schedule_basis, created_by)
  VALUES (cid, 'prepaid_expense', 'Documented over-total (synthetic)', '1400', a5600, 1000, '2026-01-01', 2, 0, 'draft', 'documented_schedule', 'documented', 'rehearsal@test') RETURNING id INTO sx;
  INSERT INTO recognition_schedule_periods (schedule_id, period_month, scheduled_cents) VALUES (sx, '2026-01-01', 600), (sx, '2026-02-01', 500);
  ok := false; BEGIN
    UPDATE recognition_schedules SET status = 'active', approved_by = 'rehearsal@test', approved_at = now() WHERE id = sx;
    SET CONSTRAINTS trg_recognition_schedules_tie IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%must tie exactly%'; END;
  SET CONSTRAINTS ALL DEFERRED;
  IF NOT ok THEN RAISE EXCEPTION 'documented months above total approved'; END IF;
  ok := false; BEGIN INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognize_amount_cents, start_month, term_months, monthly_amount_cents, recognition_method) VALUES (cid, 'prepaid_expense', 'x', '1400', 1000, '2026-01-01', 1, 1000, 'documented_schedule'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%created as draft%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'documented schedule created active'; END IF;
  res := res || '5 above total REFUSED (tampered month hits the cap; documented months over total cannot be approved; month outside schedule refused); ';

  -- 6) reversal: explicit, audited, then a clean re-post
  SELECT id, journal_entry_id INTO pid, oj FROM recognition_postings WHERE schedule_id = si AND period_month = '2026-09-01' AND kind = 'recognition';
  ok := false; BEGIN PERFORM reverse_recognition_posting(pid, '  ', 'rehearsal@test', '2026-09-30'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%needs a reason%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'reversal without reason allowed'; END IF;
  rid := reverse_recognition_posting(pid, 'Posted before the policy endorsement; re-post after review', 'rehearsal@test', '2026-09-30');
  SELECT journal_entry_id INTO rj FROM recognition_postings WHERE id = rid;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = rj AND source_module = 'reversal' AND reverses_je_id = oj AND status = 'posted')
  OR NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = oj AND status = 'voided' AND void_reversal_je_id = rj AND void_reason IS NOT NULL) THEN RAISE EXCEPTION 'reversal journals wrong'; END IF;
  IF (SELECT amount_cents FROM recognition_postings WHERE id = rid) <> -200000 OR (SELECT reversed_by_posting_id FROM recognition_postings WHERE id = pid) <> rid THEN RAISE EXCEPTION 'reversal rows wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recognition_events WHERE schedule_id = si AND event = 'reversed' AND actor = 'rehearsal@test' AND detail ->> 'reason' LIKE 'Posted before%') THEN RAISE EXCEPTION 'reversal not logged'; END IF;
  IF (SELECT recognized_cents FROM v_recognition_schedule_status WHERE schedule_id = si) <> 1600000 OR pg_temp.gl(a1400) <> 800000 OR pg_temp.gl(a5600) <> 1600000 THEN RAISE EXCEPTION 'after reversal wrong'; END IF;
  ok := false; BEGIN PERFORM reverse_recognition_posting(pid, 'again', 'rehearsal@test', '2026-09-30'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already reversed%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'double reversal allowed'; END IF;
  ok := false; BEGIN DELETE FROM recognition_postings WHERE id = pid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%permanent%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posting deleted'; END IF;
  ok := false; BEGIN UPDATE recognition_postings SET amount_cents = 1 WHERE id = pid; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%posted only by%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posting edited'; END IF;
  ok := false; BEGIN UPDATE recognition_events SET actor = 'x' WHERE schedule_id = si; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%permanent%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'events edited'; END IF;
  PERFORM post_recognition_period(si, '2026-09-01', 'rehearsal@test');
  IF (SELECT recognized_cents FROM v_recognition_schedule_status WHERE schedule_id = si) <> 1800000 OR pg_temp.gl(a1400) <> 600000
  OR NOT EXISTS (SELECT 1 FROM recognition_postings WHERE schedule_id = si AND period_month = '2026-09-01' AND kind = 'recognition' AND reversed_by_posting_id IS NULL AND source_reference LIKE '%:2') THEN RAISE EXCEPTION 're-post after reversal wrong'; END IF;
  res := res || '6 reversal explicit (offset JE + original voided + reversal row + event with reason/actor), double/no-reason reversal, delete, edit REFUSED, re-post once OK; ';

  -- controls: closed period, cancel audit, no deletes, completion
  UPDATE accounting_periods SET status = 'closed' WHERE community_id = cid AND period_number = 10;
  ok := false; BEGIN PERFORM post_recognition_period(si, '2026-10-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%no open accounting period%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posted into a closed period'; END IF;
  ok := false; BEGIN UPDATE recognition_schedules SET status = 'cancelled' WHERE id = sd; EXCEPTION WHEN check_violation THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'cancel without reason allowed'; END IF;
  ok := false; BEGIN DELETE FROM recognition_schedules WHERE id = sd; EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%not deleted%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'schedule deleted'; END IF;
  FOR m IN 1 .. 3 LOOP PERFORM post_recognition_period(sr, make_date(2026, m, 1), 'rehearsal@test'); END LOOP;
  IF (SELECT status FROM recognition_schedules WHERE id = sr) <> 'fully_recognized' OR NOT EXISTS (SELECT 1 FROM recognition_events WHERE schedule_id = sr AND event = 'completed') THEN RAISE EXCEPTION 'completion wrong'; END IF;
  ok := false; BEGIN PERFORM post_recognition_period(sr, '2026-03-01', 'rehearsal@test'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%fully_recognized%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'posted past completion'; END IF;
  res := res || 'closed period REFUSED; cancel w/o reason REFUSED; schedule delete REFUSED; completion logged; ';

  -- 7) forecast uses the remaining recognition months (LOPF: read-only GL, rolled-back schedule + line)
  SELECT id INTO l2205 FROM chart_of_accounts WHERE community_id = lopf AND account_number = '2205';
  SELECT id INTO l4000 FROM chart_of_accounts WHERE community_id = lopf AND account_number = '4000';
  SELECT id INTO l5600 FROM chart_of_accounts WHERE community_id = lopf AND account_number = '5600';
  INSERT INTO recognition_schedules (community_id, schedule_type, description, balance_account_number, recognition_account_id, recognize_amount_cents, start_month, term_months, monthly_amount_cents, period_start, period_end, source_type, created_by)
  VALUES (lopf, 'deferred_revenue', 'REHEARSAL: 2026 assessments, 7/31 unearned balance', '2205', l4000, 16237419, '2026-08-01', 5, 3247483, '2026-08-01', '2026-12-31', 'conversion_balance', 'rehearsal@test') RETURNING id INTO lsid;
  SELECT -pg_temp.gl(l4000) INTO lpost;
  IF lpost + (SELECT sum(scheduled_cents) FROM recognition_schedule_periods WHERE schedule_id = lsid) <> (SELECT annual_amount_cents FROM budget_line_items WHERE budget_id = lbid AND account_id = l4000) THEN
    RAISE EXCEPTION 'LOPF recognized + scheduled does not equal the approved levy';
  END IF;
  IF -pg_temp.gl(l2205) <> 16237419 THEN RAISE EXCEPTION 'LOPF 2205 balance is not the scheduled total'; END IF;
  INSERT INTO budget_forecasts (community_id, fiscal_year, budget_id, as_of_month, created_by) VALUES (lopf, 2026, lbid, 9, 'rehearsal@test') RETURNING id INTO lfid;
  INSERT INTO forecast_lines (forecast_id, account_id, method, settings, remaining_months, updated_by)
  VALUES (lfid, l4000, 'recognition_schedule', jsonb_build_object('recognition_schedule_ids', jsonb_build_array(lsid)), ARRAY[0,0,0,0,0,0,0,0,0,9742449,3247483,3247487]::bigint[], 'rehearsal@test');
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, method, settings, remaining_months) VALUES (lfid, l5600, 'recognition_schedule', jsonb_build_object('recognition_schedule_ids', jsonb_build_array(lsid)), ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%does not recognize into%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'schedule for another account accepted'; END IF;
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, method, settings, remaining_months) VALUES (lfid, l5600, 'recognition_schedule', jsonb_build_object('recognition_schedule_ids', jsonb_build_array(si)), ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%not found for this community%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'other community schedule accepted'; END IF;
  ok := false; BEGIN INSERT INTO forecast_lines (forecast_id, account_id, method, remaining_months) VALUES (lfid, l5600, 'recognition_schedule', ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::bigint[]); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%names its schedules%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'recognition line without schedules accepted'; END IF;
  res := res || '7 forecast: LOPF 4000 recognized $227,323.81 + scheduled $162,374.19 (= 2205 balance) = approved levy $389,698.00; recognition_schedule line accepted, wrong account/community/no schedule REFUSED; ';

  -- 8) nothing real moved
  SELECT md5(string_agg(id::text || account_id::text || coalesce(fund_id::text,'') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id)) INTO h1 FROM budget_line_items WHERE budget_id = lbid;
  IF h1 <> h0 OR h0 <> 'd246598beacc61cab198e7a89bae5074' THEN RAISE EXCEPTION 'LOPF approved budget changed'; END IF;
  IF je0 <> (SELECT md5(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id)) FROM journal_entries WHERE community_id = lopf)
  OR jel0 <> (SELECT count(*)::text || ':' || sum(l.debit_cents)::text || ':' || sum(l.credit_cents)::text FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = lopf) THEN RAISE EXCEPTION 'LOPF GL changed'; END IF;
  res := res || '8 LOPF approved budget hash ' || h0 || ' unchanged; LOPF GL unchanged';
  RAISE EXCEPTION 'REHEARSAL_OK %', res;
END
$t$;
