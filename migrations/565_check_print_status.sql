-- 565: Check print status + print audit log (Ed 2026-11-17)
--
-- WHY: a check that printed wrong (contents ran onto the next check) could not be
-- printed again: the reprint was locked the day after the run, and nothing recorded
-- whether a check ever came out of the printer. Generating a PDF is not the same as
-- a check that printed correctly, so the register now records that separately and
-- staff confirm it.
--
--   check_register.print_status
--     'pdf_generated'  the check PDF was produced; nobody has confirmed a good print
--                      (the default, and what every existing check starts as)
--     'printed'        staff confirmed the check printed correctly
--     'print_failed'   staff recorded a failed or misaligned print
--   A reprint keeps the ORIGINAL check number, payee, amount, date, payment and GL
--   entry; it only renders the same check again. reprinted_count already exists.
--
--   check_print_events: append-only log of every PDF generated, reprint, and
--   print confirmation or failure, with who and when.
--
-- Record ownership: association_record (part of the disbursement audit trail).
-- No change to any check, payment, invoice or journal entry row.

BEGIN;

ALTER TABLE check_register ADD COLUMN IF NOT EXISTS print_status TEXT NOT NULL DEFAULT 'pdf_generated'
  CONSTRAINT check_register_print_status_check CHECK (print_status IN ('pdf_generated', 'printed', 'print_failed'));
ALTER TABLE check_register ADD COLUMN IF NOT EXISTS print_confirmed_at TIMESTAMPTZ;
ALTER TABLE check_register ADD COLUMN IF NOT EXISTS print_confirmed_by_user_id UUID;
ALTER TABLE check_register ADD COLUMN IF NOT EXISTS last_pdf_generated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS check_print_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_register_id   UUID NOT NULL REFERENCES check_register(id) ON DELETE RESTRICT,
  community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  event               TEXT NOT NULL CONSTRAINT check_print_events_event_check
                        CHECK (event IN ('pdf_generated', 'reprint_generated', 'print_confirmed', 'print_failed')),
  print_status_before TEXT,
  print_status_after  TEXT,
  reason              TEXT,
  actor_user_id       UUID,
  actor_name          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_check_print_events_check ON check_print_events (check_register_id, created_at DESC);

GRANT SELECT, INSERT ON check_print_events TO service_role;
GRANT SELECT ON check_print_events TO authenticated;

COMMIT;
