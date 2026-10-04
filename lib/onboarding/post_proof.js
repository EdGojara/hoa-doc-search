// ============================================================================
// lib/onboarding/post_proof.js  (Issue #15) — post-conversion proof (stage 7)
// ----------------------------------------------------------------------------
// PURE and READ-ONLY: given the committed execution, the approved preflight
// report it executed, the bridge records and a read-only snapshot of the books
// AFTER execution, prove the conversion landed exactly as approved. Reuses the
// M6 proof expectations (report.plan: writes, summary, proof_plan, preconditions).
//
// Robust to legitimate activity AFTER the conversion: balances are checked AS OF
// THE CUTOFF; "post-cutover entries unchanged" is checked over the entries that
// existed when the execution committed; the current-TB projection is not re-run
// (EXECUTE verified it inside its own transaction). The Trusted fingerprint is
// EXPECTED to differ from the bridge's after execution (the conversion changed
// the books by design); it is never a reason to rebuild anything here.
// ============================================================================
const crypto = require('crypto');
const { countsInGl } = require('../accounting/je_status');

const d10 = (v) => (v ? String(v).slice(0, 10) : null);
const ctl = (code, label, failures, extra = {}) => ({ code, label, level: 'post_proof', status: failures.length ? 'FAIL' : 'PASS', failures,
  ...(extra.left != null ? { left_cents: extra.left } : {}), ...(extra.right != null ? { right_cents: extra.right, difference_cents: (extra.left || 0) - extra.right } : {}) });
const parseRecord = (r) => { const s = String(r); const i = s.indexOf(':'); return { table: s.slice(0, i), id: s.slice(i + 1) }; };

/**
 * @param {object} p
 *   batch       { id, batch_code, approved_preflight_sha256 }
 *   executions  all onboarding_executions rows of the batch
 *   report      the approved preflight report (v2) the execution was bound to
 *   preflight_completion_id
 *   bridge_items  [{ item_no, classification, records: ['table:id'] }] of the bridge result the preflight bound
 *   data        read-only books after execution:
 *               { journal_entries, journal_entry_lines, accounts, upload_batches, conversion_rows, ap_invoices, properties,
 *                 current_owner_ledger_ids, gl_cutover_date, execution_writes, canonical_counts }
 */
function buildPostProof({ batch, executions, report, preflight_completion_id, bridge_items = [], data }) {
  const controls = []; const code = batch.batch_code; const plan = report.plan; const w = plan.writes; const cutoff = plan.cutoff;
  const committed = (executions || []).filter((x) => x.status === 'committed'); const ex = committed[0] || null;
  controls.push(ctl('post_proof.single_committed_execution', 'Exactly one committed execution, bound to the approved preflight result and hash',
    committed.length !== 1 ? [{ committed: committed.length }] : (ex.preflight_completion_id !== preflight_completion_id || ex.preflight_sha256 !== report.sha256 || batch.approved_preflight_sha256 !== report.sha256 ? [{ execution: ex.id, preflight_completion_id: ex.preflight_completion_id, preflight_sha256: ex.preflight_sha256 }] : [])));
  if (!ex) return { controls, summary: { execution_id: null } };

  const acct = new Map((data.accounts || []).map((a) => [a.id, a.account_number]));
  const jes = data.journal_entries || [];
  const linesOf = new Map(); for (const l of data.journal_entry_lines || []) { if (!linesOf.has(l.journal_entry_id)) linesOf.set(l.journal_entry_id, []); linesOf.get(l.journal_entry_id).push(l); }
  const tb = new Map();
  for (const j of jes.filter((x) => countsInGl(x) && d10(x.posting_date) <= cutoff)) for (const l of linesOf.get(j.id) || []) { const a = acct.get(l.account_id) || `?${l.account_id}`; tb.set(a, (tb.get(a) || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0)); }
  const tbOf = (a) => tb.get(a) || 0;
  const expected = (plan.proof_plan.find((x) => x.check === 'cutoff_trial_balance') || {}).expected || {};
  const tbDiff = [...new Set([...Object.keys(expected), ...tb.keys()])].sort().filter((a) => tbOf(a) !== (expected[a] || 0)).map((a) => ({ account: a, trusted_cents: tbOf(a), source_cents: expected[a] || 0 }));
  controls.push(ctl('post_proof.cutoff_tb_equals_source', `Trusted trial balance at ${cutoff} equals the source on every account (all others zero)`, tbDiff));
  const tbNet = [...tb.values()].reduce((t, v) => t + v, 0);
  controls.push(ctl('post_proof.cutoff_tb_balances', `Trial balance at ${cutoff}: debits = credits`, tbNet === 0 ? [] : [{ net_cents: tbNet }]));

  // ---- conversion entries
  const conv = jes.filter((j) => String(j.reference || '').startsWith(code));
  const planned = [...w.opening_journal_entries, ...w.neutralize_journal_entries, ...w.repost_journal_entries];
  const convProblems = [];
  if (conv.length !== planned.length || new Set(conv.map((j) => j.reference)).size !== conv.length) convProblems.push({ written: conv.length, planned: planned.length, unique: new Set(conv.map((j) => j.reference)).size });
  for (const p of planned) {
    const j = conv.find((x) => x.reference === p.reference);
    if (!j) { convProblems.push({ reference: p.reference, problem: 'missing' }); continue; }
    const ls = linesOf.get(j.id) || []; const dr = ls.reduce((t, l) => t + Number(l.debit_cents || 0), 0); const cr = ls.reduce((t, l) => t + Number(l.credit_cents || 0), 0);
    if (j.status !== 'posted' || dr !== cr || dr !== Number(p.total_debits_cents) || d10(j.posting_date) !== p.posting_date || (p.period_id && j.period_id !== p.period_id) || j.source_module !== p.source_module) convProblems.push({ reference: p.reference, status: j.status, dr, cr, date: d10(j.posting_date), period_ok: !p.period_id || j.period_id === p.period_id, module: j.source_module });
    if (!String(j.notes || '').includes(ex.id)) convProblems.push({ reference: p.reference, problem: 'no execution provenance' });
  }
  controls.push(ctl('post_proof.conversion_entries_as_planned', `${planned.length} conversion entries (${w.opening_journal_entries.length} opening / ${w.neutralize_journal_entries.length} neutralize / ${w.repost_journal_entries.length} re-post): balanced, posted, planned date / period / module, execution provenance`, convProblems));
  const sup = jes.filter((j) => j.status === 'superseded' && j.superseded_by_conversion === code);
  const supMissing = w.supersede_journal_entries.filter((s) => !sup.some((j) => j.id === s.id)).map((s) => s.id);
  controls.push(ctl('post_proof.legacy_entries_superseded', `${w.supersede_journal_entries.length} legacy-import entries superseded (exactly the planned ones)`, [...(sup.length !== w.supersede_journal_entries.length ? [{ superseded: sup.length, planned: w.supersede_journal_entries.length }] : []), ...supMissing.map((id) => ({ missing: id }))]));

  // ---- homeowner ledger
  const ub = data.upload_batches || [];
  const convBatches = ub.filter((b) => b.uploaded_by === w.ar_opening_batch.uploaded_by);
  const revProblems = w.revert_ar_batches.filter((r) => { const b = ub.find((x) => x.id === r.id); return !b || b.status !== 'reverted' || (convBatches[0] && b.replaced_by_batch_id !== convBatches[0].id); }).map((r) => ({ batch: r.id }));
  controls.push(ctl('post_proof.ledger_batches_replaced', `${w.revert_ar_batches.length} legacy ledger batch(es) reverted (rows kept) and replaced by ONE committed conversion batch`, [...revProblems, ...(convBatches.length !== 1 || convBatches[0].status !== 'committed' ? [{ conversion_batches: convBatches.length }] : [])]));
  const rows = data.conversion_rows || [];
  const prior = (r) => !!((r.raw_row_jsonb && r.raw_row_jsonb.onboarding && r.raw_row_jsonb.onboarding.prior_owner) || (r.raw_row_jsonb && r.raw_row_jsonb.prior_owner));
  const recv = rows.filter((r) => r.txn_type !== 'credit').reduce((t, r) => t + Number(r.amount_cents), 0);
  const curPre = rows.filter((r) => r.txn_type === 'credit' && !prior(r)).reduce((t, r) => t + Number(r.amount_cents), 0);
  const priorRows = rows.filter((r) => r.txn_type === 'credit' && prior(r)); const priorSum = priorRows.reduce((t, r) => t + Number(r.amount_cents), 0);
  const roles = { ar: '1300', pp: '2400', ap: '2000' };
  const arA = ((plan.proof_plan.find((x) => x.check === 'ar_subledger') || {}).text || '').match(/GL (\d+)/); if (arA) roles.ar = arA[1];
  controls.push(ctl('post_proof.homeowner_ledger_rows', `${w.ar_opening_batch.row_count} homeowner-ledger opening rows, dated ${cutoff}`, rows.length === w.ar_opening_batch.row_count && rows.every((r) => d10(r.transaction_date) === cutoff) ? [] : [{ rows: rows.length, planned: w.ar_opening_batch.row_count }]));
  controls.push(ctl('post_proof.ar_ties', `Receivables: GL ${roles.ar} at ${cutoff} = homeowner ledger = plan`, recv === tbOf(roles.ar) && recv === w.ar_opening_batch.receivable_cents ? [] : [{ gl_cents: tbOf(roles.ar), ledger_cents: recv, plan_cents: w.ar_opening_batch.receivable_cents }], { left: recv, right: tbOf(roles.ar) }));
  controls.push(ctl('post_proof.prepaid_ties', `Prepaids: GL ${roles.pp} at ${cutoff} = current-owner + prior-owner credits = plan`, curPre + priorSum === tbOf(roles.pp) && curPre === w.ar_opening_batch.current_owner_prepaid_cents && priorSum === w.ar_opening_batch.prior_owner_credit_cents ? [] : [{ gl_cents: tbOf(roles.pp), current_owner_cents: curPre, prior_owner_cents: priorSum }], { left: curPre + priorSum, right: tbOf(roles.pp) }));
  const currentAccts = new Set((data.properties || []).map((p) => String(p.vantaca_account_id)));
  const inCurrent = new Set(data.current_owner_ledger_ids || []);
  controls.push(ctl('post_proof.prior_owner_isolated', 'Prior-owner rows: no tenure, not on a current property account, never in the current-owner ledger',
    priorRows.filter((r) => r.tenure_id || currentAccts.has(String(r.vantaca_account_id)) || inCurrent.has(r.id)).map((r) => ({ row: r.id }))));

  // ---- AP
  const convAp = (data.ap_invoices || []).filter((a) => String(a.notes || '').includes(`key ${code}:`));
  const openRefs = new Set(w.opening_journal_entries.map((j) => j.reference));
  const openIds = new Set(conv.filter((j) => openRefs.has(j.reference)).map((j) => j.id));
  const apSum = convAp.reduce((t, a) => t + Number(a.total_cents), 0);
  const apPlan = w.ap_opening_invoices.reduce((t, a) => t + Number(a.total_cents), 0);
  controls.push(ctl('post_proof.ap_ties', `Open AP: GL ${roles.ap} at ${cutoff} = conversion AP invoices = plan, posted by the opening entry`,
    convAp.length === w.ap_opening_invoices.length && apSum === apPlan && -apSum === tbOf(roles.ap) && convAp.every((a) => openIds.has(a.posting_journal_entry_id)) ? [] : [{ invoices: convAp.length, invoices_cents: apSum, plan_cents: apPlan, gl_cents: tbOf(roles.ap) }], { left: -apSum, right: tbOf(roles.ap) }));

  // ---- untouched + cutover + write log
  const postCut = jes.filter((j) => countsInGl(j) && d10(j.posting_date) >= plan.cutover && !String(j.reference || '').startsWith(code) && (!j.created_at || !(Date.parse(j.created_at) > Date.parse(ex.created_at))));
  const fp = crypto.createHash('sha256').update(JSON.stringify(postCut.map((j) => [j.id, j.status, Number(j.total_debits_cents || 0), (linesOf.get(j.id) || []).length]).sort())).digest('hex');
  controls.push(ctl('post_proof.post_cutover_entries_unchanged', `The ${plan.preconditions.post_cutover_entries.count} post-cutover entries that existed at execution are unchanged (fingerprint = preflight preconditions)`,
    postCut.length === plan.preconditions.post_cutover_entries.count && fp === plan.preconditions.post_cutover_entries.fingerprint ? [] : [{ count: postCut.length, fingerprint_matches: fp === plan.preconditions.post_cutover_entries.fingerprint }]));
  const touched = new Set([...w.supersede_journal_entries.map((s) => s.id), ...w.neutralize_journal_entries.map((n) => n.original_je_id)]);
  const keepItems = new Set(plan.untouched.filter((u) => ['LEGITIMATE_SUBSEQUENT', 'OUT_OF_SCOPE'].includes(u.classification)).map((u) => u.item_no));
  const keepJes = bridge_items.filter((it) => keepItems.has(it.item_no)).flatMap((it) => (it.records || []).map(parseRecord).filter((r) => r.table === 'journal_entries').map((r) => r.id));
  controls.push(ctl('post_proof.untouched_items_untouched', `${plan.untouched.length} untouched bridge items: no subsequent / out-of-scope entry was superseded or neutralized`, keepJes.filter((id) => touched.has(id) || (jes.find((j) => j.id === id) || {}).superseded_by_conversion).map((id) => ({ je: id }))));
  controls.push(ctl('post_proof.cutover_date', `GL cutover date = ${w.cutover_date.to}`, d10(data.gl_cutover_date) === w.cutover_date.to ? [] : [{ gl_cutover_date: d10(data.gl_cutover_date) }]));
  const byKind = (data.execution_writes || []).reduce((m, x) => { m[x.write_kind] = (m[x.write_kind] || 0) + 1; return m; }, {});
  const s = plan.summary;
  const want = { opening_je: s.opening_journal_entries, neutralize_je: s.neutralize_journal_entries, repost_je: s.repost_journal_entries, supersede_je: s.supersede_journal_entries, revert_ar_batch: s.revert_ar_batches, ar_opening_batch: 1, ar_opening_row: s.ar_opening_rows, ap_opening_invoice: s.ap_opening_invoices, cutover_date: 1, conversion_batch: 1 };
  const logDiff = Object.keys({ ...want, ...byKind }).filter((k) => (byKind[k] || 0) !== (want[k] || 0)).map((k) => ({ kind: k, logged: byKind[k] || 0, planned: want[k] || 0 }));
  controls.push(ctl('post_proof.write_log_equals_plan', 'The execution write log equals the plan exactly (no unexpected or duplicate writes)', logDiff));
  const cc = data.canonical_counts || null;
  controls.push(ctl('post_proof.canonical_data_untouched', 'Canonical community data readable and untouched by the conversion (the write log names no canonical table)',
    !cc || Object.values(cc).some((v) => v == null) ? [{ problem: 'canonical community data not readable' }] : (data.execution_writes || []).filter((x) => /^cd_/.test(x.table_name)).map((x) => ({ table: x.table_name }))));
  return { controls, summary: { execution_id: ex.id, committed_at: ex.created_at, preflight_completion_id, preflight_sha256: report.sha256, write_counts: byKind, canonical_counts: cc,
    ar_cents: recv, current_owner_prepaid_cents: curPre, prior_owner_credit_cents: priorSum, ap_cents: apSum, conversion_entries: conv.length, superseded: sup.length } };
}

module.exports = { buildPostProof };
