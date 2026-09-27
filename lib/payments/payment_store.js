// ============================================================================
// lib/payments/payment_store.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Production store for payment_lifecycle.js. Every state change goes through a
// migration-469 database function (row lock + compare-and-set); the GL entry is
// keyed 'stripe:pay:<payment id>' under a unique index, so each step can be
// retried and never duplicates.
//
// Posting order (a credit is invisible until all three finish):
//   1. post_stripe_tenure_payment  -> tenure-stamped AR row in a DRAFT batch
//   2. journal entry               -> Dr 1090 Stripe Clearing / Cr 1300 AR
//   3. payment_commit_posting      -> commits the batch; the owner sees the credit
// Known business blocks (period closed, missing account) mark the payment
// 'blocked' for an operator instead of throwing; anything unexpected throws so
// the webhook returns 500 and Stripe retries.
// ============================================================================
const { postJournalEntry } = require('../accounting/posting');

const CLEARING_ACCOUNT = '1090';
const AR_ACCOUNT = '1300';

function createPaymentStore({ supabase, legacy = {}, log = console }) {
  async function must(query, what) {
    const { data, error } = await query;
    if (error) throw new Error(`[payment_store] ${what} failed: ${error.message}`);
    return data;
  }
  async function rpc(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`[payment_store] ${fn} failed: ${error.message}`);
    return data;
  }
  async function accountsFor(communityId) {
    const rows = await must(supabase.from('chart_of_accounts').select('id, account_number, is_active')
      .eq('community_id', communityId).in('account_number', [CLEARING_ACCOUNT, AR_ACCOUNT]), 'accounts');
    return Object.fromEntries(rows.filter((a) => a.is_active).map((a) => [String(a.account_number), a.id]));
  }
  async function findJournal(communityId, ref) {
    const rows = await must(supabase.from('journal_entries').select('id, status')
      .eq('community_id', communityId).eq('source_reference', ref).limit(1), 'journal lookup');
    return rows[0] || null;
  }
  // Post (or find) the one journal entry for this reference.
  async function postOnce(communityId, ref, entry) {
    const found = await findJournal(communityId, ref);
    if (found) return { id: found.id, existed: true };
    try {
      const { entry: je } = await postJournalEntry({ community_id: communityId, source_module: 'payment_intake', source_reference: ref, ...entry });
      return { id: je.id, existed: false };
    } catch (e) {
      if (e.code === '23505' || /uq_journal_entries_stripe_ref|duplicate key/i.test(e.message || '')) {
        const again = await findJournal(communityId, ref);
        if (again) return { id: again.id, existed: true };
      }
      throw e;
    }
  }

  return {
    async claimEvent(event) {
      const obj = (event.data && event.data.object) || {};
      return rpc('stripe_event_claim', {
        p_event_id: event.id, p_type: event.type, p_livemode: !!event.livemode,
        p_account: event.account || null, p_object_id: obj.id || null, p_payload: event,
      });
    },
    async finishEvent(eventId, status, error, outcome) {
      await rpc('stripe_event_finish', { p_event_id: eventId, p_status: status, p_error: error, p_outcome: outcome });
    },
    settle: ({ group, session, paymentIntent, charge }) =>
      rpc('payment_settle', { p_group: group, p_session: session, p_payment_intent: paymentIntent, p_charge: charge }),
    markProcessing: ({ group, session, paymentIntent }) =>
      rpc('payment_mark_processing', { p_group: group, p_session: session, p_payment_intent: paymentIntent }),
    markFailed: ({ group, session, paymentIntent, terminal, reason }) =>
      rpc('payment_mark_failed', { p_group: group, p_session: session, p_payment_intent: paymentIntent, p_terminal: terminal, p_reason: reason }),
    flagReview: (paymentId, reason) => rpc('payment_flag_review', { p_payment_id: paymentId, p_reason: reason }),

    async findAssessmentByIntent(paymentIntent) {
      if (!paymentIntent) return null;
      const rows = await must(supabase.from('payments').select('id, payment_group_id, amount_cents, fee_type')
        .eq('processor_payment_id', paymentIntent).eq('product_type', 'assessment_payment').not('payment_group_id', 'is', null), 'payment by intent');
      const a = rows.find((r) => r.fee_type === 'assessment');
      if (!a) return null;
      return { id: a.id, payment_group_id: a.payment_group_id, group_total_cents: rows.reduce((s, r) => s + Number(r.amount_cents || 0), 0) };
    },

    async postPayment(paymentId, { paymentDate }) {
      const p = await must(supabase.from('payments')
        .select('id, community_id, property_id, amount_cents, settlement_state, posting_state').eq('id', paymentId).single(), 'payment');
      if (p.posting_state === 'posted') return { posting: 'already_posted' };
      if (p.settlement_state !== 'settled') throw new Error(`payment ${paymentId} is not settled (${p.settlement_state})`);

      const community = await must(supabase.from('communities').select('id, gl_cutover_date').eq('id', p.community_id).single(), 'community');
      const cutover = community.gl_cutover_date ? String(community.gl_cutover_date).slice(0, 10) : null;
      if (!cutover || cutover > paymentDate) {
        await rpc('payment_mark_posting', { p_payment_id: paymentId, p_state: 'not_applicable', p_note: 'Community is not on the live GL; its receivable is still kept outside Trusted.' });
        return { posting: 'not_applicable' };
      }

      const accts = await accountsFor(p.community_id);
      if (!accts[CLEARING_ACCOUNT] || !accts[AR_ACCOUNT]) {
        await rpc('payment_mark_posting', { p_payment_id: paymentId, p_state: 'blocked', p_note: `Missing active GL account ${!accts[CLEARING_ACCOUNT] ? CLEARING_ACCOUNT : AR_ACCOUNT}` });
        log.error(`[payments] payment ${paymentId} settled but BLOCKED: missing GL account`);
        return { posting: 'blocked', reason: 'missing_account' };
      }

      const ar = await rpc('post_stripe_tenure_payment', { p_payment_id: paymentId, p_payment_date: paymentDate });
      const amount = Math.abs(Number(p.amount_cents));
      let je;
      try {
        je = await postOnce(p.community_id, `stripe:pay:${paymentId}`, {
          posting_date: paymentDate,
          description: 'Online homeowner payment (Stripe)',
          lines: [
            { account_id: accts[CLEARING_ACCOUNT], debit_cents: amount, credit_cents: 0, memo: 'Stripe payment awaiting payout' },
            { account_id: accts[AR_ACCOUNT], debit_cents: 0, credit_cents: amount, memo: 'Homeowner payment', property_id: p.property_id },
          ],
        });
      } catch (e) {
        if (e.code === 'period_closed' || /before.*cutover|cutover/i.test(e.message || '')) {
          await rpc('payment_mark_posting', { p_payment_id: paymentId, p_state: 'blocked', p_note: `GL not posted: ${e.message}` });
          log.error(`[payments] payment ${paymentId} settled but BLOCKED: ${e.message}`);
          return { posting: 'blocked', reason: e.message };
        }
        throw e;
      }
      const c = await rpc('payment_commit_posting', { p_payment_id: paymentId, p_journal_entry_id: je.id });
      return { posting: 'posted', journal_entry_id: je.id, homeowner_txn_id: c.homeowner_txn_id || ar.payment_txn_id, applied_cents: ar.applied_cents, unapplied_cents: ar.unapplied_cents };
    },

    async reversePayment(paymentId, reason, reversalDate) {
      const r = await rpc('reverse_stripe_tenure_payment', { p_payment_id: paymentId, p_reason: reason });
      if (r.action === 'review') return { action: 'review', payment_id: paymentId };
      const p = await must(supabase.from('payments').select('id, community_id, property_id, amount_cents, reversal_journal_entry_id').eq('id', paymentId).single(), 'payment');
      if (p.reversal_journal_entry_id) return { action: 'already_reversed', payment_id: paymentId };
      const accts = await accountsFor(p.community_id);
      const amount = Math.abs(Number(p.amount_cents));
      try {
        const je = await postOnce(p.community_id, `stripe:rev:${paymentId}`, {
          posting_date: reversalDate,
          description: `Online payment reversed (${reason})`,
          lines: [
            { account_id: accts[AR_ACCOUNT], debit_cents: amount, credit_cents: 0, memo: 'Homeowner payment reversed', property_id: p.property_id },
            { account_id: accts[CLEARING_ACCOUNT], debit_cents: 0, credit_cents: amount, memo: `Stripe ${reason}` },
          ],
        });
        await rpc('payment_link_reversal', { p_payment_id: paymentId, p_journal_entry_id: je.id });
        return { action: 'reversed', payment_id: paymentId, reversal_journal_entry_id: je.id };
      } catch (e) {
        // The receivable is already restored; the GL half needs a person (e.g. closed period).
        await rpc('payment_flag_review', { p_payment_id: paymentId, p_reason: `Credit reversed but GL reversal not posted: ${e.message}` });
        log.error(`[payments] payment ${paymentId} reversal GL not posted: ${e.message}`);
        return { action: 'reversed_gl_pending', payment_id: paymentId };
      }
    },

    legacyCheckoutCompleted: (obj, eventId) => (legacy.checkoutCompleted ? legacy.checkoutCompleted(obj, eventId) : null),
    legacyPaymentFailed: (obj, eventId) => (legacy.paymentFailed ? legacy.paymentFailed(obj, eventId) : null),
    legacyChargeRefunded: (obj, eventId) => (legacy.chargeRefunded ? legacy.chargeRefunded(obj, eventId) : null),
    accountUpdated: (obj) => (legacy.accountUpdated ? legacy.accountUpdated(obj) : null),
  };
}

module.exports = { createPaymentStore, CLEARING_ACCOUNT, AR_ACCOUNT };
