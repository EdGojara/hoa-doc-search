-- 438_clma_board_tiles_config.sql
-- ----------------------------------------------------------------------------
-- Tailor the CLMA (Cinco Landscape Maintenance Association) board portal through
-- DATA, not frontend conditionals. CLMA is a landscape maintenance association,
-- not a residential HOA, so the homeowner-specific board tiles (violations/DRV,
-- architectural review, individual properties) and the empty community map do
-- not belong on its board view. We hide them via the board_tiles namespace the
-- board portal now reads (portal_module_config.board_tiles); every other tile,
-- and every other community, is unaffected. (Ed 2026-09-20, CLMA board cleanup.)
--
-- Kept visible for CLMA: Ask Amanda, Board Learning, Documents/Meetings, Motions,
-- Projects, Financials (each with truthful empty states). No fake data is added.
-- Absent config => all tiles show, so residential board portals are unchanged.
BEGIN;

UPDATE communities
   SET portal_module_config =
       COALESCE(portal_module_config, '{}'::jsonb)
       || jsonb_build_object(
            'board_tiles',
            jsonb_build_object(
              'drv',        'hidden',
              'arc',        'hidden',
              'properties', 'hidden',
              'map',        'hidden'
            )
          )
 WHERE id = 'c4a87380-81ae-43aa-94eb-a671e2d6401f';

COMMIT;
