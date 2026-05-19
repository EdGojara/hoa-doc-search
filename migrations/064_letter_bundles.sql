-- Letter bundling — group multiple violations at the same property + stage
-- into a single mailed envelope.
-- ---------------------------------------------------------------------------
-- Mrs. Henderson's property has overgrown grass + faded trim + storage shed
-- — all opened in the same inspection at courtesy_1. Without bundling, that's
-- three separate letters in three envelopes hitting the same mailbox on the
-- same day. Empty-chair lens: this reads as harassment, regardless of intent.
-- Bundle-the-letter says: one envelope, three sections, one wide shot at top,
-- one admin fee. The homeowner gets a coherent communication; the audit trail
-- stays clean because each violation still has its own interactions row.
--
-- Design: bundle_id is a shared UUID across the N interactions in a bundle.
-- The bundle isn't a separate table — it's a convention. Letter PDF is
-- generated ONCE and referenced from each interaction's attachments. The
-- Drafts queue groups by bundle_id when rendering.
--
-- Backward compat: bundle_id is nullable. Pre-bundle interactions stay as
-- they are. New drafts get a bundle_id (which may be a singleton).

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS bundle_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_bundle
  ON interactions(bundle_id)
  WHERE bundle_id IS NOT NULL;

-- The fee a bundle carries (admin fee for the certified mailing, etc.).
-- Lives on each interaction in the bundle so the audit trail is consistent
-- per-row; in practice every row in a bundle carries the same value (set at
-- bundle creation from the community's letter_fee_* config).
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS letter_fee_cents INTEGER NULL;

-- Date stamping — the LEGAL mailing date that anchors cure-by + hearing-
-- request deadlines. Set at lock-and-mail time (operator action), not at
-- draft time. Tex. Prop. Code § 209.006(b)(2)(B) keys the 30-day hearing
-- window to "the date the notice was mailed to the owner" — this is that
-- date for the audit record. Distinct from sent_at which is the existing
-- timestamp; postmark_date is a DATE (not a timestamp) because the law
-- cares about calendar day, not time of day.
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS postmark_date DATE NULL;
