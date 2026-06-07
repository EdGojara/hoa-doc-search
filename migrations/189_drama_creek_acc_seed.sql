-- ============================================================================
-- 189_drama_creek_acc_seed.sql
-- ----------------------------------------------------------------------------
-- Drama Creek demo — ACC pipeline seed.
--
-- arc_historical_decisions is the source of truth for both historical
-- (decided) AND in-flight (pending) ARC submissions. decision_type='pending'
-- with decided_at=NULL represents a submission that's still in review.
--
-- Patricia Newpaint's archetype is "ACC submission in review" — this
-- migration captures her pending repaint request so the Open Requests
-- tile and Claire's pre-call warmup both show it.
--
-- Also adds 2 historical decisions for Drama Creek so the AI assessment
-- engine's precedent retrieval has examples to surface:
--   - An approved fence repaint (sets a precedent for color flexibility)
--   - A denied addition (sets a precedent for setback enforcement)
--
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Patricia Newpaint — PENDING repaint submission, in committee review.
-- Property dc110035 (210 Peaceful Pond Drive).
-- Matches the Patricia sample call from migration 187 where the brief said
-- "Repaint application submitted 2026-06-01; sage green w/ white trim".
-- ----------------------------------------------------------------------------
INSERT INTO arc_historical_decisions (
  id, management_company_id, community_id, property_id,
  property_address, homeowner_name,
  project_type, project_description,
  decision_type, decided_at,
  conditions, reasoning, summary,
  extracted_by_model, extraction_confidence,
  notes
) VALUES
  ('dc180001-0000-4000-a000-000000000000',
   '00000000-0000-0000-0000-000000000001',
   'dc100000-0000-4000-a000-000000000000',
   'dc110035-0000-4000-a000-000000000000',
   '210 Peaceful Pond Drive',
   'Patricia Newpaint',
   'paint',
   'Exterior body repaint — sage green (Sherwin Williams SW6178 Clary Sage) with white (SW7008 Alabaster) trim. Existing color: builder beige. Submission includes paint chips and a photo of the existing house. No structural changes.',
   'pending',  -- in review; decided_at NULL
   NULL,
   NULL,
   NULL,
   'ARC submission in review — exterior repaint from beige to sage green with white trim.',
   'manual_seed',
   'high',
   'Demo seed: Patricia Newpaint pending ARC submission for portal Open Requests tile + warmup context.')
ON CONFLICT (id) DO UPDATE
  SET decision_type = EXCLUDED.decision_type,
      decided_at = EXCLUDED.decided_at,
      summary = EXCLUDED.summary,
      project_description = EXCLUDED.project_description,
      updated_at = NOW();

-- ----------------------------------------------------------------------------
-- Two historical decisions for precedent retrieval. The AI assessment
-- engine pulls these via semantic match when a new ARC application comes
-- in (e.g., another paint request) to ground the recommendation in
-- community precedent.
-- ----------------------------------------------------------------------------
INSERT INTO arc_historical_decisions (
  id, management_company_id, community_id, property_id,
  property_address, homeowner_name,
  project_type, project_description,
  decision_type, decided_at, decided_by,
  conditions, reasoning, summary,
  extracted_by_model, extraction_confidence,
  notes
) VALUES
  -- Approved fence repaint — sets precedent that earth-tone color shifts
  -- are OK
  ('dc180002-0000-4000-a000-000000000000',
   '00000000-0000-0000-0000-000000000001',
   'dc100000-0000-4000-a000-000000000000',
   'dc110005-0000-4000-a000-000000000000',                    -- Sunny Meadows lives here (Tranquility Trail)
   '109 Tranquility Trail',
   'Sunny Meadows',
   'fence',
   'Repaint existing 6-ft cedar privacy fence from natural to warm chestnut stain (Behr Premium Semi-Transparent Stain, Chestnut #ST-141).',
   'approved',
   '2025-09-12',
   'ACC committee',
   NULL,
   'Earth-tone shift consistent with neighborhood character; no structural changes; existing fence in good condition.',
   'Approved — earth-tone color change consistent with community character; no setback or structural concerns.',
   'manual_seed',
   'high',
   'Demo precedent: shows ACC approves reasonable color changes when consistent with community character.'),

  -- Denied side-yard addition — sets precedent that 5-ft side setback is
  -- enforced
  ('dc180003-0000-4000-a000-000000000000',
   '00000000-0000-0000-0000-000000000001',
   'dc100000-0000-4000-a000-000000000000',
   'dc110021-0000-4000-a000-000000000000',                    -- Marcus Behindbills' property (201 Harmony Lane)
   '201 Harmony Lane',
   'Marcus Behindbills',
   'addition',
   'Side-yard 12-ft x 14-ft enclosed sunroom addition extending 4 ft into the south side yard, reducing side setback to 3 ft.',
   'denied',
   '2025-05-20',
   'ACC committee',
   NULL,
   'Proposed addition reduces side setback from required 5 ft to 3 ft. Setback is non-waivable under community covenants.',
   'Denied — proposed addition encroaches 4 ft into 5-ft side setback; setback is non-waivable.',
   'manual_seed',
   'high',
   'Demo precedent: shows ACC enforces side setbacks consistently.')
ON CONFLICT (id) DO UPDATE
  SET decision_type = EXCLUDED.decision_type,
      decided_at = EXCLUDED.decided_at,
      summary = EXCLUDED.summary,
      project_description = EXCLUDED.project_description,
      reasoning = EXCLUDED.reasoning,
      updated_at = NOW();

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--
--   SELECT decision_type, project_type, homeowner_name, decided_at
--   FROM arc_historical_decisions
--   WHERE community_id = 'dc100000-0000-4000-a000-000000000000'
--   ORDER BY COALESCE(decided_at, CURRENT_DATE) DESC;
--   -- Expected: 3 rows
--   --   pending  · paint    · Patricia Newpaint · (null)
--   --   approved · fence    · Sunny Meadows     · 2025-09-12
--   --   denied   · addition · Marcus Behindbills· 2025-05-20
-- ============================================================================
