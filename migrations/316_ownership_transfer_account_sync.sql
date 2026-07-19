-- ===========================================================================
-- 316_ownership_transfer_account_sync.sql
-- ---------------------------------------------------------------------------
-- Record ownership: property_ownerships + ownership_change_proposals are
-- `association_record` (the roster IS the HOA's). No new tables here.
--
-- WHY: approve_ownership_proposal (mig 087) creates/links the new owner contact
-- and closes+opens the property_ownerships row, but it NEVER propagated the new
-- Vantaca account number. On a sale, Vantaca issues the buyer a NEW account #
-- (e.g. LOPF 2013979 Tafish -> 2016976 Huerta). The AR subledger keys on
-- vantaca_account_id, so after an approved transfer the property + old contact
-- kept the SELLER's account # while AR moved to the buyer's — a silent split
-- between the roster and the money. This CREATE OR REPLACE adds the account
-- sync: the new contact carries the new account #, and the property's
-- vantaca_account_id is updated to match, so ownership and AR stay one truth.
-- Only fires when the proposal actually carries a vantaca_account_id (a
-- title-company transfer with no Vantaca # leaves it untouched).
-- ===========================================================================
BEGIN;

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
  prior_acct     TEXT;
  acct_synced    BOOLEAN := FALSE;
BEGIN
  SELECT * INTO prop_rec FROM ownership_change_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'proposal % not found', p_proposal_id; END IF;
  IF prop_rec.status <> 'pending' THEN
    RAISE EXCEPTION 'proposal already in status %', prop_rec.status;
  END IF;

  -- Resolve or create the proposed contact (by email when possible, else full_name).
  -- The new contact carries the buyer's Vantaca account # so AR resolves to them.
  IF prop_rec.proposed_owner_email IS NOT NULL THEN
    SELECT id INTO new_contact_id FROM contacts
     WHERE LOWER(primary_email) = LOWER(prop_rec.proposed_owner_email)
     LIMIT 1;
  END IF;
  IF new_contact_id IS NULL THEN
    INSERT INTO contacts (full_name, primary_email, primary_phone, mailing_address, vantaca_account_id)
    VALUES (prop_rec.proposed_owner_name,
            prop_rec.proposed_owner_email,
            prop_rec.proposed_owner_phone,
            prop_rec.proposed_mailing_address,
            prop_rec.vantaca_account_id)
    RETURNING id INTO new_contact_id;
  ELSE
    UPDATE contacts
       SET mailing_address   = COALESCE(prop_rec.proposed_mailing_address, mailing_address),
           vantaca_account_id = COALESCE(prop_rec.vantaca_account_id, vantaca_account_id),
           updated_at = NOW()
     WHERE id = new_contact_id;
  END IF;

  -- Close any open ownership rows on this property.
  UPDATE property_ownerships
     SET end_date = COALESCE(prop_rec.effective_end_date_prior, CURRENT_DATE),
         updated_at = NOW()
   WHERE property_id = prop_rec.property_id
     AND end_date IS NULL;
  GET DIAGNOSTICS closed_count = ROW_COUNT;

  -- Insert the new ownership, noting the account transition for the audit trail.
  INSERT INTO property_ownerships (property_id, contact_id, start_date, is_primary, source, notes)
  VALUES (prop_rec.property_id,
          new_contact_id,
          COALESCE(prop_rec.effective_start_date, CURRENT_DATE),
          TRUE,
          'ownership_proposal_approval',
          'Approved from proposal ' || p_proposal_id::text
            || CASE WHEN prop_rec.vantaca_account_id IS NOT NULL
                    THEN ' (Vantaca acct -> ' || prop_rec.vantaca_account_id || ')' ELSE '' END);

  -- Keep the property's Vantaca account # in sync with the new owner so the AR
  -- subledger (keyed on vantaca_account_id) resolves to the right property.
  IF prop_rec.vantaca_account_id IS NOT NULL THEN
    SELECT vantaca_account_id INTO prior_acct FROM properties WHERE id = prop_rec.property_id;
    IF prior_acct IS DISTINCT FROM prop_rec.vantaca_account_id THEN
      UPDATE properties
         SET vantaca_account_id = prop_rec.vantaca_account_id, updated_at = NOW()
       WHERE id = prop_rec.property_id;
      acct_synced := TRUE;
    END IF;
  END IF;

  -- Mark the proposal approved.
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
    'prior_ownerships_closed', closed_count,
    'vantaca_account_synced', acct_synced,
    'vantaca_account_id', prop_rec.vantaca_account_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION approve_ownership_proposal(UUID, TEXT, TEXT) TO service_role;

COMMIT;
