// ============================================================================
// api/gl.js — read endpoints for the General Ledger.
// ----------------------------------------------------------------------------
// Powers the Accounting screen: community picker, chart of accounts, trial
// balance (from v_trial_balance), per-homeowner ledgers (from
// v_owner_ar_balance), and recent journal entries. Read-only for now — posting
// comes in a later slice. Staff-scoped (bare paths require the staff cookie via
// server.js, same as the other admin modules).
// ============================================================================
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Communities that have a GL stood up (an account_funds row exists).
router.get('/communities', async (req, res) => {
  try {
    const { data: funds, error } = await supabase.from('account_funds').select('community_id').eq('is_active', true);
    if (error) throw error;
    const ids = [...new Set((funds || []).map((f) => f.community_id))];
    if (!ids.length) return res.json({ communities: [] });
    const { data: comms } = await supabase.from('communities').select('id, name, slug').in('id', ids).order('name');
    res.json({ communities: comms || [] });
  } catch (err) {
    console.error('[gl] communities failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/chart-of-accounts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number, account_name, account_type, account_subtype, normal_balance, is_active, fund_id, account_funds:fund_id(fund_code, fund_name)')
      .eq('community_id', req.params.communityId)
      .order('account_number');
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) {
    console.error('[gl] chart-of-accounts failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/trial-balance', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_trial_balance')
      .select('account_number, account_name, account_type, normal_balance, fund_code, fund_name, total_debits_cents, total_credits_cents, balance_cents')
      .eq('community_id', req.params.communityId)
      .order('account_number');
    if (error) throw error;
    const rows = data || [];
    const totals = rows.reduce((a, r) => ({
      debits: a.debits + Number(r.total_debits_cents || 0),
      credits: a.credits + Number(r.total_credits_cents || 0),
    }), { debits: 0, credits: 0 });
    res.json({ rows, totals, balanced: totals.debits === totals.credits });
  } catch (err) {
    console.error('[gl] trial-balance failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Per-homeowner ledgers: current balance + aging, joined to the property address.
router.get('/:communityId/homeowner-ledgers', async (req, res) => {
  try {
    const cid = req.params.communityId;
    // Paginated — a community can exceed the 1000-row PostgREST cap.
    const bals = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('v_owner_ar_balance')
        .select('property_id, open_charge_count, total_balance_cents, bucket_current_cents, bucket_1_30_cents, bucket_31_60_cents, bucket_61_90_cents, bucket_91_120_cents, bucket_over_120_cents, max_days_past_due')
        .eq('community_id', cid)
        .order('property_id')
        .range(from, from + 999);
      if (error) throw error;
      bals.push(...(data || []));
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    // All properties (so $0 owners show too), with current owner name/address.
    const props = [];
    let pf = 0;
    while (true) {
      const { data, error } = await supabase
        .from('v_current_property_owners')
        .select('property_id, street_address, owner_name')
        .eq('community_id', cid)
        .order('property_id')
        .range(pf, pf + 999);
      if (error) throw error;
      props.push(...(data || []));
      if (!data || data.length < 1000) break;
      pf += 1000;
    }
    const balByProp = Object.fromEntries(bals.map((b) => [b.property_id, b]));
    const ledgers = props.map((p) => {
      const b = balByProp[p.property_id] || {};
      return {
        property_id: p.property_id,
        street_address: p.street_address,
        owner_name: p.owner_name,
        balance_cents: Number(b.total_balance_cents || 0),
        open_charge_count: b.open_charge_count || 0,
        max_days_past_due: b.max_days_past_due || 0,
      };
    }).sort((a, b) => b.balance_cents - a.balance_cents || (a.street_address || '').localeCompare(b.street_address || ''));
    const totalOutstanding = ledgers.reduce((s, l) => s + l.balance_cents, 0);
    res.json({ ledgers, count: ledgers.length, total_outstanding_cents: totalOutstanding });
  } catch (err) {
    console.error('[gl] homeowner-ledgers failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/journal-entries', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { data, error } = await supabase
      .from('journal_entries')
      .select('reference, posting_date, description, source_module, total_debits_cents, status')
      .eq('community_id', req.params.communityId)
      .order('posting_date', { ascending: false })
      .order('reference', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ journal_entries: data || [] });
  } catch (err) {
    console.error('[gl] journal-entries failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Rolling N-month income statement (Ed's own-review tool). JSON by default;
// ?format=html returns a printable report with each P&L account as monthly
// columns and any ZERO month flagged (a data gap, or the pre-cutover boundary).
//   GET /:communityId/rolling-income-statement?end=2026-06-30&months=12[&format=html]
// ----------------------------------------------------------------------------
router.get('/:communityId/rolling-income-statement', async (req, res) => {
  try {
    const { rollingIncomeStatement } = require('../lib/accounting/financial_statements');
    const end_date = req.query.end || _today();
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);
    const data = await rollingIncomeStatement({ community_id: req.params.communityId, end_date, months });
    if (req.query.format !== 'html') return res.json(data);

    const { data: comm } = await supabase.from('communities').select('name').eq('id', req.params.communityId).maybeSingle();
    const fmt = (c) => { const n = Number(c || 0) / 100; return (n < 0 ? '(' : '') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) + (n < 0 ? ')' : ''); };
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const mLabel = (ym) => { const [y, m] = ym.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] + " '" + y.slice(2); };
    const zero = new Set(data.zero_months);
    const th = data.months.map((m) => `<th class="${zero.has(m) ? 'z' : ''}">${mLabel(m)}</th>`).join('');
    const rowHtml = (r) => `<tr><td class="acct">${esc(r.account_number)} ${esc(r.account_name)}</td>${data.months.map((m) => `<td class="${zero.has(m) ? 'z' : ''}">${r.by_month[m] ? fmt(r.by_month[m]) : '·'}</td>`).join('')}<td class="tot">${fmt(r.total_cents)}</td></tr>`;
    const totRow = (label, key, cls) => `<tr class="${cls}"><td class="acct">${label}</td>${data.monthly.map((m) => `<td class="${zero.has(m.month) ? 'z' : ''}">${fmt(m[key])}</td>`).join('')}<td class="tot">${fmt(data.monthly.reduce((s, m) => s + m[key], 0))}</td></tr>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(comm ? comm.name : '')} — Rolling ${months}-Month Income Statement</title>
<style>body{font:13px -apple-system,Arial,sans-serif;color:#0B1D34;margin:24px;}h1{font-size:18px;margin:0 0 2px;}.sub{color:#6b7a8d;margin:0 0 16px;}
.wrap{overflow-x:auto;border:1px solid #e3e8ef;border-radius:8px;}table{border-collapse:collapse;white-space:nowrap;}
th,td{padding:6px 10px;text-align:right;border-bottom:1px solid #eef2f6;font-variant-numeric:tabular-nums;}
th{background:#0B1D34;color:#fff;position:sticky;top:0;font-weight:600;}td.acct,th:first-child{text-align:left;position:sticky;left:0;background:#fff;min-width:230px;}
th:first-child{background:#0B1D34;}.tot{font-weight:700;background:#f7f9fc;}.z{background:#fdecec;color:#b42318;}
tr.section td{background:#eef2f6;font-weight:700;} tr.net td{border-top:2px solid #0B1D34;font-weight:700;background:#f0f6ff;}
.flag{margin:14px 0;padding:10px 14px;border-radius:8px;background:#fdecec;color:#b42318;font-weight:600;} .ok{background:#eaf7ee;color:#1a7f37;}</style></head>
<body><h1>${esc(comm ? comm.name : '')} — Rolling ${months}-Month Income Statement</h1>
<p class="sub">Through ${esc(data.to_date)} · each column a month · red = no activity posted</p>
<div class="${data.zero_months.length ? 'flag' : 'flag ok'}">${data.zero_months.length ? `${data.zero_months.length} month(s) with zero activity: ${data.zero_months.map(mLabel).join(', ')} — pre-cutover boundary if before the community's migration, otherwise a data gap to investigate.` : 'Every month has activity — no gaps.'}</div>
<div class="wrap"><table><thead><tr><th>Account</th>${th}<th class="tot">Total</th></tr></thead><tbody>
<tr class="section"><td class="acct">REVENUE</td>${data.months.map(() => '<td></td>').join('')}<td></td></tr>
${data.revenue.map(rowHtml).join('')}
${totRow('Total Revenue', 'revenue_cents', 'section')}
<tr class="section"><td class="acct">EXPENSE</td>${data.months.map(() => '<td></td>').join('')}<td></td></tr>
${data.expense.map(rowHtml).join('')}
${totRow('Total Expense', 'expense_cents', 'section')}
${totRow('NET INCOME', 'net_cents', 'net')}
</tbody></table></div></body></html>`;
    res.set('Content-Type', 'text/html').send(html);
  } catch (err) {
    console.error('[gl] rolling-income-statement failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Aging helper — days past due → bucket. Shared by AR + AP.
// ----------------------------------------------------------------------------
const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd91_120', 'd120_plus'];
function _agingBucket(dueDate, asOf) {
  if (!dueDate) return 'current';
  const due = Date.parse(String(dueDate).slice(0, 10));
  const now = Date.parse(asOf);
  if (Number.isNaN(due)) return 'current';
  const days = Math.floor((now - due) / 86400000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  if (days <= 120) return 'd91_120';
  return 'd120_plus';
}
const _emptyBuckets = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
const _today = () => new Date().toISOString().slice(0, 10);

async function _fetchAll(table, cols, filters) {
  const out = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(cols).order(String(cols).split(',')[0].trim().split(" ")[0] || 'id').range(from, from + 999);
    for (const [k, v] of Object.entries(filters || {})) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

// Categorize a Vantaca transaction description into an AR category + label +
// Texas Property Code §209.0063 payment-application priority (lower = applied
// first): assessments → assessment-related attorney/collection fees → fines →
// everything else (interest, late fees, certified fees, admin, NSF).
function _categorizeVantacaCharge(desc) {
  const d = String(desc || '');
  if (/assessment/i.test(d) && !/late/i.test(d))            return { category: 'assessment', label: 'Assessment', priority: 1 };
  if (/(prior balance|balance forward)/i.test(d) && !/(interest|fine|legal|admin|fee)/i.test(d)) return { category: 'assessment', label: 'Prior Balance', priority: 1 };
  if (/(legal|attorney|collection)/i.test(d))               return { category: 'attorney_fee', label: 'Legal / Collections', priority: 3 };
  if (/fine/i.test(d))                                       return { category: 'fine', label: 'Fine', priority: 5 };
  if (/certified/i.test(d))                                  return { category: 'certified', label: 'Certified Fee', priority: 6 };
  if (/interest/i.test(d))                                   return { category: 'interest', label: 'Interest', priority: 6 };
  if (/late fee/i.test(d))                                   return { category: 'late_fee', label: 'Late Fee', priority: 6 };
  if (/(nsf|bank return|stop payment)/i.test(d))             return { category: 'nsf_fee', label: 'NSF / Returned', priority: 6 };
  if (/payment plan/i.test(d))                              return { category: 'other', label: 'Payment Plan Fee', priority: 6 };
  if (/admin/i.test(d))                                      return { category: 'other', label: 'Administrative Fee', priority: 6 };
  return { category: 'other', label: (d.split(/[-:]/)[0] || 'Other').trim().slice(0, 30) || 'Other', priority: 9 };
}

// Compute open AR charges from the migrated Vantaca subledger
// (homeowner_transactions) for communities that don't use the native ar_charges
// table. Applies each owner's payments/credits in §209.0063 order (priority,
// then oldest first) and returns the still-open charges shaped like ar_charges
// rows so the aging endpoint's aggregation is identical for both sources.
// Scope: current owners only (property_id present) — the aging screen is the
// live roster; sold/inactive stale balances are a separate write-off track.
async function _openChargesFromTransactions(cid, propertyId = null) {
  // Only COMMITTED batches — the balance view (v_homeowner_current_balance)
  // sums committed batches only, so we must match it or a reverted/draft batch
  // (e.g. Waterview's double-counted batch that was reverted) inflates the total
  // and it won't reconcile.
  const committed = await _fetchAll('transaction_upload_batches', 'id', { community_id: cid, status: 'committed' });
  const committedIds = new Set((committed || []).map((b) => b.id));
  if (!committedIds.size) return [];
  // Page in a STABLE order (by id) — .range() without an ORDER BY drifts across
  // pages on large tables (Waterview's 13k txns were non-deterministic between
  // runs). Financial reads must be deterministic. propertyId narrows to one
  // owner (fast path for the account-detail screen).
  const txns = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('homeowner_transactions')
      .select('property_id, vantaca_account_id, transaction_date, description, txn_type, amount_cents, source_batch_id')
      .eq('community_id', cid);
    if (propertyId) q = q.eq('property_id', propertyId);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    txns.push(...(data || []).filter((t) => committedIds.has(t.source_batch_id)));
    if (!data || data.length < 1000) break;
  }
  const byOwner = new Map();
  for (const t of txns) {
    if (!t.property_id) continue; // current-owner roster only
    if (!byOwner.has(t.property_id)) byOwner.set(t.property_id, { charges: [], credit: 0 });
    const o = byOwner.get(t.property_id);
    const amt = Number(t.amount_cents) || 0;
    if (amt > 0 && t.txn_type !== 'payment') {
      const c = _categorizeVantacaCharge(t.description);
      o.charges.push({ ...c, date: (t.transaction_date || '').slice(0, 10), amount: amt });
    } else {
      o.credit += Math.abs(amt); // payments + negative credits reduce the balance
    }
  }
  const open = [];
  for (const [propertyId, o] of byOwner) {
    o.charges.sort((a, b) => (a.priority - b.priority) || String(a.date).localeCompare(String(b.date)));
    let left = o.credit;
    for (const ch of o.charges) { const applied = Math.min(ch.amount, Math.max(0, left)); ch.remaining = ch.amount - applied; left -= applied; }
    for (const ch of o.charges) {
      if (ch.remaining <= 0) continue;
      open.push({
        property_id: propertyId,
        balance_remaining_cents: ch.remaining,
        due_date: ch.date,
        ar_charge_types: { category: ch.category, display_name: ch.label },
      });
    }
  }
  return open;
}

// ----------------------------------------------------------------------------
// AR aging — per homeowner, broken out by charge CATEGORY (assessment, late
// fee, interest, certified/attorney fees, etc.) and aged by due date.
// ----------------------------------------------------------------------------
async function computeArAging(cid, asOf) {
    asOf = asOf || _today();
    const charges = await _fetchAll('ar_charges',
      'property_id, charge_type_id, balance_remaining_cents, due_date, status, ar_charge_types:charge_type_id(category, display_name)',
      { community_id: cid, status: 'open' });
    let open = charges.filter((c) => Number(c.balance_remaining_cents) > 0);
    // Migrated communities keep their AR in the Vantaca subledger
    // (homeowner_transactions) + the GL, not the native ar_charges table. When
    // ar_charges is empty, compute the aging from that migrated subledger so the
    // AR that's already reconciled to the GL actually shows.
    let ar_source = 'ar_charges';
    if (open.length === 0) {
      const fromTxns = await _openChargesFromTransactions(cid);
      if (fromTxns.length) { open = fromTxns; ar_source = 'homeowner_transactions'; }
    }

    const categories = new Set();
    const byCategory = {};       // category -> { label, total, buckets }
    const byProp = {};           // property_id -> { total, by_category{}, buckets, oldest_days }
    let grandTotal = 0;
    const totalBuckets = _emptyBuckets();

    for (const c of open) {
      const cat = (c.ar_charge_types && c.ar_charge_types.category) || 'other';
      const label = (c.ar_charge_types && c.ar_charge_types.display_name) || cat;
      const bal = Number(c.balance_remaining_cents);
      const bucket = _agingBucket(c.due_date, asOf);
      categories.add(cat);
      grandTotal += bal;
      totalBuckets[bucket] += bal;

      if (!byCategory[cat]) byCategory[cat] = { category: cat, label, total: 0, buckets: _emptyBuckets() };
      byCategory[cat].total += bal; byCategory[cat].buckets[bucket] += bal;

      if (!byProp[c.property_id]) byProp[c.property_id] = { property_id: c.property_id, total: 0, by_category: {}, buckets: _emptyBuckets(), oldest_days: 0 };
      const p = byProp[c.property_id];
      p.total += bal; p.by_category[cat] = (p.by_category[cat] || 0) + bal; p.buckets[bucket] += bal;
      const days = Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(c.due_date).slice(0, 10))) / 86400000));
      if (days > p.oldest_days) p.oldest_days = days;
    }

    // Join property addresses + owner names.
    const owners = await _fetchAll('v_current_property_owners', 'property_id, street_address, owner_name', { community_id: cid });
    const ownerByProp = Object.fromEntries(owners.map((o) => [o.property_id, o]));
    // Collection state per account (status badge + bankruptcy flag). Defensive:
    // the code can deploy before migration 232 creates the table — degrade to
    // "no collections" rather than 500 the whole aging screen.
    let collByProp = {};
    try {
      const coll = await _fetchAll('ar_account_collections', 'property_id, collection_status, status_since, bankruptcy_petition_date', { community_id: cid });
      collByProp = Object.fromEntries(coll.map((c) => [c.property_id, c]));
    } catch (e) { console.warn('[gl] collections table not ready:', e.message); }
    const homeowners = Object.values(byProp).map((p) => ({
      ...p,
      street_address: (ownerByProp[p.property_id] || {}).street_address || '—',
      owner_name: (ownerByProp[p.property_id] || {}).owner_name || '—',
      collection_status: (collByProp[p.property_id] || {}).collection_status || 'none',
      bankruptcy_petition_date: (collByProp[p.property_id] || {}).bankruptcy_petition_date || null,
    })).sort((a, b) => b.total - a.total);

    const collectionSummary = {};
    for (const h of homeowners) { if (h.collection_status && h.collection_status !== 'none') collectionSummary[h.collection_status] = (collectionSummary[h.collection_status] || 0) + 1; }

    // Former-owner balances — money owed to/by people who left. Surfaced so a
    // stranded balance can't hide. Defensive against the pre-migration window.
    let formerOwners = [];
    try {
      const fo = await _fetchAll('former_owner_balances', 'vantaca_account_id, owner_name, property_address, balance_cents, kind, status, gl_account_number, notes', { community_id: cid, status: 'open' });
      formerOwners = fo.sort((a, b) => Math.abs(Number(b.balance_cents)) - Math.abs(Number(a.balance_cents)));
    } catch (e) { console.warn('[gl] former_owner_balances not ready:', e.message); }

    return {
      as_of: asOf,
      ar_source,
      categories: [...categories],
      summary: { total_cents: grandTotal, by_bucket: totalBuckets, by_category: Object.values(byCategory).sort((a, b) => b.total - a.total) },
      collection_summary: collectionSummary,
      former_owners: formerOwners,
      former_owners_total_cents: formerOwners.reduce((s, f) => s + Number(f.balance_cents), 0),
      homeowners,
      homeowner_count: homeowners.length,
    };
}
router.get('/:communityId/ar-aging', async (req, res) => {
  try {
    res.json(await computeArAging(req.params.communityId, req.query.as_of));
  } catch (err) {
    console.error('[gl] ar-aging failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// AR drill-down — every open charge for one property, by category, with age.
router.get('/:communityId/ar-aging/property/:propertyId', async (req, res) => {
  try {
    const asOf = req.query.as_of || _today();
    const charges = await _fetchAll('ar_charges',
      'id, charge_date, due_date, description, original_amount_cents, balance_remaining_cents, ar_charge_types:charge_type_id(category, display_name)',
      { community_id: req.params.communityId, property_id: req.params.propertyId, status: 'open' });
    // Collection state for this account (status + bankruptcy petition data).
    // Defensive against the pre-migration window (see ar-aging above).
    let collRow = null;
    try {
      const r = await supabase.from('ar_account_collections')
        .select('collection_status, status_since, bankruptcy_petition_date, bankruptcy_chapter, bankruptcy_case_number, bankruptcy_discharge_date, bankruptcy_dismissed_date, notes')
        .eq('community_id', req.params.communityId).eq('property_id', req.params.propertyId).maybeSingle();
      if (r.error) throw r.error;
      collRow = r.data;
    } catch (e) { console.warn('[gl] collections table not ready:', e.message); }
    const collection = collRow || { collection_status: 'none' };
    const petition = collection.bankruptcy_petition_date ? String(collection.bankruptcy_petition_date).slice(0, 10) : null;

    const rows = charges.filter((c) => Number(c.balance_remaining_cents) > 0).map((c) => {
      const chargeDate = String(c.charge_date || c.due_date || '').slice(0, 10);
      // Pre-petition = charge incurred BEFORE the bankruptcy filing (frozen by the
      // automatic stay); post-petition = on/after filing (the debtor's ongoing,
      // collectible obligation). Null when the account isn't in bankruptcy.
      const petition_phase = petition ? (chargeDate < petition ? 'pre_petition' : 'post_petition') : null;
      return {
        charge_date: c.charge_date, due_date: c.due_date, description: c.description,
        category: (c.ar_charge_types && c.ar_charge_types.display_name) || 'other',
        original_cents: Number(c.original_amount_cents), balance_cents: Number(c.balance_remaining_cents),
        days_past_due: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(c.due_date).slice(0, 10))) / 86400000)),
        bucket: _agingBucket(c.due_date, asOf), petition_phase,
      };
    }).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

    const total_cents = rows.reduce((s, r) => s + r.balance_cents, 0);
    // When in bankruptcy, split the ledger into the two legally-distinct buckets.
    const bankruptcy_split = petition ? {
      petition_date: petition,
      pre_petition_cents: rows.filter((r) => r.petition_phase === 'pre_petition').reduce((s, r) => s + r.balance_cents, 0),
      post_petition_cents: rows.filter((r) => r.petition_phase === 'post_petition').reduce((s, r) => s + r.balance_cents, 0),
    } : null;
    res.json({ charges: rows, total_cents, collection, bankruptcy_split });
  } catch (err) {
    console.error('[gl] ar-aging property failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Billing policy — per-community assessment amount, late fee, interest, grace.
// The settings the late-fee/interest run uses. One active row per community.
// ----------------------------------------------------------------------------
const POLICY_FIELDS = ['assessment_cadence', 'assessment_default_amount_cents', 'assessment_due_day_of_month', 'reserve_contribution_pct', 'grace_period_days', 'late_fee_amount_cents', 'late_fee_recurring', 'interest_apr_pct', 'interest_compounding', 'interest_start_days_past_due', 'courtesy_letter_days', 'certified_209_notice_days', 'collections_referral_days', 'notes', 'approved_by_board_at'];

router.get('/:communityId/billing-policy', async (req, res) => {
  try {
    const { data } = await supabase.from('community_billing_policies').select('*')
      .eq('community_id', req.params.communityId).is('effective_end_date', null)
      .order('effective_start_date', { ascending: false }).limit(1).maybeSingle();
    res.json({ policy: data || null });
  } catch (err) {
    console.error('[gl] billing-policy get failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.put('/:communityId/billing-policy', express.json(), async (req, res) => {
  try {
    const cid = req.params.communityId;
    const patch = {};
    for (const f of POLICY_FIELDS) if (req.body[f] !== undefined) patch[f] = req.body[f] === '' ? null : req.body[f];
    const { data: existing } = await supabase.from('community_billing_policies').select('id')
      .eq('community_id', cid).is('effective_end_date', null).maybeSingle();
    let row;
    if (existing) {
      const { data, error } = await supabase.from('community_billing_policies').update(patch).eq('id', existing.id).select().single();
      if (error) throw error; row = data;
    } else {
      const { data, error } = await supabase.from('community_billing_policies').insert({
        community_id: cid, effective_start_date: _today(),
        assessment_default_amount_cents: patch.assessment_default_amount_cents || 0, ...patch,
      }).select().single();
      if (error) throw error; row = data;
    }
    res.json({ ok: true, policy: row });
  } catch (err) {
    console.error('[gl] billing-policy save failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Record a homeowner payment (check / lockbox / online) — record-only.
router.post('/:communityId/owners/:propertyId/payment', express.json(), async (req, res) => {
  try {
    const { recordHomeownerPayment } = require('../lib/accounting/record_payment');
    const r = await recordHomeownerPayment({
      supabase, communityId: req.params.communityId, propertyId: req.params.propertyId,
      amountCents: Math.round(Number(req.body.amount_dollars) * 100), paymentDate: req.body.payment_date,
      source: req.body.source, reference: req.body.reference, dryRun: req.body.dryRun === true,
    });
    res.json(r);
  } catch (err) {
    console.error('[gl] record payment failed:', err.message);
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// Late fee + interest run (and one-click reversal).
router.post('/:communityId/late-fee-run', express.json(), async (req, res) => {
  try {
    const { runLateFeesAndInterest } = require('../lib/accounting/late_fee_interest');
    const r = await runLateFeesAndInterest({ supabase, communityId: req.params.communityId, runMonth: req.body.runMonth, dryRun: req.body.dryRun !== false });
    res.json(r);
  } catch (err) {
    console.error('[gl] late-fee-run failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});
router.post('/:communityId/late-fee-reverse', express.json(), async (req, res) => {
  try {
    const { reverseLateFeesAndInterest } = require('../lib/accounting/late_fee_interest');
    const r = await reverseLateFeesAndInterest({ supabase, communityId: req.params.communityId, runMonth: req.body.runMonth });
    res.json(r);
  } catch (err) {
    console.error('[gl] late-fee-reverse failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Homeowner accounts — search any owner by name or address, pull up the account.
// ----------------------------------------------------------------------------
router.get('/:communityId/owners/search', async (req, res) => {
  try {
    const cid = req.params.communityId;
    const q = (req.query.q || '').trim().toLowerCase();
    const owners = await _fetchAll('v_current_property_owners',
      'property_id, street_address, owner_name, owner_email, owner_phone, vantaca_account_id, trusted_account_number', { community_id: cid });
    const charges = await _fetchAll('ar_charges', 'property_id, balance_remaining_cents', { community_id: cid, status: 'open' });
    const balByProp = {};
    if (charges.length) {
      for (const c of charges) balByProp[c.property_id] = (balByProp[c.property_id] || 0) + Number(c.balance_remaining_cents);
    } else {
      // Migrated community — balances live in the subledger, not ar_charges.
      // Use the SAME computation as AR Aging so every AR screen agrees.
      const openTx = await _openChargesFromTransactions(cid);
      for (const c of openTx) balByProp[c.property_id] = (balByProp[c.property_id] || 0) + Number(c.balance_remaining_cents);
    }
    const coll = await _fetchAll('ar_account_collections', 'property_id, collection_status', { community_id: cid });
    const collByProp = Object.fromEntries(coll.map((c) => [c.property_id, c.collection_status]));
    const matched = (q
      ? owners.filter((o) => (o.owner_name || '').toLowerCase().includes(q) || (o.street_address || '').toLowerCase().includes(q)
          || (o.vantaca_account_id || '').toLowerCase().includes(q) || (o.trusted_account_number || '').toLowerCase().includes(q))
      : owners)
      .map((o) => ({ ...o, balance_cents: balByProp[o.property_id] || 0, collection_status: collByProp[o.property_id] || 'none' }))
      .sort((a, b) => (a.street_address || '').localeCompare(b.street_address || ''))
      .slice(0, 100);
    res.json({ owners: matched, count: matched.length });
  } catch (err) {
    console.error('[gl] owner search failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/owners/:propertyId/account', async (req, res) => {
  try {
    const cid = req.params.communityId, pid = req.params.propertyId, asOf = _today();
    const owner = (await _fetchAll('v_current_property_owners', '*', { community_id: cid, property_id: pid }))[0] || null;
    let charges = (await _fetchAll('ar_charges',
      'charge_date, due_date, description, original_amount_cents, balance_remaining_cents, ar_charge_types:charge_type_id(category, display_name)',
      { community_id: cid, property_id: pid, status: 'open' })).filter((c) => Number(c.balance_remaining_cents) > 0);
    if (!charges.length) {
      // Migrated community — derive this owner's open charges from the subledger.
      charges = (await _openChargesFromTransactions(cid, pid)).map((c) => ({
        charge_date: c.due_date, due_date: c.due_date,
        description: (c.ar_charge_types && c.ar_charge_types.display_name) || 'Charge',
        original_amount_cents: c.balance_remaining_cents, balance_remaining_cents: c.balance_remaining_cents,
        ar_charge_types: c.ar_charge_types,
      }));
    }
    const byCategory = {}; const buckets = _emptyBuckets(); let total = 0;
    const rows = charges.map((c) => {
      const cat = (c.ar_charge_types && c.ar_charge_types.display_name) || 'other';
      const bal = Number(c.balance_remaining_cents); const bucket = _agingBucket(c.due_date, asOf);
      total += bal; buckets[bucket] += bal;
      byCategory[cat] = (byCategory[cat] || 0) + bal;
      return { charge_date: c.charge_date, due_date: c.due_date, description: c.description, category: cat,
        original_cents: Number(c.original_amount_cents), balance_cents: bal,
        days_past_due: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(c.due_date).slice(0, 10))) / 86400000)) };
    }).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    const { data: collRow } = await supabase.from('ar_account_collections')
      .select('collection_status, status_since, bankruptcy_petition_date, bankruptcy_chapter, bankruptcy_case_number, notes')
      .eq('community_id', cid).eq('property_id', pid).maybeSingle();
    const petition = collRow && collRow.bankruptcy_petition_date ? String(collRow.bankruptcy_petition_date).slice(0, 10) : null;
    const bankruptcy_split = petition ? {
      petition_date: petition,
      pre_petition_cents: rows.filter((r) => String(r.charge_date || r.due_date).slice(0, 10) < petition).reduce((s, r) => s + r.balance_cents, 0),
      post_petition_cents: rows.filter((r) => String(r.charge_date || r.due_date).slice(0, 10) >= petition).reduce((s, r) => s + r.balance_cents, 0),
    } : null;
    // Transaction ledger (statement history) — defensive against pre-migration.
    let ledger = [];
    try {
      ledger = await _fetchAll('homeowner_ledger_entries',
        'entry_date, description, charge_cents, payment_cents, running_balance_cents, entry_type, sort_seq',
        { community_id: cid, property_id: pid });
      ledger.sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || '') || (a.sort_seq - b.sort_seq));
    } catch (e) { /* table not present yet */ }
    if (!ledger.length) {
      // Migrated community — the ledger IS the Vantaca transaction history.
      const committed = await _fetchAll('transaction_upload_batches', 'id', { community_id: cid, status: 'committed' });
      const committedIds = new Set((committed || []).map((b) => b.id));
      const txns = (await _fetchAll('homeowner_transactions',
        'transaction_date, description, txn_type, amount_cents, running_balance_cents, source_batch_id',
        { community_id: cid, property_id: pid })).filter((t) => committedIds.has(t.source_batch_id));
      txns.sort((a, b) => (a.transaction_date || '').localeCompare(b.transaction_date || ''));
      ledger = txns.map((t) => {
        const amt = Number(t.amount_cents) || 0;
        const isPayment = t.txn_type === 'payment' || amt < 0;
        return {
          entry_date: t.transaction_date, description: t.description,
          charge_cents: isPayment ? 0 : amt, payment_cents: isPayment ? Math.abs(amt) : 0,
          running_balance_cents: t.running_balance_cents, entry_type: t.txn_type,
        };
      });
    }
    res.json({
      owner, as_of: asOf, total_cents: total,
      by_category: Object.entries(byCategory).map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents),
      buckets, charges: rows, collection: collRow || { collection_status: 'none' }, bankruptcy_split,
      ledger, ledger_through: ledger.length ? ledger[ledger.length - 1].entry_date : null,
    });
  } catch (err) {
    console.error('[gl] owner account failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Homeowner statement — branded PDF rendered from the account + ledger.
router.get('/:communityId/owners/:propertyId/statement', async (req, res) => {
  try {
    const cid = req.params.communityId, pid = req.params.propertyId, asOf = _today();
    const { renderStatementHTML } = require('../lib/accounting/homeowner_statement');
    const puppeteer = require('puppeteer');

    const { data: comm } = await supabase.from('communities').select('name, legal_name').eq('id', cid).maybeSingle();
    const owner = (await _fetchAll('v_current_property_owners', '*', { community_id: cid, property_id: pid }))[0] || {};
    let charges = (await _fetchAll('ar_charges',
      'due_date, charge_date, balance_remaining_cents, ar_charge_types:charge_type_id(display_name)',
      { community_id: cid, property_id: pid, status: 'open' })).filter((c) => Number(c.balance_remaining_cents) > 0);
    if (!charges.length) {
      charges = (await _openChargesFromTransactions(cid, pid)).map((c) => ({
        due_date: c.due_date, charge_date: c.due_date, balance_remaining_cents: c.balance_remaining_cents,
        ar_charge_types: { display_name: (c.ar_charge_types && c.ar_charge_types.display_name) || 'Charge' },
      }));
    }
    const byCategory = {}; const buckets = _emptyBuckets(); let total = 0;
    for (const c of charges) {
      const cat = (c.ar_charge_types && c.ar_charge_types.display_name) || 'Other';
      const bal = Number(c.balance_remaining_cents);
      total += bal; buckets[_agingBucket(c.due_date, asOf)] += bal; byCategory[cat] = (byCategory[cat] || 0) + bal;
    }
    let ledger = [];
    try {
      ledger = await _fetchAll('homeowner_ledger_entries', 'entry_date, description, charge_cents, payment_cents, running_balance_cents, sort_seq', { community_id: cid, property_id: pid });
      ledger.sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || '') || (a.sort_seq - b.sort_seq));
    } catch (e) { /* ledger not loaded */ }
    if (!ledger.length) {
      const committed = await _fetchAll('transaction_upload_batches', 'id', { community_id: cid, status: 'committed' });
      const committedIds = new Set((committed || []).map((b) => b.id));
      const txns = (await _fetchAll('homeowner_transactions', 'transaction_date, description, txn_type, amount_cents, running_balance_cents, source_batch_id', { community_id: cid, property_id: pid })).filter((t) => committedIds.has(t.source_batch_id));
      txns.sort((a, b) => (a.transaction_date || '').localeCompare(b.transaction_date || ''));
      ledger = txns.map((t) => { const amt = Number(t.amount_cents) || 0; const isPayment = t.txn_type === 'payment' || amt < 0; return { entry_date: t.transaction_date, description: t.description, charge_cents: isPayment ? 0 : amt, payment_cents: isPayment ? Math.abs(amt) : 0, running_balance_cents: t.running_balance_cents }; });
    }

    const html = renderStatementHTML({
      owner, communityName: comm ? (comm.legal_name || comm.name) : '', statementDate: asOf, total_cents: total,
      by_category: Object.entries(byCategory).map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents),
      buckets, ledger, ledgerThrough: asOf,
    });

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
      const safe = (owner.street_address || 'statement').replace(/[^a-zA-Z0-9]+/g, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="Statement-${safe}-${asOf}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(pdf));
    } finally { await browser.close(); }
  } catch (err) {
    console.error('[gl] statement failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// AP aging — open vendor invoices grouped by vendor, aged by due date.
// ----------------------------------------------------------------------------
async function computeApAging(cid, asOf) {
    asOf = asOf || _today();
    const invoices = await _fetchAll('ap_invoices',
      'vendor_id, total_cents, amount_paid_cents, due_date, status, vendors:vendor_id(name, category)',
      { community_id: cid });
    const open = invoices.filter((i) => (Number(i.total_cents) - Number(i.amount_paid_cents)) > 0 && !['paid', 'voided'].includes(i.status));

    const byVendor = {};
    let grandTotal = 0;
    const totalBuckets = _emptyBuckets();
    for (const i of open) {
      const bal = Number(i.total_cents) - Number(i.amount_paid_cents);
      const bucket = _agingBucket(i.due_date, asOf);
      const vid = i.vendor_id;
      grandTotal += bal; totalBuckets[bucket] += bal;
      if (!byVendor[vid]) byVendor[vid] = { vendor_id: vid, vendor_name: (i.vendors && i.vendors.name) || '—', category: (i.vendors && i.vendors.category) || null, total: 0, open_count: 0, buckets: _emptyBuckets(), oldest_days: 0 };
      const v = byVendor[vid];
      v.total += bal; v.open_count += 1; v.buckets[bucket] += bal;
      const days = Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(i.due_date || '').slice(0, 10))) / 86400000));
      if (days > v.oldest_days) v.oldest_days = days;
    }
    return {
      as_of: asOf,
      summary: { total_cents: grandTotal, by_bucket: totalBuckets },
      vendors: Object.values(byVendor).sort((a, b) => b.total - a.total),
      vendor_count: Object.keys(byVendor).length,
    };
}
router.get('/:communityId/ap-aging', async (req, res) => {
  try {
    res.json(await computeApAging(req.params.communityId, req.query.as_of));
  } catch (err) {
    console.error('[gl] ap-aging failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:communityId/ap-aging/vendor/:vendorId', async (req, res) => {
  try {
    const asOf = req.query.as_of || _today();
    const invoices = await _fetchAll('ap_invoices',
      'id, vendor_invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, status',
      { community_id: req.params.communityId, vendor_id: req.params.vendorId });
    const rows = invoices.filter((i) => (Number(i.total_cents) - Number(i.amount_paid_cents)) > 0 && !['paid', 'voided'].includes(i.status)).map((i) => ({
      invoice_number: i.vendor_invoice_number, invoice_date: i.invoice_date, due_date: i.due_date,
      total_cents: Number(i.total_cents), balance_cents: Number(i.total_cents) - Number(i.amount_paid_cents),
      days_past_due: Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(String(i.due_date || '').slice(0, 10))) / 86400000)),
      bucket: _agingBucket(i.due_date, asOf),
    })).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    res.json({ invoices: rows, total_cents: rows.reduce((s, r) => s + r.balance_cents, 0) });
  } catch (err) {
    console.error('[gl] ap-aging vendor failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Subledger tie-out — every control account must equal its subledger detail.
// A non-zero difference is a RED FLAG: the GL and the supporting detail have
// drifted (a posting hit one but not the other). This is the standing integrity
// check that makes trustEd trustworthy as the book of record.
// ----------------------------------------------------------------------------
router.get('/:communityId/tie-out', async (req, res) => {
  try {
    const cid = req.params.communityId;
    const tb = await _fetchAll('v_trial_balance', 'account_number, total_debits_cents, total_credits_cents', { community_id: cid });
    // GL balance in the account's natural direction (debit-normal => Dr-Cr).
    const glMag = (acct, normal) => {
      const a = tb.find((x) => x.account_number === acct);
      if (!a) return null;
      const deb = Number(a.total_debits_cents), cr = Number(a.total_credits_cents);
      return normal === 'debit' ? deb - cr : cr - deb;
    };
    // Subledger totals.
    const arCharges = (await _fetchAll('ar_charges', 'balance_remaining_cents', { community_id: cid, status: 'open' }))
      .reduce((a, r) => a + Number(r.balance_remaining_cents), 0);
    const ownerCredits = (await _fetchAll('ar_payments', 'unapplied_balance_cents', { community_id: cid }))
      .reduce((a, r) => a + Number(r.unapplied_balance_cents || 0), 0);
    const apInv = await _fetchAll('ap_invoices', 'total_cents, amount_paid_cents, status', { community_id: cid });
    const apOpen = apInv.filter((i) => !['paid', 'voided'].includes(i.status))
      .reduce((a, i) => a + (Number(i.total_cents) - Number(i.amount_paid_cents)), 0);

    // control account, its normal side, and the subledger it must equal.
    const defs = [
      { account: '1300', label: 'Accounts Receivable', normal: 'debit', subledger: 'Homeowner charges', sub: arCharges },
      { account: '2000', label: 'Accounts Payable', normal: 'credit', subledger: 'Open vendor invoices', sub: apOpen },
      { account: '2400', label: 'Prepaid Owner Assessments', normal: 'credit', subledger: 'Unapplied owner credits', sub: ownerCredits },
    ];
    const controls = defs.map((d) => {
      const gl = glMag(d.account, d.normal);
      const monitored = gl !== null;
      const difference = monitored ? gl - d.sub : null;
      return {
        account: d.account, label: d.label, subledger: d.subledger,
        gl_balance_cents: gl, subledger_balance_cents: d.sub,
        difference_cents: difference,
        status: !monitored ? 'no_gl_account' : (Math.abs(difference) < 1 ? 'tied' : 'broken'),
      };
    });
    const broken = controls.filter((c) => c.status === 'broken');
    res.json({ as_of: _today(), all_tied: broken.length === 0, broken_count: broken.length, controls });
  } catch (err) {
    console.error('[gl] tie-out failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Collections — set/update an account's collection status + bankruptcy data.
// The pre/post-petition ledger split (in the property drill-down) activates
// automatically once bankruptcy_petition_date is set.
// ----------------------------------------------------------------------------
const COLLECTION_STATUSES = ['none', 'late_notice', 'delinquent_reminder', 'certified_demand', 'board_review', 'payment_plan', 'with_attorney', 'bankruptcy', 'lien_filed', 'foreclosure', 'written_off'];
const COLLECTION_FIELDS = ['collection_status', 'status_since', 'bankruptcy_petition_date', 'bankruptcy_chapter', 'bankruptcy_case_number', 'bankruptcy_discharge_date', 'bankruptcy_dismissed_date', 'notes'];

router.patch('/:communityId/collections/:propertyId', async (req, res) => {
  try {
    const { communityId, propertyId } = req.params;
    const patch = { community_id: communityId, property_id: propertyId };
    for (const f of COLLECTION_FIELDS) {
      if (req.body[f] === undefined) continue;
      patch[f] = req.body[f] === '' ? null : req.body[f];
    }
    if (patch.collection_status && !COLLECTION_STATUSES.includes(patch.collection_status)) {
      return res.status(400).json({ error: 'invalid_collection_status' });
    }
    if (patch.bankruptcy_chapter && !['7', '11', '12', '13'].includes(String(patch.bankruptcy_chapter))) {
      return res.status(400).json({ error: 'invalid_bankruptcy_chapter' });
    }
    const { data, error } = await supabase.from('ar_account_collections')
      .upsert(patch, { onConflict: 'community_id,property_id' }).select().single();
    if (error) throw error;
    res.json({ ok: true, collection: data });
  } catch (err) {
    console.error('[gl] collections patch failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// List accounts in collections (status != none), with current balance + owner.
router.get('/:communityId/collections', async (req, res) => {
  try {
    const cid = req.params.communityId;
    const coll = await _fetchAll('ar_account_collections',
      'property_id, collection_status, status_since, bankruptcy_petition_date, bankruptcy_chapter, bankruptcy_case_number, notes',
      { community_id: cid });
    const active = coll.filter((c) => c.collection_status && c.collection_status !== 'none');
    const charges = await _fetchAll('ar_charges', 'property_id, balance_remaining_cents', { community_id: cid, status: 'open' });
    const balByProp = {};
    if (charges.length) {
      for (const c of charges) balByProp[c.property_id] = (balByProp[c.property_id] || 0) + Number(c.balance_remaining_cents);
    } else {
      // Migrated community — balances live in the subledger, not ar_charges.
      // Use the SAME computation as AR Aging so every AR screen agrees.
      const openTx = await _openChargesFromTransactions(cid);
      for (const c of openTx) balByProp[c.property_id] = (balByProp[c.property_id] || 0) + Number(c.balance_remaining_cents);
    }
    const owners = await _fetchAll('v_current_property_owners', 'property_id, street_address, owner_name', { community_id: cid });
    const ownerByProp = Object.fromEntries(owners.map((o) => [o.property_id, o]));
    const rows = active.map((c) => ({
      ...c,
      balance_cents: balByProp[c.property_id] || 0,
      street_address: (ownerByProp[c.property_id] || {}).street_address || '—',
      owner_name: (ownerByProp[c.property_id] || {}).owner_name || '—',
    })).sort((a, b) => b.balance_cents - a.balance_cents);
    res.json({ accounts: rows, count: rows.length });
  } catch (err) {
    console.error('[gl] collections list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Expose the aging computations so other server-side modules (e.g. the board
// packet assembler) can pull the same numbers the /ar-aging and /ap-aging
// endpoints return — single source of truth, no duplicated aging math.
router.computeArAging = computeArAging;
router.computeApAging = computeApAging;

module.exports = router;
