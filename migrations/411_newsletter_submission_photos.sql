-- ============================================================================
-- 411_newsletter_submission_photos.sql  (Ed 2026-09-06)
-- ----------------------------------------------------------------------------
-- Residents can attach photos to a "Share Community News" submission so staff
-- can actually USE the image if they pick that submission for the newsletter
-- (a neighbor being celebrated, a local business, an event). Files live in the
-- 'documents' storage bucket under newsletter-submissions/<community_id>/<row>/;
-- this column holds the lightweight manifest: [{path,name,mime,size}].
--
-- Record ownership follows the parent row (newsletter_submissions = mixed):
-- a photo the association publishes in a delivered newsletter is an
-- association_record; an unused/declined submission photo stays a workpaper.
-- No new table + no new grants needed — the column rides migration 409's grants.
-- ============================================================================
BEGIN;

ALTER TABLE newsletter_submissions
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
