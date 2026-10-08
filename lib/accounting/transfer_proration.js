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
//   2. The GL entry posts through postJournalEntry, keyed to the batch:
//        builder charge   Dr 1300 AR / Cr 4000 Current Year Assessment Income
//        builder credit   Dr 4000 / Cr 1300 AR
//        homeowner charge Dr 1300 AR / Cr 4000
//   3. The batch is committed, then the proration rows are marked posted.
// A failure after step 1 leaves nothing visible and is finished by calling
// postTransferProration again for the same transfer.
// ============================================================================
const { postJournalEntry } = require('./posting');

const AR = '1300', INCOME = '4000';

const REASON_TEXT = {
  seller_mixed_owners: 'the seller account has owners who are not the builder',
  multiple_builders: 'the seller names more than one builder',
  rates_missing: 'the homeowner or builder assessment rate is not set for this community',
  fiscal_year_not_calendar: 'the assessment year is not the calendar year',
  ambiguous_builder_assessment: "the builder's existing assessment activity for the year does not show clearly what it was billed",
  buyer_already_billed: 'the buyer already has assessment activity for the year',
  before_gl_cutover: 'the settlement date is before this community moved its books to trustEd',
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

async function _accounts(supabase, communityId) {
  const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number')
    .eq('community_id', communityId).in('account_number', [AR, INCOME]);
  if (error) throw error;
  const by = Object.fromEntries((data || []).map((a) => [a.account_number, a.id]));
  if (!by[AR] || !by[INCOME]) throw new Error(`accounts ${AR}/${INCOME} missing for this community`);
  return by;
}

// The GL lines for a written plan. Pure (given account ids).
function glLines(acct, plan) {
  const adj = Number(plan.builder_adjustment_cents || 0);
  const ho = Number(plan.homeowner_due_cents || 0);
  const pid = plan.property_id;
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
    lines.push({ account_id: acct[INCOME], debit_cents: 0, credit_cents: ho, memo: `Prorated homeowner assessment ${plan.fiscal_year}` });
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
    const acct = await _accounts(supabase, communityId);
    const r = await postJournalEntry({
      community_id: communityId, posting_date: plan.settlement_date, source_module: 'assessment_billing', source_reference: batchId,
      description: `Assessment proration at transfer: ${plan.builder} to ${plan.buyer_name || 'new owner'} (${plan.settlement_date})`,
      notes: `Transfer ${proposalId}; subledger batch ${batchId}; issue #94 rule (builder ${plan.builder_rate_pct}%, homeowner 100%)`,
      lines: glLines(acct, plan),
    });
    entry = r.entry;
  }
  const { error: ce } = await supabase.from('transaction_upload_batches')
    .update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', batchId).eq('status', 'draft');
  if (ce) throw Object.assign(new Error(`GL ${entry.reference} posted but the proration batch could not be committed: ${ce.message}. Retry to finish.`), { code: 'commit_pending' });
  const { error: me } = await supabase.from('assessment_prorations')
    .update({ status: 'posted', journal_entry_id: entry.id }).eq('proposal_id', proposalId).eq('status', 'draft');
  if (me) throw Object.assign(new Error(`GL ${entry.reference} posted and the batch committed, but the proration record could not be marked posted: ${me.message}. Retry to finish.`), { code: 'mark_pending' });

  return {
    status: data.already_prorated ? 'completed_retry' : 'posted', proposal_id: proposalId,
    journal_entry_id: entry.id, journal_reference: entry.reference, batch_id: batchId,
    builder_adjustment_cents: plan.builder_adjustment_cents, homeowner_due_cents: plan.homeowner_due_cents,
    builder_due_cents: plan.builder_due_cents, plan: data.written ? data : plan,
  };
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

module.exports = { previewTransferProration, postTransferProration, gateTransferProration, afterTransfer, glLines, reasonText, REASON_TEXT };
