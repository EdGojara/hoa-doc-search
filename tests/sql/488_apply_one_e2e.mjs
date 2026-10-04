// tests/sql/488_apply_one_e2e.mjs — migration 488 (onboarding EXECUTE) applied END TO
// END through the single-migration tool with its REAL checks file, on top of 452-486
// and the accounting tables EXECUTE writes. Proves the apply changes no rows, the
// objects are exactly the declared ones, and the new path is closed by default:
// human only, nothing executes without an approved preflight, records are
// append-only. (The full execute behaviour is tests/sql/onboarding_execute_e2e.mjs.)
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  488 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '488_onboarding_execute.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm488-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client, rpc } = await onboardingWorld(PGlite, { through: 486, gl: true });
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes (incl. the accounting schema EXECUTE writes)', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, pre: plan.preflight }).slice(0, 900));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 488 applied and verified through the tool (objects exactly as declared, no row changes)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 900));
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
if (r.status === 'applied') {
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-APPLY', p_as_of: '2026-03-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  const c = await rpc('onboarding_record_completion', { p_batch: B, p_stage: 'intake', p_status: 'PASS', p_open: [], p_controls: [{ code: 'ok', label: 'ok', status: 'PASS' }], p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' });
  check('closed by default: an operator cannot execute (human only)', /only a human/.test(await err(() => rpc('onboarding_execute', { p_batch: B, p_completion: c, p_preflight_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' })) || ''));
  check('closed by default: a batch outside preflight cannot execute', /starts from the preflight stage/.test(await err(() => rpc('onboarding_execute', { p_batch: B, p_completion: c, p_preflight_sha256: 'a'.repeat(64), p_actor_kind: 'human', p_actor_id: 'ed' })) || ''));
  const f = await rpc('onboarding_record_execution_failure', { p_batch: B, p_completion: c, p_preflight_sha256: 'a'.repeat(64), p_error: 'rehearsal', p_actor_kind: 'human', p_actor_id: 'ed' });
  check('a failed attempt can be recorded, and the record is append-only', !!f && /append-only/.test(await err(() => db.query(`DELETE FROM onboarding_executions WHERE id = $1`, [f])) || ''));
  check('the 482 advance into execute is still refused', /EXECUTE is not available/.test(await err(() => rpc('onboarding_advance', { p_batch: B, p_completion: c, p_to: 'execute', p_actor_kind: 'human', p_actor_id: 'ed' })) || '')
    || /may only advance/.test(await err(() => rpc('onboarding_advance', { p_batch: B, p_completion: c, p_to: 'execute', p_actor_kind: 'human', p_actor_id: 'ed' })) || ''));
  check('no accounting row exists', (await db.query(`SELECT (SELECT count(*) FROM journal_entries) + (SELECT count(*) FROM homeowner_transactions) + (SELECT count(*) FROM ap_invoices) AS n`)).rows[0].n == 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
