-- ============================================================================
-- 219_violation_continuations.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-13: when re-inspecting a community we cannot send a second letter
-- for a violation that already has an open case. The §209 cure period was
-- given; sending another courtesy notice signals the certified letter was a
-- bluff. Texas case law also expects continuous evidence-of-continuity if
-- escalating to fines/attorney after the cure period elapsed.
--
-- This migration adds:
--   1. violation_continuations join table — every time a re-observation at
--      a property+category that already has an OPEN violation gets recorded,
--      the new observation links here instead of creating a duplicate
--      violation + drafting a duplicate letter.
--   2. ALTER violations + continuation_count + last_continued_at — cheap
--      denormalized counters so the board packet query doesn't need to
--      aggregate every time.
--   3. v_continued_non_compliance VIEW — board-packet surface listing every
--      open violation that has been re-observed at least once, with §209
--      timing and continuation evidence count. This is the artifact the
--      board uses to authorize attorney referral.
--
-- Record-ownership note (per CLAUDE.md):
--   violation_continuations is `association_record` — it documents the
--   association's enforcement evidence trail. Must export on termination.
--
-- Apply AFTER 218. Idempotent.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. violation_continuations — append-only audit table.
-- Each row: "on this date this observation/photo re-confirmed that this
-- previously-cited violation is still present at this property."
-- ============================================================================
CREATE TABLE IF NOT EXISTS violation_continuations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id          UUID NOT NULL REFERENCES violations(id) ON DELETE RESTRICT,
  observation_id        UUID NULL REFERENCES property_observations(id) ON DELETE SET NULL,
  inspection_photo_id   UUID NULL REFERENCES inspection_photos(id) ON DELETE SET NULL,
  inspection_id         UUID NULL REFERENCES inspections(id) ON DELETE SET NULL,
  noted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  noted_by_user_id      UUID NULL,
  source                TEXT NOT NULL DEFAULT 'inspection'
                          CHECK (source IN ('inspection','manual','vantaca_import','homeowner_report','board_report')),
  notes                 TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_violation_continuations_violation
  ON violation_continuations (violation_id, noted_at DESC);
CREATE INDEX IF NOT EXISTS idx_violation_continuations_observation
  ON violation_continuations (observation_id)
  WHERE observation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_violation_continuations_inspection
  ON violation_continuations (inspection_id, noted_at DESC)
  WHERE inspection_id IS NOT NULL;

-- One observation can only continue one violation. Enforces 1:1 linkage from
-- the new observation back to the existing case file.
CREATE UNIQUE INDEX IF NOT EXISTS uq_violation_continuations_observation
  ON violation_continuations (observation_id)
  WHERE observation_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON violation_continuations TO service_role;
GRANT SELECT                          ON violation_continuations TO authenticated;


-- ============================================================================
-- 2. Denormalized continuation counters on violations.
-- These get bumped by the linker in the same transaction the continuation
-- row is inserted, so the board packet query stays O(violations) not
-- O(violations * continuations).
-- ============================================================================
ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS continuation_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_continued_at   TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_violations_continued
  ON violations (community_id, continuation_count DESC, last_continued_at DESC)
  WHERE continuation_count > 0
    AND current_stage NOT IN ('cured','closed','voided');


-- ============================================================================
-- 3. v_continued_non_compliance — board-packet view.
-- Lists every OPEN violation that has been re-observed at least once, with:
--   - days since opened (when the lifecycle started)
--   - days since §209 mailed (if the certified notice has gone out)
--   - continuation_count (how many re-observations)
--   - last_continued_at (when most recently re-confirmed)
--
-- The board uses this to authorize the next stage (fines / attorney referral)
-- for properties that have ignored §209 and continue to violate.
--
-- §209 timing is derived from interactions: the most recent letter_209
-- interaction tied to this violation. If null, the violation has not yet
-- escalated to certified — likely just a courtesy_1 / courtesy_2 case.
-- ============================================================================
DROP VIEW IF EXISTS v_continued_non_compliance CASCADE;

CREATE VIEW v_continued_non_compliance AS
SELECT
  v.id                                                    AS violation_id,
  v.community_id,
  c.name                                                  AS community_name,
  v.property_id,
  p.street_address,
  p.unit,
  p.owner_name,
  v.primary_category_id,
  ec.label                                                AS category_label,
  v.current_stage,
  v.opened_at,
  v.cure_period_ends_at,
  v.continuation_count,
  v.last_continued_at,
  -- Days since lifecycle started
  EXTRACT(DAY FROM (NOW() - v.opened_at))::INTEGER        AS days_open,
  -- Most recent certified §209 mailing for this violation (sent_at preferred —
  -- that's the actual mail date; created_at is just draft creation).
  (
    SELECT MAX(COALESCE(i.sent_at, i.created_at))
    FROM interactions i
    WHERE i.violation_id = v.id
      AND i.type = 'letter_209'
      AND i.status = 'sent'
  )                                                       AS certified_209_mailed_at,
  -- Days since §209 mailed
  CASE
    WHEN (
      SELECT MAX(COALESCE(i.sent_at, i.created_at))
      FROM interactions i
      WHERE i.violation_id = v.id
        AND i.type = 'letter_209'
        AND i.status = 'sent'
    ) IS NOT NULL
    THEN EXTRACT(DAY FROM (NOW() - (
      SELECT MAX(COALESCE(i.sent_at, i.created_at))
      FROM interactions i
      WHERE i.violation_id = v.id
        AND i.type = 'letter_209'
        AND i.status = 'sent'
    )))::INTEGER
    ELSE NULL
  END                                                     AS days_since_209,
  -- Recommended action surfaced on the board packet row
  CASE
    WHEN v.current_stage = 'certified_209'
      AND v.continuation_count >= 1
      AND (NOW() - v.cure_period_ends_at) > INTERVAL '14 days'
      THEN 'authorize_fine_or_attorney'
    WHEN v.current_stage = 'certified_209'
      AND v.continuation_count >= 1
      THEN 'await_cure_period_completion'
    WHEN v.current_stage IN ('courtesy_1','courtesy_2')
      AND v.continuation_count >= 1
      THEN 'advance_to_certified_209'
    ELSE 'monitor'
  END                                                     AS recommended_action
FROM violations v
JOIN communities c             ON c.id = v.community_id
JOIN properties  p             ON p.id = v.property_id
JOIN enforcement_categories ec ON ec.id = v.primary_category_id
WHERE v.continuation_count > 0
  AND v.current_stage NOT IN ('cured','closed','voided');

GRANT SELECT ON v_continued_non_compliance TO anon, authenticated, service_role;

COMMIT;
