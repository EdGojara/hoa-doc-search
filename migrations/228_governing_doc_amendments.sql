-- ============================================================================
-- 228_governing_doc_amendments.sql
-- ----------------------------------------------------------------------------
-- Amendment management for governing documents (Declarations, Bylaws, Rules).
--
-- Problem this solves (Ed 2026-06-17 evening, surfaced when Mike Watson's
-- Section 3.3 question hit Waterview):
--   Bedrock's library has the original Declaration AND amendments to it
--   sitting side by side, with no link between them. Retrieval pulls
--   whichever ranks higher. The AI has no way to know which is current.
--   Worst case: staff sends a homeowner the original 2004 language for a
--   section that was amended in 2019. That's an enforcement letter that
--   gets the board sued.
--
-- Architecture (three layers, this migration is layer 1):
--   1. Schema (this migration) — add supersession links.
--   2. Ingestion workflow — when an amendment is uploaded, AI proposes
--      which existing doc + sections it amends, operator confirms,
--      supersession links get written.
--   3. Retrieval awareness — chunks from a superseded section get
--      hard-deprioritized in hybrid retrieval; AI synthesis layer
--      flags amendments in the context block.
--
-- Schema layer adds three things to library_documents:
--   - supersedes_library_document_id  UUID FK (this doc amends that one)
--   - amended_sections                JSONB (which sections of the parent)
--   - supersession_recorded_at        TIMESTAMPTZ (when operator confirmed)
--
-- Plus an audit log of every supersession edit, so we can answer "who
-- linked this amendment to the original, and when?"
--
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- library_documents supersession columns
-- ----------------------------------------------------------------------------
ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS supersedes_library_document_id UUID
    REFERENCES library_documents(id) ON DELETE SET NULL;

ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS amended_sections JSONB;

ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS supersession_recorded_at TIMESTAMPTZ;

ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS supersession_recorded_by TEXT;

COMMENT ON COLUMN library_documents.supersedes_library_document_id IS
  'When this doc is an amendment, points to the doc it amends (the original Declaration / Bylaws / etc). NULL = not an amendment, or amendment not yet linked.';
COMMENT ON COLUMN library_documents.amended_sections IS
  'JSONB array of section identifiers this amendment touches. Example: ["3.3", "5.1(a)"]. Empty array or NULL = whole-document supersession (the entire parent is replaced).';
COMMENT ON COLUMN library_documents.supersession_recorded_at IS
  'Timestamp when operator confirmed the supersession link. NULL = AI-suggested but not yet confirmed.';

-- Index on the FK so "find amendments to doc X" is fast
CREATE INDEX IF NOT EXISTS idx_library_documents_supersedes
  ON library_documents(supersedes_library_document_id)
  WHERE supersedes_library_document_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- library_document_amendment_log — audit trail
-- ----------------------------------------------------------------------------
-- Every supersession link (or unlink) is logged. Lets us answer:
--   - When was this amendment linked to the original?
--   - Did anyone change which sections it amends?
--   - Who confirmed the link?
-- Catastrophic-output discipline: if we ever send a homeowner stale text
-- because a supersession link was wrong, this log tells the postmortem
-- exactly what changed and when.
CREATE TABLE IF NOT EXISTS library_document_amendment_log (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amendment_library_document_id   UUID NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE,
  superseded_library_document_id  UUID REFERENCES library_documents(id) ON DELETE SET NULL,
  amended_sections                JSONB,
  action                          TEXT NOT NULL CHECK (action IN ('linked', 'unlinked', 'sections_edited', 'ai_suggested', 'operator_confirmed')),
  source                          TEXT NOT NULL CHECK (source IN ('ai', 'operator', 'migration')),
  actor                           TEXT,
  ai_confidence                   NUMERIC(3,2),
  ai_reasoning                    TEXT,
  recorded_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_amendment_log_amendment
  ON library_document_amendment_log(amendment_library_document_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_amendment_log_parent
  ON library_document_amendment_log(superseded_library_document_id, recorded_at DESC)
  WHERE superseded_library_document_id IS NOT NULL;

COMMENT ON TABLE library_document_amendment_log IS
  'Audit trail for governing-doc amendment supersession links. Every link/unlink/edit gets a row. Required reading on postmortem if a homeowner ever receives stale language because a supersession link was wrong.';

-- ----------------------------------------------------------------------------
-- v_library_documents_with_amendment_status view
-- ----------------------------------------------------------------------------
-- Convenience view for the retrieval layer and the admin UI. For each library
-- doc, surface:
--   - is_amendment      — does this doc supersede another?
--   - amendments_count  — how many amendments exist that supersede THIS doc?
--   - latest_amendment_id — most recent amendment to this doc, if any
--
-- Retrieval will check is_superseded_by_amendment to decide whether to
-- deprioritize a chunk; the admin UI will surface amendments_count and
-- latest_amendment_id so the operator can see "Section 3.3 was amended in
-- the doc you're looking at" at a glance.
DROP VIEW IF EXISTS v_library_documents_with_amendment_status CASCADE;
CREATE VIEW v_library_documents_with_amendment_status AS
SELECT
  d.*,
  CASE WHEN d.supersedes_library_document_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_amendment,
  COALESCE((
    SELECT COUNT(*)::int
    FROM library_documents amend
    WHERE amend.supersedes_library_document_id = d.id
  ), 0) AS amendments_count,
  (
    SELECT amend.id
    FROM library_documents amend
    WHERE amend.supersedes_library_document_id = d.id
    ORDER BY amend.supersession_recorded_at DESC NULLS LAST
    LIMIT 1
  ) AS latest_amendment_id
FROM library_documents d;

COMMENT ON VIEW v_library_documents_with_amendment_status IS
  'Library docs enriched with amendment relationships: whether this doc IS an amendment, how many amendments point at it, and the most recent one.';

-- Re-issue GRANTs since DROP VIEW removed them (CLAUDE.md scar).
GRANT SELECT ON v_library_documents_with_amendment_status TO anon, authenticated, service_role;

-- Service-role writes on the audit log + library_documents amendments path.
GRANT SELECT, INSERT, UPDATE, DELETE ON library_document_amendment_log TO service_role;
GRANT SELECT ON library_document_amendment_log TO authenticated;

COMMIT;
