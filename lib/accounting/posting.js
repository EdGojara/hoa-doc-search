// ============================================================================
// lib/accounting/posting.js — double-entry journal posting engine
// ----------------------------------------------------------------------------
// THE function that posts every journal entry trustEd will ever record.
// Used by:
//   - Manual JE UI (api/books.js)
//   - Assessment billing engine (Phase 2)
//   - Payment intake / portal payments
//   - Bank reconciliation auto-posting (Phase 2)
//   - Vantaca import replay
//
// CONTRACT — every posting goes through postJournalEntry():
//   - Validates DEBITS = CREDITS (DB also enforces; this is the friendly error path)
//   - Validates each line has only debit OR credit (not both, not neither)
//   - Validates each account exists, is_active, and not is_summary
//   - Validates posting_date falls in an OPEN period for the community
//     (rejects with 'period_closed' error otherwise)
//   - Computes totals, generates reference, inserts atomically
//
// APPEND-ONLY:
//   voidJournalEntry() does NOT delete — it posts an offsetting entry on
//   today's date and flips the original's status to 'voided'. The reversal
//   chain (reverses_je_id / void_reversal_je_id) preserves the audit trail.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Find the open period containing a posting_date for a community.
 * Returns null if no open period covers the date.
 */
async function resolveOpenPeriod(community_id, posting_date) {
  const { data, error } = await supabase
    .from('accounting_periods')
    .select('id, fiscal_year, period_number, period_start, period_end, status')
    .eq('community_id', community_id)
    .lte('period_start', posting_date)
    .gte('period_end', posting_date)
    .in('status', ['open', 'reopened'])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Generate the next sequential JE reference for a community/year.
 * Uses the DB function for race-safe sequencing.
 */
async function generateReference(community_id, fiscal_year) {
  const { data, error } = await supabase.rpc('next_je_reference', {
    p_community_id: community_id,
    p_fiscal_year: fiscal_year,
  });
  if (error) throw error;
  return data;
}

/**
 * Post a journal entry. Returns { entry, lines } on success or throws on validation failure.
 *
 * @param {object} opts
 * @param {string} opts.community_id   — required
 * @param {string} opts.posting_date   — 'YYYY-MM-DD', required
 * @param {string} opts.description    — required
 * @param {string} [opts.reference]    — optional; auto-generated if omitted
 * @param {string} [opts.source_module] — defaults to 'manual'
 * @param {string} [opts.source_reference]
 * @param {string} [opts.posted_by_user_id]
 * @param {string} [opts.notes]
 * @param {Array}  opts.lines          — required, ≥ 2. Each: {account_id, debit_cents, credit_cents, memo, property_id?, vendor_id?, bank_account_id?}
 * @param {string} [opts.reverses_je_id] — when this entry is a reversal of another
 */
async function postJournalEntry(opts) {
  const {
    community_id,
    posting_date,
    description,
    reference,
    source_module = 'manual',
    source_reference,
    posted_by_user_id,
    notes,
    lines,
    reverses_je_id,
  } = opts;

  // ---- Validation: required fields ----
  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!posting_date || !/^\d{4}-\d{2}-\d{2}$/.test(posting_date)) {
    throw Object.assign(new Error('posting_date_required_yyyy_mm_dd'), { code: 'invalid_input' });
  }
  if (!description || !description.trim()) {
    throw Object.assign(new Error('description_required'), { code: 'invalid_input' });
  }
  if (!Array.isArray(lines) || lines.length < 2) {
    throw Object.assign(new Error('at_least_2_lines_required'), { code: 'invalid_input' });
  }

  // ---- Validation: each line shape + totals ----
  let totalDebits = 0;
  let totalCredits = 0;
  const account_ids = new Set();
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.account_id) {
      throw Object.assign(new Error(`line_${i + 1}_account_id_required`), { code: 'invalid_input' });
    }
    const d = Number(ln.debit_cents || 0);
    const c = Number(ln.credit_cents || 0);
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0) {
      throw Object.assign(new Error(`line_${i + 1}_amounts_must_be_non_negative_integers`), { code: 'invalid_input' });
    }
    if (d > 0 && c > 0) {
      throw Object.assign(new Error(`line_${i + 1}_cannot_have_both_debit_and_credit`), { code: 'invalid_input' });
    }
    if (d === 0 && c === 0) {
      throw Object.assign(new Error(`line_${i + 1}_must_have_either_debit_or_credit`), { code: 'invalid_input' });
    }
    totalDebits += d;
    totalCredits += c;
    account_ids.add(ln.account_id);
  }
  if (totalDebits !== totalCredits) {
    throw Object.assign(new Error(`debits_${totalDebits}_must_equal_credits_${totalCredits}`), { code: 'unbalanced' });
  }
  if (totalDebits === 0) {
    throw Object.assign(new Error('zero_amount_entry'), { code: 'invalid_input' });
  }

  // ---- Validation: accounts exist + are postable ----
  const { data: accountRows, error: acctErr } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number, is_active, is_summary, community_id, fund_id')
    .in('id', Array.from(account_ids));
  if (acctErr) throw acctErr;
  const byId = new Map((accountRows || []).map((a) => [a.id, a]));
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const a = byId.get(ln.account_id);
    if (!a) throw Object.assign(new Error(`line_${i + 1}_account_not_found`), { code: 'invalid_input' });
    if (a.community_id !== community_id) {
      throw Object.assign(new Error(`line_${i + 1}_account_in_different_community`), { code: 'invalid_input' });
    }
    if (!a.is_active) {
      throw Object.assign(new Error(`line_${i + 1}_account_${a.account_number}_is_inactive`), { code: 'invalid_input' });
    }
    if (a.is_summary) {
      throw Object.assign(new Error(`line_${i + 1}_account_${a.account_number}_is_summary_only_no_direct_posting`), { code: 'invalid_input' });
    }
  }

  // ---- Validation: posting_date falls in an open period ----
  const period = await resolveOpenPeriod(community_id, posting_date);
  if (!period) {
    throw Object.assign(new Error(`no_open_period_for_${posting_date}_check_period_management`), { code: 'period_closed' });
  }

  // ---- Generate reference if not supplied ----
  const fiscalYear = period.fiscal_year;
  const ref = reference || (await generateReference(community_id, fiscalYear));

  // ---- Insert journal entry ----
  const { data: je, error: jeErr } = await supabase
    .from('journal_entries')
    .insert({
      community_id,
      period_id: period.id,
      posting_date,
      reference: ref,
      description,
      source_module,
      source_reference: source_reference || null,
      total_debits_cents: totalDebits,
      total_credits_cents: totalCredits,
      reverses_je_id: reverses_je_id || null,
      status: 'posted',
      posted_by_user_id: posted_by_user_id || null,
      notes: notes || null,
    })
    .select('*')
    .single();
  if (jeErr) throw jeErr;

  // ---- Insert lines ----
  const lineRows = lines.map((ln, i) => ({
    journal_entry_id: je.id,
    line_number: i + 1,
    account_id: ln.account_id,
    // Fund dimension (Ed 2026-06-30): caller may tag the line's fund explicitly
    // (e.g. a 3050 fund-balance line in the Reserve fund); otherwise inherit the
    // account's home fund. Keeps single-fund postings correct with zero caller
    // changes; lets multi-fund accounts be tagged per line.
    fund_id: ln.fund_id || (byId.get(ln.account_id) || {}).fund_id || null,
    debit_cents: Number(ln.debit_cents || 0),
    credit_cents: Number(ln.credit_cents || 0),
    memo: ln.memo || null,
    property_id: ln.property_id || null,
    vendor_id: ln.vendor_id || null,
    bank_account_id: ln.bank_account_id || null,
  }));
  const { data: insertedLines, error: lnErr } = await supabase
    .from('journal_entry_lines')
    .insert(lineRows)
    .select('*');
  if (lnErr) {
    // Rollback the journal entry — the FK on lines will prevent later access,
    // but better to clean up. Use delete (this is the ONE legitimate case for
    // delete: failed-insert rollback before any audit signal).
    await supabase.from('journal_entries').delete().eq('id', je.id);
    throw lnErr;
  }

  return { entry: je, lines: insertedLines };
}

/**
 * Void a posted journal entry by creating an offsetting reversal entry on
 * today's date (or a specified reversal_date). The original entry's status
 * flips to 'voided' and void_reversal_je_id captures the offset entry's id.
 *
 * @param {object} opts
 * @param {string} opts.journal_entry_id — the entry to void
 * @param {string} opts.void_reason       — required, audit trail
 * @param {string} [opts.reversal_date]   — defaults to today
 * @param {string} [opts.posted_by_user_id]
 */
async function voidJournalEntry(opts) {
  const { journal_entry_id, void_reason, reversal_date, posted_by_user_id } = opts;
  if (!journal_entry_id) throw Object.assign(new Error('journal_entry_id_required'), { code: 'invalid_input' });
  if (!void_reason) throw Object.assign(new Error('void_reason_required'), { code: 'invalid_input' });

  // Load the original entry + its lines
  const { data: original, error: origErr } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('id', journal_entry_id)
    .maybeSingle();
  if (origErr) throw origErr;
  if (!original) throw Object.assign(new Error('original_not_found'), { code: 'not_found' });
  if (original.status === 'voided') {
    throw Object.assign(new Error('already_voided'), { code: 'invalid_state' });
  }

  const { data: origLines, error: lnErr } = await supabase
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', original.id);
  if (lnErr) throw lnErr;

  // Build the offsetting entry — flip debits and credits
  const revDate = reversal_date || new Date().toISOString().slice(0, 10);
  const reversalLines = (origLines || []).map((ln) => ({
    account_id: ln.account_id,
    debit_cents: ln.credit_cents,        // swap
    credit_cents: ln.debit_cents,        // swap
    memo: `Reversal of ${original.reference}: ${ln.memo || ''}`.trim(),
    property_id: ln.property_id,
    vendor_id: ln.vendor_id,
    bank_account_id: ln.bank_account_id,
  }));

  // Post the reversal
  const reversal = await postJournalEntry({
    community_id: original.community_id,
    posting_date: revDate,
    description: `VOID: ${original.reference} — ${void_reason}`,
    source_module: 'reversal',
    source_reference: original.id,
    posted_by_user_id,
    notes: `Reverses ${original.reference} posted ${original.posting_date}. Void reason: ${void_reason}`,
    reverses_je_id: original.id,
    lines: reversalLines,
  });

  // Flip the original's status
  const { error: updErr } = await supabase
    .from('journal_entries')
    .update({
      status: 'voided',
      voided_at: new Date().toISOString(),
      voided_by_user_id: posted_by_user_id || null,
      void_reason,
      void_reversal_je_id: reversal.entry.id,
    })
    .eq('id', original.id);
  if (updErr) throw updErr;

  return { original_entry: original, reversal_entry: reversal.entry, reversal_lines: reversal.lines };
}

/**
 * Edit a posted journal entry IN PLACE, only while its period is OPEN, and
 * record a before/after change-log row so the audit trail survives (Ed
 * 2026-07-11 — "edit the auto entries during review instead of making a JE").
 * Closed periods are immutable: this throws period_closed, and the caller
 * should post an adjusting entry in the next open period instead.
 *
 * Accepts any subset of: description, notes, source_document_id,
 * source_document_path, classification_reason, needs_review, and a full `lines`
 * replacement (re-validated + re-balanced like a fresh post).
 */
async function editJournalEntry(opts) {
  const {
    journal_entry_id, edited_by_user_id, edited_by_name, reason,
    description, notes, source_document_id, source_document_path,
    classification_reason, needs_review, lines,
  } = opts || {};
  if (!journal_entry_id) throw Object.assign(new Error('journal_entry_id_required'), { code: 'invalid_input' });

  const { data: je, error } = await supabase.from('journal_entries').select('*').eq('id', journal_entry_id).maybeSingle();
  if (error) throw error;
  if (!je) throw Object.assign(new Error('entry_not_found'), { code: 'not_found' });
  if (je.status === 'voided') throw Object.assign(new Error('cannot_edit_a_voided_entry'), { code: 'invalid_state' });

  // Period must be open/reopened — closed books are immutable.
  const { data: period } = await supabase.from('accounting_periods').select('id, status').eq('id', je.period_id).maybeSingle();
  if (!period || !['open', 'reopened'].includes(period.status)) {
    throw Object.assign(new Error('period_closed_post_an_adjusting_entry_instead'), { code: 'period_closed' });
  }

  const changes = {};
  const patch = {};
  const setIf = (field, val) => { if (val !== undefined && val !== je[field]) { changes[field] = { before: je[field], after: val }; patch[field] = val; } };
  setIf('description', description);
  setIf('notes', notes);
  setIf('source_document_id', source_document_id);
  setIf('source_document_path', source_document_path);
  setIf('classification_reason', classification_reason);
  setIf('needs_review', needs_review);

  // Full line replacement — validate exactly like a fresh post (balance +
  // account postability + community scope) so an edit can never break the GL.
  let newLineRows = null;
  if (Array.isArray(lines)) {
    if (lines.length < 2) throw Object.assign(new Error('at_least_2_lines_required'), { code: 'invalid_input' });
    let totalDebits = 0, totalCredits = 0; const account_ids = new Set();
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.account_id) throw Object.assign(new Error(`line_${i + 1}_account_id_required`), { code: 'invalid_input' });
      const d = Number(ln.debit_cents || 0), c = Number(ln.credit_cents || 0);
      if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0) throw Object.assign(new Error(`line_${i + 1}_amounts_must_be_non_negative_integers`), { code: 'invalid_input' });
      if (d > 0 && c > 0) throw Object.assign(new Error(`line_${i + 1}_cannot_have_both_debit_and_credit`), { code: 'invalid_input' });
      if (d === 0 && c === 0) throw Object.assign(new Error(`line_${i + 1}_must_have_either_debit_or_credit`), { code: 'invalid_input' });
      totalDebits += d; totalCredits += c; account_ids.add(ln.account_id);
    }
    if (totalDebits !== totalCredits) throw Object.assign(new Error(`debits_${totalDebits}_must_equal_credits_${totalCredits}`), { code: 'unbalanced' });
    if (totalDebits === 0) throw Object.assign(new Error('zero_amount_entry'), { code: 'invalid_input' });
    const { data: accountRows, error: acctErr } = await supabase.from('chart_of_accounts')
      .select('id, account_number, is_active, is_summary, community_id, fund_id').in('id', Array.from(account_ids));
    if (acctErr) throw acctErr;
    const byId = new Map((accountRows || []).map((a) => [a.id, a]));
    for (let i = 0; i < lines.length; i++) {
      const a = byId.get(lines[i].account_id);
      if (!a) throw Object.assign(new Error(`line_${i + 1}_account_not_found`), { code: 'invalid_input' });
      if (a.community_id !== je.community_id) throw Object.assign(new Error(`line_${i + 1}_account_in_different_community`), { code: 'invalid_input' });
      if (!a.is_active) throw Object.assign(new Error(`line_${i + 1}_account_${a.account_number}_is_inactive`), { code: 'invalid_input' });
      if (a.is_summary) throw Object.assign(new Error(`line_${i + 1}_account_${a.account_number}_is_summary_only`), { code: 'invalid_input' });
    }
    newLineRows = lines.map((ln, i) => ({
      journal_entry_id, line_number: i + 1, account_id: ln.account_id,
      fund_id: ln.fund_id || (byId.get(ln.account_id) || {}).fund_id || null,
      debit_cents: Number(ln.debit_cents || 0), credit_cents: Number(ln.credit_cents || 0),
      memo: ln.memo || null, property_id: ln.property_id || null, vendor_id: ln.vendor_id || null, bank_account_id: ln.bank_account_id || null,
    }));
    const { data: curLines } = await supabase.from('journal_entry_lines').select('account_id, debit_cents, credit_cents, memo').eq('journal_entry_id', journal_entry_id).order('line_number');
    changes.lines = { before: curLines || [], after: newLineRows.map(({ account_id, debit_cents, credit_cents, memo }) => ({ account_id, debit_cents, credit_cents, memo })) };
    patch.total_debits_cents = totalDebits;
    patch.total_credits_cents = totalCredits;
  }

  if (Object.keys(changes).length === 0) return { entry: je, unchanged: true };

  patch.last_edited_at = new Date().toISOString();
  patch.last_edited_by_user_id = edited_by_user_id || null;
  patch.updated_at = new Date().toISOString();

  const { data: updated, error: upErr } = await supabase.from('journal_entries').update(patch).eq('id', journal_entry_id).select('*').single();
  if (upErr) throw upErr;

  if (newLineRows) {
    const { error: delErr } = await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', journal_entry_id);
    if (delErr) throw delErr;
    const { error: insErr } = await supabase.from('journal_entry_lines').insert(newLineRows);
    if (insErr) throw insErr;
  }

  const { error: logErr } = await supabase.from('journal_entry_edits').insert({
    journal_entry_id, community_id: je.community_id,
    edited_by_user_id: edited_by_user_id || null, edited_by_name: edited_by_name || null,
    reason: reason || null, changes,
  });
  if (logErr) throw logErr;

  return { entry: updated, changes };
}

module.exports = { postJournalEntry, voidJournalEntry, editJournalEntry, resolveOpenPeriod };
