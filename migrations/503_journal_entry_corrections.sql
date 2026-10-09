-- ===========================================================================
-- 503_journal_entry_corrections.sql  (Ed 2026-10-09)
-- ---------------------------------------------------------------------------
-- A posted journal entry is permanent. When an application workflow corrects a
-- posted entry (an AP invoice re-code, a line re-code, a prior-period hold), it
-- posts a correcting entry (a reversal of the live entry, linked by
-- reverses_je_id) and, where the workflow re-posts, a replacement. This table
-- records that link as DATA: which invoice, which original entry, which entry
-- was actually reversed, the correcting entry, the replacement, who, when, why.
--
-- Scar: 2026-09-28/29, Lakes of Pine Forest. Re-coding four unpaid Barker
-- Cypress MUD bills deleted the lines of posted accruals JE-2026-00169..00172;
-- the header delete was refused by a foreign key and nothing noticed. The code
-- now never deletes (lib/accounting/correct_entry.js), and every correction is
-- recorded here. This migration repairs nothing; the four LOPF entries are
-- untouched.
--
-- corrected_je_id differs from original_je_id when a conversion neutralized
-- the original and re-posted it (CONV-*-REPOST-*): the re-post was the live
-- entry, so it is what the correcting entry reverses. correcting_je_id is NULL
-- only when nothing was live to reverse (the original was already fully
-- reversed); a row always names a correcting entry or a replacement.
--
-- Append-only: a guard trigger refuses UPDATE and DELETE.
-- Touches no existing table, no trigger on journal_entries or
-- journal_entry_lines (those belong to migration 502's period lock).
-- Record ownership: association_record (part of the association's books).
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS journal_entry_corrections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      uuid NOT NULL,
  invoice_id        uuid,
  original_je_id    uuid NOT NULL,
  corrected_je_id   uuid NOT NULL,
  correcting_je_id  uuid,
  replacement_je_id uuid,
  kind              text NOT NULL,
  actor_user_id     uuid,
  actor_name        text NOT NULL,
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entry_corrections_community_fk   FOREIGN KEY (community_id)      REFERENCES communities(id)     ON DELETE RESTRICT,
  CONSTRAINT journal_entry_corrections_invoice_fk     FOREIGN KEY (invoice_id)        REFERENCES ap_invoices(id)     ON DELETE RESTRICT,
  CONSTRAINT journal_entry_corrections_original_fk    FOREIGN KEY (original_je_id)    REFERENCES journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT journal_entry_corrections_corrected_fk   FOREIGN KEY (corrected_je_id)   REFERENCES journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT journal_entry_corrections_correcting_fk  FOREIGN KEY (correcting_je_id)  REFERENCES journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT journal_entry_corrections_replacement_fk FOREIGN KEY (replacement_je_id) REFERENCES journal_entries(id) ON DELETE RESTRICT,
  CONSTRAINT journal_entry_corrections_kind_check CHECK (kind IN ('ap_recode', 'ap_line_recode', 'ap_hold_prior_periods')),
  CONSTRAINT journal_entry_corrections_entries_check CHECK (correcting_je_id IS NOT NULL OR replacement_je_id IS NOT NULL),
  CONSTRAINT journal_entry_corrections_reason_check CHECK (length(btrim(reason)) > 0),
  CONSTRAINT journal_entry_corrections_actor_check CHECK (length(btrim(actor_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entry_corrections_correcting
  ON journal_entry_corrections (correcting_je_id) WHERE correcting_je_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entry_corrections_invoice  ON journal_entry_corrections (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entry_corrections_original ON journal_entry_corrections (original_je_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_corrections_community ON journal_entry_corrections (community_id, created_at);

COMMENT ON TABLE journal_entry_corrections IS 'association_record: one row per correction of a posted journal entry by an application workflow (invoice, original entry, entry reversed, correcting entry, replacement, actor, time, reason). Append-only (migration 503).';

CREATE OR REPLACE FUNCTION journal_entry_corrections_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'journal_entry_corrections is append-only: a correction record is never changed or deleted';
END;
$fn$;
DROP TRIGGER IF EXISTS trg_journal_entry_corrections_append_only ON journal_entry_corrections;
CREATE TRIGGER trg_journal_entry_corrections_append_only BEFORE UPDATE OR DELETE ON journal_entry_corrections
  FOR EACH ROW EXECUTE FUNCTION journal_entry_corrections_append_only();

GRANT SELECT, INSERT ON journal_entry_corrections TO service_role;
GRANT SELECT         ON journal_entry_corrections TO authenticated;

COMMIT;
