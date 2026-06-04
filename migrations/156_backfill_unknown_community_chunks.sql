-- 156_backfill_unknown_community_chunks.sql
--
-- Backfill chunks tagged metadata.community='Unknown' so they become
-- retrievable. The hybrid retrieval layer (lib/hybrid_retrieval.js)
-- includes 'General' in every query's fallback array but never 'Unknown',
-- so any chunk stamped with 'Unknown' has been invisible to askEd since
-- whenever the bug was introduced. lib/library_reindex.js no longer
-- writes 'Unknown' (migration-coincident code fix), but the existing
-- chunks need this one-time UPDATE to become searchable again.
--
-- Strategy:
--   1. For each Unknown-tagged chunk, look up its library_documents row
--      via metadata->>library_document_id, then resolve community_id
--      to the real community name. If we find one, write it back.
--   2. Any chunk whose library_document_id can't be resolved (FK broken,
--      library row deleted) gets re-tagged 'General' so it at least
--      surfaces to fallback retrieval instead of being a black hole.
--
-- Record-ownership note: this is a workpaper-level integrity fix on the
-- `documents` chunks table. No association-record data is being moved
-- or rewritten — only the metadata.community sentinel that controls
-- search visibility.
--
-- Idempotent: filters by metadata->>'community' = 'Unknown' so re-running
-- after the fix is a no-op.

BEGIN;

-- 1. Resolve Unknown chunks whose library_documents row IS findable
--    and whose community_id resolves to a real community.
WITH resolved AS (
  SELECT
    d.ctid AS chunk_ctid,
    c.name AS resolved_name
  FROM documents d
  JOIN library_documents ld
    ON ld.id::text = (d.metadata->>'library_document_id')
  JOIN communities c
    ON c.id = ld.community_id
  WHERE d.metadata->>'community' = 'Unknown'
)
UPDATE documents d
SET metadata = jsonb_set(d.metadata, '{community}', to_jsonb(r.resolved_name))
FROM resolved r
WHERE d.ctid = r.chunk_ctid;

-- 2. Any Unknown chunk that COULDN'T resolve (FK broken or community_id
--    null on the library row) becomes 'General' so it at least surfaces
--    via the fallback path. Better than permanently invisible.
UPDATE documents
SET metadata = jsonb_set(metadata, '{community}', '"General"'::jsonb)
WHERE metadata->>'community' = 'Unknown';

COMMIT;
