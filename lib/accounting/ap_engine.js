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
// Delegates to gl_classifier — the ONE coding brain. (Ed 2026-07-15.)
//
// This function used to be a second, parallel classifier: vendor default, then
// vendor.category and a keyword table that both resolved through hardcoded
// 5-digit account numbers ('50900' pool, '51100' security, '50800' landscape...).
// Not one of those 13 numbers exists on ANY of the 8 communities' charts — they
// are numbered 5300/5370/5010. So signals 2 and 3 could never hit: every keyword
// match looked up an account that wasn't there, fell through, and returned
// 'no_match'. The function has been shipping uncoded bills its whole life, and
// because an uncoded bill has no journal entry, NOBODY could approve them —
// which is why 6 of 8 bills sat in the queue with no approval buttons and Ed
// couldn't find the manager review button.
//
// gl_classifier already does all of this, better and community-agnostically:
// vendor default -> vendor HISTORY on this community's own books (amount-aware)
// -> description matched against the REAL account names on the REAL chart. Two
// brains for one question is the silo pattern Ed has banned; the copy that
// drifts is the one that silently returns nothing. This is now a thin adapter.
async function autoCodeGlAccount({ community_id, vendor_id, line_description, vendor_name = null, total_cents = null }) {
  if (!community_id) return { gl_account_id: null, confidence: 'low', signal: 'no_community' };
  try {
    const { suggestClassification } = require('./gl_classifier');
    const r = await suggestClassification({
      communityId: community_id, vendorId: vendor_id || null, vendorName: vendor_name,
      description: line_description || vendor_name || null,
      totalCents: Number.isFinite(Number(total_cents)) ? Number(total_cents) : null,
    });
    if (r && r.account_id) {
      return {
        gl_account_id: r.account_id, confidence: r.confidence || 'low',
        signal: 'gl_classifier', reason: r.reason || null, needs_review: !!r.needs_review,
      };
    }
    return { gl_account_id: null, confidence: 'low', signal: 'no_match', reason: (r && r.reason) || null };
  } catch (e) {
    console.error('[ap_engine] autoCodeGlAccount delegate failed:', e.message);
    return { gl_account_id: null, confidence: 'low', signal: 'no_match' };
  }
}


// ---------------------------------------------------------------------------
// createInvoice — full intake flow with auto-coding + auto-post JE
// ---------------------------------------------------------------------------
async function createInvoice(opts) {
  const {
    community_id, vendor_id,
    vendor_invoice_number, invoice_date, due_date, terms,
    tax_cents,
    source_document_id, source_filename,
    lines,                                  // [{description, quantity, unit_price_cents, amount_cents, gl_account_id?, tax_amount_cents?, is_taxable?}]
    notes, posted_by_user_id,
  } = opts;
  // Mutable: a per-vendor convenience fee (below) bumps these before posting.
  let { subtotal_cents, total_cents } = opts;

  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!vendor_id) throw Object.assign(new Error('vendor_id_required'), { code: 'invalid_input' });
  if (!invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(invoice_date)) throw Object.assign(new Error('invoice_date_required'), { code: 'invalid_input' });
  if (!total_cents || total_cents <= 0) throw Object.assign(new Error('total_cents_must_be_positive'), { code: 'invalid_input' });
  if (!Array.isArray(lines) || lines.length === 0) throw Object.assign(new Error('at_least_one_line_required'), { code: 'invalid_input' });

  // Per-vendor convenience fee (MUD water districts: $1/invoice). Same helper the
  // email intake uses, so an uploaded MUD bill gets the fee identically. Mutates
  // the local total/subtotal/lines before coding + posting. (Ed 2026-07-23.)
  let _convenienceFeeCents = 0;
  try {
    const { getVendorConvenienceFee, applyConvenienceFee } = require('../ap/convenience_fee');
    const fee = await getVendorConvenienceFee(supabase, vendor_id);
    if (fee.cents > 0) {
      const box = { total_cents, subtotal_cents, lines };
      applyConvenienceFee(box, fee, 'lines');
      total_cents = box.total_cents;
      subtotal_cents = box.subtotal_cents;
      _convenienceFeeCents = fee.cents;
    }
  } catch (e) { console.warn('[ap_engine] convenience fee skipped:', e.message); }

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
        // The amount decides WHICH of this vendor's jobs the line looks like when
        // they're coded to more than one account (the Swim Houston splash-pad
        // scar). Per LINE, not the invoice total — a 2-line bill can legitimately
        // split across two accounts.
        total_cents: ln.amount_cents ?? ln.total_cents ?? null,
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
// attachSourceAndRecode — attach a source PDF's extracted lines to an EXISTING
// invoice and (re)code + post.
// ---------------------------------------------------------------------------
// Use case (Ed 2026-07-23): a bill arrives by email where the PDF sat behind a
// "click to download" link, so intake created the invoice HEADER (vendor, total)
// but never got the attachment — the invoice has no line items and can't be
// coded/posted. Staff now upload the PDF to the existing bill and re-run,
// instead of creating a duplicate.
//
// SAFETY: this only ever runs on a bill that has NOT posted its accrual yet
// (posting_journal_entry_id IS NULL). If a bill is already posted, replacing its
// lines would silently diverge the ledger from the invoice; the caller must use
// the recode flow (which reverses the old JE) instead. We refuse here.
async function attachSourceAndRecode(opts) {
  const { invoice_id, lines, source_document_id, source_filename, source_storage_path, posted_by_user_id } = opts;
  if (!invoice_id) throw Object.assign(new Error('invoice_id_required'), { code: 'invalid_input' });
  if (!Array.isArray(lines) || lines.length === 0) throw Object.assign(new Error('at_least_one_line_required'), { code: 'invalid_input' });

  const { data: inv, error: invErr } = await supabase.from('ap_invoices').select('*').eq('id', invoice_id).maybeSingle();
  if (invErr) throw invErr;
  if (!inv) throw Object.assign(new Error('invoice_not_found'), { code: 'not_found' });
  if (inv.status === 'voided') throw Object.assign(new Error('invoice_voided'), { code: 'invalid_state' });
  if (inv.posting_journal_entry_id) {
    // Already on the books — replacing lines here would desync the ledger.
    throw Object.assign(new Error('invoice_already_posted'), { code: 'invalid_state' });
  }

  const community_id = inv.community_id;
  const vendor_id = inv.vendor_id;

  // Per-line auto-coding — identical logic to createInvoice so behavior can't
  // drift between the two intake paths.
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
        total_cents: ln.amount_cents ?? ln.total_cents ?? null,
      });
      gl_account_id = coded.gl_account_id;
      lineConfidence = coded.confidence;
      lineSignal = coded.signal;
      if (!gl_account_id) allCoded = false;
      if (lineConfidence === 'low' || highestConfidence === 'low') highestConfidence = 'low';
      else if (lineConfidence === 'medium' && highestConfidence !== 'low') highestConfidence = 'medium';
      if (!codingSignal) codingSignal = lineSignal;
    }
    codedLines.push({ ...ln, gl_account_id, line_number: i + 1, _confidence: lineConfidence, _signal: lineSignal });
  }

  // Post the accrual JE only if every line coded AND the lines reconcile to the
  // invoice total the header already carries. A mismatch means the extraction
  // read the PDF differently than the amount we already owe — never post a JE
  // for a different number than the bill; attach the lines and flag for review.
  const lineSum = codedLines.reduce((s, ln) => s + Number(ln.amount_cents || 0) + Number(ln.tax_amount_cents || 0), 0);
  const totalMismatch = lineSum !== Number(inv.total_cents || 0);
  let postingJeId = null;
  let postWarning = null;
  if (allCoded && !totalMismatch) {
    try {
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

      const debitMap = new Map();
      for (const ln of codedLines) {
        const amt = Number(ln.amount_cents || 0) + Number(ln.tax_amount_cents || 0);
        debitMap.set(ln.gl_account_id, (debitMap.get(ln.gl_account_id) || 0) + amt);
      }
      const jeLines = [];
      for (const [acct, amt] of debitMap.entries()) {
        jeLines.push({ account_id: acct, debit_cents: amt, credit_cents: 0, memo: `Invoice ${inv.vendor_invoice_number || ''}`.trim(), vendor_id });
      }
      jeLines.push({ account_id: apAccount.id, debit_cents: 0, credit_cents: inv.total_cents, memo: `AP — invoice ${inv.vendor_invoice_number || ''}`.trim(), vendor_id });

      const je = await postJournalEntry({
        community_id,
        posting_date: inv.invoice_date,
        description: `AP invoice ${inv.vendor_invoice_number || ''} — ${(inv.vendor_name || 'vendor')}`.trim(),
        source_module: 'manual',
        source_reference: source_filename || inv.source_filename || null,
        posted_by_user_id,
        lines: jeLines,
      });
      postingJeId = je.entry.id;
    } catch (e) {
      // Never let a posting failure lose the attach work — the PDF + lines still
      // get saved; the bill just stays uncoded for manual finish.
      console.error('[ap_engine] attachSourceAndRecode JE post failed:', e.message);
      postWarning = 'lines_attached_but_not_posted';
    }
  } else if (totalMismatch) {
    postWarning = 'line_total_mismatch';
  }

  // Replace the invoice's lines with the freshly extracted ones.
  await supabase.from('ap_invoice_lines').delete().eq('invoice_id', invoice_id);
  const lineRows = codedLines.map((ln) => ({
    invoice_id,
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

  const { data: updated, error: updErr } = await supabase.from('ap_invoices').update({
    source_document_id: source_document_id || inv.source_document_id || null,
    source_filename: source_filename || inv.source_filename || null,
    // The "View original PDF" link reads source_storage_path — set it so the
    // attached PDF is actually viewable, not just retained.
    source_storage_path: source_storage_path || inv.source_storage_path || null,
    auto_coded: allCoded && !totalMismatch,
    auto_coding_confidence: (allCoded && !totalMismatch) ? highestConfidence : 'low',
    auto_coding_signal: codingSignal,
    posting_journal_entry_id: postingJeId,
    updated_at: new Date().toISOString(),
  }).eq('id', invoice_id).select('*').single();
  if (updErr) throw updErr;

  await supabase.from('ap_invoice_approvals').insert({
    invoice_id,
    action: 'submitted',
    user_id: posted_by_user_id || null,
    amount_at_time_cents: inv.total_cents,
    notes: postingJeId
      ? `Source PDF attached; re-extracted ${lineRows.length} line(s), auto-coded ${highestConfidence} and posted`
      : (totalMismatch
        ? `Source PDF attached; extracted lines sum to ${(lineSum / 100).toFixed(2)} but bill total is ${(Number(inv.total_cents || 0) / 100).toFixed(2)} — needs review`
        : `Source PDF attached; ${lineRows.length} line(s) extracted, GL coding still needed`),
  });

  return {
    invoice: updated,
    lines: insertedLines,
    auto_coded: allCoded && !totalMismatch,
    coding_confidence: highestConfidence,
    posting_journal_entry_id: postingJeId,
    line_sum_cents: lineSum,
    total_mismatch: totalMismatch,
    warning: postWarning,
  };
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

module.exports = { autoCodeGlAccount, createInvoice, attachSourceAndRecode, approveInvoice, recordPayment };
