// ============================================================================
// lib/vantaca/extractors/transaction_history.js
// ----------------------------------------------------------------------------
// Extract Vantaca's "Transaction History — Association" report. This is the
// PER-OWNER FULL LEDGER from Vantaca — every charge, every payment, every
// adjustment for every property in the association. THIS IS THE MIGRATION
// UNLOCK: when Quail Ridge migrates, export this from Vantaca on cutover
// day → drop here → replay each transaction into trustEd's AR sub-ledger.
//
// Contract matches other Vantaca extractors:
//   exports.run({ importRow, fileBuffer, mime, filename, community, supabase })
//     → { extraction_raw, row_count, downstream_table, downstream_count, warnings }
//
// extraction_raw holds the full per-property transaction list. A separate
// migration tool (lib/accounting/ar_migration.js — Phase 2B+) reads this
// from vantaca_imports.extraction_raw and replays into ar_charges +
// ar_payments + ar_payment_applications using the §209.0063 engine.
//
// This extractor's job is to EXTRACT FAITHFULLY. It does NOT post or apply.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `You are reading a Vantaca "Transaction History — Association" PDF.
This report shows the per-owner full transaction history across an HOA's portfolio:
every assessment, late fee, interest charge, payment, NSF return, fine, attorney fee,
etc. — chronologically per property/owner.

Return ONLY valid JSON, no preamble, no markdown fences:

{
  "community_name":          "string from header or empty",
  "report_period_start":     "YYYY-MM-DD or empty",
  "report_period_end":       "YYYY-MM-DD or empty",
  "as_of_date":              "YYYY-MM-DD — the 'as of' date for ending balances",
  "owners": [
    {
      "property_address":    "string — street address as written on the report",
      "unit":                "string or null",
      "homeowner_name":      "string — primary account holder name",
      "account_number":      "string or null — Vantaca account ID",
      "beginning_balance_cents":  <integer or null — period-opening balance>,
      "ending_balance_cents":     <integer or null — period-closing balance>,
      "transactions": [
        {
          "transaction_date":  "YYYY-MM-DD",
          "type":              "charge | payment | adjustment | nsf_return | refund | writeoff",
          "category":          "assessment_regular | assessment_special | late_fee | interest | attorney_fee_assessment | attorney_fee_other | records_request_fee | fine | transfer_fee | resale_certificate_fee | nsf_fee | payment | other",
          "description":       "string — verbatim from report",
          "amount_cents":      <integer — SIGNED. Charges/adjustments increasing balance are POSITIVE. Payments/credits decreasing balance are NEGATIVE.>,
          "balance_after_cents": <integer or null — running balance after this transaction if shown>,
          "reference":         "string or null — check #, ACH ref, JE ref, etc.",
          "due_date":          "YYYY-MM-DD or null — for charges only, when stated"
        }
      ]
    }
  ],
  "warnings": ["string"]
}

CRITICAL RULES:
- Money values are INTEGER CENTS. Never strings, never decimals. "$1,234.56" → 123456.
- amount_cents SIGN convention:
    * charges, fees, interest, NSF returns → POSITIVE (they increase the owner's AR balance)
    * payments, refunds, write-offs that reduce balance → NEGATIVE
    * adjustments → signed per the report (if balance went up, positive; down, negative)
- category mapping (force exact strings):
    * Anything labeled "Assessment", "Regular Assessment", "Monthly Assessment" → "assessment_regular"
    * "Special Assessment" / "SA" → "assessment_special"
    * "Late Fee", "LF" → "late_fee"
    * "Interest", "Int" → "interest"
    * "Attorney Fee" if assessment-collection related → "attorney_fee_assessment"; if other → "attorney_fee_other"
    * "Records Request" → "records_request_fee"
    * "Fine", "Violation Fee" → "fine"
    * "Transfer Fee" → "transfer_fee"
    * "Resale Certificate" → "resale_certificate_fee"
    * "NSF", "Returned Check" → "nsf_fee"
    * Any payment → "payment"
    * Unclear → "other"
- Extract EVERY transaction line per owner. Don't skip "running balance" headers or grouping rows.
- account_number: capture the Vantaca account ID exactly as printed (digits only if numeric, alphanumeric otherwise).
- If a transaction shows BOTH a payment AND its automatic application breakdown on separate lines, capture the payment line as type='payment' and skip the application rows (we re-derive applications from the §209.0063 engine on replay).
- warnings: array of plain-English notes when something looks off:
    * "Owner X transactions don't tie: beginning + sum(amount_cents) doesn't equal ending"
    * "Could not classify category for transaction Y"

Return ONLY the JSON.`;

async function extractTransactionHistory(fileBuffer) {
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') },
        },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  const raw = (response.content || []).map((b) => b.text || '').join('').trim();
  console.log(`[transaction_history_extractor] raw first 1200: ${raw.slice(0, 1200)}`);

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const stopReason = response.stop_reason;
    const hint = stopReason === 'max_tokens'
      ? ' Model hit max_tokens — split the report by date range or by half the properties.'
      : '';
    throw new Error(`Transaction history extraction returned malformed JSON.${hint} Parse: ${err.message}`);
  }

  // Defensive coercions
  parsed.owners = (parsed.owners || []).map((o) => {
    const txCoerce = (t) => {
      const coerceM = (v) => {
        if (v == null || v === '') return null;
        if (typeof v === 'number') return Math.round(v);
        const n = Number(String(v).replace(/[$,\s]/g, ''));
        return Number.isFinite(n) ? Math.round(n) : null;
      };
      return {
        transaction_date: t.transaction_date || null,
        type: t.type || 'other',
        category: t.category || 'other',
        description: t.description || '',
        amount_cents: coerceM(t.amount_cents) ?? 0,
        balance_after_cents: coerceM(t.balance_after_cents),
        reference: t.reference || null,
        due_date: t.due_date || null,
      };
    };
    return {
      property_address: o.property_address || '',
      unit: o.unit || null,
      homeowner_name: o.homeowner_name || '',
      account_number: o.account_number ? String(o.account_number) : null,
      beginning_balance_cents: o.beginning_balance_cents ?? null,
      ending_balance_cents: o.ending_balance_cents ?? null,
      transactions: (o.transactions || []).map(txCoerce),
    };
  });
  parsed.warnings = parsed.warnings || [];

  // Self-check per owner: beginning + sum(amount_cents) should equal ending
  for (const o of parsed.owners) {
    if (o.beginning_balance_cents != null && o.ending_balance_cents != null) {
      const sum = (o.transactions || []).reduce((acc, t) => acc + (t.amount_cents || 0), 0);
      const computed = o.beginning_balance_cents + sum;
      const diff = Math.abs(computed - o.ending_balance_cents);
      if (diff > 1) {
        parsed.warnings.push(`Owner '${o.homeowner_name || o.property_address || o.account_number || 'unknown'}' transactions don't tie: beginning + sum differs from ending by ${(diff / 100).toFixed(2)}`);
      }
    }
  }

  return { ...parsed, duration_ms: Date.now() - t0 };
}

// ----------------------------------------------------------------------------
// CSV parsing path (Ed 2026-06-08).
// Vantaca's "Transaction History — Association" can be exported as CSV. The
// shape is one row per ledger line per owner with at least: Date, Account,
// Description, Charge, Payment, Balance.
//
// The CSV extractor produces extraction_raw in the same {owners: [...]}
// shape as the PDF extractor so downstream consumers see one canonical
// format regardless of input.
// ----------------------------------------------------------------------------

// Header aliases. Includes:
//   1. Human-readable headers ("Date", "Account Number", etc.)
//   2. Vantaca's SSRS-generated headers ("ledgerDateDataTextBox", etc.)
//      — when Vantaca exports a report to CSV, SSRS dumps every text-box
//      control by its internal control name. The "DataTextBox" suffix
//      flags the actual data cells; "CaptionTextBox" flags the literal
//      column-header text (which we ignore — they're not data).
const HEADER_ALIASES_CSV = {
  date:          ['date', 'trans date', 'transaction date', 'txn date', 'ledgerdatedatatextbox'],
  account:       ['account number', 'account', 'acct', 'acct number', 'acct #', 'account #', 'accountnumberdatatextbox', 'accountdatatextbox'],
  name:          ['name', 'homeowner', 'homeowner name', 'owner', 'owner name', 'ownernamedatatextbox', 'namedatatextbox'],
  address:       ['address', 'property', 'property address', 'addressdatatextbox', 'propertyaddressdatatextbox'],
  description:   ['description', 'memo', 'desc', 'detail', 'descrdatatextbox', 'descriptiondatatextbox'],
  charge:        ['charge', 'charges', 'debit', 'chgamountdatatextbox', 'chargedatatextbox', 'chargeamountdatatextbox'],
  payment:       ['payment', 'payments', 'credit', 'payamountdatatextbox', 'paymentdatatextbox', 'paymentamountdatatextbox'],
  balance:       ['balance', 'running balance', 'new balance', 'balancedatatextbox', 'runningbalancedatatextbox'],
};

// Vantaca SSRS exports also include CAPTION cells — these are the literal
// "Date" / "Description" / etc. column labels rendered as cells in every
// row. Skip rows where the Caption columns are populated but the Data
// columns are empty (they're header bleed-through, not transactions).
const SSRS_CAPTION_HEADERS = new Set([
  'ledgerdatecaptiontextbox', 'descrcaptiontextbox', 'chgamountcaptiontextbox',
  'payamountcaptiontextbox', 'balancecaptiontextbox',
]);

function _normHeader(h) { return String(h || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function _matchHeader(h) {
  const n = _normHeader(h);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES_CSV)) {
    if (aliases.includes(n)) return field;
  }
  return null;
}

function _parseCents(s) {
  if (s == null) return null;
  const raw = String(s).trim();
  if (!raw || raw === '-' || raw === '$-') return null;
  const isNeg = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const cleaned = raw.replace(/[\$,\s()]/g, '').replace(/^-/, '');
  if (!cleaned || isNaN(Number(cleaned))) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return isNeg ? -cents : cents;
}

function _parseDateStr(s) {
  if (!s) return null;
  const raw = String(s).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  let m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    const yy = parseInt(m[3], 10);
    const yyyy = yy < 50 ? 2000 + yy : 1900 + yy;
    return `${yyyy}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch (_) {}
  return null;
}

function _parseCsvText(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c === '\r') {}
      else { field += c; }
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function _deriveTypeCsv(chargeCents, paymentCents, description) {
  const desc = String(description || '').toLowerCase();
  if (desc.includes('initial balance') || desc.includes('balance brought forward')) {
    return { type: 'balance_brought_forward', category: 'other' };
  }
  if (paymentCents != null && paymentCents !== 0) return { type: 'payment', category: 'payment' };
  if (chargeCents != null && chargeCents !== 0) {
    if (desc.includes('annual assessment') || desc.includes('assessment')) {
      return { type: 'charge', category: 'assessment_regular' };
    }
    if (desc.includes('late fee')) return { type: 'charge', category: 'late_fee' };
    if (desc.includes('interest')) return { type: 'charge', category: 'interest' };
    if (desc.includes('attorney')) return { type: 'charge', category: 'attorney_fee_assessment' };
    if (desc.includes('certified letter')) return { type: 'charge', category: 'fine' };
    if (desc.includes('fine')) return { type: 'charge', category: 'fine' };
    return { type: 'charge', category: 'other' };
  }
  return { type: 'adjustment', category: 'other' };
}

async function extractFromCsv(fileBuffer) {
  const text = fileBuffer.toString('utf8');
  const rows = _parseCsvText(text);
  if (rows.length < 2) {
    throw new Error(`Transaction history CSV has no data rows (parsed ${rows.length}).`);
  }
  const headerRow = rows[0];
  const colMap = {};
  headerRow.forEach((h, i) => {
    const f = _matchHeader(h);
    if (f) colMap[f] = i;
  });

  // SSRS exports often have generic "textBoxN" columns holding the
  // account / owner-name / address values for each transaction row.
  // No way to know from the header which is which — sample the data
  // and pick the column that looks most account-number-like for
  // "account", and the column that looks most address-like for
  // "address", and the column that looks most name-like for "name".
  if (!('account' in colMap)) {
    const generic = [];
    headerRow.forEach((h, i) => {
      const norm = _normHeader(h);
      // Catch SSRS generic boxes: textBoxN, textBoxNN, tbN, etc.
      if (/^(textbox|tb)\d+$/i.test(norm)) generic.push(i);
    });
    if (generic.length) {
      // Score each generic column. Account = mostly numeric short strings.
      // Address = mostly contains a street suffix or numeric+text mix.
      // Name = mostly word-like.
      const scoreAccount = (vals) => {
        let n = 0;
        for (const v of vals) {
          const s = String(v || '').trim();
          // 4-12 char numeric strings, no spaces
          if (/^\d{4,12}$/.test(s)) n++;
        }
        return n;
      };
      const scoreAddress = (vals) => {
        let n = 0;
        for (const v of vals) {
          const s = String(v || '').trim();
          if (/^\d{1,5}\s+[A-Za-z]/.test(s)) n++;
        }
        return n;
      };
      const scoreName = (vals) => {
        let n = 0;
        for (const v of vals) {
          const s = String(v || '').trim();
          // 2+ words, mostly letters
          if (s && /^[A-Za-z]/.test(s) && s.split(/\s+/).length >= 2 && !/\d/.test(s.slice(0, 8))) n++;
        }
        return n;
      };
      const sample = rows.slice(1, Math.min(rows.length, 50));
      const scores = generic.map(i => ({
        idx: i,
        account: scoreAccount(sample.map(r => r[i])),
        address: scoreAddress(sample.map(r => r[i])),
        name:    scoreName(sample.map(r => r[i])),
      }));
      // Pick the column with the highest "account" score (if it's a clear winner)
      const acctWinner = scores.reduce((best, s) => (s.account > best.account ? s : best), { account: 0, idx: -1 });
      if (acctWinner.idx >= 0 && acctWinner.account >= 3) colMap.account = acctWinner.idx;
      const addrCandidates = scores.filter(s => s.idx !== acctWinner.idx);
      const addrWinner = addrCandidates.reduce((best, s) => (s.address > best.address ? s : best), { address: 0, idx: -1 });
      if (addrWinner.idx >= 0 && addrWinner.address >= 3) colMap.address = addrWinner.idx;
      const nameCandidates = scores.filter(s => s.idx !== acctWinner.idx && s.idx !== addrWinner.idx);
      const nameWinner = nameCandidates.reduce((best, s) => (s.name > best.name ? s : best), { name: 0, idx: -1 });
      if (nameWinner.idx >= 0 && nameWinner.name >= 3) colMap.name = nameWinner.idx;
    }
  }

  for (const req of ['date', 'account', 'description']) {
    if (!(req in colMap)) {
      const detail = (req === 'account')
        ? '\n\nThe parser couldn\'t auto-detect which column holds the account number. Either:\n  • Open the CSV in Excel, rename the account column header to "Account Number", save, re-upload, OR\n  • Add an "Account Number" column explicitly in Vantaca\'s report config.'
        : '';
      throw new Error(`CSV is missing required column: ${req}.${detail}\n\nDetected headers: ${headerRow.join(', ')}`);
    }
  }

  // Group rows by account number to build the {owners: [...]} shape
  const byAccount = new Map();
  const warnings = [];

  rows.slice(1).forEach((r, idx) => {
    const date = _parseDateStr(r[colMap.date]);
    const account = String(r[colMap.account] || '').trim();
    const description = String(r[colMap.description] || '').trim();

    // Silently skip SSRS caption bleed-through rows — the row exists but
    // its data columns are empty (only the caption columns hold the
    // literal "Date"/"Description" labels). No warning, no noise.
    const rowAllEmpty = !date && !account && !description;
    if (rowAllEmpty) return;

    if (!date || !account || !description) {
      warnings.push(`Row ${idx + 2} skipped — partial data (date='${date || ''}' account='${account}' desc='${description.slice(0, 30)}')`);
      return;
    }
    const chargeCents  = ('charge'  in colMap) ? _parseCents(r[colMap.charge])  : null;
    const paymentCents = ('payment' in colMap) ? _parseCents(r[colMap.payment]) : null;
    const balanceCents = ('balance' in colMap) ? _parseCents(r[colMap.balance]) : null;
    let amountCents = 0;
    if (chargeCents && chargeCents !== 0) amountCents += Math.abs(chargeCents);
    if (paymentCents && paymentCents !== 0) amountCents -= Math.abs(paymentCents);
    const { type, category } = _deriveTypeCsv(chargeCents, paymentCents, description);
    if (type === 'balance_brought_forward' && amountCents === 0 && balanceCents != null) {
      amountCents = balanceCents;
    }

    if (!byAccount.has(account)) {
      byAccount.set(account, {
        property_address: ('address' in colMap) ? String(r[colMap.address] || '').trim() : '',
        homeowner_name:   ('name' in colMap)    ? String(r[colMap.name] || '').trim()    : '',
        account_number: account,
        beginning_balance_cents: null,
        ending_balance_cents: null,
        transactions: [],
      });
    }
    const owner = byAccount.get(account);
    owner.transactions.push({
      transaction_date: date,
      type,
      category,
      description,
      amount_cents: amountCents,
      balance_after_cents: balanceCents,
      reference: null,
      due_date: null,
    });
    if (balanceCents != null) owner.ending_balance_cents = balanceCents;
  });

  return {
    community_name: '',
    report_period_start: '',
    report_period_end: '',
    as_of_date: '',
    owners: Array.from(byAccount.values()),
    warnings,
  };
}

// ----------------------------------------------------------------------------
// DOWNSTREAM WRITE — converts extraction_raw into:
//   1) one transaction_upload_batches row (migration 195)
//   2) N homeowner_transactions rows (one per ledger line)
// Idempotent at the batch level: a re-extracted import REPLACES its
// downstream batch — the previous batch is reverted first so views drop it.
// ----------------------------------------------------------------------------
async function writeDownstream({ importRow, extracted, community, supabase }) {
  const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

  // Compute as_of_date — use the latest transaction date across all owners.
  let asOfDate = extracted.as_of_date || extracted.report_period_end || null;
  if (!asOfDate) {
    let maxDate = '0000-00-00';
    for (const o of extracted.owners || []) {
      for (const t of o.transactions || []) {
        if (t.transaction_date && t.transaction_date > maxDate) maxDate = t.transaction_date;
      }
    }
    asOfDate = maxDate !== '0000-00-00' ? maxDate : new Date().toISOString().slice(0, 10);
  }
  const periodLabel = extracted.report_period_end
    ? `Through ${extracted.report_period_end}`
    : new Date(asOfDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // If this import already has a committed batch, revert it first (re-extract path).
  await supabase
    .from('transaction_upload_batches')
    .update({ status: 'reverted', reverted_at: new Date().toISOString(), reverted_reason: 'replaced by re-extract' })
    .eq('source_storage_path', `vantaca_import:${importRow.id}`)
    .eq('status', 'committed');

  // Tally totals
  let totalCharges = 0;
  let totalPayments = 0;
  let rowCount = 0;
  const accountSet = new Set();
  for (const o of extracted.owners || []) {
    accountSet.add(o.account_number || '');
    for (const t of o.transactions || []) {
      rowCount++;
      if ((t.amount_cents || 0) > 0) totalCharges  += t.amount_cents;
      if ((t.amount_cents || 0) < 0) totalPayments += Math.abs(t.amount_cents);
    }
  }

  // Insert the batch row
  const { data: batch, error: batchErr } = await supabase
    .from('transaction_upload_batches')
    .insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: community.id,
      period_label: periodLabel,
      as_of_date: asOfDate,
      source_filename: importRow.source_filename || null,
      source_storage_path: `vantaca_import:${importRow.id}`,
      source_format: 'csv',
      row_count: rowCount,
      account_count: accountSet.size,
      total_charges_cents: totalCharges,
      total_payments_cents: totalPayments,
      status: 'committed',
      committed_at: new Date().toISOString(),
      uploaded_by: 'vantaca_import_pipeline',
      notes: `From vantaca_imports row ${importRow.id}. ${(extracted.warnings || []).length} extraction warnings.`,
    })
    .select()
    .single();
  if (batchErr) throw new Error(`transaction_upload_batches insert failed: ${batchErr.message}`);

  // Build per-row records. Resolve property_id + contact_id via
  // vantaca_account_id lookup.
  const accountIds = Array.from(accountSet).filter(Boolean);
  const propByAcct = {};
  const contactByAcct = {};
  if (accountIds.length) {
    const { data: props } = await supabase
      .from('properties')
      .select('id, vantaca_account_id')
      .eq('community_id', community.id)
      .in('vantaca_account_id', accountIds);
    (props || []).forEach(p => { if (p.vantaca_account_id) propByAcct[p.vantaca_account_id] = p.id; });
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, vantaca_account_id')
      .in('vantaca_account_id', accountIds);
    (contacts || []).forEach(c => { if (c.vantaca_account_id) contactByAcct[c.vantaca_account_id] = c.id; });
  }

  // Flatten + insert per-row (chunks of 500)
  const rows = [];
  let rowIdx = 0;
  for (const o of extracted.owners || []) {
    for (const t of o.transactions || []) {
      rowIdx++;
      const acct = o.account_number;
      rows.push({
        source_batch_id: batch.id,
        source_row_index: rowIdx,
        community_id: community.id,
        vantaca_account_id: acct || 'unknown',
        property_id: acct ? (propByAcct[acct] || null) : null,
        contact_id:  acct ? (contactByAcct[acct] || null) : null,
        transaction_date: t.transaction_date,
        description: t.description,
        txn_type: ['charge','payment','credit','adjustment','balance_brought_forward'].includes(t.type)
          ? t.type
          : (t.amount_cents < 0 ? 'payment' : (t.amount_cents > 0 ? 'charge' : 'adjustment')),
        amount_cents: t.amount_cents || 0,
        running_balance_cents: t.balance_after_cents,
        raw_row_jsonb: t,
      });
    }
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error: txnErr, count } = await supabase
      .from('homeowner_transactions')
      .insert(chunk, { count: 'exact' });
    if (txnErr) console.warn('[transaction_history/writeDownstream] chunk insert failed:', txnErr.message);
    else inserted += count || chunk.length;
  }

  return {
    batch_id: batch.id,
    rows_inserted: inserted,
    accounts_matched_to_property: Object.keys(propByAcct).length,
    accounts_total: accountSet.size,
  };
}

async function run({ importRow, fileBuffer, mime, filename, community, supabase }) {
  const isCsv = mime === 'text/csv'
    || mime === 'application/vnd.ms-excel'
    || /\.csv$/i.test(filename || '');
  const isPdf = mime === 'application/pdf';
  if (!isCsv && !isPdf) {
    throw new Error(`Transaction history extractor expects PDF or CSV; got mime=${mime} filename=${filename || ''}`);
  }
  console.log(`[vantaca/transaction_history] extracting ${filename || '(unnamed)'} (${isCsv ? 'CSV' : 'PDF'}) for community=${community?.name}`);

  const extracted = isCsv ? await extractFromCsv(fileBuffer) : await extractTransactionHistory(fileBuffer);

  const totalTransactions = (extracted.owners || []).reduce((acc, o) => acc + (o.transactions?.length || 0), 0);

  // Write downstream — populates the new transactions tables (migration 195)
  // so the homeowner portal sees it via /api/portal/transactions.
  let downstream = null;
  if (community?.id) {
    try {
      downstream = await writeDownstream({ importRow, extracted, community, supabase });
    } catch (dsErr) {
      console.error('[vantaca/transaction_history] downstream write failed:', dsErr.message);
      (extracted.warnings || []).push(`Downstream write failed: ${dsErr.message}`);
    }
  } else {
    (extracted.warnings || []).push('No community resolved — downstream rows not written. Operator must reclassify with override_community_id and re-run.');
  }

  return {
    extraction_raw: extracted,
    row_count: totalTransactions,
    downstream_table: downstream ? 'homeowner_transactions' : null,
    downstream_count: downstream ? downstream.rows_inserted : (extracted.owners?.length || 0),
    warnings: extracted.warnings || [],
  };
}

module.exports = { run, extractTransactionHistory, extractFromCsv, writeDownstream };
