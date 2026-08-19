-- ============================================================================
-- 370_staff_document_reviews.sql  (Ed 2026-08-19)
-- ----------------------------------------------------------------------------
-- Amanda's memory of reviewing a staff member's work.
--
-- WHY THIS EXISTS. Without it every review starts from zero, which is exactly
-- how a TOOL behaves: you upload, it grades, it forgets. A manager says "this
-- is the second month the motion had no seconder", and that sentence is the
-- whole difference. Ed 2026-08-19: he wants Amanda to act like a manager and
-- correspond with staff, not be a box people remember to use.
--
-- Findings are stored as RULE IDS from lib/minutes/standards.js, not prose, so
-- "you fixed the GL codes, the seconder is still missing" is COMPUTED rather
-- than vibes. Prose alone would let the model invent a history that never
-- happened, which is the same class of error as the invented praise this
-- feature shipped with on its first draft.
--
-- RECORD OWNERSHIP: workpaper. This is Bedrock's internal supervision of its
-- own staff. It is NOT an association record and does not transfer on
-- termination. See the record-ownership table in CLAUDE.md.
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS staff_document_reviews (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- who reviewed, and who was reviewed
  reviewer_persona      TEXT NOT NULL DEFAULT 'amanda',
  staff_email           TEXT NOT NULL,               -- lowercased, the memory key
  staff_name            TEXT,

  -- what was reviewed
  document_type         TEXT NOT NULL
                          CHECK (document_type IN ('minutes','nominations','agenda','notice','general')),
  document_filename     TEXT,
  community_id          UUID REFERENCES communities(id) ON DELETE SET NULL,

  -- WHAT WAS FOUND, structured. Array of { rule_id, severity, note }.
  -- rule_id matches lib/minutes/standards.js so the next review can diff
  -- against it instead of re-reading old prose.
  findings              JSONB NOT NULL DEFAULT '[]'::jsonb,
  finding_ids           TEXT[] NOT NULL DEFAULT '{}', -- flattened, for cheap overlap queries

  -- the reply she actually sent, kept so a human can audit what staff was told
  reply_subject         TEXT,
  reply_body            TEXT,

  -- provenance
  source_email_id       UUID REFERENCES email_messages(id) ON DELETE SET NULL,
  sent_at               TIMESTAMPTZ,                  -- null while still a draft

  record_ownership      TEXT NOT NULL DEFAULT 'workpaper'
                          CHECK (record_ownership IN ('workpaper','association_record','mixed')),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot path: "the last few reviews for this person and this kind of document".
CREATE INDEX IF NOT EXISTS idx_sdr_staff_type
  ON staff_document_reviews (staff_email, document_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sdr_finding_ids
  ON staff_document_reviews USING GIN (finding_ids);

CREATE INDEX IF NOT EXISTS idx_sdr_community
  ON staff_document_reviews (community_id, created_at DESC) WHERE community_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_sdr_updated_at ON staff_document_reviews;
CREATE TRIGGER trg_sdr_updated_at
  BEFORE UPDATE ON staff_document_reviews
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Explicit grants. Default privileges do not propagate reliably across
-- migrations in this Supabase setup, and a new table the API writes to without
-- them fails every INSERT with "permission denied" deep inside a side-effect
-- chain, where the caller still reports success. Hit three times in one evening
-- on 2026-06-08 (migrations 168/195 -> 196/200).
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_document_reviews TO service_role;
GRANT SELECT                          ON staff_document_reviews TO authenticated;

COMMIT;
