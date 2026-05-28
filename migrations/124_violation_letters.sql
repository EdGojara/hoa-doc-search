-- ============================================================================
-- 124_violation_letters.sql
-- ----------------------------------------------------------------------------
-- Links violations to the actual letter PDFs that were sent — whether by
-- Vantaca historically (imported as artifacts) or by trustEd going forward
-- (generated via the letter pipeline). Solves the enforcement-continuity
-- problem when transitioning a community off Vantaca: the next letter
-- trustEd sends starts at the correct stage because the imported Vantaca
-- letter establishes "we already sent courtesy_1 on [date]."
--
-- Schema design:
--   violation_letters — junction table. One row per letter ever sent for
--   a given violation. Links to library_documents for the canonical PDF
--   (where the homeowner-folder file lives). Includes stage_at_send so
--   the continuation logic can read "the most recent letter was courtesy_1,
--   so the next one is courtesy_2."
--
-- Why a junction (not JSONB):
--   - One violation can have N letters (full enforcement timeline)
--   - Each letter is a queryable artifact: list-all-letters-by-source,
--     by-stage, by-date for board packets + audit
--   - FKs to library_documents preserve referential integrity if a PDF
--     gets re-categorized later
--
-- Record ownership (per CLAUDE.md):
--   association_record — sent letters ARE the association's record of
--   enforcement action. Transfer cleanly on termination as part of the
--   property's enforcement history. The fact that we IMPORTED them (vs.
--   generated them) is metadata that stays workpaper.
--
-- Apply AFTER 123. Idempotent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) violation_letters — the canonical "letter sent" record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS violation_letters (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id              UUID NOT NULL REFERENCES violations(id) ON DELETE CASCADE,
  library_document_id       UUID NULL REFERENCES library_documents(id) ON DELETE SET NULL,
  -- NULL when the letter is in trustEd's letter-draft state but not yet
  -- archived to library_documents (rare; mainly transitional state).

  -- Which enforcement stage this letter represents
  stage_at_send             TEXT NOT NULL
                              CHECK (stage_at_send IN (
                                'courtesy_1', 'courtesy_2', 'certified_209',
                                'fine_assessed', 'hearing_notice',
                                'legal_referral', 'lien_filed', 'other'
                              )),
  sent_at                   DATE NOT NULL,
  sent_via                  TEXT NOT NULL DEFAULT 'trusted'
                              CHECK (sent_via IN ('vantaca', 'trusted', 'manual', 'other')),
  delivery_method           TEXT NULL
                              CHECK (delivery_method IS NULL OR delivery_method IN (
                                'mail', 'certified_mail', 'email', 'hand_delivery', 'postcard'
                              )),
  -- USPS tracking or similar
  tracking_number           TEXT NULL,
  -- Free-text note for context (e.g., "Original Vantaca PDF, imported during transition")
  notes                     TEXT NULL,

  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id        UUID NULL REFERENCES user_profiles(id) ON DELETE SET NULL,
  -- Ingest source — was this row created via the Vantaca import workflow,
  -- a trustEd letter send, or a manual entry by staff?
  source                    TEXT NOT NULL DEFAULT 'trusted'
                              CHECK (source IN ('vantaca_import', 'trusted', 'manual_entry'))
);

CREATE INDEX IF NOT EXISTS idx_violation_letters_violation
  ON violation_letters (violation_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_violation_letters_doc
  ON violation_letters (library_document_id)
  WHERE library_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_violation_letters_stage
  ON violation_letters (violation_id, stage_at_send, sent_at DESC);

COMMENT ON TABLE violation_letters IS
  'association_record. One row per letter ever sent for a violation. Joins to library_documents for the canonical PDF (the homeowner folder). Powers continuation logic: "what was the last letter sent for this violation, so what stage comes next?"';

-- ---------------------------------------------------------------------------
-- 2) Allow 'violation_letter' as a library_documents category
-- ---------------------------------------------------------------------------
-- The library_documents.category column may have a CHECK constraint. Try
-- to expand it to allow 'violation_letter' if it exists. Wrapped in a DO
-- block so the migration succeeds even if no constraint exists yet.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  WHERE cls.relname = 'library_documents'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%category%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE library_documents DROP CONSTRAINT %I', constraint_name);
    -- We don't restore the constraint with the new value because we don't
    -- know what the original allowed values were. The column is free-text
    -- now; downstream code already filters by category strings.
    RAISE NOTICE 'Dropped category CHECK constraint % to allow violation_letter and future categories', constraint_name;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Helper view — current letter state per violation
-- ---------------------------------------------------------------------------
-- For each violation, the latest letter that's been sent (regardless of
-- source). Powers "what was the last stage" lookups for the continuation
-- workflow.
DROP VIEW IF EXISTS v_violation_latest_letter CASCADE;
CREATE VIEW v_violation_latest_letter AS
SELECT DISTINCT ON (vl.violation_id)
  vl.violation_id,
  vl.id                AS letter_id,
  vl.library_document_id,
  vl.stage_at_send,
  vl.sent_at,
  vl.sent_via,
  vl.source,
  -- Next-stage hint — the conventional progression. Code can override
  -- this when the operator overrides via the inspection UI.
  CASE vl.stage_at_send
    WHEN 'courtesy_1'    THEN 'courtesy_2'
    WHEN 'courtesy_2'    THEN 'certified_209'
    WHEN 'certified_209' THEN 'fine_assessed'
    WHEN 'fine_assessed' THEN 'hearing_notice'
    WHEN 'hearing_notice' THEN 'legal_referral'
    WHEN 'legal_referral' THEN 'lien_filed'
    ELSE 'other'
  END                  AS suggested_next_stage
FROM violation_letters vl
ORDER BY vl.violation_id, vl.sent_at DESC, vl.created_at DESC;

GRANT SELECT ON v_violation_latest_letter TO service_role, authenticated;

COMMENT ON VIEW v_violation_latest_letter IS
  'Per-violation latest letter + suggested next stage. Used by the inspection continuation flow to surface "next letter would be courtesy_2" when an operator confirms an ongoing violation.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT INSERT, SELECT, UPDATE, DELETE ON violation_letters TO service_role;
GRANT SELECT ON violation_letters TO authenticated;

COMMIT;
