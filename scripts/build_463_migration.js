#!/usr/bin/env node
// Builds migrations/463_report_categories.sql. The LOPF seed is embedded from
// lib/accounting/report_seeds/lopf_income_statement.json so the migration and
// the tests read one approved map (tests/test_report_categories.js checks they
// match). Run once to (re)generate; never after 463 is applied.
const fs = require('fs');
const path = require('path');
const spec = fs.readFileSync(path.join(__dirname, '..', 'lib/accounting/report_seeds/lopf_income_statement.json'), 'utf8').trim();
JSON.parse(spec);

const sql = `-- ============================================================================
-- 463_report_categories.sql
-- ----------------------------------------------------------------------------
-- Record ownership: association_record. Categories and account mappings decide
-- how the association's own statements are presented; they go with the books.
--
-- WHY: statements grouped accounts by guessing from account names (_plGroup),
-- which misfiles real lines (insurance under Administrative, fountains under
-- Landscaping, security under "Other"). Boards need grouped statements they
-- recognise. (Ed 2026-09-25, Reporting categories Phase 1.)
--
-- WHAT (presentation metadata only; the GL is not touched):
--   * report_categories      community-specific categories, one level of
--                            subcategories, display order, optional report label.
--   * account_report_map     one row per GL account per statement. The category
--                            is the subcategory when there is one (the parent is
--                            derived), so category and subcategory can't disagree.
--                            An account with no row is Unmapped and stays visible.
--   * report_mapping_events  append-only log of every category / mapping change.
--   * set_account_report_category(): the write path for (bulk) mapping, with actor.
--   * Seed: Lakes of Pine Forest only, from the approved map.
-- GL accounts, journals, budgets, AR, AP, ownership: unchanged.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m463_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(id::text || account_number || account_name || account_type || coalesce(fund_id::text, '') || coalesce(parent_account_id::text, '') || is_summary::text || is_active::text, '|' ORDER BY id), '')) FROM chart_of_accounts) AS coa_h,
  (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) AS je_h,
  (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) AS jel_h,
  (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || coalesce(fund_id::text, '') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items) AS bl_h,
  (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) AS bh_h;

-- 1) Categories ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_categories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id       uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  statement          text NOT NULL DEFAULT 'income_statement' CHECK (statement IN ('income_statement')),
  section            text NOT NULL CHECK (section IN ('revenue', 'expense')),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  report_label       text,
  parent_category_id uuid REFERENCES report_categories(id) ON DELETE RESTRICT,
  display_order      integer NOT NULL DEFAULT 100,
  is_active          boolean NOT NULL DEFAULT true,
  updated_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE report_categories IS 'association_record: presentation categories for a community''s statements (one level of subcategories). Not part of the GL.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_categories_name
  ON report_categories (community_id, statement, coalesce(parent_category_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_report_categories_community ON report_categories (community_id, statement);
CREATE INDEX IF NOT EXISTS idx_report_categories_parent ON report_categories (parent_category_id);
GRANT SELECT, INSERT, UPDATE ON report_categories TO service_role;
GRANT SELECT ON report_categories TO authenticated;
DROP TRIGGER IF EXISTS trg_report_categories_updated_at ON report_categories;
CREATE TRIGGER trg_report_categories_updated_at BEFORE UPDATE ON report_categories
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

CREATE OR REPLACE FUNCTION report_categories_validate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE p report_categories%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'report categories are not deleted; deactivate "%" instead', OLD.name;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.community_id <> OLD.community_id OR NEW.statement <> OLD.statement) THEN
    RAISE EXCEPTION 'a category cannot move to another community or statement';
  END IF;
  IF NEW.parent_category_id IS NOT NULL THEN
    IF NEW.parent_category_id = NEW.id THEN RAISE EXCEPTION 'a category cannot be its own parent'; END IF;
    SELECT * INTO p FROM report_categories WHERE id = NEW.parent_category_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'parent category not found'; END IF;
    IF p.parent_category_id IS NOT NULL THEN RAISE EXCEPTION 'subcategories are one level deep ("%" is already a subcategory)', p.name; END IF;
    IF p.community_id <> NEW.community_id OR p.statement <> NEW.statement OR p.section <> NEW.section THEN
      RAISE EXCEPTION 'a subcategory must share its parent''s community, statement and section';
    END IF;
    IF EXISTS (SELECT 1 FROM report_categories c WHERE c.parent_category_id = NEW.id) THEN
      RAISE EXCEPTION '"%" has subcategories, so it cannot become a subcategory', NEW.name;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.section <> OLD.section AND (
       EXISTS (SELECT 1 FROM report_categories c WHERE c.parent_category_id = NEW.id)
    OR EXISTS (SELECT 1 FROM account_report_map m WHERE m.category_id = NEW.id)) THEN
    RAISE EXCEPTION 'move or unmap its subcategories and accounts before changing the section of "%"', NEW.name;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active AND NOT NEW.is_active AND (
       EXISTS (SELECT 1 FROM report_categories c WHERE c.parent_category_id = NEW.id AND c.is_active)
    OR EXISTS (SELECT 1 FROM account_report_map m WHERE m.category_id = NEW.id)) THEN
    RAISE EXCEPTION '"%" still has accounts or active subcategories; move them first', NEW.name;
  END IF;
  RETURN NEW;
END;
$fn$;

-- 2) Account mapping ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_report_map (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  account_id    uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  statement     text NOT NULL DEFAULT 'income_statement' CHECK (statement IN ('income_statement')),
  category_id   uuid NOT NULL REFERENCES report_categories(id) ON DELETE RESTRICT,
  display_order integer,
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, statement)
);
COMMENT ON TABLE account_report_map IS 'association_record: which report category each GL account presents under, per statement. One account, one category per statement. No row = Unmapped.';
CREATE INDEX IF NOT EXISTS idx_account_report_map_community ON account_report_map (community_id, statement);
CREATE INDEX IF NOT EXISTS idx_account_report_map_category ON account_report_map (category_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON account_report_map TO service_role;
GRANT SELECT ON account_report_map TO authenticated;
DROP TRIGGER IF EXISTS trg_account_report_map_updated_at ON account_report_map;
CREATE TRIGGER trg_account_report_map_updated_at BEFORE UPDATE ON account_report_map
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

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
  IF a.account_type NOT IN ('revenue', 'expense') OR a.account_type <> c.section THEN
    RAISE EXCEPTION 'account % is %; it cannot present under the % category "%"', a.account_number, a.account_type, c.section, c.name;
  END IF;
  RETURN NEW;
END;
$fn$;

-- 3) Audit log (append-only) --------------------------------------------------
CREATE TABLE IF NOT EXISTS report_mapping_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  entity       text NOT NULL CHECK (entity IN ('category', 'account_map')),
  entity_id    uuid NOT NULL,
  account_id   uuid,
  action       text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  old_row      jsonb,
  new_row      jsonb,
  actor        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE report_mapping_events IS 'association_record: every change to report categories and account mappings, who and when. Append-only.';
CREATE INDEX IF NOT EXISTS idx_report_mapping_events_community ON report_mapping_events (community_id, created_at);
CREATE INDEX IF NOT EXISTS idx_report_mapping_events_account ON report_mapping_events (account_id, created_at);
GRANT SELECT, INSERT ON report_mapping_events TO service_role;
GRANT SELECT ON report_mapping_events TO authenticated;

CREATE OR REPLACE FUNCTION report_mapping_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'report mapping events are permanent (event %)', OLD.id;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_report_mapping_events_append_only ON report_mapping_events;
CREATE TRIGGER trg_report_mapping_events_append_only BEFORE UPDATE OR DELETE ON report_mapping_events
  FOR EACH ROW EXECUTE FUNCTION report_mapping_events_append_only();

CREATE OR REPLACE FUNCTION report_mapping_log() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE r record; actor text;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  actor := coalesce(nullif(current_setting('trusted.actor', true), ''), CASE WHEN TG_OP = 'DELETE' THEN OLD.updated_by ELSE NEW.updated_by END);
  -- An update that changes nothing but the timestamp is not a change.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at' - 'updated_by') = (to_jsonb(OLD) - 'updated_at' - 'updated_by') THEN RETURN NEW; END IF;
  INSERT INTO report_mapping_events (community_id, entity, entity_id, account_id, action, old_row, new_row, actor)
  VALUES (r.community_id,
          CASE WHEN TG_TABLE_NAME = 'report_categories' THEN 'category' ELSE 'account_map' END,
          r.id,
          CASE WHEN TG_TABLE_NAME = 'account_report_map' THEN (to_jsonb(r) ->> 'account_id')::uuid END,
          lower(TG_OP),
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
          actor);
  RETURN r;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_report_categories_validate ON report_categories;
CREATE TRIGGER trg_report_categories_validate BEFORE INSERT OR UPDATE OR DELETE ON report_categories
  FOR EACH ROW EXECUTE FUNCTION report_categories_validate();
DROP TRIGGER IF EXISTS trg_report_categories_log ON report_categories;
CREATE TRIGGER trg_report_categories_log AFTER INSERT OR UPDATE ON report_categories
  FOR EACH ROW EXECUTE FUNCTION report_mapping_log();
DROP TRIGGER IF EXISTS trg_account_report_map_validate ON account_report_map;
CREATE TRIGGER trg_account_report_map_validate BEFORE INSERT OR UPDATE ON account_report_map
  FOR EACH ROW EXECUTE FUNCTION account_report_map_validate();
DROP TRIGGER IF EXISTS trg_account_report_map_log ON account_report_map;
CREATE TRIGGER trg_account_report_map_log AFTER INSERT OR UPDATE OR DELETE ON account_report_map
  FOR EACH ROW EXECUTE FUNCTION report_mapping_log();

-- 4) The mapping write path (bulk, with actor). p_category_id NULL = unmap.
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
    INSERT INTO account_report_map (community_id, account_id, statement, category_id, updated_by)
    SELECT p_community_id, x.id, p_statement, p_category_id, btrim(p_actor) FROM unnest(p_account_ids) x(id)
    ON CONFLICT (account_id, statement) DO UPDATE SET category_id = EXCLUDED.category_id, updated_by = EXCLUDED.updated_by
      WHERE account_report_map.category_id IS DISTINCT FROM EXCLUDED.category_id;
    GET DIAGNOSTICS n_changed = ROW_COUNT;
  END IF;
  PERFORM set_config('trusted.actor', '', true);
  RETURN jsonb_build_object('changed', n_changed, 'unmapped', n_removed);
END;
$$;
REVOKE ALL ON FUNCTION set_account_report_category(uuid, uuid[], uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_account_report_category(uuid, uuid[], uuid, text, text) TO service_role;

-- 5) Seed: Lakes of Pine Forest only (approved map, embedded verbatim).
DO $seed$
DECLARE
  spec jsonb := $spec$${spec}$spec$::jsonb;
  cid uuid; cat jsonb; sub jsonb; acct text; top_id uuid; sub_id uuid; aid uuid; ci int := 0; si int;
BEGIN
  SELECT id INTO cid FROM communities WHERE name = spec->>'community_name';
  IF cid IS NULL THEN RAISE EXCEPTION 'seed community % not found', spec->>'community_name'; END IF;
  IF EXISTS (SELECT 1 FROM report_categories WHERE community_id = cid) THEN
    RAISE NOTICE 'LOPF report categories already present; seed skipped';
    RETURN;
  END IF;
  PERFORM set_config('trusted.actor', 'migration 463 (approved LOPF map)', true);
  FOR cat IN SELECT * FROM jsonb_array_elements(spec->'categories') LOOP
    ci := ci + 10;
    INSERT INTO report_categories (community_id, statement, section, name, report_label, display_order, updated_by)
    VALUES (cid, spec->>'statement', cat->>'section', cat->>'name', cat->>'report_label', ci, 'migration 463')
    RETURNING id INTO top_id;
    si := 0;
    FOR sub IN SELECT * FROM jsonb_array_elements(cat->'subcategories') LOOP
      si := si + 10;
      INSERT INTO report_categories (community_id, statement, section, name, report_label, parent_category_id, display_order, updated_by)
      VALUES (cid, spec->>'statement', cat->>'section', sub->>'name', sub->>'report_label', top_id, si, 'migration 463')
      RETURNING id INTO sub_id;
      FOR acct IN SELECT * FROM jsonb_array_elements_text(sub->'accounts') LOOP
        SELECT id INTO aid FROM chart_of_accounts WHERE community_id = cid AND account_number = acct;
        IF aid IS NULL THEN RAISE EXCEPTION 'seed account % not found at LOPF', acct; END IF;
        INSERT INTO account_report_map (community_id, account_id, statement, category_id, updated_by)
        VALUES (cid, aid, spec->>'statement', sub_id, 'migration 463');
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config('trusted.actor', '', true);
END
$seed$;

-- 6) Guards -------------------------------------------------------------------
DO $guard$
DECLARE b record; cid uuid; n_top int; n_sub int; n_map int; n_unmapped int; n_ev int;
BEGIN
  SELECT * INTO b FROM _m463_before;
  IF b.coa_h <> (SELECT md5(coalesce(string_agg(id::text || account_number || account_name || account_type || coalesce(fund_id::text, '') || coalesce(parent_account_id::text, '') || is_summary::text || is_active::text, '|' ORDER BY id), '')) FROM chart_of_accounts) THEN RAISE EXCEPTION 'guard: chart of accounts changed'; END IF;
  IF b.je_h <> (SELECT md5(coalesce(string_agg(id::text || status || total_debits_cents::text || total_credits_cents::text, ',' ORDER BY id), '')) FROM journal_entries) THEN RAISE EXCEPTION 'guard: journal entries changed'; END IF;
  IF b.jel_h <> (SELECT count(*)::text || ':' || coalesce(sum(debit_cents), 0)::text || ':' || coalesce(sum(credit_cents), 0)::text FROM journal_entry_lines) THEN RAISE EXCEPTION 'guard: journal lines changed'; END IF;
  IF b.bl_h <> (SELECT md5(coalesce(string_agg(id::text || budget_id::text || account_id::text || coalesce(fund_id::text, '') || annual_amount_cents::text || array_to_string(monthly_amounts_cents, ','), '|' ORDER BY id), '')) FROM budget_line_items)
  OR b.bh_h <> (SELECT md5(coalesce(string_agg(id::text || status || fiscal_year::text, '|' ORDER BY id), '')) FROM community_budgets) THEN RAISE EXCEPTION 'guard: budgets changed'; END IF;
  SELECT id INTO cid FROM communities WHERE name = 'Lakes of Pine Forest';
  SELECT count(*) FILTER (WHERE parent_category_id IS NULL), count(*) FILTER (WHERE parent_category_id IS NOT NULL) INTO n_top, n_sub FROM report_categories WHERE community_id = cid;
  SELECT count(*) INTO n_map FROM account_report_map WHERE community_id = cid;
  SELECT count(*) INTO n_unmapped FROM chart_of_accounts a WHERE a.community_id = cid AND a.account_type IN ('revenue', 'expense')
    AND NOT EXISTS (SELECT 1 FROM account_report_map m WHERE m.account_id = a.id AND m.statement = 'income_statement');
  IF n_top <> 10 OR n_sub <> 51 THEN RAISE EXCEPTION 'guard: expected 10 categories / 51 subcategories, got % / %', n_top, n_sub; END IF;
  IF n_map <> 54 OR n_unmapped <> 0 THEN RAISE EXCEPTION 'guard: expected 54 mapped / 0 unmapped, got % / %', n_map, n_unmapped; END IF;
  IF EXISTS (SELECT 1 FROM report_categories WHERE community_id <> cid) OR EXISTS (SELECT 1 FROM account_report_map WHERE community_id <> cid) THEN RAISE EXCEPTION 'guard: another community was seeded'; END IF;
  SELECT count(*) INTO n_ev FROM report_mapping_events WHERE community_id = cid;
  IF n_ev <> 115 THEN RAISE EXCEPTION 'guard: expected 115 audit events, got %', n_ev; END IF;
  --@@END@@
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';
`;
fs.writeFileSync(path.join(__dirname, '..', 'migrations', '463_report_categories.sql'), sql);
console.log('wrote migrations/463_report_categories.sql', sql.length, 'bytes');
