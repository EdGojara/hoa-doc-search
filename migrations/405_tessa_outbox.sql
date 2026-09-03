-- ============================================================================
-- 405_tessa_outbox.sql  (Ed 2026-09-03)
-- ----------------------------------------------------------------------------
-- Tessa's OUTBOX: work she has prepared and is holding for release.
--
-- North star: a company run by the AI team with humans supervising. Tessa
-- (Ed's EA) does the work like a real assistant would -- she drafts the email,
-- attaches the document, lines up the meeting -- and then holds it in her
-- outbox for Ed to glance at and release. The click is the supervision, not the
-- labour. This is the same "human releases, AI does" gate the Draft Queue and
-- /api/tessa/meeting already use, given its own surface on Tessa's page so a
-- queued email AND a queued meeting sit side by side.
--
-- One row = one prepared action, kind 'email' or 'meeting'. Everything the
-- release needs is on the row (recipients, body, the attachment's storage path,
-- or the meeting's local wall-time + attendees). Nothing is sent until Ed hits
-- release; result JSON captures what came back (message id / join link).
--
-- Record ownership: workpaper (Bedrock's internal production queue). The SENT
-- artifact (the email, the calendar invite) is the association/relationship
-- record; this row is the internal staging of it.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS tessa_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('email', 'meeting')),
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'cancelled', 'error')),
  title            text NOT NULL,                 -- short label for the card
  note             text,                          -- why / context shown to Ed

  -- email fields
  to_emails        text,                          -- comma/semicolon separated
  cc_emails        text,
  subject          text,
  body_text        text,
  attachment_path  text,                          -- storage path in the bucket below
  attachment_name  text,
  attachment_mime  text,
  attachment_bucket text DEFAULT 'documents',

  -- meeting fields (local wall time + explicit zone; never a bare date -- see the
  -- election-date scar in CLAUDE.md and lib/ea/tessa_meeting.js)
  organizer          text,                        -- mailbox the meeting belongs to
  meeting_start      text,                        -- 'YYYY-MM-DDTHH:MM:SS'
  meeting_end        text,
  meeting_time_zone  text,
  meeting_location   text,
  meeting_attendees  text,                        -- comma/semicolon separated

  -- outcome of the release
  result           jsonb,
  send_error       text,

  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_by      text,
  sent_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_tessa_outbox_status ON tessa_outbox (status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON tessa_outbox TO service_role;

COMMIT;
