-- Photo pairing — wide-shot + close-up flow for inspection captures.
-- ---------------------------------------------------------------------------
-- Defensible enforcement requires both: a wide shot that establishes which
-- house the violation is at (the wrong-house insurance) AND a close-up of
-- the actual issue (the evidence). This migration adds the structure to
-- pair them so the system can render both in the violation letter and the
-- evidence panel.
--
-- photo_role values:
--   'wide'     — identifying shot, captures address + house features
--   'close_up' — issue evidence, linked back to a wide via paired_wide_photo_id
--   'single'   — backward-compat for unpaired shots (legacy + quick captures)

ALTER TABLE inspection_photos
  ADD COLUMN IF NOT EXISTS photo_role TEXT NULL
    CHECK (photo_role IS NULL OR photo_role IN ('wide', 'close_up', 'single')),
  ADD COLUMN IF NOT EXISTS paired_wide_photo_id UUID NULL
    REFERENCES inspection_photos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inspection_photos_paired_wide
  ON inspection_photos(paired_wide_photo_id)
  WHERE paired_wide_photo_id IS NOT NULL;

-- Sanity constraint: a wide shot cannot itself be paired to another wide.
-- (close_up and single can have paired_wide_photo_id; wide cannot.)
ALTER TABLE inspection_photos
  DROP CONSTRAINT IF EXISTS chk_inspection_photo_pairing;

ALTER TABLE inspection_photos
  ADD CONSTRAINT chk_inspection_photo_pairing
  CHECK (
    photo_role IS DISTINCT FROM 'wide'
    OR paired_wide_photo_id IS NULL
  );
