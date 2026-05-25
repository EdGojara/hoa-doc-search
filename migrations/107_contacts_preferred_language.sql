-- ============================================================================
-- 107_contacts_preferred_language.sql
-- ----------------------------------------------------------------------------
-- Adds a preferred_language column to contacts so the Vapi assistant-request
-- webhook can route Spanish-speaking callers to Isabella (Spanish AI persona)
-- and English-speaking callers to Claire (English AI persona) automatically.
--
-- Defaults to NULL (unknown). NULL = treat as English (Claire is the default
-- persona, which is correct for the existing English-only book; opt-in to
-- Spanish per-contact).
--
-- ISO 639-1 two-letter codes, optionally with a region (e.g. 'es-MX', 'es-US'
-- if we ever need that granularity; for now plain 'es' / 'en' / etc.).
--
-- Lightweight CHECK constraint that allows the languages we have personas for
-- today (en, es) plus future planned (zh for Mandarin Mei, vi for Vietnamese
-- Linh, ko for Korean Jin-Soo per project_multilingual_voice_architecture.md).
-- Anything else gets rejected — keeps the data clean and forces a deliberate
-- migration when we add a new persona.
--
-- Backfill / UI: nothing automated. Bedrock staff will set preferred_language
-- per contact via the Owner / Contact admin UI as they learn caller preference
-- from real calls. Could also bulk-import from a community demographic
-- worksheet if a board provides one.
--
-- record_ownership note: contacts is association_record. Adding a column to
-- an association_record table doesn't change the ownership bucket — every
-- value is still part of the community's record. Preferred-language is
-- arguably useful info to hand back on termination (next manager would want
-- to know which households prefer Spanish).
-- ============================================================================

BEGIN;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS preferred_language TEXT;

-- Allowed values — current personas plus planned. Update when we ship a new
-- persona (Mei / Linh / Jin-Soo).
ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_preferred_language_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_preferred_language_check
  CHECK (preferred_language IS NULL OR preferred_language IN ('en', 'es', 'zh', 'vi', 'ko'));

-- Index on (preferred_language) is overkill for current volume — keep the
-- table lean. Voice assistant-request reads preferred_language via the
-- primary key path (contacts.id from caller_lookup), not via a scan, so no
-- index needed. Re-evaluate if we ever build a "language-preference
-- dashboard" that scans by language.

COMMENT ON COLUMN contacts.preferred_language IS
  'ISO 639-1 language code. NULL = unknown/default (Claire English). '
  'Used by /api/voice/vapi-assistant-request to route Spanish-speaking '
  'callers to Isabella (and future Mei/Linh/Jin-Soo). Set per-contact via '
  'admin UI as we learn from real calls.';

COMMIT;
