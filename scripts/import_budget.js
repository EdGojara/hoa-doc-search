#!/usr/bin/env node
// ===========================================================================
// import_budget.js  (Ed 2026-07-05)
// ---------------------------------------------------------------------------
// Import a Vantaca "Budget" export (annual + 12 monthly columns per account)
// into community_budgets + budget_line_items. Matches each account by its
// leading number to the community's chart_of_accounts. Reconciles that each
// line's 12 monthly values sum to its annual before writing. Dry-run by default.
//
//   node -r dotenv/config scripts/import_budget.js "<community>" "<file.xls>" [--apply]
// ===========================================================================
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const commQuery = process.argv[2];
const FILE = process.argv[3];

// "$$85,619" / "($13,667)" / " - " / "$0" -> cents (int, signed).
function cents(v) {
  let t = String(v == null ? '' : v).trim();
  if (t === '' || t === '-' || /^\s*-\s*$/.test(t)) return 0;
  const neg = /^\(/.test(t) || /^-/.test(t);
  t = t.replace(/[^0-9.]/g, '');
  const n = parseFloat(t) || 0;
  return Math.round((neg ? -n : n) * 100);
}

(async () => {
  if (!commQuery || !FILE) { console.error('usage: "<community>" "<file.xls>" [--apply]'); process.exit(1); }
  const { data: comm } = await sb.from('communities').select('id, name').ilike('name', `%${commQuery}%`).limit(1).maybeSingle();
  if (!comm) { console.error('community not found:', commQuery); process.exit(1); }
  console.log('community:', comm.name);

  const wb = XLSX.readFile(FILE);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });

  // Locate the header row + the fiscal year.
  let hdrRow = -1, fiscalYear = null;
  for (let i = 0; i < Math.min(12, aoa.length); i++) {
    const row = (aoa[i] || []).map((c) => String(c || ''));
    if (row.some((c) => /Fiscal year/i.test(c))) { const m = row.join(' ').match(/(\d{4})/); if (m) fiscalYear = Number(m[1]); }
    if (row.includes('Annual') && row.includes('Jan')) hdrRow = i;
  }
  if (hdrRow < 0) { console.error('could not find header row (Annual + Jan)'); process.exit(1); }
  const hdr = aoa[hdrRow].map((c) => String(c || '').trim());
  const annualCol = hdr.indexOf('Annual');
  // Merged-cell headers don't align with the data columns, so DETECT the 12
  // month value-columns from the data: the first account row with exactly 12
  // non-empty cells after the Annual column. Those column indices are then read
  // for every row (a "-"/"$0" at that column = 0).
  let monthCols = null;
  for (let i = hdrRow + 1; i < aoa.length && !monthCols; i++) {
    const r = aoa[i] || [];
    if (!/^\d{3,5}\s*-/.test(String(r[0] || ''))) continue;
    const cols = [];
    for (let ci = annualCol + 1; ci < r.length; ci++) if (r[ci] != null && String(r[ci]).trim() !== '') cols.push(ci);
    if (cols.length === 12) monthCols = cols;
  }
  if (!monthCols) { console.error('could not detect 12 month value columns'); process.exit(1); }
  console.log(`fiscal year: ${fiscalYear} | annual col ${annualCol} | month value cols ${monthCols.join(',')}`);

  // Chart of accounts for matching.
  const coa = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await sb.from('chart_of_accounts').select('id, account_number, account_name, fund_id').eq('community_id', comm.id).range(f, f + 999); if (error) { console.error('CoA fetch failed:', error.message); process.exit(1); } coa.push(...(data || [])); if (!data || data.length < 1000) break; }
  const byNum = Object.fromEntries(coa.map((a) => [String(a.account_number), a]));

  // Operating fund_id — inferred from the community's existing operating accounts
  // (all budget lines here are operating revenue/expense). Caught below if empty.
  const fundCounts = {};
  coa.forEach((a) => { if (a.fund_id) fundCounts[a.fund_id] = (fundCounts[a.fund_id] || 0) + 1; });
  const operatingFundId = Object.keys(fundCounts).sort((x, y) => fundCounts[y] - fundCounts[x])[0] || null;

  // Normalize 12 monthly values so they sum EXACTLY to the annual figure. Vantaca
  // rounds each month independently, so the 12 months drift a few dollars off the
  // annual total. Ed's rule: "the total always equals the yearly budget." Park the
  // residual (annual - sum) in the largest-magnitude month so the line ties.
  function normalizeMonths(monthly, annual) {
    const sum = monthly.reduce((s, x) => s + x, 0);
    if (annual === 0 || sum === annual) return { monthly, drift: 0 };
    let li = 0, lm = -1;
    monthly.forEach((v, idx) => { if (Math.abs(v) > lm) { lm = Math.abs(v); li = idx; } });
    const out = monthly.slice();
    out[li] += (annual - sum);
    return { monthly: out, drift: annual - sum };
  }

  const lines = [], toCreate = [];
  let maxDrift = 0;
  for (let i = hdrRow + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const c0 = String(r[0] || '').trim();
    const m = c0.match(/^(\d{3,5})\s*-\s*(.+)/);       // account line: "4000 - Current Year Assessment Income"
    if (!m) continue;
    const acctNum = m[1];
    const name = m[2].trim();
    const annual = cents(r[annualCol]);
    const rawMonthly = monthCols.map((c) => cents(r[c]));
    const rawSum = rawMonthly.reduce((s, x) => s + x, 0);
    if (annual === 0 && rawSum === 0) continue;         // empty line
    const norm = normalizeMonths(rawMonthly, annual);
    if (Math.abs(norm.drift) > maxDrift) maxDrift = Math.abs(norm.drift);
    let a = byNum[acctNum];
    if (!a) {
      // Missing from the chart — infer type from the number (4xxx revenue,
      // 5xxx/6xxx expense). Asset/liability ranges aren't expected in an operating
      // budget; leave type null so it's flagged rather than mis-created.
      const lead = acctNum[0];
      let account_type = null, normal_balance = null;
      if (lead === '4') { account_type = 'revenue'; normal_balance = 'credit'; }
      else if (lead === '5' || lead === '6') { account_type = 'expense'; normal_balance = 'debit'; }
      const spec = byNum['__c_' + acctNum] || { account_number: acctNum, account_name: name, account_type, normal_balance };
      if (!byNum['__c_' + acctNum]) { byNum['__c_' + acctNum] = spec; toCreate.push(spec); }
      a = { __pending: spec }; // resolved to a real id after creation on --apply
    }
    lines.push({ account: a, account_number: acctNum, name, annual_amount_cents: annual, monthly_amounts_cents: norm.monthly });
  }

  const unmatched = toCreate.filter((s) => !s.account_type); // couldn't infer type — genuinely can't place
  console.log(`\nparsed ${lines.length} budget lines | will create: ${toCreate.length} | uninferable: ${unmatched.length}`);
  console.log(`  max month→annual drift corrected: $${(maxDrift / 100).toFixed(2)} (parked in largest month per line so each ties)`);
  if (toCreate.length) { console.log('  ACCOUNTS TO CREATE in Operating fund:'); toCreate.forEach((s) => console.log(`    ${s.account_number} - ${s.account_name}  [${s.account_type || 'UNKNOWN — needs manual placement'}]`)); }
  const totAnnual = lines.reduce((s, l) => s + l.annual_amount_cents, 0);
  const totMonths = lines.reduce((s, l) => s + l.monthly_amounts_cents.reduce((a, b) => a + b, 0), 0);
  console.log(`  total annual across all lines: $${(totAnnual / 100).toLocaleString()}`);
  console.log(`  total of all monthly values:   $${(totMonths / 100).toLocaleString()}  ${totMonths === totAnnual ? '✓ ties' : '✗ DOES NOT TIE'}`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write the budget (creates missing accounts first).'); return; }
  if (unmatched.length) { console.error('Refusing to write: accounts with un-inferable type. Add them to the chart manually first.'); process.exit(1); }
  if (!operatingFundId) { console.error('Refusing to write: could not determine the Operating fund_id (empty chart).'); process.exit(1); }

  // Create the missing accounts in the Operating fund, then resolve pending refs.
  for (const spec of toCreate) {
    const { data: created, error } = await sb.from('chart_of_accounts').insert({
      community_id: comm.id, fund_id: operatingFundId, account_number: spec.account_number,
      account_name: spec.account_name, account_type: spec.account_type, normal_balance: spec.normal_balance,
      is_summary: false, is_active: true, description: 'Created by budget import ' + FILE.split(/[\\/]/).pop(),
    }).select('id, fund_id').single();
    if (error) { console.error(`account create failed (${spec.account_number}):`, error.message); process.exit(1); }
    spec.__id = created.id; spec.__fund = created.fund_id;
    console.log(`  created account ${spec.account_number} ${spec.account_name} -> ${created.id}`);
  }
  // Resolve every line to a concrete account_id + fund_id.
  lines.forEach((l) => {
    if (l.account.__pending) { l.account_id = l.account.__pending.__id; l.fund_id = l.account.__pending.__fund; }
    else { l.account_id = l.account.id; l.fund_id = l.account.fund_id || operatingFundId; }
  });

  // Replace any existing budget for this community + fiscal year.
  const { data: existing } = await sb.from('community_budgets').select('id').eq('community_id', comm.id).eq('fiscal_year', fiscalYear).maybeSingle();
  let budgetId = existing && existing.id;
  if (budgetId) { await sb.from('budget_line_items').delete().eq('budget_id', budgetId); await sb.from('community_budgets').update({ status: 'draft', source_filename: FILE.split(/[\\/]/).pop() }).eq('id', budgetId); }
  else {
    const { data: b, error } = await sb.from('community_budgets').insert({ community_id: comm.id, fiscal_year: fiscalYear, status: 'draft', source_filename: FILE.split(/[\\/]/).pop() }).select('id').single();
    if (error) { console.error('budget insert failed:', error.message); process.exit(1); }
    budgetId = b.id;
  }
  const rows = lines.map((l) => ({ budget_id: budgetId, account_id: l.account_id, fund_id: l.fund_id, annual_amount_cents: l.annual_amount_cents, monthly_amounts_cents: l.monthly_amounts_cents }));
  for (let i = 0; i < rows.length; i += 200) { const { error } = await sb.from('budget_line_items').insert(rows.slice(i, i + 200)); if (error) { console.error('line insert failed:', error.message); process.exit(1); } }
  console.log(`\nAPPLIED: budget ${budgetId} — ${rows.length} lines, FY${fiscalYear}.`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
