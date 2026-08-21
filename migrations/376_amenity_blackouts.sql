-- ============================================================================
-- 376_amenity_blackouts.sql  (Ed 2026-08-20)
-- ----------------------------------------------------------------------------
-- Dates staff can take off the board.
--
-- Ed: "how does the staff block out dates on the calendar."
--
-- Today they cannot. Availability is computed purely from existing bookings
-- (v_amenity_busy_slots), so a clubhouse closed for a floor refinish, a holiday,
-- or an association event is bookable online and somebody turns up to a locked
-- door. The only workaround was to create a fake rental, which puts a fiction
-- in the record the association keeps.
--
-- Scope, deliberately two ways:
--   amenity_id set          this amenity only, e.g. clubhouse floors resealed
--   amenity_id NULL         every amenity in the community, e.g. Christmas Day
-- Same shape as calendar_events, where a null community means company-wide.
--
-- A blackout is a RANGE. A three-day closure is one row a person can read and
-- cancel, not three rows they have to remember to remove together.
--
-- WHAT A HOMEOWNER SEES. Ed 2026-08-20: "they just see reserved or event or not
-- available". public_note is what the booking page may show ("Closed for
-- maintenance"); internal reason is staff-only. If public_note is null the date
-- simply reads "Not available", which is all a homeowner needs.
--
-- record_ownership: association_record. When the clubhouse was closed is the
-- association's operating history and goes with them.
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS amenity_blackouts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  -- NULL = every amenity in this community.
  amenity_id        UUID REFERENCES amenities(id) ON DELETE CASCADE,

  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,          -- inclusive; same as start for one day

  reason            TEXT NOT NULL,          -- staff-facing: "Floors being resealed"
  public_note       TEXT,                   -- homeowner-facing, or NULL for a bare "Not available"

  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A range that ends before it starts silently blocks nothing, which looks
  -- exactly like a blackout that worked.
  CONSTRAINT amenity_blackouts_range_check CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_amenity_blackouts_lookup
  ON amenity_blackouts (community_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_amenity_blackouts_amenity
  ON amenity_blackouts (amenity_id, start_date) WHERE amenity_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_amenity_blackouts_updated_at ON amenity_blackouts;
CREATE TRIGGER trg_amenity_blackouts_updated_at
  BEFORE UPDATE ON amenity_blackouts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Explicit grants. A new table the API writes to without these is silently
-- unwritable, and the failure surfaces deep in a side-effect chain while the
-- caller reports success. (CLAUDE.md, hit three times in one evening.)
GRANT SELECT, INSERT, UPDATE, DELETE ON amenity_blackouts TO service_role;
GRANT SELECT                          ON amenity_blackouts TO authenticated;

COMMIT;

-- Verify:
--   SELECT c.name, a.name AS amenity, b.start_date, b.end_date, b.reason
--     FROM amenity_blackouts b
--     JOIN communities c ON c.id = b.community_id
--     LEFT JOIN amenities a ON a.id = b.amenity_id
--    ORDER BY b.start_date;
