// tests/sql/onboarding_execute_e2e.mjs — Issue #15 M6: EXECUTE on the REAL 452-488 SQL,
// synthetic community only (never Quail Ridge). A batch is walked to preflight with
// PASS results; a v2 preflight (pure plan builder + canonical hash) is recorded, the
// owner approves it, and EXECUTE carries out exactly its write contract in ONE
// transaction against realistic accounting tables (production columns + constraints).
// Proves: refusals before any write (no approval, agent / operator actor, wrong hash,
// tampered report, stale Trusted activity, superseded preflight, the 482 advance path);
// an injected mid-transaction failure rolls back EVERYTHING and is recorded as failed;
// the successful execute writes exactly the plan (provenance on every row, cutoff TB =
// source, prior-owner row with no tenure / no lot, AP posted by the opening entry,
// cutover date, batch posted + re-locked); a retry writes nothing; zero duplicates.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  onboarding execute e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
const { buildConversionPlan } = require(`${REPO}/lib/onboarding/conversion_plan.js`);
const { trustedFingerprint } = require(`${REPO}/lib/onboarding/bridge.js`);
const PF = require(`${REPO}/lib/onboarding/preflight.js`);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };

const world = await onboardingWorld(PGlite, { through: 488, gl: true });
const { rpc, db } = world;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ------------------------------------------------------------ synthetic community
const MC = u(900); const OPR = u(901); const V = u(902); const P1 = u(903); const P2 = u(904); const T1 = u(905); const T2 = u(906); const LB = u(907);
const ACC = { 1000: u(1000), 1300: u(1300), 2000: u(2000), 2400: u(2400), 3000: u(3000), 4000: u(4000), 5000: u(5000) };
await db.exec(`
  INSERT INTO management_companies VALUES ('${MC}');
  UPDATE communities SET management_company_id = '${MC}', gl_cutover_date = '2026-01-01' WHERE id = '${COMM}';
  INSERT INTO account_funds VALUES ('${OPR}', '${COMM}', 'OPR');
  ${Object.entries(ACC).map(([n, id]) => `INSERT INTO chart_of_accounts VALUES ('${id}', '${COMM}', '${n}', '${OPR}', NULL);`).join('\n  ')}
  INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status)
    SELECT '${COMM}', 2026, m, make_date(2026, m, 1), (make_date(2026, m, 1) + interval '1 month - 1 day')::date, 'open' FROM generate_series(1, 12) m;
  INSERT INTO properties VALUES ('${P1}', '${COMM}', '10001', '1 Example Lane'), ('${P2}', '${COMM}', '10002', '2 Example Lane');
  INSERT INTO ownership_tenures VALUES ('${T1}', '${COMM}', '${P1}', 'owner', '2020-01-01', NULL), ('${T2}', '${COMM}', '${P2}', 'owner', '2021-01-01', NULL);
  INSERT INTO vendors VALUES ('${V}', 'Acme Pools', '${MC}');
  INSERT INTO transaction_upload_batches (id, management_company_id, community_id, period_label, as_of_date, row_count, status) VALUES ('${LB}', '${MC}', '${COMM}', 'legacy import', '2026-02-28', 2, 'committed');
  INSERT INTO homeowner_transactions (id, source_batch_id, source_row_index, community_id, vantaca_account_id, property_id, transaction_date, description, txn_type, amount_cents)
    VALUES ('${u(911)}', '${LB}', 1, '${COMM}', '10001', '${P1}', '2026-02-01', 'legacy charge', 'charge', 1500), ('${u(912)}', '${LB}', 2, '${COMM}', '10002', '${P2}', '2026-02-01', 'legacy charge', 'charge', 500);`);
const period = async (d) => (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND period_start <= $2::date AND period_end >= $2::date`, [COMM, d])).id;
const postJe = async (id, ref, date, module, lines) => {
  const tot = lines.reduce((t, [, dr]) => t + dr, 0);
  await db.query(`INSERT INTO journal_entries (id, community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'posted')`, [id, COMM, await period(date), date, ref, `synthetic ${ref}`, module, tot]);
  let n = 0;
  for (const [acct, dr, cr] of lines) await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents) VALUES ($1, $2, $3, $4, $5, $6)`, [id, ++n, ACC[acct], OPR, dr, cr]);
};
const L1 = u(801); const N1 = u(802); const D1 = u(803); const PC = u(804);
await postJe(L1, 'JE-L1', '2026-02-28', 'vantaca_import', [[1000, 500, 0], [4000, 0, 500]]);   // legacy import -> supersede
await postJe(N1, 'JE-N1', '2026-03-15', 'system', [[5000, 100, 0], [1000, 0, 100]]);           // already in source -> neutralize
await postJe(D1, 'JE-D1', '2026-03-20', 'ap_invoice', [[5000, 50, 0], [2000, 0, 50]]);         // owner decided record_after_cutoff -> neutralize + re-post
await postJe(PC, 'JE-PC', '2026-04-10', 'payment_intake', [[1000, 300, 0], [4000, 0, 300]]);   // post-cutover -> untouched

// read-only views of "Trusted" exactly as the production loaders shape them (text dates)
const trustedNow = async () => ({
  journal_entries: await q(`SELECT id, posting_date::text, source_module, source_reference, reference, description, status, total_debits_cents::int, total_credits_cents::int,
                                   reverses_je_id, void_reversal_je_id, superseded_at::text, created_at::text, updated_at::text FROM journal_entries WHERE community_id = $1 ORDER BY id`, [COMM]),
  journal_entry_lines: await q(`SELECT l.id, l.journal_entry_id, l.line_number, l.account_id, l.fund_id, l.debit_cents::int, l.credit_cents::int, l.property_id, l.vendor_id, l.created_at::text
                                FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = $1 ORDER BY l.id`, [COMM]),
  ap_invoices: await q(`SELECT id, vendor_id, vendor_invoice_number, total_cents::int, status, voided_at::text, created_at::text, updated_at::text FROM ap_invoices WHERE community_id = $1 ORDER BY id`, [COMM]),
  homeowner_transactions: await q(`SELECT id, source_batch_id, amount_cents::int, created_at::text FROM homeowner_transactions WHERE community_id = $1 ORDER BY id`, [COMM]),
  ap_payments: [], ar_charges: [], ar_payments: [], payments: [],
});
const trustedReader = async () => ({ trusted: await trustedNow(), accountNumber: () => null, accountOfProperty: () => null });
const ctxNow = async () => ({
  accounts: await q(`SELECT id, account_number, fund_id, vantaca_account_number FROM chart_of_accounts WHERE community_id = $1`, [COMM]),
  funds: (await q(`SELECT id, fund_code FROM account_funds WHERE community_id = $1`, [COMM])).map((f) => ({ id: f.id, code: f.fund_code })),
  properties: await q(`SELECT id, vantaca_account_id, street_address FROM properties WHERE community_id = $1`, [COMM]),
  tenures: await q(`SELECT id, property_id, kind, start_date::text, end_date::text FROM ownership_tenures WHERE community_id = $1`, [COMM]),
  vendors: await q(`SELECT id, name FROM vendors WHERE management_company_id = $1`, [MC]),
  periods: await q(`SELECT id, period_start::text, period_end::text, status FROM accounting_periods WHERE community_id = $1`, [COMM]),
  management_company_id: MC,
  gl_cutover_date: (await one(`SELECT gl_cutover_date::text AS d FROM communities WHERE id = $1`, [COMM])).d,
});
const storage = { async putOnce() {}, async get() { return Buffer.alloc(0); } };
const svc = createOnboardingService({ rpc, storage, trustedReader, conversionContext: ctxNow });
const ED = { kind: 'human', id: 'ed', role: 'owner' };

// ------------------------------------------------- source position at 3/31 (synthetic)
const CUTOFF = '2026-03-31';
const snapshotLines = (batchCode) => [
  ['gl_opening_balance', '1000', 10000], ['gl_opening_balance', '1300', 2000], ['gl_opening_balance', '2000', -500], ['gl_opening_balance', '2400', -300],
  ['gl_opening_balance', '3000', -8000], ['gl_opening_balance', '4000', -5000], ['gl_opening_balance', '5000', 1800],
].map(([kind, account_code, amount_cents], i) => ({ line_no: i + 1, kind, account_code, amount_cents, batch_code: batchCode, cutoff_date: CUTOFF, detail: {} })).concat([
  { line_no: 8, kind: 'ar_aging_item', account_code: '1300', source_account_key: '10001', amount_cents: 1500, detail: { charge_type: 'Annual Assessment' } },
  { line_no: 9, kind: 'ar_aging_item', account_code: '1300', source_account_key: '10002', amount_cents: 500, detail: { charge_type: 'Late Fee' } },
  { line_no: 10, kind: 'prepaid_detail', account_code: '2400', source_account_key: '10001', amount_cents: -100, detail: {} },
  { line_no: 11, kind: 'prepaid_detail', account_code: '2400', source_account_key: '90009', amount_cents: -200, detail: { former_owner: true } },
  { line_no: 12, kind: 'ap_detail', account_code: '2000', amount_cents: -500, detail: { source_vendor_key: 'ACME POOLS', invoice_number: 'INV-1', invoice_date: '2026-03-10' } },
].map((l) => ({ ...l, batch_code: batchCode, cutoff_date: CUTOFF }))).map((l) => ({ component: l.kind === 'gl_opening_balance' ? 'gl' : l.kind === 'ap_detail' ? 'ap' : 'ar', provenance: [{ artifact: 'synthetic', line: l.line_no }], ...l }));
const source = { prepaid_rows: [{ source_account_key: '90009', previous_owner: true, amount_cents: 200, provenance: { artifact_sha256: 'c'.repeat(64), locator: { line: 3 }, raw: '***90009  OLD PLACEHOLDER ROAD  Prior Owner  2.00' } }] };
const bridgeItems = (batchCode) => [
  { item_no: 1, event_key: 'legacy', kind: 'legacy_import', classification: 'ALREADY_IN_SOURCE', method: 'provenance_legacy_import', amount_cents: 500, records: [`journal_entries:${L1}`, `homeowner_transactions:${u(911)}`, `homeowner_transactions:${u(912)}`] },
  { item_no: 2, event_key: `je:${N1}`, kind: 'gl_entry', classification: 'ALREADY_IN_SOURCE', method: 'gl_entry_lines_identical_in_source', amount_cents: 100, event_date: '2026-03-15', records: [`journal_entries:${N1}`] },
  { item_no: 3, event_key: `je:${D1}`, kind: 'gl_entry', classification: 'AMBIGUOUS', method: 'in_source_period_absent_from_source', amount_cents: 50, event_date: '2026-03-20',
    evidence: { decision: { type: 'recording_period', recorded: { choice_key: 'record_after_cutoff', decision_id: 'dec-1' } } }, records: [`journal_entries:${D1}`] },
  { item_no: 4, event_key: `je:${PC}`, kind: 'gl_entry', classification: 'LEGITIMATE_SUBSEQUENT', method: 'after_cutoff_no_source_evidence', amount_cents: 300, event_date: '2026-04-10', records: [`journal_entries:${PC}`] },
].map((it) => ({ confidence: 'high', evidence: {}, ...it, batch_code: batchCode, cutoff_date: CUTOFF }));

// Walk a batch to preflight (operator path) and record a v2 preflight built from the live data.
const ctl = [{ code: 'ok', label: 'ok', status: 'PASS' }];
async function toPreflight(batchCode) {
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: batchCode, p_as_of: CUTOFF, p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: B, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: B, p_completion: c, p_actor_id: 'op' }); }
  const lines = snapshotLines(batchCode);
  const sn = await rpc('onboarding_record_snapshot', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' } }, p_lines: lines, p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: sn, p_actor_id: 'op' });
  const fp = trustedFingerprint(await trustedNow());
  const items = bridgeItems(batchCode);
  const br = await rpc('onboarding_record_bridge', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: sn, bridge_engine: 'test' }, p_items: items, p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: fp, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: br, p_actor_id: 'op' });
  return { B, sn, br, fp, lines, items, batchCode };
}
async function buildReport(w) {
  const ctx = await ctxNow(); const trusted = await trustedNow();
  const plan = buildConversionPlan({ batch: { id: w.B, batch_code: w.batchCode, community_id: COMM, as_of_date: CUTOFF },
    snapshot: { completion_id: w.sn, sha256: 'a'.repeat(64), roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, lines: w.lines },
    bridge: { completion_id: w.br, sha256: 'b'.repeat(64), trusted_fingerprint: w.fp, status: 'PASS', items: w.items }, source, trusted, ctx: { ...ctx, current_trusted_fingerprint: trustedFingerprint(trusted) } });
  const { controls, ...body } = plan;
  return PF.buildConversionPreflight({ batch: { batch_code: w.batchCode, community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: CUTOFF, cutover_date: plan.cutover },
    inputs: { snapshot: { completion_id: w.sn, sha256: 'a'.repeat(64), status: 'PASS' }, bridge: { completion_id: w.br, sha256: 'b'.repeat(64), trusted_fingerprint: w.fp, status: 'PASS', engine: 'test' }, decisions: [], bridge_waivers: [], artifacts: [] },
    plan: body, controls }, []);
}
const recordPf = async (B, report) => rpc('onboarding_record_completion', { p_batch: B, p_stage: 'preflight', p_status: report.status.overall, p_open: report.controls.filter((c) => c.status !== 'PASS').map((c) => c.code),
  p_controls: report.controls.map((c) => ({ code: c.code, label: c.label, status: c.status })), p_summary: { preflight_format: report.format, preflight_sha256: report.sha256, preflight_report: report }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });
const counts = async () => one(`SELECT (SELECT count(*)::int FROM journal_entries) AS je, (SELECT count(*)::int FROM journal_entry_lines) AS lines, (SELECT count(*)::int FROM homeowner_transactions) AS ht,
  (SELECT count(*)::int FROM transaction_upload_batches) AS tub, (SELECT count(*)::int FROM ap_invoices) AS ap, (SELECT gl_cutover_date::text FROM communities WHERE id = '${COMM}') AS cutover,
  (SELECT status FROM journal_entries WHERE id = '${L1}') AS l1, (SELECT status FROM transaction_upload_batches WHERE id = '${LB}') AS lb`);

// ================================= batch B2: approval bound to a SUPERSEDED preflight
// (same community, before anything is converted; B2 only exercises refusals, never writes)
{
  const W2 = await toPreflight('CONV-EX2-20260331');
  const r2 = await buildReport(W2);
  const pf2a = await recordPf(W2.B, r2);
  check('B2: the owner approves its first preflight result', (await code(() => svc.approve(ED, W2.B, { completion_id: pf2a, preflight: r2 }))) === null);
  const pf2b = await recordPf(W2.B, r2);          // a newer preflight result supersedes the approved one
  const before2 = await counts();
  check('superseded preflight: executing the approved-but-superseded result is refused (service)', /NOT_THE_CURRENT_PREFLIGHT_RESULT/.test((await code(() => svc.execute(ED, W2.B, { completion_id: pf2a, preflight_sha256: r2.sha256 }))) || ''));
  check('superseded preflight: the DATABASE refuses it too (a newer result was recorded)', /newer result/.test((await code(() => rpc('onboarding_execute', { p_batch: W2.B, p_completion: pf2a, p_preflight_sha256: r2.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
  check('the newer result was never approved: refused even with the same hash (approval binds to the completion it approved)',
    /no human approval of that hash for the current preflight result/.test((await code(() => rpc('onboarding_execute', { p_batch: W2.B, p_completion: pf2b, p_preflight_sha256: r2.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
  check('nothing written by B2', JSON.stringify(await counts()) === JSON.stringify(before2));
}

// ===================================================== batch B: the proving batch
const W = await toPreflight('CONV-EX-20260331');
const report = await buildReport(W);
check('synthetic plan: every preflight control PASSES (eligible); entries use the live source_module values and name an open period',
  report.status.overall === 'PASS' && report.plan.writes.opening_journal_entries.every((j) => j.source_module === 'opening_entry' && j.period_id)
  && report.plan.writes.neutralize_journal_entries.every((j) => j.source_module === 'reversal' && j.period_id) && report.plan.writes.repost_journal_entries.every((j) => j.source_module === 'manual' && j.period_id),
  JSON.stringify(report.controls.filter((c) => c.status !== 'PASS')));
const pf = await recordPf(W.B, report);
const base = await counts();
const tw = report.plan.writes;
check('the write set: 1 opening (OPR), 2 neutralize, 1 re-post, 1 supersede, 1 ledger batch reverted, 4 opening ledger rows (2 aging, 1 current prepaid, 1 prior-owner), 1 AP invoice, cutover 2026-01-01 -> 2026-04-01',
  tw.opening_journal_entries.length === 1 && tw.neutralize_journal_entries.length === 2 && tw.repost_journal_entries.length === 1 && tw.supersede_journal_entries.length === 1
  && tw.revert_ar_batches.length === 1 && tw.ar_opening_batch.rows.length === 4 && tw.ar_opening_batch.rows.filter((r) => r.prior_owner).length === 1 && tw.ap_opening_invoices.length === 1
  && tw.cutover_date.from === '2026-01-01' && tw.cutover_date.to === '2026-04-01', JSON.stringify(report.plan.summary));

// ---------------------------------------------------- refusals BEFORE any approval
check('no approval yet: the service refuses (NOT_APPROVED)', /NOT_APPROVED/.test((await code(() => svc.execute(ED, W.B, { completion_id: pf, preflight_sha256: report.sha256 }))) || ''));
check('no approval yet: the DATABASE refuses a direct call too', /not the approved preflight hash/.test((await code(() => rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: report.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
check('an operator / agent can never execute (service OWNER_ONLY)', /OWNER_ONLY/.test((await code(() => svc.execute({ kind: 'system', id: 'onboarding-operator' }, W.B, { completion_id: pf, preflight_sha256: report.sha256 }))) || '')
  && /OWNER_ONLY/.test((await code(() => svc.execute({ kind: 'agent', id: 'a1', assigned_stage: 'preflight' }, W.B, { completion_id: pf, preflight_sha256: report.sha256 }))) || '')
  && /OWNER_ONLY/.test((await code(() => svc.execute({ kind: 'human', id: 'staff', role: 'admin' }, W.B, { completion_id: pf, preflight_sha256: report.sha256 }))) || ''));
check('an operator / agent can never execute (DATABASE human gate)', /only a human/.test((await code(() => rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: report.sha256, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' }))) || ''));
check('an operator can never approve its own preflight (DATABASE)', /human/.test((await code(() => rpc('onboarding_approve', { p_batch: W.B, p_completion: pf, p_preflight_sha256: report.sha256, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' }))) || ''));
check('the 482 advance path into execute stays closed (only onboarding_execute enters execute)', /EXECUTE is not available/.test((await code(() => svc.advance(ED, W.B, { completion_id: pf, to: 'execute' }))) || ''));
check('nothing written by any refusal', JSON.stringify(await counts()) === JSON.stringify(base));

// ------------------------------------------------------------- owner approval
check('the owner approves the exact recorded report', (await code(() => svc.approve(ED, W.B, { completion_id: pf, preflight: report }))) === null);
const tampered = JSON.parse(JSON.stringify(report)); tampered.plan.writes.opening_journal_entries[0].lines[0].debit_cents += 1;
const tamperedHash = PF.buildConversionPreflight(PF.preflightBase(tampered), []).sha256;
check('approval for a DIFFERENT hash (a tampered report) is refused (service + DATABASE)',
  /APPROVAL_FOR_ANOTHER_HASH/.test((await code(() => svc.execute(ED, W.B, { completion_id: pf, preflight_sha256: tamperedHash }))) || '')
  && /not the approved preflight hash/.test((await code(() => rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: tamperedHash, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
check('the recorded report cannot be tampered with in place (append-only)', /append-only/.test((await code(() => db.query(`UPDATE onboarding_stage_events SET result = result WHERE id = $1`, [pf]))) || ''));
check('the approved hash is write-once (a second approval cannot swap it)', /write-once|human approval/.test((await code(() => db.query(`UPDATE conversion_batches SET approved_preflight_sha256 = $2 WHERE id = $1`, [W.B, tamperedHash]))) || ''));

// --------------------------------------- stale: Trusted activity changed after approval
await postJe(u(850), 'JE-LATE', '2026-04-20', 'manual', [[5000, 70, 0], [1000, 0, 70]]);
check('stale after approval: new Trusted activity -> the service refuses (PREFLIGHT_STALE)', /PREFLIGHT_STALE/.test((await code(() => svc.execute(ED, W.B, { completion_id: pf, preflight_sha256: report.sha256 }))) || ''));
check('stale after approval: a direct DATABASE call refuses too (post-cutover activity changed)', /post-cutover activity changed/.test((await code(() => rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: report.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
await db.exec(`DELETE FROM journal_entry_lines WHERE journal_entry_id = '${u(850)}'; DELETE FROM journal_entries WHERE id = '${u(850)}';`);
await db.exec(`UPDATE journal_entries SET status = 'voided', voided_at = now() WHERE id = '${N1}'`);
check('stale after approval: a neutralize target changed -> the DATABASE refuses (unchanged originals)', /entries to neutralize are unchanged/.test((await code(() => rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: report.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
await db.exec(`UPDATE journal_entries SET status = 'posted', voided_at = NULL WHERE id = '${N1}'`);
await db.exec(`UPDATE accounting_periods SET status = 'closed' WHERE community_id = '${COMM}' AND period_number = 4`);
check('a period closed after approval -> the DATABASE refuses (no open period for the re-post)', /no open accounting period/.test((await code(() => rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: report.sha256, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
await db.exec(`UPDATE accounting_periods SET status = 'open' WHERE community_id = '${COMM}' AND period_number = 4`);
const midState = await counts();
check('still nothing written; the batch is in preflight and write-locked', JSON.stringify(midState) === JSON.stringify(base)
  && (await one(`SELECT onboarding_stage, write_locked FROM conversion_batches WHERE id = $1`, [W.B])).onboarding_stage === 'preflight');

// ------------------------------------------- atomic failure: injected mid-transaction
await db.exec(`CREATE FUNCTION test_fail_ap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected AP failure'; END $$;
  CREATE TRIGGER trg_test_fail_ap BEFORE INSERT ON ap_invoices FOR EACH ROW EXECUTE FUNCTION test_fail_ap();`);
const failMsg = await code(() => svc.execute(ED, W.B, { completion_id: pf, preflight_sha256: report.sha256 }));
const afterFail = await counts();
const bAfterFail = await one(`SELECT onboarding_stage, write_locked, status FROM conversion_batches WHERE id = $1`, [W.B]);
check('an injected failure AFTER the journal entries, supersede and ledger writes surfaces as an error', /injected AP failure/.test(failMsg || ''), failMsg);
check('ATOMIC: everything rolled back (no conversion entries, legacy entry still posted, legacy batch still committed, no new batch / rows, cutover unchanged)',
  JSON.stringify(afterFail) === JSON.stringify(base), JSON.stringify(afterFail));
check('ATOMIC: the batch is back in preflight, write-locked, not posted; no execute event survived',
  bAfterFail.onboarding_stage === 'preflight' && bAfterFail.write_locked === true && bAfterFail.status === 'draft'
  && (await one(`SELECT count(*)::int AS n FROM onboarding_stage_events WHERE batch_id = $1 AND (stage = 'execute' OR to_stage = 'execute')`, [W.B])).n === 0);
const failed = (await svc.getExecution(W.B)).filter((x) => x.status === 'failed');
check('the failed attempt is recorded truthfully (status failed, the error, no execute result, no write rows)',
  failed.length === 1 && /injected AP failure/.test(failed[0].error) && !failed[0].execute_completion_id && JSON.stringify(failed[0].writes) === '{}');
await db.exec(`DROP TRIGGER trg_test_fail_ap ON ap_invoices; DROP FUNCTION test_fail_ap();`);

// ------------------------------------------------------------- the real execute
const res = await svc.execute(ED, W.B, { completion_id: pf, preflight_sha256: report.sha256 });
check('EXECUTE succeeds on retry after the rollback (same writes), with the planned write counts',
  res && res.status === 'executed' && res.write_counts.opening_journal_entries === 1 && res.write_counts.neutralize_journal_entries === 2 && res.write_counts.repost_journal_entries === 1
  && res.write_counts.supersede_journal_entries === 1 && res.write_counts.revert_ar_batches === 1 && res.write_counts.ar_opening_rows === 4 && res.write_counts.ap_opening_invoices === 1, JSON.stringify(res));
const EX = res.execution_id;
const conv = await q(`SELECT reference, source_module, posting_date::text AS d, reverses_je_id, source_reference, notes, period_id FROM journal_entries WHERE left(reference, 16) = 'CONV-EX-20260331' ORDER BY reference`);
check('journal entries: exactly the 4 planned references, live source_module values, on the planned dates',
  JSON.stringify(conv.map((j) => [j.reference, j.source_module, j.d])) === JSON.stringify([
    ['CONV-EX-20260331-NEUT-JE-D1', 'reversal', '2026-03-20'], ['CONV-EX-20260331-NEUT-JE-N1', 'reversal', '2026-03-15'],
    ['CONV-EX-20260331-OPEN-OPR', 'opening_entry', '2026-03-31'], ['CONV-EX-20260331-REPOST-JE-D1', 'manual', '2026-04-01']]), JSON.stringify(conv.map((j) => [j.reference, j.source_module, j.d])));
check('neutralizations reverse their originals; the re-post cites its original', conv.find((j) => j.reference.endsWith('NEUT-JE-N1')).reverses_je_id === N1
  && conv.find((j) => j.reference.endsWith('NEUT-JE-D1')).reverses_je_id === D1 && conv.find((j) => j.reference.endsWith('REPOST-JE-D1')).source_reference === D1);
check('provenance: every conversion entry names the batch, the preflight completion and the execution', conv.every((j) => j.notes.includes(W.B) && j.notes.includes(pf) && j.notes.includes(EX)));
const l1 = await one(`SELECT status, superseded_by_conversion, superseded_reason FROM journal_entries WHERE id = $1`, [L1]);
check('legacy import superseded (row kept), with the conversion code and execution provenance', l1.status === 'superseded' && l1.superseded_by_conversion === 'CONV-EX-20260331' && l1.superseded_reason.includes(EX));
check('originals kept: N1 and D1 still posted (the reversal is the audit trail); post-cutover JE-PC untouched',
  (await q(`SELECT status FROM journal_entries WHERE id IN ($1, $2, $3)`, [N1, D1, PC])).every((r) => r.status === 'posted'));
const tbAt = async (through) => Object.fromEntries((await q(`SELECT c.account_number AS a, sum(l.debit_cents - l.credit_cents)::int AS v FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id
  JOIN chart_of_accounts c ON c.id = l.account_id WHERE j.community_id = $1 AND ($2::date IS NULL OR j.posting_date <= $2::date) AND j.status = 'posted' GROUP BY 1 HAVING sum(l.debit_cents - l.credit_cents) <> 0 ORDER BY 1`, [COMM, through])).map((r) => [r.a, r.v]));
check('cutoff TB (3/31) = the source TB on every account', JSON.stringify(await tbAt(CUTOFF)) === JSON.stringify({ 1000: 10000, 1300: 2000, 2000: -500, 2400: -300, 3000: -8000, 4000: -5000, 5000: 1800 }), JSON.stringify(await tbAt(CUTOFF)));
check('current TB = cutoff TB + the preserved post-cutover entry + the re-post', JSON.stringify(await tbAt(null)) === JSON.stringify({ 1000: 10300, 1300: 2000, 2000: -550, 2400: -300, 3000: -8000, 4000: -5300, 5000: 1850 }), JSON.stringify(await tbAt(null)));
const nb = await one(`SELECT id, status, source_filename, row_count, notes FROM transaction_upload_batches WHERE source_filename = 'CONV-EX-20260331-AR'`);
const lb = await one(`SELECT status, replaced_by_batch_id, reverted_reason FROM transaction_upload_batches WHERE id = $1`, [LB]);
check('homeowner ledger: the opening batch is committed (4 rows); the legacy batch is reverted, replaced by it (rows kept)',
  nb.status === 'committed' && nb.row_count === 4 && lb.status === 'reverted' && lb.replaced_by_batch_id === nb.id && lb.reverted_reason.includes(EX)
  && (await one(`SELECT count(*)::int AS n FROM homeowner_transactions WHERE source_batch_id = $1`, [LB])).n === 2);
const rows = await q(`SELECT vantaca_account_id, property_id, tenure_id, txn_type, charge_category, amount_cents::int AS a, raw_row_jsonb, notes FROM homeowner_transactions WHERE source_batch_id = $1 ORDER BY source_row_index`, [nb.id]);
check('current owners: on their lot and current tenure', rows.filter((r) => r.vantaca_account_id === '10001').every((r) => r.property_id === P1 && r.tenure_id === T1) && rows.find((r) => r.vantaca_account_id === '10002').tenure_id === T2);
const prior = rows.find((r) => r.vantaca_account_id === '90009');
check('prior-owner credit: own source account, NO tenure, NO lot (the source prints a placeholder), flagged prior_owner, -$2.00',
  prior && prior.tenure_id === null && prior.property_id === null && prior.a === -200 && prior.raw_row_jsonb.onboarding.prior_owner === true && prior.raw_row_jsonb.prior_owner.ownership_dates === 'not established');
check('ledger ties: receivables 2000 = GL 1300; current prepaids -100 + prior-owner -200 = GL 2400', rows.filter((r) => r.txn_type !== 'credit').reduce((t, r) => t + r.a, 0) === 2000
  && rows.filter((r) => r.txn_type === 'credit').reduce((t, r) => t + r.a, 0) === -300);
check('provenance on every ledger row (batch, preflight completion, execution id)', rows.every((r) => r.raw_row_jsonb.onboarding.execution_id === EX && r.raw_row_jsonb.onboarding.preflight_completion_id === pf && r.notes.includes(EX)));
const ap = await one(`SELECT a.vendor_id, a.vendor_invoice_number, a.total_cents::int AS t, a.status, j.reference, a.notes FROM ap_invoices a JOIN journal_entries j ON j.id = a.posting_journal_entry_id`);
check('AP: the open invoice is posted by the opening entry (no second GL posting), with its idempotency key and provenance',
  ap && ap.vendor_id === V && ap.vendor_invoice_number === 'INV-1' && ap.t === 500 && ap.status === 'approved' && ap.reference === 'CONV-EX-20260331-OPEN-OPR' && ap.notes.includes('key CONV-EX-20260331:') && ap.notes.includes(EX));
const bt = await one(`SELECT onboarding_stage, write_locked, status FROM conversion_batches WHERE id = $1`, [W.B]);
check('cutover date 2026-04-01; batch posted, in execute, write lock CLOSED again', (await counts()).cutover === '2026-04-01' && bt.onboarding_stage === 'execute' && bt.write_locked === true && bt.status === 'posted');
const ev = await q(`SELECT event_type, stage, to_stage, actor_kind, result->>'status' AS st FROM onboarding_stage_events WHERE batch_id = $1 ORDER BY seq DESC LIMIT 3`, [W.B]);
check('audit: a human advance into execute, then the PASS execute result (the approval stayed separate)', ev[0].event_type === 'stage_completed' && ev[0].stage === 'execute' && ev[0].st === 'PASS'
  && ev[1].event_type === 'stage_advanced' && ev[1].to_stage === 'execute' && ev[1].actor_kind === 'human' && ev[2].event_type === 'preflight_approved' && ev[2].actor_kind === 'human');
const execs = await svc.getExecution(W.B);
const ok = execs.find((x) => x.status === 'committed');
check('execution record: committed, bound to the preflight completion + hash + approval event; write index by kind; proof + proof plan kept for M7',
  ok && ok.id === EX && ok.preflight_completion_id === pf && ok.preflight_sha256 === report.sha256 && ok.approval_event_id && ok.proof.cutoff_trial_balance === 'equal' && ok.proof.post_cutover_entries_unchanged === 1
  && JSON.stringify(Object.fromEntries(Object.entries(ok.writes).sort())) === JSON.stringify({ ap_opening_invoice: 1, ar_opening_batch: 1, ar_opening_row: 4, conversion_batch: 1, cutover_date: 1, neutralize_je: 2, opening_je: 1, repost_je: 1, revert_ar_batch: 1, supersede_je: 1 })
  && Array.isArray(ok.proof_plan) && ok.proof_plan.some((p) => p.check === 'cutoff_trial_balance'), JSON.stringify(ok && ok.writes));
check('execution records are append-only', /append-only/.test((await code(() => db.query(`UPDATE onboarding_executions SET error = 'x' WHERE id = $1`, [EX]))) || '')
  && /append-only/.test((await code(() => db.query(`DELETE FROM onboarding_execution_writes WHERE execution_id = $1`, [EX]))) || ''));

// --------------------------------------------------------------- idempotent retry
const afterExec = await counts();
const again = await svc.execute(ED, W.B, { completion_id: pf, preflight_sha256: report.sha256 });
const againDb = await rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: report.sha256, p_actor_kind: 'human', p_actor_id: 'ed' });
check('retry (service and DATABASE): returns the committed execution, writes NOTHING', again.status === 'already_executed' && again.execution_id === EX && again.rows_written_now === 0
  && againDb.status === 'already_executed' && againDb.execution_id === EX && JSON.stringify(await counts()) === JSON.stringify(afterExec));
check('retry with another hash / completion is refused, not executed again', /ALREADY_EXECUTED/.test((await code(() => svc.execute(ED, W.B, { completion_id: pf, preflight_sha256: tamperedHash }))) || '')
  && /already executed/.test((await code(() => rpc('onboarding_execute', { p_batch: W.B, p_completion: pf, p_preflight_sha256: tamperedHash, p_actor_kind: 'human', p_actor_id: 'ed' }))) || ''));
check('zero duplicate postings: references unique, one opening batch, one AP invoice, one committed execution',
  (await one(`SELECT count(*)::int AS n, count(DISTINCT reference)::int AS d FROM journal_entries WHERE left(reference, 16) = 'CONV-EX-20260331'`)).d === 4
  && (await one(`SELECT count(*)::int AS n FROM journal_entries WHERE left(reference, 16) = 'CONV-EX-20260331'`)).n === 4
  && (await one(`SELECT count(*)::int AS n FROM transaction_upload_batches WHERE source_filename = 'CONV-EX-20260331-AR'`)).n === 1
  && (await one(`SELECT count(*)::int AS n FROM ap_invoices`)).n === 1 && execs.filter((x) => x.status === 'committed').length === 1);
const op = await svc.operate(W.B);
check('the operator never acts on an executed batch (no runner for execute; nothing written)', op.reason === 'no_runner' && op.stopped_at === 'execute' && JSON.stringify(await counts()) === JSON.stringify(afterExec));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
