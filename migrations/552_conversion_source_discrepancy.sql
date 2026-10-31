-- ============================================================================
-- 552_conversion_source_discrepancy.sql  (Ed 2026-10-31)
-- ----------------------------------------------------------------------------
-- Two conversion policy kinds (lib/onboarding/conversion_objects.js):
--
--   source_discrepancy  The SOURCE trial balance itself does not net to zero, by an
--                       exact amount that sits in one account whose correct figure the
--                       (balancing) source balance sheet shows. First case: Waterview's
--                       Vantaca 2026 trial balance is out by $700 from Vantaca's 2025
--                       year-end roll (Ed 2026-06-27: charge it to 3050). The account opens
--                       at the balance-sheet figure so every conversion entry balances; the
--                       source amounts and the failed source controls stay on record.
--                       An adjustment cannot carry this: adjustments must balance (535).
--   fund_allocation     One account's opening split across funds exactly as the source's
--                       fund columns show it, proposed and approved like every other
--                       conversion object (until now only an owner-only stage setting).
--
-- Both are keyed by account (one live policy per kind + account per batch) and need
-- their source evidence. Approval stays human, in the app, bound to the fingerprint.
--
-- Record ownership: association_record (conversion_policies, as in 535).
-- Changes no existing row: widens one CHECK list and replaces the policy guard
-- function with the same rules plus the two kinds.
-- ============================================================================
BEGIN;

ALTER TABLE conversion_policies DROP CONSTRAINT IF EXISTS conversion_policies_policy_kind_check;
ALTER TABLE conversion_policies ADD CONSTRAINT conversion_policies_policy_kind_check
  CHECK (policy_kind IN ('cutoff_authority','legacy_owner_routing','suspense_treatment','timing_treatment','preserve_source_coding','carried_balance',
                         'source_discrepancy','fund_allocation'));

CREATE OR REPLACE FUNCTION conversion_policies_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a conversion policy is never deleted (supersede or reject it)' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approval_channel IS NOT NULL THEN
      RAISE EXCEPTION 'a conversion policy is created proposed; it is approved only through conversion_decide_object' USING ERRCODE = 'check_violation';
    END IF;
    NEW.policy_key := CASE WHEN NEW.policy_kind IN ('suspense_treatment','preserve_source_coding','source_discrepancy','fund_allocation') THEN btrim(coalesce(NEW.value->>'account', ''))
                           WHEN NEW.policy_kind = 'carried_balance' THEN btrim(coalesce(NEW.value->>'control', '')) || ':' || btrim(coalesce(NEW.value->>'item_key', ''))
                           ELSE '' END;
    IF NEW.policy_kind IN ('suspense_treatment','preserve_source_coding','source_discrepancy','fund_allocation') AND NEW.policy_key = '' THEN
      RAISE EXCEPTION 'a % policy names its account', NEW.policy_kind USING ERRCODE = 'check_violation';
    END IF;
    -- A carried balance names the control it explains, the reconciling item and the exact cents, and is
    -- source-supported: its evidence is required (a document of the batch; checked by the application).
    IF NEW.policy_kind = 'carried_balance' AND (NEW.policy_key ~ '(^:|:$)' OR coalesce(NEW.value->>'amount_cents', '') !~ '^-?[0-9]+$'
       OR NEW.evidence IS NULL OR NOT (NEW.evidence ? 'artifact_sha256' AND NEW.evidence ? 'locator')) THEN
      RAISE EXCEPTION 'a carried-balance policy names the control, the reconciling item, the exact amount_cents and its source evidence' USING ERRCODE = 'check_violation';
    END IF;
    -- 552: a source discrepancy is exact, non-zero, read from the balance sheet, and sourced.
    IF NEW.policy_kind = 'source_discrepancy' AND (coalesce(NEW.value->>'amount_cents', '') !~ '^-?[1-9][0-9]*$' OR coalesce(NEW.value->>'basis', '') <> 'balance_sheet'
       OR NEW.evidence IS NULL OR NOT (NEW.evidence ? 'artifact_sha256' AND NEW.evidence ? 'locator')) THEN
      RAISE EXCEPTION 'a source-discrepancy policy names the account, the exact non-zero amount_cents, basis balance_sheet and its source evidence' USING ERRCODE = 'check_violation';
    END IF;
    -- 552: a fund allocation lists its parts and is read from the source's fund columns.
    IF NEW.policy_kind = 'fund_allocation' AND ((CASE WHEN jsonb_typeof(NEW.value->'parts') = 'array' THEN jsonb_array_length(NEW.value->'parts') ELSE 0 END) < 1
       OR coalesce(NEW.value->>'basis', '') <> 'source_fund_columns' OR NEW.evidence IS NULL OR NOT (NEW.evidence ? 'artifact_sha256' AND NEW.evidence ? 'locator')) THEN
      RAISE EXCEPTION 'a fund-allocation policy names the account, its parts, basis source_fund_columns and its source evidence' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.policy_kind = 'suspense_treatment' AND coalesce(NEW.value->>'allocate_to_owners', '') <> 'false' THEN
      RAISE EXCEPTION 'a suspense balance is never allocated to owners (allocate_to_owners must be false)' USING ERRCODE = 'check_violation';
    END IF;
    NEW.fingerprint := conversion_sha256_jsonb(jsonb_build_object('batch_id', NEW.batch_id, 'policy_kind', NEW.policy_kind, 'policy_key', NEW.policy_key, 'value', NEW.value,
      'reason', NEW.reason, 'evidence', NEW.evidence));
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.batch_id, NEW.community_id, NEW.policy_kind, NEW.policy_key, NEW.value, NEW.reason, NEW.evidence, NEW.instruction_source, NEW.supersedes_id, NEW.fingerprint,
      NEW.proposed_by_kind, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.batch_id, OLD.community_id, OLD.policy_kind, OLD.policy_key, OLD.value, OLD.reason, OLD.evidence, OLD.instruction_source, OLD.supersedes_id, OLD.fingerprint,
      OLD.proposed_by_kind, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a conversion policy''s content is fixed once proposed; propose a new one that supersedes it' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(current_setting('onboarding.object_writer', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'conversion policies change status only through conversion_decide_object / a superseding proposal' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('approved','rejected','superseded')) OR (OLD.status = 'approved' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'a conversion policy cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approved_by_user_id, NEW.approved_by_label, NEW.approved_at, NEW.approval_channel) IS DISTINCT FROM (OLD.approved_by_user_id, OLD.approved_by_label, OLD.approved_at, OLD.approval_channel) THEN
    RAISE EXCEPTION 'an approval is permanent (it can be superseded, never rewritten)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMIT;
