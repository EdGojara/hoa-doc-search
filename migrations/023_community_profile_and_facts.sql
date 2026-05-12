-- ============================================================================
-- 023_community_profile_and_facts.sql
-- ----------------------------------------------------------------------------
-- Adds two layers of community-specific operational knowledge:
--
-- 1. communities.profile  (JSONB)
--      Structured fields that change rarely and need exact recall:
--      office hours, contact info, fiscal year end, assessment rate,
--      amenities list, banking info, insurance carrier, etc.
--      Edited via "Community Profile" admin page; injected into every
--      askEd prompt for that community so answers cite correct facts.
--
-- 2. community_facts  (TABLE)
--      Free-form key/value facts with expiration tracking. Each row:
--        - category   ('pool', 'vendor', 'parking', 'amenities', ...)
--        - key        ('pool_hours_2026', 'current_landscaper', ...)
--        - label      ('Pool Hours — 2026 Season')
--        - value      (the answer/text the user sees)
--        - details    (rich JSONB payload — contact, phone, email, etc.)
--        - source_type ('manual' | 'pulled_from')
--          'pulled_from' rows are computed at read-time from another table
--          (e.g. vendor_contracts), with optional manual override.
--        - expires_at  (nullable; flips needs_review when past)
--        - embedding   (vector(1536) — semantic retrieval inside askEd)
--
-- Why two layers:
--   Profile = small, known fields, edited via a structured form.
--   Facts  = unbounded, ad-hoc, with expiration. Pool hours change every
--            season. Landscaper changes when contract renews. The form
--            for "everything else" must not require a schema migration.
--
-- Apply AFTER 022. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. communities.profile — structured profile JSONB
-- ----------------------------------------------------------------------------

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN communities.profile IS
  'Structured per-community facts edited via admin UI: office_hours, primary_contact, assessment_annual, assessment_frequency, fiscal_year_end, amenities, banking, insurance, etc. Injected into askEd prompts.';

-- ----------------------------------------------------------------------------
-- 2. community_facts — free-form facts with expiration + embeddings
-- ----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS community_facts (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  -- Categorization & lookup
  category             TEXT,                                -- 'pool', 'parking', 'vendor', 'amenities', 'office', 'rules', ...
  key                  TEXT NOT NULL,                       -- short stable slug, e.g. 'pool_hours_2026'
  label                TEXT,                                -- human-friendly heading
  value                TEXT NOT NULL,                       -- the actual answer / fact text
  details              JSONB,                               -- richer payload (phone, email, contract_id, etc.)

  -- Provenance — manual vs auto-pulled from another table
  source_type          TEXT NOT NULL DEFAULT 'manual'
                         CHECK (source_type IN ('manual', 'pulled_from')),
  source_ref           TEXT,                                -- e.g. 'vendor_contracts:UUID', 'invoices_received:UUID'
  manual_override      BOOLEAN NOT NULL DEFAULT FALSE,      -- TRUE if this fact was auto-pulled but staff edited it

  -- Freshness / staleness
  last_updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_by      UUID,
  expires_at           TIMESTAMPTZ,                         -- nullable; if set + past, needs_review flips on next read
  needs_review         BOOLEAN NOT NULL DEFAULT FALSE,
  review_note          TEXT,                                -- optional reminder ('check pool hours each April')

  -- Semantic retrieval — embeds (label + ' ' + value) for askEd matching
  embedding            VECTOR(1536),

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (community_id, key)
);

CREATE INDEX IF NOT EXISTS idx_community_facts_community
  ON community_facts(community_id);
CREATE INDEX IF NOT EXISTS idx_community_facts_category
  ON community_facts(community_id, category);
CREATE INDEX IF NOT EXISTS idx_community_facts_expires
  ON community_facts(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_facts_embedding
  ON community_facts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- Auto-flip needs_review when expires_at passes. Cheap: triggered on SELECT
-- via a view (or computed at API layer). We expose a tiny helper view too.

CREATE OR REPLACE VIEW v_community_facts AS
SELECT
  cf.*,
  (cf.expires_at IS NOT NULL AND cf.expires_at < NOW()) AS is_expired,
  EXTRACT(EPOCH FROM (NOW() - cf.last_updated_at))::int AS age_seconds
FROM community_facts cf;

COMMENT ON VIEW v_community_facts IS
  'Same as community_facts but with computed is_expired flag and age_seconds. Use this in API reads so callers always know freshness.';

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_community_facts_updated_at ON community_facts;
CREATE TRIGGER trg_community_facts_updated_at
  BEFORE UPDATE ON community_facts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. RPC: semantic match against community_facts (mirrors match_playbook)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_community_facts(
  query_embedding   VECTOR(1536),
  community_id_in   UUID,
  match_count       INT DEFAULT 8,
  similarity_threshold FLOAT DEFAULT 0.0
)
RETURNS TABLE (
  id            UUID,
  key           TEXT,
  label         TEXT,
  value         TEXT,
  details       JSONB,
  category      TEXT,
  last_updated_at TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  is_expired    BOOLEAN,
  similarity    FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT
    cf.id,
    cf.key,
    cf.label,
    cf.value,
    cf.details,
    cf.category,
    cf.last_updated_at,
    cf.expires_at,
    (cf.expires_at IS NOT NULL AND cf.expires_at < NOW()) AS is_expired,
    1 - (cf.embedding <=> query_embedding) AS similarity
  FROM community_facts cf
  WHERE cf.community_id = community_id_in
    AND cf.embedding IS NOT NULL
    AND (1 - (cf.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY cf.embedding <=> query_embedding
  LIMIT match_count;
$$;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verify:
--   SELECT id, name, profile FROM communities LIMIT 3;
--   SELECT category, key, label, is_expired FROM v_community_facts LIMIT 10;
-- ----------------------------------------------------------------------------
