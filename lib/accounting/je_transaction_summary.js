// ============================================================================
// lib/accounting/je_transaction_summary.js  (Ed 2026-09-28)
// ----------------------------------------------------------------------------
// "What actually happened?" for one journal entry, read-first, before the
// debit/credit lines and the edit form. READ-ONLY. Nothing is invented: every
// fact comes from an existing record and carries its source ("ap_payments.
// payment_method"), and what the data can't answer is listed in `gaps`.
//
// How an entry is traced to the real-world record (existing links only):
//   * AP payment      ap_payments.posting_journal_entry_id = JE -> vendor,
//                     method, check #, bank account, date, amount; its
//                     ap_payment_applications -> the bill(s) paid, each bill's
//                     number/date/document/expense lines; check_register row.
//   * AP bill         ap_invoices.posting_journal_entry_id = JE (or the JE's
//                     source_reference) -> vendor, invoice #, dates, lines and
//                     GL accounts, approvals, document, payments applied.
//   * Check           check_register.posting_journal_entry_id = JE.
//   * Homeowner       ar_payments / ar_charges.posting_journal_entry_id = JE ->
//     payment/charge  property address.
//   * Reversal        journal_entries.reverses_je_id -> the entry it reverses.
//   * Voided entry    journal_entries.void_reversal_je_id -> its reversal.
//   * Fallback        the lines' own vendor_id / property_id tags.
// ============================================================================

const money = (c) => (c == null ? null : (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const METHOD_LABEL = { ach: 'ACH', check: 'Check', wire: 'Wire', credit_card: 'Credit card', cash: 'Cash', other: 'Other' };
const ORIGIN_LABEL = {
  ap_invoice: 'Vendor bill (Payables)', payment_intake: 'Payment recorded', reversal: 'Reversal / void',
  manual: 'Manual journal entry', vantaca_import: 'Migrated from Vantaca GL detail', opening_entry: 'Opening balances (conversion)',
  closing_entry: 'Year-end closing entry', system: 'System-generated', certified_letter_fee: 'Certified letter fee charged',
  assessment_billing: 'Assessment billing', recognition: 'Scheduled recognition (prepaid/deferred)', ap_billback: 'Legal bill-back to homeowner',
};

async function one(q) { const { data, error } = await q; if (error) throw error; return data || null; }
async function many(q) { const { data, error } = await q; if (error) throw error; return data || []; }
// A table/column that doesn't exist here (older schema) is "no link", not an error.
async function tryMany(q) { const { data, error } = await q; if (error) { if (/does not exist|schema cache/i.test(error.message || '')) return []; throw error; } return data || []; }

function docLink(d) {
  if (!d) return null;
  if (d.source_document_id) return `/api/documents/${encodeURIComponent(d.source_document_id)}/preview`;
  const path = d.source_storage_path || d.source_document_path;
  return path ? `/api/homeowner/file?kind=document&path=${encodeURIComponent(path)}` : null;
}

async function accountNames(supabase, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await many(supabase.from('chart_of_accounts').select('id, account_number, account_name').in('id', uniq));
  return new Map(rows.map((a) => [a.id, `${a.account_number} ${a.account_name}`]));
}

const REF_GAP = {
  ach: 'No ACH reference number is recorded.', wire: 'No wire reference number is recorded.',
  check: 'No check number is recorded.', credit_card: 'No card transaction reference is recorded.',
};

// Which cash/bank account a payment came out of, WITHOUT guessing. In order:
//   1. a line explicitly tagged with a bank account (journal_entry_lines.bank_account_id);
//   2. credited accounts that are a bank's GL account (bank_accounts.gl_account_number
//      in this community) or are explicitly classified cash (account_subtype 'cash');
//      used only when exactly ONE such account is credited.
// Anything else (no candidate, or several) is "can't determine", never the first
// credit line: a discount, clearing or card line must not be called "paid from".
async function paidFromAccount(supabase, je, lines) {
  const tagged = [...new Set(lines.filter((l) => Number(l.credit_cents) > 0 && l.bank_account_id).map((l) => l.bank_account_id))];
  if (tagged.length === 1) {
    const b = await one(supabase.from('bank_accounts').select('account_nickname, bank_name').eq('id', tagged[0]).maybeSingle());
    if (b) return { bank: [b.account_nickname, b.bank_name].filter(Boolean).join(' · ') };
  }
  const creditIds = [...new Set(lines.filter((l) => Number(l.credit_cents) > 0).map((l) => l.account_id).filter(Boolean))];
  if (!creditIds.length) return { why: 'no credit lines' };
  const accts = await many(supabase.from('chart_of_accounts').select('id, account_number, account_name, account_subtype').in('id', creditIds));
  const banks = je.community_id ? await tryMany(supabase.from('bank_accounts').select('gl_account_number').eq('community_id', je.community_id)) : [];
  const bankGl = new Set(banks.map((b) => String(b.gl_account_number || '')).filter(Boolean));
  const cash = accts.filter((a) => bankGl.has(String(a.account_number)) || a.account_subtype === 'cash');
  if (cash.length === 1) {
    const a = cash[0];
    return { account: `${a.account_number} ${a.account_name}`, source: bankGl.has(String(a.account_number))
      ? 'journal_entry_lines credit → chart_of_accounts, matched to bank_accounts.gl_account_number'
      : "journal_entry_lines credit → chart_of_accounts (account_subtype 'cash')" };
  }
  return { why: cash.length ? `${cash.length} cash accounts credited` : 'no credited account is a known bank/cash account' };
}

async function summarizeJournalEntry(supabase, jeId) {
  const je = await one(supabase.from('journal_entries').select('*').eq('id', jeId).maybeSingle());
  if (!je) return { error: 'not_found' };
  const lines = await many(supabase.from('journal_entry_lines').select('line_number, account_id, debit_cents, credit_cents, memo, vendor_id, property_id, bank_account_id').eq('journal_entry_id', jeId).order('line_number'));
  const facts = [];
  const links = [];
  const documents = [];
  const gaps = [];
  const fact = (label, value, source) => { if (value != null && value !== '') facts.push({ label, value: String(value), source }); };
  const amount = Math.max(Number(je.total_debits_cents || 0), Number(je.total_credits_cents || 0));
  let headline = { kind: je.source_module || 'entry', title: je.description || 'Journal entry', amount_cents: amount, date: je.posting_date, counterparty: null };

  // ---- AP payment ----------------------------------------------------------
  const payments = await tryMany(supabase.from('ap_payments').select('*').eq('posting_journal_entry_id', jeId));
  if (payments.length > 1) gaps.push(`${payments.length} AP payments point to this one entry; showing the first. Review the others in Payables.`);
  if (payments.length) {
    const p = payments[0];
    const vendor = p.vendor_id ? await one(supabase.from('vendors').select('name, payee_name').eq('id', p.vendor_id).maybeSingle()) : null;
    const method = METHOD_LABEL[p.payment_method] || p.payment_method;
    headline = { kind: 'ap_payment', title: `${method || 'Payment'} payment — ${money(p.amount_cents)}`, amount_cents: Number(p.amount_cents), date: p.payment_date,
      counterparty: vendor ? (vendor.payee_name || vendor.name) : null };
    fact('Payee', headline.counterparty, 'ap_payments.vendor_id → vendors.name');
    fact('Payment method', method, 'ap_payments.payment_method');
    fact('Check / reference #', p.check_number, 'ap_payments.check_number');
    fact('Payment date', p.payment_date, 'ap_payments.payment_date');
    fact('Amount', money(p.amount_cents), 'ap_payments.amount_cents');
    fact('Status', p.status, 'ap_payments.status');
    if (p.notes) fact('Note', p.notes, 'ap_payments.notes');
    if (p.bank_account_id) {
      const b = await one(supabase.from('bank_accounts').select('*').eq('id', p.bank_account_id).maybeSingle());
      if (b) fact('Paid from', [b.account_nickname, b.bank_name].filter(Boolean).join(' · ') || null, 'ap_payments.bank_account_id → bank_accounts.account_nickname');
    } else {
      const paidFrom = await paidFromAccount(supabase, je, lines);
      if (paidFrom.bank) fact('Paid from', paidFrom.bank, 'journal_entry_lines.bank_account_id → bank_accounts.account_nickname');
      else if (paidFrom.account) {
        fact('Paid from (GL cash account)', paidFrom.account, paidFrom.source);
        gaps.push('No bank account is recorded on this payment (ap_payments.bank_account_id is empty); the cash GL account it was credited to is shown instead.');
      } else gaps.push(`No bank account is recorded on this payment, and the paying cash account can't be determined from the ledger lines (${paidFrom.why}).`);
    }
    if (!p.check_number) gaps.push(REF_GAP[p.payment_method] || 'No payment reference number is recorded.');
    const checks = await tryMany(supabase.from('check_register').select('check_number, issue_date, status, cleared_date, printed_at, check_pdf_storage_path').eq('ap_payment_id', p.id));
    for (const c of checks) {
      if (String(c.check_number) !== String(p.check_number || '')) fact('Check #', c.check_number, 'check_register.check_number');
      fact('Check status', c.status + (c.cleared_date ? ` (cleared ${c.cleared_date})` : ''), 'check_register.status / cleared_date');
      if (c.check_pdf_storage_path) documents.push({ label: `Check #${c.check_number}`, href: docLink({ source_storage_path: c.check_pdf_storage_path }), source: 'check_register.check_pdf_storage_path' });
    }
    const apps = await many(supabase.from('ap_payment_applications').select('invoice_id, applied_cents').eq('payment_id', p.id));
    const bills = [];
    for (const a of apps) {
      const inv = await one(supabase.from('ap_invoices').select('id, vendor_invoice_number, invoice_date, due_date, total_cents, status, source_storage_path, source_document_id, posting_journal_entry_id').eq('id', a.invoice_id).maybeSingle());
      if (!inv) continue;
      const ilines = await many(supabase.from('ap_invoice_lines').select('description, amount_cents, gl_account_id').eq('invoice_id', inv.id).order('line_number'));
      const names = await accountNames(supabase, ilines.map((l) => l.gl_account_id));
      bills.push({
        invoice_id: inv.id, invoice_number: inv.vendor_invoice_number, invoice_date: inv.invoice_date, total_cents: Number(inv.total_cents), applied_cents: Number(a.applied_cents),
        status: inv.status, description: ilines.map((l) => l.description).filter(Boolean)[0] || null,
        expense_accounts: [...new Set(ilines.map((l) => names.get(l.gl_account_id)).filter(Boolean))],
        bill_journal_entry_id: inv.posting_journal_entry_id || null,
        document: docLink(inv),
      });
      if (docLink(inv)) documents.push({ label: `Invoice ${inv.vendor_invoice_number || ''}`.trim(), href: docLink(inv), source: 'ap_invoices.source_storage_path' });
      if (inv.posting_journal_entry_id) links.push({ label: `AP bill entry (invoice ${inv.vendor_invoice_number || inv.invoice_date})`, journal_entry_id: inv.posting_journal_entry_id });
    }
    if (bills.length) {
      facts.push({ label: 'Pays bill(s)', value: bills.map((b) => `Invoice ${b.invoice_number || '(no #)'} dated ${b.invoice_date} (${money(b.applied_cents)})`).join('; '), source: 'ap_payment_applications → ap_invoices' });
      const accts = [...new Set(bills.flatMap((b) => b.expense_accounts))];
      if (accts.length) facts.push({ label: 'Bill originally charged to', value: accts.join('; '), source: 'ap_invoices → ap_invoice_lines.gl_account_id' });
      const d0 = bills.find((b) => b.description);
      if (d0) fact('What it was for', d0.description, 'ap_invoice_lines.description');
    } else gaps.push('This payment is not applied to any bill in Payables.');
    return finish({ je, lines, headline, facts, links, documents, gaps, related: { bills } }, supabase);
  }

  // ---- AP bill -------------------------------------------------------------
  let inv = await tryMany(supabase.from('ap_invoices').select('*').eq('posting_journal_entry_id', jeId));
  if (!inv.length && je.source_module === 'ap_invoice' && je.source_reference) inv = await tryMany(supabase.from('ap_invoices').select('*').eq('id', je.source_reference));
  if (inv.length) {
    const b = inv[0];
    const vendor = b.vendor_id ? await one(supabase.from('vendors').select('name, payee_name').eq('id', b.vendor_id).maybeSingle()) : null;
    const ilines = await many(supabase.from('ap_invoice_lines').select('description, amount_cents, gl_account_id').eq('invoice_id', b.id).order('line_number'));
    const names = await accountNames(supabase, ilines.map((l) => l.gl_account_id));
    headline = { kind: 'ap_bill', title: `Vendor bill — ${money(b.total_cents)}`, amount_cents: Number(b.total_cents), date: b.invoice_date, counterparty: vendor ? vendor.name : null };
    fact('Vendor', headline.counterparty, 'ap_invoices.vendor_id → vendors.name');
    fact('Invoice #', b.vendor_invoice_number, 'ap_invoices.vendor_invoice_number');
    fact('Invoice date', b.invoice_date, 'ap_invoices.invoice_date');
    fact('Due date', b.due_date, 'ap_invoices.due_date');
    fact('Amount', money(b.total_cents), 'ap_invoices.total_cents');
    fact('Paid so far', money(b.amount_paid_cents || 0), 'ap_invoices.amount_paid_cents');
    fact('Bill status', b.status, 'ap_invoices.status');
    fact('What it was for', ilines.map((l) => l.description).filter(Boolean).slice(0, 3).join('; ') || null, 'ap_invoice_lines.description');
    const accts = [...new Set(ilines.map((l) => names.get(l.gl_account_id)).filter(Boolean))];
    if (accts.length) fact('Charged to', accts.join('; '), 'ap_invoice_lines.gl_account_id → chart_of_accounts');
    fact('How it arrived', b.intake_method, 'ap_invoices.intake_method');
    fact('Coding', b.classification_reason, 'ap_invoices.classification_reason');
    const approvals = await many(supabase.from('ap_invoice_approvals').select('action, user_name, created_at').eq('invoice_id', b.id).order('created_at'));
    if (approvals.length) facts.push({ label: 'Approvals', value: approvals.map((a) => `${a.action.replace(/_/g, ' ')} by ${a.user_name || 'staff'} ${String(a.created_at).slice(0, 10)}`).join('; '), source: 'ap_invoice_approvals' });
    else gaps.push('No approval is recorded on this bill yet.');
    const pays = await many(supabase.from('ap_payment_applications').select('payment_id, applied_cents').eq('invoice_id', b.id));
    if (pays.length) {
      const pr = await many(supabase.from('ap_payments').select('id, payment_date, payment_method, check_number, posting_journal_entry_id').in('id', pays.map((x) => x.payment_id)));
      facts.push({ label: 'Paid by', value: pr.map((x) => `${METHOD_LABEL[x.payment_method] || x.payment_method}${x.check_number ? ' #' + x.check_number : ''} on ${x.payment_date}`).join('; '), source: 'ap_payment_applications → ap_payments' });
      for (const x of pr) if (x.posting_journal_entry_id) links.push({ label: `Payment entry (${x.payment_date})`, journal_entry_id: x.posting_journal_entry_id });
    }
    if (docLink(b)) documents.push({ label: `Invoice ${b.vendor_invoice_number || ''}`.trim(), href: docLink(b), source: 'ap_invoices.source_storage_path' });
    return finish({ je, lines, headline, facts, links, documents, gaps, related: { bill_id: b.id } }, supabase);
  }

  // ---- Check-register entry (e.g. a check void) ------------------------------
  const checks = await tryMany(supabase.from('check_register').select('check_number, payee_name, amount_cents, issue_date, status, voided_reason').eq('posting_journal_entry_id', jeId));
  if (checks.length) {
    const c = checks[0];
    headline = { kind: 'check', title: `Check #${c.check_number} — ${money(c.amount_cents)}`, amount_cents: Number(c.amount_cents), date: c.issue_date, counterparty: c.payee_name };
    fact('Payee', c.payee_name, 'check_register.payee_name'); fact('Check #', c.check_number, 'check_register.check_number');
    fact('Status', c.status, 'check_register.status'); fact('Void reason', c.voided_reason, 'check_register.voided_reason');
    return finish({ je, lines, headline, facts, links, documents, gaps, related: {} }, supabase);
  }

  // ---- Homeowner payment / charge -------------------------------------------
  const arp = await tryMany(supabase.from('ar_payments').select('property_id, payment_date, amount_cents, source, source_reference, status').eq('posting_journal_entry_id', jeId));
  const arc = arp.length ? [] : await tryMany(supabase.from('ar_charges').select('property_id, charge_date, due_date, description, original_amount_cents, balance_remaining_cents, status').eq('posting_journal_entry_id', jeId));
  if (arp.length + arc.length > 1) {
    facts.push({ label: 'Linked homeowner records', value: `${arp.length ? arp.length + ' payment(s)' : arc.length + ' charge(s)'} are recorded against this one entry (a batch or conversion entry)`, source: arp.length ? 'ar_payments.posting_journal_entry_id' : 'ar_charges.posting_journal_entry_id' });
  } else if (arp.length || arc.length) {
    const r = arp[0] || arc[0];
    const prop = r.property_id ? await one(supabase.from('properties').select('street_address, unit').eq('id', r.property_id).maybeSingle()) : null;
    const address = prop ? `${prop.street_address}${prop.unit ? ' #' + prop.unit : ''}` : null;
    if (arp.length) {
      headline = { kind: 'homeowner_payment', title: `Homeowner payment — ${money(r.amount_cents)}`, amount_cents: Number(r.amount_cents), date: r.payment_date, counterparty: address };
      fact('Property', address, 'ar_payments.property_id → properties.street_address'); fact('Paid via', r.source, 'ar_payments.source');
      fact('Reference', r.source_reference, 'ar_payments.source_reference'); fact('Status', r.status, 'ar_payments.status');
    } else {
      headline = { kind: 'homeowner_charge', title: `Homeowner charge — ${money(r.original_amount_cents)}`, amount_cents: Number(r.original_amount_cents), date: r.charge_date, counterparty: address };
      fact('Property', address, 'ar_charges.property_id → properties.street_address'); fact('Charge', r.description, 'ar_charges.description');
      fact('Due date', r.due_date, 'ar_charges.due_date'); fact('Still owed', money(r.balance_remaining_cents), 'ar_charges.balance_remaining_cents');
    }
    return finish({ je, lines, headline, facts, links, documents, gaps, related: {} }, supabase);
  }

  // ---- Reversal / voided ------------------------------------------------------
  if (je.reverses_je_id) {
    const orig = await one(supabase.from('journal_entries').select('id, reference, posting_date, description').eq('id', je.reverses_je_id).maybeSingle());
    headline = { ...headline, kind: 'reversal', title: `Reversal — ${money(amount)}` };
    if (orig) { fact('Reverses', `${orig.reference} (${orig.posting_date}): ${orig.description || ''}`, 'journal_entries.reverses_je_id'); links.push({ label: `Original entry ${orig.reference}`, journal_entry_id: orig.id }); }
    fact('Why', je.notes, 'journal_entries.notes');
  } else {
    // Fallback: what the lines themselves are tagged with.
    const vendorIds = [...new Set(lines.map((l) => l.vendor_id).filter(Boolean))];
    const propIds = [...new Set(lines.map((l) => l.property_id).filter(Boolean))];
    if (vendorIds.length) {
      const vs = await many(supabase.from('vendors').select('id, name').in('id', vendorIds));
      headline.counterparty = vs.map((v) => v.name).join(', ') || null;
      fact('Vendor', headline.counterparty, 'journal_entry_lines.vendor_id → vendors.name');
    }
    if (propIds.length) {
      const ps = await many(supabase.from('properties').select('id, street_address').in('id', propIds.slice(0, 20)));
      const a = ps.map((x) => x.street_address).join(', ');
      headline.counterparty = headline.counterparty || a || null;
      fact('Property', a, 'journal_entry_lines.property_id → properties.street_address');
    }
    if (je.source_module === 'vantaca_import') gaps.push('Migrated from Vantaca as daily GL detail: the underlying invoice/payment records were not migrated, so only the description and memo are available.');
    else if (!vendorIds.length && !propIds.length) gaps.push('No linked source record was found for this entry; the description and memo are all the ledger holds.');
  }
  if (je.void_reversal_je_id) {
    const rev = await one(supabase.from('journal_entries').select('id, reference, posting_date').eq('id', je.void_reversal_je_id).maybeSingle());
    if (rev) { fact('Voided by', `${rev.reference} (${rev.posting_date})`, 'journal_entries.void_reversal_je_id'); links.push({ label: `Reversal ${rev.reference}`, journal_entry_id: rev.id }); }
  }
  return finish({ je, lines, headline, facts, links, documents, gaps, related: {} }, supabase);
}

// Common tail: the entry's own document, origin, audit, and the accounting lines.
async function finish(r, supabase) {
  const { je, lines } = r;
  if (docLink(je) && !r.documents.some((d) => d.href === docLink(je))) r.documents.push({ label: 'Supporting document', href: docLink(je), source: 'journal_entries.source_document_path' });
  if (!r.documents.length) r.gaps.push('No supporting document is attached.');
  const names = await accountNames(supabase, lines.map((l) => l.account_id));
  let postedBy = null;
  if (je.posted_by_user_id) {
    const u = await one(supabase.from('user_profiles').select('full_name, email').eq('id', je.posted_by_user_id).maybeSingle());
    postedBy = u ? (u.full_name || u.email) : null;
  }
  if (!postedBy && je.source_module === 'manual') r.gaps.push('Who posted this manual entry is not recorded (posted_by_user_id is empty).');
  const edits = await tryMany(supabase.from('journal_entry_edits').select('edited_by_name, reason, created_at').eq('journal_entry_id', je.id).order('created_at'));
  return {
    journal_entry_id: je.id, reference: je.reference, status: je.status,
    headline: r.headline, facts: r.facts, documents: r.documents, links: r.links, gaps: [...new Set(r.gaps)], related: r.related,
    origin: { source_module: je.source_module, label: ORIGIN_LABEL[je.source_module] || je.source_module || 'Unknown',
      posted_by: postedBy || (je.source_module === 'manual' ? null : 'System (automatic posting)'), posted_at: je.posted_at, source_reference: je.source_reference || null },
    accounting: lines.map((l) => ({ line_number: l.line_number, account: names.get(l.account_id) || l.account_id, debit_cents: Number(l.debit_cents), credit_cents: Number(l.credit_cents), memo: l.memo || null })),
    audit: { classification_reason: je.classification_reason || null, needs_review: !!je.needs_review, notes: je.notes || null,
      edits: edits.map((e) => ({ by: e.edited_by_name, reason: e.reason, at: e.created_at })) },
  };
}

module.exports = { summarizeJournalEntry, docLink, METHOD_LABEL, ORIGIN_LABEL };
