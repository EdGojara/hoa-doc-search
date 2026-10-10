// tests/sql/506_working_forecasts_e2e.mjs — working forecast persistence on the REAL SQL.
// 506 is applied through the single-migration tool with its real checks file, then: the base
// budget must be the community's approved base-year budget; decisions need a written assumption /
// reason and a valid model hash; decisions are append-only; forecast, account and decision must be
// the same community; one working forecast per community / year; anon / authenticated get nothing.
// Postgres 17 (PGlite). Skips without PGlite. --print-objects prints 506's catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  506 working forecasts rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const C = '00000000-0000-0000-0000-0000000000c1', OTHER = '00000000-0000-0000-0000-0000000000c2';
const world = await onboardingWorld(PGlite, { through: 452, gl: true });
const { db } = world;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
await db.exec(`
  CREATE TABLE community_budgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), fiscal_year int NOT NULL, status text NOT NULL);
  CREATE TABLE budget_line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), budget_id uuid REFERENCES community_budgets(id), account_id uuid, annual_amount_cents bigint);
  CREATE TABLE library_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, title text);
  CREATE TABLE vendor_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid, community_id uuid REFERENCES communities(id), vendor_name_raw text,
    service_category text, effective_date date, end_date date, file_path text, file_hash text, status text NOT NULL DEFAULT 'active', notes text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  INSERT INTO communities (id, name) VALUES ('${OTHER}', 'Other');
  INSERT INTO account_funds (id, community_id, fund_code) VALUES ('00000000-0000-0000-0000-00000000f0f1', '${C}', 'OPR');
  INSERT INTO chart_of_accounts (id, community_id, account_number, fund_id) VALUES ('00000000-0000-0000-0000-0000000a5770', '${C}', '5770', '00000000-0000-0000-0000-00000000f0f1'),
    ('00000000-0000-0000-0000-0000000b5770', '${OTHER}', '5770', null);`);
const B26 = (await one(`INSERT INTO community_budgets (community_id, fiscal_year, status) VALUES ($1, 2026, 'approved') RETURNING id`, [C])).id;
const BDRAFT = (await one(`INSERT INTO community_budgets (community_id, fiscal_year, status) VALUES ($1, 2026, 'draft') RETURNING id`, [C])).id;
await db.query(`INSERT INTO budget_line_items (budget_id, account_id, annual_amount_cents) VALUES ($1, '00000000-0000-0000-0000-0000000a5770', 23500000)`, [B26]);
await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('171_budgets_and_fs.sql', 'recorded'), ('015_vendor_storage_benchmarking.sql', 'recorded') ON CONFLICT DO NOTHING`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig506-'));
fs.mkdirSync(path.join(dir, 'checks'));
const F = '506_working_forecasts.sql';
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', '506_working_forecasts.json'), lf(`${REPO}/migrations/checks/506_working_forecasts.json`));
const ctxA = { client: world.client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctxA, filename: F });
const applied = await A.applyMigration({ ...ctxA, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
if (PRINT) { console.log(JSON.stringify((applied.detail || {}).objects || applied, null, 2)); process.exit(0); }
check('506 planned and applied + verified through the tool with its real checks file', plan.status === 'ready' && applied.status === 'applied', JSON.stringify({ p: plan.status, pre: plan.preflight, e: plan.error, r: applied.status, err: applied.error }).slice(0, 1500));
if (applied.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
check('no existing row changed (budgets protected; deltas 0)', applied.detail.protected.every((p) => p.unchanged) && Object.values(applied.detail.row_changes).every((v) => v === 0));

const mk = (budget, yr = 2027, base = 2026) => db.query(`INSERT INTO working_forecasts (community_id, fiscal_year, base_fiscal_year, base_budget_id, created_by) VALUES ($1, $2, $3, $4, 'ed') RETURNING id`, [C, yr, base, budget]);
check('a working forecast must be measured from an APPROVED base budget', /must be approved/.test(await code(() => mk(BDRAFT)) || ''));
check('the base year must be the year before the target', /years_check|base budget must be this community/.test(await code(() => mk(B26, 2027, 2025)) || ''));
const WF = (await mk(B26)).rows[0].id;
check('one working forecast per community / year', /uq_working_forecasts_one|duplicate/.test(await code(() => mk(B26)) || ''));
check('identity fields cannot change', /cannot change/.test(await code(() => db.query(`UPDATE working_forecasts SET fiscal_year = 2028 WHERE id = $1`, [WF])) || ''));
check('policy can be updated (assumptions)', !(await code(() => db.query(`UPDATE working_forecasts SET policy = '{"expense_inflation_pct": 3.5}'::jsonb, updated_by = 'ed' WHERE id = $1`, [WF]))));
const adj = (o = {}) => db.query(`INSERT INTO working_forecast_adjustments (forecast_id, community_id, account_id, driver, amount_cents, assumption, confidence, source, actor, base_cents, base_as_of) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  [WF, o.community || C, o.account || '00000000-0000-0000-0000-0000000a5770', o.driver || 'contract', o.amount ?? 705000, o.assumption || 'Allied Universal renewal 3% escalator per signed contract', o.confidence || 'high', o.source || 'contract', 'ed',
    o.base === undefined ? null : o.base, o.base === undefined || o.base === null ? null : '2026-09-30']);
check('a driver adjustment with a written assumption is recorded', !(await code(() => adj())));
check('an adjustment without a real assumption is refused', /assumption_check/.test(await code(() => adj({ assumption: 'tbd' })) || ''));
check('a one-time removal must be negative (sign rule in the database)', /sign_check/.test(await code(() => adj({ driver: 'one_time', amount: 4000000, base: 4766500, assumption: 'Saifee monument sign project is one-time' })) || ''));
check('an omitted recurring amount must be positive (sign rule in the database)', /sign_check/.test(await code(() => adj({ driver: 'omitted_recurring', amount: -100, base: 4766500, assumption: 'Recurring pest control omitted from 2026' })) || ''));
check('a normalization must record the base and as-of it was made against', /base_check/.test(await code(() => adj({ driver: 'one_time', amount: -4000000, assumption: 'Saifee monument sign project is one-time' })) || ''));
check('a correctly signed normalization with its base is recorded', !(await code(() => adj({ driver: 'one_time', amount: -4000000, base: 4766500, assumption: 'Saifee monument sign project is one-time' }))));
check('an unknown driver is refused', /driver_check/.test(await code(() => adj({ driver: 'guess' })) || ''));
check('an account of another community is refused', /same community/.test(await code(() => adj({ account: '00000000-0000-0000-0000-0000000b5770' })) || ''));
check('adjustments are append-only (no update)', /permanent/.test(await code(() => db.query(`UPDATE working_forecast_adjustments SET amount_cents = 0`)) || ''));
check('adjustments are append-only (no delete)', /permanent/.test(await code(() => db.query(`DELETE FROM working_forecast_adjustments`)) || ''));
const ovr = (o = {}) => db.query(`INSERT INTO working_forecast_overrides (forecast_id, community_id, account_id, model_recommendation_cents, model_sha256, override_cents, reason, actor) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ed')`,
  [WF, C, '00000000-0000-0000-0000-0000000a5770', o.model ?? 10000000, o.sha || 'a'.repeat(64), o.value === undefined ? 9400000 : o.value, o.reason || 'Board expects security hours to drop after the gate upgrade']);
check('an override keeps the model value alongside the override and reason', !(await code(() => ovr())) && (await one(`SELECT model_recommendation_cents::bigint AS m, override_cents::bigint AS o FROM working_forecast_overrides`)).m == 10000000);
check('clearing an override is a new row with override NULL (history kept)', !(await code(() => ovr({ value: null, reason: 'Revert to the model after vendor quote came in' }))) && Number((await one(`SELECT count(*) AS n FROM working_forecast_overrides`)).n) === 2);
check('an override without a real reason is refused', /reason_check/.test(await code(() => ovr({ reason: 'no' })) || ''));
check('an override needs a valid model hash', /sha_check/.test(await code(() => ovr({ sha: 'x' })) || ''));
check('overrides are append-only', /permanent/.test(await code(() => db.query(`UPDATE working_forecast_overrides SET override_cents = 1`)) || ''));
check('working forecasts are not deleted', /not deleted/.test(await code(() => db.query(`DELETE FROM working_forecasts`)) || ''));
const priv = await one(`SELECT has_table_privilege('anon', 'working_forecast_adjustments', 'SELECT') AS a, has_table_privilege('authenticated', 'working_forecasts', 'SELECT') AS b, has_table_privilege('service_role', 'working_forecast_adjustments', 'UPDATE') AS u`);
check('anon / authenticated cannot read; service_role cannot update decisions', priv.a === false && priv.b === false && priv.u === false);

// ---------------------------------------------------------------- executed-contract evidence
const VC = (o = {}) => db.query(`INSERT INTO vendor_contracts (community_id, vendor_name_raw, effective_date, end_date, file_hash, execution_status, execution_confidence, execution_reason, periodic_amount, periodic_frequency, forecast_account_id, intake_source)
  VALUES ($1, 'Star Protection', '2026-01-01', '2027-12-31', $2, $3, $4, $5, 19583.33, 'monthly', $6, 'manual') RETURNING id`, [o.community || C, o.hash === undefined ? 'h1' : o.hash, o.status || 'likely_executed', o.conf ?? 0.8, o.reason || 'signature blocks present on page 7', o.account || null]);
check('a machine / upload path cannot create a contract already verified', /only through verify_vendor_contract/.test(await code(() => VC({ status: 'verified_executed' })) || ''));
const K = (await VC({ account: '00000000-0000-0000-0000-0000000a5770' })).rows[0].id;
check('a likely-executed contract with confidence and reason is recorded, bound to its GL account', Number((await one(`SELECT document_version AS v FROM vendor_contracts WHERE id = $1`, [K])).v) === 1);
check('a contract cannot drive another community\'s GL account', /forecast account must belong/.test(await code(() => VC({ account: '00000000-0000-0000-0000-0000000b5770' })) || ''));
check('an unknown execution status is refused', /execution_status_check/.test(await code(() => VC({ status: 'signed' })) || ''));
check('execution confidence must be 0..1', /execution_confidence_check/.test(await code(() => VC({ conf: 1.5 })) || ''));
check('a direct UPDATE to verified_executed is refused', /only through verify_vendor_contract/.test(await code(() => db.query(`UPDATE vendor_contracts SET execution_status = 'verified_executed', verified_by = 'x', verified_at = now(), verification_source = 'xxxxxxxxxxxx' WHERE id = $1`, [K])) || ''));
const vf = (h, who = 'egojara@bedrocktx.com', src = 'Signed by board president and vendor, dated 12/15/2025, page 7') => db.query(`SELECT verify_vendor_contract($1, $2, $3, $4) AS r`, [K, h, who, src]);
check('verification against a different document version is refused', /document changed since it was reviewed/.test(await code(() => vf('h-other')) || ''));
check('verification needs a basis', /needs its basis/.test(await code(() => vf('h1', 'ed', 'ok')) || ''));
check('a named person verifies against the exact document hash', !(await code(() => vf('h1'))));
const kv = await one(`SELECT execution_status, verified_by, verification_source, verified_at FROM vendor_contracts WHERE id = $1`, [K]);
check('verified_executed carries who, when and the basis', kv.execution_status === 'verified_executed' && kv.verified_by === 'egojara@bedrocktx.com' && /page 7/.test(kv.verification_source) && kv.verified_at);
check('the verification is in the append-only history', (await one(`SELECT count(*)::int AS n FROM vendor_contract_events WHERE vendor_contract_id = $1 AND event = 'verified' AND file_hash = 'h1'`, [K])).n === 1);
await db.query(`UPDATE vendor_contracts SET file_hash = 'h2' WHERE id = $1`, [K]);
const kr = await one(`SELECT execution_status, verified_by, document_version FROM vendor_contracts WHERE id = $1`, [K]);
check('replacing the document resets verification (back to likely_executed) and bumps the version', kr.execution_status === 'likely_executed' && kr.verified_by === null && Number(kr.document_version) === 2);
check('the document replacement is logged', (await one(`SELECT count(*)::int AS n FROM vendor_contract_events WHERE vendor_contract_id = $1 AND event = 'document_replaced'`, [K])).n === 1);
check('contract events are append-only', /permanent/.test(await code(() => db.query(`DELETE FROM vendor_contract_events`)) || ''));
check('only service_role may run verify_vendor_contract', (await one(`SELECT has_function_privilege('authenticated', 'verify_vendor_contract(uuid, text, text, text)', 'EXECUTE') AS a`)).a === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
