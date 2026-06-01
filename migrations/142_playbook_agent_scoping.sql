-- ============================================================================
-- 142_playbook_agent_scoping.sql
-- ----------------------------------------------------------------------------
-- Adds agent scoping to the unified `playbook` table so a single entry can
-- be marked as applying to:
--   - both Claire (voice) and askEd (staff chat)  → universal
--   - Claire only                                 → homeowner-voice rule
--   - askEd only                                  → staff-chat rule
--
-- Today every playbook entry implicitly applies to both surfaces because
-- both call getRelevantPlaybook() with no agent filter. That's the right
-- default — most corrections are universal (refusal triggers, escalation
-- rules, factual accuracy). But some are persona-specific:
--   - "Never quote §209 statutory citations to a homeowner" → claire only
--   - "Always include the citation when answering staff"     → asked only
--
-- The training console (next ship) needs a way to write entries scoped to
-- one agent without affecting the other. This column is the mechanism.
--
-- Also adds training_context columns so the console can preserve the FULL
-- dialogue that produced an entry — helps future operators understand WHY
-- the rule exists (Bus-factor: someone reading the entry 2 years from
-- now needs to know what call/email triggered this correction).
--
-- Record ownership (CLAUDE.md): workpaper bucket. The playbook is
-- Bedrock's institutional intelligence — not transferable on termination.
-- Tagged in the migration comment + read-only access for non-admin staff.
--
-- Apply after 141. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE playbook
  -- Default to universal: every existing entry applies to both agents.
  -- Going forward, the training console sets this explicitly based on
  -- which persona Ed was correcting when he saved the entry.
  ADD COLUMN IF NOT EXISTS applies_to TEXT[] NOT NULL DEFAULT ARRAY['claire', 'asked']::TEXT[],
  -- Training console captures the dialogue that produced this entry,
  -- so the operator who reads it later understands the context.
  ADD COLUMN IF NOT EXISTS training_dialogue TEXT,
  ADD COLUMN IF NOT EXISTS training_correction_target TEXT,  -- what response was wrong
  ADD COLUMN IF NOT EXISTS training_correction_expected TEXT, -- what response should have been
  -- Free-form admin note (e.g. "found this gap when Mrs. Hodges called 2026-05-31").
  ADD COLUMN IF NOT EXISTS training_notes TEXT;

COMMENT ON COLUMN playbook.applies_to IS
  'Array of agent personas this entry affects. Allowed values: claire (voice/homeowner), asked (staff/chat). Default both (universal). Entries with one element apply only to that agent.';

COMMENT ON COLUMN playbook.training_dialogue IS
  'JSONB-serializable text capturing the full dialogue that triggered this entry. Lets future operators understand WHY the rule exists when reading it years later.';

COMMENT ON COLUMN playbook.training_correction_target IS
  'The AI response that was wrong (the answer the operator corrected).';

COMMENT ON COLUMN playbook.training_correction_expected IS
  'What the AI should have said instead. This becomes the few-shot example.';

-- Helpful index for the per-agent filter query when retrieval needs to
-- limit by agent. The GIN index on the text array is fast for ANY/ALL ops.
CREATE INDEX IF NOT EXISTS idx_playbook_applies_to
  ON playbook USING GIN (applies_to);

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- -- Existing entries default to universal:
-- SELECT COUNT(*), applies_to FROM playbook GROUP BY applies_to;
-- -- (Expect every row to show ['claire','asked'] after this migration.)
--
-- -- Entries that apply ONLY to Claire (created by training console):
-- SELECT id, situation, applies_to FROM playbook
-- WHERE 'claire' = ANY(applies_to) AND NOT ('asked' = ANY(applies_to));
