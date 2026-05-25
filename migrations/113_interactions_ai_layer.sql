-- ============================================================================
-- 113_interactions_ai_layer.sql
-- ----------------------------------------------------------------------------
-- Adds three capabilities to the existing interactions table (migration 050):
--
--   1. ai_classification (JSONB) — the system's read on each interaction
--      when it arrives. Populated by classify-on-insert pipeline. Shape:
--        {
--          "category": "billing_question" | "service_request" | "arc_request"
--                      | "general_inquiry" | "complaint" | "compliment" | ...,
--          "urgency": "low" | "normal" | "high" | "critical",
--          "lens_triggers": ["legal", "ccr", "financial", "homeowner_experience"],
--          "suggested_routing": "violations@" | "acc@" | "accounting@" | ...,
--          "classified_at": "2026-05-25T...",
--          "classified_by_model": "claude-sonnet-4-6"
--        }
--      Used for inbox triage + auto-routing + analytics.
--
--   2. reply_token (TEXT, UNIQUE) — routing token for inbound replies.
--      When we send an outbound interaction (DRV notice, broadcast, response),
--      we embed a token in the Reply-To address (reply+<token>@bedrocktx.com).
--      When the homeowner replies via email, the ingester reads the token
--      and threads the inbound reply back to the originating interaction
--      via parent_interaction_id + thread_id. Standard Linear/GitHub/Front
--      mechanic. Partial unique index — only enforced where present.
--
--   3. parent_interaction_id + thread_id — explicit threading. parent_id
--      points to the immediate predecessor (the email being replied to);
--      thread_id is the denormalized root id (set to the first interaction
--      in the thread, propagated to all descendants). Lets us walk
--      "give me the full thread for this DRV" as one indexed lookup
--      instead of recursive CTEs through parent chains.
--
-- interactions today (migration 050) already has: type, direction, subject,
-- content, delivery_method (enum incl. 'certified_mail' and 'portal' — the
-- dual-rail correspondence model uses this field directly), attachments,
-- status, ai_drafted boolean + ai_model, source/original_external_id,
-- embedding vector. This migration adds the three capabilities above on top.
--
-- Apply AFTER 112. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS ai_classification     JSONB NULL,
  ADD COLUMN IF NOT EXISTS reply_token           TEXT NULL,
  ADD COLUMN IF NOT EXISTS parent_interaction_id UUID NULL REFERENCES interactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS thread_id             UUID NULL;

-- reply_token is the routing key for inbound replies. Must be unique across
-- all interactions. Partial unique index — most rows don't have one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_reply_token
  ON interactions (reply_token)
  WHERE reply_token IS NOT NULL;

-- Thread walking — fast "all interactions in this thread" lookup.
CREATE INDEX IF NOT EXISTS idx_interactions_thread
  ON interactions (thread_id, sent_at NULLS LAST)
  WHERE thread_id IS NOT NULL;

-- Parent lookup (rare but indexed for occasional reverse walks).
CREATE INDEX IF NOT EXISTS idx_interactions_parent
  ON interactions (parent_interaction_id)
  WHERE parent_interaction_id IS NOT NULL;

-- AI classification queries — find recently classified interactions per
-- community (for triage dashboards + backfill detection).
CREATE INDEX IF NOT EXISTS idx_interactions_ai_classified_recent
  ON interactions (community_id, created_at DESC)
  WHERE ai_classification IS NOT NULL;

-- Find unclassified inbound interactions awaiting classification (backfill
-- + reprocessing).
CREATE INDEX IF NOT EXISTS idx_interactions_ai_unclassified_inbound
  ON interactions (community_id, created_at DESC)
  WHERE ai_classification IS NULL
    AND direction = 'inbound';

COMMIT;

-- Verify:
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_name = 'interactions'
--      AND column_name IN ('ai_classification','reply_token','parent_interaction_id','thread_id')
--    ORDER BY column_name;
--   -- 4 rows
