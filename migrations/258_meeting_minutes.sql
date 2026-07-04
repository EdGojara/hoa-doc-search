-- ============================================================================
-- 258_meeting_minutes.sql
-- ----------------------------------------------------------------------------
-- Minutes module (Ed 2026-07-02). Formal board/annual meeting minutes, drafted
-- by AI from what the platform already knows (board roster, the decisions log,
-- annual-meeting attendance), edited by staff, then finalized into a Bedrock-
-- branded document that files as an association record AND feeds the board
-- packet's Prior Minutes section. Closes the loop agenda → meeting → minutes →
-- packet.
--
-- Record ownership: association_record — minutes ARE the HOA's record and must
-- be handed over on termination.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS meeting_minutes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id  uuid NOT NULL,
  community_id           uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  meeting_date           date,
  meeting_type           text NOT NULL DEFAULT 'regular'
                           CHECK (meeting_type IN ('regular', 'annual', 'special', 'executive', 'organizational')),
  title                  text,
  status                 text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'in_review', 'final')),
  body_markdown          text,                     -- the editable minutes body
  attendees              jsonb,                    -- [{ name, role, present }]
  location               text,
  called_to_order_at     text,                     -- free text time e.g. "6:03 PM"
  adjourned_at           text,
  ai_drafted             boolean NOT NULL DEFAULT false,
  ai_model               text,
  rendered_document_id   uuid REFERENCES library_documents(id) ON DELETE SET NULL,
  finalized_at           timestamptz,
  finalized_by           text,
  record_ownership       text NOT NULL DEFAULT 'association_record',
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_minutes_community
  ON meeting_minutes(community_id, meeting_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_meeting_minutes_final
  ON meeting_minutes(community_id, status, meeting_date DESC) WHERE status = 'final';

DROP TRIGGER IF EXISTS trg_meeting_minutes_updated_at ON meeting_minutes;
CREATE TRIGGER trg_meeting_minutes_updated_at
  BEFORE UPDATE ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_minutes TO service_role;
GRANT SELECT                          ON meeting_minutes TO authenticated;

COMMIT;
