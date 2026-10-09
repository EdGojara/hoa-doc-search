// tests/sql/505_balance_sheet_categories_e2e.mjs — balance-sheet report categories (PR C) on the REAL SQL.
// The real 463 (report categories, minus its LOPF-only seed) is applied, an income-statement mapping
// is written the 463 way, then 505 is applied through the single-migration tool with its real checks
// file, and: existing mappings are grandfathered explicitly (who / when recorded, audited, category
// unchanged); new mappings default to 'proposed' and nothing is approved by omission; the
// statement / section / account-type rules; proposed vs approved (who and when); the approve path and
// its audit trail; the assign path returning 463's keys; and the owner override being append-only,
// snapshot-bound and closed to anon / authenticated.
// Postgres 17 (PGlite). Skips without PGlite. --print-objects prints 505's catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  505 balance-sheet categories rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const C = '00000000-0000-0000-0000-0000000000c1';
const OTHER = '00000000-0000-0000-0000-0000000000c2';
const world = await onboardingWorld(PGlite, { through: 452, gl: true });
const { db, rpc } = world;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

await db.exec(`
  ALTER TABLE chart_of_accounts ADD COLUMN account_type text, ADD COLUMN account_name text, ADD COLUMN parent_account_id uuid, ADD COLUMN is_summary boolean NOT NULL DEFAULT false, ADD COLUMN is_active boolean NOT NULL DEFAULT true;
  CREATE TABLE board_packets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid REFERENCES communities(id));
  INSERT INTO communities (id, name) VALUES ('${OTHER}', 'Other Place');
  INSERT INTO chart_of_accounts (id, community_id, account_number, account_type, account_name) VALUES
    ('00000000-0000-0000-0000-0000000a1000', '${C}', '1000', 'asset', 'Operating Checking'),
    ('00000000-0000-0000-0000-0000000a1405', '${C}', '1405', 'asset', 'Utility Deposits'),
    ('00000000-0000-0000-0000-0000000a2000', '${C}', '2000', 'liability', 'Accounts Payable'),
    ('00000000-0000-0000-0000-0000000a3050', '${C}', '3050', 'equity', 'Accumulated Fund Balance'),
    ('00000000-0000-0000-0000-0000000a4000', '${C}', '4000', 'revenue', 'Assessment Income'),
    ('00000000-0000-0000-0000-0000000b1000', '${OTHER}', '1000', 'asset', 'Other Checking');`);
// The real 463 without its seed (it names Lakes of Pine Forest's accounts) and its before/after guard
// (it hashes tables this world does not carry).
const sql463 = lf(`${REPO}/migrations/463_report_categories.sql`).replace(/CREATE TEMP TABLE _m463_before[\s\S]*?;\n/, '').replace(/DO \$seed\$[\s\S]*?\$seed\$;/, '').replace(/DO \$guard\$[\s\S]*?\$guard\$;/, '');
await db.exec(sql463);
await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('463_report_categories.sql', 'recorded')`);
const A1000 = '00000000-0000-0000-0000-0000000a1000', A1405 = '00000000-0000-0000-0000-0000000a1405', A2000 = '00000000-0000-0000-0000-0000000a2000';
const A3050 = '00000000-0000-0000-0000-0000000a3050', A4000 = '00000000-0000-0000-0000-0000000a4000', B1000 = '00000000-0000-0000-0000-0000000b1000';
const rev = (await one(`INSERT INTO report_categories (community_id, section, name, updated_by) VALUES ($1, 'revenue', 'Assessments', 'ed') RETURNING id`, [C])).id;
await rpc('set_account_report_category', { p_community_id: C, p_account_ids: `{${A4000}}`, p_category_id: rev, p_actor: 'ed' });
const before = await one(`SELECT to_jsonb(m) AS j FROM account_report_map m WHERE account_id = $1`, [A4000]);

// ------------------------------------------------------------------- apply 505 through the tool
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig505-'));
fs.mkdirSync(path.join(dir, 'checks'));
const F = '505_balance_sheet_report_categories.sql';
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
// The real checks file, with its two production-specific counts (54 income-statement mappings to
// grandfather, 54 audit rows) set to this world's: one mapping.
const checks505 = JSON.parse(lf(`${REPO}/migrations/checks/505_balance_sheet_report_categories.json`));
const pin = checks505.preflight.find((x) => /mappings to grandfather/.test(x.name));
check('the checks file pins the production count it grandfathers, and declares one audit row per mapping', pin && pin.expect === 54 && checks505.row_changes.report_mapping_events === 54);
const worldN = Number((await one(`SELECT count(*)::int AS n FROM account_report_map WHERE statement = 'income_statement'`)).n);
pin.expect = worldN; checks505.row_changes.report_mapping_events = worldN;
fs.writeFileSync(path.join(dir, 'checks', '505_balance_sheet_report_categories.json'), JSON.stringify(checks505, null, 2));
const reqs = JSON.parse(lf(`${REPO}/migrations/checks/505_balance_sheet_report_categories.json`)).requires;
check('every prerequisite named by the 505 checks file is a real migration file', reqs.every((x) => fs.existsSync(`${REPO}/migrations/${x}`)));
const ctxA = { client: world.client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctxA, filename: F });
const applied = await A.applyMigration({ ...ctxA, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
if (PRINT) { console.log(JSON.stringify((applied.detail || {}).objects || applied, null, 2)); process.exit(0); }
check('505 planned (preflight passes) and applied + verified through the tool with its real checks file', plan.status === 'ready' && applied.status === 'applied',
  JSON.stringify({ plan: plan.status, pre: plan.preflight, err: plan.error, r: applied.status, e: applied.error }).slice(0, 2000));
if (applied.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
check('protected tables unchanged; no mapping, category or account added or removed; one audit row per grandfathered mapping', applied.detail.protected.every((p) => p.unchanged)
  && ['report_categories', 'account_report_map', 'chart_of_accounts'].every((t) => applied.detail.row_changes[t] === 0) && applied.detail.row_changes.report_mapping_events === worldN, JSON.stringify(applied.detail.row_changes));
const after = await one(`SELECT to_jsonb(m) AS j FROM account_report_map m WHERE account_id = $1`, [A4000]);
const keep = ['id', 'community_id', 'account_id', 'statement', 'category_id', 'display_order', 'updated_by', 'created_at'];
check('grandfathering: the pre-505 mapping keeps its account, statement and category', keep.every((k) => JSON.stringify(after.j[k]) === JSON.stringify(before.j[k])), JSON.stringify({ before: before.j, after: after.j }));
check('grandfathering: approved EXPLICITLY, with who (its recorded setter, marked) and when (when it was last set)', after.j.approval_status === 'approved'
  && after.j.approved_by === 'ed (grandfathered by migration 505)' && new Date(after.j.approved_at).getTime() === new Date(before.j.updated_at).getTime(), JSON.stringify(after.j));
const gev = await one(`SELECT actor, new_row->>'approval_status' AS n FROM report_mapping_events WHERE account_id = $1 AND action = 'update' ORDER BY created_at DESC LIMIT 1`, [A4000]);
check('grandfathering: logged by the 463 audit trail, attributed to the migration', gev && gev.n === 'approved' && /migration 505/.test(gev.actor), JSON.stringify(gev));
check('the column default is proposed (not approved)', /proposed/.test((await one(`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'account_report_map' AND column_name = 'approval_status'`)).d));

// ------------------------------------------------------------------- categories
const cat = async (statement, section, name) => (await one(`INSERT INTO report_categories (community_id, statement, section, name, updated_by) VALUES ($1, $2, $3, $4, 'ed') RETURNING id`, [C, statement, section, name])).id;
const cash = await cat('balance_sheet', 'asset', 'Cash & cash equivalents');
const other = await cat('balance_sheet', 'asset', 'Other assets');
const ap = await cat('balance_sheet', 'liability', 'Accounts payable');
check('a balance-sheet category may be asset / liability / equity', !!(cash && ap && await cat('balance_sheet', 'equity', 'Fund balance')));
check('a balance-sheet category cannot be revenue', /section_check/.test(await code(() => cat('balance_sheet', 'revenue', 'Nope')) || ''));
check('an income-statement category cannot be an asset', /section_check/.test(await code(() => cat('income_statement', 'asset', 'Nope')) || ''));
check('an unknown statement is refused', /statement_check|section_check/.test(await code(() => cat('cash_flow', 'asset', 'Nope')) || ''));

// ------------------------------------------------------------------- mappings
const map = (acct, catId, status, by = null, at = null) => db.query(`INSERT INTO account_report_map (community_id, account_id, statement, category_id, updated_by, approval_status, approved_by, approved_at) VALUES ($1, $2, 'balance_sheet', $3, 'system', $4, $5, $6)`, [C, acct, catId, status, by, at]);
check('a PROPOSED balance-sheet mapping needs no approver', !(await code(() => map(A1405, other, 'proposed'))));
await db.query(`INSERT INTO account_report_map (community_id, account_id, statement, category_id, updated_by) VALUES ($1, $2, 'balance_sheet', $3, 'system')`, [C, A2000, ap]);
check('an insert that omits approval_status is PROPOSED, never approved', (await one(`SELECT approval_status AS s, approved_by AS b FROM account_report_map WHERE account_id = $1 AND statement = 'balance_sheet'`, [A2000])).s === 'proposed');
const revOther = (await one(`INSERT INTO report_categories (community_id, section, name, updated_by) VALUES ($1, 'revenue', 'Other revenue', 'ed') RETURNING id`, [C])).id;
await db.query(`INSERT INTO chart_of_accounts (id, community_id, account_number, account_type, account_name) VALUES ('00000000-0000-0000-0000-0000000a4100', $1, '4100', 'revenue', 'Late Fees')`, [C]);
await db.query(`INSERT INTO account_report_map (community_id, account_id, statement, category_id) VALUES ($1, '00000000-0000-0000-0000-0000000a4100', 'income_statement', $2)`, [C, revOther]);
check('the same holds for a new income-statement mapping (defaults to proposed)', (await one(`SELECT approval_status AS s FROM account_report_map WHERE account_id = '00000000-0000-0000-0000-0000000a4100'`)).s === 'proposed');
check('an APPROVED income-statement mapping without who / when is refused too', /who approved it/.test(await code(() => db.query(`UPDATE account_report_map SET approval_status = 'approved' WHERE account_id = '00000000-0000-0000-0000-0000000a4100'`)) || ''));
check('an approved mapping cannot lose its approver', /who approved it/.test(await code(() => db.query(`UPDATE account_report_map SET approved_by = NULL WHERE account_id = $1`, [A4000])) || ''));
check('an APPROVED balance-sheet mapping without who / when is refused', /who approved it/.test(await code(() => map(A1000, cash, 'approved')) || ''));
check('a revenue account cannot present on the balance sheet', /cannot present/.test(await code(() => map(A4000, cash, 'proposed')) || ''));
check('an asset account cannot present under a liability category', /cannot present/.test(await code(() => map(A1000, ap, 'proposed')) || ''));
check('an equity account cannot present under an asset category', /cannot present/.test(await code(() => map(A3050, cash, 'proposed')) || ''));
check('an unknown approval status is refused', /approval_status_check/.test(await code(() => db.query(`UPDATE account_report_map SET approval_status = 'maybe' WHERE account_id = $1 AND statement = 'balance_sheet'`, [A2000])) || ''));
check('another community\'s account cannot map to this community\'s category', /same community/.test(await code(() => db.query(`INSERT INTO account_report_map (community_id, account_id, statement, category_id, approval_status) VALUES ($1, $2, 'balance_sheet', $3, 'proposed')`, [C, B1000, cash])) || ''));
check('approve: anon and authenticated cannot execute approve_account_report_map', (await one(`SELECT has_function_privilege('anon', 'approve_account_report_map(uuid, uuid[], text, text)', 'EXECUTE') AS a, has_function_privilege('authenticated', 'approve_account_report_map(uuid, uuid[], text, text)', 'EXECUTE') AS b`)).a === false);
check('approve: an approval needs who is making it', /who is making it/.test(await code(() => rpc('approve_account_report_map', { p_community_id: C, p_account_ids: `{${A1405}}`, p_actor: ' ' })) || ''));
const n0 = await rpc('approve_account_report_map', { p_community_id: OTHER, p_account_ids: `{${A1405}}`, p_actor: 'ed' });
check('approve: scoped to the community (another community approves nothing)', n0.approved === 0);
const n1 = await rpc('approve_account_report_map', { p_community_id: C, p_account_ids: `{${A1405}}`, p_actor: 'ed@bedrock' });
const r1405 = await one(`SELECT approval_status, approved_by, approved_at, category_id FROM account_report_map WHERE account_id = $1 AND statement = 'balance_sheet'`, [A1405]);
check('approve: the proposal becomes approved as proposed, with who and when', n1.approved === 1 && r1405.approval_status === 'approved' && r1405.approved_by === 'ed@bedrock' && r1405.approved_at && r1405.category_id === other);
const ev = await one(`SELECT actor, old_row->>'approval_status' AS o, new_row->>'approval_status' AS n FROM report_mapping_events WHERE account_id = $1 AND action = 'update' ORDER BY created_at DESC LIMIT 1`, [A1405]);
check('approve: the 463 audit trail records the approval and who made it', ev && ev.actor === 'ed@bedrock' && ev.o === 'proposed' && ev.n === 'approved');
check('approve: approving again changes nothing', (await rpc('approve_account_report_map', { p_community_id: C, p_account_ids: `{${A1405}}`, p_actor: 'ed' })).approved === 0);
const s1 = await rpc('set_account_report_category', { p_community_id: C, p_account_ids: `{${A1000}}`, p_category_id: cash, p_actor: 'staff@bedrock', p_statement: 'balance_sheet' });
const r1000 = await one(`SELECT approval_status, approved_by FROM account_report_map WHERE account_id = $1 AND statement = 'balance_sheet'`, [A1000]);
check('assign: a person assigning a balance-sheet category approves it (who recorded)', s1.changed === 1 && r1000.approval_status === 'approved' && r1000.approved_by === 'staff@bedrock');
const s2 = await rpc('set_account_report_category', { p_community_id: C, p_account_ids: `{${A1000}}`, p_category_id: null, p_actor: 'staff@bedrock', p_statement: 'balance_sheet' });
check('assign: unmapping returns 463\'s keys (changed / unmapped)', s2.unmapped === 1 && 'changed' in s2 && !('removed' in s2));
const s3 = await rpc('set_account_report_category', { p_community_id: C, p_account_ids: `{${A4000}}`, p_category_id: rev, p_actor: 'ed' });
check('assign: the income-statement path is unchanged (re-assigning the same category is not a change)', s3.changed === 0);
check('assign: the actor setting does not leak past the call', (await one(`SELECT coalesce(current_setting('trusted.actor', true), '') AS a`)).a === '');

// ------------------------------------------------------------------- owner overrides
const SHA = 'a'.repeat(64);
const pk = (await one(`INSERT INTO board_packets (community_id) VALUES ($1) RETURNING id`, [C])).id;
const ovr = (o = {}) => db.query(`INSERT INTO statement_mapping_overrides (community_id, packet_id, section_key, snapshot_sha256, unmapped_accounts, reason, owner_actor) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
  [C, pk, o.section || 'balance_sheet', o.sha || SHA, JSON.stringify(o.accts || [{ account_number: '1415' }]), o.reason || 'Escrow account classification pending CPA review', o.actor || 'Ed Gojara (owner)']);
check('override: recorded with the snapshot it was made on', !(await code(() => ovr())));
check('override: a reason under 10 characters is refused', /reason_check/.test(await code(() => ovr({ reason: 'ok' })) || ''));
check('override: a malformed snapshot hash is refused', /sha_check/.test(await code(() => ovr({ sha: 'nothex' })) || ''));
check('override: cannot be changed', /permanent/.test(await code(() => db.query(`UPDATE statement_mapping_overrides SET reason = 'something else entirely'`)) || ''));
check('override: cannot be deleted', /permanent/.test(await code(() => db.query(`DELETE FROM statement_mapping_overrides`)) || ''));
check('override: a board packet with an override cannot be deleted out from under it', /foreign key|violates/.test(await code(() => db.query(`DELETE FROM board_packets WHERE id = $1`, [pk])) || ''));
const priv = await one(`SELECT has_table_privilege('anon', 'statement_mapping_overrides', 'SELECT') AS a, has_table_privilege('authenticated', 'statement_mapping_overrides', 'SELECT') AS b, has_table_privilege('service_role', 'statement_mapping_overrides', 'UPDATE') AS u`);
check('override: anon / authenticated cannot read it; service_role cannot update it', priv.a === false && priv.b === false && priv.u === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
