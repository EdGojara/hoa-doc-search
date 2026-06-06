-- 178: Per-community letter copy overrides
--
-- Lets each community customize the editable copy blocks in violation letters
-- (title, opening paragraph, closing paragraph) without touching the renderer.
-- Statutory blocks (§209 cure language, hearing-request, SCRA, postmark
-- anchor, fee disclosure, §209.0064 fine-schedule reference) stay hard-locked
-- in code — those carry catastrophic-output risk and need engineering +
-- counsel review to change.
--
-- Record ownership: workpaper. These overrides are Bedrock's drafting
-- configuration. The rendered letter that gets mailed becomes an
-- association_record (mixed-bucket — sent artifact is theirs, the override
-- config that produced it is ours).
--
-- Placeholder substitution happens at render time:
--   {{community_name}}       — community.name
--   {{community_legal_name}} — community.legal_name
--   {{cure_days}}            — derived from community.letter_cure_days_*
--   {{cure_by_date}}         — letter_date + cure_days, long format
--   {{property_address}}     — property.street_address
--   {{category_label}}       — primary violation category
--   {{phone}}                — Bedrock contact phone
--   {{email}}                — Bedrock contact email
--   {{owner_salutation}}     — derived "Dear Mr. Smith" etc.

BEGIN;

CREATE TABLE IF NOT EXISTS letter_copy_overrides (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  stage             TEXT NOT NULL
                      CHECK (stage IN ('courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed')),
  block_key         TEXT NOT NULL
                      CHECK (block_key IN ('title', 'opening_paragraph', 'closing_paragraph')),
  body              TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID,
  updated_by_name   TEXT,
  UNIQUE (community_id, stage, block_key)
);

CREATE INDEX IF NOT EXISTS idx_letter_copy_overrides_lookup
  ON letter_copy_overrides (community_id, stage);

DROP TRIGGER IF EXISTS trg_letter_copy_overrides_updated_at ON letter_copy_overrides;
CREATE TRIGGER trg_letter_copy_overrides_updated_at
  BEFORE UPDATE ON letter_copy_overrides
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMIT;
