-- ============================================================================
-- 474_legal_invoice_extractions.sql  (Issue #9 step 2b: read the attorney PDF)
-- ----------------------------------------------------------------------------
-- The AP line text of an attorney invoice often carries no owner, address or
-- matter ("Fees", "Lien Enforcement Notice"); the attorney's PDF does. This
-- stores what the invoice reader extracted from the stored PDF, append-only:
--   legal_invoice_extractions  one row per read of an invoice's PDF: the
--       model's output verbatim (raw), the normalized matters, the AP line →
--       matter map, the validation problems, and the status:
--         valid         matters reconcile to the PDF total AND the payable,
--                       every payable line is tied to exactly one matter
--         needs_review  read, but did not reconcile (never feeds suggestions)
--         failed        the read itself failed (error recorded)
--       Source hash, model and prompt version are kept so a read is
--       reproducible. Rows are never updated or deleted.
-- Items record which extraction they relied on (extraction_id), and a service
-- date taken from the PDF's time / expense entries is its own source
-- ('pdf_entry'), distinct from a date merely mentioned in narrative.
-- DRAFT ONLY: nothing here posts to the GL or charges an owner.
--
-- Record ownership: WORKPAPER (Bedrock's review process). community_id on
-- every row for termination export scoping.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legal_invoice_extractions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ap_invoice_id       uuid NOT NULL REFERENCES ap_invoices(id) ON DELETE RESTRICT,
  community_id        uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  source_storage_path text,
  source_sha256       text,
  model               text NOT NULL,
  prompt_version      text NOT NULL,
  status              text NOT NULL CHECK (status IN ('valid', 'needs_review', 'failed')),
  raw                 jsonb,
  matters             jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_map            jsonb NOT NULL DEFAULT '{}'::jsonb,
  header              jsonb NOT NULL DEFAULT '{}'::jsonb,
  problems            jsonb NOT NULL DEFAULT '[]'::jsonb,
  error               text,
  duration_ms         integer,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- A failed read says why; a completed read keeps what the model returned.
  CONSTRAINT legal_extraction_status_detail CHECK (
    (status = 'failed' AND error IS NOT NULL) OR (status <> 'failed' AND raw IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_legal_invoice_extractions_invoice ON legal_invoice_extractions (ap_invoice_id, created_at DESC);

ALTER TABLE legal_invoice_extractions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legal_invoice_extractions FROM PUBLIC, anon, authenticated;
-- Append-only: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON legal_invoice_extractions TO service_role;

-- Items: which extraction they relied on, and the PDF-entry date source.
ALTER TABLE legal_invoice_items ADD COLUMN IF NOT EXISTS extraction_id uuid REFERENCES legal_invoice_extractions(id) ON DELETE RESTRICT;
ALTER TABLE legal_invoice_items DROP CONSTRAINT IF EXISTS legal_invoice_items_service_date_source_check;
ALTER TABLE legal_invoice_items ADD CONSTRAINT legal_invoice_items_service_date_source_check
  CHECK (service_date_source IN ('line_text', 'invoice_service_period', 'pdf_entry', 'staff', 'none'));

-- The one draft-save path, now also persisting extraction_id (and refusing an
-- extraction that belongs to a different invoice). Everything else unchanged
-- from migration 473.
CREATE OR REPLACE FUNCTION legal_review_save_draft(p_ap_invoice_id uuid, p_community_id uuid, p_base_revision integer,
                                                   p_actor text, p_items jsonb, p_summary jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_review legal_invoice_reviews%ROWTYPE;
  v_rev integer;
  v_item jsonb;
  v_alloc jsonb;
  v_item_id uuid;
  v_prop uuid;
  v_tenure uuid;
  v_extraction uuid;
  v_i integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ap_invoices WHERE id = p_ap_invoice_id AND community_id = p_community_id) THEN
    RAISE EXCEPTION 'legal_review_invoice_community_mismatch';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'legal_review_items_not_array'; END IF;

  INSERT INTO legal_invoice_reviews (ap_invoice_id, community_id, created_by, updated_by)
  VALUES (p_ap_invoice_id, p_community_id, p_actor, p_actor)
  ON CONFLICT (ap_invoice_id) DO NOTHING;
  SELECT * INTO v_review FROM legal_invoice_reviews WHERE ap_invoice_id = p_ap_invoice_id FOR UPDATE;
  IF v_review.community_id <> p_community_id THEN RAISE EXCEPTION 'legal_review_community_mismatch'; END IF;
  IF v_review.revision <> p_base_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', 'stale', 'revision', v_review.revision, 'review_id', v_review.id);
  END IF;
  v_rev := v_review.revision + 1;

  UPDATE legal_invoice_allocations SET is_active = false, superseded_at = now() WHERE review_id = v_review.id AND is_active;
  UPDATE legal_invoice_items SET is_active = false, superseded_at = now() WHERE review_id = v_review.id AND is_active;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_extraction := (v_item->>'extraction_id')::uuid;
    IF v_extraction IS NOT NULL AND NOT EXISTS (SELECT 1 FROM legal_invoice_extractions WHERE id = v_extraction AND ap_invoice_id = p_ap_invoice_id) THEN
      RAISE EXCEPTION 'legal_review_extraction_not_for_invoice';
    END IF;
    INSERT INTO legal_invoice_items (review_id, community_id, revision, sort_order, source_line_ids, source_text, matter_ref,
                                     amount_cents, service_date, service_period_start, service_period_end, service_date_source,
                                     extraction_id, created_by)
    VALUES (v_review.id, p_community_id, v_rev, v_i,
            ARRAY(SELECT jsonb_array_elements_text(coalesce(v_item->'source_line_ids', '[]'::jsonb)))::uuid[],
            v_item->>'source_text', v_item->>'matter_ref', (v_item->>'amount_cents')::bigint,
            (v_item->>'service_date')::date, (v_item->>'service_period_start')::date, (v_item->>'service_period_end')::date,
            coalesce(v_item->>'service_date_source', 'none'), v_extraction, p_actor)
    RETURNING id INTO v_item_id;

    FOR v_alloc IN SELECT value FROM jsonb_array_elements(coalesce(v_item->'allocations', '[]'::jsonb)) LOOP
      v_prop := (v_alloc->>'property_id')::uuid;
      v_tenure := (v_alloc->>'tenure_id')::uuid;
      IF v_prop IS NOT NULL AND NOT EXISTS (SELECT 1 FROM properties WHERE id = v_prop AND community_id = p_community_id) THEN
        RAISE EXCEPTION 'legal_review_property_not_in_community';
      END IF;
      IF v_tenure IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ownership_tenures WHERE id = v_tenure AND property_id = v_prop) THEN
        RAISE EXCEPTION 'legal_review_tenure_not_on_property';
      END IF;
      INSERT INTO legal_invoice_allocations (item_id, review_id, community_id, revision, amount_cents, classification, property_id,
                                             tenure_id, charge_category, tenure_match, confidence, bankruptcy_stop, evidence,
                                             suggested, note, created_by)
      VALUES (v_item_id, v_review.id, p_community_id, v_rev, (v_alloc->>'amount_cents')::bigint, v_alloc->>'classification', v_prop,
              v_tenure, v_alloc->>'charge_category', coalesce(v_alloc->>'tenure_match', 'not_applicable'),
              coalesce(v_alloc->>'confidence', 'none'), coalesce((v_alloc->>'bankruptcy_stop')::boolean, false),
              coalesce(v_alloc->'evidence', '[]'::jsonb), coalesce((v_alloc->>'suggested')::boolean, false),
              v_alloc->>'note', p_actor);
    END LOOP;
    v_i := v_i + 1;
  END LOOP;

  UPDATE legal_invoice_reviews SET revision = v_rev, updated_by = p_actor WHERE id = v_review.id;
  INSERT INTO legal_invoice_review_events (review_id, community_id, revision, action, actor, summary)
  VALUES (v_review.id, p_community_id, v_rev, 'draft_saved', p_actor, coalesce(p_summary, '{}'::jsonb));
  RETURN jsonb_build_object('ok', true, 'review_id', v_review.id, 'revision', v_rev);
END $$;
REVOKE ALL ON FUNCTION legal_review_save_draft(uuid, uuid, integer, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legal_review_save_draft(uuid, uuid, integer, text, jsonb, jsonb) TO service_role;

COMMIT;
