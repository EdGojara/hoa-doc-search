// ============================================================================
// lib/ap/deposit_followup.js  (Ed 2026-09-28; revised after ChatGPT code review)
// ----------------------------------------------------------------------------
// The deposit -> balance-due follow-up, on top of the vendor_deposits subledger
// (migration 364) and the reconciliation ledger + functions (migration 471,
// PROPOSED). NARROW SLICE: track the obligation and its source documents, and
// HOLD any bill that may consume a deposit. Nothing here changes an AP amount,
// a journal entry or a deposit's status, and nothing pays.
//
//   upcomingBalances()   the "Upcoming vendor balances" queue. The obligation
//                        stays listed until the final bill is actually PAID
//                        (not merely reconciled or approved).
//   setFollowup()        event / due date / agreed total (+ basis) via the
//                        vendor_deposit_set_followup function: the update and its
//                        audit event commit together or not at all.
//   proposeReconciliation()  pure math (deposit_reconcile.js) stored via
//                        vendor_deposit_propose (proposal + event, atomically).
//   decideReconciliation()   via vendor_deposit_decide (row locks, state machine,
//                        decision + event atomically). manual_accounting_recorded
//                        re-evaluates LIVE data first and the function re-checks
//                        it under lock.
//   approvalGateForInvoice() the HARD hold used by the approval endpoint. It is
//                        driven by outstanding deposits for the bill's vendor +
//                        community, not by whether a proposal happened to be
//                        written, and it fails closed.
//
// Emma CANNOT release a deposit-consuming bill in this slice. The deposit
// accounting (relieve 1430, or net an expensed deposit) is a separate step; until
// it exists, an admin posts the adjusting entry by hand and records it here.
// ============================================================================
const { reconcileDeposit, depositPosition } = require('./deposit_reconcile');

const missingTable = (e) => !!e && /does not exist|schema cache|could not find the function/i.test(String(e.message || ''));
const PAYABLE_FORMS = ['balance_only', 'full_total_less_deposit', 'revised_total'];
const DUE_BASES = ['deposit_invoice_terms', 'contract', 'vendor_confirmed', 'staff_entered'];
const TOTAL_BASES = ['derived_from_deposit_invoice', 'invoice_estimate', 'quote', 'contract', 'staff_entered'];
const FOLLOWUP_FIELDS = ['event_date', 'balance_due_date', 'balance_due_basis', 'agreed_total_cents', 'agreed_total_basis', 'project_id', 'notes'];
const DECISIONS = ['confirmed_match', 'reject', 'unrelated', 'duplicate_confirmed', 'manual_accounting_recorded'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
// Postgres RAISE text -> our error code (the function raises plain codes).
const pgCode = (e) => { const m = String((e && e.message) || '').match(/^([a-z_]+)$/) || String((e && e.message) || '').match(/\b(identity_required|deposit_not_found|deposit_not_outstanding|invoice_not_found|same_as_deposit_invoice|vendor_or_community_mismatch|reconciliation_not_found|proposer_cannot_decide|superseded|already_decided|admin_required|note_required|form_not_payable|net_due_not_positive|invoice_voided|invoice_total_not_net_due|stale_reconciliation|accounting_je_invalid|deposit_already_applied_elsewhere|accounting_je_required|je_does_not_relieve_deposit|accounting_je_already_used|no_relief_entry_for_expensed_deposit|final_bill_touches_deposit_account)\b/); return m ? m[1] : null; };

const INV_COLS = 'id, community_id, vendor_id, vendor_invoice_number, invoice_date, total_cents, tax_cents, amount_paid_cents, status, file_sha256, paid_at, notes, source_storage_path, source_filename';

async function loadDeposit(supabase, depositId) {
  const { data: deposit, error } = await supabase.from('vendor_deposits').select('*').eq('id', depositId).maybeSingle();
  if (error) throw error;
  if (!deposit) return { deposit: null };
  let depositInvoice = null;
  if (deposit.deposit_invoice_id) {
    const { data, error: iErr } = await supabase.from('ap_invoices').select(INV_COLS).eq('id', deposit.deposit_invoice_id).maybeSingle();
    if (iErr) throw iErr;
    depositInvoice = data || null;
  }
  return { deposit, depositInvoice };
}

// Live reconciliation of a deposit against a bill (always from current data).
async function liveReconciliation(supabase, depositId, invoiceId, { isStatement = null } = {}) {
  const { deposit, depositInvoice } = await loadDeposit(supabase, depositId);
  if (!deposit) return { error: 'deposit_not_found' };
  const { data: inv, error: iErr } = await supabase.from('ap_invoices').select(INV_COLS).eq('id', invoiceId).maybeSingle();
  if (iErr) throw iErr;
  if (!inv) return { error: 'invoice_not_found' };
  const { data: lines, error: lErr } = await supabase.from('ap_invoice_lines').select('description, amount_cents').eq('invoice_id', invoiceId).order('line_number');
  if (lErr) throw lErr;
  // Do NOT infer "statement" from the lines here: lib/ap/statement_lines.js
  // counts any negative line naming a deposit as a Vantaca prior payment, which
  // would turn a genuine "full total less deposit" bill into a non-payable
  // statement. In the deposit context a statement is a person's call.
  const statement = isStatement === true;
  const isDepositBill = /DEPOSIT invoice/i.test(inv.notes || '');
  const r = reconcileDeposit({ deposit, depositInvoice, incoming: { ...inv, is_deposit_invoice: isDepositBill }, incomingLines: lines || [], isStatement: !!statement });
  return { deposit, depositInvoice, invoice: inv, reconciliation: r };
}

// Decisions per reconciliation id -> { confirmed, terminal }.
async function decisionsFor(supabase, recIds) {
  const out = new Map();
  if (!recIds.length) return out;
  const { data, error } = await supabase.from('vendor_deposit_reconciliation_decisions').select('*').in('reconciliation_id', recIds).order('created_at');
  if (error) throw error;
  for (const d of data || []) {
    const e = out.get(d.reconciliation_id) || { confirmed: null, terminal: null };
    if (d.decision === 'confirmed_match') e.confirmed = d; else e.terminal = d;
    out.set(d.reconciliation_id, e);
  }
  return out;
}

// Source documents behind a set of invoices (primary file + filed extras).
async function documentsFor(supabase, invoices) {
  const ids = invoices.map((i) => i && i.id).filter(Boolean);
  const docs = invoices.filter(Boolean).filter((i) => i.source_storage_path)
    .map((i) => ({ invoice_id: i.id, kind: 'invoice', label: i.source_filename || `Invoice ${i.vendor_invoice_number || ''}`.trim() }));
  if (ids.length) {
    const { data, error } = await supabase.from('ap_invoice_documents').select('id, invoice_id, kind, label, file_name').in('invoice_id', ids);
    if (error && !missingTable(error)) throw error;
    for (const d of data || []) docs.push({ invoice_id: d.invoice_id, document_id: d.id, kind: d.kind, label: d.label || d.file_name });
  }
  return docs;
}

// The obligation as a person reads it. Every amount says where it came from.
function describe(deposit, depositInvoice, extra = {}) {
  const pos = depositPosition(deposit, depositInvoice);
  const today = new Date().toISOString().slice(0, 10);
  const due = deposit.balance_due_date || null;
  const daysToDue = due ? Math.round((Date.parse(due) - Date.parse(today)) / 86400000) : null;
  return {
    deposit_id: deposit.id, community_id: deposit.community_id, vendor_id: deposit.vendor_id,
    project_description: deposit.project_description || null, project_id: deposit.project_id || null,
    event_date: deposit.event_date || null, balance_due_date: due, balance_due_basis: deposit.balance_due_basis || null,
    days_to_due: daysToDue, due_state: due == null ? 'no_due_date' : daysToDue < 0 ? 'past_due' : daysToDue <= 7 ? 'due_soon' : 'upcoming',
    deposit_invoice: depositInvoice ? { id: depositInvoice.id, number: depositInvoice.vendor_invoice_number, status: depositInvoice.status,
      total_cents: depositInvoice.total_cents, amount_paid_cents: depositInvoice.amount_paid_cents || 0 } : null,
    deposit_billed_cents: pos.billed, deposit_paid_cents: pos.paid, deposit_still_owed_cents: pos.still_owed,
    agreed_total_cents: pos.agreed_total_cents, agreed_total_basis: pos.agreed_total_basis,
    expected_balance_cents: pos.expected_balance_cents,
    expected_balance_label: pos.expected_balance_cents == null ? 'Unknown until the vendor bills or a quote/contract is attached'
      : pos.estimate ? 'ESTIMATE (not an invoice; confirm against the final bill)' : `Per ${pos.agreed_total_basis}`,
    deposit_status: deposit.status,
    ...extra,
  };
}

// Obligation state, from the deposit's reconciliations/decisions and the final
// bill's LIVE payment state. The item stays in the queue until the final bill is
// paid; reconciling or approving does not clear it.
function obligationState(recs, decs, invById) {
  const live = recs.filter((r) => !(decs.get(r.id) || {}).terminal || (decs.get(r.id).terminal.decision !== 'unrelated' && decs.get(r.id).terminal.decision !== 'reject'));
  const applied = recs.find((r) => ((decs.get(r.id) || {}).terminal || {}).decision === 'manual_accounting_recorded');
  if (applied) {
    const inv = invById.get(applied.incoming_invoice_id);
    const paidUp = inv && inv.total_cents > 0 && (inv.amount_paid_cents || 0) >= inv.total_cents;
    return { state: paidUp ? 'final_bill_paid' : 'final_bill_accounted_awaiting_payment', final_invoice_id: applied.incoming_invoice_id,
      label: paidUp ? 'Balance paid. Ready to close out.' : 'Deposit accounting recorded. Final bill goes through normal approval and payment.' };
  }
  if (live.length) return { state: 'final_bill_held', final_invoice_id: live[0].incoming_invoice_id,
    label: 'Final bill received and HELD. Emma cannot release it; the deposit accounting step is required first.' };
  return { state: 'waiting_for_final_bill', final_invoice_id: null, label: 'Waiting for the final bill.' };
}

async function upcomingBalances(supabase, { communityId = null } = {}) {
  const deposits = [];
  for (let from = 0; from < 20000; from += 1000) {
    let q = supabase.from('vendor_deposits').select('*, vendors:vendor_id(name), communities:community_id(name)')
      .eq('status', 'outstanding').order('created_at', { ascending: true }).range(from, from + 999);
    if (communityId) q = q.eq('community_id', communityId);
    const { data, error } = await q;
    if (error) throw error;
    deposits.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  let recs = [];
  if (deposits.length) {
    const { data, error } = await supabase.from('vendor_deposit_reconciliations')
      .select('id, deposit_id, incoming_invoice_id, form, net_due_cents, needs_review, created_at').in('deposit_id', deposits.map((d) => d.id));
    if (error && !missingTable(error)) throw error;
    recs = data || [];
  }
  const decs = await decisionsFor(supabase, recs.map((r) => r.id)).catch((e) => { if (missingTable(e)) return new Map(); throw e; });
  const invIds = [...new Set([...deposits.map((d) => d.deposit_invoice_id), ...recs.map((r) => r.incoming_invoice_id)].filter(Boolean))];
  const invById = new Map();
  for (let i = 0; i < invIds.length; i += 200) {
    const { data, error } = await supabase.from('ap_invoices').select(INV_COLS).in('id', invIds.slice(i, i + 200));
    if (error) throw error;
    for (const r of data || []) invById.set(r.id, r);
  }
  const out = [];
  for (const d of deposits) {
    const mine = recs.filter((r) => r.deposit_id === d.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const latestPerBill = [...new Map(mine.map((r) => [r.incoming_invoice_id, r])).values()];   // newest per bill is authoritative
    const ob = obligationState(latestPerBill, decs, invById);
    const depInv = invById.get(d.deposit_invoice_id) || null;
    const docs = await documentsFor(supabase, [depInv, ...latestPerBill.map((r) => invById.get(r.incoming_invoice_id))]);
    out.push(describe(d, depInv, {
      vendor_name: (d.vendors && d.vendors.name) || null, community_name: (d.communities && d.communities.name) || null,
      obligation_state: ob.state, obligation_label: ob.label, final_invoice_id: ob.final_invoice_id, documents: docs,
    }));
  }
  return out.sort((a, b) => (a.balance_due_date || '9999').localeCompare(b.balance_due_date || '9999'));
}

async function setFollowup(supabase, { depositId, fields = {}, actor, actorUserId }) {
  if (!actorUserId || !actor) return { error: 'identity_required' };
  const patch = {};
  for (const k of FOLLOWUP_FIELDS) if (Object.prototype.hasOwnProperty.call(fields, k)) patch[k] = fields[k] === '' ? null : fields[k];
  if (!Object.keys(patch).length) return { error: 'nothing_to_update' };
  for (const k of ['event_date', 'balance_due_date']) if (patch[k] != null && !isDate(patch[k])) return { error: `${k}_invalid` };
  if (patch.balance_due_date != null && !('balance_due_basis' in patch)) patch.balance_due_basis = 'staff_entered';
  if (patch.balance_due_basis != null && !DUE_BASES.includes(patch.balance_due_basis)) return { error: 'balance_due_basis_invalid' };
  if (patch.agreed_total_cents != null) {
    if (!Number.isInteger(patch.agreed_total_cents) || patch.agreed_total_cents < 0) return { error: 'agreed_total_cents_invalid' };
    if (!patch.agreed_total_basis) return { error: 'agreed_total_basis_required', hint: 'Say where the total came from: invoice_estimate, quote, contract or staff_entered.' };
  }
  if (patch.agreed_total_basis != null && !TOTAL_BASES.includes(patch.agreed_total_basis)) return { error: 'agreed_total_basis_invalid' };
  const { data, error } = await supabase.rpc('vendor_deposit_set_followup', { p_deposit_id: depositId, p_patch: patch, p_actor: actor, p_actor_user_id: actorUserId });
  if (error) return missingTable(error) ? { error: 'migration_471_required' } : { error: pgCode(error) || error.message };
  return { ok: true, deposit_id: depositId, followup: data };
}

async function proposeReconciliation(supabase, { depositId, invoiceId, actor, actorUserId = null, isStatement = null }) {
  if (!actor) return { error: 'identity_required' };
  const live = await liveReconciliation(supabase, depositId, invoiceId, { isStatement });
  if (live.error) return live;
  if (live.deposit.status !== 'outstanding') return { error: 'deposit_not_outstanding' };
  if (invoiceId === live.deposit.deposit_invoice_id) return { error: 'same_as_deposit_invoice' };
  const r = live.reconciliation;
  // If this bill was proposed before at a different amount (e.g. it was netted
  // or re-entered), keep the ORIGINAL billed face visible in the record.
  const { data: first, error: fpErr } = await supabase.from('vendor_deposit_reconciliations')
    .select('incoming_face_cents, created_at').eq('deposit_id', depositId).eq('incoming_invoice_id', invoiceId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (fpErr && !missingTable(fpErr)) throw fpErr;
  if (first && Number(first.incoming_face_cents) !== r.incoming_face_cents) {
    r.warnings = [...r.warnings, 'bill_amount_changed_since_first_proposal'];
    r.math = [...r.math, `Originally billed $${(Number(first.incoming_face_cents) / 100).toFixed(2)}; the bill now reads $${(r.incoming_face_cents / 100).toFixed(2)}.`];
  }
  const row = {
    deposit_id: depositId, incoming_invoice_id: invoiceId, form: r.form, agreed_total_cents: r.agreed_total_cents, agreed_total_basis: r.agreed_total_basis,
    deposit_billed_cents: r.deposit_billed_cents, deposit_paid_cents: r.deposit_paid_cents, deposit_still_owed_cents: r.deposit_still_owed_cents,
    incoming_face_cents: r.incoming_face_cents, credits_shown_cents: r.credits_shown_cents, extras_cents: r.extras_cents, tax_cents: r.tax_cents,
    final_total_cents: r.final_total_cents, net_due_cents: r.net_due_cents, outstanding_obligation_cents: r.outstanding_obligation_cents,
    variance_cents: r.variance_cents, needs_review: r.needs_review, reasons: r.reasons, warnings: r.warnings, math: r.math,
    proposed_by: actor, proposed_by_user_id: actorUserId,
  };
  const { data, error } = await supabase.rpc('vendor_deposit_propose', { p_row: row });
  if (error) return missingTable(error) ? { error: 'migration_471_required', reconciliation: r } : { error: pgCode(error) || error.message };
  return { ok: true, reconciliation_id: data, reconciliation: r };
}

// Resolve a journal entry by id or human reference (JE-2026-00322) in a community.
async function resolveJournalEntry(supabase, communityId, ref) {
  if (!ref) return null;
  const col = /^[0-9a-f-]{36}$/i.test(ref) ? 'id' : 'reference';
  const { data, error } = await supabase.from('journal_entries').select('id, status, community_id, reference').eq(col, ref).eq('community_id', communityId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function decideReconciliation(supabase, { reconciliationId, decision, note = null, actor, actorUserId, role = null, accountingJeRef = null }) {
  if (!DECISIONS.includes(decision)) return { error: 'decision_invalid' };
  if (!actorUserId || !actor) return { error: 'identity_required' };
  if (['unrelated', 'manual_accounting_recorded'].includes(decision) && role !== 'admin') return { error: 'admin_required' };
  if (decision !== 'confirmed_match' && !(note && String(note).trim())) return { error: 'note_required' };
  const { data: rec, error } = await supabase.from('vendor_deposit_reconciliations').select('*').eq('id', reconciliationId).maybeSingle();
  if (error) return missingTable(error) ? { error: 'migration_471_required' } : { error: error.message };
  if (!rec) return { error: 'not_found' };
  let jeId = null, expectedNet = null, livePaid = null;
  if (decision === 'manual_accounting_recorded') {
    if (role !== 'admin') return { error: 'admin_required' };
    // Re-evaluate from LIVE data; a proposal made before the deposit was paid (or
    // before the bill was netted) is stale and must be re-proposed.
    const live = await liveReconciliation(supabase, rec.deposit_id, rec.incoming_invoice_id);
    if (live.error) return live;
    const r = live.reconciliation;
    if (r.form !== rec.form || r.net_due_cents !== rec.net_due_cents || r.deposit_paid_cents !== Number(rec.deposit_paid_cents)) {
      return { error: 'stale_reconciliation', hint: 'Live data changed since this proposal (deposit payment or bill). Re-run the reconciliation.', live: { form: r.form, net_due_cents: r.net_due_cents, deposit_paid_cents: r.deposit_paid_cents } };
    }
    if (!PAYABLE_FORMS.includes(r.form)) return { error: 'form_not_payable' };
    if (!(r.net_due_cents > 0)) return { error: 'net_due_not_positive', hint: 'A zero or negative net is a vendor credit/refund, not a payable.' };
    if (Number(live.invoice.total_cents) !== r.net_due_cents) return { error: 'invoice_total_not_net_due', hint: `The bill reads ${live.invoice.total_cents}; the net due is ${r.net_due_cents}. Net the deposit on the bill first.` };
    // The relief entry is optional here: the SQL function decides by how the
    // deposit was booked (prepaid needs a JE crediting the deposit account for
    // the deposit amount, which may be the final bill's own accrual; expensed
    // needs none). A reference that doesn't resolve is an error, never ignored.
    if (accountingJeRef) {
      const je = await resolveJournalEntry(supabase, rec.community_id, accountingJeRef);
      if (!je) return { error: 'accounting_je_not_found', hint: `No journal entry ${accountingJeRef} in this community.` };
      jeId = je.id;
    }
    expectedNet = r.net_due_cents; livePaid = r.deposit_paid_cents;
  }
  const { data, error: dErr } = await supabase.rpc('vendor_deposit_decide', {
    p_reconciliation_id: reconciliationId, p_decision: decision, p_actor: actor, p_actor_user_id: actorUserId, p_role: role,
    p_note: note, p_accounting_je_id: jeId, p_expected_net_cents: expectedNet, p_live_deposit_paid_cents: livePaid,
  });
  if (dErr) return missingTable(dErr) ? { error: 'migration_471_required' } : { error: pgCode(dErr) || dErr.message };
  return { ok: true, decision, decision_id: data };
}

// The HARD hold for the approval endpoint. A bill is a deposit candidate when
// its vendor + community has an OUTSTANDING deposit other than the one this bill
// itself created. Every candidate deposit must be resolved for THIS bill by the
// newest reconciliation's terminal decision:
//   unrelated                      -> fine (a different job)
//   manual_accounting_recorded     -> fine while the bill's live total still
//                                     equals what was verified
//   anything else / none / missing -> HOLD
// Fails closed: if the ledger can't be read (migration 471 absent), a candidate
// bill is held, never waved through.
async function approvalGateForInvoice(supabase, invoice) {
  if (!invoice || !invoice.id) return { block: true, reason: 'deposit_check_unavailable' };
  if (!invoice.vendor_id || !invoice.community_id || invoice.total_cents == null) {
    // Never decide on a partial row (a caller that selected too few columns must
    // not silently skip the hold): reload what the gate needs.
    const { data: full, error: fErr } = await supabase.from('ap_invoices').select('id, vendor_id, community_id, total_cents').eq('id', invoice.id).maybeSingle();
    if (fErr) throw fErr;
    if (!full || !full.vendor_id || !full.community_id) return { block: true, reason: 'deposit_check_unavailable' };
    invoice = { ...invoice, ...full };
  }
  const { data: deps, error } = await supabase.from('vendor_deposits').select('id, deposit_invoice_id')
    .eq('community_id', invoice.community_id).eq('vendor_id', invoice.vendor_id).eq('status', 'outstanding');
  if (error) {
    if (missingTable(error)) return { block: false };   // no deposit subledger at all (pre-364): nothing to protect
    throw error;
  }
  const candidates = (deps || []).filter((d) => d.deposit_invoice_id !== invoice.id);
  if (!candidates.length) return { block: false };
  const { data: recs, error: rErr } = await supabase.from('vendor_deposit_reconciliations')
    .select('id, deposit_id, form, net_due_cents, created_at').eq('incoming_invoice_id', invoice.id).order('created_at', { ascending: false });
  if (rErr) {
    if (missingTable(rErr)) return { block: true, reason: 'deposit_check_unavailable', deposit_ids: candidates.map((c) => c.id) };
    throw rErr;
  }
  const latestByDeposit = new Map();
  for (const r of recs || []) if (!latestByDeposit.has(r.deposit_id)) latestByDeposit.set(r.deposit_id, r);
  const decs = await decisionsFor(supabase, [...latestByDeposit.values()].map((r) => r.id));
  for (const c of candidates) {
    const r = latestByDeposit.get(c.id);
    if (!r) return { block: true, reason: 'deposit_reconciliation_missing', deposit_id: c.id };
    const t = (decs.get(r.id) || {}).terminal;
    if (t && t.decision === 'unrelated') continue;
    if (t && t.decision === 'manual_accounting_recorded') {
      if (Number(invoice.total_cents) !== Number(t.verified_invoice_total_cents)) return { block: true, reason: 'invoice_changed_after_accounting', deposit_id: c.id, reconciliation: r };
      continue;
    }
    if (t && t.decision === 'duplicate_confirmed') return { block: true, reason: 'duplicate_or_statement_void_it', deposit_id: c.id, reconciliation: r };
    if (t && t.decision === 'reject') return { block: true, reason: 'deposit_reconciliation_rejected', deposit_id: c.id, reconciliation: r };
    return { block: true, reason: 'deposit_accounting_pending', deposit_id: c.id, reconciliation: r };
  }
  return { block: false };
}

// Reconciliation view for one invoice: follow-up + every proposal + decisions + docs.
async function reconciliationViewForInvoice(supabase, invoiceId) {
  const { data: recs, error } = await supabase.from('vendor_deposit_reconciliations').select('*').eq('incoming_invoice_id', invoiceId).order('created_at', { ascending: false });
  if (error) { if (missingTable(error)) return null; throw error; }
  if (!recs || !recs.length) return null;
  const decs = await decisionsFor(supabase, recs.map((r) => r.id));
  const { deposit, depositInvoice } = await loadDeposit(supabase, recs[0].deposit_id);
  const { data: inv } = await supabase.from('ap_invoices').select(INV_COLS).eq('id', invoiceId).maybeSingle();
  const docs = await documentsFor(supabase, [depositInvoice, inv]);
  const gate = inv ? await approvalGateForInvoice(supabase, inv) : { block: false };
  return {
    followup: deposit ? describe(deposit, depositInvoice, { documents: docs }) : null,
    reconciliations: recs.map((r, i) => ({ ...r, superseded: recs.slice(0, i).some((x) => x.deposit_id === r.deposit_id), confirmed: (decs.get(r.id) || {}).confirmed || null, decision: (decs.get(r.id) || {}).terminal || null })),
    hold: gate.block ? { reason: gate.reason, message: HOLD_MESSAGES[gate.reason] || 'Held for the deposit.' } : null,
  };
}

const HOLD_MESSAGES = {
  deposit_check_unavailable: 'Held: this vendor has an outstanding deposit and the deposit ledger could not be checked.',
  deposit_reconciliation_missing: 'Held: this vendor has an outstanding deposit. Reconcile this bill against it (or mark it unrelated) first.',
  deposit_accounting_pending: 'Held: Emma cannot release this bill. The deposit accounting step is not automated yet. An admin records the deposit accounting here (a relieving entry for a prepaid deposit; none for an expensed one); the bill must already read the net due. A bill that shows the full total without the deposit credit cannot be netted in this version: have the vendor reissue it for the balance, or wait for the accounting step.',
  deposit_reconciliation_rejected: 'Held: the reconciliation was rejected. Fix the bill and re-run it, or mark it unrelated.',
  duplicate_or_statement_void_it: 'Held: confirmed as a duplicate or statement. Void it (this reverses its accrual); it is never payable.',
  invoice_changed_after_accounting: 'Held: the bill changed after the deposit accounting was recorded. Re-run the reconciliation.',
};

module.exports = {
  upcomingBalances, setFollowup, proposeReconciliation, decideReconciliation, approvalGateForInvoice,
  reconciliationViewForInvoice, liveReconciliation, obligationState, describe, loadDeposit, HOLD_MESSAGES,
};
