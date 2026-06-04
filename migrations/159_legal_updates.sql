-- 159_legal_updates.sql
--
-- Legal Updates layer for trustEd. Ed 2026-06-04 directive: ingest legal
-- guidance / case law / agency rulings so they feed into askEd's legal
-- lens. NOT legal advice — augments the existing statute (§209) chunks
-- with current interpretation/guidance from authoritative sources like
-- RMWBH, HUD enforcement notices, Texas AG opinions, TX Supreme Court
-- opinions.
--
-- Record ownership per CLAUDE.md:
--   - Sidecar metadata (this table): workpaper — Bedrock IP. The curated
--     taxonomy + structured extraction + supersedes-chain is the encoded
--     legal-lens knowledge layer.
--   - Source PDFs (library_documents): mixed. Source articles are
--     publicly available materials; our extraction + curation is workpaper.
--
-- Architecture:
--   - library_documents holds the PDF + standard chunks (no new vector
--     silo per CLAUDE.md). Category = 'legal_update'. Community = 'Law'
--     so retrieval includes them cross-community.
--   - legal_updates is a 1:1 sidecar joined to library_documents with
--     the structured metadata: source publisher, dates, jurisdiction,
--     topics, key holding, supersedes chain, status.
--   - Triggers auto-mark older entries as 'superseded' when a newer one
--     references them via supersedes_id. Keeps "what's current" queries
--     O(1) without callers walking the chain.

BEGIN;

CREATE TABLE IF NOT EXISTS legal_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_document_id uuid NOT NULL UNIQUE REFERENCES library_documents(id) ON DELETE CASCADE,

  -- Source identification
  source_publisher text NOT NULL,           -- "RMWBH Law", "HUD Office of Fair Housing", "Texas AG"
  source_url text,                          -- if uploaded from URL or has canonical source
  source_date date NOT NULL,                -- when published
  effective_date date,                      -- when the rule/guidance takes effect (often same as source_date)

  -- Categorization
  jurisdiction text[] NOT NULL DEFAULT '{}', -- ['federal'] | ['texas'] | ['fort_bend_county'] | combinations
  topics text[] NOT NULL DEFAULT '{}',       -- ['esa','fair_housing'] etc. — controlled vocabulary in JS

  -- Substance
  key_holding text NOT NULL,                -- 1-2 sentence quotable summary the model can cite
  key_quote text,                            -- direct quote from doc capturing the rule (optional)

  -- Lifecycle
  supersedes_id uuid REFERENCES legal_updates(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'current'
    CHECK (status IN ('current', 'superseded', 'historical')),

  -- Audit / debug
  ai_extracted jsonb NOT NULL DEFAULT '{}'::jsonb,  -- raw AI extraction for diagnosis
  reviewed_by text,                                  -- email of operator who confirmed metadata
  reviewed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes: filter by status (current is the hot path), sort by date,
-- GIN on text[] for topic/jurisdiction tag queries, FK lookups.
CREATE INDEX IF NOT EXISTS idx_legal_updates_status ON legal_updates(status);
CREATE INDEX IF NOT EXISTS idx_legal_updates_source_date ON legal_updates(source_date DESC);
CREATE INDEX IF NOT EXISTS idx_legal_updates_topics ON legal_updates USING GIN(topics);
CREATE INDEX IF NOT EXISTS idx_legal_updates_jurisdiction ON legal_updates USING GIN(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_legal_updates_library_doc ON legal_updates(library_document_id);
CREATE INDEX IF NOT EXISTS idx_legal_updates_supersedes ON legal_updates(supersedes_id);

-- Standard updated_at trigger using the canonical helper.
DROP TRIGGER IF EXISTS trg_legal_updates_updated_at ON legal_updates;
CREATE TRIGGER trg_legal_updates_updated_at
  BEFORE UPDATE ON legal_updates
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Supersedes-chain handler: when a new legal_update inserts (or one is
-- updated) referencing a prior entry via supersedes_id, automatically
-- mark that prior entry as 'superseded'. This keeps the "what's current"
-- filter (status='current') accurate without callers needing to walk the
-- chain. Manual override is still possible — an operator can flip the
-- status back via PATCH and the trigger will not re-flip.
CREATE OR REPLACE FUNCTION trusted_legal_supersede_handler() RETURNS trigger AS $$
BEGIN
  IF NEW.supersedes_id IS NOT NULL
     AND NEW.status = 'current'
     AND (TG_OP = 'INSERT' OR OLD.supersedes_id IS DISTINCT FROM NEW.supersedes_id)
  THEN
    UPDATE legal_updates
       SET status = 'superseded', updated_at = now()
     WHERE id = NEW.supersedes_id
       AND status = 'current';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_updates_supersede ON legal_updates;
CREATE TRIGGER trg_legal_updates_supersede
  AFTER INSERT OR UPDATE OF supersedes_id, status ON legal_updates
  FOR EACH ROW EXECUTE FUNCTION trusted_legal_supersede_handler();

-- Grants — service_role writes from the server, authenticated reads
-- from staff surfaces in the UI.
GRANT SELECT, INSERT, UPDATE, DELETE ON legal_updates TO service_role;
GRANT SELECT ON legal_updates TO authenticated;

COMMIT;
