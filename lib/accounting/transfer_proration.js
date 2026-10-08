// ============================================================================
// lib/accounting/transfer_proration.js  (Ed 2026-10-08, GitHub issue #94)
// ----------------------------------------------------------------------------
// Builder-to-homeowner assessment proration, run INSIDE the ownership transfer
// (Home Sales "Record closing" and Ownership Review "Approve"). Still Creek
// Ranch / Lennar is the only configured case (migration 500); every other
// community and every other seller gets plan.applies === false and the
// transfer behaves exactly as before.
//
// Same shape as the closing payoff (homeowner_payment.js):
//   1. post_transfer_assessment_proration (mig 500) writes the builder
//      adjustment on the SELLER tenure and the homeowner charge on the BUYER
//      tenure into a DRAFT batch that no ledger reader sees, plus one
//      assessment_prorations row per role. One transfer, one set: unique keys.
//   2. The GL entry posts through postJournalEntry, keyed to the batch, on the
//      community's OWN revenue treatment (community_assessment_rates):
//        builder charge   Dr 1300 AR / Cr income (4000): its months have all
//                         elapsed by the settlement, so it is earned
//        builder credit   Dr income / Cr 1300 AR (direct-recognition communities
//                         only). A builder's DEFERRED annual assessment is
//                         normalized by the community's accounting conversion
//                         (a 'conversion_builder_normalization' row on the
//                         builder's tenure, migration 500); until then the
//                         transfer blocks, after it the transfer nets against
//                         it, so nothing is adjusted twice
//        homeowner charge Dr 1300 AR / Cr deferral (2205 at Still Creek), then a
//                         recognition schedule releases it to income monthly from
//                         the settlement month through year end; with no
//                         deferral account configured, Cr income directly
//   3. The batch is committed, then the proration rows are marked posted.
// A failure after step 1 leaves nothing visible and is finished by calling
// postTransferProration again for the same transfer.
//
// ACCOUNTING READINESS (Ed 2026-10-08): nothing financial is written until the
// community has a POSTED conversion (the platform's one readiness rule,
// lib/ar/ownership_history.js). Before that, the transfer still shows and
// confirms the calculation, and the proration is STAGED: recorded against the
// transfer with no owner-ledger row, batch or GL entry. After the conversion
// posts, postStagedProration recomputes it against the converted ledger, shows
// it again for confirmation, and posts it. We never create an interim GL that a
// later conversion is expected to repair.
// ============================================================================
const { postJournalEntry } = require('./posting');

const AR = '1300';

const REASON_TEXT = {
  seller_mixed_owners: 'the seller account has owners who are not the builder',
  multiple_builders: 'the seller names more than one builder',
  rates_missing: 'the homeowner or builder assessment rate is not set for this community',
  fiscal_year_not_calendar: 'the assessment year is not the calendar year',
  ambiguous_builder_assessment: "the builder's existing assessment activity for the year does not show clearly what it was billed",
  awaiting_conversion_normalization: "the builder's annual assessment is deferred in the community's unearned income; the community's accounting conversion must first normalize it to the builder rate (this screen never changes community-wide revenue schedules)",
  builder_coverage_missing: "the conversion recorded no builder coverage for this lot (e.g. an unexplained builder charge it did not normalize); it needs a person",
  builder_coverage_invalid: "the builder's coverage record has a gap, an overlap or an amount that does not match the builder rate; it needs review",
  builder_coverage_pending: "a builder coverage period is still being posted; finish it first",
  builder_billed_past_settlement: "the builder has already been billed past the settlement date (e.g. an accrual ran before this closing was recorded); the last period must be voided first",
  buyer_already_billed: 'the buyer already has assessment activity for the year',
  settlement_before_conversion_baseline: 'the settlement date is on or before the accounting conversion baseline (Vantaca-era activity)',
};
const reasonText = (codes) => (codes || []).map((c) => REASON_TEXT[c] || c);

function _err(error) { return Object.assign(new Error(error.message), { code: error.code }); }

// Before the transfer: what the proration WILL be, from the lot's current owner.
async function previewTransferProration(supabase, { propertyId, sellerTenureId, settlementDate, buyerName }) {
  const { data, error } = await supabase.rpc('transfer_proration_plan', {
    p_property_id: propertyId, p_seller_tenure_id: sellerTenureId, p_settlement_date: settlementDate,
    p_buyer_name: buyerName || null, p_buyer_tenure_id: null,
  });
  if (error) throw _err(error);
  return { ...data, blocked_text: reasonText(data && data.blocked_reasons) };
}

// The accounts a plan posts to: AR, the community's income account and (when
// it defers) its unearned account. All must exist.
async function _accounts(supabase, communityId, plan) {
  const want = [AR, plan.income_account || '4000', plan.deferral_account].filter(Boolean);
  const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number')
    .eq('community_id', communityId).in('account_number', want);
  if (error) throw error;
  const by = Object.fromEntries((data || []).map((a) => [a.account_number, a.id]));
  const missing = want.filter((n) => !by[n]);
  if (missing.length) throw new Error(`accounts ${missing.join('/')} missing for this community`);
  return by;
}

// The GL lines for a written plan. Pure (given account ids).
function glLines(acct, plan) {
  const adj = Number(plan.builder_adjustment_cents || 0);
  const ho = Number(plan.homeowner_due_cents || 0);
  const pid = plan.property_id;
  const INCOME = plan.income_account || '4000';
  const HO_CREDIT = plan.deferral_account || INCOME;
  if (adj < 0 && plan.deferral_account) throw new Error('a credit against a deferred annual assessment is never posted here; the accounting conversion normalizes it (awaiting_conversion_normalization)');
  const lines = [];
  if (adj > 0) {
    lines.push({ account_id: acct[AR], debit_cents: adj, credit_cents: 0, property_id: pid, memo: `Builder assessment proration (${plan.builder}), seller tenure ${plan.seller_tenure_id}` });
    lines.push({ account_id: acct[INCOME], debit_cents: 0, credit_cents: adj, memo: `Builder assessment proration ${plan.fiscal_year}` });
  } else if (adj < 0) {
    lines.push({ account_id: acct[INCOME], debit_cents: -adj, credit_cents: 0, memo: `Builder assessment reduced to its ${plan.builder_rate_pct}% prorated share ${plan.fiscal_year}` });
    lines.push({ account_id: acct[AR], debit_cents: 0, credit_cents: -adj, property_id: pid, memo: `Builder assessment adjustment (${plan.builder}), seller tenure ${plan.seller_tenure_id}` });
  }
  if (ho > 0) {
    lines.push({ account_id: acct[AR], debit_cents: ho, credit_cents: 0, property_id: pid, memo: `Prorated assessment, new owner tenure ${plan.buyer_tenure_id}` });
    lines.push({ account_id: acct[HO_CREDIT], debit_cents: 0, credit_cents: ho, memo: plan.deferral_account
      ? `Prorated homeowner assessment ${plan.fiscal_year}, unearned until released monthly`
      : `Prorated homeowner assessment ${plan.fiscal_year}` });
  }
  return lines;
}

// After an approved transfer. Returns:
//   { status: 'not_applicable' | 'blocked' | 'posted' | 'already_posted' | 'completed_retry', ... }
// Never throws for a business answer (not applicable / blocked); throws on a
// real failure, which the caller reports as pending and retries.
async function postTransferProration(supabase, { proposalId, postedBy }) {
  const { data, error } = await supabase.rpc('post_transfer_assessment_proration', {
    p_proposal_id: proposalId, p_posted_by: postedBy || 'staff', p_dry_run: false,
  });
  if (error) throw _err(error);
  if (data && data.already_prorated && data.all_posted) return { status: 'already_posted', ...data };
  if (data && data.applies === false) return { status: 'not_applicable', ...data };
  if (data && data.blocked) return { status: 'blocked', ...data, blocked_text: reasonText(data.blocked_reasons) };
  // Not converted yet: the calculation is recorded against the transfer, nothing financial.
  if (data && data.staged && !data.written) return { status: 'staged', ...data };

  // The written (or previously written, unfinished) proration. Read it back from
  // the audit rows so a retry posts exactly what was written.
  const { data: rows, error: rErr } = await supabase.from('assessment_prorations')
    .select('id, role, status, prorated_amount_cents, batch_id, journal_entry_id, homeowner_txn_id, tenure_id, community_id, property_id')
    .eq('proposal_id', proposalId);
  if (rErr) throw rErr;
  if (!rows || !rows.length) throw new Error('proration rows missing after write');
  const batchId = rows.map((r) => r.batch_id).find(Boolean) || null;
  const communityId = rows[0].community_id;
  if (!batchId) {
    // Nothing to post (both amounts zero): the audit rows are the whole record.
    return { status: data.already_prorated ? 'already_posted' : 'posted', proposal_id: proposalId, journal_entry_id: null, rows };
  }
  const plan = data.written ? data : await _planFromLedger(supabase, batchId, rows);

  // GL, idempotent by batch id.
  const { data: je, error: je0 } = await supabase.from('journal_entries').select('id, reference, status')
    .eq('community_id', communityId).eq('source_module', 'assessment_billing').eq('source_reference', batchId).maybeSingle();
  if (je0) throw je0;
  let entry = je;
  if (!entry) {
    const acct = await _accounts(supabase, communityId, plan);
    const r = await postJournalEntry({
      community_id: communityId, posting_date: plan.settlement_date, source_module: 'assessment_billing', source_reference: batchId,
      description: `Assessment proration at transfer: ${plan.builder} to ${plan.buyer_name || 'new owner'} (${plan.settlement_date})`,
      notes: `Transfer ${proposalId}; subledger batch ${batchId}; issue #94 rule (builder ${plan.builder_rate_pct}%, homeowner 100%)`,
      lines: glLines(acct, plan),
    });
    entry = r.entry;
  }
  // The new owner's deferred share: one recognition schedule per transfer, keyed
  // to the homeowner proration row, created before anything is marked done.
  const schedule = await _ensureRecognition(supabase, { plan, rows, entry, communityId, proposalId });
  const { error: ce } = await supabase.from('transaction_upload_batches')
    .update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', batchId).eq('status', 'draft');
  if (ce) throw Object.assign(new Error(`GL ${entry.reference} posted but the proration batch could not be committed: ${ce.message}. Retry to finish.`), { code: 'commit_pending' });
  const { error: me } = await supabase.from('assessment_prorations')
    .update({ status: 'posted', journal_entry_id: entry.id }).eq('proposal_id', proposalId).eq('status', 'draft');
  if (me) throw Object.assign(new Error(`GL ${entry.reference} posted and the batch committed, but the proration record could not be marked posted: ${me.message}. Retry to finish.`), { code: 'mark_pending' });
  // The transfer's builder days (a transfer_true_up coverage period) are now accounted for.
  const { error: ve } = await supabase.from('builder_assessment_coverage')
    .update({ status: 'posted', journal_entry_id: entry.id, journal_entry_reference: entry.reference }).eq('proposal_id', proposalId).eq('status', 'pending');
  if (ve) throw Object.assign(new Error(`GL ${entry.reference} posted, but the builder coverage period could not be marked posted: ${ve.message}. Retry to finish.`), { code: 'coverage_pending' });

  return {
    status: data.already_prorated ? 'completed_retry' : 'posted', proposal_id: proposalId,
    journal_entry_id: entry.id, journal_reference: entry.reference, batch_id: batchId, recognition_schedule_id: schedule ? schedule.id : null,
    builder_adjustment_cents: plan.builder_adjustment_cents, homeowner_due_cents: plan.homeowner_due_cents,
    builder_due_cents: plan.builder_due_cents, plan: data.written ? data : plan,
  };
}

// The recognition schedule for the new owner's deferred share (the recognition
// engine posts the months: Dr deferral / Cr income). Idempotent: found by its
// source (assessment_billing + the homeowner proration row).
async function _ensureRecognition(supabase, { plan, rows, entry, communityId, proposalId }) {
  const ho = Number(plan.homeowner_due_cents || 0);
  const rec = plan.homeowner_recognition;
  if (!plan.deferral_account || !(ho > 0) || !rec) return null;
  const hRow = rows.find((r) => r.role === 'homeowner_charge');
  if (!hRow) throw new Error('homeowner proration row missing');
  const { data: found, error: fErr } = await supabase.from('recognition_schedules').select('id')
    .eq('source_type', 'assessment_billing').eq('source_id', hRow.id).maybeSingle();
  if (fErr) throw fErr;
  let sched = found;
  if (!sched) {
    const acct = await _accounts(supabase, communityId, plan);
    const startMon = String(rec.start_month).slice(0, 7);
    const { data, error } = await supabase.from('recognition_schedules').insert({
      community_id: communityId, schedule_type: 'deferred_revenue',
      description: `${plan.fiscal_year} prorated assessment, new owner from ${plan.settlement_date} (transfer ${proposalId})`,
      balance_account_number: plan.deferral_account, recognition_account_id: acct[plan.income_account || '4000'],
      recognize_amount_cents: ho, start_month: rec.start_month, term_months: rec.term_months, monthly_amount_cents: rec.monthly_cents,
      period_start: plan.settlement_date, period_end: plan.homeowner_period_end,
      recognition_method: 'straight_line_monthly', schedule_basis: 'calculated', status: 'active',
      source_type: 'assessment_billing', source_id: hRow.id, source_journal_entry_id: entry.id,
      created_by: 'transfer_proration',
      explanation: `Released 1/${rec.term_months} monthly from ${startMon}, the community's convention (annual assessments deferred through ${plan.deferral_account} and recognized monthly).`,
    }).select('id').single();
    if (error) throw Object.assign(new Error(`GL ${entry.reference} posted but the recognition schedule could not be created: ${error.message}. Retry to finish.`), { code: 'schedule_pending' });
    sched = data;
    const { error: sErr } = await supabase.from('recognition_schedule_segments').insert([{ schedule_id: sched.id, income_account_number: plan.income_account || '4000', label: 'Assessment Income', monthly_amount_cents: rec.monthly_cents }]);
    if (sErr) throw Object.assign(new Error(`recognition schedule ${sched.id} created but its income segment failed: ${sErr.message}`), { code: 'schedule_pending' });
  }
  const { error: uErr } = await supabase.from('assessment_prorations').update({ recognition_schedule_id: sched.id }).eq('id', hRow.id);
  if (uErr) throw uErr;
  return sched;
}

// A retry after the draft was written: rebuild the posting facts from the two
// ledger rows (their raw_row_jsonb carries the plan they were written from).
async function _planFromLedger(supabase, batchId, rows) {
  const { data: txns, error } = await supabase.from('homeowner_transactions')
    .select('id, amount_cents, tenure_id, raw_row_jsonb').eq('source_batch_id', batchId);
  if (error) throw error;
  const any = (txns || []).find((t) => t.raw_row_jsonb && t.raw_row_jsonb.plan);
  if (!any) throw new Error('proration batch has no plan to finish from');
  const b = rows.find((r) => r.role === 'builder_adjustment');
  const h = rows.find((r) => r.role === 'homeowner_charge');
  return {
    ...any.raw_row_jsonb.plan,
    property_id: rows[0].property_id, community_id: rows[0].community_id,
    seller_tenure_id: b && b.tenure_id, buyer_tenure_id: h && h.tenure_id,
    builder_adjustment_cents: b ? b.prorated_amount_cents : 0,
    homeowner_due_cents: h ? h.prorated_amount_cents : 0,
  };
}

// Before a transfer runs: decide whether it may proceed, so staff always SEE
// the proration before anything posts. Returns { proceed: true, plan } or
// { proceed: false, status, body } for the endpoint to send as-is.
//   applies + clean   -> needs confirmed === true (the staff saw the numbers)
//   applies + blocked -> needs blockedAck === true (record the transfer now;
//                        the proration waits for a human, nothing guessed)
//   not applicable    -> proceed (every other community / seller, unchanged)
// Before migration 500 is applied the plan function does not exist: transfers
// proceed exactly as before, with a warning in the log.
async function gateTransferProration(supabase, { propertyId, sellerTenureId, settlementDate, buyerName, confirmed, blockedAck }) {
  let plan;
  try {
    plan = await previewTransferProration(supabase, { propertyId, sellerTenureId, settlementDate, buyerName });
  } catch (e) {
    if (e.code === 'PGRST202' || e.code === '42883' || /transfer_proration_plan/.test(e.message || '') && /does not exist|Could not find/i.test(e.message || '')) {
      console.warn('[transfer-proration] plan function not available (migration 500 not applied); transfer proceeds without proration');
      return { proceed: true, plan: { applies: false, reason: 'not_installed' } };
    }
    return { proceed: false, status: 409, body: { error: 'proration_cannot_plan: ' + e.message, code: 'proration_cannot_plan' } };
  }
  if (!plan.applies) return { proceed: true, plan };
  if (plan.blocked) {
    if (blockedAck === true) return { proceed: true, plan };
    return { proceed: false, status: 409, body: {
      error: 'proration_blocked: ' + plan.blocked_text.join('; ') + '. The transfer can be recorded now and the assessment proration resolved separately; nothing will be guessed.',
      code: 'proration_blocked', proration: plan } };
  }
  if (confirmed === true) return { proceed: true, plan };
  return { proceed: false, status: 409, body: { error: 'proration_confirmation_required: review the assessment proration, then confirm', code: 'proration_confirmation_required', proration: plan } };
}

// After a transfer: post when the gate said so. A failure never undoes the
// transfer; it is reported pending and finished with postTransferProration.
async function afterTransfer(supabase, gate, { proposalId, postedBy }) {
  if (!gate || !gate.plan || !gate.plan.applies) return null;
  if (gate.plan.blocked) return { status: 'blocked', ...gate.plan };
  try { return await postTransferProration(supabase, { proposalId, postedBy }); }
  catch (e) {
    console.error('[transfer-proration] post failed (transfer stands):', e.message);
    return { status: 'pending', error: e.message, proposal_id: proposalId };
  }
}

// Post a STAGED proration once the community is converted. Staff see the
// recomputed numbers first: without confirmed === true this returns
// { status: 'confirmation_required', plan } and writes nothing.
async function postStagedProration(supabase, { proposalId, postedBy, confirmed }) {
  const { data, error } = await supabase.rpc('post_transfer_assessment_proration', {
    p_proposal_id: proposalId, p_posted_by: postedBy || 'staff', p_dry_run: true,
  });
  if (error) throw _err(error);
  if (data && data.already_prorated) return postTransferProration(supabase, { proposalId, postedBy });   // finish / already done
  if (data && data.applies === false) return { status: 'not_applicable', ...data };
  if (data && data.blocked) return { status: 'blocked', ...data, blocked_text: reasonText(data.blocked_reasons) };
  if (data && data.posting_ready === false) return { status: 'staged', ...data };
  if (confirmed !== true) return { status: 'confirmation_required', plan: { ...data, blocked_text: [] } };
  return postTransferProration(supabase, { proposalId, postedBy });
}

// The staged-proration queue (Ed 2026-10-08): every transfer proration not yet
// posted, RECALCULATED now against the current ledger and readiness:
//   Staged        calculated at the transfer; the community is not converted
//   Ready to Post converted, recomputed, nothing blocking; staff review + confirm
//   Blocked       a person must resolve something (the reason is given)
// Nothing here posts. Posting is POST /transfer/:proposalId/post with confirmed.
async function listTransferQueue(supabase, communityId) {
  let qy = supabase.from('assessment_prorations')
    .select('proposal_id, community_id, property_id, role, status, effective_date, created_at, properties(street_address)')
    .not('proposal_id', 'is', null).in('status', ['staged', 'draft']).order('effective_date').limit(1000);
  if (communityId) qy = qy.eq('community_id', communityId);
  const { data, error } = await qy;
  if (error) throw error;
  const by = new Map();
  for (const r of data || []) {
    if (!by.has(r.proposal_id)) by.set(r.proposal_id, { proposal_id: r.proposal_id, community_id: r.community_id, property_id: r.property_id,
      property: r.properties && r.properties.street_address, settlement_date: r.effective_date, recorded_at: r.created_at, record_status: r.status });
    if (r.status === 'draft') by.get(r.proposal_id).record_status = 'draft';
  }
  const out = [];
  for (const item of by.values()) {
    const { data: p, error: pErr } = await supabase.rpc('post_transfer_assessment_proration', { p_proposal_id: item.proposal_id, p_posted_by: 'queue', p_dry_run: true });
    if (pErr) { out.push({ ...item, status: 'Blocked', reasons: [pErr.message] }); continue; }
    const plan = p || {};
    let status;
    if (item.record_status === 'draft') status = 'Ready to Post';                 // an interrupted post: finish it
    else if (plan.blocked) status = 'Blocked';
    else if (plan.posting_ready) status = 'Ready to Post';
    else status = 'Staged';
    out.push({
      ...item, status,
      reasons: status === 'Blocked' ? reasonText(plan.blocked_reasons) : (status === 'Staged' ? ['waiting for the community\'s accounting conversion to be posted'] : []),
      outgoing_owner: (plan.seller_names || []).join('; ') || null,
      incoming_owner: plan.buyer_name || null,
      builder: plan.builder || null,
      builder_due_cents: plan.builder_due_cents, builder_adjustment_cents: plan.builder_adjustment_cents,
      builder_prior_billed_cents: plan.builder_prior_billed_cents, homeowner_due_cents: plan.homeowner_due_cents,
      builder_prior_rows: plan.builder_prior_rows || [], normalization_required: plan.normalization_required || null, builder_normalized: plan.builder_normalized || null,
      plan,
    });
  }
  return out;
}

module.exports = { previewTransferProration, postTransferProration, postStagedProration, listTransferQueue, gateTransferProration, afterTransfer, glLines, reasonText, REASON_TEXT };
