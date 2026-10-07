// tests/sql/onboarding_execute_straddle_e2e.mjs — migration 498 on the REAL SQL (Ed 2026-10-07).
// SCAR: Canyon Gate's approved conversion was refused at EXECUTE ("35 of 40 entries to neutralize
// are unchanged since the preflight"). The 5 were originals of void pairs that STRADDLE the cutoff
// (entry before, void reversal after): status 'voided' with a reversal, which COUNTS in the GL, but
// the neutralize precondition demanded 'posted'. Proves: before 498 EXECUTE refuses such a plan and
// writes nothing; with 498 it executes, the cutoff TB equals the source, and after the cutover the
// re-post and the existing reversal net to zero; a target voided WITHOUT a reversal is still refused.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { onboardingWorld, COMM } from './onboarding_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  onboarding execute straddle e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const { createOnboardingService } = require(`${REPO}/lib/onboarding/service.js`);
const { buildConversionPlan } = require(`${REPO}/lib/onboarding/conversion_plan.js`);
const { trustedFingerprint } = require(`${REPO}/lib/onboarding/bridge.js`);
const PF = require(`${REPO}/lib/onboarding/preflight.js`);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const code = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code || ''} ${e.message || ''}`; } };
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUTOFF = '2026-03-31';
const ctl = [{ code: 'ok', label: 'ok', status: 'PASS' }];
const ED = { kind: 'human', id: 'ed', role: 'owner' };

async function scenario(through, { reversal = true } = {}) {
  const world = await onboardingWorld(PGlite, { through, gl: true });
  const { rpc, db } = world;
  const q = async (sql, p) => (await db.query(sql, p)).rows; const one = async (sql, p) => (await q(sql, p))[0];
  const MC = u(900); const OPR = u(901); const ACC = { 1000: u(1000), 2000: u(2000), 3000: u(3000), 5000: u(5000) };
  await db.exec(`
    INSERT INTO management_companies VALUES ('${MC}');
    UPDATE communities SET management_company_id = '${MC}', gl_cutover_date = '2026-01-01' WHERE id = '${COMM}';
    INSERT INTO account_funds VALUES ('${OPR}', '${COMM}', 'OPR');
    ${Object.entries(ACC).map(([n, id]) => `INSERT INTO chart_of_accounts VALUES ('${id}', '${COMM}', '${n}', '${OPR}', NULL);`).join('\n    ')}
    INSERT INTO accounting_periods (community_id, fiscal_year, period_number, period_start, period_end, status)
      SELECT '${COMM}', 2026, m, make_date(2026, m, 1), (make_date(2026, m, 1) + interval '1 month - 1 day')::date, 'open' FROM generate_series(1, 12) m;`);
  const period = async (d) => (await one(`SELECT id FROM accounting_periods WHERE community_id = $1 AND period_start <= $2::date AND period_end >= $2::date`, [COMM, d])).id;
  const postJe = async (id, ref, date, module, lines, extra = {}) => {
    const tot = lines.reduce((t, [, dr]) => t + dr, 0);
    await db.query(`INSERT INTO journal_entries (id, community_id, period_id, posting_date, reference, description, source_module, total_debits_cents, total_credits_cents, status, reverses_je_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'posted', $9)`, [id, COMM, await period(date), date, ref, `synthetic ${ref}`, module, tot, extra.reverses || null]);
    let n = 0; for (const [acct, dr, cr] of lines) await db.query(`INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents) VALUES ($1, $2, $3, $4, $5, $6)`, [id, ++n, ACC[acct], OPR, dr, cr]);
  };
  // the straddling void pair: entry 3/20 (before the cutoff), its void reversal 4/10 (after it)
  const O = u(801); const V = u(802);
  await postJe(O, 'JE-O', '2026-03-20', 'ap_invoice', [[5000, 70, 0], [2000, 0, 70]]);
  if (reversal) { await postJe(V, 'JE-V', '2026-04-10', 'reversal', [[2000, 70, 0], [5000, 0, 70]], { reverses: O }); await db.query(`UPDATE journal_entries SET status = 'voided', voided_at = now(), void_reversal_je_id = $2 WHERE id = $1`, [O, V]); }
  const trustedNow = async () => ({
    journal_entries: await q(`SELECT id, posting_date::text, source_module, source_reference, reference, description, status, total_debits_cents::int, total_credits_cents::int, reverses_je_id, void_reversal_je_id, superseded_at::text, created_at::text, updated_at::text FROM journal_entries WHERE community_id = $1 ORDER BY id`, [COMM]),
    journal_entry_lines: await q(`SELECT l.id, l.journal_entry_id, l.line_number, l.account_id, l.fund_id, l.debit_cents::int, l.credit_cents::int, l.property_id, l.vendor_id, l.created_at::text FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id WHERE j.community_id = $1 ORDER BY l.id`, [COMM]),
    ap_invoices: [], homeowner_transactions: [], ap_payments: [], ar_charges: [], ar_payments: [], payments: [] });
  const ctxNow = async () => ({ accounts: await q(`SELECT id, account_number, fund_id, vantaca_account_number FROM chart_of_accounts WHERE community_id = $1`, [COMM]),
    funds: (await q(`SELECT id, fund_code FROM account_funds WHERE community_id = $1`, [COMM])).map((f) => ({ id: f.id, code: f.fund_code })), properties: [], tenures: [], vendors: [],
    periods: await q(`SELECT id, period_start::text, period_end::text, status FROM accounting_periods WHERE community_id = $1`, [COMM]), management_company_id: MC,
    gl_cutover_date: (await one(`SELECT gl_cutover_date::text AS d FROM communities WHERE id = $1`, [COMM])).d });
  const svc = createOnboardingService({ rpc, storage: { async putOnce() {}, async get() { return Buffer.alloc(0); } }, trustedReader: async () => ({ trusted: await trustedNow(), accountNumber: () => null, accountOfProperty: () => null }), conversionContext: ctxNow });
  const code6 = 'CONV-STRADDLE-20260331';
  const B = await rpc('onboarding_create_batch', { p_community: COMM, p_batch_code: code6, p_as_of: CUTOFF, p_source_system: 'vantaca', p_actor_kind: 'human', p_actor_id: 'ed' });
  for (const s of ['intake', 'normalize', 'source_controls']) { const c = await rpc('onboarding_record_completion', { p_batch: B, p_stage: s, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: {}, p_actor_kind: 'system', p_actor_id: 'op' }); await rpc('onboarding_auto_advance', { p_batch: B, p_completion: c, p_actor_id: 'op' }); }
  const lines = [['1000', 10000], ['3000', -10000]].map(([a, c], i) => ({ line_no: i + 1, kind: 'gl_opening_balance', component: 'gl', account_code: a, amount_cents: c, batch_code: code6, cutoff_date: CUTOFF, detail: {}, provenance: [{ artifact: 'synthetic', line: i + 1 }] }));
  const sn = await rpc('onboarding_record_snapshot', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' } }, p_lines: lines, p_snapshot_sha256: 'a'.repeat(64), p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: sn, p_actor_id: 'op' });
  const fp = trustedFingerprint(await trustedNow());
  const items = [{ item_no: 1, event_key: `je:${O}`, kind: 'ap_invoice', classification: 'OUT_OF_SCOPE', method: 'void_pair_nets_to_zero', amount_cents: 70, event_date: '2026-03-20', records: [`journal_entries:${O}`] },
    ...(reversal ? [{ item_no: 2, event_key: `je:${V}`, kind: 'reversal', classification: 'OUT_OF_SCOPE', method: 'void_pair_nets_to_zero', amount_cents: 70, event_date: '2026-04-10', records: [`journal_entries:${V}`] }] : [])]
    .map((it) => ({ confidence: 'high', evidence: {}, ...it, batch_code: code6, cutoff_date: CUTOFF }));
  const br = await rpc('onboarding_record_bridge', { p_batch: B, p_status: 'PASS', p_open: [], p_controls: ctl, p_summary: { snapshot_completion_id: sn, bridge_engine: 'test' }, p_items: items, p_bridge_sha256: 'b'.repeat(64), p_trusted_fingerprint: fp, p_actor_kind: 'system', p_actor_id: 'op' });
  await rpc('onboarding_auto_advance', { p_batch: B, p_completion: br, p_actor_id: 'op' });
  const ctx = await ctxNow(); const trusted = await trustedNow();
  const plan = buildConversionPlan({ batch: { id: B, batch_code: code6, community_id: COMM, as_of_date: CUTOFF }, snapshot: { completion_id: sn, sha256: 'a'.repeat(64), roles: { ar_account: '1300', prepaid_account: '2400', ap_account: '2000' }, lines },
    bridge: { completion_id: br, sha256: 'b'.repeat(64), trusted_fingerprint: fp, status: 'PASS', items }, source: {}, trusted, ctx: { ...ctx, current_trusted_fingerprint: trustedFingerprint(trusted) } });
  const { controls, ...body } = plan;
  const report = PF.buildConversionPreflight({ batch: { batch_code: code6, community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: CUTOFF, cutover_date: plan.cutover },
    inputs: { snapshot: { completion_id: sn, sha256: 'a'.repeat(64), status: 'PASS' }, bridge: { completion_id: br, sha256: 'b'.repeat(64), trusted_fingerprint: fp, status: 'PASS', engine: 'test' }, decisions: [], bridge_waivers: [], artifacts: [] }, plan: body, controls }, []);
  const pf = await rpc('onboarding_record_completion', { p_batch: B, p_stage: 'preflight', p_status: report.status.overall, p_open: report.controls.filter((c) => c.status !== 'PASS').map((c) => c.code),
    p_controls: report.controls.map((c) => ({ code: c.code, label: c.label, status: c.status })), p_summary: { preflight_format: report.format, preflight_sha256: report.sha256, preflight_report: report }, p_actor_kind: 'system', p_actor_id: 'onboarding-operator' });
  const appr = await code(() => svc.approve(ED, B, { completion_id: pf, preflight: report }));
  const before = await one(`SELECT count(*)::int AS n FROM journal_entries`);
  const ex = await code(() => svc.execute(ED, B, { completion_id: pf, preflight_sha256: report.sha256 }));
  const after = await one(`SELECT count(*)::int AS n FROM journal_entries`);
  const tb = async (through, from = null) => Object.fromEntries((await q(`SELECT a.account_number, sum(l.debit_cents - l.credit_cents)::int AS net FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE j.community_id = $1 AND (j.status = 'posted' OR (j.status = 'voided' AND j.void_reversal_je_id IS NOT NULL)) AND j.posting_date <= $2::date AND ($3::date IS NULL OR j.posting_date >= $3::date) GROUP BY 1`, [COMM, through, from])).filter((r) => r.net !== 0).map((r) => [r.account_number, r.net]));
  return { report, appr, ex, before: before.n, after: after.n, plan, tb };
}

const old = await scenario(491);
check('setup: the plan moves the straddling entry across the cutover (neutralize + re-post) and every preflight control PASSES', old.report.status.overall === 'PASS' && old.plan.writes.neutralize_journal_entries.length === 1 && old.plan.writes.repost_journal_entries.length === 1, JSON.stringify(old.report.controls.filter((c) => c.status !== 'PASS')));
check('BEFORE 498: EXECUTE refuses the approved plan (the voided original is not "posted"), and writes nothing', old.appr === null && /entries to neutralize are unchanged/.test(old.ex || '') && old.after === old.before, old.ex);

const neu = await scenario(498);
check('WITH 498: the same approved plan EXECUTES', neu.appr === null && neu.ex === null, neu.ex);
const cut = await neu.tb('2026-03-31'); const postCut = await neu.tb('2026-12-31', '2026-04-01');
check('cutoff TB = the source exactly (1000 +10000, 3000 -10000; the straddling entry nets to zero before the cutover)', JSON.stringify(cut) === JSON.stringify({ 1000: 10000, 3000: -10000 }), JSON.stringify(cut));
check('after the cutover the re-post and the existing void reversal net to zero (no residue in 2000 / 5000)', Object.keys(postCut).length === 0, JSON.stringify(postCut));

const orphan = await (async () => {
  const s = await onboardingWorld(PGlite, { through: 498, gl: true });
  const src = (await s.db.query(`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p WHERE p.proname = 'onboarding_execute'`)).rows[0].d;
  return /j\.status = 'voided' AND j\.void_reversal_je_id IS NOT NULL/.test(src) && !/AND j\.status = 'posted'\s*\n\s*AND j\.posting_date/.test(src);
})();
check('the applied execute function accepts exactly the counted predicate for neutralize targets (voided requires its reversal)', orphan);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
