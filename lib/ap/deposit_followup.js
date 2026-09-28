// ============================================================================
// lib/ap/deposit_followup.js  (Ed 2026-09-28)
// ----------------------------------------------------------------------------
// The deposit -> balance-due follow-up, on top of the vendor_deposits subledger
// (migration 364) and the reconciliation ledger (migration 471, PROPOSED).
//
//   upcomingBalances()      the "Upcoming vendor balances" queue: every
//                           OUTSTANDING deposit, its due date, the expected
//                           balance (labeled ESTIMATE unless quote/contract), and
//                           the deposit invoice's LIVE payment state. Keyed on
//                           vendor_deposits, so it survives the deposit being
//                           approved and paid.
//   setFollowup()           staff record the event / due date / agreed total.
//   proposeReconciliation() run lib/ap/deposit_reconcile.js against a bill and
//                           store the immutable proposal.
//   decideReconciliation()  a named person approves or rejects. Approving marks
//                           the deposit applied to that bill, and ONLY when the
//                           bill's payable already equals the net due.
//   pendingForInvoice()     used by the approval endpoint: a bill with an
//                           undecided reconciliation can't be approved/released.
//
// Nothing in this file pays, creates a payable, or changes an AP amount. The
// final bill goes through the normal two-key approval and check run.
// ============================================================================
const { reconcileDeposit, depositPosition, approvalBlockers } = require('./deposit_reconcile');

const missingTable = (e) => !!e && /does not exist|schema cache|column .* does not exist/i.test(String(e.message || ''));
const FOLLOWUP_FIELDS = ['event_date', 'balance_due_date', 'balance_due_basis', 'agreed_total_cents', 'agreed_total_basis', 'project_id', 'notes'];
const DUE_BASES = ['deposit_invoice_terms', 'contract', 'vendor_confirmed', 'staff_entered'];
const TOTAL_BASES = ['derived_from_deposit_invoice', 'invoice_estimate', 'quote', 'contract', 'staff_entered'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

async function logEvent(supabase, { depositId, type, actor, actorUserId = null, detail = {} }) {
  const { error } = await supabase.from('vendor_deposit_events').insert({ deposit_id: depositId, event_type: type, actor: actor || 'system', actor_user_id: actorUserId, detail });
  if (error && !missingTable(error)) console.warn('[deposit_followup] event not recorded:', error.message);
}

async function loadDeposit(supabase, depositId) {
  const { data: deposit, error } = await supabase.from('vendor_deposits').select('*').eq('id', depositId).maybeSingle();
  if (error) throw error;
  if (!deposit) return { deposit: null };
  let depositInvoice = null;
  if (deposit.deposit_invoice_id) {
    const { data, error: iErr } = await supabase.from('ap_invoices')
      .select('id, vendor_invoice_number, invoice_date, total_cents, amount_paid_cents, status, file_sha256, paid_at')
      .eq('id', deposit.deposit_invoice_id).maybeSingle();
    if (iErr) throw iErr;
    depositInvoice = data || null;
  }
  return { deposit, depositInvoice };
}

// The follow-up as a person reads it. Every amount says where it came from.
function describe(deposit, depositInvoice) {
  const pos = depositPosition(deposit, depositInvoice);
  const today = new Date().toISOString().slice(0, 10);
  const due = deposit.balance_due_date || null;
  const daysToDue = due ? Math.round((Date.parse(due) - Date.parse(today)) / 86400000) : null;
  return {
    deposit_id: deposit.id, community_id: deposit.community_id, vendor_id: deposit.vendor_id,
    project_description: deposit.project_description || null, project_id: deposit.project_id || null,
    event_date: deposit.event_date || null, balance_due_date: due, balance_due_basis: deposit.balance_due_basis || null,
    days_to_due: daysToDue, due_state: due == null ? 'no_due_date' : daysToDue < 0 ? 'past_due' : daysToDue <= 7 ? 'due_soon' : 'upcoming',
    deposit_invoice: depositInvoice ? {
      id: depositInvoice.id, number: depositInvoice.vendor_invoice_number, status: depositInvoice.status,
      total_cents: depositInvoice.total_cents, amount_paid_cents: depositInvoice.amount_paid_cents || 0,
    } : null,
    deposit_billed_cents: pos.billed, deposit_paid_cents: pos.paid, deposit_still_owed_cents: pos.still_owed,
    agreed_total_cents: pos.agreed_total_cents, agreed_total_basis: pos.agreed_total_basis,
    expected_balance_cents: pos.expected_balance_cents,
    expected_balance_label: pos.expected_balance_cents == null ? 'Unknown until the vendor bills or a quote/contract is attached'
      : pos.estimate ? 'ESTIMATE (not an invoice; confirm against the final bill)' : `Per ${pos.agreed_total_basis}`,
    status: deposit.status, applied_invoice_id: deposit.applied_invoice_id || null,
  };
}

async function upcomingBalances(supabase, { communityId = null, includeApplied = false } = {}) {
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    let q = supabase.from('vendor_deposits').select('*, vendors:vendor_id(name), communities:community_id(name)')
      .order('created_at', { ascending: true }).range(from, from + 999);
    if (!includeApplied) q = q.eq('status', 'outstanding');
    if (communityId) q = q.eq('community_id', communityId);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const invIds = [...new Set(out.map((d) => d.deposit_invoice_id).filter(Boolean))];
  const invById = new Map();
  for (let i = 0; i < invIds.length; i += 200) {
    const { data, error } = await supabase.from('ap_invoices')
      .select('id, vendor_invoice_number, invoice_date, total_cents, amount_paid_cents, status, file_sha256, paid_at')
      .in('id', invIds.slice(i, i + 200));
    if (error) throw error;
    for (const r of data || []) invById.set(r.id, r);
  }
  // Pending (undecided) reconciliations per deposit, if migration 471 is in.
  const pendingByDeposit = new Map();
  if (out.length) {
    const { data: recs, error: rErr } = await supabase.from('vendor_deposit_reconciliations')
      .select('id, deposit_id, incoming_invoice_id, form, net_due_cents, needs_review, created_at')
      .in('deposit_id', out.map((d) => d.id).slice(0, 1000));
    if (rErr && !missingTable(rErr)) throw rErr;
    if (recs && recs.length) {
      const { data: decs, error: dErr } = await supabase.from('vendor_deposit_reconciliation_decisions')
        .select('reconciliation_id').in('reconciliation_id', recs.map((r) => r.id));
      if (dErr && !missingTable(dErr)) throw dErr;
      const decided = new Set((decs || []).map((d) => d.reconciliation_id));
      for (const r of recs) if (!decided.has(r.id)) (pendingByDeposit.get(r.deposit_id) || pendingByDeposit.set(r.deposit_id, []).get(r.deposit_id)).push(r);
    }
  }
  return out.map((d) => ({
    ...describe(d, invById.get(d.deposit_invoice_id) || null),
    vendor_name: (d.vendors && d.vendors.name) || null, community_name: (d.communities && d.communities.name) || null,
    pending_reconciliations: pendingByDeposit.get(d.id) || [],
  })).sort((a, b) => (a.balance_due_date || '9999').localeCompare(b.balance_due_date || '9999'));
}

async function setFollowup(supabase, { depositId, fields = {}, actor, actorUserId = null }) {
  const patch = {};
  for (const k of FOLLOWUP_FIELDS) if (Object.prototype.hasOwnProperty.call(fields, k)) patch[k] = fields[k] === '' ? null : fields[k];
  if (!Object.keys(patch).length) return { error: 'nothing_to_update' };
  for (const k of ['event_date', 'balance_due_date']) if (patch[k] != null && !isDate(patch[k])) return { error: `${k}_invalid` };
  if (patch.balance_due_date != null && !patch.balance_due_basis && !fields.balance_due_basis) patch.balance_due_basis = 'staff_entered';
  if (patch.balance_due_basis != null && !DUE_BASES.includes(patch.balance_due_basis)) return { error: 'balance_due_basis_invalid' };
  if (patch.agreed_total_cents != null) {
    if (!Number.isInteger(patch.agreed_total_cents) || patch.agreed_total_cents < 0) return { error: 'agreed_total_cents_invalid' };
    if (!patch.agreed_total_basis) return { error: 'agreed_total_basis_required', hint: 'Say where the total came from: invoice_estimate, quote, contract or staff_entered.' };
  }
  if (patch.agreed_total_basis != null && !TOTAL_BASES.includes(patch.agreed_total_basis)) return { error: 'agreed_total_basis_invalid' };
  const { deposit } = await loadDeposit(supabase, depositId);
  if (!deposit) return { error: 'not_found' };
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, deposit[k] === undefined ? null : deposit[k]]));
  const { error } = await supabase.from('vendor_deposits').update(patch).eq('id', depositId);
  if (error) return missingTable(error) ? { error: 'migration_471_required' } : { error: error.message };
  await logEvent(supabase, { depositId, type: 'followup_set', actor, actorUserId, detail: { before, after: patch } });
  return { ok: true, deposit_id: depositId, updated: patch };
}

async function proposeReconciliation(supabase, { depositId, invoiceId, actor, actorUserId = null, isStatement = false }) {
  const { deposit, depositInvoice } = await loadDeposit(supabase, depositId);
  if (!deposit) return { error: 'deposit_not_found' };
  if (deposit.status !== 'outstanding') return { error: 'deposit_not_outstanding' };
  if (invoiceId === deposit.deposit_invoice_id) return { error: 'same_as_deposit_invoice' };
  const { data: inv, error: iErr } = await supabase.from('ap_invoices')
    .select('id, community_id, vendor_id, vendor_invoice_number, invoice_date, total_cents, tax_cents, file_sha256, status, notes').eq('id', invoiceId).maybeSingle();
  if (iErr) throw iErr;
  if (!inv) return { error: 'invoice_not_found' };
  if (inv.community_id !== deposit.community_id || (deposit.vendor_id && inv.vendor_id !== deposit.vendor_id)) return { error: 'vendor_or_community_mismatch' };
  const { data: lines, error: lErr } = await supabase.from('ap_invoice_lines').select('description, amount_cents').eq('invoice_id', invoiceId).order('line_number');
  if (lErr) throw lErr;
  let statement = isStatement;
  if (!statement) { try { statement = require('./statement_lines').classifyStatement(lines || []).is_statement; } catch (_) { /* optional */ } }
  const isDepositBill = /DEPOSIT invoice/i.test(inv.notes || '');
  const r = reconcileDeposit({ deposit, depositInvoice, incoming: { ...inv, is_deposit_invoice: isDepositBill }, incomingLines: lines || [], isStatement: statement });
  const row = {
    deposit_id: deposit.id, community_id: deposit.community_id, vendor_id: deposit.vendor_id || null, incoming_invoice_id: invoiceId,
    form: r.form, agreed_total_cents: r.agreed_total_cents, agreed_total_basis: r.agreed_total_basis,
    deposit_billed_cents: r.deposit_billed_cents, deposit_paid_cents: r.deposit_paid_cents, deposit_still_owed_cents: r.deposit_still_owed_cents,
    incoming_face_cents: r.incoming_face_cents, credits_shown_cents: r.credits_shown_cents, extras_cents: r.extras_cents, tax_cents: r.tax_cents,
    final_total_cents: r.final_total_cents, net_due_cents: r.net_due_cents, outstanding_obligation_cents: r.outstanding_obligation_cents,
    variance_cents: r.variance_cents, needs_review: r.needs_review, reasons: r.reasons, warnings: r.warnings, math: r.math,
    proposed_by: actor || 'emma', proposed_by_user_id: actorUserId,
  };
  const { data, error } = await supabase.from('vendor_deposit_reconciliations').insert(row).select('id').single();
  if (error) return missingTable(error) ? { error: 'migration_471_required', reconciliation: r } : { error: error.message };
  await logEvent(supabase, { depositId: deposit.id, type: 'reconciliation_proposed', actor: actor || 'emma', actorUserId, detail: { reconciliation_id: data.id, invoice_id: invoiceId, form: r.form, net_due_cents: r.net_due_cents } });
  return { ok: true, reconciliation_id: data.id, reconciliation: r };
}

async function decideReconciliation(supabase, { reconciliationId, decision, note = null, actor, actorUserId = null, role = null }) {
  if (!['approve', 'reject', 'unrelated'].includes(decision)) return { error: 'decision_invalid' };
  if (!actor) return { error: 'actor_required' };
  const { data: rec, error } = await supabase.from('vendor_deposit_reconciliations').select('*').eq('id', reconciliationId).maybeSingle();
  if (error) return missingTable(error) ? { error: 'migration_471_required' } : { error: error.message };
  if (!rec) return { error: 'not_found' };
  if (rec.proposed_by_user_id && actorUserId && rec.proposed_by_user_id === actorUserId) return { error: 'proposer_cannot_decide' };
  const { data: prior } = await supabase.from('vendor_deposit_reconciliation_decisions').select('id, decision').eq('reconciliation_id', reconciliationId).maybeSingle();
  if (prior) return { error: 'already_decided', decision: prior.decision };
  if (decision !== 'approve' && !note) return { error: 'note_required' };
  let invoice = null;
  if (rec.incoming_invoice_id) {
    const { data } = await supabase.from('ap_invoices').select('id, total_cents, status').eq('id', rec.incoming_invoice_id).maybeSingle();
    invoice = data || null;
  }
  if (decision === 'approve') {
    const blockers = approvalBlockers(rec, invoice, { role });
    if (blockers.length) return { error: 'cannot_approve', blockers };
  }
  const { error: dErr } = await supabase.from('vendor_deposit_reconciliation_decisions').insert({
    reconciliation_id: reconciliationId, decision, decided_by_user_id: actorUserId, decided_by_name: actor, note,
  });
  if (dErr) {
    if (String(dErr.code) === '23505') return { error: 'already_decided' };
    return { error: dErr.message };
  }
  await logEvent(supabase, { depositId: rec.deposit_id, type: 'reconciliation_decided', actor, actorUserId, detail: { reconciliation_id: reconciliationId, decision, note } });
  // Approving a real final bill applies the deposit to it (subledger only; no
  // AP amount changes, no payment). A duplicate/statement leaves it outstanding.
  if (decision === 'approve' && ['balance_only', 'full_total_less_deposit', 'revised_total'].includes(rec.form)) {
    const { error: uErr } = await supabase.from('vendor_deposits')
      .update({ status: 'applied', applied_invoice_id: rec.incoming_invoice_id, applied_at: new Date().toISOString() })
      .eq('id', rec.deposit_id).eq('status', 'outstanding');
    if (uErr) return { error: 'deposit_apply_failed', detail: uErr.message };
    await logEvent(supabase, { depositId: rec.deposit_id, type: 'applied', actor, actorUserId, detail: { invoice_id: rec.incoming_invoice_id, net_due_cents: rec.net_due_cents } });
  }
  return { ok: true, decision };
}

// For the approval endpoint. Returns { block: bool, reason, reconciliation }.
async function approvalGateForInvoice(supabase, invoiceId, invoiceTotalCents) {
  const { data: recs, error } = await supabase.from('vendor_deposit_reconciliations')
    .select('id, form, net_due_cents, needs_review, created_at').eq('incoming_invoice_id', invoiceId).order('created_at', { ascending: false });
  if (error) { if (missingTable(error)) return { block: false }; throw error; }
  if (!recs || !recs.length) return { block: false };
  const { data: decs, error: dErr } = await supabase.from('vendor_deposit_reconciliation_decisions')
    .select('reconciliation_id, decision').in('reconciliation_id', recs.map((r) => r.id));
  if (dErr) throw dErr;
  const byRec = new Map((decs || []).map((d) => [d.reconciliation_id, d.decision]));
  const latest = recs[0];
  const dec = byRec.get(latest.id);
  if (!dec) return { block: true, reason: 'deposit_reconciliation_pending', reconciliation: latest };
  if (dec === 'approve' && ['balance_only', 'full_total_less_deposit', 'revised_total'].includes(latest.form)
      && Number(latest.net_due_cents) !== Number(invoiceTotalCents)) {
    return { block: true, reason: 'invoice_total_not_reconciled_net_due', reconciliation: latest };
  }
  if (dec === 'approve' && latest.form === 'duplicate_or_statement') return { block: true, reason: 'reconciled_as_duplicate_or_statement', reconciliation: latest };
  // Rejected = the reviewer said the math is wrong. Fix the bill and re-run, or
  // mark it unrelated; a rejected reconciliation never waves a bill through.
  if (dec === 'reject') return { block: true, reason: 'deposit_reconciliation_rejected', reconciliation: latest };
  return { block: false, reconciliation: latest, decision: dec };
}

// Reconciliation view for one invoice (deposit side + every proposal + decision).
async function reconciliationViewForInvoice(supabase, invoiceId) {
  const { data: recs, error } = await supabase.from('vendor_deposit_reconciliations').select('*').eq('incoming_invoice_id', invoiceId).order('created_at', { ascending: false });
  if (error) { if (missingTable(error)) return null; throw error; }
  if (!recs || !recs.length) return null;
  const { data: decs } = await supabase.from('vendor_deposit_reconciliation_decisions').select('*').in('reconciliation_id', recs.map((r) => r.id));
  const byRec = new Map((decs || []).map((d) => [d.reconciliation_id, d]));
  const { deposit, depositInvoice } = await loadDeposit(supabase, recs[0].deposit_id);
  return { followup: deposit ? describe(deposit, depositInvoice) : null, reconciliations: recs.map((r) => ({ ...r, decision: byRec.get(r.id) || null })) };
}

module.exports = {
  upcomingBalances, setFollowup, proposeReconciliation, decideReconciliation,
  approvalGateForInvoice, reconciliationViewForInvoice, describe, loadDeposit,
};
