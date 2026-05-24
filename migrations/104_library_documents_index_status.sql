-- ============================================================================
-- 104_library_documents_index_status.sql
-- ----------------------------------------------------------------------------
-- Add explicit indexing-pipeline state columns to library_documents so the
-- reindex queue picker no longer has to scan documents.metadata->>'library_
-- document_id' to figure out what's pending. Single source of truth + much
-- faster queue queries + poison-pill protection via attempt-count gating.
--
-- Background: prior architecture called indexLibraryDoc() synchronously from
-- the upload handler. For form-field PDFs / scanned PDFs that need the Claude
-- vision pipeline (lib/ocr_pdf.js, ~30-90s per doc), the upload's HTTP request
-- routinely got guillotined by Render's 100s gateway timeout — chunks never
-- inserted, library row landed with no asked_indexed signal, and the doc fell
-- into "queue limbo" with no visible state. 120-deep backlog observed
-- 2026-05-24 morning, all of it Claude-vision-needed docs.
--
-- New columns on library_documents:
--   index_status            text  NULL   — pending | indexed | failed | failed_permanent
--                                          NULL means indexing N/A (missing
--                                          status, no file_path, deleted, etc.)
--   index_attempt_count     int   default 0
--   last_index_attempt_at   timestamptz NULL
--   last_index_error        text  NULL   — last failure reason for visibility
--
-- Backfill (idempotent):
--   1. Mark all "indexable" rows pending (mgmt_co=Bedrock, status!='missing',
--      file_path IS NOT NULL).
--   2. Promote to 'indexed' for rows that already have chunks in the `documents`
--      table — these are the docs that successfully indexed under the old
--      sync pipeline. Stamp last_index_attempt_at = uploaded_at as a best-effort
--      timestamp (we don't know the actual prior index time).
--
-- Record-ownership bucket: these columns are `workpaper` (Bedrock's internal
-- pipeline state, never delivered to a board). They live on a `mixed` table
-- (library_documents); export tool should strip these columns from any
-- termination handover bundle along with the existing extraction_* internals.
--
-- Apply after migration 103. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Add the columns (idempotent via IF NOT EXISTS)
-- ----------------------------------------------------------------------------
ALTER TABLE library_documents
  ADD COLUMN IF NOT EXISTS index_status          TEXT,
  ADD COLUMN IF NOT EXISTS index_attempt_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_index_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_index_error      TEXT;

-- CHECK constraint — added separately so we can DROP+ADD if values evolve
-- without rewriting the column. NULL is allowed (indexing N/A).
ALTER TABLE library_documents
  DROP CONSTRAINT IF EXISTS library_documents_index_status_check;
ALTER TABLE library_documents
  ADD CONSTRAINT library_documents_index_status_check
  CHECK (index_status IS NULL OR index_status IN ('pending','indexed','failed','failed_permanent'));

-- ----------------------------------------------------------------------------
-- 2. Partial index on the queue hot path
-- ----------------------------------------------------------------------------
-- Queue picker: WHERE index_status IN ('pending','failed') ORDER BY uploaded_at.
-- Partial index keeps the index small (only rows actually in queue) and lets
-- the ORDER BY use the index directly.
CREATE INDEX IF NOT EXISTS idx_library_docs_index_queue
  ON library_documents(uploaded_at)
  WHERE index_status IN ('pending','failed');

-- ----------------------------------------------------------------------------
-- 3. Backfill — only run on rows where index_status IS NULL (so re-runs are
--    safe and don't clobber state the running app has already written).
-- ----------------------------------------------------------------------------

-- 3a. Mark indexable rows pending.
UPDATE library_documents
   SET index_status = 'pending'
 WHERE index_status IS NULL
   AND status <> 'missing'
   AND file_path IS NOT NULL;

-- 3b. Promote to 'indexed' the rows that already have chunks in `documents`.
--     The reindex pipeline stores library_document_id in chunk metadata, so a
--     DISTINCT scan of documents.metadata gives us the set of indexed library
--     doc ids.
UPDATE library_documents l
   SET index_status = 'indexed',
       last_index_attempt_at = COALESCE(l.last_index_attempt_at, l.uploaded_at)
  FROM (
    SELECT DISTINCT (metadata->>'library_document_id')::uuid AS lib_id
      FROM documents
     WHERE metadata ? 'library_document_id'
       AND metadata->>'library_document_id' ~ '^[0-9a-f-]{36}$'
  ) AS indexed
 WHERE l.id = indexed.lib_id
   AND l.index_status = 'pending';

COMMIT;

-- Verification: queue depth + indexed count after backfill.
--   SELECT index_status, COUNT(*) FROM library_documents GROUP BY index_status;
--
-- Expected after backfill:
--   indexed  → docs that already have chunks
--   pending  → docs that don't (the actual backlog — the 120 from 2026-05-24)
--   NULL     → 'missing'-status placeholders or no file_path
