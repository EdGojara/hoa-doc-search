// ============================================================================
// lib/ap/early_prepay.js  (Ed 2026-08-31)
// ----------------------------------------------------------------------------
// Pay a vendor bill BEFORE its invoice/service date without distorting the
// month you paid in. This is the small-vendor-favor case: they need cash, we
// cut the check early. Paid naively, the payment (Dr AP / Cr Cash) lands in the
// pay month while the accrual (Cr AP) doesn't exist until the invoice month, so
// AP shows a negative (debit) balance at month-end and the pay month has cash
// out with no matching expense. That is really a PREPAYMENT, and the books
// should say so.
//
// Ed's model, encoded here — three entries:
//   Pay month  (M1):  Dr Prepaid (13000) / Cr AP        ← book the payable as a prepaid asset
//                     Dr AP              / Cr Cash       ← the check clears the payable (AP nets to 0)
//   Invoice mo (M2):  Dr Expense         / Cr Prepaid    ← reverse the prepaid into expense
//
// Net: M1 balance sheet shows Prepaid + cash out, no expense, no negative AP.
// M2 shows the expense. The reversal is DATED in M2 so it recognizes in the
// service month, and it is posted now (not left to a cron that doesn't exist)
// so it can never be forgotten.
//
// Only fires when the payment month is strictly BEFORE the invoice month. Same
// month (pay 9/1 for a 9/5 bill) has no artifact and takes the normal path.
// The whole bill must be paid (no partial cross-period prepay). Requires coded
// lines — we need to know which expense account the reversal lands in.
// ============================================================================

// posting.js is required lazily inside the function (it builds a Supabase client
// at module load) so tests can inject posters without env. Same pattern as
// lib/ap/legal_billback.js.

const ymOf = (d) => String(d).slice(0, 7);
const firstOfMonth = (d) => `${ymOf(d)}-01`;

// True when the payment lands in an EARLIER month than the invoice date — the
// only case that creates the cross-period prepaid artifact.
function isEarlyCrossPeriod(paymentDate, invoiceDate) {
  if (!paymentDate || !invoiceDate) return false;
  return ymOf(paymentDate) < ymOf(invoiceDate);
}

async function _resolveAccount(supabase, community_id, numbers, nameLike) {
  for (const n of numbers) {
    const { data } = await supabase.from('chart_of_accounts')
      .select('id, account_number').eq('community_id', community_id)
      .eq('account_number', n).eq('is_active', true).maybeSingle();
    if (data) return data;
  }
  if (nameLike) {
    const { data } = await supabase.from('chart_of_accounts')
      .select('id, account_number').eq('community_id', community_id)
      .ilike('account_name', nameLike).eq('is_active', true).limit(1).maybeSingle();
    if (data) return data;
  }
  return null;
}

// The invoice-month reversal (Dr Expense / Cr Prepaid). Bedrock keeps future
// periods open, so the normal validated poster handles it — full balance +
// account checks + a real sequential reference. If a future period ever isn't
// open, fall back to a direct insert (mirroring the recognition engine) so the
// reversal can NEVER strand — there is no monthly cron to catch it later.
async function _postReversal(supabase, args, postJE) {
  try {
    const je = await postJE({
      community_id: args.community_id, posting_date: args.posting_date,
      description: args.description, source_module: 'system',
      source_reference: String(args.invoiceId), lines: args.lines,
    });
    return je.entry.id;
  } catch (e) {
    if (e && e.code === 'period_closed') return _postReversalDirect(supabase, args);
    throw e;
  }
}

async function _postReversalDirect(supabase, { community_id, posting_date, description, lines, invoiceId }) {
  let totalD = 0, totalC = 0;
  for (const l of lines) { totalD += Number(l.debit_cents || 0); totalC += Number(l.credit_cents || 0); }
  if (totalD !== totalC) throw Object.assign(new Error(`reversal_unbalanced_${totalD}_${totalC}`), { code: 'unbalanced' });

  const fy = Number(posting_date.slice(0, 4)), pn = Number(posting_date.slice(5, 7));
  const { data: period } = await supabase.from('accounting_periods')
    .select('id').eq('community_id', community_id).eq('fiscal_year', fy).eq('period_number', pn).maybeSingle();

  const ref = `JE-PREPAY-REV-${ymOf(posting_date)}-${String(invoiceId).slice(0, 8)}`;
  const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
    community_id, period_id: period ? period.id : null, posting_date, reference: ref,
    description, source_module: 'system', total_debits_cents: totalD, total_credits_cents: totalC, status: 'posted',
  }).select('id').single();
  if (jeErr) throw jeErr;

  const rows = lines.map((l, i) => ({
    journal_entry_id: je.id, line_number: i + 1, account_id: l.account_id,
    debit_cents: Number(l.debit_cents || 0), credit_cents: Number(l.credit_cents || 0), memo: l.memo || null,
  }));
  const { error: lErr } = await supabase.from('journal_entry_lines').insert(rows);
  if (lErr) throw lErr;
  return je.id;
}

// injected.{postJE, voidJE, postReversal} are override points for tests.
async function payInvoiceEarlyAsPrepaid(supabase, {
  invoice, paymentDate, amountCents, method = 'ach', checkNumber = null, bankAccountId = null, postedByUserId = null,
}, injected = {}) {
  // Short-circuit the requires when posters are injected (tests), so posting.js
  // (which builds a Supabase client at load) is never touched without env.
  const postJE = injected.postJE || require('../accounting/posting').postJournalEntry;
  const voidJE = injected.voidJE || require('../accounting/posting').voidJournalEntry;
  const postReversal = injected.postReversal || ((args) => _postReversal(supabase, args, postJE));

  if (!invoice || !invoice.id) throw Object.assign(new Error('invoice_required'), { code: 'invalid_input' });
  const community_id = invoice.community_id;
  const invoice_date = invoice.invoice_date;
  if (!isEarlyCrossPeriod(paymentDate, invoice_date)) {
    throw Object.assign(new Error('not_early_cross_period_use_normal_payment'), { code: 'invalid_input' });
  }

  const owed = Number(invoice.total_cents || 0) - Number(invoice.amount_paid_cents || 0);
  if (owed <= 0) throw Object.assign(new Error('nothing_due'), { code: 'invalid_state' });
  const amt = Number(amountCents);
  if (!Number.isInteger(amt) || amt <= 0) throw Object.assign(new Error('amount_required'), { code: 'invalid_input' });
  if (amt !== owed) throw Object.assign(new Error('prepay_must_be_full_amount'), { code: 'invalid_input' });

  // Expense side comes from the invoice's own coded lines — we can't defer to a
  // prepaid and later recognize without knowing which expense account it lands in.
  const { data: lineRows, error: lnErr } = await supabase.from('ap_invoice_lines')
    .select('gl_account_id, amount_cents, tax_amount_cents').eq('invoice_id', invoice.id);
  if (lnErr) throw lnErr;
  if (!lineRows || !lineRows.length) throw Object.assign(new Error('invoice_has_no_lines'), { code: 'invalid_state' });
  if (lineRows.some((l) => !l.gl_account_id)) throw Object.assign(new Error('invoice_not_coded_code_before_prepay'), { code: 'invalid_state' });

  const expMap = new Map();
  let expSum = 0;
  for (const l of lineRows) {
    const a = Number(l.amount_cents || 0) + Number(l.tax_amount_cents || 0);
    expMap.set(l.gl_account_id, (expMap.get(l.gl_account_id) || 0) + a);
    expSum += a;
  }
  // Fold any tax/rounding remainder into the largest expense account so the
  // reversal ties to the amount paid (same reconcile ap_engine does on accrual).
  if (expSum !== amt && expMap.size) {
    let bigA = null, bigV = -Infinity;
    for (const [k, v] of expMap.entries()) { if (v > bigV) { bigV = v; bigA = k; } }
    expMap.set(bigA, expMap.get(bigA) + (amt - expSum));
  }

  const prepaid = await _resolveAccount(supabase, community_id, ['13000', '1400', '1450'], '%prepaid%');
  if (!prepaid) throw Object.assign(new Error('prepaid_account_not_found'), { code: 'invalid_state' });
  const ap = await _resolveAccount(supabase, community_id, ['20100', '2000'], '%accounts payable%');
  if (!ap) throw Object.assign(new Error('ap_account_not_found'), { code: 'invalid_state' });
  let cashId = null;
  if (bankAccountId) {
    const { data: ba } = await supabase.from('bank_accounts').select('gl_account_number').eq('id', bankAccountId).maybeSingle();
    if (ba && ba.gl_account_number) { const c = await _resolveAccount(supabase, community_id, [ba.gl_account_number], null); cashId = c && c.id; }
  }
  if (!cashId) { const c = await _resolveAccount(supabase, community_id, ['10100', '1000'], '%operating%'); cashId = c && c.id; }
  if (!cashId) throw Object.assign(new Error('cash_account_not_found'), { code: 'invalid_state' });

  const invMonthFirst = firstOfMonth(invoice_date);

  // 0) A normal accrual (Dr Expense / Cr AP) may already sit in the invoice
  //    month if that period was open at intake. Void it ON its own posting date
  //    so it nets to zero in that month with no residue, then replace it with
  //    the prepaid structure below.
  let voidedAccrual = null;
  if (invoice.posting_journal_entry_id) {
    const { data: acc } = await supabase.from('journal_entries').select('posting_date').eq('id', invoice.posting_journal_entry_id).maybeSingle();
    const r = await voidJE({
      journal_entry_id: invoice.posting_journal_entry_id,
      void_reason: `Replaced by early-payment prepaid (paid ${paymentDate})`,
      reversal_date: (acc && acc.posting_date) || invoice_date,
      posted_by_user_id: postedByUserId,
    });
    voidedAccrual = (r && r.reversal_entry && r.reversal_entry.id) || true;
  }

  // 1) Pay month: Dr Prepaid / Cr AP — book the payable as a prepaid asset.
  const jeA = await postJE({
    community_id, posting_date: paymentDate,
    description: `Prepaid — early payment of ${invoice.vendor_invoice_number || 'invoice'} (service ${invoice_date})`,
    source_module: 'ap_invoice', source_reference: invoice.id, posted_by_user_id: postedByUserId,
    lines: [
      { account_id: prepaid.id, debit_cents: amt, credit_cents: 0, memo: `Prepaid ${invoice.vendor_invoice_number || ''}`.trim(), vendor_id: invoice.vendor_id },
      { account_id: ap.id, debit_cents: 0, credit_cents: amt, memo: `AP — ${invoice.vendor_invoice_number || ''}`.trim(), vendor_id: invoice.vendor_id },
    ],
  });

  // 2) Pay month: Dr AP / Cr Cash — the check clears the payable (AP nets to 0).
  const jeB = await postJE({
    community_id, posting_date: paymentDate,
    description: `AP payment ${method}${checkNumber ? ' #' + checkNumber : ''} — ${invoice.vendor_invoice_number || 'invoice'} (early)`,
    source_module: 'payment_intake', source_reference: checkNumber || null, posted_by_user_id: postedByUserId,
    lines: [
      { account_id: ap.id, debit_cents: amt, credit_cents: 0, memo: 'AP payment (early)', vendor_id: invoice.vendor_id },
      { account_id: cashId, debit_cents: 0, credit_cents: amt, memo: 'Cash disbursement (early)', vendor_id: invoice.vendor_id, bank_account_id: bankAccountId || null },
    ],
  });

  // 3) Invoice month: Dr Expense / Cr Prepaid — reverse the prepaid into expense.
  const revLines = [];
  for (const [acct, a] of expMap.entries()) {
    revLines.push({ account_id: acct, debit_cents: a, credit_cents: 0, memo: `${invoice.vendor_invoice_number || ''} expense (prepaid recognized)`.trim() });
  }
  revLines.push({ account_id: prepaid.id, debit_cents: 0, credit_cents: amt, memo: 'Prepaid drawdown' });
  const reversalJeId = await postReversal({
    community_id, posting_date: invMonthFirst,
    description: `Recognize prepaid expense — ${invoice.vendor_invoice_number || 'invoice'} (${ymOf(invoice_date)})`,
    lines: revLines, invoiceId: invoice.id,
  });

  // Record the payment + mark the invoice paid.
  const { data: payment, error: payErr } = await supabase.from('ap_payments').insert({
    community_id, vendor_id: invoice.vendor_id, payment_date: paymentDate, amount_cents: amt,
    payment_method: method, check_number: checkNumber || null, bank_account_id: bankAccountId || null,
    posting_journal_entry_id: jeB.entry.id, status: 'completed',
    notes: `Early prepayment before invoice date ${invoice_date} — booked to prepaid ${prepaid.account_number}, reverses to expense ${ymOf(invoice_date)}`,
    created_by_user_id: postedByUserId || null,
  }).select('*').single();
  if (payErr) throw payErr;

  await supabase.from('ap_payment_applications').insert({ payment_id: payment.id, invoice_id: invoice.id, applied_cents: amt });
  await supabase.from('ap_invoices').update({
    amount_paid_cents: Number(invoice.amount_paid_cents || 0) + amt,
    status: 'paid', paid_at: new Date().toISOString(),
    posting_journal_entry_id: jeA.entry.id,     // the prepaid accrual is now the invoice's posting entry
  }).eq('id', invoice.id);

  return {
    prepaid: true,
    prepaid_je_id: jeA.entry.id,
    payment_je_id: jeB.entry.id,
    reversal_je_id: reversalJeId,
    voided_accrual: voidedAccrual,
    payment_id: payment.id,
    prepaid_account: prepaid.account_number,
    pay_month: ymOf(paymentDate),
    reverses_month: ymOf(invoice_date),
  };
}

module.exports = { payInvoiceEarlyAsPrepaid, isEarlyCrossPeriod };
