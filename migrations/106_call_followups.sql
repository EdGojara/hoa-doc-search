-- ============================================================================
-- 106_call_followups.sql
-- ----------------------------------------------------------------------------
-- Adds follow-up state to homeowner_calls. Powers the Calls Dashboard
-- (new tab in trustEd) where Bedrock staff sees open follow-ups, response
-- deadlines, and tracks resolution.
--
-- Without this, every Claire-handled call that needs follow-up only flows
-- to email — fine at low volume but doesn't scale. With this, calls become
-- a structured queue with deadlines and visible state.
--
-- Schema additions to homeowner_calls:
--   follow_up_status      TEXT NULL — 'open' / 'in_progress' / 'done' /
--                          'dismissed'. NULL means no follow-up needed
--                          (call resolved itself, dropped, etc.)
--   respond_by_at         TIMESTAMPTZ — calculated deadline based on the
--                          brief's category + urgency flags
--   resolved_at           TIMESTAMPTZ — when a staff member marked it done
--                          or dismissed
--   internal_notes        TEXT — staff notes added while working the follow-up
--
-- Backfill logic for existing rows:
--   Rows where brief.escalate=true OR compliance_flag=true → status='open',
--     respond_by_at = started_at + 4 hours
--   Rows with a brief and a non-trivial next_step → status='open',
--     respond_by_at = started_at + 3 business days (approximated as +3 days)
--   Rows with no brief or self-resolved → status NULL (no follow-up)
--
-- Forward-going: lib/voice/call_log.js processCallEnd() should ALSO set
-- these columns when it persists the brief — see follow-up commit.
--
-- Record-ownership bucket: mixed. The call transcript + brief are
-- association_record (correspondence on behalf of the association).
-- Internal_notes are workpaper (Bedrock's own operational notes about
-- handling). Export tool should split per CLAUDE.md three-bucket rules.
--
-- Apply after migration 105. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Add the columns
-- ----------------------------------------------------------------------------
ALTER TABLE homeowner_calls
  ADD COLUMN IF NOT EXISTS follow_up_status  TEXT,
  ADD COLUMN IF NOT EXISTS respond_by_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS internal_notes    TEXT;

-- CHECK constraint on follow_up_status. NULL allowed (call doesn't need follow-up).
ALTER TABLE homeowner_calls
  DROP CONSTRAINT IF EXISTS homeowner_calls_follow_up_status_check;
ALTER TABLE homeowner_calls
  ADD CONSTRAINT homeowner_calls_follow_up_status_check
  CHECK (follow_up_status IS NULL OR follow_up_status IN ('open','in_progress','done','dismissed'));

-- ----------------------------------------------------------------------------
-- 2. Indexes for the dashboard hot path
-- ----------------------------------------------------------------------------
-- Open / in-progress follow-ups sorted by respond-by deadline (the
-- "what should I work next?" query).
CREATE INDEX IF NOT EXISTS idx_calls_followups_open
  ON homeowner_calls(respond_by_at)
  WHERE follow_up_status IN ('open','in_progress');

-- Per-community filtered queries
CREATE INDEX IF NOT EXISTS idx_calls_followups_community
  ON homeowner_calls(community_id, follow_up_status, respond_by_at)
  WHERE follow_up_status IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Backfill — based on brief.escalate / compliance_flag / brief.next_step
-- ----------------------------------------------------------------------------
-- High-urgency (compliance flag OR brief says escalate): 4 hours
UPDATE homeowner_calls
   SET follow_up_status = 'open',
       respond_by_at = started_at + INTERVAL '4 hours'
 WHERE follow_up_status IS NULL
   AND status = 'completed'
   AND (
     compliance_flag = TRUE
     OR (brief IS NOT NULL AND brief->>'escalate' = 'true')
   );

-- Enforcement / legal category: 24 hours
UPDATE homeowner_calls
   SET follow_up_status = 'open',
       respond_by_at = started_at + INTERVAL '24 hours'
 WHERE follow_up_status IS NULL
   AND status = 'completed'
   AND brief IS NOT NULL
   AND brief->>'category' IN ('enforcement','legal','collections');

-- Accounting / financial category: 1 business day (approximated as 24 hours)
UPDATE homeowner_calls
   SET follow_up_status = 'open',
       respond_by_at = started_at + INTERVAL '24 hours'
 WHERE follow_up_status IS NULL
   AND status = 'completed'
   AND brief IS NOT NULL
   AND brief->>'category' IN ('accounting','financial','ar','payment');

-- Everything else with a non-trivial next_step: 3 business days (approx +3 days)
UPDATE homeowner_calls
   SET follow_up_status = 'open',
       respond_by_at = started_at + INTERVAL '3 days'
 WHERE follow_up_status IS NULL
   AND status = 'completed'
   AND brief IS NOT NULL
   AND brief->>'next_step' IS NOT NULL
   AND length(brief->>'next_step') > 5;  -- skip trivial "n/a" type values

-- ----------------------------------------------------------------------------
-- 4. Grants (re-issue for the table — additive ALTER doesn't reset grants
--    but be safe per CLAUDE.md DROP-VIEW-loses-grants discipline)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON homeowner_calls TO authenticated, service_role;

COMMIT;

-- Verification: see what backfilled
--   SELECT follow_up_status, COUNT(*)
--   FROM homeowner_calls
--   GROUP BY follow_up_status
--   ORDER BY follow_up_status NULLS LAST;
--
--   SELECT id, started_at, respond_by_at, follow_up_status,
--          brief->>'category' AS category, compliance_flag
--   FROM homeowner_calls
--   WHERE follow_up_status IN ('open','in_progress')
--   ORDER BY respond_by_at ASC
--   LIMIT 20;
