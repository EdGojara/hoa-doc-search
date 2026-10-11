// ============================================================================
// lib/legal/treatment.js — Legal Invoice Review step 3: APPROVE TREATMENT
// (Ed 2026-10-11, migration 508)
// ----------------------------------------------------------------------------
// Turns an accepted review into accounting, allocation by allocation:
//
//   homeowner_recoverable  Dr 1300 AR (that property) / Cr the invoice line's
//                          accrued expense account (5870 / 5860), plus a
//                          homeowner ledger charge. The accrual already credited
//                          AP when the bill was entered, so the bill-back moves
//                          the cost from expense to receivable. AP is never
//                          credited a second time.
//   association_legal_expense  No entry. The accrual is already right.
//   bedrock_corporate      Dr the community's Bedrock receivable / Cr the
//                          accrued expense account. Refused when the community
//                          has no such account; nobody invents one here.
//
// Approve Treatment is the chargeback authorization only. It never approves
// the AP invoice and never releases payment: those stay the two-key AP path.
//
// Idempotency: each allocation is claimed in legal_invoice_postings (status
// 'pending') before anything posts. A partial unique index allows one live
// claim per allocation, and a crashed run resumes from its claim by finding
// the journal entry (source_reference = posting id) and the homeowner line
// (raw_row_jsonb.legal_posting_id) it already wrote. Nothing posts twice.
//
// Corrections: reverse a posting (reversing journal entry + an offsetting
// homeowner adjustment, with a reason), then reopen the review (reason on the
// audit trail), re-save and approve again. The originals are never deleted.
// ============================================================================
const S = require('./review_suggest');
const { draftFreshness } = require('./review_data');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_LABEL = { attorney_fee: 'Legal Fees - Collections/DRV', attorney_fee_other: 'Legal Fees - Other' };
const $ = (c) => (Number(c) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const missingTable = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || /legal_invoice_postings|schema cache/.test(e.message || ''));

async function postingsReady(supabase) {
  const { error } = await supabase.from('legal_invoice_postings').select('id', { head: true, count: 'exact' }).limit(1);
  if (error && missingTable(error)) return false;
  if (error) throw error;
  return true;
}

// The community's receivable from Bedrock, by name. None exists today; the
// Bedrock path stays closed until one is created (a chart-of-accounts change).
async function bedrockReceivableAccount(supabase, communityId) {
  const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number, account_name')
    .eq('community_id', communityId).eq('is_active', true).like('account_number', '1%');
  if (error) throw error;
  return (data || []).find((a) => /bedrock|due from (the )?management co/i.test(a.account_name || '') && !/prior/i.test(a.account_name || '')) || null;
}

async function accountByNumber(supabase, communityId, number) {
  const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number, account_name')
    .eq('community_id', communityId).eq('account_number', number).eq('is_active', true).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function loadReviewRow(supabase, invoiceId) {
  const { data, error } = await supabase.from('legal_invoice_reviews').select('*').eq('ap_invoice_id', invoiceId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function loadPostings(supabase, invoiceId) {
  const { data, error } = await supabase.from('legal_invoice_postings').select('*').eq('ap_invoice_id', invoiceId).order('created_at');
  if (error) throw error;
  return data || [];
}

// ---- plan (pure once its inputs are loaded) ---------------------------------
// Everything Approve Treatment would do, or why it can't. Never writes.
function buildPlan({ d, review, lineAccounts, accrual, ar, bedrock, postingDate }) {
  const blocking = [];
  const inv = d.invoice;
  if (d.readOnly) blocking.push(d.readOnly);
  if (!inv.accrued || !accrual) blocking.push('The invoice has no accrual entry yet. Code it first, so there is an expense to reclassify.');
  const items = (d.saved && d.saved.items) || [];
  if (!review || !items.length) blocking.push('Save a reviewed draft first.');
  const fresh = draftFreshness(d);
  if (fresh.stale) fresh.reasons.forEach((r) => blocking.push(r));
  const summary = S.summarize(inv.total_cents, items);
  const rec = S.reconcile(inv.total_cents, items);
  if (!rec.reconciled) blocking.push(`The allocations do not add up to the invoice total (difference ${$(rec.difference_cents || 0)}).`);
  items.forEach((it, i) => {
    const t = S.triageItem(it);
    if (t.status === 'exception') blocking.push(`Item ${i + 1}: ${t.reasons[0]}${t.reasons.length > 1 ? ` (+${t.reasons.length - 1} more)` : ''}`);
  });

  let date = postingDate || (accrual && accrual.posting_date) || inv.invoice_date;
  if (postingDate && !DATE.test(postingDate)) blocking.push('The posting date is not a date.');
  if (accrual && date && date < accrual.posting_date) blocking.push(`The posting date cannot be before the accrual (${accrual.posting_date}).`);

  const postings = [];
  const totals = { homeowner_cents: 0, association_cents: 0, bedrock_cents: 0 };
  items.forEach((it, i) => {
    const accts = [...new Set((it.source_line_ids || []).map((id) => lineAccounts.get(id)).filter(Boolean))];
    const needsEntry = (it.allocations || []).some((a) => a.classification === 'homeowner_recoverable' || a.classification === 'bedrock_corporate');
    if (needsEntry && accts.length !== 1) {
      blocking.push(accts.length ? `Item ${i + 1} spans more than one expense account; split it so each item has one.` : `Item ${i + 1}'s invoice line is not coded to an expense account.`);
    }
    (it.allocations || []).forEach((a) => {
      const cents = Number(a.amount_cents);
      if (a.classification === 'association_legal_expense') { totals.association_cents += cents; return; }
      if (a.classification === 'needs_review') return;   // already blocking via triage
      if (cents <= 0) { blocking.push(`Item ${i + 1}: a negative ${a.classification} allocation cannot be posted as a charge.`); return; }
      if (a.classification === 'homeowner_recoverable') {
        totals.homeowner_cents += cents;
        if (!ar) blocking.push('Accounts Receivable (1300) is not on this community’s chart.');
        postings.push({ allocation_id: a.id, item_id: it.id, ap_invoice_line_ids: it.source_line_ids, kind: 'homeowner_chargeback',
          property_id: a.property_id, amount_cents: cents, debit_account_id: ar && ar.id, credit_account_id: accts[0] || null,
          charge_category: a.charge_category, matter_ref: it.matter_ref || null });
      } else if (a.classification === 'bedrock_corporate') {
        totals.bedrock_cents += cents;
        if (!bedrock) blocking.push('This community has no receivable-from-Bedrock account, so a Bedrock recovery cannot post. Creating one is a chart-of-accounts decision.');
        postings.push({ allocation_id: a.id, item_id: it.id, ap_invoice_line_ids: it.source_line_ids, kind: 'bedrock_recovery',
          property_id: null, amount_cents: cents, debit_account_id: bedrock && bedrock.id, credit_account_id: accts[0] || null,
          note: a.note || null, matter_ref: it.matter_ref || null });
      }
    });
  });
  const allocated = totals.homeowner_cents + totals.association_cents + totals.bedrock_cents;
  if (!blocking.length && allocated !== inv.total_cents) blocking.push(`Treatment totals ${$(allocated)}, not the invoice total ${$(inv.total_cents)}.`);
  const uniq = blocking.filter((x, i) => blocking.indexOf(x) === i);
  return { ready: uniq.length === 0, blocking: uniq, posting_date: date, totals, invoice_total_cents: inv.total_cents, postings, summary };
}

async function planTreatment(supabase, d, { postingDate } = {}) {
  const review = await loadReviewRow(supabase, d.invoice.id);
  const { data: rawLines, error: le } = await supabase.from('ap_invoice_lines').select('id, gl_account_id').eq('invoice_id', d.invoice.id);
  if (le) throw le;
  const lineAccounts = new Map((rawLines || []).map((l) => [l.id, l.gl_account_id]));
  const { data: inv, error: ie } = await supabase.from('ap_invoices').select('posting_journal_entry_id').eq('id', d.invoice.id).maybeSingle();
  if (ie) throw ie;
  let accrual = null;
  if (inv && inv.posting_journal_entry_id) {
    const { data: je, error: je_e } = await supabase.from('journal_entries').select('id, posting_date, status, reference').eq('id', inv.posting_journal_entry_id).maybeSingle();
    if (je_e) throw je_e;
    accrual = je && je.status === 'posted' ? je : null;
  }
  const [ar, bedrock] = await Promise.all([accountByNumber(supabase, d.invoice.community_id, '1300'), bedrockReceivableAccount(supabase, d.invoice.community_id)]);
  const plan = buildPlan({ d, review, lineAccounts, accrual, ar, bedrock, postingDate });
  plan.review = review ? { id: review.id, status: review.status, revision: review.revision, approved_by: review.approved_by || null, approved_at: review.approved_at || null } : null;
  plan.accrual = accrual ? { id: accrual.id, reference: accrual.reference, posting_date: accrual.posting_date } : null;
  return plan;
}

// ---- execute ----------------------------------------------------------------
function homeownerDescription(p, invoiceNumber) {
  return `${CATEGORY_LABEL[p.charge_category] || 'Legal Fees'} - Legal Fees / ${invoiceNumber || ''}`.trim();
}

async function findExistingWrites(supabase, posting) {
  const { data: je } = await supabase.from('journal_entries').select('id').eq('source_module', 'ap_billback')
    .eq('source_reference', posting.id).eq('status', 'posted').limit(1);
  let txnId = null;
  if (posting.kind === 'homeowner_chargeback') {
    const { data: tx } = await supabase.from('homeowner_transactions').select('id').eq('community_id', posting.community_id)
      .eq('raw_row_jsonb->>legal_posting_id', posting.id).eq('txn_type', 'charge').limit(1);
    txnId = tx && tx[0] ? tx[0].id : null;
  }
  return { jeId: je && je[0] ? je[0].id : null, txnId };
}

async function recordEvent(supabase, review, action, actor, summary) {
  const { error } = await supabase.from('legal_invoice_review_events').insert({
    review_id: review.id, community_id: review.community_id, revision: review.revision, action, actor, summary,
  });
  if (error) throw error;
}

// opts.deps (tests): postJE, postCharge
async function approveTreatment(supabase, d, { actor, actorUserId, baseRevision, postingDate, deps = {} } = {}) {
  if (!actor) throw Object.assign(new Error('actor required'), { status: 400 });
  if (!(await postingsReady(supabase))) return { ok: false, error: 'migration_pending', detail: 'Migration 508 (legal review approval) is not applied yet.' };
  const plan = await planTreatment(supabase, d, { postingDate });
  const review = await loadReviewRow(supabase, d.invoice.id);
  // An approved review that is resuming may legitimately re-plan; anything
  // blocking stops before the lock.
  if (!plan.ready) return { ok: false, error: 'not_ready', blocking: plan.blocking, plan };
  if (!Number.isInteger(baseRevision) || baseRevision !== review.revision) {
    return { ok: false, error: 'stale', detail: 'The review changed since you opened it. Reload and approve again.', revision: review.revision };
  }
  const lock = await supabase.rpc('legal_review_approve', {
    p_ap_invoice_id: d.invoice.id, p_base_revision: baseRevision, p_actor: actor,
    p_summary: { totals: plan.totals, invoice_total_cents: plan.invoice_total_cents, postings: plan.postings.length, posting_date: plan.posting_date },
  });
  if (lock.error) throw lock.error;
  if (!lock.data || !lock.data.ok) return { ok: false, error: (lock.data && lock.data.error) || 'approve_failed', detail: lock.data };
  const locked = await loadReviewRow(supabase, d.invoice.id);

  const postJE = deps.postJE || require('../accounting/posting').postJournalEntry;
  const postCharge = deps.postCharge || require('../accounting/homeowner_charge').postHomeownerCharge;
  const results = [];
  for (const p of plan.postings) {
    // 1. claim (or find the existing claim)
    let row;
    const ins = await supabase.from('legal_invoice_postings').insert({
      review_id: locked.id, allocation_id: p.allocation_id, item_id: p.item_id, ap_invoice_id: d.invoice.id,
      ap_invoice_line_ids: p.ap_invoice_line_ids, community_id: d.invoice.community_id, review_revision: locked.revision,
      kind: p.kind, property_id: p.property_id, amount_cents: p.amount_cents, debit_account_id: p.debit_account_id,
      credit_account_id: p.credit_account_id, posting_date: plan.posting_date, status: 'pending',
    }).select('*').single();
    if (ins.error) {
      if (ins.error.code !== '23505') throw ins.error;
      const { data: ex, error: xe } = await supabase.from('legal_invoice_postings').select('*').eq('allocation_id', p.allocation_id).in('status', ['pending', 'posted']).maybeSingle();
      if (xe) throw xe;
      row = ex;
    } else row = ins.data;
    if (row.status === 'posted') { results.push({ posting_id: row.id, already: true }); continue; }

    // 2. resume: anything this claim already wrote
    const prior = await findExistingWrites(supabase, row);
    let jeId = prior.jeId;
    if (!jeId) {
      const memo = `${d.invoice.vendor || 'Attorney'} inv ${d.invoiceNumber || ''}${p.matter_ref ? ` (${p.matter_ref})` : ''}`.trim();
      const je = await postJE({
        community_id: d.invoice.community_id, posting_date: plan.posting_date,
        description: p.kind === 'homeowner_chargeback' ? `Legal fee bill-back: ${memo}` : `Legal fee recovery from Bedrock: ${memo}`,
        source_module: 'ap_billback', source_reference: row.id, posted_by_user_id: actorUserId || null,
        notes: `Approved treatment by ${actor}, legal review revision ${locked.revision}. Reclassifies the accrued expense; AP is unchanged.${p.note ? ` Evidence: ${p.note}` : ''}`,
        lines: [
          { account_id: p.debit_account_id, debit_cents: p.amount_cents, credit_cents: 0, property_id: p.property_id || null, memo },
          { account_id: p.credit_account_id, debit_cents: 0, credit_cents: p.amount_cents, memo: `Reclass from expense: ${memo}` },
        ],
      });
      jeId = je && je.entry && je.entry.id;
      if (!jeId) throw new Error('journal entry did not return an id');
    }
    let txnId = prior.txnId;
    if (p.kind === 'homeowner_chargeback' && !txnId) {
      const ch = await postCharge(supabase, {
        communityId: d.invoice.community_id, propertyId: p.property_id, transactionDate: plan.posting_date,
        description: homeownerDescription(p, d.invoiceNumber), chargeCategory: p.charge_category, amountCents: p.amount_cents,
        notes: `Attorney bill-back, ${d.invoice.vendor || 'attorney'} invoice ${d.invoiceNumber || ''}`.trim(),
        raw: { source: 'legal_invoice_review', legal_posting_id: row.id, ap_invoice_id: d.invoice.id, ap_invoice_line_ids: p.ap_invoice_line_ids, journal_entry_id: jeId },
      });
      txnId = ch.chargeId;
    }
    const up = await supabase.from('legal_invoice_postings').update({
      status: 'posted', journal_entry_id: jeId, homeowner_transaction_id: txnId || null, posted_by: actor, posted_at: new Date().toISOString(),
    }).eq('id', row.id).eq('status', 'pending');
    if (up.error) throw up.error;
    await recordEvent(supabase, locked, 'posting_recorded', actor, { posting_id: row.id, kind: p.kind, amount_cents: p.amount_cents, property_id: p.property_id, journal_entry_id: jeId, homeowner_transaction_id: txnId || null });
    results.push({ posting_id: row.id, journal_entry_id: jeId, homeowner_transaction_id: txnId || null, kind: p.kind, amount_cents: p.amount_cents });
  }
  return { ok: true, already_approved: !!lock.data.already, revision: locked.revision, totals: plan.totals, posted: results };
}

// ---- correction -------------------------------------------------------------
// opts.deps (tests): voidJE, postCredit
async function reversePosting(supabase, postingId, { actor, actorUserId, reason, reversalDate, deps = {} } = {}) {
  if (!actor) throw Object.assign(new Error('actor required'), { status: 400 });
  if (!reason || String(reason).trim().length < 5) return { ok: false, error: 'reason_required', detail: 'Say why this posting is being reversed.' };
  if (reversalDate && !DATE.test(reversalDate)) return { ok: false, error: 'bad_date' };
  const { data: row, error } = await supabase.from('legal_invoice_postings').select('*').eq('id', postingId).maybeSingle();
  if (error) throw error;
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'posted') return { ok: false, error: 'not_posted', detail: `This posting is ${row.status}.` };
  const voidJE = deps.voidJE || require('../accounting/posting').voidJournalEntry;
  const postCredit = deps.postCredit || require('../accounting/homeowner_charge').postHomeownerCredit;
  const why = String(reason).trim().slice(0, 1000);
  // Resumable: a run that voided the entry but stopped before the owner credit
  // picks up the reversal it already posted instead of failing on 'already voided'.
  const { data: orig, error: oe } = await supabase.from('journal_entries').select('id, status, void_reversal_je_id').eq('id', row.journal_entry_id).maybeSingle();
  if (oe) throw oe;
  let revJeId = orig && orig.status === 'voided' ? orig.void_reversal_je_id : null;
  if (!revJeId) {
    const rev = await voidJE({ journal_entry_id: row.journal_entry_id, void_reason: `Legal treatment correction: ${why}`, reversal_date: reversalDate, posted_by_user_id: actorUserId || null });
    revJeId = rev && rev.reversal_entry ? rev.reversal_entry.id : null;
    if (!revJeId) throw new Error('reversal entry did not return an id');
  }
  let revTxn = null;
  if (row.kind === 'homeowner_chargeback') {
    const { data: done } = await supabase.from('homeowner_transactions').select('id').eq('community_id', row.community_id)
      .eq('raw_row_jsonb->>reverses_legal_posting_id', row.id).limit(1);
    revTxn = done && done[0] ? done[0].id : null;
  }
  if (row.kind === 'homeowner_chargeback' && !revTxn) {
    const cr = await postCredit(supabase, {
      communityId: row.community_id, propertyId: row.property_id, transactionDate: reversalDate || new Date().toISOString().slice(0, 10),
      description: 'Legal Fees - correction (reverses attorney bill-back)', amountCents: Number(row.amount_cents),
      notes: `Reverses legal bill-back ${row.id}: ${why}`,
      raw: { source: 'legal_invoice_review', reverses_legal_posting_id: row.id, reverses_homeowner_transaction_id: row.homeowner_transaction_id },
    });
    revTxn = cr.chargeId;
  }
  const up = await supabase.from('legal_invoice_postings').update({
    status: 'reversed', reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn, reversal_reason: why,
    reversed_by: actor, reversed_at: new Date().toISOString(),
  }).eq('id', row.id).eq('status', 'posted');
  if (up.error) throw up.error;
  const review = (await supabase.from('legal_invoice_reviews').select('*').eq('id', row.review_id).single()).data;
  await recordEvent(supabase, review, 'posting_reversed', actor, { posting_id: row.id, reason: why, reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn });
  return { ok: true, posting_id: row.id, reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn };
}

async function reopenReview(supabase, invoiceId, { actor, reason }) {
  const r = await supabase.rpc('legal_review_reopen', { p_ap_invoice_id: invoiceId, p_actor: actor, p_reason: reason || null });
  if (r.error) {
    if (/reason_required/.test(r.error.message || '')) return { ok: false, error: 'reason_required', detail: 'Say why the review is being reopened.' };
    throw r.error;
  }
  if (!r.data.ok && r.data.error === 'live_postings') return { ok: false, error: 'live_postings', detail: 'Reverse every posting first, then reopen.' };
  return r.data;
}

module.exports = { buildPlan, planTreatment, approveTreatment, reversePosting, reopenReview, postingsReady, loadPostings, bedrockReceivableAccount, homeownerDescription };
