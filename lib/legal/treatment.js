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
// DIRECT TO RECEIVABLE (Ed 2026-10-12): when the treatment is approved BEFORE the
// invoice is accrued (attorney invoices wait for review at intake), the approval
// posts ONE accrual: Dr 1300 for each approved owner amount (with its property),
// Dr the coded expense for what stays with the association, Dr the Bedrock
// receivable for a Bedrock recovery, Cr AP for the invoice total. No expense-and-
// recovery cycle. Owner charges post exactly as before, linked to the same claims.
// An invoice already accrued keeps the reclass method above (never re-posted).
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
// Concurrency: approval and every claim commit in one transaction; each claim
// is then worked under a lease (legal_posting_claim), and unique indexes on the
// bill-back entry and the owner charge per posting are the database backstop.
//
// Corrections: reverse a posting (reversing journal entry + an offsetting
// homeowner adjustment, with a reason), or cancel a pending one that cannot
// finish (reversing whatever it wrote), then reopen the review (reason on the
// audit trail), re-save and approve again. The originals are never deleted.
// ============================================================================
const S = require('./review_suggest');
const { draftFreshness } = require('./review_data');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// What the owner reads on the ledger: one source, shared with the review screen
// (lib/legal/review_suggest.js ownerDescription).
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
//   closedThrough: books closed through this date (month-end close), or null
//   currentTenure: Map property_id -> the property's current owner tenure id
function buildPlan({ d, review, lineAccounts, accrual, ar, bedrock, ap = null, postingDate, cutover = null, closedThrough = null, currentTenure = new Map() }) {
  const blocking = [];
  const inv = d.invoice;
  if (d.readOnly) blocking.push(d.readOnly);
  // Not accrued yet: the approval posts the accrual itself, straight to the receivable.
  const direct = !accrual && !(inv.accrued);
  if (direct) {
    if (!ap) blocking.push('This community has no Accounts Payable account (2000), so the accrual cannot post.');
    const uncoded = (d.lines || []).filter((l) => Number(l.amount_cents) !== 0 && !lineAccounts.get(l.id));
    if (uncoded.length) blocking.push(`Code every invoice line to an account first (${uncoded.length} uncoded), so the association's share has an expense account.`);
  } else if (!inv.accrued || !accrual) blocking.push('The invoice has no accrual entry yet. Code it first, so there is an expense to reclassify.');
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

  // Never before the accrual, never before the GL cutover (a pre-cutover
  // accrual was neutralized at conversion and re-posted at the cutover), and
  // never into a closed month: the default moves to the first open day.
  const floor = [accrual && accrual.posting_date, cutover].filter(Boolean).sort().pop() || null;
  let date = postingDate || floor || inv.invoice_date;
  if (postingDate && !DATE.test(postingDate)) blocking.push('The posting date is not a date.');
  if (floor && date && date < floor) blocking.push(`The posting date cannot be before ${floor} (the accrual or the GL cutover).`);
  if (closedThrough && date && date <= closedThrough) {
    if (postingDate) blocking.push(`The books are closed through ${closedThrough}; pick a posting date after that.`);
    else date = nextDay(closedThrough);
  }

  const postings = [];
  const totals = { homeowner_cents: 0, association_cents: 0, bedrock_cents: 0 };
  items.forEach((it, i) => {
    const accts = [...new Set((it.source_line_ids || []).map((id) => lineAccounts.get(id)).filter(Boolean))];
    const needsEntry = (it.allocations || []).some((a) => a.classification === 'homeowner_recoverable' || a.classification === 'bedrock_corporate')
      || (direct && accts.length > 1 && (it.allocations || []).some((a) => a.classification === 'association_legal_expense') && (it.allocations || []).some((a) => a.classification !== 'association_legal_expense'));
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
        // The owner reviewed must still be the owner: a closing after the
        // draft was saved would bill the prior owner's fees to the buyer.
        if (!a.tenure_id || currentTenure.get(a.property_id) !== a.tenure_id) {
          blocking.push(`Item ${i + 1}: the owner reviewed is no longer the current owner of the property. Re-review the draft.`);
        }
        postings.push({ allocation_id: a.id, item_id: it.id, ap_invoice_line_ids: it.source_line_ids, kind: 'homeowner_chargeback',
          property_id: a.property_id, tenure_id: a.tenure_id || null, amount_cents: cents, debit_account_id: ar && ar.id, credit_account_id: direct ? (ap && ap.id) : (accts[0] || null),
          posting_date: date });
      } else if (a.classification === 'bedrock_corporate') {
        totals.bedrock_cents += cents;
        if (!bedrock) blocking.push('This community has no receivable-from-Bedrock account, so a Bedrock recovery cannot post. Creating one is a chart-of-accounts decision.');
        postings.push({ allocation_id: a.id, item_id: it.id, ap_invoice_line_ids: it.source_line_ids, kind: 'bedrock_recovery',
          property_id: null, tenure_id: null, amount_cents: cents, debit_account_id: bedrock && bedrock.id, credit_account_id: direct ? (ap && ap.id) : (accts[0] || null),
          posting_date: date });
      }
    });
  });
  const allocated = totals.homeowner_cents + totals.association_cents + totals.bedrock_cents;
  if (!blocking.length && allocated !== inv.total_cents) blocking.push(`Treatment totals ${$(allocated)}, not the invoice total ${$(inv.total_cents)}.`);
  const uniq = blocking.filter((x, i) => blocking.indexOf(x) === i);
  return { ready: uniq.length === 0, blocking: uniq, posting_date: date, totals, invoice_total_cents: inv.total_cents, postings, summary, mode: direct ? 'direct' : 'reclass' };
}

// The invoice's Accounts Payable account (the same resolution the AP accrual uses).
async function apAccount(supabase, communityId) {
  for (const num of ['20100', '2000']) {
    const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', communityId).eq('account_number', num).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  return null;
}

function nextDay(d) { const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

// Period facts come from the GL poster's own rules (lib/accounting/posting).
const defaultPeriods = {
  closedThrough: (communityId) => require('../accounting/posting').closedThroughDate(communityId),
  openPeriod: (communityId, date) => require('../accounting/posting').resolveOpenPeriod(communityId, date),
};

async function planTreatment(supabase, d, { postingDate, periods = defaultPeriods } = {}) {
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
  const items = (d.saved && d.saved.items) || [];
  const props = [...new Set(items.flatMap((it) => (it.allocations || []).filter((a) => a.classification === 'homeowner_recoverable').map((a) => a.property_id)).filter(Boolean))];
  const [ar, bedrock, comm, ten, ap] = await Promise.all([accountByNumber(supabase, d.invoice.community_id, '1300'), bedrockReceivableAccount(supabase, d.invoice.community_id),
    supabase.from('communities').select('gl_cutover_date').eq('id', d.invoice.community_id).maybeSingle(),
    props.length ? supabase.from('ownership_tenures').select('id, property_id').in('property_id', props).eq('kind', 'owner').is('end_date', null) : Promise.resolve({ data: [] }),
    apAccount(supabase, d.invoice.community_id)]);
  if (comm && comm.error) throw comm.error;
  if (ten && ten.error) throw ten.error;
  const cutover = comm && comm.data && comm.data.gl_cutover_date ? String(comm.data.gl_cutover_date).slice(0, 10) : null;
  const currentTenure = new Map(((ten && ten.data) || []).map((t) => [t.property_id, t.id]));
  const closedThrough = await periods.closedThrough(d.invoice.community_id);
  const plan = buildPlan({ d, review, lineAccounts, accrual, ar, bedrock, ap, postingDate, cutover, closedThrough: closedThrough ? String(closedThrough).slice(0, 10) : null, currentTenure });
  if (plan.postings.length && plan.posting_date && DATE.test(plan.posting_date) && !(await periods.openPeriod(d.invoice.community_id, plan.posting_date))) {
    plan.blocking.push(`There is no open accounting period for ${plan.posting_date}. Open the period (or pick another date) first.`);
    plan.ready = false;
  }
  plan.review = review ? { id: review.id, status: review.status, revision: review.revision, approved_by: review.approved_by || null, approved_at: review.approved_at || null } : null;
  plan.accrual = accrual ? { id: accrual.id, reference: accrual.reference, posting_date: accrual.posting_date } : null;
  return plan;
}

// ---- execute ----------------------------------------------------------------
function homeownerDescription(category, invoiceNumber, serviceTexts) {
  return S.ownerDescription(category, invoiceNumber, serviceTexts);
}

const must = (r, what) => { if (r && r.error) throw Object.assign(new Error(`${what}: ${r.error.message}`), { cause: r.error }); return r ? r.data : null; };

// Anything this posting row already wrote. A failed lookup throws: it must
// never read as "nothing written", or a retry would post twice.
async function isDirectRow(supabase, row) {
  if (!row || !row.credit_account_id) return false;
  const a = must(await supabase.from('chart_of_accounts').select('account_number').eq('id', row.credit_account_id).maybeSingle(), 'credit account');
  return !!a && /^(2000|20100)$/.test(String(a.account_number));
}
async function invoiceAccrualId(supabase, apInvoiceId) {
  const inv = must(await supabase.from('ap_invoices').select('posting_journal_entry_id').eq('id', apInvoiceId).maybeSingle(), 'invoice accrual');
  return inv && inv.posting_journal_entry_id ? inv.posting_journal_entry_id : null;
}
async function findExistingWrites(supabase, row) {
  const direct = await isDirectRow(supabase, row);
  const je = direct ? [{ id: await invoiceAccrualId(supabase, row.ap_invoice_id) }].filter((x) => x.id)
    : must(await supabase.from('journal_entries').select('id').eq('source_module', 'ap_billback')
      .eq('source_reference', row.id).eq('status', 'posted').limit(1), 'bill-back entry lookup');
  let txnId = null;
  if (row.kind === 'homeowner_chargeback') {
    const tx = must(await supabase.from('homeowner_transactions').select('id').eq('community_id', row.community_id)
      .eq('raw_row_jsonb->>legal_posting_id', row.id).limit(1), 'owner charge lookup');
    txnId = tx && tx[0] ? tx[0].id : null;
  }
  return { jeId: je && je[0] ? je[0].id : null, txnId, direct };
}

// Direct mode: post THE invoice accrual from the approved claims and the approved
// allocations (never a re-plan), once. Dr each claim's debit account (1300 with its
// property / Bedrock receivable), Dr the coded expense for the association's share,
// Cr AP for the invoice total. Found again (posting_journal_entry_id or the posted
// ap_invoice entry) so a retry never posts a second accrual.
async function ensureDirectAccrual(supabase, d, review, { postJE, actor, actorUserId, postingDate }) {
  const have = await invoiceAccrualId(supabase, d.invoice.id);
  if (have) return have;
  const found = must(await supabase.from('journal_entries').select('id').eq('source_module', 'ap_invoice').eq('source_reference', d.invoice.id).eq('status', 'posted').limit(1), 'accrual lookup');
  if (found && found[0]) { must(await supabase.from('ap_invoices').update({ posting_journal_entry_id: found[0].id }).eq('id', d.invoice.id), 'link accrual'); return found[0].id; }
  const ap = await apAccount(supabase, d.invoice.community_id);
  if (!ap) throw new Error('no Accounts Payable account for this community');
  const claims = must(await supabase.from('legal_invoice_postings').select('*').eq('review_id', review.id).in('status', ['pending', 'posted']), 'claims');
  const lines = must(await supabase.from('ap_invoice_lines').select('id, gl_account_id, amount_cents').eq('invoice_id', d.invoice.id), 'invoice lines');
  const lineAcct = new Map(lines.map((l) => [l.id, l.gl_account_id]));
  const items = (d.saved && d.saved.items) || [];
  const memo = `${d.invoice.vendor || 'Attorney'} inv ${d.invoiceNumber || ''}`.trim();
  const jl = [];
  for (const c of claims) jl.push({ account_id: c.debit_account_id, debit_cents: Number(c.amount_cents), credit_cents: 0, property_id: c.property_id || null, memo: `${c.kind === 'homeowner_chargeback' ? 'Owner legal fees' : 'Bedrock legal recovery'}: ${memo}` });
  for (const it of items) {
    const assoc = (it.allocations || []).filter((a) => a.classification === 'association_legal_expense').reduce((t, a) => t + Number(a.amount_cents), 0);
    if (!assoc) continue;
    const ids = (it.source_line_ids || []).filter((id) => lineAcct.get(id));
    const accts = [...new Set(ids.map((id) => lineAcct.get(id)))];
    if (accts.length === 1) jl.push({ account_id: accts[0], debit_cents: assoc, credit_cents: 0, memo: `Association legal expense: ${memo}` });
    else for (const id of ids) { const l = lines.find((x) => x.id === id); jl.push({ account_id: l.gl_account_id, debit_cents: Number(l.amount_cents), credit_cents: 0, memo: `Association legal expense: ${memo}` }); }
  }
  const dr = jl.reduce((t, l) => t + l.debit_cents, 0);
  if (dr !== Number(d.invoice.total_cents)) throw new Error(`direct accrual does not reconcile: ${dr} of ${d.invoice.total_cents} cents`);
  jl.push({ account_id: ap.id, debit_cents: 0, credit_cents: dr, memo: `AP — ${d.invoice.vendor || 'attorney'}`.trim(), vendor_id: d.invoice.vendor_id || null });
  const date = (claims[0] && String(claims[0].posting_date).slice(0, 10)) || postingDate;
  const je = await postJE({ community_id: d.invoice.community_id, posting_date: date, source_module: 'ap_invoice', source_reference: d.invoice.id, ap_posting: true, posted_by_user_id: actorUserId || null,
    description: `AP invoice ${d.invoiceNumber || ''} — ${d.invoice.vendor || 'attorney'} (approved legal treatment: owner fees to receivable)`.trim(),
    notes: `Accrual posted with the approved legal treatment by ${actor} (review revision ${review.revision}): recoverable owner fees debit 1300 directly; the association's share debits its coded expense.`, lines: jl });
  const id = je && je.entry && je.entry.id;
  if (!id) throw new Error('accrual entry did not return an id');
  must(await supabase.from('ap_invoices').update({ posting_journal_entry_id: id }).eq('id', d.invoice.id), 'link accrual');
  await recordEvent(supabase, review, 'posting_recorded', actor, { kind: 'direct_accrual', journal_entry_id: id, amount_cents: dr });
  return id;
}

// Direct mode correction: move one owner's amount back to association expense
// (Dr the coded line account / Cr 1300) without touching the shared accrual.
async function directCorrection(supabase, row, why, date, actorUserId, postJE) {
  const ref = `${row.id}:correction`;
  const prior = must(await supabase.from('journal_entries').select('id').eq('source_module', 'ap_billback').eq('source_reference', ref).eq('status', 'posted').limit(1), 'correction lookup');
  if (prior && prior[0]) return prior[0].id;
  const lines = must(await supabase.from('ap_invoice_lines').select('gl_account_id').in('id', row.ap_invoice_line_ids || []), 'invoice lines');
  const acct = [...new Set(lines.map((l) => l.gl_account_id).filter(Boolean))];
  if (acct.length !== 1) throw new Error('cannot tell which expense account the owner amount came from');
  const je = await postJE({ community_id: row.community_id, posting_date: date || new Date().toISOString().slice(0, 10), source_module: 'ap_billback', source_reference: ref, posted_by_user_id: actorUserId || null,
    description: 'Legal treatment correction: owner amount back to association expense', notes: `Corrects direct-to-receivable posting ${row.id}: ${why}`,
    lines: [{ account_id: acct[0], debit_cents: Number(row.amount_cents), credit_cents: 0, memo: 'Association legal expense (correction)' },
      { account_id: row.debit_account_id, debit_cents: 0, credit_cents: Number(row.amount_cents), property_id: row.property_id || null, memo: 'Reverse owner legal fees (correction)' }] });
  const id = je && je.entry && je.entry.id;
  if (!id) throw new Error('correction entry did not return an id');
  return id;
}

async function recordEvent(supabase, review, action, actor, summary) {
  must(await supabase.from('legal_invoice_review_events').insert({
    review_id: review.id, community_id: review.community_id, revision: review.revision, action, actor, summary,
  }), 'audit event');
}

// One worker at a time per posting row (legal_posting_claim, migration 508).
async function lease(supabase, rowId, fromStatus) {
  const token = require('crypto').randomUUID();
  const ok = must(await supabase.rpc('legal_posting_claim', { p_posting_id: rowId, p_token: token, p_from_status: fromStatus }), 'claim');
  return ok === true ? token : null;
}

// The GL entry + owner charge for one claimed row, from the row's own stored
// amounts, accounts, property and date (what was approved), never a re-plan.
async function postClaim(supabase, d, row, { actor, actorUserId, postJE, postCharge }) {
  const token = await lease(supabase, row.id, 'pending');
  if (!token) return { posting_id: row.id, in_progress: true };
  const prior = await findExistingWrites(supabase, row);
  const alloc = must(await supabase.from('legal_invoice_allocations').select('charge_category, note, legal_invoice_items(matter_ref, source_text)').eq('id', row.allocation_id).maybeSingle(), 'allocation');
  const matter = alloc && alloc.legal_invoice_items ? alloc.legal_invoice_items.matter_ref : null;
  const memo = `${d.invoice.vendor || 'Attorney'} inv ${d.invoiceNumber || ''}${matter ? ` (${matter})` : ''}`.trim();
  let jeId = prior.jeId;
  if (!jeId && prior.direct) throw new Error('the invoice accrual is not posted yet; approval posts it before the owner charges');
  if (!jeId) {
    const je = await postJE({
      community_id: row.community_id, posting_date: String(row.posting_date).slice(0, 10),
      description: row.kind === 'homeowner_chargeback' ? `Legal fee bill-back: ${memo}` : `Legal fee recovery from Bedrock: ${memo}`,
      source_module: 'ap_billback', source_reference: row.id, posted_by_user_id: actorUserId || null,
      notes: `Approved treatment by ${actor}, legal review revision ${row.review_revision}. Reclassifies the accrued expense; AP is unchanged.${row.kind === 'bedrock_recovery' && alloc && alloc.note ? ` Evidence: ${alloc.note}` : ''}`,
      lines: [
        { account_id: row.debit_account_id, debit_cents: Number(row.amount_cents), credit_cents: 0, property_id: row.property_id || null, memo },
        { account_id: row.credit_account_id, debit_cents: 0, credit_cents: Number(row.amount_cents), memo: `Reclass from expense: ${memo}` },
      ],
    });
    jeId = je && je.entry && je.entry.id;
    if (!jeId) throw new Error('journal entry did not return an id');
  }
  let txnId = prior.txnId;
  if (row.kind === 'homeowner_chargeback' && !txnId) {
    // Charge only the owner who was approved. A sale since approval stops
    // here; the claim can then be cancelled (which reverses the entry above).
    const cur = must(await supabase.from('ownership_tenures').select('id').eq('property_id', row.property_id).eq('kind', 'owner').is('end_date', null).maybeSingle(), 'current owner');
    if (!cur || cur.id !== row.tenure_id) throw Object.assign(new Error('The property changed hands after approval; this charge was not posted. Cancel the pending posting and re-review.'), { code: 'tenure_changed' });
    // Homeowner-facing description: category + a catalogue service phrase + the invoice's
    // actual reference (lib/legal/review_suggest.js ownerDescription). The attorney's line
    // text stays internal. No reference on the invoice: none is shown, and staff are told.
    const sourceText = alloc && alloc.legal_invoice_items ? alloc.legal_invoice_items.source_text : null;
    const ref = S.cleanReference(d.invoiceNumber);
    const ch = await postCharge(supabase, {
      communityId: row.community_id, propertyId: row.property_id, tenureId: row.tenure_id || null, transactionDate: String(row.posting_date).slice(0, 10),
      description: homeownerDescription(alloc && alloc.charge_category, ref, sourceText ? [sourceText] : []), chargeCategory: (alloc && alloc.charge_category) || 'attorney_fee',
      amountCents: Number(row.amount_cents),
      notes: ref ? `Attorney bill-back, ${d.invoice.vendor || 'attorney'} invoice ${ref}` : `Attorney bill-back, ${d.invoice.vendor || 'attorney'}. STAFF REVIEW: the attorney invoice has no invoice number; no reference is shown to the homeowner.`,
      raw: { source: 'legal_invoice_review', legal_posting_id: row.id, ap_invoice_id: row.ap_invoice_id, ap_invoice_line_ids: row.ap_invoice_line_ids, journal_entry_id: jeId,
        legal_invoice_item_id: row.item_id || null, legal_allocation_id: row.allocation_id || null, attorney_invoice_number: ref, attorney_reference_missing: !ref,
        service_phrase: S.servicePhrase(sourceText ? [sourceText] : []), description_version: 2 },
    });
    txnId = ch.chargeId;
  }
  const up = must(await supabase.from('legal_invoice_postings').update({
    status: 'posted', journal_entry_id: jeId, homeowner_transaction_id: txnId || null, posted_by: actor, posted_at: new Date().toISOString(),
    claim_token: null, claimed_at: null,
  }).eq('id', row.id).eq('status', 'pending').eq('claim_token', token).select('id'), 'mark posted');
  if (!up || up.length !== 1) throw new Error(`posting ${row.id} lost its claim before it could be marked posted`);
  const review = must(await supabase.from('legal_invoice_reviews').select('*').eq('id', row.review_id).single(), 'review');
  await recordEvent(supabase, review, 'posting_recorded', actor, { posting_id: row.id, kind: row.kind, amount_cents: Number(row.amount_cents), property_id: row.property_id, journal_entry_id: jeId, homeowner_transaction_id: txnId || null });
  return { posting_id: row.id, journal_entry_id: jeId, homeowner_transaction_id: txnId || null, kind: row.kind, amount_cents: Number(row.amount_cents) };
}

// opts.deps (tests): postJE, postCharge, periods
async function approveTreatment(supabase, d, { actor, actorUserId, baseRevision, postingDate, deps = {} } = {}) {
  if (!actor) throw Object.assign(new Error('actor required'), { status: 400 });
  if (!(await postingsReady(supabase))) return { ok: false, error: 'migration_pending', detail: 'Migration 508 (legal review approval) is not applied yet.' };
  const review = await loadReviewRow(supabase, d.invoice.id);
  if (!review) return { ok: false, error: 'not_ready', blocking: ['Save a reviewed draft first.'] };
  let already = review.status === 'approved';
  let plan = null;
  if (!already) {
    // First approval: everything must check out, then approval and every
    // claim commit together (legal_review_approve, migration 508).
    plan = await planTreatment(supabase, d, { postingDate, periods: deps.periods || defaultPeriods });
    if (!plan.ready) return { ok: false, error: 'not_ready', blocking: plan.blocking, plan };
    if (!Number.isInteger(baseRevision) || baseRevision !== review.revision) {
      return { ok: false, error: 'stale', detail: 'The review changed since you opened it. Reload and approve again.', revision: review.revision };
    }
    const lock = await supabase.rpc('legal_review_approve', {
      p_ap_invoice_id: d.invoice.id, p_base_revision: baseRevision, p_actor: actor,
      p_summary: { totals: plan.totals, invoice_total_cents: plan.invoice_total_cents, postings: plan.postings.length, posting_date: plan.posting_date },
      p_postings: plan.postings.map((p) => ({ allocation_id: p.allocation_id, kind: p.kind, amount_cents: p.amount_cents, property_id: p.property_id, tenure_id: p.tenure_id,
        ap_invoice_line_ids: p.ap_invoice_line_ids, debit_account_id: p.debit_account_id, credit_account_id: p.credit_account_id, posting_date: p.posting_date })),
    });
    if (lock.error) throw lock.error;
    if (!lock.data || !lock.data.ok) return { ok: false, error: (lock.data && lock.data.error) || 'approve_failed', detail: lock.data };
    already = !!lock.data.already;
  }
  // Post (or finish posting) every pending claim of this review, from the
  // claim rows themselves. A resume never re-plans.
  const postJE = deps.postJE || require('../accounting/posting').postJournalEntry;
  const postCharge = deps.postCharge || require('../accounting/homeowner_charge').postHomeownerCharge;
  if (!(await invoiceAccrualId(supabase, d.invoice.id))) {
    const lockedReview = await loadReviewRow(supabase, d.invoice.id);
    await ensureDirectAccrual(supabase, d, lockedReview, { postJE, actor, actorUserId, postingDate: (plan && plan.posting_date) || postingDate || String(d.invoice.invoice_date || '').slice(0, 10) });
  }
  const pending = must(await supabase.from('legal_invoice_postings').select('*').eq('review_id', review.id).eq('status', 'pending'), 'pending postings');
  const results = [];
  for (const row of pending || []) results.push(await postClaim(supabase, d, row, { actor, actorUserId, postJE, postCharge }));
  const locked = await loadReviewRow(supabase, d.invoice.id);
  return { ok: true, already_approved: already, revision: locked.revision, totals: plan ? plan.totals : null, posted: results };
}

// ---- corrections ------------------------------------------------------------
async function offsetOwnerCharge(supabase, row, why, date, postCredit) {
  const done = must(await supabase.from('homeowner_transactions').select('id').eq('community_id', row.community_id)
    .eq('raw_row_jsonb->>reverses_legal_posting_id', row.id).limit(1), 'owner correction lookup');
  if (done && done[0]) return done[0].id;
  const cr = await postCredit(supabase, {
    communityId: row.community_id, propertyId: row.property_id, transactionDate: date || new Date().toISOString().slice(0, 10),
    description: 'Legal Fees - correction (reverses attorney bill-back)', amountCents: Number(row.amount_cents),
    notes: `Reverses legal bill-back ${row.id}: ${why}`,
    raw: { source: 'legal_invoice_review', reverses_legal_posting_id: row.id, reverses_homeowner_transaction_id: row.homeowner_transaction_id || null },
  });
  return cr.chargeId;
}

// The reversing entry for a bill-back, found first so a retry never posts a
// second one (voidJournalEntry posts the reversal before flipping the original).
async function reverseEntry(supabase, jeId, why, date, actorUserId, voidJE) {
  const existing = must(await supabase.from('journal_entries').select('id').eq('reverses_je_id', jeId).eq('status', 'posted').limit(1), 'reversal lookup');
  if (existing && existing[0]) return existing[0].id;
  const rev = await voidJE({ journal_entry_id: jeId, void_reason: `Legal treatment correction: ${why}`, reversal_date: date, posted_by_user_id: actorUserId || null });
  const id = rev && rev.reversal_entry ? rev.reversal_entry.id : null;
  if (!id) throw new Error('reversal entry did not return an id');
  return id;
}

// opts.deps (tests): voidJE, postCredit
async function reversePosting(supabase, postingId, { actor, actorUserId, reason, reversalDate, deps = {} } = {}) {
  if (!actor) throw Object.assign(new Error('actor required'), { status: 400 });
  if (!reason || String(reason).trim().length < 5) return { ok: false, error: 'reason_required', detail: 'Say why this posting is being reversed.' };
  if (reversalDate && !DATE.test(reversalDate)) return { ok: false, error: 'bad_date' };
  const row = must(await supabase.from('legal_invoice_postings').select('*').eq('id', postingId).maybeSingle(), 'posting');
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'posted') return { ok: false, error: 'not_posted', detail: `This posting is ${row.status}.` };
  const token = await lease(supabase, row.id, 'posted');
  if (!token) return { ok: false, error: 'in_progress', detail: 'Another correction of this posting is in progress.' };
  const voidJE = deps.voidJE || require('../accounting/posting').voidJournalEntry;
  const postCredit = deps.postCredit || require('../accounting/homeowner_charge').postHomeownerCredit;
  const why = String(reason).trim().slice(0, 1000);
  const revJeId = (await isDirectRow(supabase, row))
    ? await directCorrection(supabase, row, why, reversalDate, actorUserId, deps.postJE || require('../accounting/posting').postJournalEntry)
    : await reverseEntry(supabase, row.journal_entry_id, why, reversalDate, actorUserId, voidJE);
  const revTxn = row.kind === 'homeowner_chargeback' ? await offsetOwnerCharge(supabase, row, why, reversalDate, postCredit) : null;
  const up = must(await supabase.from('legal_invoice_postings').update({
    status: 'reversed', reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn, reversal_reason: why,
    reversed_by: actor, reversed_at: new Date().toISOString(), claim_token: null, claimed_at: null,
  }).eq('id', row.id).eq('status', 'posted').eq('claim_token', token).select('id'), 'mark reversed');
  if (!up || up.length !== 1) throw new Error(`posting ${row.id} lost its claim before it could be marked reversed`);
  const review = must(await supabase.from('legal_invoice_reviews').select('*').eq('id', row.review_id).single(), 'review');
  await recordEvent(supabase, review, 'posting_reversed', actor, { posting_id: row.id, reason: why, reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn });
  return { ok: true, posting_id: row.id, reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn };
}

// A pending claim that cannot finish (closed period, sale after approval, a
// failing owner charge) is cancelled with a reason. Anything it already wrote
// is reversed first, so cancelling never leaves a half-posted bill-back.
async function cancelPendingPosting(supabase, postingId, { actor, actorUserId, reason, deps = {} } = {}) {
  if (!actor) throw Object.assign(new Error('actor required'), { status: 400 });
  if (!reason || String(reason).trim().length < 5) return { ok: false, error: 'reason_required', detail: 'Say why this pending posting is being cancelled.' };
  const row = must(await supabase.from('legal_invoice_postings').select('*').eq('id', postingId).maybeSingle(), 'posting');
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'pending') return { ok: false, error: 'not_pending', detail: `This posting is ${row.status}.` };
  const token = await lease(supabase, row.id, 'pending');
  if (!token) return { ok: false, error: 'in_progress', detail: 'This posting is being worked on right now. Try again in a few minutes.' };
  const why = String(reason).trim().slice(0, 1000);
  const prior = await findExistingWrites(supabase, row);
  const voidJE = deps.voidJE || require('../accounting/posting').voidJournalEntry;
  const postCredit = deps.postCredit || require('../accounting/homeowner_charge').postHomeownerCredit;
  const revJeId = !prior.jeId ? null : prior.direct
    ? await directCorrection(supabase, row, why, null, actorUserId, deps.postJE || require('../accounting/posting').postJournalEntry)
    : await reverseEntry(supabase, prior.jeId, why, null, actorUserId, voidJE);
  const revTxn = prior.txnId ? await offsetOwnerCharge(supabase, Object.assign({}, row, { homeowner_transaction_id: prior.txnId }), why, null, postCredit) : null;
  const up = must(await supabase.from('legal_invoice_postings').update({
    status: 'cancelled', journal_entry_id: prior.jeId, homeowner_transaction_id: prior.txnId, reversal_journal_entry_id: revJeId,
    reversal_homeowner_transaction_id: revTxn, reversal_reason: why, reversed_by: actor, reversed_at: new Date().toISOString(), claim_token: null, claimed_at: null,
  }).eq('id', row.id).eq('status', 'pending').eq('claim_token', token).select('id'), 'mark cancelled');
  if (!up || up.length !== 1) throw new Error(`posting ${row.id} lost its claim before it could be cancelled`);
  const review = must(await supabase.from('legal_invoice_reviews').select('*').eq('id', row.review_id).single(), 'review');
  await recordEvent(supabase, review, 'posting_cancelled', actor, { posting_id: row.id, reason: why, reversed_journal_entry_id: prior.jeId, reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn });
  return { ok: true, posting_id: row.id, reversal_journal_entry_id: revJeId, reversal_homeowner_transaction_id: revTxn };
}

async function reopenReview(supabase, invoiceId, { actor, reason }) {
  const r = await supabase.rpc('legal_review_reopen', { p_ap_invoice_id: invoiceId, p_actor: actor, p_reason: reason || null });
  if (r.error) {
    if (/reason_required/.test(r.error.message || '')) return { ok: false, error: 'reason_required', detail: 'Say why the review is being reopened.' };
    throw r.error;
  }
  if (!r.data.ok && r.data.error === 'live_postings') return { ok: false, error: 'live_postings', detail: 'Reverse (or cancel) every posting first, then reopen.' };
  return r.data;
}

// Live (pending or posted) postings for an AP invoice. The void and line-split
// paths refuse while any exist: voiding the bill would leave the owner charged.
async function livePostingsForInvoice(supabase, invoiceId) {
  const { data, error } = await supabase.from('legal_invoice_postings').select('id').eq('ap_invoice_id', invoiceId).in('status', ['pending', 'posted']);
  if (error && missingTable(error)) return 0;   // before migration 508
  if (error) throw error;
  return (data || []).length;
}

module.exports = { buildPlan, planTreatment, approveTreatment, ensureDirectAccrual, apAccount, reversePosting, cancelPendingPosting, reopenReview, postingsReady, loadPostings, livePostingsForInvoice, bedrockReceivableAccount, homeownerDescription };
