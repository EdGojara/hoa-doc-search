-- ============================================================================
-- 336_recurrence_escalation_flag.sql  (Ed 2026-07-25)
-- ----------------------------------------------------------------------------
-- Repeat-offender escalation, scoped to the RIGHT violations.
--
-- Tex. Prop. Code §209.006(d): the notice-and-cure requirement does NOT apply to
-- a violation for which the owner was given notice and an opportunity to cure a
-- SIMILAR violation within the preceding SIX MONTHS. So a within-6-month repeat
-- of the same/similar violation can skip the courtesy/cure step and escalate.
--
-- But that anti-evasion rule is only fair for violations the owner can MOVE or
-- HIDE to dodge a notice and then bring back (a trailer, an RV, stored items,
-- a portable basketball goal). It must NOT apply to violations that recur by
-- NATURE — grass regrows, trash cans go out weekly — where "it came back" is
-- normal life, not gaming, and escalating would be indefensible. (Ed 2026-07-25:
-- "separate it from grass mowing and trash cans and use it more for things like
-- trailers that move and come back.")
--
-- This flag marks the movable/concealable categories. The intake chokepoint
-- (lib/enforcement/find_or_continue_violation.js) uses it: a fresh observation of
-- a flagged category whose prior case was CURED within 6 months is a RECURRENCE
-- (escalate), not a new courtesy. Unflagged categories always get a clean
-- courtesy. Per-community tuning + the fine schedule / repeat-notice wording stay
-- an RMWBH call.
-- Record ownership: association_record (enforcement config).
-- ============================================================================
BEGIN;

ALTER TABLE enforcement_categories
  ADD COLUMN IF NOT EXISTS recurrence_escalates BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN enforcement_categories.recurrence_escalates IS
  'TRUE for movable/concealable violations (trailer, RV, stored items, portable goal) where a within-6-month repeat can skip the cure period per Tex. Prop. Code 209.006(d). FALSE (default) for natural-cadence maintenance (grass, trash cans) that always gets a fresh courtesy.';

-- Flag the movable/concealable categories by slug (stable across id changes).
UPDATE enforcement_categories SET recurrence_escalates = TRUE
WHERE slug IN (
  'vehicle_rv',                        -- RV / boat / trailer
  'recreational_vehicle',
  'stored_vehicle',
  'vehicle_commercial',                -- Commercial vehicle
  'vehicle_inoperable',                -- Inoperable vehicle
  'atv_off_road_vehicle_motorcycles',
  'trailer_-_legal_drv',
  'portable_basketball_goal',
  'shed_outbuilding_-_pod'             -- a POD is temporary/movable
)
OR slug LIKE 'storage_of_unapproved_items%'   -- base + all "- Couch/Tire/..." variants
OR slug LIKE 'play_equipment_-_portable_basketball%';

COMMIT;
