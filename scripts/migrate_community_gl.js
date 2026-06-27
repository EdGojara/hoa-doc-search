// ============================================================================
// scripts/migrate_community_gl.js
// ----------------------------------------------------------------------------
// Generalized, file-driven community GL rebuild: move a community off Vantaca
// onto trustEd as book of record by replaying its Vantaca exports as real
// journal entries ([[project_portfolio_gl_migration]]). Replaces the hardcoded
// Quail Ridge one-offs; reads ANY community via lib/accounting/vantaca_gl_import.
//
//   node scripts/migrate_community_gl.js \
//     --community=lpf \
//     --bs="C:/Users/edget/Downloads/BalanceSheet (8).xls"   (fund-split opening, 12/31 prior year) \
//     --tb="C:/Users/edget/Downloads/GLTrialBalance (9).xls" (one or more, comma-separated, in order) \
//     --year=2026 [--apply]
//
// WHAT IT DOES (dry-run by default; --apply writes):
//   1. Funds from the balance-sheet columns (Operating/Reserve/Savings/...).
//   2. Chart of accounts from the trial balance, each account fund-tagged.
//   3. Opening JE at 1/1 of --year, FUND-SPLIT, with the prior-year close
//      applied (current-year surplus 3000 rolled into per-fund accumulated
//      fund-balance accounts) — the multi-fund equity cleanup Vantaca never did.
//   4. One balanced JE per active day from the TB detail (all lines preserved).
//   5. TIE-OUT GATE: refuses to write unless every non-equity account
//      reproduces Vantaca's ending to the penny, total equity ties, and each
//      fund nets to zero (assets = liabilities + equity within the fund).
//
// Idempotent: opening = source_module 'opening_entry', detail = 'vantaca_import';
// a re-run clears only those within the posted date range.
// ----------------------------------------------------------------------------
// PER-COMMUNITY CONFIG: the only thing that varies per community. Everything
// else is derived from the files. Fund of an account is taken from the balance
// sheet where present; income-statement accounts not on the BS default to
// Operating unless overridden here (e.g. reserve/savings interest income).
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { parseBalanceSheet, parseTrialBalance } = require('../lib/accounting/vantaca_gl_import');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  lpf: {
    // Income-statement accounts whose fund isn't on the balance sheet.
    fundOverrides: { '4110': 'SAV', '4120': 'RES' }, // Interest - Savings / Reserve
    // Per-fund accumulated fund-balance accounts (the cleanup: Vantaca lumped
    // all of this into 3050; trustEd uses the distinct GL accounts that already
    // exist in the chart). Maps fund_code -> account_number.
    fundBalanceAccount: { OPR: '3050', RES: '3020', SAV: '3010' },
    currentYearSurplusAccount: '3000', // closed into the above at opening
  },
};

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const APPLY = process.argv.includes('--apply');
const slug = arg('community');
const YEAR = parseInt(arg('year', '2026'), 10);
const bsPath = arg('bs');
const tbPaths = (arg('tb') || '').split(',').map((x) => x.trim()).filter(Boolean);
const D = (c) => '$' + (Number(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function classify(num) {
  const d = String(num)[0];
  if (d === '1') return { type: 'asset', normal_balance: 'debit', subtype: 'current_asset' };
  if (d === '2') return { type: 'liability', normal_balance: 'credit', subtype: 'current_liability' };
  if (d === '3') return { type: 'equity', normal_balance: 'credit', subtype: 'fund_balance' };
  if (d === '4') return { type: 'revenue', normal_balance: 'credit', subtype: 'operating_revenue' };
  return { type: 'expense', normal_balance: 'debit', subtype: 'operating_expense' };
}

(async () => {
  if (!slug) { console.error('need --community=<slug>'); process.exit(1); }
  if (!bsPath) { console.error('need --bs=<fund-split opening balance sheet .xls>'); process.exit(1); }
  if (!tbPaths.length) { console.error('need --tb=<trial balance .xls[,...]>'); process.exit(1); }
  const cfg = CONFIG[slug];
  if (!cfg) { console.error(`no CONFIG for "${slug}" — add fund overrides + fund-balance accounts`); process.exit(1); }

  const { data: comm, error: cErr } = await s.from('communities').select('id, name').eq('slug', slug).maybeSingle();
  if (cErr || !comm) { console.error('community lookup failed:', cErr ? cErr.message : 'not found'); process.exit(1); }
  const CID = comm.id;
  console.log(`\n=== ${comm.name} (${slug}) — GL rebuild, FY ${YEAR} ===\n`);

  // ---- Parse sources --------------------------------------------------------
  const bs = parseBalanceSheet(bsPath);
  const tbs = tbPaths.map((p) => parseTrialBalance(p));
  const detailTbs = tbs.filter((t) => Object.keys(t.byDay).length);
  // Accounts: union across all TBs (the live chart over the whole window).
  const acctMeta = {};
  for (const t of tbs) for (const a of t.accounts) acctMeta[a.number] = { number: a.number, name: a.name };

  // ---- Fund structure + fund map -------------------------------------------
  const funds = bs.funds.map((f) => ({ code: f.code, name: f.name }));
  const bsFund = {}; // account_number -> fund_code (balance-sheet accounts)
  for (const a of bs.accounts) bsFund[a.number] = a.fund_code; // last write wins; equity handled separately
  const fundBalanceNums = new Set(Object.values(cfg.fundBalanceAccount));
  const fundOf = (num) => {
    if (cfg.fundOverrides[num]) return cfg.fundOverrides[num];
    if (bsFund[num]) return bsFund[num];
    return funds[0].code; // default Operating
  };

  // ---- Opening balances (fund-split, post-close) ---------------------------
  // Non-equity: take the first TB's beginning column (the 1/1 GL opening; we
  // verified these tie to the BS totals). Equity: roll current-year surplus
  // into per-fund accumulated fund-balance accounts from the BS split.
  const tb0 = tbs[0];
  const begOf = Object.fromEntries(tb0.accounts.map((a) => [a.number, a.beginning_cents]));
  const opening = []; // { number, fund_code, cents }  cents signed debit-positive
  for (const a of tb0.accounts) {
    if (/^3/.test(a.number)) continue; // equity handled below
    if (a.beginning_cents === 0) continue;
    opening.push({ number: a.number, fund_code: fundOf(a.number), cents: a.beginning_cents });
  }
  // Equity: BS gives per-fund 3000 (current-year surplus) + 3050 (accumulated).
  // Closed accumulated = 3050_fund + 3000_fund, posted to the fund's FB account.
  const bsEquity = {}; // fund -> { surplus, accum }
  for (const a of bs.accounts) {
    if (a.number === cfg.currentYearSurplusAccount) (bsEquity[a.fund_code] = bsEquity[a.fund_code] || {}).surplus = (bsEquity[a.fund_code]?.surplus || 0) + a.opening_cents;
    if (cfg.fundBalanceAccount[a.fund_code] === a.number || a.name.toLowerCase().includes('accumulated')) {
      (bsEquity[a.fund_code] = bsEquity[a.fund_code] || {}).accum = (bsEquity[a.fund_code]?.accum || 0) + a.opening_cents;
    }
  }
  for (const f of funds) {
    const e = bsEquity[f.code] || { surplus: 0, accum: 0 };
    const closed = (e.surplus || 0) + (e.accum || 0);
    if (closed !== 0) opening.push({ number: cfg.fundBalanceAccount[f.code], fund_code: f.code, cents: closed });
  }

  // ---- Chart of accounts to create -----------------------------------------
  // Every account seen in the TBs, plus the per-fund FB accounts. An account is
  // single-fund; the per-fund FB accounts (3050/3020/3010) are distinct numbers.
  const coa = {};
  const addCoa = (num, fund) => {
    if (coa[num]) return;
    const meta = acctMeta[num] || { number: num, name: num };
    coa[num] = { account_number: num, account_name: meta.name, fund_code: fund, ...classify(num) };
  };
  for (const num of Object.keys(acctMeta)) { if (!fundBalanceNums.has(num) && num !== cfg.currentYearSurplusAccount) addCoa(num, fundOf(num)); }
  for (const f of funds) addCoa(cfg.fundBalanceAccount[f.code], f.code);
  // Name the FB accounts per fund where the chart didn't already.
  for (const f of funds) { const n = cfg.fundBalanceAccount[f.code]; if (coa[n] && /^\d+$/.test(coa[n].account_name)) coa[n].account_name = `${f.name} Fund Balance`; }

  // ---- VERIFY before any write ---------------------------------------------
  let openDr = 0, openCr = 0;
  for (const o of opening) { if (o.cents > 0) openDr += o.cents; else openCr += -o.cents; }
  console.log(`Funds: ${funds.map((f) => `${f.code}(${f.name})`).join(', ')}`);
  console.log(`Accounts in chart: ${Object.keys(coa).length}`);
  console.log(`Opening JE (${opening.length} lines): DR ${D(openDr)}  CR ${D(openCr)}  ${openDr === openCr ? 'BALANCED ✓' : 'OUT BY ' + D(openDr - openCr) + ' ✗'}`);
  if (openDr !== openCr) { console.error('Refusing: opening does not balance.'); process.exit(1); }

  // Daily detail: collect across all TBs, verify each day balances + accounts known.
  const byDay = {};
  for (const t of detailTbs) for (const [iso, lines] of Object.entries(t.byDay)) (byDay[iso] = byDay[iso] || []).push(...lines);
  const days = Object.keys(byDay).sort();
  let detailLines = 0; const unknown = new Set();
  for (const d of days) {
    const dr = byDay[d].reduce((a, l) => a + l.debit_cents, 0), cr = byDay[d].reduce((a, l) => a + l.credit_cents, 0);
    if (dr !== cr) { console.error(`Refusing: ${d} does not balance (${D(dr)} vs ${D(cr)}).`); process.exit(1); }
    detailLines += byDay[d].length;
    for (const l of byDay[d]) if (!coa[l.accountNumber]) unknown.add(l.accountNumber);
  }
  if (unknown.size) { console.error('Refusing: detail references unknown accounts:', [...unknown].join(', ')); process.exit(1); }
  console.log(`Detail: ${days.length} active days, ${detailLines} lines, ${days[0]} → ${days[days.length - 1]} — all balance ✓`);

  // TIE-OUT GATE: opening + detail per account must reproduce Vantaca ending.
  // Non-equity ties account-by-account; equity ties in aggregate (we restructured
  // it on purpose) and per fund.
  const endVan = {}; // last TB's ending per account number (lumped, Vantaca form)
  for (const a of tbs[tbs.length - 1].accounts) endVan[a.number] = a.ending_cents;
  const computed = {}; // our trustEd ending per account number (split form)
  for (const o of opening) computed[o.number] = (computed[o.number] || 0) + o.cents;
  for (const d of days) for (const l of byDay[d]) computed[l.accountNumber] = (computed[l.accountNumber] || 0) + l.debit_cents - l.credit_cents;

  let mismatches = [];
  for (const num of Object.keys(endVan)) {
    if (/^3/.test(num)) continue; // equity checked in aggregate
    const got = computed[num] || 0, want = endVan[num] || 0;
    if (got !== want) mismatches.push(`${num} ${acctMeta[num]?.name || ''}: trustEd ${D(got)} vs Vantaca ${D(want)} (Δ ${D(got - want)})`);
  }
  // Equity aggregate: trustEd equity total vs Vantaca equity total.
  const eqGot = Object.keys(computed).filter((n) => /^3/.test(n)).reduce((a, n) => a + computed[n], 0);
  const eqWant = Object.keys(endVan).filter((n) => /^3/.test(n)).reduce((a, n) => a + endVan[n], 0);
  // Per-fund net = 0 (assets = liab + equity within fund), as of the last ending.
  const fundNet = {};
  for (const num of new Set([...Object.keys(computed)])) {
    const fc = coa[num] ? coa[num].fund_code : fundOf(num);
    fundNet[fc] = (fundNet[fc] || 0) + (computed[num] || 0);
  }

  console.log(`\nTIE-OUT to Vantaca ${tbs[tbs.length - 1].range.replace(/.*-\s*/, 'ending ')}:`);
  console.log(`  non-equity accounts: ${mismatches.length === 0 ? 'ALL TIE ✓' : mismatches.length + ' MISMATCH ✗'}`);
  mismatches.slice(0, 12).forEach((m) => console.log('    ' + m));
  console.log(`  equity (aggregate):  trustEd ${D(eqGot)} vs Vantaca ${D(eqWant)}  ${eqGot === eqWant ? 'TIES ✓' : 'Δ ' + D(eqGot - eqWant) + ' ✗'}`);
  console.log(`  per-fund net (each should be $0): ${Object.entries(fundNet).map(([k, v]) => `${k} ${D(v)}`).join(' | ')}`);
  const fundsBalanced = Object.values(fundNet).every((v) => v === 0);
  const clean = mismatches.length === 0 && eqGot === eqWant && fundsBalanced;
  console.log(`\n  RESULT: ${clean ? 'CLEAN — reproduces Vantaca to the penny ✓' : 'NOT CLEAN — see above ✗'}`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write funds, chart, periods, and journal entries.'); return; }
  if (!clean) { console.error('\nRefusing to --apply: tie-out is not clean.'); process.exit(1); }

  // ---- WRITE ---------------------------------------------------------------
  // 1) Funds
  const fundRows = funds.map((f, i) => ({ community_id: CID, fund_code: f.code, fund_name: f.name, fund_type: f.code === 'OPR' ? 'operating' : (f.code === 'RES' ? 'reserve' : 'other'), display_order: i + 1 }));
  await s.from('account_funds').upsert(fundRows, { onConflict: 'community_id,fund_code' });
  const { data: fundRecs } = await s.from('account_funds').select('id, fund_code').eq('community_id', CID);
  const fundId = Object.fromEntries(fundRecs.map((f) => [f.fund_code, f.id]));

  // 2) Chart of accounts
  const coaRows = Object.values(coa).map((a) => ({
    community_id: CID, fund_id: fundId[a.fund_code] || null, account_number: a.account_number, account_name: a.account_name,
    account_type: a.type, account_subtype: a.subtype, normal_balance: a.normal_balance, is_summary: false, is_active: true, vantaca_account_number: a.account_number,
  }));
  await s.from('chart_of_accounts').upsert(coaRows, { onConflict: 'community_id,account_number' });
  const { data: coaRecs } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acctId = Object.fromEntries(coaRecs.map((a) => [a.account_number, a.id]));

  // 3) Periods (12 monthly for the fiscal year)
  const periodRows = MONTHS.map((_, i) => { const m = i + 1; return { community_id: CID, fiscal_year: YEAR, period_number: m, period_type: 'monthly', period_start: `${YEAR}-${String(m).padStart(2, '0')}-01`, period_end: `${YEAR}-${String(m).padStart(2, '0')}-${String(lastDay(YEAR, m)).padStart(2, '0')}`, status: 'open' }; });
  await s.from('accounting_periods').upsert(periodRows, { onConflict: 'community_id,fiscal_year,period_number' });
  const { data: periodRecs } = await s.from('accounting_periods').select('id, period_number').eq('community_id', CID).eq('fiscal_year', YEAR);
  const periodId = Object.fromEntries(periodRecs.map((p) => [p.period_number, p.id]));

  // 4) Clear prior migrated entries (idempotent), then post opening + daily detail.
  const range0 = `${YEAR}-01-01`, range1 = days[days.length - 1];
  const { data: prior } = await s.from('journal_entries').select('id').eq('community_id', CID).in('source_module', ['opening_entry', 'vantaca_import']).gte('posting_date', range0).lte('posting_date', range1);
  if (prior && prior.length) { await s.from('journal_entry_lines').delete().in('journal_entry_id', prior.map((j) => j.id)); await s.from('journal_entries').delete().in('id', prior.map((j) => j.id)); console.log(`Cleared ${prior.length} prior entries.`); }

  // Opening JE
  const { data: oje } = await s.from('journal_entries').insert({ community_id: CID, period_id: periodId[1], posting_date: `${YEAR}-01-01`, reference: `JE-${YEAR}-OPEN`, description: `Opening balances migrated from Vantaca (fund-split, ${bs.asOf} close)`, source_module: 'opening_entry', total_debits_cents: openDr, total_credits_cents: openCr, status: 'posted' }).select('id').single();
  await s.from('journal_entry_lines').insert(opening.map((o, i) => ({ journal_entry_id: oje.id, line_number: i + 1, account_id: acctId[o.number], debit_cents: o.cents > 0 ? o.cents : 0, credit_cents: o.cents < 0 ? -o.cents : 0, memo: `Opening ${o.fund_code} ${bs.asOf}` })));
  console.log(`Posted opening JE (${opening.length} lines).`);

  // Daily detail
  let posted = 0, postedLines = 0;
  for (const d of days) {
    const lines = byDay[d];
    const dr = lines.reduce((a, l) => a + l.debit_cents, 0), cr = lines.reduce((a, l) => a + l.credit_cents, 0);
    const { data: je } = await s.from('journal_entries').insert({ community_id: CID, period_id: periodId[Number(d.slice(5, 7))], posting_date: d, reference: `JE-D-${d.replace(/-/g, '')}`, description: `Daily activity ${d} (migrated from Vantaca GL detail)`, source_module: 'vantaca_import', total_debits_cents: dr, total_credits_cents: cr, status: 'posted' }).select('id').single();
    const rows = lines.map((l, i) => ({ journal_entry_id: je.id, line_number: i + 1, account_id: acctId[l.accountNumber], debit_cents: l.debit_cents, credit_cents: l.credit_cents, memo: (l.type ? l.type + ': ' : '') + (l.description || '').slice(0, 180) }));
    for (let i = 0; i < rows.length; i += 200) await s.from('journal_entry_lines').insert(rows.slice(i, i + 200));
    posted++; postedLines += rows.length;
  }
  console.log(`Posted ${posted} daily entries, ${postedLines} lines.`);
  console.log(`\nDONE. ${comm.name} GL rebuilt in trustEd, FY ${YEAR}, tied to Vantaca to the penny.`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
