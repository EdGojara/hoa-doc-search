-- ============================================================================
-- 110_contact_preferences.sql
-- ----------------------------------------------------------------------------
-- Granular per-contact communication preferences. Extends what's flat on
-- contacts today (sms_opt_in/out, email_opt_out, preferred_language) with
-- the channel splits and per-feature toggles Vantaca exposes — needed for
-- the unified Homeowner Profile to match Vantaca-grade preference granularity.
--
-- Separate table (not columns on contacts) so:
--   - Preferences evolve faster than identity fields; isolating them keeps
--     the contacts table stable across pref changes.
--   - Future per-community pref overrides ("paper at HOA A, email at HOA B")
--     become a community_id column add, not a contacts table churn.
--   - JOIN cost stays cheap: single row per contact, indexed FK.
--
-- One row per contact (UNIQUE on contact_id). Absent row = the application
-- treats defaults as implicit (general=email, billing=email,
-- payment_confirmation=true, payment_reminders_text=false).
--
-- Apply AFTER 109. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS contact_preferences (
  id                                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                         UUID NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,

  -- Channel preferences by message category
  general_comm_channel               TEXT NOT NULL DEFAULT 'email'
                                       CHECK (general_comm_channel IN ('paper','email','both','suppress')),
  billing_comm_channel               TEXT NOT NULL DEFAULT 'email'
                                       CHECK (billing_comm_channel IN ('paper','email','both','suppress')),

  -- Per-feature toggles
  payment_confirmation_email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  payment_reminders_text_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  payment_reminders_phone            TEXT NULL,

  notes                              TEXT NULL,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_preferences_contact
  ON contact_preferences (contact_id);

DROP TRIGGER IF EXISTS trg_contact_preferences_set_updated_at ON contact_preferences;
CREATE TRIGGER trg_contact_preferences_set_updated_at
  BEFORE UPDATE ON contact_preferences
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_preferences TO service_role;

COMMIT;

-- Verify:
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'contact_preferences'
--    ORDER BY ordinal_position;
