-- ============================================================================
-- 505_balance_sheet_report_categories.sql  (Ed 2026-10-09, month-end close PR C)
-- ----------------------------------------------------------------------------
-- Explicit balance-sheet presentation categories. The balance sheet is grouped
-- only by a mapping a person approved, never inferred from account names.
--
-- 1. report_categories / account_report_map: the statement CHECK gains
--    'balance_sheet'; a category's section may be asset / liability / equity
--    for that statement (revenue / expense stay income-statement only).
-- 2. account_report_map gains an approval state: 'proposed' (NOT shown as
--    mapped) or 'approved' (a person's affirmative decision, with who and when).
--    New mappings DEFAULT TO 'proposed': no insert becomes approved by leaving
--    approval_status out, and an approved row of either statement must carry
--    approved_by and approved_at (validation trigger). The existing pre-505
--    income-statement mappings were people's decisions under 463; they are
--    grandfathered EXPLICITLY below (approved_by = their recorded updated_by,
--    marked "grandfathered by migration 505"; approved_at = when they were last
--    set), and the 463 audit trigger logs each one. An admin assigning a
--    category (set_account_report_category) is an approval;
--    approve_account_report_map() approves proposals as they stand.
-- 3. statement_mapping_overrides: an OWNER's written decision to let a board
--    statement be marked final while some balance-sheet accounts are still
--    unmapped, bound to the exact statement snapshot (sha256) it was made on.
--    Append-only. Record ownership: association_record.
--
-- Row changes: only the explicit grandfathering of existing income-statement
-- mappings (approval columns set; category unchanged). Seeds nothing (proposals
-- are a separate, reviewed step: scripts/propose_balance_sheet_mapping.js).
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------- 1. statement + section
ALTER TABLE report_categories DROP CONSTRAINT IF EXISTS report_categories_statement_check;
ALTER TABLE report_categories ADD CONSTRAINT report_categories_statement_check CHECK (statement IN ('income_statement', 'balance_sheet'));
ALTER TABLE report_categories DROP CONSTRAINT IF EXISTS report_categories_section_check;
ALTER TABLE report_categories ADD CONSTRAINT report_categories_section_check CHECK (
  (statement = 'income_statement' AND section IN ('revenue', 'expense'))
  OR (statement = 'balance_sheet' AND section IN ('asset', 'liability', 'equity')));

ALTER TABLE account_report_map DROP CONSTRAINT IF EXISTS account_report_map_statement_check;
ALTER TABLE account_report_map ADD CONSTRAINT account_report_map_statement_check CHECK (statement IN ('income_statement', 'balance_sheet'));

-- ---------------------------------------------------------- 2. approval state
-- Added with the non-permissive default: every row (existing ones included)
-- starts 'proposed' until the explicit grandfathering below.
ALTER TABLE account_report_map ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'proposed';
ALTER TABLE account_report_map ALTER COLUMN approval_status SET DEFAULT 'proposed';
ALTER TABLE account_report_map ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE account_report_map ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE account_report_map DROP CONSTRAINT IF EXISTS account_report_map_approval_status_check;
ALTER TABLE account_report_map ADD CONSTRAINT account_report_map_approval_status_check CHECK (approval_status IN ('proposed', 'approved'));

-- The 463 validation, extended: a balance-sheet mapping joins an asset /
-- liability / equity account to a category of the same section.
CREATE OR REPLACE FUNCTION account_report_map_validate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE a record; c report_categories%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.account_id <> OLD.account_id OR NEW.statement <> OLD.statement OR NEW.community_id <> OLD.community_id) THEN
    RAISE EXCEPTION 'change the category, not the account, of a mapping';
  END IF;
  SELECT community_id, account_type, account_number INTO a FROM chart_of_accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'account not found'; END IF;
  SELECT * INTO c FROM report_categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'category not found'; END IF;
  IF a.community_id <> NEW.community_id OR c.community_id <> NEW.community_id THEN
    RAISE EXCEPTION 'account %, its category and the mapping must belong to the same community', a.account_number;
  END IF;
  IF c.statement <> NEW.statement THEN RAISE EXCEPTION 'category belongs to a different statement'; END IF;
  IF NOT c.is_active THEN RAISE EXCEPTION 'category "%" is inactive', c.name; END IF;
  IF NEW.statement = 'income_statement' AND (a.account_type NOT IN ('revenue', 'expense') OR a.account_type <> c.section) THEN
    RAISE EXCEPTION 'account % is %; it cannot present under the % category "%"', a.account_number, a.account_type, c.section, c.name;
  END IF;
  IF NEW.statement = 'balance_sheet' AND (a.account_type NOT IN ('asset', 'liability', 'equity') OR a.account_type <> c.section) THEN
    RAISE EXCEPTION 'account % is %; it cannot present under the % category "%"', a.account_number, a.account_type, c.section, c.name;
  END IF;
  IF NEW.approval_status = 'approved' AND (coalesce(btrim(NEW.approved_by), '') = '' OR NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'an approved mapping records who approved it and when';
  END IF;
  RETURN NEW;
END;
$fn$;

-- Explicit grandfathering of the pre-505 income-statement mappings (463 had no
-- approval state; every row was set by a person through the audited path).
SELECT set_config('trusted.actor', 'migration 505 (grandfathered pre-505 mapping)', true);
UPDATE account_report_map
   SET approval_status = 'approved',
       approved_by = coalesce(nullif(btrim(updated_by), ''), 'unrecorded') || ' (grandfathered by migration 505)',
       approved_at = coalesce(updated_at, created_at)
 WHERE statement = 'income_statement' AND approval_status = 'proposed' AND approved_at IS NULL;
SELECT set_config('trusted.actor', '', true);

-- A person assigning a category IS the approval (same signature as 463).
CREATE OR REPLACE FUNCTION set_account_report_category(p_community_id uuid, p_account_ids uuid[], p_category_id uuid, p_actor text, p_statement text DEFAULT 'income_statement')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE n_changed int := 0; n_removed int := 0;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'a mapping change needs who is making it'; END IF;
  IF p_account_ids IS NULL OR array_length(p_account_ids, 1) IS NULL THEN RAISE EXCEPTION 'no accounts given'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_account_ids) x(id) LEFT JOIN chart_of_accounts a ON a.id = x.id WHERE a.id IS NULL OR a.community_id <> p_community_id) THEN
    RAISE EXCEPTION 'every account must belong to this community';
  END IF;
  PERFORM set_config('trusted.actor', btrim(p_actor), true);
  IF p_category_id IS NULL THEN
    DELETE FROM account_report_map WHERE community_id = p_community_id AND statement = p_statement AND account_id = ANY (p_account_ids);
    GET DIAGNOSTICS n_removed = ROW_COUNT;
  ELSE
    INSERT INTO account_report_map (community_id, account_id, statement, category_id, updated_by, approval_status, approved_by, approved_at)
    SELECT p_community_id, x.id, p_statement, p_category_id, btrim(p_actor), 'approved', btrim(p_actor), now() FROM unnest(p_account_ids) x(id)
    ON CONFLICT (account_id, statement) DO UPDATE SET category_id = EXCLUDED.category_id, updated_by = EXCLUDED.updated_by,
        approval_status = 'approved', approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at
      WHERE account_report_map.category_id IS DISTINCT FROM EXCLUDED.category_id OR account_report_map.approval_status <> 'approved';
    GET DIAGNOSTICS n_changed = ROW_COUNT;
  END IF;
  PERFORM set_config('trusted.actor', '', true);
  RETURN jsonb_build_object('changed', n_changed, 'unmapped', n_removed);
END;
$$;

-- Approve proposals exactly as proposed (balance sheet).
CREATE OR REPLACE FUNCTION approve_account_report_map(p_community_id uuid, p_account_ids uuid[], p_actor text, p_statement text DEFAULT 'balance_sheet')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE n int := 0;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'an approval needs who is making it'; END IF;
  IF p_account_ids IS NULL OR array_length(p_account_ids, 1) IS NULL THEN RAISE EXCEPTION 'no accounts given'; END IF;
  PERFORM set_config('trusted.actor', btrim(p_actor), true);
  UPDATE account_report_map SET approval_status = 'approved', approved_by = btrim(p_actor), approved_at = now(), updated_by = btrim(p_actor)
   WHERE community_id = p_community_id AND statement = p_statement AND account_id = ANY (p_account_ids) AND approval_status = 'proposed';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('trusted.actor', '', true);
  RETURN jsonb_build_object('approved', n);
END;
$$;
REVOKE ALL ON FUNCTION approve_account_report_map(uuid, uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_account_report_map(uuid, uuid[], text, text) TO service_role;

-- ---------------------------------------------------------- 3. owner overrides
CREATE TABLE IF NOT EXISTS statement_mapping_overrides (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  community_id      uuid NOT NULL,
  packet_id         uuid,
  section_key       text NOT NULL,
  snapshot_sha256   text NOT NULL,
  unmapped_accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason            text NOT NULL,
  owner_actor       text NOT NULL,
  owner_user_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_mapping_overrides_pkey PRIMARY KEY (id),
  CONSTRAINT statement_mapping_overrides_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT statement_mapping_overrides_packet_fk FOREIGN KEY (packet_id) REFERENCES board_packets(id) ON DELETE RESTRICT,
  CONSTRAINT statement_mapping_overrides_reason_check CHECK (length(btrim(reason)) >= 10 AND length(btrim(owner_actor)) > 0),
  CONSTRAINT statement_mapping_overrides_sha_check CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_statement_mapping_overrides_snapshot ON statement_mapping_overrides (snapshot_sha256);
CREATE OR REPLACE FUNCTION statement_mapping_overrides_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'statement mapping overrides are permanent; record a new one instead';
END $fn$;
DROP TRIGGER IF EXISTS trg_statement_mapping_overrides_guard ON statement_mapping_overrides;
CREATE TRIGGER trg_statement_mapping_overrides_guard BEFORE UPDATE OR DELETE ON statement_mapping_overrides
  FOR EACH ROW EXECUTE FUNCTION statement_mapping_overrides_guard();
ALTER TABLE statement_mapping_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON statement_mapping_overrides FROM anon, authenticated;
GRANT SELECT, INSERT ON statement_mapping_overrides TO service_role;

COMMIT;
