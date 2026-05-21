-- ============================================================================
-- 087_ownership_change_proposals.sql
-- ----------------------------------------------------------------------------
-- Review queue for ownership changes detected by the Vantaca import.
--
-- Pattern: when a Vantaca re-upload detects that a property's current owner
-- differs from what's on file, the import does NOT auto-apply the change.
-- Instead, it inserts a proposal row here. Staff reviews + approves; only
-- then does the system close the old ownership row (end_date=today) and
-- insert the new one. Rejection leaves the property's current ownership
-- intact and records the reason.
--
-- Why: ownership transitions can be wrong in Vantaca (typos, mistaken
-- updates, premature recording before deed actually transfers). Auto-applying
-- creates audit-trail problems if Bedrock has to back out a change later.
-- A human-in-the-loop review preserves both data quality and a clear
-- audit history of who approved what.
--
-- Apply after 086. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ownership_change_proposals (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  community_id             UUID NOT NULL REFERENCES communities(id),

  -- The current owner on file (before this change)
  current_contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  current_owner_name       TEXT,             -- snapshot at proposal time
  current_owner_email      TEXT,
  current_owner_phone      TEXT,

  -- The proposed new owner from the upload
  proposed_owner_name      TEXT NOT NULL,
  proposed_owner_email     TEXT,
  proposed_owner_phone     TEXT,
  proposed_mailing_address TEXT,
  proposed_homeowner_id    TEXT,             -- Vantaca's Homeowner ID

  -- Source of the proposal
  source                   TEXT NOT NULL
                             CHECK (source IN ('vantaca_import', 'manual_entry', 'title_company', 'estoppel_response')),
  source_filename          TEXT,
  source_batch_id          UUID,
  vantaca_account_id       TEXT,

  -- Workflow state
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'withdrawn')),
  reviewed_at              TIMESTAMPTZ,
  reviewed_by              TEXT,
  decision_notes           TEXT,

  -- Effective dates — when staff approves, this is when the ownership transitions
  effective_start_date     DATE,             -- typically NOW() when approved
  effective_end_date_prior DATE,             -- typically NOW() when approved (closes the prior ownership)

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ownership_proposals_pending
  ON ownership_change_proposals(community_id, status, created_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ownership_proposals_property
  ON ownership_change_proposals(property_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ownership_proposals_batch
  ON ownership_change_proposals(source_batch_id)
  WHERE source_batch_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ownership_proposals_updated_at ON ownership_change_proposals;
CREATE TRIGGER trg_ownership_proposals_updated_at
  BEFORE UPDATE ON ownership_change_proposals
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE ON ownership_change_proposals TO service_role;

-- ----------------------------------------------------------------------------
-- View for the staff admin queue
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ownership_proposals_queue AS
SELECT
  p.id,
  p.community_id,
  (SELECT name FROM communities WHERE id = p.community_id) AS community_name,
  p.property_id,
  prop.street_address,
  prop.unit,
  p.current_owner_name,
  p.current_owner_email,
  p.proposed_owner_name,
  p.proposed_owner_email,
  p.proposed_mailing_address,
  p.source,
  p.source_filename,
  p.vantaca_account_id,
  p.status,
  p.created_at,
  p.reviewed_at,
  p.reviewed_by,
  p.decision_notes,
  EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400.0 AS age_days
FROM ownership_change_proposals p
LEFT JOIN properties prop ON prop.id = p.property_id;

GRANT SELECT ON v_ownership_proposals_queue TO service_role, authenticated;

-- ----------------------------------------------------------------------------
-- RPC — approve a proposal (transitions ownership atomically)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_ownership_proposal(
  p_proposal_id  UUID,
  p_reviewed_by  TEXT,
  p_notes        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prop_rec       ownership_change_proposals%ROWTYPE;
  new_contact_id UUID;
  closed_count   INT := 0;
BEGIN
  SELECT * INTO prop_rec FROM ownership_change_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'proposal % not found', p_proposal_id; END IF;
  IF prop_rec.status <> 'pending' THEN
    RAISE EXCEPTION 'proposal already in status %', prop_rec.status;
  END IF;

  -- Resolve or create the proposed contact (by email when possible, else full_name)
  IF prop_rec.proposed_owner_email IS NOT NULL THEN
    SELECT id INTO new_contact_id FROM contacts
     WHERE LOWER(primary_email) = LOWER(prop_rec.proposed_owner_email)
     LIMIT 1;
  END IF;
  IF new_contact_id IS NULL THEN
    INSERT INTO contacts (full_name, primary_email, primary_phone, mailing_address)
    VALUES (prop_rec.proposed_owner_name,
            prop_rec.proposed_owner_email,
            prop_rec.proposed_owner_phone,
            prop_rec.proposed_mailing_address)
    RETURNING id INTO new_contact_id;
  ELSE
    -- Update mailing address on existing contact if we have a value
    IF prop_rec.proposed_mailing_address IS NOT NULL THEN
      UPDATE contacts
         SET mailing_address = prop_rec.proposed_mailing_address,
             updated_at = NOW()
       WHERE id = new_contact_id;
    END IF;
  END IF;

  -- Close any open ownership rows on this property
  UPDATE property_ownerships
     SET end_date = COALESCE(prop_rec.effective_end_date_prior, CURRENT_DATE),
         updated_at = NOW()
   WHERE property_id = prop_rec.property_id
     AND end_date IS NULL;
  GET DIAGNOSTICS closed_count = ROW_COUNT;

  -- Insert the new ownership
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source, notes)
  VALUES (prop_rec.property_id,
          new_contact_id,
          COALESCE(prop_rec.effective_start_date, CURRENT_DATE),
          TRUE,
          'ownership_proposal_approval',
          'Approved from proposal ' || p_proposal_id::text);

  -- Mark the proposal approved
  UPDATE ownership_change_proposals
     SET status = 'approved',
         reviewed_at = NOW(),
         reviewed_by = p_reviewed_by,
         decision_notes = p_notes,
         effective_start_date = COALESCE(effective_start_date, CURRENT_DATE),
         effective_end_date_prior = COALESCE(effective_end_date_prior, CURRENT_DATE)
   WHERE id = p_proposal_id;

  RETURN jsonb_build_object(
    'ok', true,
    'proposal_id', p_proposal_id,
    'new_contact_id', new_contact_id,
    'prior_ownerships_closed', closed_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION approve_ownership_proposal(UUID, TEXT, TEXT) TO service_role;

-- ----------------------------------------------------------------------------
-- RPC — reject a proposal
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_ownership_proposal(
  p_proposal_id  UUID,
  p_reviewed_by  TEXT,
  p_notes        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE ownership_change_proposals
     SET status = 'rejected',
         reviewed_at = NOW(),
         reviewed_by = p_reviewed_by,
         decision_notes = p_notes
   WHERE id = p_proposal_id
     AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal not found or not pending';
  END IF;
  RETURN jsonb_build_object('ok', true, 'proposal_id', p_proposal_id);
END;
$$;

GRANT EXECUTE ON FUNCTION reject_ownership_proposal(UUID, TEXT, TEXT) TO service_role;
