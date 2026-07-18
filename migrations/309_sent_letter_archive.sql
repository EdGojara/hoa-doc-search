BEGIN;

-- ============================================================================
-- 309_sent_letter_archive.sql  (Ed 2026-07-18)
-- ----------------------------------------------------------------------------
-- THE LOCKED RECORD OF WHAT WAS MAILED.
--
-- Defect this fixes: sent §209/courtesy letters lived only in the MUTABLE
-- `violation-letters` storage bucket, alongside working drafts. Files there get
-- overwritten (draft re-renders), deleted (rejected drafts), or orphaned
-- (postmark re-locks). Result: no guarantee the PDF a "sent" letter points at is
-- the exact document that was mailed — and 4 Still Creek sent letters were found
-- with their PDF already gone. For a Texas §209 system that is indefensible: the
-- whole point of the record is "here is the exact notice postmarked that day, and
-- here is proof it has not changed."
--
-- The fix: at send time, a write-once copy of the exact PDF is sealed into the
-- separate `sent-letters-archive` bucket, and its SHA-256 is recorded HERE. This
-- table is append-only (INSERT/SELECT grants only — no UPDATE/DELETE) so the hash
-- ledger itself is tamper-evident. The served "view sent letter" reads from the
-- archive and can be verified against the hash.
--
-- Record ownership: association_record — correspondence sent on behalf of the
-- Association; must be exported and handed over on termination. Single-class
-- table, documented here (no per-row record_ownership column needed).
-- ============================================================================

CREATE TABLE IF NOT EXISTS sent_letter_archive (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
  violation_id   UUID REFERENCES violations(id)   ON DELETE SET NULL,
  community_id   UUID REFERENCES communities(id)  ON DELETE SET NULL,
  property_id    UUID,
  letter_type    TEXT,
  sent_at        TIMESTAMPTZ,
  postmark_date  DATE,
  archive_path   TEXT NOT NULL,       -- path in the write-once sent-letters-archive bucket
  source_path    TEXT,                -- the working-bucket path it was copied from (provenance)
  sha256         TEXT NOT NULL,       -- integrity proof of the exact bytes mailed
  bytes          INTEGER,
  sealed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (archive_path)
);

CREATE INDEX IF NOT EXISTS idx_sent_letter_archive_interaction ON sent_letter_archive (interaction_id);
CREATE INDEX IF NOT EXISTS idx_sent_letter_archive_violation   ON sent_letter_archive (violation_id);
CREATE INDEX IF NOT EXISTS idx_sent_letter_archive_community   ON sent_letter_archive (community_id);

-- Append-only by grant: service_role may SELECT + INSERT, never UPDATE/DELETE.
-- authenticated may read (the audit/evidence view). This makes the ledger
-- tamper-evident at the privilege layer, not just by convention.
GRANT SELECT, INSERT ON sent_letter_archive TO service_role;
GRANT SELECT          ON sent_letter_archive TO authenticated;

COMMIT;
