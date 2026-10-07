-- ============================================================================
-- 493_billing_worksheet_drafts.sql  (Ed 2026-10-07)
-- ----------------------------------------------------------------------------
-- Bedrock Office Billing: SAVE PROGRESS on the community invoice worksheet.
--
-- Until now the worksheet (rates, quantities, amounts, removed categories)
-- lived only in the browser: close the tab and the work was gone. This table
-- holds ONE saved worksheet per community + invoice type + service month. It is
-- not an invoice: saving never generates, posts, finalizes or sends anything,
-- and it never touches association accounting. Generating still creates the
-- invoice from the operator's current values, exactly as before.
--
--   lines                    the worksheet lines as the operator left them
--   removed_pending_item_ids one-off charges the operator removed from THIS
--                            invoice (the charge itself stays staged)
--   revision                 bumped on every save; a save or generate based on
--                            an older revision is refused (no silent overwrite)
--   generated_invoice_id     the invoice this worksheet became, once generated
--
-- Record ownership: workpaper (Bedrock's internal billing preparation).
-- Reversible: DROP TABLE billing_worksheet_drafts.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS billing_worksheet_drafts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             uuid NOT NULL,
  invoice_type             text NOT NULL,
  service_period           text NOT NULL,
  lines                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  removed_pending_item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision                 integer NOT NULL DEFAULT 1,
  saved_at                 timestamptz NOT NULL DEFAULT now(),
  saved_by                 text,
  generated_invoice_id     uuid,
  generated_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_worksheet_drafts_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
  CONSTRAINT billing_worksheet_drafts_invoice_fk FOREIGN KEY (generated_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT billing_worksheet_drafts_type_check CHECK (invoice_type IN ('fixed', 'activity')),
  CONSTRAINT billing_worksheet_drafts_period_check CHECK (service_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT billing_worksheet_drafts_revision_check CHECK (revision >= 1),
  CONSTRAINT billing_worksheet_drafts_lines_array CHECK (jsonb_typeof(lines) = 'array'),
  CONSTRAINT billing_worksheet_drafts_removed_array CHECK (jsonb_typeof(removed_pending_item_ids) = 'array'),
  CONSTRAINT uq_billing_worksheet_draft UNIQUE (community_id, invoice_type, service_period)
);

GRANT SELECT, INSERT, UPDATE ON billing_worksheet_drafts TO service_role;

COMMIT;
