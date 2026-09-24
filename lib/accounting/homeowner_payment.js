// ============================================================================
// lib/accounting/homeowner_payment.js
// ----------------------------------------------------------------------------
// Post a homeowner payment to an EXPLICIT owner tenure (never "the property"),
// applied to that tenure's charges in the approved Tex. Prop. Code 209.0063
// order, with the matching GL entry. First caller: the Home Sales closing
// payoff (a title company paying the SELLER's balance at closing).
//
// The subledger work (payment row + one application per charge slice) is ONE
// database call (post_homeowner_tenure_payment, mig 461), written to a DRAFT
// batch that no reader sees. Then the GL entry posts through postJournalEntry
// (Dr 1000 Operating Cash / Cr 1300 AR, dated the check date), and only then is
// the batch committed. A failure after the draft leaves nothing visible and is
// retried idempotently: the same check (community + check # + amount) always
// resolves to the same draft, the GL is keyed to the batch, nothing duplicates.
// ============================================================================
const { postJournalEntry } = require('./posting');

const CASH = '1000', AR = '1300';

function _args(o, dryRun) {
  return {
    p_community_id: o.communityId, p_property_id: o.propertyId, p_tenure_id: o.tenureId,
    p_amount_cents: o.amountCents, p_payment_date: o.paymentDate, p_check_number: String(o.checkNumber || '').trim(),
    p_payee: o.payee || null, p_source: o.source || {}, p_approved_by: o.approvedBy || null, p_dry_run: dryRun,
  };
}

async function _accounts(supabase, communityId) {
  const { data, error } = await supabase.from('chart_of_accounts').select('id, account_number')
    .eq('community_id', communityId).in('account_number', [CASH, AR]);
  if (error) throw error;
  const by = Object.fromEntries((data || []).map((a) => [a.account_number, a.id]));
  if (!by[CASH] || !by[AR]) throw new Error(`accounts ${CASH}/${AR} missing`);
  return by;
}

function _glLines(acct, o, label) {
  return [
    { account_id: acct[CASH], debit_cents: o.amountCents, credit_cents: 0, memo: `Closing payoff check ${o.checkNumber} (${o.payee || 'title company'})` },
    { account_id: acct[AR], debit_cents: 0, credit_cents: o.amountCents, property_id: o.propertyId,
      memo: `Seller payoff ${label}: tenure ${o.tenureId}, check ${o.checkNumber}` },
  ];
}

// Dry run: the application plan plus the exact rows/entry a post would write.
async function planTenurePayment(supabase, o) {
  const { data, error } = await supabase.rpc('post_homeowner_tenure_payment', _args(o, true));
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  if (data && data.already_posted) return data;
  const acct = await _accounts(supabase, o.communityId);
  return {
    ...data,
    proposed_payment_row: {
      tenure_id: o.tenureId, property_id: o.propertyId, transaction_date: o.paymentDate, txn_type: 'payment',
      charge_category: 'payment', amount_cents: -o.amountCents, reduction_source: 'cash_payment',
      check_number: String(o.checkNumber).trim(), payee: o.payee || null, source: o.source || {},
    },
    proposed_gl: { posting_date: o.paymentDate, source_module: 'payment_intake', lines: _glLines(acct, o, o.label || '') },
  };
}

// Post (or finish a previously interrupted post). Returns { status: 'posted' | 'already_posted', ... }.
async function postTenurePayment(supabase, o) {
  const { data, error } = await supabase.rpc('post_homeowner_tenure_payment', _args(o, false));
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const batchId = data.batch_id;
  if (data.already_posted && data.batch_status === 'committed') return { status: 'already_posted', ...data };

  // GL, idempotent by batch id.
  const { data: je, error: je0 } = await supabase.from('journal_entries').select('id, reference, status')
    .eq('community_id', o.communityId).eq('source_module', 'payment_intake').eq('source_reference', batchId).maybeSingle();
  if (je0) throw je0;
  let entry = je;
  if (!entry) {
    const acct = await _accounts(supabase, o.communityId);
    const r = await postJournalEntry({
      community_id: o.communityId, posting_date: o.paymentDate, source_module: 'payment_intake', source_reference: batchId,
      description: `Closing payoff: check ${o.checkNumber} applied to seller account${o.label ? ' (' + o.label + ')' : ''}`,
      notes: `Subledger batch ${batchId}; applied per Tex. Prop. Code 209.0063`,
      lines: _glLines(acct, o, o.label || ''),
    });
    entry = r.entry;
  }
  const { error: ce } = await supabase.from('transaction_upload_batches')
    .update({ status: 'committed', committed_at: new Date().toISOString() }).eq('id', batchId).eq('status', 'draft');
  if (ce) throw Object.assign(new Error(`GL ${entry.reference} posted but the payment batch could not be committed: ${ce.message}. Retry to finish.`), { code: 'commit_pending' });
  return { status: data.already_posted ? 'completed_retry' : 'posted', ...data, journal_entry_id: entry.id, journal_reference: entry.reference };
}

module.exports = { planTenurePayment, postTenurePayment };
