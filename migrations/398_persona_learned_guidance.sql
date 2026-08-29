-- ============================================================================
-- 398_persona_learned_guidance.sql  (Ed 2026-08-29)
-- ----------------------------------------------------------------------------
-- The encode-Ed loop's memory. Ed grades shadow drafts against his bar; his
-- corrections (ed_note + ed_rewrite on shadow_drafts) are distilled into a short
-- set of PRINCIPLES in his voice, which Ed approves and which then get injected
-- into that persona's system prompt so future drafts already follow them.
--
-- One standing approved block per persona (upserted on approve). This is the
-- durable behavior change grading produces — the difference between "Ed fixed
-- one email" and "the persona learned how Ed handles this."
--
-- record_ownership = 'workpaper': Bedrock's encoded judgment (encode-Ed IP).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS persona_learned_guidance (
  persona          text PRIMARY KEY,
  guidance         text NOT NULL DEFAULT '',
  source_count     integer NOT NULL DEFAULT 0,   -- how many corrections it was distilled from
  status           text NOT NULL DEFAULT 'approved',
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  record_ownership text NOT NULL DEFAULT 'workpaper'
);

GRANT SELECT, INSERT, UPDATE, DELETE ON persona_learned_guidance TO service_role;
GRANT SELECT                          ON persona_learned_guidance TO authenticated;

COMMIT;
