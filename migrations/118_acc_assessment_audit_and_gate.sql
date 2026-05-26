-- ============================================================================
-- 118_acc_assessment_audit_and_gate.sql
-- ----------------------------------------------------------------------------
-- Two changes that make the ACC module launch-safe:
--
-- (A) acc_assessment_audit — forensic log of every AI assessment run.
--     Stores retrieval fingerprint (which chunks the model saw + their
--     community tags), validator results (Layer 2 cross-validators),
--     token usage, model stop_reason, and a contamination ratio. This
--     is the regression base — if a future change degrades retrieval
--     quality, the audit catches it on the next assessment, not after
--     a bad letter goes out.
--
-- (B) community_services.arc_ai_homeowner_visible — per-community gate
--     for whether the AI's assessment output is shown to the homeowner
--     in the submission receipt. Default FALSE. Even after launch the
--     homeowner gets a clean receipt ("draft appears complete, response
--     within 48 hours"). Manager queue still gets the full AI output
--     internally regardless of this flag. Per-community flip is a
--     deliberate admin action when each community is ready.
--
-- Record ownership:
--   acc_assessment_audit       = workpaper (Bedrock IP, AI internals)
--   arc_ai_homeowner_visible   = workpaper (Bedrock configuration)
--
-- Apply AFTER 117. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- (A) acc_assessment_audit
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acc_assessment_audit (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                  UUID NOT NULL REFERENCES community_applications(id) ON DELETE CASCADE,
  community_id                    UUID NOT NULL REFERENCES communities(id),

  -- When the assessment ran
  ran_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger_source                  TEXT,                     -- 'public_submit' | 'manager_reassess' | 'gold_standard_test'

  -- Retrieval fingerprint — the chunks the model saw
  -- Each entry: { filename, community, sources: [vector|keyword|title] }
  retrieved_chunks                JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieved_chunk_count           INTEGER NOT NULL DEFAULT 0,
  contamination_ratio             NUMERIC(5,4),             -- 0.0000 - 1.0000; fraction of chunks NOT from target community AND NOT Law/General
  community_chunk_count           INTEGER NOT NULL DEFAULT 0,
  law_general_chunk_count         INTEGER NOT NULL DEFAULT 0,

  -- Model call telemetry
  ai_model                        TEXT,
  ai_input_tokens                 INTEGER,
  ai_output_tokens                INTEGER,
  ai_max_tokens                   INTEGER,
  ai_stop_reason                  TEXT,                     -- 'end_turn' | 'max_tokens' | 'stop_sequence' | other
  ai_duration_ms                  INTEGER,

  -- Pre-flight guard outcomes (Layer 1)
  guards_fired                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Examples of items in this array:
  --   { code: 'CCRS_MISSING', severity: 'block', detail: '...' }
  --   { code: 'LETTER_TRUNCATED', severity: 'block', detail: 'stop_reason=max_tokens' }
  --   { code: 'JSON_PARSE_FAILED', severity: 'block', detail: '...' }

  -- Cross-validator results (Layer 2)
  validators                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Example shape:
  --   {
  --     dimension_consistency: { ok: false, detail: 'analysis cites 280 sq ft; letter cites 240 sq ft' },
  --     length_sanity: { ok: true, word_count: 312 },
  --     decision_letter_agreement: { ok: true },
  --     citation_source: { ok: true, unmatched: [] }
  --   }
  validator_blockers              INTEGER NOT NULL DEFAULT 0,
  validator_warnings              INTEGER NOT NULL DEFAULT 0,

  -- Outcome
  final_status                    TEXT,                     -- 'shipped' | 'held_for_review' | 'failed'
  hold_reason                     TEXT,

  -- Optional links — easier debugging without joining
  prompt_hash                     TEXT,                     -- sha256 of the user message (for tracking prompt changes)
  response_excerpt                TEXT,                     -- first 600 chars of the model's response

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_acc_assessment_audit_app
  ON acc_assessment_audit(application_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_assessment_audit_community_ran
  ON acc_assessment_audit(community_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_assessment_audit_held
  ON acc_assessment_audit(final_status, ran_at DESC)
  WHERE final_status = 'held_for_review';
CREATE INDEX IF NOT EXISTS idx_acc_assessment_audit_contamination
  ON acc_assessment_audit(contamination_ratio DESC, ran_at DESC)
  WHERE contamination_ratio IS NOT NULL AND contamination_ratio > 0.2;

COMMENT ON TABLE acc_assessment_audit IS
  'Forensic log of every ACC AI assessment. Stores the retrieval fingerprint, validator results, and token telemetry needed to catch silent regressions. Workpaper (Bedrock IP).';

COMMENT ON COLUMN acc_assessment_audit.contamination_ratio IS
  'Fraction of retrieved chunks that came from a community OTHER than the target community (excluding Law/General reference chunks). >0.2 = retrieval bug likely.';

COMMENT ON COLUMN acc_assessment_audit.guards_fired IS
  'Layer 1 pre-flight blockers that fired. Each entry has code/severity/detail. Block severity = assessment held for review.';

COMMENT ON COLUMN acc_assessment_audit.validators IS
  'Layer 2 structural cross-validators (dimension consistency, length sanity, decision/letter agreement, citation source). Any blocker holds the assessment for manager review.';

-- ----------------------------------------------------------------------------
-- (B) community_services.arc_ai_homeowner_visible
-- ----------------------------------------------------------------------------
ALTER TABLE community_services
  ADD COLUMN IF NOT EXISTS arc_ai_homeowner_visible BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN community_services.arc_ai_homeowner_visible IS
  'Whether the AI assessment output is shown to the homeowner in the submission receipt. Default FALSE — homeowner sees only a clean receipt + 48hr SLA. Manager queue always gets the full AI output regardless. Flip per-community when ready.';

-- Backfill nothing — DEFAULT FALSE applies to all existing rows.

COMMIT;
