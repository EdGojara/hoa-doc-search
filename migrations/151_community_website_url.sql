-- 151_community_website_url.sql
-- Adds website_url to communities. Used by the Annual Meeting Notice
-- renderer to point homeowners at the public-facing community site for
-- full candidate biographies (the mailing version omits bios to cut
-- postage; the bios live on the online ballot and the community website).
--
-- Nullable on purpose — not every community has a site, and we'd rather
-- the renderer fall back to "available on the online ballot" than print
-- a dead link. Ed populates per community as URLs are confirmed.

ALTER TABLE communities ADD COLUMN IF NOT EXISTS website_url TEXT;

COMMENT ON COLUMN communities.website_url IS
  'Public-facing community website URL (homeowner-facing, not management portal). Used by Annual Meeting Notice and similar mailings to point owners at deeper content (candidate bios, etc.). Nullable — falls back to "online ballot" reference when absent.';
