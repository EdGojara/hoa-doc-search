-- ============================================================================
-- 491_onboarding_batches_complete_result.sql  (Issue #15, Ed 2026-10-05)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Read model only. The Batches table showed a finished batch as
-- "stage complete / current result not run" (Quail Ridge). onboarding_batches
-- (482) took the current result from the latest stage_completed event for the
-- batch's CURRENT stage, and 'complete' never has one: the owner advances into
-- it, nothing runs in it. So every finished batch read "not run".
--
-- The 481/485 gates only let a batch into 'complete' from post_proof, by a human
-- advance on a post-proof result that passed (or was fully waived). So for a
-- batch at 'complete' the meaningful result is its most recent post_proof
-- completion, and this function now reports that, with result_stage saying
-- which stage the result belongs to. Every other stage reads exactly as before.
-- Active batches sort above completed ones; within each group newest first.
--
-- What it changes (nothing else):
--   - CREATE OR REPLACE FUNCTION onboarding_batches(uuid): same signature, same
--     fields plus result_stage; grants unchanged (CREATE OR REPLACE keeps them).
-- No table, row, event, trigger or state-machine rule is touched. Requires 482.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION onboarding_batches(p_community UUID DEFAULT NULL) RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'batch_code', b.batch_code, 'community_id', b.community_id, 'as_of_date', b.as_of_date,
                                               'source_system', b.source_system, 'stage', b.onboarding_stage, 'write_locked', b.write_locked,
                                               'current_status', (SELECT e.result->>'status' FROM onboarding_stage_events e WHERE e.batch_id = b.id AND e.event_type = 'stage_completed'
                                                                   AND e.stage = r.result_stage ORDER BY e.seq DESC LIMIT 1),
                                               'result_stage', r.result_stage,
                                               'created_at', b.created_at)
                            ORDER BY (b.onboarding_stage = 'complete'), b.created_at DESC), '[]'::jsonb)
    FROM conversion_batches b
    CROSS JOIN LATERAL (SELECT CASE WHEN b.onboarding_stage = 'complete' THEN 'post_proof' ELSE b.onboarding_stage END AS result_stage) r
   WHERE b.onboarding_stage IS NOT NULL AND (p_community IS NULL OR b.community_id = p_community);
$fn$;

COMMIT;
