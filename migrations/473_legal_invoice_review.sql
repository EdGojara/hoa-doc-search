-- ============================================================================
-- 473_legal_invoice_review.sql  (Issue #9 step 2: draft-only legal review)
-- ----------------------------------------------------------------------------
-- Review state for attorney invoices: each charge is classified as association
-- legal expense or homeowner-recoverable, with the evidence behind any owner
-- match. DRAFT ONLY: nothing here posts to the GL, reclassifies an accrual, or
-- writes a homeowner charge. A later, separately reviewed posting slice will
-- read approved allocations.
--
-- Model (ChatGPT review): review → items (matters) → allocations.
--   legal_invoice_reviews      one per AP invoice
--   legal_invoice_items        a matter/charge built from one or more AP lines
--                              (source line ids + text preserved); carries the
--                              SERVICE date (not the invoice date) and where it
--                              came from
--   legal_invoice_allocations  amount_cents + classification + optional
--                              property / tenure + charge category + evidence +
--                              confidence + tenure match + bankruptcy stop.
--                              Revisioned: a save supersedes the prior active
--                              set (is_active = false) and inserts a new one;
--                              rows are never deleted.
--   legal_invoice_review_events  who did what, when (audit trail)
--   legal_review_save_draft()    the one atomic write path for a draft save
-- Also: vendors.is_legal_counsel, set for the three firms by stable id.
--
-- Record ownership: WORKPAPER (Bedrock's review/production process). Once a
-- later slice posts an owner charge or reclass, those postings are association
-- records in their own tables; these rows stay the workpaper behind them.
-- Every table carries community_id for termination export scoping.
-- ============================================================================
BEGIN;

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_legal_counsel boolean NOT NULL DEFAULT false;

-- The three attorney vendors on file today (confirmed by id, 2026-09-29).
UPDATE vendors SET is_legal_counsel = true
 WHERE id IN ('22488091-2642-489d-a84a-50c72fb05645',   -- Winstead PC
              '35f76d51-0753-4f9f-b46d-df3c73d6092a',   -- Daughtry & Farine, P.C.
              'ee565db3-2c94-4830-8855-ccea1740dfa7')   -- RMWBH
   AND is_legal_counsel = false;

CREATE TABLE IF NOT EXISTS legal_invoice_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ap_invoice_id uuid NOT NULL UNIQUE REFERENCES ap_invoices(id) ON DELETE RESTRICT,
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft')),
  revision      integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_by    text,
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_legal_invoice_reviews_community ON legal_invoice_reviews (community_id);
DROP TRIGGER IF EXISTS trg_legal_invoice_reviews_updated_at ON legal_invoice_reviews;
CREATE TRIGGER trg_legal_invoice_reviews_updated_at
  BEFORE UPDATE ON legal_invoice_reviews
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

CREATE TABLE IF NOT EXISTS legal_invoice_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id           uuid NOT NULL REFERENCES legal_invoice_reviews(id) ON DELETE RESTRICT,
  community_id        uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  revision            integer NOT NULL CHECK (revision >= 1),
  is_active           boolean NOT NULL DEFAULT true,
  sort_order          integer NOT NULL DEFAULT 0,
  source_line_ids     uuid[] NOT NULL DEFAULT '{}',
  source_text         text,
  matter_ref          text,
  amount_cents        bigint NOT NULL CHECK (amount_cents <> 0),
  service_date        date,
  service_date_source text NOT NULL DEFAULT 'none'
                      CHECK (service_date_source IN ('line_text', 'invoice_service_period', 'staff', 'none')),
  superseded_at       timestamptz,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_legal_invoice_items_review ON legal_invoice_items (review_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS legal_invoice_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES legal_invoice_items(id) ON DELETE RESTRICT,
  review_id       uuid NOT NULL REFERENCES legal_invoice_reviews(id) ON DELETE RESTRICT,
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  revision        integer NOT NULL CHECK (revision >= 1),
  is_active       boolean NOT NULL DEFAULT true,
  amount_cents    bigint NOT NULL CHECK (amount_cents <> 0),
  classification  text NOT NULL CHECK (classification IN ('homeowner_recoverable', 'association_legal_expense', 'needs_review')),
  property_id     uuid REFERENCES properties(id) ON DELETE RESTRICT,
  tenure_id       uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  charge_category text CHECK (charge_category IS NULL OR charge_category IN ('attorney_fee', 'attorney_fee_other')),
  tenure_match    text NOT NULL DEFAULT 'not_applicable'
                  CHECK (tenure_match IN ('current', 'former', 'unresolved', 'not_applicable')),
  confidence      text NOT NULL DEFAULT 'none' CHECK (confidence IN ('high', 'medium', 'low', 'none')),
  bankruptcy_stop boolean NOT NULL DEFAULT false,
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested       boolean NOT NULL DEFAULT false,
  note            text,
  superseded_at   timestamptz,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A recoverable allocation names who pays; nothing else does.
  CONSTRAINT legal_alloc_recoverable_has_property CHECK (classification <> 'homeowner_recoverable' OR property_id IS NOT NULL),
  CONSTRAINT legal_alloc_category_only_recoverable CHECK (classification = 'homeowner_recoverable' OR charge_category IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_legal_invoice_allocations_item ON legal_invoice_allocations (item_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_legal_invoice_allocations_property ON legal_invoice_allocations (property_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS legal_invoice_review_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id    uuid NOT NULL REFERENCES legal_invoice_reviews(id) ON DELETE RESTRICT,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  revision     integer NOT NULL,
  action       text NOT NULL CHECK (action IN ('draft_saved')),
  actor        text,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_legal_invoice_review_events_review ON legal_invoice_review_events (review_id, created_at);

-- Staff-only workpaper: never readable from the browser roles.
ALTER TABLE legal_invoice_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_invoice_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_invoice_review_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legal_invoice_reviews, legal_invoice_items, legal_invoice_allocations, legal_invoice_review_events FROM PUBLIC, anon, authenticated;

-- The API writes with the service role; history is never deleted.
GRANT SELECT, INSERT, UPDATE ON legal_invoice_reviews, legal_invoice_items, legal_invoice_allocations TO service_role;
GRANT SELECT, INSERT ON legal_invoice_review_events TO service_role;

-- One atomic draft save. The API validates and recomputes (evidence, tenure,
-- bankruptcy) first; this function only writes, all-or-nothing:
--   claim the review row (created on first save) under a row lock,
--   refuse a stale save (base revision is not the current one),
--   supersede the prior active items/allocations (never deleted),
--   insert the new set at revision + 1, record the event.
-- Guards that do not trust the caller: the AP invoice belongs to the
-- community, and every property / tenure named belongs to it too.
-- Returns {ok, review_id, revision} or {ok:false, error:'stale', revision}.
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
    INSERT INTO legal_invoice_items (review_id, community_id, revision, sort_order, source_line_ids, source_text, matter_ref,
                                     amount_cents, service_date, service_date_source, created_by)
    VALUES (v_review.id, p_community_id, v_rev, v_i,
            ARRAY(SELECT jsonb_array_elements_text(coalesce(v_item->'source_line_ids', '[]'::jsonb)))::uuid[],
            v_item->>'source_text', v_item->>'matter_ref', (v_item->>'amount_cents')::bigint,
            (v_item->>'service_date')::date, coalesce(v_item->>'service_date_source', 'none'), p_actor)
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
