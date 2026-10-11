-- ============================================================================
-- 508_legal_review_approval.sql  (Ed 2026-10-11)
-- ----------------------------------------------------------------------------
-- Legal Invoice Review, step 3: APPROVE TREATMENT.
--
-- Until now a review could only be saved as a draft (473/474). This adds:
--   1. An 'approved' review state. An approved review is locked: the draft
--      save path refuses it, so the treatment that was approved is the
--      treatment that posted. A correction reverses the postings, reopens the
--      review (with a reason, on the audit trail), and is approved again.
--   2. A 'bedrock_corporate' allocation: legal cost Bedrock, not the
--      association, is responsible for. Only on evidence; never a default.
--   3. legal_invoice_postings: one row per posted allocation, linking the
--      originating AP invoice line(s), the journal entry and the homeowner
--      ledger charge. A partial unique index on the allocation is the
--      idempotency control: an allocation can be live-posted at most once,
--      and a crashed run resumes from its 'pending' claim instead of posting
--      twice.
--   4. Review events for approval, each posting, each reversal and a reopen.
--
-- Invoice approval (AP two-key), chargeback authorization (this) and payment
-- release stay three separate acts. Nothing here touches ap_invoices.
--
-- Additive and safe to re-run. Ed applies it; the app reads the new state only
-- once it exists (until then Approve Treatment reports the migration missing).
-- ============================================================================

-- 1. Review state ------------------------------------------------------------
ALTER TABLE legal_invoice_reviews DROP CONSTRAINT IF EXISTS legal_invoice_reviews_status_check;
ALTER TABLE legal_invoice_reviews ADD CONSTRAINT legal_invoice_reviews_status_check CHECK (status IN ('draft', 'approved'));
ALTER TABLE legal_invoice_reviews ADD COLUMN IF NOT EXISTS approved_revision integer;
ALTER TABLE legal_invoice_reviews ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE legal_invoice_reviews ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE legal_invoice_reviews DROP CONSTRAINT IF EXISTS legal_review_approved_shape;
ALTER TABLE legal_invoice_reviews ADD CONSTRAINT legal_review_approved_shape CHECK (
  status <> 'approved' OR (approved_revision = revision AND approved_by IS NOT NULL AND approved_at IS NOT NULL));

-- 2. Bedrock-responsible allocation -----------------------------------------
ALTER TABLE legal_invoice_allocations DROP CONSTRAINT IF EXISTS legal_invoice_allocations_classification_check;
ALTER TABLE legal_invoice_allocations ADD CONSTRAINT legal_invoice_allocations_classification_check
  CHECK (classification IN ('homeowner_recoverable', 'association_legal_expense', 'bedrock_corporate', 'needs_review'));

-- 3. Events ------------------------------------------------------------------
ALTER TABLE legal_invoice_review_events DROP CONSTRAINT IF EXISTS legal_invoice_review_events_action_check;
ALTER TABLE legal_invoice_review_events ADD CONSTRAINT legal_invoice_review_events_action_check
  CHECK (action IN ('draft_saved', 'treatment_approved', 'posting_recorded', 'posting_reversed', 'review_reopened'));

-- 4. Postings ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_invoice_postings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id                 uuid NOT NULL REFERENCES legal_invoice_reviews(id) ON DELETE RESTRICT,
  allocation_id             uuid NOT NULL REFERENCES legal_invoice_allocations(id) ON DELETE RESTRICT,
  item_id                   uuid NOT NULL REFERENCES legal_invoice_items(id) ON DELETE RESTRICT,
  ap_invoice_id             uuid NOT NULL REFERENCES ap_invoices(id) ON DELETE RESTRICT,
  ap_invoice_line_ids       uuid[] NOT NULL,
  community_id              uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  review_revision           integer NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('homeowner_chargeback', 'bedrock_recovery')),
  property_id               uuid REFERENCES properties(id) ON DELETE RESTRICT,
  amount_cents              bigint NOT NULL CHECK (amount_cents > 0),
  debit_account_id          uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  credit_account_id         uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  posting_date              date NOT NULL,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'reversed')),
  journal_entry_id          uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  homeowner_transaction_id  uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  posted_by                 text,
  posted_at                 timestamptz,
  reversal_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_homeowner_transaction_id uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  reversal_reason           text,
  reversed_by               text,
  reversed_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_posting_homeowner_has_property CHECK (kind <> 'homeowner_chargeback' OR property_id IS NOT NULL),
  CONSTRAINT legal_posting_posted_shape CHECK (status = 'pending' OR (journal_entry_id IS NOT NULL AND posted_at IS NOT NULL
    AND (kind <> 'homeowner_chargeback' OR homeowner_transaction_id IS NOT NULL))),
  CONSTRAINT legal_posting_reversed_shape CHECK (status <> 'reversed' OR (reversal_journal_entry_id IS NOT NULL
    AND reversal_reason IS NOT NULL AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL
    AND (kind <> 'homeowner_chargeback' OR reversal_homeowner_transaction_id IS NOT NULL)))
);
-- The idempotency control: one live posting per allocation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_legal_invoice_postings_live_allocation
  ON legal_invoice_postings (allocation_id) WHERE status IN ('pending', 'posted');
CREATE INDEX IF NOT EXISTS idx_legal_invoice_postings_invoice ON legal_invoice_postings (ap_invoice_id);
CREATE INDEX IF NOT EXISTS idx_legal_invoice_postings_property ON legal_invoice_postings (property_id) WHERE property_id IS NOT NULL;

ALTER TABLE legal_invoice_postings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legal_invoice_postings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legal_invoice_postings TO service_role;

-- 5. Draft save refuses an approved review ----------------------------------
-- Same body as migration 474, plus the lock check right after the row lock.
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
  IF v_review.status = 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'approved_locked', 'revision', v_review.revision, 'review_id', v_review.id);
  END IF;
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

-- 6. Approve (lock) ----------------------------------------------------------
-- Locks the exact revision the approver saw. Re-approving the same revision is
-- a no-op success, so a run that crashed mid-posting can resume.
CREATE OR REPLACE FUNCTION legal_review_approve(p_ap_invoice_id uuid, p_base_revision integer, p_actor text, p_summary jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_review legal_invoice_reviews%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'legal_review_actor_required'; END IF;
  SELECT * INTO v_review FROM legal_invoice_reviews WHERE ap_invoice_id = p_ap_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'no_review'); END IF;
  IF v_review.revision <> p_base_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', 'stale', 'revision', v_review.revision);
  END IF;
  IF v_review.status = 'approved' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'review_id', v_review.id, 'revision', v_review.revision);
  END IF;
  UPDATE legal_invoice_reviews SET status = 'approved', approved_revision = revision, approved_by = p_actor,
         approved_at = now(), updated_by = p_actor WHERE id = v_review.id;
  INSERT INTO legal_invoice_review_events (review_id, community_id, revision, action, actor, summary)
  VALUES (v_review.id, v_review.community_id, v_review.revision, 'treatment_approved', p_actor, coalesce(p_summary, '{}'::jsonb));
  RETURN jsonb_build_object('ok', true, 'review_id', v_review.id, 'revision', v_review.revision);
END $$;
REVOKE ALL ON FUNCTION legal_review_approve(uuid, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legal_review_approve(uuid, integer, text, jsonb) TO service_role;

-- 7. Reopen (documented correction) -------------------------------------------
-- Only once every posting is reversed: nothing live can be orphaned by a
-- re-save. The reason is required and lands on the audit trail.
CREATE OR REPLACE FUNCTION legal_review_reopen(p_ap_invoice_id uuid, p_actor text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_review legal_invoice_reviews%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'legal_review_actor_required'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN RAISE EXCEPTION 'legal_review_reason_required'; END IF;
  SELECT * INTO v_review FROM legal_invoice_reviews WHERE ap_invoice_id = p_ap_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'no_review'); END IF;
  IF v_review.status <> 'approved' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_approved'); END IF;
  IF EXISTS (SELECT 1 FROM legal_invoice_postings WHERE review_id = v_review.id AND status IN ('pending', 'posted')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'live_postings');
  END IF;
  UPDATE legal_invoice_reviews SET status = 'draft', approved_revision = NULL, approved_by = NULL, approved_at = NULL,
         updated_by = p_actor WHERE id = v_review.id;
  INSERT INTO legal_invoice_review_events (review_id, community_id, revision, action, actor, summary)
  VALUES (v_review.id, v_review.community_id, v_review.revision, 'review_reopened', p_actor,
          jsonb_build_object('reason', btrim(p_reason), 'previously_approved_by', v_review.approved_by,
                             'previously_approved_at', v_review.approved_at));
  RETURN jsonb_build_object('ok', true, 'review_id', v_review.id, 'revision', v_review.revision);
END $$;
REVOKE ALL ON FUNCTION legal_review_reopen(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legal_review_reopen(uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
