// ============================================================================
// api/transactions.js — homeowner transaction history + monthly upload pipeline
// ----------------------------------------------------------------------------
// Mounted at /api/transactions
//
// Ed 2026-06-08 — Mirror Vantaca's per-homeowner transaction ledger into
// trustEd so the homeowner portal can show the same Recent Transactions +
// Running Balance experience. Vantaca remains source of truth; trustEd
// mirrors via monthly CSV upload with "Financial activity current as of
// [date]" disclosure to the homeowner.
//
// ENDPOINTS:
//   POST   /upload                  — multipart CSV upload, parses + commits
//                                     one batch (community × period). Returns
//                                     batch summary + row counts.
//   GET    /batches?community_id=X  — list recent batches for a community
//   GET    /batches/:id             — fetch one batch + status counts
//   POST   /batches/:id/revert      — undo a batch (sets reverted_at; the
//                                     v_homeowner_current_balance view
//                                     auto-excludes reverted batches via
//                                     the status='committed' filter)
//   GET    /freshness?community_id=X — when was this community last updated
//
// CSV FORMAT (Vantaca export shape):
//   Date,Account Number,Description,Charge,Payment,Balance
//   2026-01-01,10110674,Annual Assessment,615.00,,615.00
//   2026-01-30,10110674,Chk #1103 Payment,,615.00,0.00
//
// Header detection is case-insensitive + tolerates common variants
// ("Date", "Trans Date", "Transaction Date", etc.).
// ============================================================================

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// ----------------------------------------------------------------------------
// CSV parsing — header-tolerant, dollar-string-tolerant. Returns rows as
// { date, account, description, charge_cents, payment_cents, balance_cents, raw }.
// Skips blank rows. Numbers are cents (BIGINT). Strings are trimmed.
// ----------------------------------------------------------------------------
const HEADER_ALIASES = {
  date:        ['date', 'trans date', 'transaction date', 'txn date'],
  account:     ['account number', 'account', 'acct', 'acct number', 'acct #', 'account #'],
  description: ['description', 'memo', 'desc', 'detail'],
  charge:      ['charge', 'charges', 'debit'],
  payment:     ['payment', 'payments', 'credit'],
  balance:     ['balance', 'running balance', 'new balance'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchHeaderToField(h) {
  const n = normalizeHeader(h);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(n)) return field;
  }
  return null;
}

// Parse dollar string ("$615.00" / "615.00" / "(615.00)" / "-615.00") → cents BIGINT (signed).
// Returns null if blank/unparseable.
function parseDollarsToCents(s) {
  if (s == null) return null;
  const raw = String(s).trim();
  if (!raw || raw === '-' || raw === '$-' || raw === '$' || raw === '$0' || raw === '$0.00') return raw.includes('0') ? 0 : null;
  // Detect parens-negative
  const isNegative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const cleaned = raw.replace(/[\$,\s()]/g, '').replace(/^-/, '');
  if (!cleaned || isNaN(Number(cleaned))) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return isNegative ? -cents : cents;
}

// Parse a CSV string into rows. Handles quoted fields with embedded commas.
function parseCsvText(text) {
  // Strip BOM
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
      else if (c === '\r') { /* skip — handled by \n */ }
      else { field += c; }
    }
  }
  if (field.length || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function parseDateString(s) {
  if (!s) return null;
  const raw = String(s).trim();
  if (!raw) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // M/D/YYYY or MM/DD/YYYY
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const mm = String(slash[1]).padStart(2, '0');
    const dd = String(slash[2]).padStart(2, '0');
    return `${slash[3]}-${mm}-${dd}`;
  }
  // M/D/YY
  const slashShort = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (slashShort) {
    const mm = String(slashShort[1]).padStart(2, '0');
    const dd = String(slashShort[2]).padStart(2, '0');
    const yy = parseInt(slashShort[3], 10);
    const yyyy = yy < 50 ? 2000 + yy : 1900 + yy;
    return `${yyyy}-${mm}-${dd}`;
  }
  // Fallback: let Date parse it
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch (_) {}
  return null;
}

// Determine txn_type from charge/payment columns or description hints
function deriveType(chargeCents, paymentCents, description) {
  const desc = String(description || '').toLowerCase();
  if (desc.includes('initial balance') || desc.includes('balance brought forward')) {
    return 'balance_brought_forward';
  }
  if (paymentCents != null && paymentCents !== 0) return 'payment';
  if (chargeCents != null && chargeCents !== 0) return 'charge';
  return 'adjustment';
}

// ----------------------------------------------------------------------------
// POST /upload
// multipart: { file: CSV, community_id, period_label?, as_of_date?, notes? }
// ----------------------------------------------------------------------------
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const communityId = req.body.community_id;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });

    const text = req.file.buffer.toString('utf8');
    const rows = parseCsvText(text);
    if (rows.length < 2) {
      return res.status(400).json({ error: 'csv_has_no_data_rows', detail: `Parsed ${rows.length} row(s); need header + 1+ data rows.` });
    }

    // Build column → field map from header row
    const headerRow = rows[0];
    const colMap = {};
    headerRow.forEach((h, i) => {
      const field = matchHeaderToField(h);
      if (field) colMap[field] = i;
    });
    const required = ['date', 'account', 'description'];
    const missing = required.filter(f => !(f in colMap));
    if (missing.length) {
      return res.status(400).json({
        error: 'csv_missing_required_columns',
        missing,
        detected_headers: headerRow,
      });
    }
    // At least one of charge / payment / balance must be present
    if (!('charge' in colMap) && !('payment' in colMap) && !('balance' in colMap)) {
      return res.status(400).json({ error: 'csv_missing_amount_columns', detected_headers: headerRow });
    }

    // Parse data rows
    const dataRows = rows.slice(1);
    const parsedRows = [];
    const errors = [];
    let totalCharges = 0;
    let totalPayments = 0;
    const accountSet = new Set();

    dataRows.forEach((r, idx) => {
      const txnDate = parseDateString(r[colMap.date]);
      const account = String(r[colMap.account] || '').trim();
      const description = String(r[colMap.description] || '').trim();
      const chargeCents  = ('charge'  in colMap) ? parseDollarsToCents(r[colMap.charge])  : null;
      const paymentCents = ('payment' in colMap) ? parseDollarsToCents(r[colMap.payment]) : null;
      const balanceCents = ('balance' in colMap) ? parseDollarsToCents(r[colMap.balance]) : null;

      if (!txnDate) { errors.push({ row: idx + 2, error: 'bad_date', raw: r[colMap.date] }); return; }
      if (!account) { errors.push({ row: idx + 2, error: 'missing_account' }); return; }
      if (!description) { errors.push({ row: idx + 2, error: 'missing_description' }); return; }
      if (chargeCents == null && paymentCents == null && balanceCents == null) {
        errors.push({ row: idx + 2, error: 'no_amount_columns_parsed' });
        return;
      }

      // Signed amount_cents: charges positive, payments negative
      let amountCents = 0;
      if (chargeCents && chargeCents !== 0) amountCents += Math.abs(chargeCents);
      if (paymentCents && paymentCents !== 0) amountCents -= Math.abs(paymentCents);
      const txnType = deriveType(chargeCents, paymentCents, description);
      if (txnType === 'balance_brought_forward' && amountCents === 0 && balanceCents != null) {
        amountCents = balanceCents;
      }

      if (chargeCents && chargeCents !== 0) totalCharges += Math.abs(chargeCents);
      if (paymentCents && paymentCents !== 0) totalPayments += Math.abs(paymentCents);
      accountSet.add(account);

      parsedRows.push({
        source_row_index: idx + 2,
        transaction_date: txnDate,
        vantaca_account_id: account,
        description,
        txn_type: txnType,
        amount_cents: amountCents,
        running_balance_cents: balanceCents,
        raw_row_jsonb: r.reduce((acc, val, i) => {
          const h = headerRow[i] || `col_${i}`;
          acc[h] = val;
          return acc;
        }, {}),
      });
    });

    if (!parsedRows.length) {
      return res.status(400).json({ error: 'no_valid_rows_parsed', errors: errors.slice(0, 20) });
    }

    // Resolve property + contact for each unique account
    const accountIds = Array.from(accountSet);
    const propByAcct = {};
    const contactByAcct = {};
    if (accountIds.length) {
      const { data: props } = await supabase
        .from('properties')
        .select('id, vantaca_account_id')
        .eq('community_id', communityId)
        .in('vantaca_account_id', accountIds);
      (props || []).forEach(p => { if (p.vantaca_account_id) propByAcct[p.vantaca_account_id] = p.id; });

      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, vantaca_account_id')
        .in('vantaca_account_id', accountIds);
      (contacts || []).forEach(c => { if (c.vantaca_account_id) contactByAcct[c.vantaca_account_id] = c.id; });
    }

    // Default period_label + as_of_date if not provided
    const today = new Date();
    const periodLabel = req.body.period_label || today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    // as_of_date: max(transaction_date) seen, fallback to today
    let asOfDate = req.body.as_of_date;
    if (!asOfDate) {
      const maxDate = parsedRows.reduce((m, r) => r.transaction_date > m ? r.transaction_date : m, '0000-00-00');
      asOfDate = maxDate !== '0000-00-00' ? maxDate : today.toISOString().slice(0, 10);
    }

    // Create the batch row
    const { data: batch, error: batchErr } = await supabase
      .from('transaction_upload_batches')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id: communityId,
        period_label: periodLabel,
        as_of_date: asOfDate,
        source_filename: req.file.originalname || null,
        source_format: 'csv',
        row_count: parsedRows.length,
        account_count: accountIds.length,
        total_charges_cents: totalCharges,
        total_payments_cents: totalPayments,
        status: 'committed',
        committed_at: new Date().toISOString(),
        uploaded_by: req.body.uploaded_by || null,
        notes: req.body.notes || null,
      })
      .select()
      .single();
    if (batchErr) return res.status(500).json({ error: batchErr.message });

    // Insert all transaction rows (chunks of 500 to keep payloads sane)
    const txnRows = parsedRows.map(r => ({
      source_batch_id: batch.id,
      source_row_index: r.source_row_index,
      community_id: communityId,
      vantaca_account_id: r.vantaca_account_id,
      property_id: propByAcct[r.vantaca_account_id] || null,
      contact_id: contactByAcct[r.vantaca_account_id] || null,
      transaction_date: r.transaction_date,
      description: r.description,
      txn_type: r.txn_type,
      amount_cents: r.amount_cents,
      running_balance_cents: r.running_balance_cents,
      raw_row_jsonb: r.raw_row_jsonb,
    }));

    let inserted = 0;
    for (let i = 0; i < txnRows.length; i += 500) {
      const chunk = txnRows.slice(i, i + 500);
      const { error: txnErr, count } = await supabase
        .from('homeowner_transactions')
        .insert(chunk, { count: 'exact' });
      if (txnErr) {
        console.warn('[transactions/upload] insert chunk failed:', txnErr.message);
      } else {
        inserted += count || chunk.length;
      }
    }

    res.json({
      batch,
      stats: {
        rows_inserted: inserted,
        row_errors: errors.length,
        accounts_resolved_to_property: Object.keys(propByAcct).length,
        accounts_resolved_to_contact:  Object.keys(contactByAcct).length,
        total_charges_cents: totalCharges,
        total_payments_cents: totalPayments,
      },
      errors: errors.slice(0, 50),
    });
  } catch (err) {
    console.error('[transactions/upload] failed:', err.stack || err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /batches?community_id=X — list recent batches
// ----------------------------------------------------------------------------
router.get('/batches', async (req, res) => {
  try {
    let q = supabase
      .from('transaction_upload_batches')
      .select('id, community_id, period_label, as_of_date, source_filename, row_count, account_count, total_charges_cents, total_payments_cents, status, uploaded_by, uploaded_at, committed_at, notes')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('as_of_date', { ascending: false })
      .limit(50);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ batches: data || [] });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /batches/:id/revert — undo a batch
// ----------------------------------------------------------------------------
router.post('/batches/:id/revert', express.json(), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('transaction_upload_batches')
      .update({
        status: 'reverted',
        reverted_at: new Date().toISOString(),
        reverted_reason: req.body?.reason || null,
      })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ batch: data });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /freshness?community_id=X — when was this community last updated
// ----------------------------------------------------------------------------
router.get('/freshness', async (req, res) => {
  try {
    if (!req.query.community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase
      .from('v_community_transaction_freshness')
      .select('*')
      .eq('community_id', req.query.community_id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ freshness: data || null });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
