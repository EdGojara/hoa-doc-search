-- 435_presentation_artifact_type.sql
-- Distinguish demo/presentation exports from management-proposal outputs in the
-- shared presentation_instances history, so we never depend on misleading legacy
-- template_slug names to know which is which. (Ed 2026-09-20, presentation/
-- proposal domain split.) Additive + backfill; existing records preserved.
--
-- Record ownership: presentation_instances is `mixed` — a delivered proposal is
-- an association_record once sent; the generation history is a workpaper. The
-- artifact_type column is what the export/split tooling filters on.
BEGIN;

ALTER TABLE presentation_instances
  ADD COLUMN IF NOT EXISTS artifact_type TEXT
    CHECK (artifact_type IN ('presentation', 'proposal'));

-- Backfill existing rows by their legacy template_slug, ONE TIME, so the new
-- column is authoritative going forward and the legacy names can be retired.
--   'board' / 'management_proposal'  -> proposal
--   'audience:*', 'partner', other   -> presentation (demo)
UPDATE presentation_instances
   SET artifact_type = 'proposal'
 WHERE artifact_type IS NULL
   AND template_slug IN ('board', 'management_proposal');

UPDATE presentation_instances
   SET artifact_type = 'presentation'
 WHERE artifact_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_presentation_instances_artifact
  ON presentation_instances (management_company_id, artifact_type, created_at DESC);

-- Tell PostgREST to reload its schema cache so supabase-js sees artifact_type
-- immediately. Without this the new column is invisible to the REST layer and
-- the proposal list/download/delete queries (which filter on artifact_type)
-- fail until the cache reloads on its own. (The recurring "new column silently
-- EMPTY" scar; same pattern as migrations 141-147.)
NOTIFY pgrst, 'reload schema';

COMMIT;
