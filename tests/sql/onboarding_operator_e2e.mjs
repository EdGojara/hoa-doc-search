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
const pkgOf = async (id) => Object.fromEntries((await svc.getBatch(id, ED)).operator.package.reports.map((r) => [r.type, r]));
let pk = await pkgOf(B);
check('fresh batch, nothing uploaded: the checklist names every Vantaca report dated for the cutoff; GL + Balance Sheet needed, the rest "include it"', pk.gl_trial_balance.status === 'needed' && pk.gl_trial_balance.report === 'GL Trial Balance for 1/1/2026 - 3/31/2026' && pk.balance_sheet.status === 'needed' && ['ar_aging', 'homeowner_transactions', 'prepaid_homeowners', 'ap_aging'].every((t) => pk[t].status === 'needed_if_balance'), JSON.stringify(pk));
for (const t of ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions']) await svc.registerArtifact(ED, B, { buffer: await toPdf(fs.readFileSync(path.join(FX, `${t}.txt`), 'utf8')), filename: `Vantaca ${t}.pdf`, artifact_type: 'original_pdf' });
const run1 = await svc.operate(B);
let v = await svc.getBatch(B, ED);
check('originals extracted and recognized by header (4 report types), each linked to its original', run1.steps.some((s) => s.action === 'recognized' && s.files.length === 4) && ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions'].every((t) => v.artifacts.some((a) => a.artifact_type === t && a.derived_from_sha256)));
check('operator stops at intake and asks for the missing report BY NAME (the GL carries prepaid 2400)', run1.stopped_at === 'intake' && run1.reason === 'needs_human' && v.operator.asks.some((a) => a.type === 'missing_source' && a.report === 'Pre Paid Homeowners as of 3/31/2026 (include previous owners)'), JSON.stringify(v.operator.asks));
pk = await pkgOf(B);
check('after the first upload the checklist updates: 4 supplied (by their original file names, dated at the cutoff), the prepaid report NEEDED, AP Aging not needed (no AP balance)', ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions'].every((t) => pk[t].status === 'supplied' && pk[t].file === `Vantaca ${t}.pdf` && pk[t].dated_at_cutoff === true) && pk.prepaid_homeowners.status === 'needed' && pk.ap_aging.status === 'not_needed', JSON.stringify(pk));
check('the missing report is a BLOCKED control (not an accounting FAIL)', v.current.status === 'BLOCKED' && v.current.controls.find((c) => c.code === 'intake.required_sources_present').status === 'BLOCKED');
// 2. Ed drops the requested report; the operator continues on its own.
await svc.registerArtifact(ED, B, { buffer: await toPdf(fs.readFileSync(path.join(FX, 'prepaid_homeowners.txt'), 'utf8')), filename: 'Vantaca prepaid.pdf', artifact_type: 'original_pdf' });
const run2 = await svc.operate(B);
v = await svc.getBatch(B, ED);
const adv = run2.steps.filter((s) => s.action === 'advanced').map((s) => s.to);
check('after the upload: intake, normalize, source controls, snapshot all PASS and advance automatically', JSON.stringify(adv) === JSON.stringify(['normalize', 'source_controls', 'snapshot', 'activity_bridge']), JSON.stringify(run2.steps));
pk = await pkgOf(B);
check('after the requested upload the prepaid report shows supplied; nothing is still needed', pk.prepaid_homeowners.status === 'supplied' && !Object.values(pk).some((r) => r.status === 'needed'), JSON.stringify(pk));
check('roles were inferred from the source chart (1300 / 2400) without a human typing them', v.latest_by_stage.source_controls.summary.roles.ar_account === '1300' && v.latest_by_stage.source_controls.summary.roles.prepaid_account === '2400');
check('it stops at the activity bridge, the first stage that needs a human, and says why', run2.stopped_at === 'activity_bridge' && run2.reason === 'needs_human' && v.operator.asks.some((a) => a.type === 'ambiguity'), JSON.stringify(v.operator.asks));
check('every automatic advance is recorded as the operator (system), every stage before the bridge PASS', v.events.filter((e) => e.type === 'stage_advanced').every((e) => e.actor_kind === 'system' && e.actor_id === 'onboarding-operator') && ['intake', 'normalize', 'source_controls', 'snapshot'].every((s) => v.latest_by_stage[s].status === 'PASS'));
const m = v.operator.metrics;
check('metrics: 2 human interventions = the handoff + the ONE requested-source upload; no manual run/advance anywhere; 0 AI calls', m.human_interventions === 2 && m.interventions.handoff === 1 && m.interventions.source_uploads === 1 && m.interventions.judgments === 0 && m.interventions.authorizations === 0 && m.manual_engine_actions === 0 && m.ai_calls === 0 && m.operator_steps >= 8, JSON.stringify(m));
check('the upload alone resumed the chain: no human stage_completed / stage_advanced event exists', !v.events.some((e) => e.actor_kind === 'human' && (e.type === 'stage_completed' || e.type === 'stage_advanced')));
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

// 3b. Ed's judgment and authorization at the bridge count as interventions; the audit trail keeps everything.
const openAtBridge = v.latest_by_stage.activity_bridge.open_controls;
for (const c of openAtBridge) await svc.waive(ED, B, { completion_id: bridgeCompletion, code: c, reason: 'test: reviewed' });
await svc.advance(ED, B, { completion_id: bridgeCompletion, to: 'preflight' });
const m2 = (await svc.getBatch(B, ED)).operator.metrics;
check('metrics: each waiver is a judgment, the owner advance of a waived result is an authorization; still no manual engine ceremony', m2.interventions.judgments === openAtBridge.length && m2.interventions.authorizations === 1 && m2.human_interventions === 2 + openAtBridge.length + 1 && m2.manual_engine_actions === 0, JSON.stringify(m2));

// 4. An unknown report format is reported, not guessed.
const B3 = await svc.createBatch(ED, { community_id: COMM, batch_code: 'CONV-EX-UNKNOWN', as_of_date: '2026-03-31', source_system: 'vantaca' });
await svc.registerArtifact(ED, B3, { buffer: await toPdf('Some Other Report\n\nnot a Vantaca layout we know\n'), filename: 'mystery.pdf', artifact_type: 'original_pdf' });
const r3 = await svc.operate(B3);
const v3 = await svc.getBatch(B3, ED);
check('an unrecognized original is flagged as an unknown format (and the core reports are requested by name)', r3.stopped_at === 'intake' && v3.operator.asks.some((a) => a.type === 'unrecognized_format' && a.file === 'mystery.layout.txt') && v3.operator.asks.some((a) => a.type === 'missing_source' && /GL Trial Balance/.test(a.report)), JSON.stringify(v3.operator.asks));
// 5. Before Start: recognize the chosen files (nothing stored), and say which is which.
const storedBefore = storage.m.size;
const rec = await svc.recognize('vantaca', '2026-03-31', [
  { originalname: 'GLTrialBalance.pdf', buffer: await toPdf(fs.readFileSync(path.join(FX, 'gl_trial_balance.txt'), 'utf8')) },
  { originalname: 'AR Aging.pdf', buffer: await toPdf(fs.readFileSync(path.join(FX, 'ar_aging.txt'), 'utf8').replace('AR Aging - 3/31/2026', 'AR Aging - 2/28/2026')) },
  { originalname: 'BalanceSheet.xls', buffer: Buffer.from('xls bytes') },
]);
check('recognize (before Start): types and printed dates read from the PDFs; a misdated report flagged with the right date; an .xls asked for as PDF; nothing stored', rec[0].type === 'gl_trial_balance' && rec[0].dated_at_cutoff === true && rec[1].type === 'ar_aging' && rec[1].dated_at_cutoff === false && /Please run AR Aging as of 3\/31\/2026/.test(rec[1].note) && rec[2].type === null && /PDF version/.test(rec[2].note) && storage.m.size === storedBefore, JSON.stringify(rec));

// A batch whose AR Aging is dated a month early: requested again by name and date; the corrected upload resumes on its own.
const B4 = await svc.createBatch(ED, { community_id: COMM, batch_code: 'CONV-EX-MISDATED', as_of_date: '2026-03-31', source_system: 'vantaca' });
for (const t of ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'prepaid_homeowners']) {
  let text = fs.readFileSync(path.join(FX, `${t}.txt`), 'utf8'); if (t === 'ar_aging') text = text.replace('AR Aging - 3/31/2026', 'AR Aging - 2/28/2026');
  await svc.registerArtifact(ED, B4, { buffer: await toPdf(text), filename: `${t}.pdf`, artifact_type: 'original_pdf' });
}
const r4 = await svc.operate(B4);
let v4 = await svc.getBatch(B4, ED);
check('misdated report: intake stops and asks for "AR Aging as of 3/31/2026" by name (cutoff-aware), the checklist marks it wrong-dated', r4.stopped_at === 'intake' && v4.operator.asks.some((a) => a.type === 'missing_source' && a.report === 'AR Aging as of 3/31/2026' && /dated 2026-02-28/.test(a.why)) && v4.operator.package.reports.find((r) => r.type === 'ar_aging').dated_at_cutoff === false, JSON.stringify(v4.operator.asks));
await svc.registerArtifact(ED, B4, { buffer: await toPdf(fs.readFileSync(path.join(FX, 'ar_aging.txt'), 'utf8')), filename: 'AR Aging (1).pdf', artifact_type: 'original_pdf' });
const r5 = await svc.operate(B4);
v4 = await svc.getBatch(B4, ED);
check('the corrected upload resumes the operator past intake with no manual run / advance; the checklist shows the new file at the cutoff', r5.steps.some((st) => st.action === 'advanced' && st.to === 'normalize') && v4.operator.package.reports.find((r) => r.type === 'ar_aging').file === 'AR Aging (1).pdf' && v4.operator.package.reports.find((r) => r.type === 'ar_aging').dated_at_cutoff === true && v4.operator.metrics.manual_engine_actions === 0, JSON.stringify(r5.steps));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
