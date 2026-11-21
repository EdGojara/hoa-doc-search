-- 572: portal_user_residencies was created (migration 186) without grants, so
-- the API's service role gets "permission denied" and the renter portal path
-- (/api/portal/me renter branch, /api/portal/documents renter scope) silently
-- returns nothing. Found in portal testing 2026-11-21.
-- Record ownership: workpaper (portal access scope, internal).
BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_user_residencies TO service_role;
COMMIT;
