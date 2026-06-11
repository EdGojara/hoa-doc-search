-- Migration 213 — Flip Architectural Review tile from "coming soon" to LIVE
-- on every real community's portal_module_config.
--
-- Context: Ed 2026-06-10 asked to ship the ARC tile live. The frontend
-- defaultDemoModuleConfig() in public/portal.html already has
-- `arc: { status: 'live' }`, but the per-community
-- communities.portal_module_config JSONB does NOT have the arc key on
-- existing rows. Per the CLAUDE.md tile-gate scar, the demo default
-- alone is not enough — the per-community JSONB must also carry the
-- live flag or the tile renders as "coming soon" for real users.
--
-- Backend reality check: by the time this migration runs the ARC flow
-- is fully wired:
--   - Homeowner: POST /api/portal/arc/submit (multipart, photos + form)
--   - Homeowner: GET  /api/portal/arc (list my applications + statuses)
--   - Staff queue:    GET /applications + /applications/:id
--   - Staff fee:      POST /applications/:id/assess
--   - Staff decide:   POST /applications/:id/finalize
--   - Committee:      portal_admin routes /community/:cid/arc-committee
--   - Decision send:  POST /applications/:id/send-decision
--
-- So flipping the tile live opens a fully functional flow.
--
-- Idempotent: only touches communities whose portal_module_config either
-- lacks the arc key entirely OR has it set to anything other than live.
-- Safe to re-run.

BEGIN;

UPDATE communities
SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
                         || jsonb_build_object('arc', jsonb_build_object('status', 'live'))
WHERE
  (portal_module_config IS NULL)
  OR NOT (portal_module_config ? 'arc')
  OR (portal_module_config -> 'arc' ->> 'status') IS DISTINCT FROM 'live';

COMMIT;
