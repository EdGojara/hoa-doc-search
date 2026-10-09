-- ============================================================================
-- 502_month_end_close.sql  (Ed 2026-10-09: month-end close, PR A)
-- ----------------------------------------------------------------------------
-- transactions -> close controls -> verified period -> statements -> package.
-- This migration is the "verified period" layer: a durable close record per
-- community and month, an append-only history of every run, override, warning
-- acceptance, close and reopen, and a database-level lock so a closed month
-- cannot change by any path.
--
-- Record ownership: period_closes / period_close_runs / period_close_events /
-- close_source_requirements / period_close_evidence are WORKPAPERS (Bedrock's
-- production process). Statements delivered to a board from a closed period
-- are association records; the evidence behind them stays ours.
--
-- 1) STATES. period_closes.status: open -> review -> ready_to_close -> closed.
--    review          a checklist has run and at least one BLOCK is not overridden
--    ready_to_close  every BLOCK on the latest run is overridden by the owner
--    closed          closed by an admin/owner on the latest run, with the books'
--                    fingerprint unchanged since that run
--    A close with any owner override is labelled 'closed_with_override' for good.
--    accounting_periods.status stays the posting lock it always was
--    (open / closed / reopened / locked) and now changes ONLY through these
--    functions (a guard trigger refuses any other status change).
--
-- 2) CLOSED THROUGH. Months close in order and reopen newest first, so the
--    closed months are always a contiguous run. Closing a month locks every
--    entry dated on or before its last day, including months before the
--    community's cutover (a converted community's July opening entries are
--    locked the moment August closes). Only months ending on/after the GL
--    cutover take part in the sequence; earlier months are prior-system months.
--
-- 3) THE LOCK. Triggers on journal_entries and journal_entry_lines refuse any
--    insert, delete or change dated on/before the closed-through date or in a
--    closed/locked period. The one permitted change to a locked entry is the
--    void flip voidJournalEntry makes AFTER posting its reversal in an open month
--    (posted -> voided with the reversal recorded), plus non-financial fields
--    (description, notes, document links, review flags). Corrections to a closed
--    month are an adjusting entry in an open month, or an explicit reopen.
--
-- 4) THE CHECKLIST is computed by the server (lib/close/*) from the books; this
--    migration stores what it found. close_ledger_facts() computes the ledger
--    integrity facts and the books' fingerprint in SQL so they are deterministic
--    and identical at run time and at close time.
--
-- 5) AUTHORITY. Every write goes through a SECURITY DEFINER function executable by
--    service_role only; the tables are read-only to the API. The server passes the
--    actor's role after its own owner/admin checks; the functions refuse a BLOCK
--    override from anyone but the owner, a close/reopen/acceptance from anyone but
--    owner/admin, and a reason shorter than 10 characters for an override or reopen.
--
-- Changes no existing row. Creates no period. The lock has no effect until a
-- month is closed.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------- the close record
CREATE TABLE IF NOT EXISTS period_closes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id       uuid NOT NULL,
  period_id          uuid NOT NULL,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  status             text NOT NULL DEFAULT 'open',
  close_label        text,
  latest_run_id      uuid,
  close_run_id       uuid,
  fingerprint        text,
  closed_at          timestamptz,
  closed_by          text,
  closed_by_user_id  uuid,
  closed_by_role     text,
  accepted_warnings  jsonb NOT NULL DEFAULT '[]'::jsonb,
  overrides          jsonb NOT NULL DEFAULT '[]'::jsonb,
  reopened_at        timestamptz,
  reopened_by        text,
  reopen_reason      text,
  reopen_count       integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_closes_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT period_closes_period_fk FOREIGN KEY (period_id) REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  CONSTRAINT period_closes_period_unique UNIQUE (period_id),
  CONSTRAINT period_closes_status_check CHECK (status IN ('open', 'review', 'ready_to_close', 'closed')),
  CONSTRAINT period_closes_label_check CHECK (close_label IS NULL OR close_label IN ('closed', 'closed_with_override')),
  CONSTRAINT period_closes_closed_check CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND close_run_id IS NOT NULL
    AND fingerprint IS NOT NULL AND close_label IS NOT NULL AND closed_by_role IN ('owner', 'admin')))
);
CREATE INDEX IF NOT EXISTS idx_period_closes_community ON period_closes (community_id, period_end);
COMMENT ON TABLE period_closes IS 'workpaper: one close record per community accounting period (status open/review/ready_to_close/closed, who/when, fingerprint of the books at close, accepted warnings, owner overrides, last reopen). Written only through the close functions (migration 502).';

-- ---------------------------------------------------------------- every checklist run (append-only)
CREATE TABLE IF NOT EXISTS period_close_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL,
  period_id       uuid NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now(),
  run_by          text NOT NULL,
  run_by_user_id  uuid,
  engine_version  text NOT NULL,
  fingerprint     text NOT NULL,
  ledger_facts    jsonb NOT NULL,
  results         jsonb NOT NULL,
  summary         jsonb NOT NULL,
  status_after    text NOT NULL,
  CONSTRAINT period_close_runs_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT period_close_runs_period_fk FOREIGN KEY (period_id) REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  CONSTRAINT period_close_runs_results_check CHECK (jsonb_typeof(results) = 'array'),
  CONSTRAINT period_close_runs_status_check CHECK (status_after IN ('review', 'ready_to_close'))
);
CREATE INDEX IF NOT EXISTS idx_period_close_runs_period ON period_close_runs (period_id, run_at DESC);
COMMENT ON TABLE period_close_runs IS 'workpaper: every month-end checklist run, exactly as computed (each control PASS/WARNING/BLOCK with amount, count, explanation, drill-down and suggested action) plus the ledger facts and fingerprint it ran on. Append-only.';

ALTER TABLE period_closes DROP CONSTRAINT IF EXISTS period_closes_latest_run_fk;
ALTER TABLE period_closes ADD CONSTRAINT period_closes_latest_run_fk FOREIGN KEY (latest_run_id) REFERENCES period_close_runs(id) ON DELETE RESTRICT;
ALTER TABLE period_closes DROP CONSTRAINT IF EXISTS period_closes_close_run_fk;
ALTER TABLE period_closes ADD CONSTRAINT period_closes_close_run_fk FOREIGN KEY (close_run_id) REFERENCES period_close_runs(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------- the audit history (append-only)
CREATE TABLE IF NOT EXISTS period_close_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  community_id   uuid NOT NULL,
  period_id      uuid NOT NULL,
  run_id         uuid,
  event          text NOT NULL,
  control_code   text,
  evidence_hash  text,
  actor          text NOT NULL,
  actor_user_id  uuid,
  actor_role     text NOT NULL,
  reason         text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_close_events_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT period_close_events_period_fk FOREIGN KEY (period_id) REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  CONSTRAINT period_close_events_run_fk FOREIGN KEY (run_id) REFERENCES period_close_runs(id) ON DELETE RESTRICT,
  CONSTRAINT period_close_events_event_check CHECK (event IN ('run', 'block_overridden', 'warnings_accepted', 'closed', 'reopened')),
  CONSTRAINT period_close_events_role_check CHECK (actor_role IN ('owner', 'admin', 'staff')),
  CONSTRAINT period_close_events_authority_check CHECK (
    (event = 'block_overridden' AND actor_role = 'owner' AND control_code IS NOT NULL AND evidence_hash IS NOT NULL AND run_id IS NOT NULL AND length(btrim(coalesce(reason, ''))) >= 10)
    OR (event = 'reopened' AND actor_role IN ('owner', 'admin') AND length(btrim(coalesce(reason, ''))) >= 10)
    OR (event IN ('warnings_accepted', 'closed') AND actor_role IN ('owner', 'admin') AND run_id IS NOT NULL)
    OR (event = 'run' AND run_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_period_close_events_seq ON period_close_events (seq);
CREATE INDEX IF NOT EXISTS idx_period_close_events_period ON period_close_events (period_id, seq);
COMMENT ON TABLE period_close_events IS 'workpaper: append-only audit of each checklist run, owner BLOCK override (control, reason, evidence), warning acceptance, close and reopen (reason, who, when).';

-- ---------------------------------------------------------------- required period sources (configuration)
CREATE TABLE IF NOT EXISTS close_source_requirements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL,
  source_key    text NOT NULL,
  label         text NOT NULL,
  required      boolean NOT NULL DEFAULT true,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  set_by        text NOT NULL,
  set_reason    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT close_source_requirements_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT close_source_requirements_key_check CHECK (source_key IN ('homeowner_feed', 'bank_statements', 'recognition', 'ap_feed', 'other')),
  CONSTRAINT close_source_requirements_reason_check CHECK (length(btrim(set_reason)) >= 10),
  CONSTRAINT close_source_requirements_unique UNIQUE (community_id, source_key, label)
);
COMMENT ON TABLE close_source_requirements IS 'workpaper: per-community configuration of the period sources the close requires (homeowner feed mode, bank statements, recognition schedules, AP feed, other named sources). Absent rows mean the platform defaults; a row that turns a default off needs a reason.';

-- Evidence for an 'other' required source for one period (a statement, a report, a confirmation).
CREATE TABLE IF NOT EXISTS period_close_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL,
  period_id       uuid NOT NULL,
  requirement_id  uuid NOT NULL,
  document_ref    text NOT NULL,
  note            text,
  provided_by     text NOT NULL,
  provided_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_close_evidence_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT period_close_evidence_period_fk FOREIGN KEY (period_id) REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  CONSTRAINT period_close_evidence_requirement_fk FOREIGN KEY (requirement_id) REFERENCES close_source_requirements(id) ON DELETE RESTRICT
);
COMMENT ON TABLE period_close_evidence IS 'workpaper: the document provided for an "other" required source for one period. Append-only.';

CREATE OR REPLACE FUNCTION period_close_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_period_close_runs_append_only ON period_close_runs;
CREATE TRIGGER trg_period_close_runs_append_only BEFORE UPDATE OR DELETE ON period_close_runs FOR EACH ROW EXECUTE FUNCTION period_close_append_only();
DROP TRIGGER IF EXISTS trg_period_close_events_append_only ON period_close_events;
CREATE TRIGGER trg_period_close_events_append_only BEFORE UPDATE OR DELETE ON period_close_events FOR EACH ROW EXECUTE FUNCTION period_close_append_only();
DROP TRIGGER IF EXISTS trg_period_close_evidence_append_only ON period_close_evidence;
CREATE TRIGGER trg_period_close_evidence_append_only BEFORE UPDATE OR DELETE ON period_close_evidence FOR EACH ROW EXECUTE FUNCTION period_close_append_only();
DROP TRIGGER IF EXISTS trg_period_closes_updated_at ON period_closes;
CREATE TRIGGER trg_period_closes_updated_at BEFORE UPDATE ON period_closes FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_close_source_requirements_updated_at ON close_source_requirements;
CREATE TRIGGER trg_close_source_requirements_updated_at BEFORE UPDATE ON close_source_requirements FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- The close tables change only inside the close functions.
CREATE OR REPLACE FUNCTION period_closes_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF coalesce(current_setting('trusted.close_txn', true), '') <> 'on' THEN
    RAISE EXCEPTION 'period_closes changes only through the month-end close functions';
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a close record is never deleted'; END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_period_closes_guard ON period_closes;
CREATE TRIGGER trg_period_closes_guard BEFORE INSERT OR UPDATE OR DELETE ON period_closes FOR EACH ROW EXECUTE FUNCTION period_closes_guard();

-- ---------------------------------------------------------------- closed through
-- The last day on/before which this community's books are closed (NULL: none).
CREATE OR REPLACE FUNCTION close_closed_through(p_community uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT max(period_end) FROM accounting_periods WHERE community_id = p_community AND status IN ('closed', 'locked');
$fn$;

-- Is a posting date (or the entry's period) locked for this community?
CREATE OR REPLACE FUNCTION close_is_locked(p_community uuid, p_period uuid, p_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT coalesce(p_date <= close_closed_through(p_community), false)
      OR EXISTS (SELECT 1 FROM accounting_periods p WHERE p.id = p_period AND p.status IN ('closed', 'locked'));
$fn$;

-- accounting_periods: status moves only through the close functions; a closed or
-- locked period's dates and community never change; locked is final.
CREATE OR REPLACE FUNCTION accounting_periods_close_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE in_close boolean := coalesce(current_setting('trusted.close_txn', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('closed', 'locked') THEN RAISE EXCEPTION 'period_closed: a closed accounting period is never deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('open') AND NOT in_close THEN RAISE EXCEPTION 'a new accounting period starts open'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'locked' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'period_closed: a locked period is final'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT in_close THEN
    RAISE EXCEPTION 'period_closed: an accounting period closes and reopens only through the month-end close (checklist, authority, reason)';
  END IF;
  IF OLD.status IN ('closed', 'locked') AND (NEW.period_start, NEW.period_end, NEW.community_id, NEW.fiscal_year, NEW.period_number)
       IS DISTINCT FROM (OLD.period_start, OLD.period_end, OLD.community_id, OLD.fiscal_year, OLD.period_number) THEN
    RAISE EXCEPTION 'period_closed: a closed period''s dates do not change';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_accounting_periods_close_guard ON accounting_periods;
CREATE TRIGGER trg_accounting_periods_close_guard BEFORE INSERT OR UPDATE OR DELETE ON accounting_periods FOR EACH ROW EXECUTE FUNCTION accounting_periods_close_guard();

-- journal_entries: nothing dated into a closed month is added, removed or changed.
CREATE OR REPLACE FUNCTION journal_entries_close_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF close_is_locked(NEW.community_id, NEW.period_id, NEW.posting_date) THEN
      RAISE EXCEPTION 'period_closed: % is dated % in a closed month; post an adjusting entry in an open month or reopen the period', NEW.reference, NEW.posting_date;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF close_is_locked(OLD.community_id, OLD.period_id, OLD.posting_date) THEN
      RAISE EXCEPTION 'period_closed: % is in a closed month and cannot be deleted', OLD.reference;
    END IF;
    RETURN OLD;
  END IF;
  IF close_is_locked(OLD.community_id, OLD.period_id, OLD.posting_date) OR close_is_locked(NEW.community_id, NEW.period_id, NEW.posting_date) THEN
    IF (NEW.community_id, NEW.period_id, NEW.posting_date, NEW.reference, NEW.source_module, NEW.total_debits_cents, NEW.total_credits_cents,
        NEW.reverses_je_id, NEW.superseded_at, NEW.superseded_by_conversion)
       IS DISTINCT FROM (OLD.community_id, OLD.period_id, OLD.posting_date, OLD.reference, OLD.source_module, OLD.total_debits_cents, OLD.total_credits_cents,
        OLD.reverses_je_id, OLD.superseded_at, OLD.superseded_by_conversion) THEN
      RAISE EXCEPTION 'period_closed: % is in a closed month; its amounts, date and source do not change', OLD.reference;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.void_reversal_je_id IS DISTINCT FROM OLD.void_reversal_je_id THEN
      -- The one permitted change: the void flip after the reversal posted in an open month.
      IF NOT (OLD.status = 'posted' AND NEW.status = 'voided' AND NEW.void_reversal_je_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM journal_entries r WHERE r.id = NEW.void_reversal_je_id AND r.reverses_je_id = NEW.id)) THEN
        RAISE EXCEPTION 'period_closed: % is in a closed month; it can only be voided by a reversal dated in an open month', OLD.reference;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_journal_entries_close_guard ON journal_entries;
CREATE TRIGGER trg_journal_entries_close_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_close_guard();

CREATE OR REPLACE FUNCTION journal_entry_lines_close_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE je record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT community_id, period_id, posting_date, reference INTO je FROM journal_entries WHERE id = OLD.journal_entry_id;
    IF FOUND AND close_is_locked(je.community_id, je.period_id, je.posting_date) THEN
      RAISE EXCEPTION 'period_closed: the lines of % are in a closed month', je.reference;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT community_id, period_id, posting_date, reference INTO je FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF FOUND AND close_is_locked(je.community_id, je.period_id, je.posting_date) THEN
      RAISE EXCEPTION 'period_closed: the lines of % are in a closed month', je.reference;
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_journal_entry_lines_close_guard ON journal_entry_lines;
CREATE TRIGGER trg_journal_entry_lines_close_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_close_guard();

-- ---------------------------------------------------------------- ledger facts + fingerprint
-- Read-only. "Counted" is THE rule (lib/accounting/je_status.js, v_trial_balance):
-- posted, or voided with its reversal recorded.
CREATE OR REPLACE FUNCTION close_ledger_facts(p_community uuid, p_period uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  per record; v_through_dr bigint; v_through_cr bigint; v_period_dr bigint; v_period_cr bigint;
  v_fp text; v_lines bigint; v_funds jsonb; v_broken jsonb; v_drafts jsonb; v_dates jsonb; v_backdated jsonb; v_voidnorev jsonb;
  v_cutover date; v_closed_through date;
BEGIN
  SELECT * INTO per FROM accounting_periods WHERE id = p_period AND community_id = p_community;
  IF NOT FOUND THEN RAISE EXCEPTION 'no accounting period % for this community', p_period; END IF;
  SELECT gl_cutover_date INTO v_cutover FROM communities WHERE id = p_community;
  v_closed_through := close_closed_through(p_community);

  WITH counted AS (
    SELECT j.id AS je_id, j.status, j.posting_date, l.id AS line_id, l.account_id, coalesce(l.fund_id, a.fund_id) AS fund_id, l.debit_cents, l.credit_cents
      FROM journal_entries j JOIN journal_entry_lines l ON l.journal_entry_id = j.id LEFT JOIN chart_of_accounts a ON a.id = l.account_id
     WHERE j.community_id = p_community AND j.posting_date <= per.period_end
       AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL)))
  SELECT coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0),
         coalesce(sum(debit_cents) FILTER (WHERE posting_date >= per.period_start), 0), coalesce(sum(credit_cents) FILTER (WHERE posting_date >= per.period_start), 0),
         count(*), md5(coalesce(string_agg(concat_ws('|', je_id, status, posting_date, line_id, account_id, fund_id, debit_cents, credit_cents), ',' ORDER BY line_id), ''))
    INTO v_through_dr, v_through_cr, v_period_dr, v_period_cr, v_lines, v_fp
    FROM counted;

  -- Every fund balances (debits = credits) through period end.
  SELECT coalesce(jsonb_agg(jsonb_build_object('fund_id', f.fund_id, 'fund_code', af.fund_code, 'debit_cents', f.dr, 'credit_cents', f.cr, 'difference_cents', f.dr - f.cr) ORDER BY af.fund_code), '[]'::jsonb)
    INTO v_funds
    FROM (SELECT coalesce(l.fund_id, a.fund_id) AS fund_id, sum(l.debit_cents) AS dr, sum(l.credit_cents) AS cr
            FROM journal_entries j JOIN journal_entry_lines l ON l.journal_entry_id = j.id LEFT JOIN chart_of_accounts a ON a.id = l.account_id
           WHERE j.community_id = p_community AND j.posting_date <= per.period_end
             AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL))
           GROUP BY 1 HAVING sum(l.debit_cents) <> sum(l.credit_cents)) f
    LEFT JOIN account_funds af ON af.id = f.fund_id;

  -- Broken entries: counted, dated through period end, whose lines are missing or
  -- do not equal the header, or do not balance.
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'posting_date', x->>'reference'), '[]'::jsonb) INTO v_broken FROM (
    SELECT jsonb_build_object('je_id', j.id, 'reference', j.reference, 'posting_date', j.posting_date, 'status', j.status, 'source_module', j.source_module,
             'header_debits_cents', j.total_debits_cents, 'header_credits_cents', j.total_credits_cents,
             'line_count', count(l.id), 'line_debits_cents', coalesce(sum(l.debit_cents), 0), 'line_credits_cents', coalesce(sum(l.credit_cents), 0),
             'problem', CASE WHEN count(l.id) = 0 THEN 'no_lines'
                             WHEN coalesce(sum(l.debit_cents), 0) <> coalesce(sum(l.credit_cents), 0) THEN 'lines_unbalanced'
                             ELSE 'lines_differ_from_header' END) AS x
      FROM journal_entries j LEFT JOIN journal_entry_lines l ON l.journal_entry_id = j.id
     WHERE j.community_id = p_community AND j.posting_date <= per.period_end
       AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL))
     GROUP BY j.id
    HAVING count(l.id) = 0 OR coalesce(sum(l.debit_cents), 0) <> j.total_debits_cents OR coalesce(sum(l.credit_cents), 0) <> j.total_credits_cents
        OR coalesce(sum(l.debit_cents), 0) <> coalesce(sum(l.credit_cents), 0)
     LIMIT 500) s;

  -- Unposted (draft) entries dated in the period.
  SELECT coalesce(jsonb_agg(jsonb_build_object('je_id', id, 'reference', reference, 'posting_date', posting_date, 'description', left(description, 120), 'amount_cents', total_debits_cents) ORDER BY posting_date, reference), '[]'::jsonb)
    INTO v_drafts FROM journal_entries
   WHERE community_id = p_community AND status = 'draft' AND posting_date BETWEEN per.period_start AND per.period_end;

  -- Voided entries with no reversal recorded (not counted; listed so nothing disappears silently).
  SELECT coalesce(jsonb_agg(jsonb_build_object('je_id', id, 'reference', reference, 'posting_date', posting_date, 'amount_cents', total_debits_cents) ORDER BY posting_date, reference), '[]'::jsonb)
    INTO v_voidnorev FROM journal_entries
   WHERE community_id = p_community AND status = 'voided' AND void_reversal_je_id IS NULL AND posting_date BETWEEN per.period_start AND per.period_end;

  -- Invalid dates: the entry's period belongs to another community, or its posting
  -- date is outside the period it is filed under.
  SELECT coalesce(jsonb_agg(jsonb_build_object('je_id', j.id, 'reference', j.reference, 'posting_date', j.posting_date, 'filed_period_start', p.period_start, 'filed_period_end', p.period_end,
           'problem', CASE WHEN p.id IS NULL THEN 'no_period' WHEN p.community_id <> j.community_id THEN 'other_community_period' ELSE 'date_outside_period' END) ORDER BY j.posting_date, j.reference), '[]'::jsonb)
    INTO v_dates
    FROM journal_entries j LEFT JOIN accounting_periods p ON p.id = j.period_id
   WHERE j.community_id = p_community AND j.posting_date BETWEEN per.period_start AND per.period_end AND j.status IN ('posted', 'voided', 'draft')
     AND (p.id IS NULL OR p.community_id <> j.community_id OR j.posting_date NOT BETWEEN p.period_start AND p.period_end);

  -- Entries dated into an already-closed month that were recorded after it closed.
  SELECT coalesce(jsonb_agg(jsonb_build_object('je_id', j.id, 'reference', j.reference, 'posting_date', j.posting_date, 'created_at', j.created_at, 'closed_period_end', c.period_end, 'closed_at', c.closed_at) ORDER BY j.posting_date), '[]'::jsonb)
    INTO v_backdated
    FROM journal_entries j JOIN period_closes c ON c.community_id = j.community_id AND c.closed_at IS NOT NULL AND j.posting_date <= c.period_end
   WHERE j.community_id = p_community AND j.created_at > c.closed_at AND j.status IN ('posted', 'voided');

  RETURN jsonb_build_object(
    'community_id', p_community, 'period_id', p_period, 'period_start', per.period_start, 'period_end', per.period_end,
    'period_status', per.status, 'gl_cutover_date', v_cutover, 'closed_through', v_closed_through,
    'through_debits_cents', v_through_dr, 'through_credits_cents', v_through_cr,
    'period_debits_cents', v_period_dr, 'period_credits_cents', v_period_cr,
    'counted_lines', v_lines, 'fingerprint', v_fp,
    'unbalanced_funds', v_funds, 'broken_entries', v_broken, 'draft_entries', v_drafts,
    'voided_without_reversal', v_voidnorev, 'invalid_dates', v_dates, 'backdated_into_closed', v_backdated);
END;
$fn$;

-- ---------------------------------------------------------------- shared helpers
-- The current close cycle starts after the last reopen of this period.
CREATE OR REPLACE FUNCTION close_cycle_start(p_period uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT coalesce(max(created_at), '-infinity'::timestamptz) FROM period_close_events WHERE period_id = p_period AND event = 'reopened';
$fn$;

-- BLOCK controls on a run that do not carry an owner override for the same evidence in this cycle.
CREATE OR REPLACE FUNCTION close_unresolved_blocks(p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT coalesce(jsonb_agg(r->>'code' ORDER BY r->>'code'), '[]'::jsonb)
    FROM period_close_runs run, jsonb_array_elements(run.results) r
   WHERE run.id = p_run AND r->>'status' = 'BLOCK'
     AND NOT EXISTS (SELECT 1 FROM period_close_events e
                      WHERE e.period_id = run.period_id AND e.event = 'block_overridden' AND e.control_code = r->>'code'
                        AND e.evidence_hash = r->>'evidence_hash' AND e.created_at > close_cycle_start(run.period_id));
$fn$;

CREATE OR REPLACE FUNCTION close_previous_open_periods(p_community uuid, p_period uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  -- Every calendar month from the start of the community's books in trustEd (the
  -- GL cutover date; with no cutover, the first month holding any entry) up to the
  -- month before this one must have a monthly period AND be closed. A quiet month
  -- with no entries still counts, and a missing period row is reported, so closing
  -- a later month can never lock an earlier month nobody closed.
  WITH me AS (SELECT period_start FROM accounting_periods WHERE id = p_period AND community_id = p_community),
  start_d AS (
    SELECT date_trunc('month', coalesce(
             (SELECT gl_cutover_date FROM communities WHERE id = p_community),
             (SELECT min(posting_date) FROM journal_entries WHERE community_id = p_community)))::date AS d),
  months AS (
    SELECT gs::date AS m FROM me, start_d, generate_series(start_d.d, me.period_start - interval '1 month', interval '1 month') gs
     WHERE start_d.d IS NOT NULL)
  SELECT coalesce(jsonb_agg(to_char(months.m, 'YYYY-MM') || CASE WHEN p.id IS NULL THEN ' (no period set up)' ELSE '' END ORDER BY months.m), '[]'::jsonb)
    FROM months
    LEFT JOIN accounting_periods p ON p.community_id = p_community AND p.period_type = 'monthly' AND p.period_start = months.m
   WHERE p.id IS NULL OR p.status NOT IN ('closed', 'locked');
$fn$;

CREATE OR REPLACE FUNCTION close_ensure_record(p_community uuid, p_period uuid) RETURNS period_closes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE pc period_closes; per accounting_periods;
BEGIN
  SELECT * INTO pc FROM period_closes WHERE period_id = p_period FOR UPDATE;
  IF FOUND THEN RETURN pc; END IF;
  SELECT * INTO per FROM accounting_periods WHERE id = p_period AND community_id = p_community;
  IF NOT FOUND THEN RAISE EXCEPTION 'no accounting period % for this community', p_period; END IF;
  IF per.period_type <> 'monthly' THEN RAISE EXCEPTION 'month-end close runs on monthly periods only'; END IF;
  PERFORM set_config('trusted.close_txn', 'on', true);
  INSERT INTO period_closes (community_id, period_id, period_start, period_end, status)
  VALUES (p_community, p_period, per.period_start, per.period_end, CASE WHEN per.status IN ('closed', 'locked') THEN 'closed' ELSE 'open' END)
  RETURNING * INTO pc;
  RETURN pc;
END;
$fn$;

-- ---------------------------------------------------------------- record a checklist run
CREATE OR REPLACE FUNCTION close_record_run(p_community uuid, p_period uuid, p_actor text, p_actor_user_id uuid, p_engine_version text,
  p_fingerprint text, p_ledger_facts jsonb, p_results jsonb, p_summary jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE pc period_closes; run_id uuid; now_fp text; unresolved jsonb; st text; per accounting_periods;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) = 0 THEN RAISE EXCEPTION 'a run needs its control results'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) r WHERE r->>'status' NOT IN ('PASS', 'WARNING', 'BLOCK') OR coalesce(r->>'code', '') = '' OR coalesce(r->>'evidence_hash', '') = '') THEN
    RAISE EXCEPTION 'every control result needs a code, a PASS/WARNING/BLOCK status and an evidence hash';
  END IF;
  SELECT * INTO per FROM accounting_periods WHERE id = p_period AND community_id = p_community FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no accounting period % for this community', p_period; END IF;
  IF per.status IN ('closed', 'locked') THEN RAISE EXCEPTION 'period_closed: this month is closed; reopen it before running the checklist again'; END IF;
  now_fp := close_ledger_facts(p_community, p_period)->>'fingerprint';
  IF now_fp IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'books_changed: the books changed while the checklist ran; run it again'; END IF;
  pc := close_ensure_record(p_community, p_period);
  INSERT INTO period_close_runs (community_id, period_id, period_start, period_end, run_by, run_by_user_id, engine_version, fingerprint, ledger_facts, results, summary, status_after)
  VALUES (p_community, p_period, per.period_start, per.period_end, btrim(p_actor), p_actor_user_id, p_engine_version, p_fingerprint, p_ledger_facts, p_results, p_summary, 'review')
  RETURNING id INTO run_id;
  unresolved := close_unresolved_blocks(run_id);
  st := CASE WHEN jsonb_array_length(unresolved) = 0 THEN 'ready_to_close' ELSE 'review' END;
  PERFORM set_config('trusted.close_txn', 'on', true);
  UPDATE period_closes SET status = st, latest_run_id = run_id WHERE id = pc.id;
  INSERT INTO period_close_events (community_id, period_id, run_id, event, actor, actor_user_id, actor_role, detail)
  VALUES (p_community, p_period, run_id, 'run', btrim(p_actor), p_actor_user_id, 'staff', jsonb_build_object('summary', p_summary, 'unresolved_blocks', unresolved, 'status', st));
  RETURN jsonb_build_object('run_id', run_id, 'status', st, 'unresolved_blocks', unresolved);
END;
$fn$;

-- A run's status_after is computed as the row is written (runs are append-only):
-- ready_to_close when every BLOCK already carries an owner override for the same
-- evidence in this close cycle.
CREATE OR REPLACE FUNCTION period_close_runs_status_after() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.results) r
     WHERE r->>'status' = 'BLOCK'
       AND NOT EXISTS (SELECT 1 FROM period_close_events e
                        WHERE e.period_id = NEW.period_id AND e.event = 'block_overridden' AND e.control_code = r->>'code'
                          AND e.evidence_hash = r->>'evidence_hash' AND e.created_at > close_cycle_start(NEW.period_id))) THEN
    NEW.status_after := 'ready_to_close';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_period_close_runs_status_after ON period_close_runs;
CREATE TRIGGER trg_period_close_runs_status_after BEFORE INSERT ON period_close_runs FOR EACH ROW EXECUTE FUNCTION period_close_runs_status_after();

-- ---------------------------------------------------------------- owner override of a BLOCK
CREATE OR REPLACE FUNCTION close_override_block(p_community uuid, p_period uuid, p_run uuid, p_control_code text, p_reason text,
  p_actor text, p_actor_user_id uuid, p_actor_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE pc period_closes; res jsonb; unresolved jsonb; st text;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'override_refused: only the owner can override a BLOCK'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'override_refused: a BLOCK override needs a written reason (10+ characters)'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  SELECT * INTO pc FROM period_closes WHERE period_id = p_period AND community_id = p_community FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run the checklist first'; END IF;
  IF pc.status = 'closed' THEN RAISE EXCEPTION 'period_closed: this month is closed'; END IF;
  IF pc.latest_run_id IS DISTINCT FROM p_run THEN RAISE EXCEPTION 'stale_run: a newer checklist run exists; override on the latest run'; END IF;
  SELECT r INTO res FROM period_close_runs run, jsonb_array_elements(run.results) r WHERE run.id = p_run AND r->>'code' = p_control_code;
  IF res IS NULL THEN RAISE EXCEPTION 'no control % on this run', p_control_code; END IF;
  IF res->>'status' <> 'BLOCK' THEN RAISE EXCEPTION 'control % is %, not BLOCK; only a BLOCK is overridden', p_control_code, res->>'status'; END IF;
  INSERT INTO period_close_events (community_id, period_id, run_id, event, control_code, evidence_hash, actor, actor_user_id, actor_role, reason, detail)
  VALUES (p_community, p_period, p_run, 'block_overridden', p_control_code, res->>'evidence_hash', btrim(p_actor), p_actor_user_id, 'owner', btrim(p_reason),
          jsonb_build_object('original_result', res));
  unresolved := close_unresolved_blocks(p_run);
  st := CASE WHEN jsonb_array_length(unresolved) = 0 THEN 'ready_to_close' ELSE 'review' END;
  PERFORM set_config('trusted.close_txn', 'on', true);
  UPDATE period_closes SET status = st WHERE id = pc.id;
  RETURN jsonb_build_object('status', st, 'unresolved_blocks', unresolved);
END;
$fn$;

-- ---------------------------------------------------------------- accept WARNINGs on the latest run
CREATE OR REPLACE FUNCTION close_accept_warnings(p_community uuid, p_period uuid, p_run uuid, p_control_codes jsonb, p_note text,
  p_actor text, p_actor_user_id uuid, p_actor_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE pc period_closes; bad text[]; codes text[];
BEGIN
  IF jsonb_typeof(p_control_codes) <> 'array' THEN RAISE EXCEPTION 'name the warnings being accepted'; END IF;
  codes := ARRAY(SELECT jsonb_array_elements_text(p_control_codes));
  IF p_actor_role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'accept_refused: warnings are accepted by an admin or the owner'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  IF coalesce(array_length(codes, 1), 0) = 0 THEN RAISE EXCEPTION 'name the warnings being accepted'; END IF;
  SELECT * INTO pc FROM period_closes WHERE period_id = p_period AND community_id = p_community FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run the checklist first'; END IF;
  IF pc.status = 'closed' THEN RAISE EXCEPTION 'period_closed: this month is closed'; END IF;
  IF pc.latest_run_id IS DISTINCT FROM p_run THEN RAISE EXCEPTION 'stale_run: a newer checklist run exists'; END IF;
  SELECT array_agg(c) INTO bad FROM unnest(codes) c
   WHERE NOT EXISTS (SELECT 1 FROM period_close_runs run, jsonb_array_elements(run.results) r WHERE run.id = p_run AND r->>'code' = c AND r->>'status' = 'WARNING');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'not a WARNING on this run: %', array_to_string(bad, ', '); END IF;
  INSERT INTO period_close_events (community_id, period_id, run_id, event, actor, actor_user_id, actor_role, reason, detail)
  VALUES (p_community, p_period, p_run, 'warnings_accepted', btrim(p_actor), p_actor_user_id, p_actor_role, nullif(btrim(coalesce(p_note, '')), ''),
          jsonb_build_object('control_codes', to_jsonb(codes),
            'results', (SELECT jsonb_agg(r) FROM period_close_runs run, jsonb_array_elements(run.results) r WHERE run.id = p_run AND r->>'code' = ANY (codes))));
  RETURN jsonb_build_object('accepted', to_jsonb(codes));
END;
$fn$;

-- ---------------------------------------------------------------- close
CREATE OR REPLACE FUNCTION close_period(p_community uuid, p_period uuid, p_run uuid, p_actor text, p_actor_user_id uuid, p_actor_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE pc period_closes; run period_close_runs; per accounting_periods; now_fp text; unresolved jsonb; unaccepted jsonb; earlier jsonb;
        ovr jsonb; acc jsonb; lbl text; cyc timestamptz;
BEGIN
  IF p_actor_role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'close_refused: a month is closed by an admin or the owner'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  SELECT * INTO per FROM accounting_periods WHERE id = p_period AND community_id = p_community FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no accounting period % for this community', p_period; END IF;
  IF per.status IN ('closed', 'locked') THEN RAISE EXCEPTION 'period_closed: already closed'; END IF;
  SELECT * INTO pc FROM period_closes WHERE period_id = p_period FOR UPDATE;
  IF NOT FOUND OR pc.latest_run_id IS NULL THEN RAISE EXCEPTION 'close_refused: run the checklist first'; END IF;
  IF pc.latest_run_id IS DISTINCT FROM p_run THEN RAISE EXCEPTION 'stale_run: a newer checklist run exists; close on the latest run'; END IF;
  SELECT * INTO run FROM period_close_runs WHERE id = p_run;
  now_fp := close_ledger_facts(p_community, p_period)->>'fingerprint';
  IF now_fp IS DISTINCT FROM run.fingerprint THEN RAISE EXCEPTION 'books_changed: the books changed since the checklist ran; run it again before closing'; END IF;
  earlier := close_previous_open_periods(p_community, p_period);
  IF jsonb_array_length(earlier) > 0 THEN RAISE EXCEPTION 'close_refused: close the earlier months first (%)', earlier; END IF;
  unresolved := close_unresolved_blocks(p_run);
  IF jsonb_array_length(unresolved) > 0 THEN RAISE EXCEPTION 'close_refused: BLOCK controls not overridden by the owner: %', unresolved; END IF;
  cyc := close_cycle_start(p_period);
  SELECT coalesce(jsonb_agg(r->>'code' ORDER BY r->>'code'), '[]'::jsonb) INTO unaccepted
    FROM jsonb_array_elements(run.results) r
   WHERE r->>'status' = 'WARNING'
     AND NOT EXISTS (SELECT 1 FROM period_close_events e, jsonb_array_elements_text(e.detail->'control_codes') c
                      WHERE e.period_id = p_period AND e.run_id = p_run AND e.event = 'warnings_accepted' AND c = r->>'code');
  IF jsonb_array_length(unaccepted) > 0 THEN RAISE EXCEPTION 'close_refused: accept these warnings first: %', unaccepted; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('control_code', e.control_code, 'reason', e.reason, 'actor', e.actor, 'at', e.created_at,
           'evidence_hash', e.evidence_hash, 'original_result', e.detail->'original_result') ORDER BY e.seq), '[]'::jsonb)
    INTO ovr FROM period_close_events e, jsonb_array_elements(run.results) r
   WHERE e.period_id = p_period AND e.event = 'block_overridden' AND e.created_at > cyc AND r->>'status' = 'BLOCK'
     AND e.control_code = r->>'code' AND e.evidence_hash = r->>'evidence_hash';
  SELECT coalesce(jsonb_agg(jsonb_build_object('control_code', c, 'accepted_by', e.actor, 'at', e.created_at, 'note', e.reason) ORDER BY e.seq), '[]'::jsonb)
    INTO acc FROM period_close_events e, jsonb_array_elements_text(e.detail->'control_codes') c
   WHERE e.period_id = p_period AND e.run_id = p_run AND e.event = 'warnings_accepted';
  lbl := CASE WHEN jsonb_array_length(ovr) > 0 THEN 'closed_with_override' ELSE 'closed' END;

  PERFORM set_config('trusted.close_txn', 'on', true);
  UPDATE accounting_periods SET status = 'closed', closed_at = now(), closed_by_user_id = p_actor_user_id WHERE id = p_period;
  UPDATE period_closes SET status = 'closed', close_label = lbl, close_run_id = p_run, fingerprint = run.fingerprint,
         closed_at = now(), closed_by = btrim(p_actor), closed_by_user_id = p_actor_user_id, closed_by_role = p_actor_role,
         accepted_warnings = acc, overrides = ovr
   WHERE id = pc.id;
  INSERT INTO period_close_events (community_id, period_id, run_id, event, actor, actor_user_id, actor_role, detail)
  VALUES (p_community, p_period, p_run, 'closed', btrim(p_actor), p_actor_user_id, p_actor_role,
          jsonb_build_object('label', lbl, 'fingerprint', run.fingerprint, 'overrides', ovr, 'accepted_warnings', acc));
  RETURN jsonb_build_object('status', 'closed', 'label', lbl, 'closed_through', per.period_end, 'fingerprint', run.fingerprint);
END;
$fn$;

-- ---------------------------------------------------------------- reopen
CREATE OR REPLACE FUNCTION reopen_period(p_community uuid, p_period uuid, p_reason text, p_actor text, p_actor_user_id uuid, p_actor_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE per accounting_periods; later jsonb;
BEGIN
  IF p_actor_role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'reopen_refused: a closed month is reopened by an admin or the owner'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'reopen_refused: a reopen needs a written reason (10+ characters)'; END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  SELECT * INTO per FROM accounting_periods WHERE id = p_period AND community_id = p_community FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no accounting period % for this community', p_period; END IF;
  IF per.status = 'locked' THEN RAISE EXCEPTION 'reopen_refused: a locked period is final'; END IF;
  IF per.status <> 'closed' THEN RAISE EXCEPTION 'reopen_refused: this month is not closed'; END IF;
  SELECT coalesce(jsonb_agg(to_char(period_end, 'YYYY-MM') ORDER BY period_end), '[]'::jsonb) INTO later
    FROM accounting_periods WHERE community_id = p_community AND period_end > per.period_end AND status IN ('closed', 'locked');
  IF jsonb_array_length(later) > 0 THEN RAISE EXCEPTION 'reopen_refused: reopen the later closed months first (%)', later; END IF;
  PERFORM set_config('trusted.close_txn', 'on', true);
  UPDATE accounting_periods SET status = 'reopened', reopened_at = now(), reopened_by_user_id = p_actor_user_id, reopened_reason = btrim(p_reason) WHERE id = p_period;
  PERFORM close_ensure_record(p_community, p_period);
  UPDATE period_closes SET status = 'open', reopened_at = now(), reopened_by = btrim(p_actor), reopen_reason = btrim(p_reason), reopen_count = reopen_count + 1
   WHERE period_id = p_period;
  INSERT INTO period_close_events (community_id, period_id, event, actor, actor_user_id, actor_role, reason, detail)
  VALUES (p_community, p_period, 'reopened', btrim(p_actor), p_actor_user_id, p_actor_role, btrim(p_reason),
          (SELECT jsonb_build_object('previous_label', close_label, 'previous_closed_at', closed_at, 'previous_closed_by', closed_by, 'previous_fingerprint', fingerprint)
             FROM period_closes WHERE period_id = p_period));
  RETURN jsonb_build_object('status', 'open', 'reopened', per.period_end);
END;
$fn$;

-- ---------------------------------------------------------------- evidence for an 'other' required source
CREATE OR REPLACE FUNCTION close_add_evidence(p_community uuid, p_period uuid, p_requirement uuid, p_document_ref text, p_note text, p_actor text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE rid uuid;
BEGIN
  IF coalesce(btrim(p_document_ref), '') = '' OR coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'document and actor required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM close_source_requirements WHERE id = p_requirement AND community_id = p_community AND source_key = 'other') THEN
    RAISE EXCEPTION 'no such "other" source requirement for this community';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_periods WHERE id = p_period AND status IN ('closed', 'locked')) THEN RAISE EXCEPTION 'period_closed: this month is closed'; END IF;
  INSERT INTO period_close_evidence (community_id, period_id, requirement_id, document_ref, note, provided_by)
  VALUES (p_community, p_period, p_requirement, btrim(p_document_ref), nullif(btrim(coalesce(p_note, '')), ''), btrim(p_actor)) RETURNING id INTO rid;
  RETURN rid;
END;
$fn$;

-- ---------------------------------------------------------------- privileges
-- The close tables are read-only to the API; every write is a function above.
-- (Supabase may grant new tables to the API roles by default; take that back first.)
REVOKE ALL ON period_closes, period_close_runs, period_close_events, period_close_evidence, close_source_requirements FROM anon, authenticated, service_role;
GRANT SELECT ON period_closes, period_close_runs, period_close_events, period_close_evidence TO service_role;
GRANT SELECT, INSERT, UPDATE ON close_source_requirements TO service_role;
-- close_closed_through / close_is_locked stay callable by every role: the lock
-- triggers call them as whoever is writing, and "is this date closed" is not secret.
REVOKE ALL ON FUNCTION close_ledger_facts(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_cycle_start(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_unresolved_blocks(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_previous_open_periods(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_ensure_record(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_record_run(uuid, uuid, text, uuid, text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_override_block(uuid, uuid, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_accept_warnings(uuid, uuid, uuid, jsonb, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_period(uuid, uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reopen_period(uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_add_evidence(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION close_closed_through(uuid), close_ledger_facts(uuid, uuid), close_unresolved_blocks(uuid),
  close_previous_open_periods(uuid, uuid), close_record_run(uuid, uuid, text, uuid, text, text, jsonb, jsonb, jsonb),
  close_override_block(uuid, uuid, uuid, text, text, text, uuid, text), close_accept_warnings(uuid, uuid, uuid, jsonb, text, text, uuid, text),
  close_period(uuid, uuid, uuid, text, uuid, text), reopen_period(uuid, uuid, text, text, uuid, text),
  close_add_evidence(uuid, uuid, uuid, text, text, text) TO service_role;

COMMIT;
