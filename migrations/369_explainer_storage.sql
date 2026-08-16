-- ============================================================================
-- 369_explainer_storage.sql  (Ed 2026-08-16)
-- ----------------------------------------------------------------------------
-- Explainer videos get a PERMANENT home.
--
-- The scar this closes, found the same day it was built: when a render finished
-- we wrote the PROVIDER's video URL straight into claire_explainers.video_url.
-- That URL is signed and expires in about a week. Every explainer would have
-- worked perfectly in testing, been linked from the portal and handed to a
-- distribution partner, and then gone dead a week later with no error anywhere
-- — the file still exists, the row still looks complete, and the only symptom
-- is a homeowner clicking play and getting nothing. A silent failure with a
-- timer on it.
--
-- Videos now land in the `explainers` storage bucket, which is PUBLIC READ and
-- deliberately separate from every other bucket in this project. All six of the
-- others (documents, violation-letters, homeowner-interactions,
-- sent-letters-archive, evidence-archive, finalized-docs-archive) are private
-- and must stay that way: they hold governing documents, owner-vault bank
-- statements, evidence photos and sealed correspondence. An explainer is the
-- one class of asset whose job is to be watched by people who are not logged
-- in — homeowners, prospects, a newsletter embed, a distribution partner's
-- audience — so it gets its own bucket rather than a public policy carved into
-- a private one.
--
-- Record ownership: workpaper (Bedrock IP). An explainer is Bedrock content
-- reused across every community, NOT a community-scoped association record,
-- which is why it lives here and not in library_documents.
-- ============================================================================
BEGIN;

ALTER TABLE claire_explainers
  ADD COLUMN IF NOT EXISTS storage_path TEXT,          -- path inside the `explainers` bucket
  ADD COLUMN IF NOT EXISTS provider_url TEXT,          -- the expiring source URL, kept for diagnosis only
  ADD COLUMN IF NOT EXISTS bytes BIGINT,
  ADD COLUMN IF NOT EXISTS stored_at TIMESTAMPTZ;

-- video_url now always holds OUR permanent public URL. provider_url keeps the
-- HeyGen link purely so a failed copy can be re-attempted before it expires;
-- nothing customer-facing should ever read it.
COMMENT ON COLUMN claire_explainers.video_url IS
  'Permanent public URL in the explainers bucket. Never a provider URL — those expire.';
COMMENT ON COLUMN claire_explainers.provider_url IS
  'Expiring provider URL, retained for re-copy and diagnosis only. Never serve this.';

CREATE INDEX IF NOT EXISTS idx_claire_explainers_ready
  ON claire_explainers(topic, language) WHERE status = 'ready';

COMMIT;
