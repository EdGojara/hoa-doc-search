-- ============================================================================
-- 226_interactions_followups_and_bucket.sql
-- Manual interaction logging (calls, notes, follow-ups) + drag-drop email
-- attachments on the staff property detail panel.
--
-- Ed 2026-06-16: staff asked to be able to see/log homeowner emails + calls
-- without leaving the property page. Phase 1 ships the schema + storage so
-- the timeline already has somewhere to write to; M365 inbound sync is
-- phase 2.
-- ============================================================================

-- One new column on interactions: when to circle back. Existing schema
-- already has type='phone'|'in_person'|'internal_note'|'email_inbound'
-- etc., direction, attachments JSONB, source='manual'. The follow-up date
-- is the only thing the existing schema can't express without overloading
-- the notes column.
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS follow_up_due_at TIMESTAMPTZ NULL;

-- Index for the "overdue follow-ups" query the timeline will surface and
-- (later) a per-staff dashboard tile can read.
CREATE INDEX IF NOT EXISTS idx_interactions_followup_due
  ON interactions (community_id, follow_up_due_at)
  WHERE follow_up_due_at IS NOT NULL;

-- Private storage bucket for dropped email files (.msg / .eml) and any
-- supporting attachments (PDFs, screenshots) staff drag onto a property.
-- Mirrors the builder-applications bucket pattern: private, signed-URL
-- retrieval from the API layer only.
INSERT INTO storage.buckets (id, name, public)
VALUES ('homeowner-interactions', 'homeowner-interactions', false)
ON CONFLICT (id) DO NOTHING;
