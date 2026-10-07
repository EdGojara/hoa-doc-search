// tests/sql/onboarding_bridge_refresh_e2e.mjs — migration 497 on the REAL SQL (Ed 2026-10-07).
// SCAR: Canyon Gate reached a PASS preflight and was stranded minutes later by a routine
// post-cutoff invoice. Stages only move forward, a bridge could only be recorded in
// activity_bridge, and the preflight requires a bridge on the CURRENT Trusted activity.
// Proves: before 497 the refresh is refused (the stranded state); with 497 a refreshed bridge
// is recorded while the batch stays in preflight (only through onboarding_record_bridge, only on
// the current snapshot); no other stage result can be recorded out of its stage; the service's
// operator refreshes the stale bridge and rebuilds the preflight. Nothing posts.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  onboarding bridge refresh e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const ctl = [{ code: 'ok', label: 'ok', status: 'PASS' }];
const FP1 = '1'.repeat(64); const FP2 = '2'.repeat(64);

async function toPreflight(rpc, code6) {
  const id = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: code6, p_as_of: '2026-03-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: id, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: id, p_completion: c, p_actor_id: 'op' }); }
  const sn = await rpc('onboarding_record_snapshot', { p_batch: id, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_lines: [], p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: id, p_completion: sn, p_actor_id: 'op' });
  const br = await rpc('onboarding_record_bridge', { p_batch: id, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: sn, bridge_engine: 'test' }, p_items: [], p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: FP1, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: id, p_completion: br, p_actor_id: 'op' });
  return { id, sn, br };
}
const refresh = (rpc, w, fp, snap = w.sn) => rpc('onboarding_record_bridge', { p_batch: w.id, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: snap, bridge_engine: 'test' }, p_items: [], p_bridge_sha256: 'c'.repeat(64), p_trusted_fingerprint: fp, p_actor_kind: 'system', p_actor_id: 'op' });

// ---- before 497: the stranded state
{
  const old = await onboardingWorld(PGlite, { through: 491, gl: true });
  const w = await toPreflight(old.rpc, 'CONV-EX-OLD');
  check('BEFORE 497: in preflight, a refreshed bridge is refused (the batch is stranded by any new activity)', /only be recorded while the batch is in activity_bridge/.test((await code(() => refresh(old.rpc, w, FP2))) || ''));
}

// ---- with 497
const world = await onboardingWorld(PGlite, { through: 497, gl: true });
const { rpc, db } = world;
const w = await toPreflight(rpc, 'CONV-EX-REFRESH');
const stageOf = async (id) => (await db.query('SELECT onboarding_stage, write_locked FROM conversion_batches WHERE id = $1', [id])).rows[0];
const b2 = await code(() => refresh(rpc, w, FP2));
const s = await stageOf(w.id);
const latestBridge = (await db.query(`SELECT result->'summary'->>'trusted_fingerprint' AS fp FROM onboarding_stage_events WHERE batch_id = $1 AND stage = 'activity_bridge' AND event_type = 'stage_completed' ORDER BY seq DESC LIMIT 1`, [w.id])).rows[0].fp;
check('WITH 497: a refreshed bridge is recorded while the batch is in preflight; the stage does not move; still write-locked', b2 === null && s.onboarding_stage === 'preflight' && s.write_locked === true && latestBridge === FP2, `${b2} ${JSON.stringify(s)} ${latestBridge}`);
check('the refresh still must be built on the CURRENT snapshot', /current snapshot/.test((await code(() => refresh(rpc, w, FP2, '00000000-0000-4000-8000-000000000000'))) || ''));
check('an activity-bridge result cannot be recorded without its items (only onboarding_record_bridge may write one)', /must be recorded with its items/.test((await code(() => rpc('onboarding_record_completion', { p_batch: w.id, p_stage: 'activity_bridge', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }))) || ''));
check('no other stage result can be recorded out of its stage (source_controls while in preflight is refused)', /result for stage source_controls but the batch is in preflight/.test((await code(() => rpc('onboarding_record_completion', { p_batch: w.id, p_stage: 'source_controls', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }))) || ''));
const early = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-EX-EARLY', p_as_of: '2026-03-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
check('a bridge still cannot be recorded BEFORE the bridge stage (intake)', /only be recorded while the batch is in activity_bridge/.test((await code(() => rpc('onboarding_record_bridge', { p_batch: early, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_items: [], p_bridge_sha256: 'c'.repeat(64), p_trusted_fingerprint: FP2, p_actor_kind: 'system', p_actor_id: 'op' }))) || ''));

const pf = await rpc('onboarding_record_completion', { p_batch: w.id, p_stage: 'preflight', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { preflight_sha256: 'd'.repeat(64) }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });
const appr = await code(() => rpc('onboarding_approve', { p_batch: w.id, p_completion: pf, p_preflight_sha256: 'd'.repeat(64), p_actor_kind: 'human', p_actor_id: 'ed' }));
check('after the refresh, a rebuilt preflight is recorded and the owner can approve it through the unchanged gate', appr === null, appr);
check('a waiver can never be recorded against the refreshed bridge from preflight (only results cross stages)', /event for stage activity_bridge but the batch is in preflight/.test((await code(() => db.query(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, completion_event_id, actor_kind, actor_id, control_code, reason) SELECT $1, 'control_waived', 'activity_bridge', id, 'human', 'ed', 'ok', 'should not be allowed' FROM onboarding_stage_events WHERE batch_id = $1 AND stage = 'activity_bridge' AND event_type = 'stage_completed' ORDER BY seq DESC LIMIT 1`, [w.id]))) || ''));

// ---- service: runStage at preflight with refresh_bridge goes to the bridge runner (not the preflight runner)
const svc = createOnboardingService({ rpc, storage: { async putOnce() {}, async get() { return Buffer.alloc(0); } } });
const ED = { kind: 'human', id: 'ed', role: 'owner' };
check('service: at preflight, refresh_bridge runs the BRIDGE runner (it needs the read-only Trusted reader, here absent -> NO_TRUSTED_READER, not a preflight result)', /NO_TRUSTED_READER/.test((await code(() => svc.runStage(ED, w.id, { refresh_bridge: true }))) || ''));
check('nothing posted anywhere', (await db.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n === 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
