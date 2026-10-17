// ============================================================================
// lib/payments/payment_store.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Production store for payment_lifecycle.js. Every state change goes through a
// migration-469 database function (row lock + compare-and-set); the GL entry is
// keyed 'stripe:pay:<payment id>' under a unique index, so each step can be
// retried and never duplicates.
//
// GL accounts come from community_account_roles (stripe_clearing, homeowner_ar),
// never from an account number in code. A community without both roles is
// 'blocked' for an operator, not guessed.
//
// Posting order (a credit is invisible until all three finish):
//   1. post_stripe_tenure_payment  -> tenure-stamped AR row in a DRAFT batch
//   2. journal entry               -> Dr stripe_clearing / Cr homeowner_ar
//   3. payment_commit_posting      -> commits the batch; the owner sees the credit
// Reversal (full refund / full chargeback) mirrors it, and the original payment
// stays on the ledger:
//   1. reverse_stripe_tenure_payment -> +amount reversal row (reverses_txn_id) in a DRAFT batch
//   2. journal entry 'stripe:rev:<id>' -> Dr homeowner_ar / Cr stripe_clearing
//   3. payment_commit_reversal      -> commits it and reopens the charges the payment paid
// Payout (Ed 2026-10-16), per connected-account payout id, into stripe_payouts:
//   payout.paid   -> journal entry 'stripe:payout:<po>' Dr operating_cash / Cr stripe_clearing
//                    on the arrival date: the bank deposit bank reconciliation matches
//   payout.failed -> if that entry posted, 'stripe:payout-fail:<po>' reverses it
// Never for an archived/ended community, one whose financials are off, or a date
// before its GL cutover; a closed period marks the payout 'blocked' for staff.
// Receipt (Ed 2026-10-16): one payment_receipts row per settled payment; emailed
// only when the community's receipt switch is on (lib/payments/payment_receipt.js).
// Known business blocks (period closed, missing account) mark the payment
// 'blocked' / review for an operator instead of throwing; anything unexpected
// throws so the webhook returns 500 and Stripe retries.
// ============================================================================
const { postJournalEntry } = require('../accounting/posting');
const { centralDate } = require('./payment_lifecycle');
const receipts = require('./payment_receipt');
const { PAYMENT_POLICY } = require('./payment_policy');

const PAYMENT_ROLES = ['stripe_clearing', 'homeowner_ar'];
const PAYOUT_ROLES = ['operating_cash', 'stripe_clearing'];
const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
// lib/community/lifecycle builds a Supabase client on load; require it only when used.
const lifecycleEvaluate = (service, row) => require('../community/lifecycle').evaluate(service, row);

function createPaymentStore({ supabase, legacy = {}, log = console, stripe = null, receiptDeps = {}, evaluate = lifecycleEvaluate }) {
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
  // { stripe_clearing: account_id, homeowner_ar: account_id } for the roles that
  // point at an active, postable account in this community.
  async function accountsFor(communityId, wanted = PAYMENT_ROLES) {
    const roles = await must(supabase.from('community_account_roles').select('role, account_id')
      .eq('community_id', communityId).in('role', wanted), 'account roles');
    if (!roles.length) return {};
    const accts = await must(supabase.from('chart_of_accounts').select('id, community_id, is_active, is_summary')
      .in('id', roles.map((r) => r.account_id)), 'role accounts');
    const ok = new Set(accts.filter((a) => a.community_id === communityId && a.is_active && !a.is_summary).map((a) => a.id));
    return Object.fromEntries(roles.filter((r) => ok.has(r.account_id)).map((r) => [r.role, r.account_id]));
  }
  const missingRole = (accts, wanted = PAYMENT_ROLES) => wanted.find((r) => !accts[r]) || null;
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
      if (p.posting_state === 'posted' || p.posting_state === 'reversed') return { posting: 'already_posted' };
      if (p.settlement_state !== 'settled') throw new Error(`payment ${paymentId} is not settled (${p.settlement_state})`);

      const community = await must(supabase.from('communities').select('id, gl_cutover_date').eq('id', p.community_id).single(), 'community');
      const cutover = community.gl_cutover_date ? String(community.gl_cutover_date).slice(0, 10) : null;
      if (!cutover || cutover > paymentDate) {
        await rpc('payment_mark_posting', { p_payment_id: paymentId, p_state: 'not_applicable', p_note: 'Community is not on the live GL; its receivable is still kept outside Trusted.' });
        return { posting: 'not_applicable' };
      }

      const accts = await accountsFor(p.community_id);
      const missing = missingRole(accts);
      if (missing) {
        await rpc('payment_mark_posting', { p_payment_id: paymentId, p_state: 'blocked', p_note: `No active GL account is assigned the ${missing} role for this community` });
        log.error(`[payments] payment ${paymentId} settled but BLOCKED: no ${missing} account role`);
        return { posting: 'blocked', reason: 'missing_account_role', role: missing };
      }

      const ar = await rpc('post_stripe_tenure_payment', { p_payment_id: paymentId, p_payment_date: paymentDate });
      const amount = Math.abs(Number(p.amount_cents));
      let je;
      try {
        je = await postOnce(p.community_id, `stripe:pay:${paymentId}`, {
          posting_date: paymentDate,
          description: 'Online homeowner payment (Stripe)',
          lines: [
            { account_id: accts.stripe_clearing, debit_cents: amount, credit_cents: 0, memo: 'Stripe payment awaiting payout' },
            { account_id: accts.homeowner_ar, debit_cents: 0, credit_cents: amount, memo: 'Homeowner payment', property_id: p.property_id },
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

    // kind: 'refund' | 'chargeback'. Full reversals only; partials are flagged upstream.
    async reversePayment(paymentId, { kind, reason, reversalDate }) {
      const r = await rpc('reverse_stripe_tenure_payment', { p_payment_id: paymentId, p_kind: kind, p_reason: reason, p_reversal_date: reversalDate });
      if (r.action === 'review') return { action: 'review', payment_id: paymentId };
      if (r.already_reversed) return { action: 'already_reversed', payment_id: paymentId };
      const p = await must(supabase.from('payments').select('id, community_id, property_id, amount_cents').eq('id', paymentId).single(), 'payment');
      const amount = Math.abs(Number(p.amount_cents));
      const accts = await accountsFor(p.community_id);
      const missing = missingRole(accts);
      let je;
      try {
        if (missing) throw new Error(`no active GL account is assigned the ${missing} role`);
        je = await postOnce(p.community_id, `stripe:rev:${paymentId}`, {
          posting_date: reversalDate,
          description: `Online payment ${kind === 'chargeback' ? 'charged back' : 'refunded'} (${reason})`,
          lines: [
            { account_id: accts.homeowner_ar, debit_cents: amount, credit_cents: 0, memo: 'Homeowner payment reversed', property_id: p.property_id },
            { account_id: accts.stripe_clearing, debit_cents: 0, credit_cents: amount, memo: `Stripe ${reason}` },
          ],
        });
      } catch (e) {
        // The reversal row stays a draft (the owner's ledger still shows the payment),
        // so the books never disagree with each other; a person finishes it.
        await rpc('payment_flag_review', { p_payment_id: paymentId, p_reason: `Stripe ${kind} received but not posted (${e.message}); reversal drafted, needs GL` });
        log.error(`[payments] payment ${paymentId} ${kind} not posted: ${e.message}`);
        return { action: 'reversal_blocked', payment_id: paymentId, reason: e.message };
      }
      const c = await rpc('payment_commit_reversal', { p_payment_id: paymentId, p_journal_entry_id: je.id });
      return { action: 'reversed', payment_id: paymentId, reversal_journal_entry_id: je.id, reversal_txn_id: c.reversal_txn_id,
        applications_reversed: c.applications_reversed, reopened_cents: c.reopened_cents };
    },

    // ---------------------------------------------------------------- receipts
    async createReceipt(paymentId, { session = {}, paymentDate }) {
      const have = await must(supabase.from('payment_receipts').select('id, status').eq('payment_id', paymentId).limit(1), 'receipt lookup');
      if (have.length) return { action: 'receipt_exists', receipt_id: have[0].id, status: have[0].status };
      const p = await must(supabase.from('payments')
        .select('id, community_id, property_id, tenure_id, amount_cents, payment_group_id, payment_method_type, trusted_account_number, settlement_state')
        .eq('id', paymentId).single(), 'payment');
      if (p.settlement_state !== 'settled') return { action: 'no_receipt', reason: `payment is ${p.settlement_state}` };
      const group = await must(supabase.from('payments').select('fee_type, amount_cents').eq('payment_group_id', p.payment_group_id).limit(10), 'payment group');
      const fee = group.filter((r) => r.fee_type === 'convenience_fee').reduce((t, r) => t + Number(r.amount_cents || 0), 0);
      const community = await must(supabase.from('communities').select('id, name, hoa_legal_name, payment_receipt_emails_enabled').eq('id', p.community_id).single(), 'community');
      const property = p.property_id ? await must(supabase.from('properties').select('street_address').eq('id', p.property_id).maybeSingle(), 'property') : null;
      const details = (session && session.customer_details) || {};
      const toEmail = details.email || (session && session.customer_email) || null;
      const r = receipts.buildPaymentReceipt({ payment: { ...p, convenience_fee_cents: fee }, community, property, paidOn: paymentDate, payerName: details.name || null });
      const decision = receipts.receiptSendDecision({ community, toEmail });
      const { data: row, error } = await supabase.from('payment_receipts').insert({
        payment_id: p.id, community_id: p.community_id, property_id: p.property_id, tenure_id: p.tenure_id,
        receipt_number: r.receipt_number, amount_cents: r.amount_cents, paid_on: r.paid_on, payment_method: r.payment_method,
        to_email: toEmail, subject: r.subject, body_text: r.body_text,
        status: decision.send ? 'recorded' : decision.status, status_note: decision.note,
      }).select('id').single();
      if (error) {
        if (error.code === '23505') return { action: 'receipt_exists' };
        throw new Error(`[payment_store] receipt insert failed: ${error.message}`);
      }
      if (!decision.send) return { action: 'receipt_recorded', receipt_id: row.id, emailed: false, status: decision.status };
      let sent;
      try { sent = await receipts.sendReceiptEmail({ receipt: r, toEmail, community }, receiptDeps); } catch (e) { sent = { ok: false, error: e.message }; }
      const patch = sent.ok ? { status: 'sent', sent_at: new Date().toISOString() } : { status: 'send_failed', status_note: String(sent.error || 'send failed').slice(0, 500) };
      const { error: uErr } = await supabase.from('payment_receipts').update(patch).eq('id', row.id);
      if (uErr) log.error(`[payments] receipt ${row.id} status not saved:`, uErr.message);
      if (!sent.ok) log.error(`[payments] receipt ${row.id} not emailed: ${sent.error}`);
      return { action: 'receipt_recorded', receipt_id: row.id, emailed: !!sent.ok, status: patch.status };
    },

    // ----------------------------------------------------------------- payouts
    async recordPayout({ accountId, payout, eventId, eventCreated = null, kind, livemode }) {
      const comms = await must(supabase.from('communities')
        .select('id, name, management_status, management_end_date, financials_active, gl_cutover_date, stripe_connected_account_id')
        .eq('stripe_connected_account_id', accountId).limit(2), 'payout community');
      if (comms.length !== 1) return { action: 'ignored', reason: comms.length ? 'account on more than one community' : 'no community for this connected account', account: accountId };
      const c = comms[0];
      const po = payout.id;
      const amount = Number(payout.amount || 0);
      const arrival = centralDate(payout.arrival_date);
      let row = (await must(supabase.from('stripe_payouts').select('*').eq('payout_id', po).limit(1), 'payout lookup'))[0] || null;
      if (!row) {
        const ins = await supabase.from('stripe_payouts').insert({
          payout_id: po, community_id: c.id, connected_account_id: accountId, livemode, amount_cents: amount,
          currency: payout.currency || 'usd', arrival_date: arrival, payout_status: kind,
          ...(kind === 'paid' ? { paid_event_id: eventId } : { failed_event_id: eventId }),
        }).select('*').single();
        if (ins.error && ins.error.code !== '23505') throw new Error(`[payment_store] payout insert failed: ${ins.error.message}`);
        row = ins.data || (await must(supabase.from('stripe_payouts').select('*').eq('payout_id', po).limit(1), 'payout lookup'))[0];
      }
      const setRow = async (patch) => {
        const { error } = await supabase.from('stripe_payouts').update(patch).eq('payout_id', po);
        if (error) throw new Error(`[payment_store] payout ${po} update failed: ${error.message}`);
        Object.assign(row, patch);
      };
      const isBusinessBlock = (e) => ['period_closed', 'before_gl_cutover'].includes(e.code) || /^period_closed|before the GL cutover|no active GL account/i.test(e.message || '');

      if (kind === 'canceled') {
        if (!row.journal_entry_id) await setRow({ payout_status: 'canceled', posting_state: 'not_applicable', posting_note: 'Payout canceled before it was paid.' });
        return { action: 'payout_canceled', payout: po };
      }

      if (kind === 'failed') {
        await setRow({ payout_status: 'failed', failed_event_id: eventId, failure_code: payout.failure_code || null, failure_message: payout.failure_message || null });
        if (!row.journal_entry_id) {
          await setRow({ posting_state: 'not_applicable', posting_note: 'Payout failed before its GL entry posted; nothing to reverse.' });
          return { action: 'payout_failed_unposted', payout: po };
        }
        if (row.failure_journal_entry_id) return { action: 'payout_failure_already_posted', payout: po, journal_entry_id: row.failure_journal_entry_id };
        const accts = await accountsFor(c.id, PAYOUT_ROLES);
        const missing = missingRole(accts, PAYOUT_ROLES);
        try {
          if (missing) throw new Error(`no active GL account is assigned the ${missing} role`);
          const je = await postOnce(c.id, `stripe:payout-fail:${po}`, {
            posting_date: centralDate(eventCreated),
            description: `Stripe payout ${po} failed and returned to Stripe (${payout.failure_code || 'failed'})`,
            lines: [
              { account_id: accts.stripe_clearing, debit_cents: amount, credit_cents: 0, memo: `Stripe payout ${po} returned` },
              { account_id: accts.operating_cash, debit_cents: 0, credit_cents: amount, memo: `Stripe payout ${po} failed` },
            ],
          });
          await setRow({ posting_state: 'reversed', failure_journal_entry_id: je.id, posting_note: `Payout failed (${payout.failure_code || 'failed'}); reversed by its own entry.` });
          return { action: 'payout_failure_posted', payout: po, journal_entry_id: je.id };
        } catch (e) {
          if (!isBusinessBlock(e)) throw e;
          await setRow({ posting_state: 'review', posting_note: `Payout failed after posting; reversal not posted: ${e.message}` });
          log.error(`[payments] payout ${po} failed after posting; reversal blocked: ${e.message}`);
          return { action: 'payout_failure_blocked', payout: po, reason: e.message };
        }
      }

      // kind === 'paid'
      if (row.journal_entry_id) return { action: 'payout_already_posted', payout: po, journal_entry_id: row.journal_entry_id };
      const life = evaluate('financials', c);
      if (!life.allowed || c.management_status === 'archived') {
        await setRow({ posting_state: 'not_applicable', posting_note: `Not posted: ${life.reason || 'community is archived'}` });
        return { action: 'payout_not_applicable', payout: po, reason: life.reason || 'archived' };
      }
      const cutover = c.gl_cutover_date ? String(c.gl_cutover_date).slice(0, 10) : null;
      if (!cutover || cutover > arrival) {
        await setRow({ posting_state: 'not_applicable', posting_note: 'Community is not on the live GL for this date.' });
        return { action: 'payout_not_applicable', payout: po, reason: 'before_gl_cutover' };
      }
      if (!(amount > 0)) {
        await setRow({ posting_state: 'not_applicable', posting_note: 'Zero-amount payout.' });
        return { action: 'payout_not_applicable', payout: po, reason: 'zero_amount' };
      }
      const accts = await accountsFor(c.id, PAYOUT_ROLES);
      const missing = missingRole(accts, PAYOUT_ROLES);
      if (missing) {
        await setRow({ posting_state: 'blocked', posting_note: `No active GL account is assigned the ${missing} role for this community` });
        log.error(`[payments] payout ${po} BLOCKED: no ${missing} account role`);
        return { action: 'payout_blocked', payout: po, reason: 'missing_account_role', role: missing };
      }
      let je;
      try {
        je = await postOnce(c.id, `stripe:payout:${po}`, {
          posting_date: arrival,
          description: `Stripe payout ${po} to the operating bank account`,
          lines: [
            { account_id: accts.operating_cash, debit_cents: amount, credit_cents: 0, memo: `Stripe payout ${po}` },
            { account_id: accts.stripe_clearing, debit_cents: 0, credit_cents: amount, memo: `Stripe payout ${po} relieves clearing` },
          ],
        });
      } catch (e) {
        if (!isBusinessBlock(e)) throw e;
        await setRow({ posting_state: 'blocked', posting_note: `GL not posted: ${e.message}` });
        log.error(`[payments] payout ${po} BLOCKED: ${e.message}`);
        return { action: 'payout_blocked', payout: po, reason: e.message };
      }
      await setRow({ posting_state: 'posted', journal_entry_id: je.id, payout_status: 'paid', posting_note: null });
      return { action: je.existed ? 'payout_already_posted' : 'payout_posted', payout: po, journal_entry_id: je.id, amount_cents: amount, arrival_date: arrival };
    },

    // --------------------------------------------------------- lost disputes
    // On a destination charge Stripe debits a dispute from the PLATFORM. This
    // recovers the association's transfer (auto reversal ON) or tells staff the
    // exact reversal to make (OFF, the default). See payment_policy.js.
    async disputeLost({ paymentId, dispute }) {
      const p = await must(supabase.from('payments').select('id, community_id, amount_cents').eq('id', paymentId).single(), 'payment');
      const community = await must(supabase.from('communities').select('id, name, stripe_dispute_auto_reversal').eq('id', p.community_id).single(), 'community');
      const amount = Math.abs(Number(p.amount_cents));
      let transferId = null;
      if (stripe && typeof stripe.retrieveCharge === 'function' && dispute.charge) {
        const ch = await stripe.retrieveCharge(typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id);
        const tr = ch.ok && ch.charge ? ch.charge.transfer : null;
        transferId = tr && typeof tr === 'object' ? tr.id : tr;
      }
      const action = transferId
        ? `reverse transfer ${transferId} for ${money(amount)} (Stripe Dashboard: Connect > Transfers > ${transferId} > Reverse; API: POST /v1/transfers/${transferId}/reversals amount=${amount})`
        : `find the transfer on charge ${dispute.charge || '(unknown)'} and reverse ${money(amount)} of it`;
      const policy = `dispute_bearer is '${PAYMENT_POLICY.dispute_bearer}' pending Ed's decision (lib/payments/payment_policy.js)`;

      if (community.stripe_dispute_auto_reversal === true && transferId && stripe && typeof stripe.reverseTransfer === 'function') {
        const r = await stripe.reverseTransfer({ transferId, amountCents: amount, idempotencyKey: `dispute-lost-${dispute.id}`,
          metadata: { dispute_id: dispute.id, payment_id: p.id }, communityId: community.id });
        if (r.ok) {
          await rpc('payment_flag_review', { p_payment_id: p.id, p_reason: `Dispute ${dispute.id} lost: transfer ${transferId} reversed ${money(amount)} (${r.reversal_id}). Confirm the association's next payout is short by this amount.` });
          return { action: 'transfer_reversed', payment_id: p.id, transfer_id: transferId, reversal_id: r.reversal_id, amount_cents: amount };
        }
        await rpc('payment_flag_review', { p_payment_id: p.id, p_reason: `Dispute ${dispute.id} lost: automatic transfer reversal FAILED (${r.error || r.reason}). Staff: ${action}.` });
        log.error(`[payments] dispute ${dispute.id} transfer reversal failed: ${r.error || r.reason}`);
        return { action: 'transfer_reversal_failed', payment_id: p.id, transfer_id: transferId, error: r.error || r.reason };
      }
      await rpc('payment_flag_review', { p_payment_id: p.id, p_reason: `Dispute ${dispute.id} lost: Stripe took ${money(dispute.amount)} from Bedrock's platform balance; ${community.name} still holds the ${money(amount)} transfer, so its Stripe clearing runs short by that amount until resolved. To recover it from the association: ${action}. ${policy}.` });
      return { action: 'dispute_lost_flagged', payment_id: p.id, transfer_id: transferId, amount_cents: amount };
    },

    legacyCheckoutCompleted: (obj, eventId) => (legacy.checkoutCompleted ? legacy.checkoutCompleted(obj, eventId) : null),
    legacyPaymentFailed: (obj, eventId) => (legacy.paymentFailed ? legacy.paymentFailed(obj, eventId) : null),
    legacyChargeRefunded: (obj, eventId) => (legacy.chargeRefunded ? legacy.chargeRefunded(obj, eventId) : null),
    accountUpdated: (obj) => (legacy.accountUpdated ? legacy.accountUpdated(obj) : null),
  };
}

module.exports = { createPaymentStore, PAYMENT_ROLES };
