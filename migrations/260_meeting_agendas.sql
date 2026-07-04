-- ============================================================================
-- 260_meeting_agendas.sql
-- ----------------------------------------------------------------------------
-- Save agendas as records so one agenda has three destinations (Ed 2026-07-02):
-- (1) emailed to the membership with the meeting notice, (2) auto-pulled into
-- the board packet's Agenda section later (packet often finished after the
-- notice goes out), (3) printed/kept as the association record. Matched to a
-- packet on community + meeting date.
--
-- Record ownership: association_record.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS meeting_agendas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id  uuid NOT NULL,
  community_id           uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  meeting_date           date,
  meeting_type           text NOT NULL DEFAULT 'regular'
                           CHECK (meeting_type IN ('regular', 'annual', 'special', 'budget', 'emergency', 'executive', 'organizational')),
  meeting_time           text,
  location               text,
  title                  text,
  full_text              text,                      -- the rendered agenda body (what the packet + email use)
  items                  jsonb,                     -- optional structured items [{topic, duration_min}]
  status                 text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'final')),
  record_ownership       text NOT NULL DEFAULT 'association_record',
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_agendas_community
  ON meeting_agendas(community_id, meeting_date DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_meeting_agendas_updated_at ON meeting_agendas;
CREATE TRIGGER trg_meeting_agendas_updated_at
  BEFORE UPDATE ON meeting_agendas
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_agendas TO service_role;
GRANT SELECT                          ON meeting_agendas TO authenticated;

COMMIT;
