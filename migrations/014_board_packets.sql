-- ============================================================================
-- 014_board_packets.sql
-- ----------------------------------------------------------------------------
-- Board Packet Generator module.
--
-- The goal: produce a Bedrock-branded, "encode-Ed-voice" board packet for a
-- community meeting in ~45 minutes (vs. several hours of cobbling together
-- Vantaca + HomeWise exports). Same design language as the static preview
-- at /public/board_packet_preview.html, but now driven by real packet data
-- assembled per-meeting.
--
-- Design pattern: "build the workflow, stub the data."
--   - The output design (sections, layout, voice) is locked.
--   - Each section accepts THREE input modes: manual / upload / auto-from-trustEd.
--   - The "auto" mode is stubbed today; gets wired to live modules
--     (financial_review, vendors, contracts, etc.) as they mature.
--   - The renderer takes structured section data → branded HTML/PDF.
--
-- Apply AFTER 013/013b documents unify. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- board_packets
-- One row per packet for a (community, meeting_date) pair.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_packets (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID NOT NULL REFERENCES communities(id),
  period_label             TEXT NOT NULL,                        -- "April 2026", "Q1 2026 Board Meeting", "Annual 2026"
  meeting_date             DATE,
  meeting_time             TIME,                                  -- optional, useful for agenda rendering
  meeting_type             TEXT
                           CHECK (meeting_type IS NULL OR meeting_type IN
                             ('regular','annual','special','executive','workshop','other')),
  meeting_format           TEXT
                           CHECK (meeting_format IS NULL OR meeting_format IN
                             ('in_person','virtual','hybrid')),
  meeting_location         TEXT,                                  -- "Clubhouse" or Zoom link
  -- Workflow status
  status                   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','in_review','final','distributed','archived')),
  -- Rendered output
  rendered_html_path       TEXT,                                  -- Supabase Storage path to final HTML
  rendered_pdf_path        TEXT,                                  -- Supabase Storage path to final PDF
  rendered_at              TIMESTAMPTZ,
  -- AI-generated summaries (cached so we don't re-run Claude on every view)
  ai_exec_summary          TEXT,
  ai_watch_outs            JSONB,                                 -- array of { severity, message, source_section }
  ai_action_items          JSONB,                                 -- array of { item, owner, due_date, source_section }
  -- Freeform
  notes                    TEXT,
  -- Audit
  created_by               UUID,                                  -- nullable until auth
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One packet per (community, period_label) — prevents accidental duplicates
  UNIQUE (community_id, period_label)
);

CREATE INDEX IF NOT EXISTS idx_board_packets_mgmt_community
  ON board_packets(management_company_id, community_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_board_packets_status
  ON board_packets(management_company_id, status);

DROP TRIGGER IF EXISTS trg_board_packets_updated_at ON board_packets;
CREATE TRIGGER trg_board_packets_updated_at
  BEFORE UPDATE ON board_packets
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- board_packet_section_templates
-- The canonical structure of a Bedrock board packet. Driving table for the
-- wizard UI and section initialization on packet creation.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_packet_section_templates (
  section_key              TEXT PRIMARY KEY,                     -- 'cover','agenda', etc.
  display_name             TEXT NOT NULL,
  description              TEXT,
  default_order            INTEGER NOT NULL,
  required_default         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Which input modes this section supports
  supports_manual          BOOLEAN NOT NULL DEFAULT TRUE,
  supports_upload          BOOLEAN NOT NULL DEFAULT FALSE,
  supports_auto_trusted    BOOLEAN NOT NULL DEFAULT FALSE,
  supports_ai_generated    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Hint to renderer / wizard
  data_schema_hint         JSONB                                  -- example of expected input_data shape
);

INSERT INTO board_packet_section_templates
  (section_key, display_name, description, default_order, required_default,
   supports_manual, supports_upload, supports_auto_trusted, supports_ai_generated, data_schema_hint)
VALUES
  ('cover',            'Cover Page',
   'Community name, meeting date/time/location, attending board members, Bedrock branding',
   10,  TRUE,  TRUE,  FALSE, TRUE,  FALSE,
   '{"attendees":[{"name":"","role":""}],"presenters":[]}'::jsonb),

  ('agenda',           'Agenda',
   'Meeting agenda with topics, presenters, and time allocations',
   20,  TRUE,  TRUE,  TRUE,  FALSE, FALSE,
   '{"items":[{"topic":"","presenter":"","duration_min":10,"notes":""}]}'::jsonb),

  ('prior_minutes',    'Prior Meeting Minutes',
   'Minutes from the previous board meeting for approval',
   30,  TRUE,  TRUE,  TRUE,  TRUE,  FALSE,
   '{"prior_meeting_date":null,"summary":"","motions":[],"action_items_status":[]}'::jsonb),

  ('exec_summary',     'Executive Summary',
   'Ed-voiced summary of the community''s state — financial position, key issues, watch-outs',
   40,  TRUE,  TRUE,  FALSE, FALSE, TRUE,
   '{"text":"","key_points":[]}'::jsonb),

  ('financials',       'Financial Statements',
   'Income Statement (P&L), Balance Sheet, cash position vs. budget',
   50,  TRUE,  TRUE,  TRUE,  TRUE,  FALSE,
   '{"period_start":null,"period_end":null,"total_revenue":null,"total_expense":null,"net_income":null,"cash_operating":null,"cash_reserves":null,"line_items":[]}'::jsonb),

  ('drv',              'Doctivity Variance Report',
   'Budget-to-actual variance analysis with commentary on material variances',
   60,  FALSE, FALSE, TRUE,  TRUE,  FALSE,
   '{"variances":[{"category":"","budget":0,"actual":0,"variance":0,"variance_pct":0,"commentary":""}]}'::jsonb),

  ('ar_aging',         'Delinquencies / AR Aging',
   'Account receivable aging by owner with collection status',
   70,  TRUE,  TRUE,  TRUE,  TRUE,  FALSE,
   '{"total_ar":0,"buckets":{"0_30":0,"31_60":0,"61_90":0,"over_90":0},"top_delinquent":[]}'::jsonb),

  ('vendor_activity',  'Vendor Activity',
   'Active contracts, recent invoices, upcoming renewals, W-9 gaps',
   80,  FALSE, FALSE, FALSE, TRUE,  FALSE,
   '{"active_contracts":[],"recent_invoices":[],"upcoming_renewals":[],"w9_gaps":[]}'::jsonb),

  ('arc_decisions',    'ARC Decisions',
   'Architectural Review Committee decisions since prior meeting',
   90,  FALSE, TRUE,  TRUE,  TRUE,  FALSE,
   '{"decisions":[{"address":"","request":"","status":"","date":null,"notes":""}]}'::jsonb),

  ('action_items',     'Action Items & Watch Outs',
   'Open items requiring board action, with owners and due dates',
   100, TRUE,  TRUE,  FALSE, FALSE, TRUE,
   '{"items":[{"item":"","owner":"","due_date":null,"priority":"medium","source":""}]}'::jsonb),

  ('appendix',         'Appendix',
   'Supporting documents and attachments referenced in the meeting',
   110, FALSE, TRUE,  TRUE,  FALSE, FALSE,
   '{"attachments":[{"title":"","library_document_id":null,"notes":""}]}'::jsonb)
ON CONFLICT (section_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  default_order = EXCLUDED.default_order,
  supports_manual = EXCLUDED.supports_manual,
  supports_upload = EXCLUDED.supports_upload,
  supports_auto_trusted = EXCLUDED.supports_auto_trusted,
  supports_ai_generated = EXCLUDED.supports_ai_generated,
  data_schema_hint = EXCLUDED.data_schema_hint;

-- ----------------------------------------------------------------------------
-- board_packet_sections
-- One row per (packet, section_key). Auto-seeded on packet creation from
-- the templates table.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_packet_sections (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  packet_id                UUID NOT NULL REFERENCES board_packets(id) ON DELETE CASCADE,
  section_key              TEXT NOT NULL REFERENCES board_packet_section_templates(section_key),
  section_order            INTEGER NOT NULL,
  -- How was this section populated?
  input_mode               TEXT NOT NULL DEFAULT 'manual'
                           CHECK (input_mode IN ('manual','upload','auto_from_trusted','ai_generated','skipped')),
  -- The actual content/data for this section
  input_data               JSONB,                                 -- shape matches data_schema_hint roughly
  input_raw_text           TEXT,                                  -- if from upload, the extracted text Claude saw
  source_document_id       UUID REFERENCES library_documents(id), -- if from upload, the library doc record
  rendered_html            TEXT,                                  -- the pre-rendered HTML for this section
  -- Status of this section
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','in_progress','ready','skipped','error')),
  -- Extraction metadata (when input_mode = 'upload' or 'ai_generated')
  extraction_model         TEXT,
  extraction_confidence    TEXT
                           CHECK (extraction_confidence IS NULL OR extraction_confidence IN ('high','medium','low')),
  extraction_notes         TEXT,
  -- Freeform
  notes                    TEXT,
  -- Audit
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (packet_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_board_packet_sections_packet
  ON board_packet_sections(packet_id, section_order);
CREATE INDEX IF NOT EXISTS idx_board_packet_sections_status
  ON board_packet_sections(packet_id, status);

DROP TRIGGER IF EXISTS trg_board_packet_sections_updated_at ON board_packet_sections;
CREATE TRIGGER trg_board_packet_sections_updated_at
  BEFORE UPDATE ON board_packet_sections
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- board_packet_distribution_log
-- Audit trail of who got the packet, how, when.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_packet_distribution_log (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  packet_id                UUID NOT NULL REFERENCES board_packets(id) ON DELETE CASCADE,
  distributed_to           TEXT NOT NULL,                        -- email address or recipient name
  distribution_method      TEXT NOT NULL
                           CHECK (distribution_method IN ('email','download','print','share_link')),
  distributed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  distributed_by           UUID,
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_board_packet_dist_packet
  ON board_packet_distribution_log(packet_id, distributed_at DESC);

-- ----------------------------------------------------------------------------
-- Helper view: packet summary with section completion counts
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_board_packet_summary AS
SELECT
  p.id,
  p.management_company_id,
  p.community_id,
  c.name                    AS community_name,
  p.period_label,
  p.meeting_date,
  p.meeting_type,
  p.status,
  COUNT(s.id) FILTER (WHERE s.status = 'ready')        AS sections_ready,
  COUNT(s.id) FILTER (WHERE s.status = 'pending')      AS sections_pending,
  COUNT(s.id) FILTER (WHERE s.status = 'in_progress')  AS sections_in_progress,
  COUNT(s.id) FILTER (WHERE s.status = 'skipped')      AS sections_skipped,
  COUNT(s.id) FILTER (WHERE s.status = 'error')        AS sections_error,
  COUNT(s.id)                                          AS sections_total,
  p.rendered_at,
  p.rendered_pdf_path,
  p.created_at,
  p.updated_at
FROM board_packets p
LEFT JOIN communities c ON c.id = p.community_id
LEFT JOIN board_packet_sections s ON s.packet_id = p.id
GROUP BY p.id, c.name;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
ALTER TABLE board_packets                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_packet_sections               ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_packet_distribution_log       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_board_packets_tenant ON board_packets;
CREATE POLICY p_board_packets_tenant ON board_packets
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_board_packet_sections_tenant ON board_packet_sections;
CREATE POLICY p_board_packet_sections_tenant ON board_packet_sections
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM board_packets p
    WHERE p.id = board_packet_sections.packet_id
      AND p.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_board_packet_dist_tenant ON board_packet_distribution_log;
CREATE POLICY p_board_packet_dist_tenant ON board_packet_distribution_log
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM board_packets p
    WHERE p.id = board_packet_distribution_log.packet_id
      AND p.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
GRANT ALL ON board_packets, board_packet_sections, board_packet_distribution_log
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  board_packets, board_packet_sections, board_packet_distribution_log
  TO authenticated;
GRANT SELECT ON board_packet_section_templates, v_board_packet_summary
  TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- Verify:
--   SELECT section_key, display_name, default_order FROM board_packet_section_templates
--     ORDER BY default_order;   -- expect 11 rows
--   SELECT COUNT(*) FROM board_packets;                  -- expect 0 (fresh table)
-- ----------------------------------------------------------------------------
