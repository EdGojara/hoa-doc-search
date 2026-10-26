-- ============================================================================
-- 547_time_attendance.sql  (Ed 2026-10-26)
-- ----------------------------------------------------------------------------
-- Staff Time & Attendance. Additive only: no existing table or row is changed.
-- user_profiles is referenced, never modified.
--
-- Record ownership: workpaper. These are Bedrock's own employment records,
-- never an association's; they carry no community_id. Activity summaries may
-- be TAGGED with communities (ta_activity_communities, FK communities) so labor
-- by association can be measured later; the tag does not make the row an
-- association record.
--
-- Tables
--   ta_settings             one row: workweek start (default Sunday, Central),
--                           weekly threshold (2400 min = 40 h), payroll period
--                           schedule (configurable; NULL until entered).
--   ta_employees            who is enrolled, hourly (nonexempt) or salaried
--                           (exempt), whether they clock in. FK user_profiles.
--   ta_punches              clock in / out. APPEND-ONLY. The database sets the
--                           time (now()); a client-sent time is overwritten. A
--                           reason is required (CHECK by direction; 'other'
--                           needs a note). No UPDATE, DELETE or TRUNCATE by
--                           anyone (trigger + revoked grants).
--   ta_corrections          requests to add a missing punch, change a punch's
--                           time, or void a punch. The original punch is never
--                           touched; the original time and direction are also
--                           snapshotted on the request. One decision only
--                           (pending -> approved | rejected | withdrawn), by an
--                           active admin who is not the employee, with a reason;
--                           every request and decision writes audit_events in
--                           the same transaction.
--   ta_overtime_requests    permission to work past the weekly threshold. Same
--                           one-decision rule and audit.
--   ta_activity_summaries   daily categories, accomplishments, outstanding,
--                           notes. APPEND-ONLY; an edit is a new version.
--                           Never read by the hours calculation.
--   ta_activity_communities optional community tags on a summary version.
--   v_ta_effective_punches  original punches with approved corrections applied
--                           (security_invoker, so RLS still applies).
--
-- Privacy (database level)
--   RLS on every table. authenticated may SELECT only its own rows
--   (user_id = auth.uid()); it has no INSERT/UPDATE/DELETE grant at all.
--   Employees write only through SECURITY DEFINER functions that take the
--   employee from auth.uid(), never from a parameter. Owner actions run as
--   service_role through functions that require an active admin actor.
--   anon has nothing.
--
-- Never deducts time: nothing here closes an open shift or subtracts a break.
-- Paid-hours rules live in lib/time_attendance/hours.js (pure, tested).
--
-- Rollback: code first (revert the PR). The tables are append-only history and
-- are not dropped; with no code calling them they are inert.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ta_settings (
  id                        smallint    NOT NULL DEFAULT 1,
  timezone                  text        NOT NULL DEFAULT 'America/Chicago',
  workweek_start_dow        smallint    NOT NULL DEFAULT 0,
  weekly_threshold_minutes  integer     NOT NULL DEFAULT 2400,
  pay_frequency             text,
  pay_period_anchor         date,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid,
  CONSTRAINT ta_settings_pkey PRIMARY KEY (id),
  CONSTRAINT ta_settings_singleton CHECK (id = 1),
  CONSTRAINT ta_settings_timezone_check CHECK (timezone = 'America/Chicago'),
  CONSTRAINT ta_settings_workweek_dow_check CHECK (workweek_start_dow BETWEEN 0 AND 6),
  CONSTRAINT ta_settings_threshold_check CHECK (weekly_threshold_minutes BETWEEN 60 AND 6000),
  CONSTRAINT ta_settings_pay_frequency_check CHECK (pay_frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  CONSTRAINT ta_settings_anchor_needed CHECK (pay_frequency IS NULL OR pay_frequency NOT IN ('weekly', 'biweekly') OR pay_period_anchor IS NOT NULL),
  CONSTRAINT ta_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES user_profiles(id) ON DELETE RESTRICT
);
INSERT INTO ta_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Enrollment
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ta_employees (
  user_id      uuid        NOT NULL,
  flsa_status  text        NOT NULL DEFAULT 'nonexempt',
  tracks_time  boolean     NOT NULL DEFAULT true,
  active       boolean     NOT NULL DEFAULT true,
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  enrolled_by  uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ta_employees_pkey PRIMARY KEY (user_id),
  CONSTRAINT ta_employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT ta_employees_enrolled_by_fkey FOREIGN KEY (enrolled_by) REFERENCES user_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT ta_employees_flsa_status_check CHECK (flsa_status IN ('nonexempt', 'exempt')),
  CONSTRAINT ta_employees_nonexempt_tracks_time CHECK (flsa_status = 'exempt' OR tracks_time)
);

-- ---------------------------------------------------------------------------
-- Punches (append-only; the database sets the time)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ta_punches (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL,
  direction            text        NOT NULL,
  punched_at           timestamptz NOT NULL DEFAULT now(),
  reason               text        NOT NULL,
  note                 text,
  worked_during_break  boolean     NOT NULL DEFAULT false,
  source               text        NOT NULL DEFAULT 'web',
  client_ip            text,
  user_agent           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ta_punches_pkey PRIMARY KEY (id),
  CONSTRAINT ta_punches_user_id_fkey FOREIGN KEY (user_id) REFERENCES ta_employees(user_id) ON DELETE RESTRICT,
  CONSTRAINT ta_punches_direction_check CHECK (direction IN ('in', 'out')),
  CONSTRAINT ta_punches_reason_check CHECK (
    (direction = 'in'  AND reason IN ('start_shift', 'back_from_break', 'back_from_meal', 'back_from_personal', 'other'))
    OR (direction = 'out' AND reason IN ('rest_break', 'meal_break', 'personal', 'end_of_shift', 'other'))
  ),
  CONSTRAINT ta_punches_other_needs_note CHECK (reason <> 'other' OR length(btrim(coalesce(note, ''))) > 0),
  CONSTRAINT ta_punches_worked_break_on_in CHECK (NOT worked_during_break OR direction = 'in'),
  CONSTRAINT ta_punches_source_check CHECK (source IN ('web')),
  CONSTRAINT ta_punches_note_len CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX IF NOT EXISTS idx_ta_punches_user_time ON ta_punches (user_id, punched_at DESC);
CREATE INDEX IF NOT EXISTS idx_ta_punches_time ON ta_punches (punched_at);

-- Server time, and a sane sequence: no clock-out without an open clock-in, no
-- second clock-in on the same Central day while one is open. A clock-in left
-- open from an earlier day does not block today (that is a missing punch,
-- fixed by a correction, never by refusing to record work).
CREATE OR REPLACE FUNCTION ta_punches_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_last ta_punches%ROWTYPE;
BEGIN
  NEW.punched_at := now();
  NEW.created_at := now();
  PERFORM pg_advisory_xact_lock(hashtextextended('ta_punch:' || NEW.user_id::text, 0));
  SELECT * INTO v_last FROM ta_punches
   WHERE user_id = NEW.user_id ORDER BY punched_at DESC, created_at DESC LIMIT 1;
  IF NEW.direction = 'out' AND (NOT FOUND OR v_last.direction <> 'in') THEN
    RAISE EXCEPTION 'ta_sequence: not clocked in' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.direction = 'in' AND FOUND AND v_last.direction = 'in'
     AND (v_last.punched_at AT TIME ZONE 'America/Chicago')::date = (NEW.punched_at AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'ta_sequence: already clocked in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_ta_punches_before_insert ON ta_punches;
CREATE TRIGGER trg_ta_punches_before_insert
  BEFORE INSERT ON ta_punches
  FOR EACH ROW EXECUTE FUNCTION ta_punches_before_insert();

CREATE OR REPLACE FUNCTION ta_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_ta_punches_append_only ON ta_punches;
CREATE TRIGGER trg_ta_punches_append_only
  BEFORE UPDATE OR DELETE ON ta_punches
  FOR EACH ROW EXECUTE FUNCTION ta_append_only();
DROP TRIGGER IF EXISTS trg_ta_punches_no_truncate ON ta_punches;
CREATE TRIGGER trg_ta_punches_no_truncate
  BEFORE TRUNCATE ON ta_punches
  FOR EACH STATEMENT EXECUTE FUNCTION ta_append_only();

-- ---------------------------------------------------------------------------
-- Corrections (request -> one decision; originals preserved)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ta_corrections (
  id                            uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id                       uuid        NOT NULL,
  kind                          text        NOT NULL,
  punch_id                      uuid,
  original_at                   timestamptz,
  original_direction            text,
  proposed_direction            text,
  proposed_at                   timestamptz,
  proposed_reason               text,
  proposed_worked_during_break  boolean     NOT NULL DEFAULT false,
  employee_reason               text        NOT NULL,
  requested_by                  uuid        NOT NULL,
  requested_at                  timestamptz NOT NULL DEFAULT now(),
  status                        text        NOT NULL DEFAULT 'pending',
  decided_by                    uuid,
  decided_at                    timestamptz,
  decision_reason               text,
  CONSTRAINT ta_corrections_pkey PRIMARY KEY (id),
  CONSTRAINT ta_corrections_user_id_fkey FOREIGN KEY (user_id) REFERENCES ta_employees(user_id) ON DELETE RESTRICT,
  CONSTRAINT ta_corrections_punch_id_fkey FOREIGN KEY (punch_id) REFERENCES ta_punches(id) ON DELETE RESTRICT,
  CONSTRAINT ta_corrections_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES user_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT ta_corrections_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES user_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT ta_corrections_kind_check CHECK (kind IN ('add_punch', 'change_time', 'void_punch')),
  CONSTRAINT ta_corrections_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT ta_corrections_shape CHECK (
    (kind = 'add_punch' AND punch_id IS NULL AND proposed_direction IN ('in', 'out') AND proposed_at IS NOT NULL AND proposed_reason IS NOT NULL)
    OR (kind = 'change_time' AND punch_id IS NOT NULL AND proposed_at IS NOT NULL)
    OR (kind = 'void_punch' AND punch_id IS NOT NULL AND proposed_at IS NULL)
  ),
  CONSTRAINT ta_corrections_proposed_reason_check CHECK (proposed_reason IS NULL OR
    (proposed_direction = 'in'  AND proposed_reason IN ('start_shift', 'back_from_break', 'back_from_meal', 'back_from_personal', 'other'))
    OR (proposed_direction = 'out' AND proposed_reason IN ('rest_break', 'meal_break', 'personal', 'end_of_shift', 'other'))),
  CONSTRAINT ta_corrections_reason_not_blank CHECK (length(btrim(employee_reason)) > 0 AND length(employee_reason) <= 1000),
  CONSTRAINT ta_corrections_decision_coherent CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status = 'withdrawn' AND decided_by IS NULL AND decided_at IS NOT NULL)
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND length(btrim(coalesce(decision_reason, ''))) > 0)
  ),
  CONSTRAINT ta_corrections_no_self_approval CHECK (decided_by IS NULL OR decided_by <> user_id)
);
CREATE INDEX IF NOT EXISTS idx_ta_corrections_user ON ta_corrections (user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ta_corrections_pending ON ta_corrections (requested_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ta_corrections_one_pending_per_punch ON ta_corrections (punch_id) WHERE status = 'pending' AND punch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ta_corrections_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_p ta_punches%ROWTYPE;
BEGIN
  NEW.requested_at := now();
  NEW.status := 'pending';
  NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.decision_reason := NULL;
  NEW.original_at := NULL; NEW.original_direction := NULL;
  IF NEW.punch_id IS NOT NULL THEN
    SELECT * INTO v_p FROM ta_punches WHERE id = NEW.punch_id;
    IF NOT FOUND OR v_p.user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'ta_correction: that punch is not this employee''s' USING ERRCODE = 'check_violation';
    END IF;
    NEW.original_at := v_p.punched_at;
    NEW.original_direction := v_p.direction;
  END IF;
  IF NEW.proposed_at IS NOT NULL AND NEW.proposed_at > now() THEN
    RAISE EXCEPTION 'ta_correction: a corrected time cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'change_time' AND NEW.proposed_at = NEW.original_at THEN
    RAISE EXCEPTION 'ta_correction: the corrected time is the same as the original' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_ta_corrections_before_insert ON ta_corrections;
CREATE TRIGGER trg_ta_corrections_before_insert
  BEFORE INSERT ON ta_corrections
  FOR EACH ROW EXECUTE FUNCTION ta_corrections_before_insert();

-- One decision, ever. Everything the employee asked for stays exactly as asked.
CREATE OR REPLACE FUNCTION ta_corrections_decide_once() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'ta_corrections: a decided request is final (status %)', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.user_id, NEW.kind, NEW.punch_id, NEW.original_at, NEW.original_direction, NEW.proposed_direction, NEW.proposed_at,
      NEW.proposed_reason, NEW.proposed_worked_during_break, NEW.employee_reason, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.kind, OLD.punch_id, OLD.original_at, OLD.original_direction, OLD.proposed_direction, OLD.proposed_at,
      OLD.proposed_reason, OLD.proposed_worked_during_break, OLD.employee_reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'ta_corrections: the request itself cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'ta_corrections: invalid decision %', NEW.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_ta_corrections_decide_once ON ta_corrections;
CREATE TRIGGER trg_ta_corrections_decide_once
  BEFORE UPDATE ON ta_corrections
  FOR EACH ROW EXECUTE FUNCTION ta_corrections_decide_once();
DROP TRIGGER IF EXISTS trg_ta_corrections_no_delete ON ta_corrections;
CREATE TRIGGER trg_ta_corrections_no_delete
  BEFORE DELETE ON ta_corrections
  FOR EACH ROW EXECUTE FUNCTION ta_append_only();
DROP TRIGGER IF EXISTS trg_ta_corrections_no_truncate ON ta_corrections;
CREATE TRIGGER trg_ta_corrections_no_truncate
  BEFORE TRUNCATE ON ta_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION ta_append_only();

-- ---------------------------------------------------------------------------
-- Overtime permission
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ta_overtime_requests (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL,
  week_start       date        NOT NULL,
  extra_minutes    integer     NOT NULL,
  employee_reason  text        NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL DEFAULT 'pending',
  decided_by       uuid,
  decided_at       timestamptz,
  decision_reason  text,
  CONSTRAINT ta_overtime_requests_pkey PRIMARY KEY (id),
  CONSTRAINT ta_overtime_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES ta_employees(user_id) ON DELETE RESTRICT,
  CONSTRAINT ta_overtime_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES user_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT ta_overtime_requests_minutes_check CHECK (extra_minutes BETWEEN 15 AND 2400),
  CONSTRAINT ta_overtime_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT ta_overtime_requests_reason_not_blank CHECK (length(btrim(employee_reason)) > 0 AND length(employee_reason) <= 1000),
  CONSTRAINT ta_overtime_requests_decision_coherent CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status = 'withdrawn' AND decided_by IS NULL AND decided_at IS NOT NULL)
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND length(btrim(coalesce(decision_reason, ''))) > 0)
  ),
  CONSTRAINT ta_overtime_requests_no_self_approval CHECK (decided_by IS NULL OR decided_by <> user_id)
);
CREATE INDEX IF NOT EXISTS idx_ta_overtime_user_week ON ta_overtime_requests (user_id, week_start);
CREATE INDEX IF NOT EXISTS idx_ta_overtime_pending ON ta_overtime_requests (requested_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION ta_overtime_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.requested_at := now();
  NEW.status := 'pending';
  NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.decision_reason := NULL;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_ta_overtime_before_insert ON ta_overtime_requests;
CREATE TRIGGER trg_ta_overtime_before_insert
  BEFORE INSERT ON ta_overtime_requests
  FOR EACH ROW EXECUTE FUNCTION ta_overtime_before_insert();

CREATE OR REPLACE FUNCTION ta_overtime_decide_once() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'ta_overtime_requests: a decided request is final (status %)', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.user_id, NEW.week_start, NEW.extra_minutes, NEW.employee_reason, NEW.requested_at)
     IS DISTINCT FROM (OLD.user_id, OLD.week_start, OLD.extra_minutes, OLD.employee_reason, OLD.requested_at) THEN
    RAISE EXCEPTION 'ta_overtime_requests: the request itself cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'ta_overtime_requests: invalid decision %', NEW.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_ta_overtime_decide_once ON ta_overtime_requests;
CREATE TRIGGER trg_ta_overtime_decide_once
  BEFORE UPDATE ON ta_overtime_requests
  FOR EACH ROW EXECUTE FUNCTION ta_overtime_decide_once();
DROP TRIGGER IF EXISTS trg_ta_overtime_no_delete ON ta_overtime_requests;
CREATE TRIGGER trg_ta_overtime_no_delete
  BEFORE DELETE ON ta_overtime_requests
  FOR EACH ROW EXECUTE FUNCTION ta_append_only();
DROP TRIGGER IF EXISTS trg_ta_overtime_no_truncate ON ta_overtime_requests;
CREATE TRIGGER trg_ta_overtime_no_truncate
  BEFORE TRUNCATE ON ta_overtime_requests
  FOR EACH STATEMENT EXECUTE FUNCTION ta_append_only();

-- ---------------------------------------------------------------------------
-- Daily activity summaries (append-only versions; separate from hours)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ta_activity_summaries (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL,
  work_date        date        NOT NULL,
  version          integer     NOT NULL DEFAULT 1,
  categories       text[]      NOT NULL,
  accomplishments  text        NOT NULL,
  outstanding      text        NOT NULL,
  notes            text,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ta_activity_summaries_pkey PRIMARY KEY (id),
  CONSTRAINT ta_activity_summaries_user_id_fkey FOREIGN KEY (user_id) REFERENCES ta_employees(user_id) ON DELETE RESTRICT,
  CONSTRAINT uq_ta_activity_summaries_version UNIQUE (user_id, work_date, version),
  CONSTRAINT ta_activity_summaries_categories_check CHECK (
    cardinality(categories) >= 1 AND categories <@ ARRAY['accounting_ap', 'collections', 'compliance_drv', 'acc_arc', 'board_support',
      'homeowner_communication', 'vendors_maintenance', 'amenities', 'admin', 'training', 'other']::text[]
  ),
  CONSTRAINT ta_activity_summaries_text_check CHECK (
    length(btrim(accomplishments)) > 0 AND length(accomplishments) <= 4000
    AND length(btrim(outstanding)) > 0 AND length(outstanding) <= 4000
    AND (notes IS NULL OR length(notes) <= 4000)
  )
);
CREATE INDEX IF NOT EXISTS idx_ta_activity_date ON ta_activity_summaries (work_date, user_id);

CREATE TABLE IF NOT EXISTS ta_activity_communities (
  summary_id    uuid NOT NULL,
  community_id  uuid NOT NULL,
  CONSTRAINT ta_activity_communities_pkey PRIMARY KEY (summary_id, community_id),
  CONSTRAINT ta_activity_communities_summary_id_fkey FOREIGN KEY (summary_id) REFERENCES ta_activity_summaries(id) ON DELETE RESTRICT,
  CONSTRAINT ta_activity_communities_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_ta_activity_communities_community ON ta_activity_communities (community_id);

CREATE OR REPLACE FUNCTION ta_activity_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.submitted_at := now();
  PERFORM pg_advisory_xact_lock(hashtextextended('ta_activity:' || NEW.user_id::text || ':' || NEW.work_date::text, 0));
  SELECT coalesce(max(version), 0) + 1 INTO NEW.version FROM ta_activity_summaries
   WHERE user_id = NEW.user_id AND work_date = NEW.work_date;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_ta_activity_before_insert ON ta_activity_summaries;
CREATE TRIGGER trg_ta_activity_before_insert
  BEFORE INSERT ON ta_activity_summaries
  FOR EACH ROW EXECUTE FUNCTION ta_activity_before_insert();
DROP TRIGGER IF EXISTS trg_ta_activity_append_only ON ta_activity_summaries;
CREATE TRIGGER trg_ta_activity_append_only
  BEFORE UPDATE OR DELETE ON ta_activity_summaries
  FOR EACH ROW EXECUTE FUNCTION ta_append_only();
DROP TRIGGER IF EXISTS trg_ta_activity_no_truncate ON ta_activity_summaries;
CREATE TRIGGER trg_ta_activity_no_truncate
  BEFORE TRUNCATE ON ta_activity_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION ta_append_only();
DROP TRIGGER IF EXISTS trg_ta_activity_communities_append_only ON ta_activity_communities;
CREATE TRIGGER trg_ta_activity_communities_append_only
  BEFORE UPDATE OR DELETE ON ta_activity_communities
  FOR EACH ROW EXECUTE FUNCTION ta_append_only();

-- ---------------------------------------------------------------------------
-- Effective punches: originals with the latest approved correction applied.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_ta_effective_punches;
CREATE VIEW v_ta_effective_punches WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (c.punch_id) c.id, c.punch_id, c.kind, c.proposed_at
    FROM ta_corrections c
   WHERE c.status = 'approved' AND c.punch_id IS NOT NULL
   ORDER BY c.punch_id, c.decided_at DESC, c.id DESC
)
SELECT p.id AS punch_id, p.user_id, p.direction,
       coalesce(l.proposed_at, p.punched_at) AS effective_at,
       p.punched_at AS original_at, p.reason, p.note, p.worked_during_break,
       l.id AS correction_id, (l.id IS NOT NULL) AS is_corrected, 'punch'::text AS origin
  FROM ta_punches p
  LEFT JOIN latest l ON l.punch_id = p.id
 WHERE l.kind IS DISTINCT FROM 'void_punch'
UNION ALL
SELECT NULL::uuid, c.user_id, c.proposed_direction, c.proposed_at, NULL::timestamptz, c.proposed_reason, c.employee_reason,
       c.proposed_worked_during_break, c.id, true, 'correction'::text
  FROM ta_corrections c
 WHERE c.status = 'approved' AND c.kind = 'add_punch';

-- ---------------------------------------------------------------------------
-- Employee functions: identity is auth.uid(), never a parameter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ta_require_employee() RETURNS ta_employees
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_e   ta_employees%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'ta_auth: sign in required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT e.* INTO v_e FROM ta_employees e JOIN user_profiles u ON u.id = e.user_id
   WHERE e.user_id = v_uid AND e.active AND u.is_active IS NOT FALSE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ta_not_enrolled: this account is not enrolled in time & attendance' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_e;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_punch(p_direction text, p_reason text, p_note text DEFAULT NULL,
                                    p_worked_during_break boolean DEFAULT false,
                                    p_client_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL)
RETURNS ta_punches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_e ta_employees%ROWTYPE := ta_require_employee();
  v_p ta_punches%ROWTYPE;
BEGIN
  IF NOT v_e.tracks_time THEN
    RAISE EXCEPTION 'ta_not_enrolled: this account does not clock in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO ta_punches (user_id, direction, reason, note, worked_during_break, client_ip, user_agent)
  VALUES (v_e.user_id, p_direction, p_reason, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_worked_during_break, false),
          left(p_client_ip, 100), left(p_user_agent, 300))
  RETURNING * INTO v_p;
  RETURN v_p;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_request_correction(p_kind text, p_punch_id uuid, p_proposed_direction text, p_proposed_at timestamptz,
                                                 p_proposed_reason text, p_worked_during_break boolean, p_reason text)
RETURNS ta_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_e ta_employees%ROWTYPE := ta_require_employee();
  v_c ta_corrections%ROWTYPE;
  v_name text;
BEGIN
  INSERT INTO ta_corrections (user_id, kind, punch_id, proposed_direction, proposed_at, proposed_reason,
                              proposed_worked_during_break, employee_reason, requested_by)
  VALUES (v_e.user_id, p_kind, p_punch_id, p_proposed_direction, p_proposed_at, p_proposed_reason,
          coalesce(p_worked_during_break, false), btrim(coalesce(p_reason, '')), v_e.user_id)
  RETURNING * INTO v_c;
  SELECT full_name INTO v_name FROM user_profiles WHERE id = v_e.user_id;
  INSERT INTO audit_events (actor_user_id, actor_name, entity_type, entity_id, action, previous_value, new_value, reason, route, record_ownership)
  VALUES (v_e.user_id, v_name, 'time_correction', v_c.id::text, 'time_correction.requested',
          CASE WHEN v_c.punch_id IS NULL THEN NULL ELSE jsonb_build_object('punch_id', v_c.punch_id, 'at', v_c.original_at, 'direction', v_c.original_direction) END,
          jsonb_build_object('kind', v_c.kind, 'direction', v_c.proposed_direction, 'at', v_c.proposed_at, 'reason', v_c.proposed_reason),
          v_c.employee_reason, 'rpc ta_request_correction', 'workpaper');
  RETURN v_c;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_withdraw_correction(p_id uuid) RETURNS ta_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_e ta_employees%ROWTYPE := ta_require_employee();
  v_c ta_corrections%ROWTYPE;
BEGIN
  UPDATE ta_corrections SET status = 'withdrawn' WHERE id = p_id AND user_id = v_e.user_id AND status = 'pending' RETURNING * INTO v_c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ta_correction: no pending request of yours with that id' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_c;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_request_overtime(p_week_start date, p_extra_minutes integer, p_reason text) RETURNS ta_overtime_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_e ta_employees%ROWTYPE := ta_require_employee();
  v_r ta_overtime_requests%ROWTYPE;
  v_name text;
BEGIN
  INSERT INTO ta_overtime_requests (user_id, week_start, extra_minutes, employee_reason)
  VALUES (v_e.user_id, p_week_start, p_extra_minutes, btrim(coalesce(p_reason, '')))
  RETURNING * INTO v_r;
  SELECT full_name INTO v_name FROM user_profiles WHERE id = v_e.user_id;
  INSERT INTO audit_events (actor_user_id, actor_name, entity_type, entity_id, action, new_value, reason, route, record_ownership)
  VALUES (v_e.user_id, v_name, 'overtime_request', v_r.id::text, 'overtime.requested',
          jsonb_build_object('week_start', v_r.week_start, 'extra_minutes', v_r.extra_minutes), v_r.employee_reason,
          'rpc ta_request_overtime', 'workpaper');
  RETURN v_r;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_submit_activity(p_work_date date, p_categories text[], p_accomplishments text, p_outstanding text,
                                              p_notes text DEFAULT NULL, p_community_ids uuid[] DEFAULT '{}')
RETURNS ta_activity_summaries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_e ta_employees%ROWTYPE := ta_require_employee();
  v_s ta_activity_summaries%ROWTYPE;
BEGIN
  IF p_work_date > (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'ta_activity: a summary cannot be for a future day' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO ta_activity_summaries (user_id, work_date, categories, accomplishments, outstanding, notes)
  VALUES (v_e.user_id, p_work_date, p_categories, btrim(coalesce(p_accomplishments, '')), btrim(coalesce(p_outstanding, '')),
          nullif(btrim(coalesce(p_notes, '')), ''))
  RETURNING * INTO v_s;
  INSERT INTO ta_activity_communities (summary_id, community_id)
  SELECT DISTINCT v_s.id, c FROM unnest(coalesce(p_community_ids, '{}'::uuid[])) AS c;
  RETURN v_s;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Owner functions (service_role only; the actor must be an active admin)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ta_require_admin_actor(p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_name text;
BEGIN
  SELECT full_name INTO v_name FROM user_profiles WHERE id = p_actor AND role = 'admin' AND is_active IS NOT FALSE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ta_auth: only an active administrator can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN coalesce(v_name, 'Administrator');
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_decide_correction(p_id uuid, p_decision text, p_reason text, p_actor uuid, p_route text DEFAULT NULL)
RETURNS ta_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_name text := ta_require_admin_actor(p_actor);
  v_old ta_corrections%ROWTYPE;
  v_c   ta_corrections%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'ta_correction: decision must be approved or rejected' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_old FROM ta_corrections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ta_correction: not found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE ta_corrections SET status = p_decision, decided_by = p_actor, decision_reason = btrim(coalesce(p_reason, ''))
   WHERE id = p_id RETURNING * INTO v_c;
  INSERT INTO audit_events (actor_user_id, actor_name, entity_type, entity_id, action, field, previous_value, new_value, reason, route, record_ownership)
  VALUES (p_actor, v_name, 'time_correction', v_c.id::text, 'time_correction.' || p_decision, 'status',
          jsonb_build_object('status', v_old.status, 'employee_id', v_old.user_id, 'kind', v_old.kind, 'punch_id', v_old.punch_id,
                             'original_at', v_old.original_at, 'original_direction', v_old.original_direction),
          jsonb_build_object('status', v_c.status, 'proposed_direction', v_c.proposed_direction, 'proposed_at', v_c.proposed_at,
                             'proposed_reason', v_c.proposed_reason, 'decided_at', v_c.decided_at),
          v_c.decision_reason, p_route, 'workpaper');
  RETURN v_c;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_decide_overtime(p_id uuid, p_decision text, p_reason text, p_actor uuid, p_route text DEFAULT NULL)
RETURNS ta_overtime_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_name text := ta_require_admin_actor(p_actor);
  v_old ta_overtime_requests%ROWTYPE;
  v_r   ta_overtime_requests%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'ta_overtime: decision must be approved or rejected' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_old FROM ta_overtime_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ta_overtime: not found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE ta_overtime_requests SET status = p_decision, decided_by = p_actor, decision_reason = btrim(coalesce(p_reason, ''))
   WHERE id = p_id RETURNING * INTO v_r;
  INSERT INTO audit_events (actor_user_id, actor_name, entity_type, entity_id, action, field, previous_value, new_value, reason, route, record_ownership)
  VALUES (p_actor, v_name, 'overtime_request', v_r.id::text, 'overtime.' || p_decision, 'status',
          jsonb_build_object('status', v_old.status, 'employee_id', v_old.user_id, 'week_start', v_old.week_start, 'extra_minutes', v_old.extra_minutes),
          jsonb_build_object('status', v_r.status, 'decided_at', v_r.decided_at),
          v_r.decision_reason, p_route, 'workpaper');
  RETURN v_r;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_set_employee(p_user_id uuid, p_flsa_status text, p_tracks_time boolean, p_active boolean,
                                          p_reason text, p_actor uuid, p_route text DEFAULT NULL)
RETURNS ta_employees
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_name text := ta_require_admin_actor(p_actor);
  v_old ta_employees%ROWTYPE;
  v_e   ta_employees%ROWTYPE;
BEGIN
  IF length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'ta_employee: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_user_id = p_actor THEN
    RAISE EXCEPTION 'ta_employee: an administrator cannot enroll themself (no one could approve their corrections)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_old FROM ta_employees WHERE user_id = p_user_id FOR UPDATE;
  INSERT INTO ta_employees (user_id, flsa_status, tracks_time, active, enrolled_by)
  VALUES (p_user_id, p_flsa_status, p_tracks_time, p_active, p_actor)
  ON CONFLICT (user_id) DO UPDATE SET flsa_status = EXCLUDED.flsa_status, tracks_time = EXCLUDED.tracks_time,
                                      active = EXCLUDED.active, updated_at = now()
  RETURNING * INTO v_e;
  INSERT INTO audit_events (actor_user_id, actor_name, entity_type, entity_id, action, previous_value, new_value, reason, route, record_ownership)
  VALUES (p_actor, v_name, 'ta_employee', p_user_id::text, CASE WHEN v_old.user_id IS NULL THEN 'ta_employee.enrolled' ELSE 'ta_employee.updated' END,
          CASE WHEN v_old.user_id IS NULL THEN NULL ELSE jsonb_build_object('flsa_status', v_old.flsa_status, 'tracks_time', v_old.tracks_time, 'active', v_old.active) END,
          jsonb_build_object('flsa_status', v_e.flsa_status, 'tracks_time', v_e.tracks_time, 'active', v_e.active),
          btrim(p_reason), p_route, 'workpaper');
  RETURN v_e;
END;
$fn$;

CREATE OR REPLACE FUNCTION ta_update_settings(p_workweek_start_dow smallint, p_weekly_threshold_minutes integer, p_pay_frequency text,
                                              p_pay_period_anchor date, p_reason text, p_actor uuid, p_route text DEFAULT NULL)
RETURNS ta_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_name text := ta_require_admin_actor(p_actor);
  v_old ta_settings%ROWTYPE;
  v_s   ta_settings%ROWTYPE;
BEGIN
  IF length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'ta_settings: a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_old FROM ta_settings WHERE id = 1 FOR UPDATE;
  UPDATE ta_settings SET workweek_start_dow = p_workweek_start_dow, weekly_threshold_minutes = p_weekly_threshold_minutes,
                         pay_frequency = p_pay_frequency, pay_period_anchor = p_pay_period_anchor,
                         updated_at = now(), updated_by = p_actor
   WHERE id = 1 RETURNING * INTO v_s;
  INSERT INTO audit_events (actor_user_id, actor_name, entity_type, entity_id, action, previous_value, new_value, reason, route, record_ownership)
  VALUES (p_actor, v_name, 'ta_settings', '1', 'ta_settings.updated',
          jsonb_build_object('workweek_start_dow', v_old.workweek_start_dow, 'weekly_threshold_minutes', v_old.weekly_threshold_minutes,
                             'pay_frequency', v_old.pay_frequency, 'pay_period_anchor', v_old.pay_period_anchor),
          jsonb_build_object('workweek_start_dow', v_s.workweek_start_dow, 'weekly_threshold_minutes', v_s.weekly_threshold_minutes,
                             'pay_frequency', v_s.pay_frequency, 'pay_period_anchor', v_s.pay_period_anchor),
          btrim(p_reason), p_route, 'workpaper');
  RETURN v_s;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Row level security + grants
-- ---------------------------------------------------------------------------
ALTER TABLE ta_settings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ta_employees            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ta_punches              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ta_corrections          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ta_overtime_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ta_activity_summaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ta_activity_communities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ta_settings_read ON ta_settings;
CREATE POLICY ta_settings_read ON ta_settings FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ta_employees_own ON ta_employees;
CREATE POLICY ta_employees_own ON ta_employees FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS ta_punches_own ON ta_punches;
CREATE POLICY ta_punches_own ON ta_punches FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS ta_corrections_own ON ta_corrections;
CREATE POLICY ta_corrections_own ON ta_corrections FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS ta_overtime_own ON ta_overtime_requests;
CREATE POLICY ta_overtime_own ON ta_overtime_requests FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS ta_activity_own ON ta_activity_summaries;
CREATE POLICY ta_activity_own ON ta_activity_summaries FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS ta_activity_communities_own ON ta_activity_communities;
CREATE POLICY ta_activity_communities_own ON ta_activity_communities FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM ta_activity_summaries s WHERE s.id = summary_id AND s.user_id = auth.uid()));

REVOKE ALL ON ta_settings, ta_employees, ta_punches, ta_corrections, ta_overtime_requests,
              ta_activity_summaries, ta_activity_communities, v_ta_effective_punches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON ta_settings, ta_employees, ta_punches, ta_corrections, ta_overtime_requests,
                ta_activity_summaries, ta_activity_communities, v_ta_effective_punches TO authenticated, service_role;

REVOKE ALL ON FUNCTION ta_require_employee() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION ta_require_admin_actor(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION ta_punch(text, text, text, boolean, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ta_request_correction(text, uuid, text, timestamptz, text, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ta_withdraw_correction(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ta_request_overtime(date, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ta_submit_activity(date, text[], text, text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ta_punch(text, text, text, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ta_request_correction(text, uuid, text, timestamptz, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ta_withdraw_correction(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ta_request_overtime(date, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ta_submit_activity(date, text[], text, text, text, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION ta_decide_correction(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ta_decide_overtime(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ta_set_employee(uuid, text, boolean, boolean, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ta_update_settings(smallint, integer, text, date, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ta_decide_correction(uuid, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION ta_decide_overtime(uuid, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION ta_set_employee(uuid, text, boolean, boolean, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION ta_update_settings(smallint, integer, text, date, text, uuid, text) TO service_role;

COMMIT;
