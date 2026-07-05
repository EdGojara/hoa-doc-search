#!/usr/bin/env node
// ===========================================================================
// import_budget.js  (Ed 2026-07-05)
// ---------------------------------------------------------------------------
// Import an HOA annual budget into community_budgets + budget_line_items.
// Two input shapes, one reconcile+write pipeline:
//   * .xls / .xlsx — Vantaca "Budget" export (Annual + 12 monthly columns)
//   * .pdf         — any budget PDF, via the Claude extractor used by the app
//                    (lib/accounting/budget_pdf_extractor). Annual-only PDFs
//                    come back evenly split across 12 months; monthly PDFs keep
//                    their shape.
// Every line's 12 months are normalized to sum EXACTLY to its annual before
// writing (Ed: "the total always equals the yearly budget"). Accounts missing
// from the chart are created in the Operating fund. Dry-run by default.
//
//   node -r dotenv/config scripts/import_budget.js "<community>" "<file>" [--apply]
// ===========================================================================
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const commQuery = process.argv[2];
const FILE = process.argv[3];

// "$85,619" / "($13,667)" / " - " / "$0" -> cents (int, signed).
function cents(v) {
  let t = String(v == null ? '' : v).trim();
  if (t === '' || t === '-' || /^\s*-\s*$/.test(t)) return 0;
  const neg = /^\(/.test(t) || /^-/.test(t);
  t = t.replace(/[^0-9.]/g, '');
  const n = parseFloat(t) || 0;
  return Math.round((neg ? -n : n) * 100);
}

// revenue/income -> credit ; expense -> debit ; else null (flag for manual)
function typeFrom(hint, acctNum) {
  const h = String(hint || '').toLowerCase();
  if (/rev|inc/.test(h)) return { account_type: 'revenue', normal_balance: 'credit' };
  if (/exp/.test(h)) return { account_type: 'expense', normal_balance: 'debit' };
  const lead = String(acctNum || '')[0];
  if (lead === '4') return { account_type: 'revenue', normal_balance: 'credit' };
  if (lead === '5' || lead === '6') return { account_type: 'expense', normal_balance: 'debit' };
  return { account_type: null, normal_balance: null };
}

// ---- parse: Vantaca XLS/XLSX (structural) --------------------------------
function parseXls() {
  const wb = XLSX.readFile(FILE);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });

  let hdrRow = -1, fiscalYear = null;
  for (let i = 0; i < Math.min(12, aoa.length); i++) {
    const row = (aoa[i] || []).map((c) => String(c || ''));
    if (row.some((c) => /Fiscal year/i.test(c))) { const m = row.join(' ').match(/(\d{4})/); if (m) fiscalYear = Number(m[1]); }
    if (row.includes('Annual') && row.includes('Jan')) hdrRow = i;
  }
  if (hdrRow < 0) throw new Error('could not find header row (Annual + Jan)');
  const hdr = aoa[hdrRow].map((c) => String(c || '').trim());
  const annualCol = hdr.indexOf('Annual');
  // Merged-cell headers don't align with data columns — detect the 12 month
  // value-columns from the first account row with exactly 12 non-empty cells
  // after the Annual column.
  let monthCols = null;
  for (let i = hdrRow + 1; i < aoa.length && !monthCols; i++) {
    const r = aoa[i] || [];
    if (!/^\d{3,5}\s*-/.test(String(r[0] || ''))) continue;
    const cols = [];
    for (let ci = annualCol + 1; ci < r.length; ci++) if (r[ci] != null && String(r[ci]).trim() !== '') cols.push(ci);
    if (cols.length === 12) monthCols = cols;
  }
  if (!monthCols) throw new Error('could not detect 12 month value columns');
  console.log(`fiscal year: ${fiscalYear} | annual col ${annualCol} | month value cols ${monthCols.join(',')}`);

  const lines = [];
  for (let i = hdrRow + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const m = String(r[0] || '').trim().match(/^(\d{3,5})\s*-\s*(.+)/);
    if (!m) continue;
    const annual = cents(r[annualCol]);
    const monthly = monthCols.map((c) => cents(r[c]));
    if (annual === 0 && monthly.reduce((s, x) => s + x, 0) === 0) continue;
    lines.push({ account_number: m[1], name: m[2].trim(), account_type_hint: null, annual_amount_cents: annual, monthly_raw: monthly });
  }
  return { fiscalYear, lines, warnings: [] };
}

// ---- parse: budget PDF (Claude extractor) --------------------------------
async function parsePdf() {
  const { extractBudget } = require('../lib/accounting/budget_pdf_extractor');
  const buf = fs.readFileSync(FILE);
  const ex = await extractBudget(buf, 'application/pdf', path.basename(FILE));
  const lines = (ex.line_items || []).map((li) => {
    const annual = Number(li.annual_amount_cents) || 0;
    let monthly = Array.isArray(li.monthly_amounts_cents) ? li.monthly_amounts_cents.map((n) => Number(n) || 0) : [];
    if (monthly.length !== 12) monthly = []; // let normalize even-split it
    return { account_number: String(li.account_number || '').trim(), name: li.account_name || '', account_type_hint: li.account_type || null, annual_amount_cents: annual, monthly_raw: monthly };
  }).filter((l) => l.account_number && (l.annual_amount_cents !== 0 || l.monthly_raw.some((x) => x !== 0)));
  return { fiscalYear: ex.fiscal_year || null, lines, warnings: ex.warnings || [] };
}

// Normalize 12 monthly values so they sum EXACTLY to annual (park residual in
// the largest-magnitude month). Empty monthly => even 1/12 split.
function normalizeMonths(monthly, annual) {
  let m = (Array.isArray(monthly) && monthly.length === 12) ? monthly.slice() : null;
  if (!m) { const e = Math.trunc(annual / 12); m = Array(12).fill(e); }
  const sum = m.reduce((s, x) => s + x, 0);
  if (annual === 0 || sum === annual) return { monthly: m, drift: 0 };
  let li = 0, lm = -1;
  m.forEach((v, idx) => { if (Math.abs(v) > lm) { lm = Math.abs(v); li = idx; } });
  m[li] += (annual - sum);
  return { monthly: m, drift: annual - sum };
}

(async () => {
  if (!commQuery || !FILE) { console.error('usage: "<community>" "<file>" [--apply]'); process.exit(1); }
  const { data: comm } = await sb.from('communities').select('id, name').ilike('name', `%${commQuery}%`).limit(1).maybeSingle();
  if (!comm) { console.error('community not found:', commQuery); process.exit(1); }
  console.log('community:', comm.name, '| file:', path.basename(FILE));

  const isPdf = /\.pdf$/i.test(FILE);
  const parsed = isPdf ? await parsePdf() : parseXls();
  const fiscalYear = parsed.fiscalYear;
  if (!fiscalYear) { console.error('could not determine fiscal year from the file'); process.exit(1); }
  if (parsed.warnings.length) parsed.warnings.forEach((w) => console.log('  ⚠ extractor:', w));

  // Chart of accounts — match by account_number OR vantaca_account_number.
  const coa = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await sb.from('chart_of_accounts').select('id, account_number, account_name, vantaca_account_number, fund_id').eq('community_id', comm.id).range(f, f + 999); if (error) { console.error('CoA fetch failed:', error.message); process.exit(1); } coa.push(...(data || [])); if (!data || data.length < 1000) break; }
  const byNum = {};
  coa.forEach((a) => { if (a.account_number != null) byNum[String(a.account_number)] = a; if (a.vantaca_account_number != null) byNum[String(a.vantaca_account_number)] = a; });

  const fundCounts = {};
  coa.forEach((a) => { if (a.fund_id) fundCounts[a.fund_id] = (fundCounts[a.fund_id] || 0) + 1; });
  const operatingFundId = Object.keys(fundCounts).sort((x, y) => fundCounts[y] - fundCounts[x])[0] || null;

  const lines = [], toCreate = [];
  const createIdx = {};
  let maxDrift = 0;
  for (const pl of parsed.lines) {
    const norm = normalizeMonths(pl.monthly_raw, pl.annual_amount_cents);
    if (Math.abs(norm.drift) > maxDrift) maxDrift = Math.abs(norm.drift);
    let a = byNum[pl.account_number];
    if (!a) {
      if (!createIdx[pl.account_number]) {
        const t = typeFrom(pl.account_type_hint, pl.account_number);
        const spec = { account_number: pl.account_number, account_name: pl.name, account_type: t.account_type, normal_balance: t.normal_balance };
        createIdx[pl.account_number] = spec; toCreate.push(spec);
      }
      a = { __pending: createIdx[pl.account_number] };
    }
    lines.push({ account: a, account_number: pl.account_number, name: pl.name, annual_amount_cents: pl.annual_amount_cents, monthly_amounts_cents: norm.monthly });
  }

  const unmatched = toCreate.filter((s) => !s.account_type);
  console.log(`\nparsed ${lines.length} budget lines | will create: ${toCreate.length} | uninferable: ${unmatched.length}`);
  console.log(`  max month→annual drift corrected: $${(maxDrift / 100).toFixed(2)} (parked in largest month per line so each ties)`);
  if (toCreate.length) { console.log('  ACCOUNTS TO CREATE in Operating fund:'); toCreate.forEach((s) => console.log(`    ${s.account_number} - ${s.account_name}  [${s.account_type || 'UNKNOWN — needs manual placement'}]`)); }
  const totAnnual = lines.reduce((s, l) => s + l.annual_amount_cents, 0);
  const totMonths = lines.reduce((s, l) => s + l.monthly_amounts_cents.reduce((a, b) => a + b, 0), 0);
  const revT = lines.filter((l) => typeFrom((l.account.account_type || (l.account.__pending && l.account.__pending.account_type)), l.account_number).account_type === 'revenue').reduce((s, l) => s + l.annual_amount_cents, 0);
  console.log(`  total annual across all lines: $${(totAnnual / 100).toLocaleString()}`);
  console.log(`  total of all monthly values:   $${(totMonths / 100).toLocaleString()}  ${totMonths === totAnnual ? '✓ ties' : '✗ DOES NOT TIE'}`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write the budget (creates missing accounts first).'); return; }
  if (unmatched.length) { console.error('Refusing to write: accounts with un-inferable type. Add them to the chart manually first.'); process.exit(1); }
  if (!operatingFundId) { console.error('Refusing to write: could not determine the Operating fund_id (empty chart).'); process.exit(1); }

  for (const spec of toCreate) {
    const { data: created, error } = await sb.from('chart_of_accounts').insert({
      community_id: comm.id, fund_id: operatingFundId, account_number: spec.account_number,
      account_name: spec.account_name, account_type: spec.account_type, normal_balance: spec.normal_balance,
      is_summary: false, is_active: true, description: 'Created by budget import ' + path.basename(FILE),
    }).select('id, fund_id').single();
    if (error) { console.error(`account create failed (${spec.account_number}):`, error.message); process.exit(1); }
    spec.__id = created.id; spec.__fund = created.fund_id;
    console.log(`  created account ${spec.account_number} ${spec.account_name} -> ${created.id}`);
  }
  lines.forEach((l) => {
    if (l.account.__pending) { l.account_id = l.account.__pending.__id; l.fund_id = l.account.__pending.__fund; }
    else { l.account_id = l.account.id; l.fund_id = l.account.fund_id || operatingFundId; }
  });

  const { data: existing } = await sb.from('community_budgets').select('id').eq('community_id', comm.id).eq('fiscal_year', fiscalYear).maybeSingle();
  let budgetId = existing && existing.id;
  if (budgetId) { await sb.from('budget_line_items').delete().eq('budget_id', budgetId); await sb.from('community_budgets').update({ status: 'draft', source_filename: path.basename(FILE) }).eq('id', budgetId); }
  else {
    const { data: b, error } = await sb.from('community_budgets').insert({ community_id: comm.id, fiscal_year: fiscalYear, status: 'draft', source_filename: path.basename(FILE) }).select('id').single();
    if (error) { console.error('budget insert failed:', error.message); process.exit(1); }
    budgetId = b.id;
  }
  const rows = lines.map((l) => ({ budget_id: budgetId, account_id: l.account_id, fund_id: l.fund_id, annual_amount_cents: l.annual_amount_cents, monthly_amounts_cents: l.monthly_amounts_cents }));
  for (let i = 0; i < rows.length; i += 200) { const { error } = await sb.from('budget_line_items').insert(rows.slice(i, i + 200)); if (error) { console.error('line insert failed:', error.message); process.exit(1); } }
  console.log(`\nAPPLIED: budget ${budgetId} — ${rows.length} lines, FY${fiscalYear}.`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
