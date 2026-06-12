-- ============================================================================
-- 217_community_photos_and_pdf_campaigns.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-12 greenlit two related capabilities:
--   1. Community photo library (NEW — no parallel exists)
--   2. Annual report / mailing-template renderer
--
-- IMPORTANT — initial draft duplicated email_campaigns + recipient tables
-- that already exist from migration 185. Rewritten to EXTEND the existing
-- infrastructure rather than silo it (CLAUDE.md "Integration depth before
-- breadth" + "No new silos").
--
-- What this migration does:
--   1. CREATE community_photos — the per-community reusable photo asset
--      library. Truly new capability with no existing parallel.
--   2. ALTER email_campaigns to add columns supporting structured-template
--      campaigns (annual reports, monthly newsletters, meeting notices) on
--      top of the current free-form HTML campaigns. Backward compatible —
--      existing campaigns continue to use the free-form path unchanged.
--   3. ALTER email_campaigns to add PDF output for print-distribution use
--      cases (annual reports get mailed). The existing send pipeline is
--      email-only; this lets a campaign produce BOTH a sent email and a
--      print-ready PDF stored in supabase storage.
--
-- Record ownership (CLAUDE.md taxonomy):
--   community_photos = association_record (HOA's brand assets; export
--   them on termination). Bedrock administers but doesn't own.
--   email_campaigns extensions inherit the existing table's mixed
--   classification.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) community_photos — the per-community reusable photo asset library.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_photos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  -- Storage location (Supabase storage bucket + path)
  storage_bucket      TEXT NOT NULL DEFAULT 'documents',
  storage_path        TEXT NOT NULL,
  original_filename   TEXT,
  mime_type           TEXT,
  size_bytes          BIGINT,
  width_px            INTEGER,
  height_px           INTEGER,

  -- Editorial metadata
  -- role drives where the photo can be auto-placed by templates:
  --   hero       = top-of-page cover image (high aspect, landscape orientation)
  --   amenity    = pool / clubhouse / playground / gym
  --   landscape  = common-area, trails, lakes, mature trees
  --   aerial     = drone / overhead shot of the community
  --   signage    = entrance sign, monument
  --   event      = annual meeting, party, gathering (date-stamped)
  --   general    = anything else; manual placement only
  role                TEXT NOT NULL DEFAULT 'general'
                        CHECK (role IN ('hero','amenity','landscape','aerial','signage','event','general')),
  caption             TEXT,
  taken_at            DATE,
  sort_order          INTEGER NOT NULL DEFAULT 100,
  active              BOOLEAN NOT NULL DEFAULT TRUE,

  -- Audit
  uploaded_by         TEXT,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes               TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_photos_lookup
  ON community_photos (community_id, role, sort_order)
  WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_community_photos_recent
  ON community_photos (community_id, uploaded_at DESC);

DROP TRIGGER IF EXISTS trg_community_photos_updated_at ON community_photos;
CREATE TRIGGER trg_community_photos_updated_at
  BEFORE UPDATE ON community_photos
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON community_photos TO service_role;
GRANT SELECT ON community_photos TO authenticated;


-- ---------------------------------------------------------------------------
-- 2) Extend email_campaigns with structured-template + PDF-output support.
-- ---------------------------------------------------------------------------
-- template_id NULL = legacy free-form HTML campaign (existing behavior).
-- template_id 'annual_report' / 'monthly_newsletter' / 'meeting_notice' =
-- structured-template campaign where structured_content is the input and
-- the renderer assembles HTML + PDF from a locked template + community
-- brand + photo library.
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS template_id TEXT
    CHECK (template_id IS NULL OR template_id IN (
      'free_form',
      'annual_report',
      'monthly_newsletter',
      'meeting_notice',
      'amenity_announcement',
      'board_packet_companion'
    ));

ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS structured_content JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS report_period_start DATE;

ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS report_period_end DATE;

-- PDF output for print-distribution use cases (annual reports get mailed).
-- Path lives in supabase storage under communities/{slug}/mailings/...
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT;

-- Cached rendered HTML — the assembled version of the body_html_template
-- after substitution but BEFORE per-recipient personalization. Lets the
-- UI show a preview without re-running the renderer on every load.
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS rendered_html_preview TEXT;

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- -- community_photos exists and is granted:
-- SELECT count(*) FROM community_photos;
--
-- -- email_campaigns gained the new columns:
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'email_campaigns'
--   AND column_name IN ('template_id','structured_content','report_period_start','report_period_end','pdf_storage_path','rendered_html_preview');
