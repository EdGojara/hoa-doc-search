-- ============================================================================
-- 444 — ap_invoice_lines.project_id (line-level project/location attribution)
-- ----------------------------------------------------------------------------
-- The operating map needs actual spend attributed to a project (and, via
-- vendor_projects.asset_id, to an asset/location). The architecture trace found
-- AP has no project dimension: ap_invoice_lines carries gl_account_id + amount
-- but no project_id, and journal_entry_lines only has a deferred comment
-- (170:274). Vendor-scoped invoice totals are NOT project spend.
--
-- The attribution belongs at the LINE, not the invoice header: one AP invoice
-- may contain charges for more than one project/location. Each line already
-- carries its GL account; this adds an OPTIONAL project dimension on the same
-- line. GL attribution is unchanged — project attribution is an additional
-- operational dimension, not a replacement for the general ledger.
--
--   AP invoice → line (gl_account_id + project_id) → vendor_projects.asset_id
--   → community_assets (→ parent_asset_id). A line is counted once, so
--   parent/child rollups never double-count the underlying transaction.
--
-- Additive + nullable. No committed/encumbrance accounting (deferred). The
-- invoiced-vs-paid distinction stays where it already lives: ap_invoices.status
-- + amount_paid_cents (header). Record ownership unchanged (per migration 177).
-- ============================================================================
BEGIN;

ALTER TABLE ap_invoice_lines
  ADD COLUMN IF NOT EXISTS project_id UUID NULL REFERENCES vendor_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ap_invoice_lines_project
  ON ap_invoice_lines (project_id) WHERE project_id IS NOT NULL;

COMMENT ON COLUMN ap_invoice_lines.project_id IS
  'Optional project attribution for this expense line (→ vendor_projects). Additional operational dimension on top of gl_account_id, never a replacement for GL. Asset/location derives via vendor_projects.asset_id. One line = one transaction, so parent/child asset rollups do not double-count.';

COMMIT;
