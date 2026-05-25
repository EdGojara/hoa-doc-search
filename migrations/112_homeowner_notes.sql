-- ============================================================================
-- 112_homeowner_notes.sql
-- ----------------------------------------------------------------------------
-- Staff-only workspace notes about a homeowner. NEVER customer-visible.
-- DISTINCT from `interactions` (which are factual touch records, possibly
-- discoverable in litigation). homeowner_notes hold staff opinions,
-- watch-outs, internal strategy:
--   - "attorney prepping demand letter; do not commit on AR until cleared"
--   - "talk only to wife per request, husband has hearing impairment"
--   - "complained at last 3 board meetings about pool; sensitive topic"
--
-- record_ownership = workpaper. Stays with Bedrock on contract termination
-- per CLAUDE.md three-bucket discipline.
--
-- Scoped to contact + optional community + optional property for context.
-- Notes can be categorized for filtering on the profile.
--
-- pinned=true surfaces the note at the top of the profile (for the
-- watch-outs that staff need to see EVERY time they open the homeowner).
--
-- Apply AFTER 111. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS homeowner_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  community_id        UUID NULL REFERENCES communities(id) ON DELETE SET NULL,
  property_id         UUID NULL REFERENCES properties(id) ON DELETE SET NULL,

  note_text           TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'general'
                        CHECK (category IN (
                          'general',
                          'escalation_history',
                          'contact_preference_context',
                          'legal_note',
                          'payment_history_context',
                          'accommodation',
                          'attorney_strategy',
                          'do_not_contact_reason',
                          'vendor_context'
                        )),

  author_email        TEXT NOT NULL,
  pinned              BOOLEAN NOT NULL DEFAULT FALSE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_homeowner_notes_contact_recent
  ON homeowner_notes (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_homeowner_notes_pinned
  ON homeowner_notes (contact_id, created_at DESC)
  WHERE pinned = TRUE;

CREATE INDEX IF NOT EXISTS idx_homeowner_notes_category
  ON homeowner_notes (contact_id, category, created_at DESC);

DROP TRIGGER IF EXISTS trg_homeowner_notes_set_updated_at ON homeowner_notes;
CREATE TRIGGER trg_homeowner_notes_set_updated_at
  BEFORE UPDATE ON homeowner_notes
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON homeowner_notes TO service_role;

COMMIT;

-- Verify:
--   SELECT category, COUNT(*) FROM homeowner_notes
--    GROUP BY category ORDER BY category;
