// tests/sql/486_apply_one_e2e.mjs — migration 486 (bridge decisions) applied END TO
// END through the single-migration tool with its REAL checks file, on top of
// 452-485. Proves owner answers are stored as structured, append-only DECISIONS
// (never as waivers): bound to the current bridge result and item, only an offered
// choice, human only, one per item per result, with provenance; nothing else changed.
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
catch (_) { console.log('SKIP  486 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '486_onboarding_bridge_decisions.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm486-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const PRINT = process.argv.includes('--print-objects');
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client, rpc } = await onboardingWorld(PGlite, { through: 485 });
const plan = await A.planMigration({ ...ctx(client), filename: F });
if (PRINT) { const rr = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) }); console.log(JSON.stringify((rr.detail || {}).objects || rr, null, 2)); process.exit(0); }
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error }).slice(0, 600));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 486 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }));
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
if (r.status === 'applied') {
  // a batch walked to the activity bridge with two open questions
  const ok = [{ code: 'ok', label: 'ok', status: 'PASS' }];
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-DEC', p_as_of: '2026-07-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: B, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ok, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: B, p_completion: c, p_actor_id: 'op' }); }
  const sn = await rpc('onboarding_record_snapshot', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ok, p_summary: {}, p_lines: [], p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: sn, p_actor_id: 'op' });
  const period = { type: 'recording_period', question: 'Example invoice X-1 ($10.00, dated 7/1/2026) is real but is not in the legacy books. Record it after the cutoff, or on 7/1/2026?', choices: [{ key: 'record_after_cutoff', label: 'After the cutoff' }, { key: 'record_on_document_date', label: 'On 7/1/2026' }], recommended: 'record_after_cutoff' };
  const item = (n, cls, evidence) => ({ item_no: n, event_key: `je:x${n}`, kind: 'ap_invoice', classification: cls, method: cls === 'AMBIGUOUS' ? 'in_source_period_absent_from_source' : 'after_cutoff_no_source_evidence', confidence: 'high', event_date: '2026-07-01', amount_cents: 1000 * n, evidence, structural_issues: [], records: [`journal_entries:x${n}`], batch_code: 'CONV-DEC', cutoff_date: '2026-07-31' });
  const bridge = (items, sha) => rpc('onboarding_record_bridge', { p_batch: B, p_status: 'BLOCKED', p_open: ['bridge.ambiguous_items_reviewed'], p_controls: [{ code: 'bridge.ambiguous_items_reviewed', label: 'x', status: 'BLOCKED' }], p_summary: { snapshot_completion_id: sn }, p_items: items, p_bridge_sha256: sha.repeat(64), p_trusted_fingerprint: 'f'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  const br1 = await bridge([item(1, 'AMBIGUOUS', { decision: period }), item(2, 'AMBIGUOUS', { decision: period }), item(3, 'LEGITIMATE_SUBSEQUENT', {}), item(4, 'AMBIGUOUS', { note: 'no question' })], 'b');
  const decide = (completion, decisions, kind = 'human', who = 'ed') => rpc('onboarding_record_bridge_decisions', { p_batch: B, p_completion: completion, p_decisions: decisions, p_actor_kind: kind, p_actor_id: who });
  const waiversBefore = (await db.query(`SELECT count(*)::int AS n FROM onboarding_stage_events WHERE batch_id = $1 AND event_type = 'control_waived'`, [B])).rows[0].n;
  const rec = await err(() => decide(br1, [{ event_key: 'je:x1', choice: 'record_after_cutoff', reason: 'keep the cutoff position exactly as the legacy books' }, { event_key: 'je:x2', choice: 'record_on_document_date' }]));
  check('two answers recorded atomically as decisions', rec === null, rec);
  const rows = (await db.query(`SELECT * FROM onboarding_bridge_decisions WHERE batch_id = $1 ORDER BY event_key`, [B])).rows;
  check('each decision is structured: item, question type, the question, choices offered, the choice taken, actor, timestamp, provenance', rows.length === 2 && rows[0].decision_type === 'recording_period' && rows[0].question === period.question && rows[0].choices.length === 2
    && rows[0].choice_key === 'record_after_cutoff' && rows[0].choice_label === 'After the cutoff' && rows[0].actor_kind === 'human' && rows[0].actor_id === 'ed' && rows[0].decided_at && rows[0].bridge_completion_id === br1
    && rows[0].bridge_sha256 === 'b'.repeat(64) && rows[0].evidence.decision.question === period.question && rows[0].reason && Number(rows[0].item_amount_cents) === 1000 && rows[0].community_id === COMM, JSON.stringify(rows[0]));
  check('decisions are NOT waivers: no control_waived event was written and the bridge control is not waived', (await db.query(`SELECT count(*)::int AS n FROM onboarding_stage_events WHERE batch_id = $1 AND event_type = 'control_waived'`, [B])).rows[0].n === waiversBefore
    && !(await rpc('onboarding_batch_view', { p_batch: B })).current.controls.some((c) => c.disposition));
  check('a choice that was not offered is refused', /not one of the choices offered/.test(await err(() => decide(br1, [{ event_key: 'je:x1', choice: 'delete_it' }])) || ''));
  check('an item that is not an open question is refused (not AMBIGUOUS / no question)', /not an open question/.test(await err(() => decide(br1, [{ event_key: 'je:x3', choice: 'record_after_cutoff' }])) || '') && /carries no question/.test(await err(() => decide(br1, [{ event_key: 'je:x4', choice: 'record_after_cutoff' }])) || ''));
  check('the same item cannot be answered twice on the same bridge result', /duplicate|unique/i.test(await err(() => decide(br1, [{ event_key: 'je:x1', choice: 'record_on_document_date' }])) || ''));
  check('human only: an operator (system) cannot record a decision', /only a human/.test(await err(() => decide(br1, [{ event_key: 'je:x2', choice: 'record_after_cutoff' }], 'system', 'onboarding-operator')) || ''));
  check('append-only: a decision cannot be changed or deleted', /append-only|not allowed|refused/i.test(await err(() => db.query(`UPDATE onboarding_bridge_decisions SET choice_key = 'x' WHERE batch_id = $1`, [B])) || '') && /append-only|not allowed|refused/i.test(await err(() => db.query(`DELETE FROM onboarding_bridge_decisions WHERE batch_id = $1`, [B])) || ''));
  const br2 = await bridge([item(1, 'AMBIGUOUS', { decision: period })], 'c');
  check('decisions bind to the CURRENT bridge result: answering the superseded result is refused; the new result can be answered', /current bridge result/.test(await err(() => decide(br1, [{ event_key: 'je:x2', choice: 'record_after_cutoff' }])) || '') && (await err(() => decide(br2, [{ event_key: 'je:x1', choice: 'record_on_document_date' }]))) === null);
  const view = await rpc('onboarding_bridge_decisions_view', { p_batch: B });
  check('the decision view returns every decision oldest first (history kept across results)', view.length === 3 && view[0].event_key === 'je:x1' && view[2].bridge_completion_id === br2, JSON.stringify(view.map((v) => [v.event_key, v.choice_key])));
  const priv = (await db.query(`SELECT has_function_privilege('anon', 'onboarding_record_bridge_decisions(uuid,uuid,jsonb,text,text)', 'EXECUTE') AS a, has_function_privilege('service_role', 'onboarding_record_bridge_decisions(uuid,uuid,jsonb,text,text)', 'EXECUTE') AS s, has_table_privilege('service_role', 'onboarding_bridge_decisions', 'UPDATE') AS u`)).rows[0];
  check('grants: service_role only; no UPDATE grant on the decision table', priv.a === false && priv.s === true && priv.u === false);
  check('no accounting row exists or changed', (await db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 0);
}
{
  const w = await onboardingWorld(PGlite, { through: 485 });
  await w.db.exec(`CREATE TABLE onboarding_bridge_decisions (id uuid)`);
  const p = await A.planMigration({ ...ctx(w.client), filename: F });
  check('drift: a pre-existing onboarding_bridge_decisions blocks the plan', p.status !== 'ready');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
