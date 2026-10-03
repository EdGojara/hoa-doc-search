// tests/sql/onboarding_operator_e2e.mjs — Issue #15: AI-operated onboarding.
// The operator runs the gated engine end to end on the REAL 452-485 SQL with the
// synthetic fixture, starting from ORIGINAL PDFs (generated here with pdf-lib),
// exactly as a legacy system exports them. Proves:
//   - originals are text-extracted server-side and recognized by their headers;
//   - intake works out which supporting reports the GL needs and asks for the
//     missing one BY NAME (Pre Paid Homeowners), then continues by itself after
//     the upload, with no extra human click;
//   - routine PASS stages advance automatically (actor 'system'); it stops at the
//     first stage that needs a human (activity bridge: ambiguous items), and the
//     batch view says exactly what it needs; ai_calls = 0;
//   - the DATABASE refuses an operator advance on anything but a plain PASS, into
//     execute, and refuses an operator waiver; a human advance still works;
//   - an unrecognized original is reported as an unrecognized format, not guessed.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  onboarding operator e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
const FX = path.join(REPO, 'tests', 'fixtures', 'onboarding', 'synthetic-vantaca');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };

// A monospace PDF of a report text, one page per form feed / 60 lines.
async function toPdf(text) {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Courier); const size = 7;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 70) {
    const page = doc.addPage([900, 612]);
    lines.slice(i, i + 70).forEach((l, k) => { if (l.trim()) page.drawText(l.replace(/\f/g, ''), { x: 20, y: 590 - k * 8.4, size, font }); });
  }
  return Buffer.from(await doc.save());
}
function memoryStorage() { const m = new Map(); return { m, async putOnce(p, b) { if (!m.has(p)) m.set(p, Buffer.from(b)); }, async get(p) { return Buffer.from(m.get(p)); } }; }

const world = await onboardingWorld(PGlite, { through: 485 });
const tje = (id, d, mod, amt, extra = {}) => ({ id, posting_date: d, source_module: mod, status: 'posted', total_debits_cents: amt, total_credits_cents: amt, description: '', ...extra });
const trustedReader = async () => ({ trusted: { journal_entries: [tje('t-legacy', '2026-02-01', 'vantaca_import', 61000), tje('t-ach', '2026-03-05', 'payment_intake', 15000, { description: 'AP payment ach' })], journal_entry_lines: [], ap_invoices: [], ap_payments: [], ar_charges: [], ar_payments: [], payments: [], homeowner_transactions: [] }, accountNumber: () => null, accountOfProperty: () => null });
const storage = memoryStorage();
const svc = createOnboardingService({ rpc: world.rpc, storage, trustedReader });
const ED = { kind: 'human', id: 'ed', role: 'owner' };

// 1. Ed starts: community, system, cutoff, and the four core reports as PDFs.
const B = await svc.createBatch(ED, { community_id: COMM, batch_code: 'CONV-EX-OPERATOR', as_of_date: '2026-03-31', source_system: 'vantaca' });
for (const t of ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions']) await svc.registerArtifact(ED, B, { buffer: await toPdf(fs.readFileSync(path.join(FX, `${t}.txt`), 'utf8')), filename: `Vantaca ${t}.pdf`, artifact_type: 'original_pdf' });
const run1 = await svc.operate(B);
let v = await svc.getBatch(B, ED);
check('originals extracted and recognized by header (4 report types), each linked to its original', run1.steps.some((s) => s.action === 'recognized' && s.files.length === 4) && ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions'].every((t) => v.artifacts.some((a) => a.artifact_type === t && a.derived_from_sha256)));
check('operator stops at intake and asks for the missing report BY NAME (the GL carries prepaid 2400)', run1.stopped_at === 'intake' && run1.reason === 'needs_human' && v.operator.asks.some((a) => a.type === 'missing_source' && /Pre Paid Homeowners report as of 2026-03-31/.test(a.report)), JSON.stringify(v.operator.asks));
check('the missing report is a BLOCKED control (not an accounting FAIL)', v.current.status === 'BLOCKED' && v.current.controls.find((c) => c.code === 'intake.required_sources_present').status === 'BLOCKED');
// 2. Ed drops the requested report; the operator continues on its own.
await svc.registerArtifact(ED, B, { buffer: await toPdf(fs.readFileSync(path.join(FX, 'prepaid_homeowners.txt'), 'utf8')), filename: 'Vantaca prepaid.pdf', artifact_type: 'original_pdf' });
const run2 = await svc.operate(B);
v = await svc.getBatch(B, ED);
const adv = run2.steps.filter((s) => s.action === 'advanced').map((s) => s.to);
check('after the upload: intake, normalize, source controls, snapshot all PASS and advance automatically', JSON.stringify(adv) === JSON.stringify(['normalize', 'source_controls', 'snapshot', 'activity_bridge']), JSON.stringify(run2.steps));
check('roles were inferred from the source chart (1300 / 2400) without a human typing them', v.latest_by_stage.source_controls.summary.roles.ar_account === '1300' && v.latest_by_stage.source_controls.summary.roles.prepaid_account === '2400');
check('it stops at the activity bridge, the first stage that needs a human, and says why', run2.stopped_at === 'activity_bridge' && run2.reason === 'needs_human' && v.operator.asks.some((a) => a.type === 'ambiguity'), JSON.stringify(v.operator.asks));
check('every automatic advance is recorded as the operator (system), every stage before the bridge PASS', v.events.filter((e) => e.type === 'stage_advanced').every((e) => e.actor_kind === 'system' && e.actor_id === 'onboarding-operator') && ['intake', 'normalize', 'source_controls', 'snapshot'].every((s) => v.latest_by_stage[s].status === 'PASS'));
check('metrics: 1 human touch (starting the batch), 0 AI calls, operator steps counted', v.operator.metrics.human_touches === 1 && v.operator.metrics.ai_calls === 0 && v.operator.metrics.operator_steps >= 8, JSON.stringify(v.operator.metrics));
check('nothing posted: no accounting rows', (await world.db.query(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0].n === 0);

// 3. The database keeps the human gates.
const bridgeCompletion = v.current.completion_id;
check('DB: an operator advance on a non-PASS result is refused', /REFUSED_BY_DATABASE|not a plain PASS/.test((await code(() => world.rpc('onboarding_auto_advance', { p_batch: B, p_completion: bridgeCompletion, p_actor_id: 'onboarding-operator' }))) || ''));
check('DB: an operator cannot waive (human gate)', /human_gates|only a human/.test((await code(() => world.rpc('onboarding_waive', { p_batch: B, p_completion: bridgeCompletion, p_code: 'bridge.ambiguous_items_reviewed', p_reason: 'operator should never do this', p_actor_kind: 'system', p_actor_id: 'onboarding-operator' }))) || ''));
check('DB: a direct system stage_advanced event on the BLOCKED bridge is refused by the validate trigger', /refused|not waived/.test((await code(() => world.db.query(`INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, completion_event_id, actor_kind, actor_id) VALUES ($1, 'stage_advanced', 'activity_bridge', 'preflight', $2, 'system', 'onboarding-operator')`, [B, bridgeCompletion]))) || ''));
// a separate batch walked to preflight with PASS results: system may not advance into execute
const B2 = await world.rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: 'CONV-EX-EXEC', p_as_of: '2026-03-31', p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
const ctl = [{ code: 'ok', label: 'ok', status: 'PASS' }];
for (const s of ['intake', 'normalize', 'source_controls']) { const c = await world.rpc('onboarding_record_completion', { p_batch: B2, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await world.rpc('onboarding_auto_advance', { p_batch: B2, p_completion: c, p_actor_id: 'op' }); }
const sn = await world.rpc('onboarding_record_snapshot', { p_batch: B2, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_lines: [], p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
await world.rpc('onboarding_auto_advance', { p_batch: B2, p_completion: sn, p_actor_id: 'op' });
const br = await world.rpc('onboarding_record_bridge', { p_batch: B2, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: sn }, p_items: [], p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: 'c'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
await world.rpc('onboarding_auto_advance', { p_batch: B2, p_completion: br, p_actor_id: 'op' });
const pf = await world.rpc('onboarding_record_completion', { p_batch: B2, p_stage: 'preflight', p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' });
check('DB: the operator can reach preflight on PASS results but can NEVER advance into execute', /never into execute/.test((await code(() => world.rpc('onboarding_auto_advance', { p_batch: B2, p_completion: pf, p_actor_id: 'op' }))) || ''));
check('a human advance still works through the normal owner path (into execute it still needs an approved preflight)', /execute needs an approved preflight|EXECUTE is not available/.test((await code(() => world.rpc('onboarding_advance', { p_batch: B2, p_completion: pf, p_to: 'execute', p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));

// 4. An unknown report format is reported, not guessed.
const B3 = await svc.createBatch(ED, { community_id: COMM, batch_code: 'CONV-EX-UNKNOWN', as_of_date: '2026-03-31', source_system: 'vantaca' });
await svc.registerArtifact(ED, B3, { buffer: await toPdf('Some Other Report\n\nnot a Vantaca layout we know\n'), filename: 'mystery.pdf', artifact_type: 'original_pdf' });
const r3 = await svc.operate(B3);
const v3 = await svc.getBatch(B3, ED);
check('an unrecognized original is flagged as an unknown format (and the core reports are requested by name)', r3.stopped_at === 'intake' && v3.operator.asks.some((a) => a.type === 'unrecognized_format' && a.file === 'mystery.layout.txt') && v3.operator.asks.some((a) => a.type === 'missing_source' && /GL Trial Balance/.test(a.report)), JSON.stringify(v3.operator.asks));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
