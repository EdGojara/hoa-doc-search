-- Per-community logo asset.
-- ---------------------------------------------------------------------------
-- Board packets, violation letters, and other customer-facing artifacts
-- should be co-branded: Bedrock (managing agent) AND the Association's own
-- mark. Different communities have different logos — Lakes of Pine Forest,
-- Canyon Gate at Cinco Ranch, Waterview Estates each have their own.
--
-- The logo file lives in Supabase storage (path stored here, image bytes
-- live in the 'documents' bucket under community_assets/<id>/logo.<ext>).
-- Width + height are denormalized so the renderer can do aspect-ratio math
-- without re-decoding the image on every packet generation.

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS logo_storage_path   TEXT NULL,
  ADD COLUMN IF NOT EXISTS logo_mime_type      TEXT NULL,
  ADD COLUMN IF NOT EXISTS logo_width          INTEGER NULL,
  ADD COLUMN IF NOT EXISTS logo_height         INTEGER NULL,
  ADD COLUMN IF NOT EXISTS logo_uploaded_at    TIMESTAMPTZ NULL;
