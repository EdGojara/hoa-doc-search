-- ============================================================================
-- 384 — New-homeowner welcome packet.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-24: "a new homeowner welcome packet in trusted for each community
-- except eaglewood ... lets look at where we do resales and transfers and i
-- think it should go there."
--
-- It goes in Home Sales because that is where the trigger already lives. The
-- moment ownership flips (POST /api/home-sales/record-closing) is the only
-- moment we reliably know a NEW person owns a lot, what lot it is, and how to
-- reach them. Anywhere else and it becomes a thing someone has to remember.
--
-- "except Eaglewood" is NOT hard-coded anywhere. Eaglewood is management_status
-- ='terminating' with a last day of 2026-09-30 (migration 382), and welcoming
-- someone to a community we stop managing in five weeks is the actual reason to
-- skip it. So the refusal is lifecycle-driven — canDo('welcome', ...) — and it
-- moves on its own when the facts move. A name in a WHERE clause would be
-- wrong the day the next client leaves.
--
-- Record ownership: association_record. The packet a homeowner received is part
-- of that association's correspondence file. It is snapshotted at render time,
-- not recomputed, because "what did we tell them in August" must survive the
-- trash vendor changing in October.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- Per-community welcome note. Content, not a gate — the board's or manager's
-- own paragraph, printed above the facts. NULL just means we print the facts.
-- ---------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS welcome_packet_note TEXT;

COMMENT ON COLUMN communities.welcome_packet_note IS
  'Optional per-community paragraph printed at the top of the new-homeowner welcome packet. Whether a packet may be produced at all is the lifecycle question (canDo(''welcome'')), never this column.';

-- ---------------------------------------------------------------------------
-- welcome_packets — one row per packet produced, with the rendered facts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS welcome_packets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id       UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  property_id        UUID NOT NULL REFERENCES properties(id)  ON DELETE CASCADE,
  contact_id         UUID REFERENCES contacts(id),
  home_sale_id       UUID REFERENCES home_sales(id),

  -- Why this packet exists. 'resale' and 'new_construction' come out of Home
  -- Sales; 'onboarding' is a community we just took over; 'manual' is an
  -- operator answering "can you send the new folks the welcome stuff".
  occasion           TEXT NOT NULL DEFAULT 'resale'
                       CHECK (occasion IN ('resale', 'new_construction', 'onboarding', 'manual')),

  owner_name         TEXT,
  property_address   TEXT,
  effective_date     DATE,                    -- closing date where there is one

  -- What actually printed, and what could not because the data is not there.
  -- Recorded on the row so "why is Quail Ridge's packet thin" is answerable a
  -- year later without re-deriving it.
  sections_included  TEXT[] NOT NULL DEFAULT '{}',
  sections_missing   TEXT[] NOT NULL DEFAULT '{}',

  -- The exact bundle that was rendered. The community's facts as of that day.
  snapshot           JSONB,

  storage_path       TEXT,                    -- documents bucket, the PDF
  status             TEXT NOT NULL DEFAULT 'generated'
                       CHECK (status IN ('generated', 'sent')),
  sent_at            TIMESTAMPTZ,
  sent_to_email      TEXT,
  interaction_id     UUID REFERENCES interactions(id),

  generated_by       TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS welcome_packets_community_idx
  ON welcome_packets (community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS welcome_packets_property_idx
  ON welcome_packets (property_id, created_at DESC);
-- The "did this closing get its packet" lookup that drives the Home Sales list.
CREATE INDEX IF NOT EXISTS welcome_packets_home_sale_idx
  ON welcome_packets (home_sale_id) WHERE home_sale_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_welcome_packets_updated_at ON welcome_packets;
CREATE TRIGGER trg_welcome_packets_updated_at
  BEFORE UPDATE ON welcome_packets
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMENT ON TABLE welcome_packets IS
  'One row per new-homeowner welcome packet produced. snapshot holds the facts as rendered, because the packet is correspondence and correspondence does not change retroactively.';
COMMENT ON COLUMN welcome_packets.sections_missing IS
  'Sections that could not print because the underlying per-community data is empty. A thin packet is a data gap, and this is where it is visible.';

-- Explicit grants. Default privileges do not propagate reliably across
-- migrations here, and a missing service_role GRANT makes the table silently
-- unwritable from the API (migrations 196 and 200 are both this bug).
GRANT SELECT, INSERT, UPDATE, DELETE ON welcome_packets TO service_role;
GRANT SELECT                         ON welcome_packets TO authenticated;

COMMIT;

-- PostgREST caches the schema. A new table it has not seen returns empty
-- rather than erroring, which is the silent-wrong-answer shape this platform
-- keeps getting bitten by. Reload it.
NOTIFY pgrst, 'reload schema';
