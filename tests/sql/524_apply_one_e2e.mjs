// tests/sql/524_apply_one_e2e.mjs — migration 524 (unidentified receipts account) applied END TO END
// through the single-migration tool with its REAL checks file: every operational community with a
// 2400 gets 2420 Unidentified Receipts (Suspense) in the same fund and the unidentified_receipts role;
// archived and prospect communities are untouched; the role guard accepts a liability for that role
// only; journal entries and homeowner ledgers are unchanged; an existing 2420 stops the plan. PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  524 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '524_unidentified_receipts_account.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm524-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
// five operational communities with a 2400, one archived, one prospect, one active without a 2400
const C = { a: 'c0000000-0000-4000-8000-00000000000a', b: 'c0000000-0000-4000-8000-00000000000b', c: 'c0000000-0000-4000-8000-00000000000c', d: 'c0000000-0000-4000-8000-00000000000d', e: 'c0000000-0000-4000-8000-00000000000e', arch: 'c0000000-0000-4000-8000-0000000000f1', pros: 'c0000000-0000-4000-8000-0000000000f2', none: 'c0000000-0000-4000-8000-0000000000f3' };
async function world({ drift = false } = {}) {
  const db = new PGlite();
  const comms = [['a', 'active'], ['b', 'active'], ['c', 'onboarding'], ['d', 'terminating'], ['e', 'active'], ['arch', 'archived'], ['pros', 'prospect'], ['none', 'active']];
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, management_status text, management_end_date date);
    CREATE TABLE account_funds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, fund_code text);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, fund_id uuid, account_number text, account_name text, account_type text, account_subtype text, normal_balance text, is_active boolean, is_summary boolean, description text);
    CREATE TABLE community_account_roles (community_id uuid NOT NULL, role text NOT NULL, account_id uuid NOT NULL, updated_by text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), PRIMARY KEY (community_id, role),
      CONSTRAINT community_account_roles_role_check CHECK (role IN ('operating_cash', 'stripe_clearing', 'homeowner_ar', 'undeposited_funds')));
    CREATE OR REPLACE FUNCTION community_account_roles_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
    DECLARE a chart_of_accounts%ROWTYPE;
    BEGIN
      SELECT * INTO a FROM chart_of_accounts WHERE id = NEW.account_id;
      IF NOT FOUND OR a.community_id <> NEW.community_id THEN RAISE EXCEPTION 'account % is not in community %', NEW.account_id, NEW.community_id; END IF;
      IF a.is_summary OR NOT a.is_active THEN RAISE EXCEPTION 'account % must be active and postable for role %', a.account_number, NEW.role; END IF;
      IF a.account_type <> 'asset' OR a.normal_balance <> 'debit' THEN RAISE EXCEPTION 'role % needs a debit-normal asset account (% is %/%)', NEW.role, a.account_number, a.account_type, a.normal_balance; END IF;
      NEW.updated_at := now(); RETURN NEW;
    END $$;
    CREATE TRIGGER trg_community_account_roles_guard BEFORE INSERT OR UPDATE ON community_account_roles FOR EACH ROW EXECUTE FUNCTION community_account_roles_guard();
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
    CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount_cents bigint);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('514_homeowner_check_receipts.sql', 'recorded');
    INSERT INTO journal_entries (reference) VALUES ('JE-1'); INSERT INTO homeowner_transactions (amount_cents) VALUES (100);`);
  for (const [k, st] of comms) {
    await db.exec(`INSERT INTO communities VALUES ('${C[k]}', '${st}', ${k === 'arch' ? "'2026-09-30'" : 'NULL'}); INSERT INTO account_funds (community_id, fund_code) VALUES ('${C[k]}', 'OPR');`);
    if (k !== 'none') await db.exec(`INSERT INTO chart_of_accounts (community_id, fund_id, account_number, account_name, account_type, account_subtype, normal_balance, is_active, is_summary)
      SELECT '${C[k]}', id, '2400', 'Prepaid Owners Assessments', 'liability', 'current_liability', 'credit', true, false FROM account_funds WHERE community_id = '${C[k]}';`);
  }
  if (drift) await db.exec(`INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, is_active, is_summary) VALUES ('${C.a}', '2420', 'Something else', 'liability', 'credit', true, false);`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const ctx = (client) => ({ client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await world();
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
check('apply: 524 applied and verified', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 2000));
if (r.status === 'applied') {
  const rows = (await db.query(`SELECT s.community_id, s.account_type, s.normal_balance, s.account_subtype, s.fund_id = p.fund_id AS same_fund FROM chart_of_accounts s JOIN chart_of_accounts p ON p.community_id = s.community_id AND p.account_number = '2400' WHERE s.account_number = '2420'`)).rows;
  check('2420 in the five operational communities, liability/credit, same fund and subtype as 2400', rows.length === 5 && rows.every((x) => x.account_type === 'liability' && x.normal_balance === 'credit' && x.account_subtype === 'current_liability' && x.same_fund), JSON.stringify(rows));
  check('archived, prospect and no-2400 communities untouched', !rows.some((x) => [C.arch, C.pros, C.none].includes(x.community_id)));
  const roles = (await db.query(`SELECT count(*)::int AS n FROM community_account_roles r JOIN chart_of_accounts a ON a.id = r.account_id WHERE r.role = 'unidentified_receipts' AND a.account_number = '2420'`)).rows[0].n;
  check('five unidentified_receipts roles, each on its own 2420', roles === 5);
  let refused = false; try { await db.query(`INSERT INTO community_account_roles (community_id, role, account_id, updated_by) SELECT community_id, 'operating_cash', id, 't' FROM chart_of_accounts WHERE community_id = '${C.none}' LIMIT 0`); await db.exec(`INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, is_active, is_summary) VALUES ('${C.none}', '2999', 'L', 'liability', 'credit', true, false); INSERT INTO community_account_roles (community_id, role, account_id, updated_by) SELECT '${C.none}', 'operating_cash', id, 't' FROM chart_of_accounts WHERE account_number = '2999';`); } catch (_) { refused = true; }
  check('guard: other roles still refuse a liability', refused);
  let assetRefused = false; try { await db.exec(`INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance, is_active, is_summary) VALUES ('${C.none}', '1999', 'A', 'asset', 'debit', true, false); INSERT INTO community_account_roles (community_id, role, account_id, updated_by) SELECT '${C.none}', 'unidentified_receipts', id, 't' FROM chart_of_accounts WHERE account_number = '1999';`); } catch (_) { assetRefused = true; }
  check('guard: unidentified_receipts refuses an asset account', assetRefused);
  const again = await A.planMigration({ ...ctx(client), filename: F });
  check('re-running is refused (already applied)', again.status !== 'ready' || !again.plan_token);
}
const d = await world({ drift: true });
const p2 = await A.planMigration({ ...ctx(d.client), filename: F });
check('drift: an existing 2420 stops the plan (no token)', p2.status !== 'ready' && !p2.plan_token, JSON.stringify({ status: p2.status }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
