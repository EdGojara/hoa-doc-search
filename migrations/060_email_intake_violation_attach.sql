-- Owner-reply intake → violation timeline linkage
-- ---------------------------------------------------------------------------
-- When a homeowner email is about an open violation, the operator attaches
-- the intake to that violation. The attachment:
--   - inserts an interactions row (the single source of truth for the DRV
--     timeline) with violation_id + property_id set
--   - sets attached_violation_id / attached_interaction_id on email_intake
--     so the intake list shows the link badge
--
-- The intake stays in the intake list as the source artifact. The interaction
-- row is what appears on the DRV timeline + property detail history.

ALTER TABLE email_intake
  ADD COLUMN IF NOT EXISTS attached_violation_id   UUID NULL
    REFERENCES violations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attached_interaction_id UUID NULL
    REFERENCES interactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attached_property_id    UUID NULL
    REFERENCES properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attached_at             TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS attached_by_user_id     UUID NULL;

CREATE INDEX IF NOT EXISTS idx_email_intake_attached_violation
  ON email_intake(attached_violation_id)
  WHERE attached_violation_id IS NOT NULL;
