-- 179: Expand letter_copy_overrides to allow signature + footer blocks
--
-- Adds 'signature_block' and 'footer_note' to the block_key CHECK constraint
-- so the editor can let operators override the sign-off lines (Sincerely /
-- sender name / sender title / "Issued by Bedrock as managing agent") and
-- add a per-community optional footer note (preferred contact channel,
-- payment portal callouts, etc.) below the signature.
--
-- The page footer ("This community is professionally managed by Bedrock
-- Association Management, LLC" + contact line) stays code-driven — it's a
-- brand-disclosure footer that has nothing to do with letter copy and
-- should be uniform across all communities.

BEGIN;

ALTER TABLE letter_copy_overrides DROP CONSTRAINT IF EXISTS letter_copy_overrides_block_key_check;
ALTER TABLE letter_copy_overrides ADD CONSTRAINT letter_copy_overrides_block_key_check
  CHECK (block_key IN ('title', 'opening_paragraph', 'closing_paragraph', 'signature_block', 'footer_note'));

COMMIT;
