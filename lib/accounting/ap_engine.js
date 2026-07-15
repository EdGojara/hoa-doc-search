// ============================================================================
// lib/accounting/ap_engine.js — Accounts Payable engine
// ----------------------------------------------------------------------------
// Four public functions that drive the AP workflow:
//
//   autoCodeGlAccount({community_id, vendor_id, line_description})
//     → multi-signal classifier returns {gl_account_id, confidence, signal}
//       Signals: vendor.default_gl_account_id, vendor.category mapped to
//       standard expense account, line description NLP (Phase 2).
//
//   createInvoice({community_id, vendor_id, ...invoice fields..., lines, posted_by_user_id})
//     → auto-codes each line if no gl_account_id given, sums totals,
//       posts JE (Dr Expense accounts / Cr AP), creates ap_invoices row +
//       ap_invoice_lines rows. Returns full record.
//
//   approveInvoice({invoice_id, user_id, notes})
//     → status awaiting_approval → approved, logs to ap_invoice_approvals
//
//   recordPayment({community_id, vendor_id, amount_cents, payment_date,
//                  payment_method, check_number, bank_account_id,
//                  applications: [{invoice_id, applied_cents}],
//                  posted_by_user_id})
//     → posts JE (Dr AP / Cr Cash), creates ap_payments row +
//       ap_payment_applications rows, updates ap_invoices.amount_paid +
//       status. For check printing flow, check_number gets passed in
//       from the check sequencer.
//
// All JEs go through lib/accounting/posting.js so double-entry constraint
// enforced at DB level.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const { postJournalEntry } = require('./posting');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Category → standard expense account number mapping.
// Used by autoCodeGlAccount when vendor has category set but no
// default_gl_account_id pinned. Matches the coa_template.js seeded numbers.
const CATEGORY_TO_GL_NUMBER = {
  landscaping: '50800',
  pool: '50900',
  janitorial: '51000',
  security: '51100',
  utilities_electric: '50700',
  utilities_water: '50710',
  utilities_gas: '50720',
  utilities_trash: '50730',
  insurance: '50600',
  insurance_property: '50600',
  insurance_d_and_o: '50610',
  insurance_workers_comp: '50620',
  management: '50100',
  legal: '50300',
  legal_collections: '50310',
  audit_tax: '50200',
  repairs: '51200',
  repairs_amenities: '51210',
  fencing: '51220',
  supplies: '50400',
  postage: '50410',
  bank_fees: '50500',
  reserve_roofing: '60100',
  reserve_painting: '60110',
  reserve_paving: '60120',
  reserve_pool: '60130',
  reserve_hvac: '60140',
  reserve_fencing: '60150',
  reserve_amenities: '60160',
  reserve_study: '60170',
  other: '51999',
};

// Lookup helper — find a CoA account by number for a community
async function findAccountByNumber(community_id, account_number) {
  const { data } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number, account_name, is_summary, is_active')
    .eq('community_id', community_id)
    .eq('account_number', account_number)
    .maybeSingle();
  return data;
}

// ---------------------------------------------------------------------------
// autoCodeGlAccount — multi-signal GL classifier
// ---------------------------------------------------------------------------
async function autoCodeGlAccount({ community_id, vendor_id, line_description }) {
  if (!community_id) return { gl_account_id: null, confidence: 'low', signal: 'no_community' };

  // Signal 1: vendor's default_gl_account_id (highest confidence)
  if (vendor_id) {
    const { data: vendor } = await supabase
      .from('vendors')
      .select('default_gl_account_id, category')
      .eq('id', vendor_id)
      .maybeSingle();

    if (vendor?.default_gl_account_id) {
      return { gl_account_id: vendor.default_gl_account_id, confidence: 'high', signal: 'vendor_default' };
    }

    // Signal 2: vendor.category mapped to standard expense account
    if (vendor?.category) {
      const acctNumber = CATEGORY_TO_GL_NUMBER[vendor.category];
      if (acctNumber) {
        const acct = await findAccountByNumber(community_id, acctNumber);
        if (acct && acct.is_active && !acct.is_summary) {
          return { gl_account_id: acct.id, confidence: 'medium', signal: 'vendor_category' };
        }
      }
    }
  }

  // Signal 3: line description NLP (Phase 2 — for now, keyword fallback)
  if (line_description) {
    const desc = line_description.toLowerCase();
    const KEYWORD_HITS = [
      [/\b(landscap|grounds|lawn|mowing|fertiliz|irrigat)/i, '50800'],
      [/\b(pool|aquatic|spa)/i, '50900'],
      [/\b(janitorial|cleaning|custodial)/i, '51000'],
      [/\b(security|patrol|gate|fob)/i, '51100'],
      [/\b(electric|electricity)/i, '50700'],
      [/\b(water|sewer)/i, '50710'],
      [/\b(gas\s+util)/i, '50720'],
      [/\b(trash|garbage|recycl)/i, '50730'],
      [/\b(insurance|premium)/i, '50600'],
      [/\b(audit|tax\s+prep|accounting\s+services)/i, '50200'],
      [/\b(legal|attorney|law\s+firm)/i, '50300'],
      [/\b(management\s+fee)/i, '50100'],
      [/\b(supplies|office)/i, '50400'],
      [/\b(postage|mail)/i, '50410'],
      [/\b(repair|maintenance)/i, '51200'],
    ];
    for (const [re, num] of KEYWORD_HITS) {
      if (re.test(desc)) {
        const acct = await findAccountByNumber(community_id, num);
        if (acct && acct.is_active && !acct.is_summary) {
          return { gl_account_id: acct.id, confidence: 'medium', signal: 'description_keyword' };
        }
      }
    }
  }

  // No match — falls through to operator pick.
  return { gl_account_id: null, confidence: 'low', signal: 'no_match' };
}

// ---------------------------------------------------------------------------
// createInvoice — full intake flow with auto-coding + auto-post JE
// ---------------------------------------------------------------------------
async function createInvoice(opts) {
  const {
    community_id, vendor_id,
    vendor_invoice_number, invoice_date, due_date, terms,
    subtotal_cents, tax_cents, total_cents,
    source_document_id, source_filename,
    lines,                                  // [{description, quantity, unit_price_cents, amount_cents, gl_account_id?, tax_amount_cents?, is_taxable?}]
    notes, posted_by_user_id,
  } = opts;

  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!vendor_id) throw Object.assign(new Error('vendor_id_required'), { code: 'invalid_input' });
  if (!invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(invoice_date)) throw Object.assign(new Error('invoice_date_required'), { code: 'invalid_input' });
  if (!total_cents || total_cents <= 0) throw Object.assign(new Error('total_cents_must_be_positive'), { code: 'invalid_input' });
  if (!Array.isArray(lines) || lines.length === 0) throw Object.assign(new Error('at_least_one_line_required'), { code: 'invalid_input' });

  // Auto-code each line that doesn't already have gl_account_id
  let highestConfidence = 'high';
  let allCoded = true;
  let codingSignal = null;
  const codedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.amount_cents && ln.amount_cents !== 0) throw Object.assign(new Error(`line_${i + 1}_amount_required`), { code: 'invalid_input' });
    if (!ln.description) throw Object.assign(new Error(`line_${i + 1}_description_required`), { code: 'invalid_input' });

    let gl_account_id = ln.gl_account_id;
    let lineConfidence = 'manual';
    let lineSignal = ln.gl_account_id ? 'operator_provided' : null;

    if (!gl_account_id) {
      const coded = await autoCodeGlAccount({
        community_id, vendor_id, line_description: ln.description,
      });
      gl_account_id = coded.gl_account_id;
      lineConfidence = coded.confidence;
      lineSignal = coded.signal;
      if (!gl_account_id) allCoded = false;
      // Track overall confidence as lowest of any line
      if (lineConfidence === 'low' || highestConfidence === 'low') highestConfidence = 'low';
      else if (lineConfidence === 'medium' && highestConfidence !== 'low') highestConfidence = 'medium';
      if (!codingSignal) codingSignal = lineSignal;
    }

    codedLines.push({
      ...ln,
      gl_account_id,
      line_number: i + 1,
      _confidence: lineConfidence,
      _signal: lineSignal,
    });
  }

  // Find the AP account — the standard CoA uses 20100; Vantaca-migrated
  // communities (e.g. Quail Ridge) use 2000. Fall back to a name match so any
  // chart of accounts works.
  let apAccount = await findAccountByNumber(community_id, '20100')
    || await findAccountByNumber(community_id, '2000');
  if (!apAccount) {
    const { data } = await supabase.from('chart_of_accounts')
      .select('id, account_number, account_name')
      .eq('community_id', community_id).ilike('account_name', '%accounts payable%')
      .eq('is_active', true).limit(1).maybeSingle();
    apAccount = data;
  }
  if (!apAccount) throw Object.assign(new Error('ap_account_not_found'), { code: 'invalid_state' });

  // Build the JE — debits are the per-line expense accounts; credit is AP for total
  // If a line has no gl_account_id (low confidence), JE can't post yet — we
  // leave the invoice in 'awaiting_approval' with NULL posting_journal_entry_id
  // and require operator to set GL coding before approval+payment.
  let postingJeId = null;
  if (allCoded) {
    const jeLines = [];
    // Aggregate debits per gl_account_id so we don't create duplicate lines
    // when multiple invoice lines hit the same expense account.
    const debitMap = new Map();
    for (const ln of codedLines) {
      const acct = ln.gl_account_id;
      const amt = Number(ln.amount_cents || 0) + Number(ln.tax_amount_cents || 0);
      debitMap.set(acct, (debitMap.get(acct) || 0) + amt);
    }
    for (const [acct, amt] of debitMap.entries()) {
      jeLines.push({ account_id: acct, debit_cents: amt, credit_cents: 0,
        memo: `Invoice ${vendor_invoice_number || ''}`.trim(), vendor_id });
    }
    jeLines.push({ account_id: apAccount.id, debit_cents: 0, credit_cents: total_cents,
      memo: `AP — invoice ${vendor_invoice_number || ''}`.trim(), vendor_id });

    const je = await postJournalEntry({
      community_id,
      posting_date: invoice_date,
      description: `AP invoice ${vendor_invoice_number || ''} — ${(opts.vendor_name || 'vendor')}`.trim(),
      source_module: 'manual',
      source_reference: source_filename || null,
      posted_by_user_id,
      lines: jeLines,
    });
    postingJeId = je.entry.id;
  }

  // Insert ap_invoices row
  const { data: invoice, error: invErr } = await supabase
    .from('ap_invoices')
    .insert({
      community_id, vendor_id,
      vendor_invoice_number: vendor_invoice_number || null,
      invoice_date,
      due_date: due_date || null,
      terms: terms || null,
      subtotal_cents: subtotal_cents ?? 0,
      tax_cents: tax_cents ?? 0,
      total_cents,
      amount_paid_cents: 0,
      source_document_id: source_document_id || null,
      source_filename: source_filename || null,
      auto_coded: allCoded,
      auto_coding_confidence: allCoded ? highestConfidence : 'low',
      auto_coding_signal: codingSignal,
      status: 'awaiting_approval',
      posting_journal_entry_id: postingJeId,
      received_by_user_id: posted_by_user_id || null,
      notes: notes || null,
    })
    .select('*')
    .single();
  if (invErr) throw invErr;

  // Insert line items
  const lineRows = codedLines.map((ln) => ({
    invoice_id: invoice.id,
    line_number: ln.line_number,
    description: ln.description,
    quantity: ln.quantity ?? 1,
    unit_price_cents: ln.unit_price_cents ?? null,
    amount_cents: ln.amount_cents,
    gl_account_id: ln.gl_account_id || null,
    tax_amount_cents: ln.tax_amount_cents ?? 0,
    is_taxable: !!ln.is_taxable,
  }));
  const { data: insertedLines, error: lnErr } = await supabase
    .from('ap_invoice_lines').insert(lineRows).select('*');
  if (lnErr) throw lnErr;

  // Log the submission
  await supabase.from('ap_invoice_approvals').insert({
    invoice_id: invoice.id,
    action: 'submitted',
    user_id: posted_by_user_id || null,
    amount_at_time_cents: total_cents,
    notes: allCoded
      ? `Auto-coded ${highestConfidence} confidence (${codingSignal})`
      : 'Submitted — manual GL coding needed before approval',
  });

  return { invoice, lines: insertedLines, posting_journal_entry_id: postingJeId, auto_coded: allCoded, coding_confidence: highestConfidence };
}

// ---------------------------------------------------------------------------
// approveInvoice
// ---------------------------------------------------------------------------
// `action` labels WHICH key turned in the two-key control: a manager's
// 'approved' attests the bill is legitimate; the admin's 'released_for_payment'
// is what actually frees the money. Defaults to 'approved' for legacy callers.
async function approveInvoice({ invoice_id, user_id, user_name, notes, action = 'approved' }) {
  if (!invoice_id) throw Object.assign(new Error('invoice_id_required'), { code: 'invalid_input' });
  const { data: inv } = await supabase.from('ap_invoices').select('*').eq('id', invoice_id).maybeSingle();
  if (!inv) throw Object.assign(new Error('invoice_not_found'), { code: 'not_found' });
  if (inv.status === 'voided') throw Object.assign(new Error('invoice_voided'), { code: 'invalid_state' });
  if (!inv.posting_journal_entry_id) {
    throw Object.assign(new Error('invoice_not_gl_coded_cannot_approve'), { code: 'invalid_state' });
  }
  if (inv.status === 'approved' || inv.status === 'paid' || inv.status === 'partially_paid') {
    return { invoice: inv, already: true };
  }

  const { data: updated, error } = await supabase.from('ap_invoices').update({
    status: 'approved',
    approved_at: new Date().toISOString(),
    approved_by_user_id: user_id || null,
  }).eq('id', invoice_id).select('*').single();
  if (error) throw error;

  await supabase.from('ap_invoice_approvals').insert({
    invoice_id, action,
    user_id: user_id || null, user_name: user_name || null,
    amount_at_time_cents: inv.total_cents,
    notes: notes || null,
  });
  return { invoice: updated };
}

// ---------------------------------------------------------------------------
// recordPayment — pay one or more invoices with a single payment instrument
// ---------------------------------------------------------------------------
async function recordPayment(opts) {
  const {
    community_id, vendor_id, amount_cents, payment_date,
    payment_method = 'check', check_number, bank_account_id,
    applications,           // [{invoice_id, applied_cents}]
    notes, posted_by_user_id,
  } = opts;

  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!vendor_id) throw Object.assign(new Error('vendor_id_required'), { code: 'invalid_input' });
  if (!amount_cents || amount_cents <= 0) throw Object.assign(new Error('amount_cents_must_be_positive'), { code: 'invalid_input' });
  if (!Array.isArray(applications) || applications.length === 0) throw Object.assign(new Error('applications_required'), { code: 'invalid_input' });
  const sumApplied = applications.reduce((s, a) => s + Number(a.applied_cents || 0), 0);
  if (sumApplied !== amount_cents) throw Object.assign(new Error(`applied_sum_${sumApplied}_must_equal_payment_${amount_cents}`), { code: 'invalid_input' });

  // Resolve Cash GL account: look up bank_account → its bank → GL number
  let cashAccountId;
  if (bank_account_id) {
    const { data: ba } = await supabase.from('bank_accounts')
      .select('gl_account_number').eq('id', bank_account_id).maybeSingle();
    if (ba?.gl_account_number) {
      const acct = await findAccountByNumber(community_id, ba.gl_account_number);
      cashAccountId = acct?.id;
    }
  }
  if (!cashAccountId) {
    // Operating Cash — try both chart numberings (GL-migrated communities use
    // 1000; the C3-style seed uses 10100). Mirrors lib/ap/intake.js. (Ed 2026-07-14.)
    for (const num of ['10100', '1000']) { const acct = await findAccountByNumber(community_id, num); if (acct) { cashAccountId = acct.id; break; } }
  }
  if (!cashAccountId) throw Object.assign(new Error('cash_account_not_found'), { code: 'invalid_state' });

  let apAccount = null;                                   // Accounts Payable — both numberings
  for (const num of ['20100', '2000']) { apAccount = await findAccountByNumber(community_id, num); if (apAccount) break; }
  if (!apAccount) throw Object.assign(new Error('ap_account_not_found'), { code: 'invalid_state' });

  // Post JE: Dr AP / Cr Cash
  const je = await postJournalEntry({
    community_id,
    posting_date: payment_date,
    description: `AP payment ${payment_method}${check_number ? ' #' + check_number : ''}`,
    source_module: 'payment_intake',
    source_reference: check_number || null,
    posted_by_user_id,
    lines: [
      { account_id: apAccount.id, debit_cents: amount_cents, credit_cents: 0, memo: 'AP payment', vendor_id },
      { account_id: cashAccountId, debit_cents: 0, credit_cents: amount_cents, memo: 'Cash disbursement', vendor_id, bank_account_id },
    ],
  });

  // Create payment row
  const { data: payment, error: payErr } = await supabase.from('ap_payments').insert({
    community_id, vendor_id, payment_date, amount_cents, payment_method,
    check_number: check_number || null,
    bank_account_id: bank_account_id || null,
    posting_journal_entry_id: je.entry.id,
    status: 'completed',
    notes: notes || null,
    created_by_user_id: posted_by_user_id || null,
  }).select('*').single();
  if (payErr) throw payErr;

  // Insert application rows + update each invoice's amount_paid + status
  for (const app of applications) {
    await supabase.from('ap_payment_applications').insert({
      payment_id: payment.id,
      invoice_id: app.invoice_id,
      applied_cents: app.applied_cents,
    });
    // Update the invoice's amount_paid and status
    const { data: inv } = await supabase.from('ap_invoices').select('total_cents, amount_paid_cents').eq('id', app.invoice_id).maybeSingle();
    if (inv) {
      const newPaid = (inv.amount_paid_cents || 0) + app.applied_cents;
      const newStatus = newPaid >= inv.total_cents ? 'paid' : 'partially_paid';
      const patch = { amount_paid_cents: newPaid, status: newStatus };
      if (newStatus === 'paid') patch.paid_at = new Date().toISOString();
      await supabase.from('ap_invoices').update(patch).eq('id', app.invoice_id);
    }
  }

  return { payment, applications };
}

module.exports = { autoCodeGlAccount, createInvoice, approveInvoice, recordPayment };
