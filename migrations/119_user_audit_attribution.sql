-- ============================================================================
-- 119_user_audit_attribution.sql
-- ----------------------------------------------------------------------------
-- Per-user audit attribution across the high-stakes action tables. Until now,
-- staff actions were stamped with free-text name fields from the request body
-- (`action_by_name`, `decided_by`, etc.) — which means anyone with the staff
-- gate could write any name. That's a real audit-integrity issue once we have
-- a real team.
--
-- This migration adds `acted_by_user_id UUID REFERENCES user_profiles(id)` to
-- every action table. The endpoint code that writes to these tables (next
-- step) captures the actor from the Supabase JWT — not from the request body.
-- Free-text name fields stay as display fallback for legacy rows + for
-- letters that need a display name in the salutation, but the canonical
-- "who did this" is now the FK.
--
-- Tables touched:
--   - application_responses           — ACC approval/denial responses
--   - acc_decisions                   — older ACC flow decisions
--   - violations                      — already has opened_by_user_id; index it
--   - property_observations           — already has reviewer_user_id; index it
--   - interactions                    — letter approval + mail batch locks
--   - violation_corrections           — staff corrections to violations
--   - builder_application_responses   — builder ARC approval/denial
--   - owner_ar_snapshots              — AR batch approvals
--   - ar_ingest_batches               — AR batch ingest/discard
--   - email_intake                    — email-sourced fact promotion
--
-- ON DELETE SET NULL on the FK — if a user gets deleted (rare; we prefer
-- is_active=false), the historical action stays in place with NULL actor.
--
-- Apply AFTER 118. Idempotent (every column add uses IF NOT EXISTS, every
-- index/constraint uses IF NOT EXISTS).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- application_responses (ACC manager actions on resident-portal submissions)
-- ----------------------------------------------------------------------------
ALTER TABLE application_responses
  ADD COLUMN IF NOT EXISTS acted_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_application_responses_acted_by
  ON application_responses(acted_by_user_id);

COMMENT ON COLUMN application_responses.acted_by_user_id IS
  'The Bedrock user who took this action, captured from the Supabase JWT at request time. action_by_name is now a display fallback only (e.g., for legacy rows or letter signatures).';

-- ----------------------------------------------------------------------------
-- acc_decisions (older ACC flow — server.js /acc-review/letter)
-- ----------------------------------------------------------------------------
ALTER TABLE acc_decisions
  ADD COLUMN IF NOT EXISTS decided_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_acc_decisions_decided_by
  ON acc_decisions(decided_by_user_id);

COMMENT ON COLUMN acc_decisions.decided_by_user_id IS
  'Bedrock user who finalized this decision (captured from JWT at /acc-review/letter time).';

-- ----------------------------------------------------------------------------
-- violations (already has opened_by_user_id but no index)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_violations_opened_by
  ON violations(opened_by_user_id);

-- ----------------------------------------------------------------------------
-- property_observations (already has reviewer_user_id but no index)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_property_observations_reviewer
  ON property_observations(reviewer_user_id);

-- ----------------------------------------------------------------------------
-- interactions (letter approval + mail-batch lock)
-- ----------------------------------------------------------------------------
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked_by_user_id   UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_approved_by
  ON interactions(approved_by_user_id);
CREATE INDEX IF NOT EXISTS idx_interactions_locked_by
  ON interactions(locked_by_user_id);

COMMENT ON COLUMN interactions.approved_by_user_id IS
  'User who approved this letter draft for mailing.';
COMMENT ON COLUMN interactions.locked_by_user_id IS
  'User who locked this letter into a mail batch (postal pickup).';

-- ----------------------------------------------------------------------------
-- violation_corrections (staff corrections to violation records)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'violation_corrections') THEN
    EXECUTE 'ALTER TABLE violation_corrections ADD COLUMN IF NOT EXISTS corrected_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_violation_corrections_corrected_by ON violation_corrections(corrected_by_user_id)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- builder_application_responses (builder ARC approval/denial)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'builder_application_responses') THEN
    EXECUTE 'ALTER TABLE builder_application_responses ADD COLUMN IF NOT EXISTS decided_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_builder_app_responses_decided_by ON builder_application_responses(decided_by_user_id)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- owner_ar_snapshots (AR batch approval — owner balance snapshots)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'owner_ar_snapshots') THEN
    EXECUTE 'ALTER TABLE owner_ar_snapshots ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_owner_ar_snapshots_approved_by ON owner_ar_snapshots(approved_by_user_id)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- ar_ingest_batches (AR batch ingest/discard actions)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ar_ingest_batches') THEN
    EXECUTE 'ALTER TABLE ar_ingest_batches ADD COLUMN IF NOT EXISTS acted_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_ar_ingest_batches_acted_by ON ar_ingest_batches(acted_by_user_id)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- email_intake (when a staff member promotes a fact/decision)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'email_intake') THEN
    EXECUTE 'ALTER TABLE email_intake ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_email_intake_approved_by ON email_intake(approved_by_user_id)';
  END IF;
END $$;

COMMIT;
