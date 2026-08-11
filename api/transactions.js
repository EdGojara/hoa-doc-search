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

    // ── Single-snapshot invariant ────────────────────────────────────────────
    // A Vantaca AR import is a FULL SNAPSHOT of owner balances, and the balance
    // view SUMS every committed batch — so leaving a prior snapshot committed
    // next to this one DOUBLES every balance the board sees. When a new snapshot
    // commits, supersede the prior committed SNAPSHOT(s) for this community so
    // there is always exactly one. Incremental 'manual' batches (transfer
    // prorations etc.) are left alone — they legitimately add to the balance.
    // (Ed 2026-08-10 — final 7/31 cutover load; correctness must be structural,
    // not "remember to revert the old one".)
    //
    // Cross-check first (Preview cross-check scar): a new snapshot covering far
    // fewer accounts than the one it replaces is probably a truncated/partial
    // file. Never silently swap a complete snapshot for a partial one and halve
    // the board's AR — HOLD the new load (do not let it affect balances) and tell
    // the operator, unless they pass force=1.
    let superseded = [];
    let held = null;
    try {
      // Identify a prior FULL SNAPSHOT by COVERAGE, not source_format: existing
      // Vantaca AR snapshots are stored as source_format 'manual' — the SAME value
      // single-charge prorations use — so keying on 'csv' would miss the real
      // snapshot (double-count) OR reverting all 'manual' would wipe prorations.
      // A snapshot covers a comparable set of accounts to this load; a proration
      // covers 1. Threshold at half this load's account count (floor 25), and
      // never touch the incremental proration batches. (Ed 2026-08-10.)
      const { data: allPriors } = await supabase.from('transaction_upload_batches')
        .select('id, period_label, as_of_date, account_count, uploaded_by')
        .eq('community_id', communityId).eq('status', 'committed').neq('id', batch.id);
      const snapThreshold = Math.max(25, Math.floor((batch.account_count || 0) * 0.5));
      const priors = (allPriors || []).filter((p) => p.uploaded_by !== 'transfer_proration' && (p.account_count || 0) >= snapThreshold);
      const maxPrior = priors.reduce((m, p) => Math.max(m, p.account_count || 0), 0);
      const force = req.body.force === '1' || req.body.force === true;
      if (priors && priors.length && !force && batch.account_count < maxPrior * 0.9) {
        // Partial-load guard: hold this batch, keep the existing snapshot live.
        await supabase.from('transaction_upload_batches')
          .update({ status: 'reverted', notes: `HELD — covers ${batch.account_count} accounts vs the current snapshot's ${maxPrior}. Looks like a partial/truncated file, so it was not applied. Re-upload the full ledger, or resubmit with force=1 if intentional.` })
          .eq('id', batch.id);
        held = { new_account_count: batch.account_count, current_snapshot_account_count: maxPrior };
      } else {
        for (const p of (priors || [])) {
          await supabase.from('transaction_upload_batches')
            .update({ status: 'reverted', notes: `Superseded by "${periodLabel}" (batch ${batch.id}) on ${new Date().toISOString().slice(0, 10)}.` })
            .eq('id', p.id);
          superseded.push({ id: p.id, period_label: p.period_label, as_of_date: p.as_of_date, account_count: p.account_count });
        }
      }
    } catch (e) { console.warn('[transactions/upload] snapshot supersede failed:', e.message); }

    res.json({
      batch,
      superseded,   // prior snapshot(s) reverted so balances don't double
      held,         // set when the load was NOT applied (partial-load guard); resubmit with force=1 to override
      warning: held ? `NOT applied: this file covers ${held.new_account_count} accounts but the current snapshot has ${held.current_snapshot_account_count}. It looks partial, so the board still shows the prior snapshot. Re-upload the full ledger, or resubmit with force to override.` : null,
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
// GET /batches/:id/reconcile — does this snapshot TIE OUT, and what needs to be
// addressed? Compares account count to the community's home count (Ed's cross-
// check: Waterview is 1,171 homes but the file had 1,296 accounts), confirms each
// account's summed transactions equal the file's own running balance, and lists
// the accounts that carry a balance but don't map to a home. (Ed 2026-08-10 —
// "make sure everything ties out and we know what needs to be addressed".)
// ----------------------------------------------------------------------------
router.get('/batches/:id/reconcile', async (req, res) => {
  try {
    const { fetchAllQuery } = require('../lib/db/fetch_all');
    const { data: batch, error: bErr } = await supabase.from('transaction_upload_batches')
      .select('id, community_id, period_label, as_of_date, account_count, status').eq('id', req.params.id).maybeSingle();
    if (bErr) throw bErr;
    if (!batch) return res.status(404).json({ error: 'batch_not_found' });

    const { count: homeCount } = await supabase.from('properties')
      .select('id', { count: 'exact', head: true }).eq('community_id', batch.community_id);

    const rows = await fetchAllQuery(() => supabase.from('homeowner_transactions')
      .select('vantaca_account_id, property_id, amount_cents, running_balance_cents, source_row_index')
      .eq('source_batch_id', batch.id), { orderBy: 'source_row_index' });

    // Roll each account up to summed balance + the file's last running balance.
    const byAcct = new Map();
    for (const r of rows) {
      const k = r.vantaca_account_id || `__row_${r.source_row_index}`;
      let a = byAcct.get(k);
      if (!a) { a = { sum: 0, last: null, lastIdx: -1, property_id: r.property_id }; byAcct.set(k, a); }
      a.sum += Number(r.amount_cents || 0);
      if (r.source_row_index > a.lastIdx) { a.lastIdx = r.source_row_index; a.last = r.running_balance_cents; a.property_id = r.property_id; }
    }

    let tieMismatch = 0, totalNet = 0, matchedNet = 0, matchedCount = 0;
    const unmatchedWithBalance = [];
    let unmatchedZero = 0;
    for (const [acct, a] of byAcct) {
      totalNet += a.sum;
      if (a.last != null && Math.abs(a.sum - Number(a.last)) > 1) tieMismatch++;
      if (a.property_id) { matchedCount++; matchedNet += a.sum; }
      else if (Math.abs(a.last || a.sum || 0) > 1) unmatchedWithBalance.push({ vantaca_account_id: acct, balance_cents: Number(a.last != null ? a.last : a.sum) });
      else unmatchedZero++;
    }
    unmatchedWithBalance.sort((x, y) => Math.abs(y.balance_cents) - Math.abs(x.balance_cents));
    const unmatchedBalanceTotal = unmatchedWithBalance.reduce((s, u) => s + u.balance_cents, 0);

    res.json({
      batch: { id: batch.id, period_label: batch.period_label, as_of_date: batch.as_of_date, status: batch.status },
      home_count: homeCount || 0,
      account_count: byAcct.size,
      accounts_over_homes: byAcct.size - (homeCount || 0),
      matched_to_home: matchedCount,
      unmatched_with_balance: unmatchedWithBalance.length,
      unmatched_zero_balance: unmatchedZero,
      unmatched_balance_total_cents: unmatchedBalanceTotal,
      ties_out: tieMismatch === 0,
      tie_mismatches: tieMismatch,               // accounts where summed txns != file running balance
      total_net_cents: totalNet,                 // whole ledger (all accounts)
      matched_net_cents: matchedNet,             // only what maps to a home (what the board sees)
      unmatched_accounts: unmatchedWithBalance.slice(0, 500),
    });
  } catch (err) {
    console.error('[transactions/reconcile] failed:', err.message);
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
