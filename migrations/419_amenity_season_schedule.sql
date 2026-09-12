-- ============================================================================
-- 419_amenity_season_schedule.sql  (Ed 2026-09-12)
-- ----------------------------------------------------------------------------
-- Date-aware seasonal schedules for amenities. A pool runs summer-daily, then a
-- weekends-only shoulder, then closed — a single stored "hours" line goes stale
-- and Claire reads the wrong season (she gave daily hours in September when the
-- Waterview pool was weekends-only). season_schedule.phases is an ordered list
-- of { from:"MM-DD", to:"MM-DD", label?, hours }; the profile builder computes
-- which phase covers TODAY (America/Chicago) and Claire states only that.
--
-- offseason_note carries the association's swim-at-your-own-risk program (a
-- resident waiver, separate from the pool-management/lifeguard contract).
--
-- Waterview values are transcribed from the Swim Houston Pool Management 2026
-- contract (Exhibit B schedule). Peak Tue-Sun daily through early Aug, then
-- weekends-only Aug 11 - Sep 27, closed after. Confirm SAYOR dates/application
-- path with Ed before treating that note as final.
-- ============================================================================
BEGIN;

ALTER TABLE amenities ADD COLUMN IF NOT EXISTS season_schedule jsonb;

UPDATE amenities SET season_schedule = '{
  "phases": [
    { "from": "06-02", "to": "07-31", "label": "Summer", "hours": "Tuesday through Sunday, 10am to 8pm (closed Mondays)" },
    { "from": "08-01", "to": "08-10", "hours": "Tuesday through Sunday, 10am to 8pm (closed Mondays)" },
    { "from": "08-11", "to": "09-27", "label": "Weekends only", "hours": "Saturday and Sunday, 10am to 8pm (weekdays closed for the season)" }
  ],
  "closed_text": "closed for the lifeguarded season (last day September 27)",
  "offseason_note": "Once the lifeguarded season ends the pool is closed for regular hours. Residents may still use the pool under the association''s swim-at-your-own-risk program, which requires a signed waiver/application through the association — point them to the homeowner portal to apply."
}'::jsonb
WHERE community_id = 'a0000000-0000-4000-8000-000000000001'
  AND (amenity_type = 'pool' OR name ILIKE '%Splash Pad%');

COMMIT;

-- Verify:
--   SELECT name, season_schedule FROM amenities
--   WHERE community_id = 'a0000000-0000-4000-8000-000000000001' AND amenity_type = 'pool';
