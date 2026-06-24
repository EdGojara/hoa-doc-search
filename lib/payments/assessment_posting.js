// ============================================================================
// lib/payments/assessment_posting.js
// ----------------------------------------------------------------------------
// Posts a completed online assessment payment to the books for a LIVE-GL
// community. Called from the Stripe webhook (checkout.session.completed) after
// the `payments` rows are marked succeeded.
//
// Two records, both reducing the homeowner's receivable by the SAME amount so
// the AR subledger and the GL control account stay in lockstep:
//   1. AR subledger — a `homeowner_transactions` payment row (negative cents)
//      so resolveCurrentAR / the homeowner portal show the balance drop now.
//   2. GL — Dr Operating Cash (1000) / Cr Accounts Receivable (1300) for the
//      assessment amount, via the canonical postJournalEntry() engine.
//
// Only the `fee_type='assessment'` portion touches the HOA's books. The card
// convenience fee is Bedrock's (payee=management_company) and stays in the
// payments ledger only — never on the association's GL.
//
// CASH-ON-PAYMENT-DATE is intentional, not a simplification: the existing bank
// reconciliation matcher (lib/banking/matcher.js) expects individual gross
// payments that net to a batched Stripe payout — so per-payment Dr Cash is
// exactly what reconciles against the payout deposit.
//
// GATING: only runs when the community is on live GL
// (communities.gl_cutover_date set and on/before today). Vantaca-snapshot
// communities are left to the payments ledger; their AR reconciles on the next
// monthly transaction import. Returns { skipped:'not_live_gl' } in that case.
//
// IDEMPOTENT: both the subledger row and the GL entry are keyed to the Stripe
// session id, so a webhook redelivery or manual replay never double-posts.
//
// PERIOD-CLOSED: if no open accounting period covers today, the GL post is
// deferred (flagged on the payment rows for operator follow-up) rather than
// throwing — the money already moved; we never wedge the webhook on a calendar
// edge. The AR subledger row still posts so the homeowner sees the payment.
// ============================================================================

const { postJournalEntry } = require('../accounting/posting');

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const CASH_ACCOUNT = '1000'; // Operating Cash
const AR_ACCOUNT = '1300';   // Accounts Receivable
const ONLINE_BATCH_LABEL = 'Online Payments';
// journal_entries.source_module is CHECK-constrained (migration 170); 'payment_intake'
// is the canonical value for portal/online payments. source_reference=<session id>
// keys idempotency to this specific payment.
const GL_SOURCE_MODULE = 'payment_intake';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// Entry point — post one completed assessment payment to AR + GL.
// ----------------------------------------------------------------------------
async function postAssessmentPaymentToBooks(supabase, { sessionId, paymentIntentId = null }) {
  if (!sessionId) return { skipped: 'no_session_id' };

  // 1) Load the assessment payment rows for this session
  const { data: payRows } = await supabase
    .from('payments')
    .select('id, community_id, product_id, fee_type, payee, amount_cents, status')
    .eq('processor_session_id', sessionId)
    .eq('product_type', 'assessment_payment');
  if (!payRows || !payRows.length) return { skipped: 'no_assessment_rows' };

  // The assessment principal is the only line that hits the HOA's books.
  const assessmentRow = payRows.find((r) => r.fee_type === 'assessment');
  if (!assessmentRow) return { skipped: 'no_assessment_fee_row' };

  const communityId = assessmentRow.community_id;
  const propertyId = assessmentRow.product_id;
  const assessmentCents = Math.abs(Number(assessmentRow.amount_cents || 0));
  if (assessmentCents <= 0) return { skipped: 'zero_amount' };

  // 2) Live-GL gate — only live communities post to AR + GL here.
  const { data: community } = await supabase
    .from('communities')
    .select('id, name, gl_cutover_date')
    .eq('id', communityId)
    .maybeSingle();
  const cutover = community && community.gl_cutover_date;
  const isLiveGL = !!cutover && String(cutover).slice(0, 10) <= todayISO();
  if (!isLiveGL) {
    return { skipped: 'not_live_gl', community_id: communityId };
  }

  // 3) Resolve property identity for the subledger key + GL line tag.
  const { data: property } = await supabase
    .from('properties')
    .select('id, vantaca_account_id, street_address')
    .eq('id', propertyId)
    .maybeSingle();
  const vantacaAccountId = property && property.vantaca_account_id;
  const propLabel =
    (property && property.street_address) || vantacaAccountId || String(propertyId).slice(0, 8);

  const result = { community_id: communityId, property_id: propertyId, amount_cents: assessmentCents };

  // 4) AR subledger — idempotent homeowner_transactions payment row.
  if (vantacaAccountId) {
    try {
      result.subledger = await upsertSubledgerPayment(supabase, {
        communityId, propertyId, vantacaAccountId,
        amountCents: assessmentCents, sessionId, paymentIntentId, propLabel,
      });
    } catch (e) {
      console.error('[assessment_posting] subledger insert failed:', e.message);
      result.subledger_error = e.message;
    }
  } else {
    console.warn(`[assessment_posting] property ${propertyId} has no vantaca_account_id; AR subledger skipped`);
    result.subledger = { skipped: 'no_vantaca_account_id' };
  }

  // 5) GL — Dr Cash / Cr AR, idempotent by session id.
  try {
    result.gl = await postPaymentToGL(supabase, {
      communityId, propertyId, amountCents: assessmentCents, sessionId, propLabel,
    });
  } catch (e) {
    if (e.code === 'period_closed') {
      console.warn(`[assessment_posting] period closed for ${todayISO()}; GL deferred for session ${sessionId}`);
      await flagGLDeferred(supabase, sessionId, e.message);
      result.gl = { deferred: true, reason: e.message };
    } else {
      console.error('[assessment_posting] GL post failed:', e.message);
      result.gl_error = e.message;
    }
  }

  return result;
}

// ----------------------------------------------------------------------------
// Find-or-create the standing "Online Payments" batch for a community. Online
// payments append to this single committed batch (vs. one batch per upload).
// ----------------------------------------------------------------------------
async function getOnlinePaymentsBatch(supabase, communityId) {
  const { data: existing } = await supabase
    .from('transaction_upload_batches')
    .select('id')
    .eq('community_id', communityId)
    .eq('period_label', ONLINE_BATCH_LABEL)
    .eq('source_format', 'manual')
    .eq('status', 'committed')
    .order('uploaded_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('transaction_upload_batches')
    .insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: communityId,
      period_label: ONLINE_BATCH_LABEL,
      as_of_date: todayISO(),
      source_format: 'manual',
      status: 'committed',
      committed_at: new Date().toISOString(),
      uploaded_by: 'system:online_payments',
      notes: 'Standing batch for online assessment payments (Stripe). Appended on each completed payment.',
    })
    .select('id')
    .single();
  if (error) throw error;
  return created.id;
}

// ----------------------------------------------------------------------------
// Insert the AR subledger payment row (idempotent by stripe session id).
// ----------------------------------------------------------------------------
async function upsertSubledgerPayment(supabase, opts) {
  const { communityId, propertyId, vantacaAccountId, amountCents, sessionId, paymentIntentId, propLabel } = opts;

  // Idempotency — already recorded this session's payment?
  const { data: dupe } = await supabase
    .from('homeowner_transactions')
    .select('id')
    .eq('community_id', communityId)
    .eq('vantaca_account_id', vantacaAccountId)
    .contains('raw_row_jsonb', { stripe_session_id: sessionId })
    .limit(1)
    .maybeSingle();
  if (dupe) return { id: dupe.id, idempotent: true };

  const batchId = await getOnlinePaymentsBatch(supabase, communityId);

  // Best-effort contact link (subledger balance keys on vantaca_account_id; this
  // is just for joins).
  let contactId = null;
  try {
    const { data: c } = await supabase
      .from('contacts').select('id').eq('vantaca_account_id', vantacaAccountId).limit(1).maybeSingle();
    contactId = c ? c.id : null;
  } catch (_) { /* non-fatal */ }

  // source_row_index — next within the batch. Low-frequency surface; on the rare
  // concurrent-payment race the UNIQUE(batch, row_index) violation (23505)
  // triggers a recompute + retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: maxRow } = await supabase
      .from('homeowner_transactions')
      .select('source_row_index')
      .eq('source_batch_id', batchId)
      .order('source_row_index', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextIdx = ((maxRow && Number(maxRow.source_row_index)) || 0) + 1;

    const { data: inserted, error } = await supabase
      .from('homeowner_transactions')
      .insert({
        source_batch_id: batchId,
        source_row_index: nextIdx,
        community_id: communityId,
        vantaca_account_id: vantacaAccountId,
        property_id: propertyId,
        contact_id: contactId,
        transaction_date: todayISO(),
        description: `Online assessment payment — ${propLabel}`,
        txn_type: 'payment',
        amount_cents: -Math.abs(amountCents), // payment reduces balance
        running_balance_cents: null,
        raw_row_jsonb: { stripe_session_id: sessionId, payment_intent: paymentIntentId, source: 'stripe_assessment' },
      })
      .select('id')
      .single();
    if (!error) return { id: inserted.id, source_row_index: nextIdx };
    if (error.code === '23505') continue; // row_index race — recompute + retry
    throw error;
  }
  throw new Error('subledger_row_index_contention');
}

// ----------------------------------------------------------------------------
// Post the GL entry: Dr Cash (1000) / Cr AR (1300). Idempotent by session id.
// ----------------------------------------------------------------------------
async function postPaymentToGL(supabase, opts) {
  const { communityId, propertyId, amountCents, sessionId, propLabel } = opts;

  // Idempotency — already posted a JE for this session?
  const { data: existingJE } = await supabase
    .from('journal_entries')
    .select('id, reference')
    .eq('community_id', communityId)
    .eq('source_module', GL_SOURCE_MODULE)
    .eq('source_reference', sessionId)
    .limit(1)
    .maybeSingle();
  if (existingJE) {
    return { journal_entry_id: existingJE.id, reference: existingJE.reference, idempotent: true };
  }

  // Resolve Cash + AR account ids for this community.
  const { data: accts } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number')
    .eq('community_id', communityId)
    .in('account_number', [CASH_ACCOUNT, AR_ACCOUNT]);
  const byNum = Object.fromEntries((accts || []).map((a) => [String(a.account_number), a.id]));
  if (!byNum[CASH_ACCOUNT] || !byNum[AR_ACCOUNT]) {
    throw new Error(`missing_coa_accounts (need ${CASH_ACCOUNT} cash + ${AR_ACCOUNT} AR)`);
  }

  const { entry } = await postJournalEntry({
    community_id: communityId,
    posting_date: todayISO(),
    description: `Online assessment payment — ${propLabel}`,
    source_module: GL_SOURCE_MODULE,
    source_reference: sessionId,
    lines: [
      { account_id: byNum[CASH_ACCOUNT], debit_cents: amountCents, credit_cents: 0, memo: `Stripe assessment payment — ${propLabel}` },
      { account_id: byNum[AR_ACCOUNT], debit_cents: 0, credit_cents: amountCents, memo: `Assessment paid — ${propLabel}`, property_id: propertyId },
    ],
  });
  return { journal_entry_id: entry.id, reference: entry.reference };
}

// ----------------------------------------------------------------------------
// Flag the payment rows so an operator can post the GL once the period reopens.
// ----------------------------------------------------------------------------
async function flagGLDeferred(supabase, sessionId, reason) {
  const { data: rows } = await supabase
    .from('payments')
    .select('id, processor_metadata')
    .eq('processor_session_id', sessionId);
  for (const r of rows || []) {
    const meta = Object.assign({}, r.processor_metadata || {}, {
      gl_deferred: true,
      gl_deferred_reason: reason,
    });
    await supabase.from('payments').update({ processor_metadata: meta }).eq('id', r.id);
  }
}

module.exports = { postAssessmentPaymentToBooks };
