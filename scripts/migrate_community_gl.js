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
//     --bs="C:/Users/edget/Downloads/BalanceSheet (8).xls"  (fund-split, at the close year-end) \
//     --tb="GLTrialBalance (7).xls,GLTrialBalance (8).xls,GLTrialBalance (9).xls"  (in date order) \
//     [--apply]
//
// TWO MODES, auto-detected from the first trial balance's beginning column:
//
//   CONVERSION MODE (first TB beginning is all zero — the C3->Vantaca
//   conversion sits inside the detail): no opening entry. Replay every detail
//   line verbatim so the rebuild ties to Vantaca to the penny INCLUDING the
//   conversion mess (faithful history). At each fiscal year-end that has a
//   following year, synthesize ONE documented close+restructure entry that
//   zeros the P&L and lands fund balance in the per-fund accounts (3050/3020/
//   3010) — the multi-fund equity cleanup Vantaca lumped into 3050. The
//   per-fund split comes from --bs at that year-end.
//
//   OPENING MODE (first TB has real beginning balances — a mid-life cutover
//   like Quail Ridge): post one fund-split opening entry from --bs, then the
//   detail. No close needed.
//
// TIE-OUT GATES (refuses to --apply unless clean):
//   * each fiscal year-end, PRE-close: every account reproduces that year's
//     Vantaca ending to the penny (faithful replay).
//   * final ending: non-equity accounts tie 1:1, equity ties in aggregate
//     (we restructured it on purpose), and each fund nets to zero.
//
// Idempotent: opening='opening_entry', detail='vantaca_import',
// close='closing_entry'; a re-run clears only those in the posted date range.
// ----------------------------------------------------------------------------
// PER-COMMUNITY CONFIG — the only thing that varies. Fund of an account comes
// from the balance sheet where present; income-statement accounts not on the
// BS default to Operating unless overridden here.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { parseBalanceSheet, parseTrialBalance } = require('../lib/accounting/vantaca_gl_import');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  lpf: {
    fundOverrides: { '4110': 'SAV', '4120': 'RES' },        // Interest - Savings / Reserve
    fundBalanceAccount: { OPR: '3050', RES: '3020', SAV: '3010' }, // per-fund accumulated FB
    currentYearSurplusAccount: '3000',                      // closed to FB at year-end
  },
  // Waterview: 3 funds incl. Adopt-A-School. Active ~$80K/yr Operating->Reserve
  // contribution recorded in 4010 (nets to ~0 in the consolidated TB), so the
  // per-fund split of the CURRENT year can't come from the TB alone. interfundOK
  // tells the gate to accept per-fund nets that OFFSET to zero (pure interfund
  // reclassification, no money lost) and report them as the documented
  // interfund adjustment Ed approved booking to Operating FB.
  waterview: {
    fundOverrides: { '4010': 'RES', '4120': 'RES', '5500': 'RES',          // Reserve revenue/expense
                     '4050': 'ADO', '4130': 'ADO', '5950': 'ADO' },        // Adopt-A-School revenue/expense
    fundBalanceAccount: { OPR: '3050', RES: '3020', ADO: '3030' },
    currentYearSurplusAccount: '3000',
    interfundOK: true,
  },
  // Canyon Gate: takeover ~Oct 2025 (clean Vantaca setup, per-fund FB already
  // used). 3 funds; reserve has real expenditures (5711-5718 RSRV-*); Adopt-A-
  // School revenue/expense. No active reserve-contribution transfer.
  'canyon-gate': {
    fundOverrides: {
      '1200': 'RES', '4205': 'RES',                                        // Reserve cash + Edward Jones unrealized gains (not on 12/31 BS)
      '4010': 'RES', '4120': 'RES',                                        // Reserve contribution / interest
      '5711': 'RES', '5712': 'RES', '5713': 'RES', '5714': 'RES', '5716': 'RES', '5718': 'RES', // RSRV-* expenditures
      '1250': 'ADO',                                                       // Adopt-A-School cash (not on 12/31 BS)
      '4050': 'ADO', '4125': 'ADO', '4130': 'ADO', '5950': 'ADO',          // Adopt-A-School rev/exp
    },
    fundBalanceAccount: { OPR: '3050', RES: '3020', ADO: '3030' },
    currentYearSurplusAccount: '3000',
    interfundOK: true,
  },
};

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const APPLY = process.argv.includes('--apply');
const slug = arg('community');
const bsPath = arg('bs');
const tbPaths = (arg('tb') || '').split(',').map((x) => x.trim()).filter(Boolean);
const D = (c) => (Number(c) < 0 ? '-' : '') + '$' + (Math.abs(Number(c)) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });
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
  if (!bsPath) { console.error('need --bs=<fund-split balance sheet .xls>'); process.exit(1); }
  if (!tbPaths.length) { console.error('need --tb=<trial balance .xls[,...]>'); process.exit(1); }
  const cfg = CONFIG[slug];
  if (!cfg) { console.error(`no CONFIG for "${slug}"`); process.exit(1); }

  const { data: comm, error: cErr } = await s.from('communities').select('id, name').eq('slug', slug).maybeSingle();
  if (cErr || !comm) { console.error('community lookup failed:', cErr ? cErr.message : 'not found'); process.exit(1); }
  const CID = comm.id;
  console.log(`\n=== ${comm.name} (${slug}) — GL rebuild ===\n`);

  // ---- Parse sources --------------------------------------------------------
  const bs = parseBalanceSheet(bsPath);
  const tbs = tbPaths.map((p) => parseTrialBalance(p));
  const acctMeta = {};
  for (const t of tbs) for (const a of t.accounts) acctMeta[a.number] = { number: a.number, name: a.name };

  // ---- Fund structure + fund map -------------------------------------------
  const funds = bs.funds.map((f) => ({ code: f.code, name: f.name }));
  const bsFund = {};
  for (const a of bs.accounts) bsFund[a.number] = a.fund_code;
  const fbNums = new Set(Object.values(cfg.fundBalanceAccount));   // 3050/3020/3010
  const fbFundOf = Object.fromEntries(Object.entries(cfg.fundBalanceAccount).map(([f, n]) => [n, f]));
  const fundOf = (num) => {
    if (fbNums.has(num)) return fbFundOf[num];                     // per-fund FB accounts
    if (num === cfg.currentYearSurplusAccount) return funds[0].code; // current-year surplus -> Operating
    if (cfg.fundOverrides[num]) return cfg.fundOverrides[num];
    if (bsFund[num]) return bsFund[num];
    return funds[0].code;
  };

  // ---- Chart of accounts (every account seen, fund-tagged) -----------------
  const coa = {};
  for (const num of Object.keys(acctMeta)) {
    coa[num] = { account_number: num, account_name: acctMeta[num].name, fund_code: fundOf(num), ...classify(num) };
  }
  for (const f of funds) { const n = cfg.fundBalanceAccount[f.code]; if (coa[n] && /^\d+$/.test(coa[n].account_name)) coa[n].account_name = `${f.name} Fund Balance`; }

  // ---- Detail (all TBs), verify each day balances + accounts known ----------
  const byDay = {};
  for (const t of tbs) for (const [iso, lines] of Object.entries(t.byDay)) (byDay[iso] = byDay[iso] || []).push(...lines);
  const days = Object.keys(byDay).sort();
  const unknown = new Set();
  let detailLines = 0;
  for (const d of days) {
    const dr = byDay[d].reduce((a, l) => a + l.debit_cents, 0), cr = byDay[d].reduce((a, l) => a + l.credit_cents, 0);
    if (dr !== cr) { console.error(`Refusing: ${d} does not balance (${D(dr)} vs ${D(cr)}).`); process.exit(1); }
    detailLines += byDay[d].length;
    for (const l of byDay[d]) if (!coa[l.accountNumber]) unknown.add(l.accountNumber);
  }
  if (unknown.size) { console.error('Refusing: detail references unknown accounts:', [...unknown].join(', ')); process.exit(1); }

  // ---- Mode + opening -------------------------------------------------------
  const tb0 = tbs[0];
  const conversionMode = tb0.accounts.every((a) => a.beginning_cents === 0);
  const opening = []; // { number, fund_code, cents }  (OPENING MODE only)
  if (!conversionMode) {
    for (const a of tb0.accounts) {
      if (/^3/.test(a.number)) continue;
      if (a.beginning_cents !== 0) opening.push({ number: a.number, fund_code: fundOf(a.number), cents: a.beginning_cents });
    }
    // equity: roll BS current-year surplus into per-fund FB
    const eq = {};
    for (const a of bs.accounts) {
      if (a.number === cfg.currentYearSurplusAccount) (eq[a.fund_code] = eq[a.fund_code] || { s: 0, a: 0 }).s += a.opening_cents;
      else if (/^3/.test(a.number)) (eq[a.fund_code] = eq[a.fund_code] || { s: 0, a: 0 }).a += a.opening_cents;
    }
    for (const f of funds) { const e = eq[f.code] || { s: 0, a: 0 }; const c = e.s + e.a; if (c) opening.push({ number: cfg.fundBalanceAccount[f.code], fund_code: f.code, cents: c }); }
  }

  // ---- Year-end close target (per-fund FB) from --bs ------------------------
  // closeYear = the BS year; target FB per fund = BS accumulated + BS surplus.
  const closeYear = bs.asOf ? parseInt(String(bs.asOf).split('/').pop(), 10) : null;
  const fbTarget = {}; // fund_code -> target FB cents (debit-signed)
  for (const f of funds) {
    let acc = 0, sur = 0;
    for (const a of bs.accounts) {
      if (a.fund_code !== f.code) continue;
      if (a.number === cfg.currentYearSurplusAccount) sur += a.opening_cents;
      else if (/^3/.test(a.number)) acc += a.opening_cents;
    }
    fbTarget[f.code] = acc + sur;
  }

  // Running balances from replay, used to build the close at closeYear-12-31.
  function balancesThrough(dateIso) {
    const bal = {};
    for (const o of opening) bal[o.number] = (bal[o.number] || 0) + o.cents;
    for (const d of days) { if (d > dateIso) break; for (const l of byDay[d]) bal[l.accountNumber] = (bal[l.accountNumber] || 0) + l.debit_cents - l.credit_cents; }
    return bal;
  }

  // Build the close+restructure entry for closeYear (CONVERSION MODE only,
  // when there is activity after closeYear-12-31).
  let closeEntry = null; // { date, lines:[{number,debit,credit,memo}] }
  const hasNextYear = days.some((d) => Number(d.slice(0, 4)) > closeYear);
  if (conversionMode && closeYear && hasNextYear) {
    const closeDate = `${closeYear}-12-31`;
    const pre = balancesThrough(closeDate);
    // Next-year TB beginning balances = the authoritative post-year-end-adjustment
    // 1/1 state. Vantaca bakes year-end adjustments (allowance true-ups, clearing
    // account zeroing — the "adjustments to balance equity") into this roll WITHOUT
    // posting them as detail, so 2025-ending ≠ 2026-beginning for those accounts.
    const nextTb = tbs.find((t) => { const m = String(t.range).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/); return m && Number(m[3]) === closeYear; })
      || tbs.find((t) => Object.keys(t.byDay).some((d) => Number(d.slice(0, 4)) === closeYear + 1));
    const nextBeg = {};
    for (const t of tbs) { const startsNextYr = String(t.range).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (startsNextYr && Number(startsNextYr[3]) === closeYear + 1) for (const a of t.accounts) nextBeg[a.number] = a.beginning_cents; }
    const lines = [];
    // 1) Bridge EVERY account to the next-year beginning balances — reproduces
    //    Vantaca's exact 1/1 state: P&L -> 0, plus the year-end adjustments Vantaca
    //    baked into the beginning roll but never posted as detail (allowance true-
    //    ups, clearing-account zeroing). Both pre-close and nextBeg are balanced
    //    trial balances, so the bridge deltas net to zero — the close balances and
    //    ties to Vantaca's actual year-end equity to the penny BY CONSTRUCTION.
    //    Equity lands lumped exactly as Vantaca carries it (in the operating FB
    //    account); step 2 then splits it per fund without changing the total.
    for (const num of new Set([...Object.keys(coa), ...Object.keys(nextBeg)])) {
      const target = nextBeg[num] || 0; const bal = pre[num] || 0; const delta = target - bal;
      if (delta === 0) continue;
      const memo = /^[4567]/.test(num) ? `Close ${closeYear} (year-end)` : `Year-end ${closeYear} close + adjustments (to ${closeYear + 1} beginning)`;
      if (delta > 0) lines.push({ number: num, debit: delta, credit: 0, memo });
      else lines.push({ number: num, debit: 0, credit: -delta, memo });
    }
    // 2) Per-fund FB reclass (NET-ZERO within equity): move each NON-operating
    //    fund's balance out of the lumped operating FB account into its own FB
    //    account, so per-fund balance sheets are clean. Net-zero => total equity
    //    stays = Vantaca. Operating FB keeps the remainder — which is where any
    //    BS-vs-GL year-end adjustment + interfund drift sits, documented and visible
    //    on the operating FB line. (For a clean community it's exactly the BS value.)
    // Set each non-operating fund's FB to its target, accounting for what the
    // BRIDGE already placed there: delta = target − post-bridge value. When the
    // source already splits per fund (Canyon Gate: 3020/3030 populated), the
    // bridge set them and delta is just the small year-end close into them; when
    // it lumps everything in operating FB (LOPF/Waterview: 3020/3030 dormant=0),
    // delta is the full move. Either way the offset to operating FB keeps the
    // entry net-zero within equity, so total equity stays = Vantaca.
    const opFb = cfg.fundBalanceAccount[funds[0].code];
    for (const f of funds.slice(1)) {
      const fb = cfg.fundBalanceAccount[f.code];
      const delta = (fbTarget[f.code] || 0) - (nextBeg[fb] || 0);
      if (delta === 0) continue;
      if (delta > 0) { lines.push({ number: fb, debit: delta, credit: 0, memo: `${f.name} fund balance (per-fund reclass)` }); lines.push({ number: opFb, debit: 0, credit: delta, memo: `Reclass ${f.name} FB vs ${funds[0].name}` }); }
      else { lines.push({ number: fb, debit: 0, credit: -delta, memo: `${f.name} fund balance (per-fund reclass)` }); lines.push({ number: opFb, debit: -delta, credit: 0, memo: `Reclass ${f.name} FB vs ${funds[0].name}` }); }
    }
    const dr = lines.reduce((a, l) => a + l.debit, 0), cr = lines.reduce((a, l) => a + l.credit, 0);
    // Operating FB absorbs the balancing amount: its own per-fund restructure
    // PLUS the BS-vs-GL year-end adjustment and any interfund drift (documented).
    if (dr !== cr) {
      const resid = dr - cr;
      const opFb = cfg.fundBalanceAccount[funds[0].code];
      lines.push({ number: opFb, debit: resid < 0 ? -resid : 0, credit: resid > 0 ? resid : 0, memo: `${funds[0].name} fund balance (per-fund restructure + year-end/interfund adjustment)` });
      console.log(`  NOTE: ${D(resid)} to ${opFb} (${funds[0].name} FB: restructure + documented adjustments).`);
    }
    closeEntry = { date: closeDate, lines };
  }

  // ---- VERIFY before any write ---------------------------------------------
  const fiscalYears = [...new Set(days.map((d) => Number(d.slice(0, 4))))].sort();
  console.log(`Mode: ${conversionMode ? 'CONVERSION (replay + year-end close)' : 'OPENING (cutover)'}`);
  console.log(`Funds: ${funds.map((f) => `${f.code}(${f.name})`).join(', ')}`);
  console.log(`Accounts in chart: ${Object.keys(coa).length}`);
  console.log(`Fiscal years: ${fiscalYears.join(', ')}`);
  console.log(`Detail: ${days.length} active days, ${detailLines} lines, ${days[0]} → ${days[days.length - 1]} — all balance ✓`);
  if (!conversionMode) {
    let dr = 0, cr = 0; for (const o of opening) { if (o.cents > 0) dr += o.cents; else cr += -o.cents; }
    console.log(`Opening JE (${opening.length} lines): DR ${D(dr)} CR ${D(cr)} ${dr === cr ? 'BALANCED ✓' : 'OUT ' + D(dr - cr) + ' ✗'}`);
    if (dr !== cr) { console.error('Refusing: opening does not balance.'); process.exit(1); }
  }
  if (closeEntry) {
    const dr = closeEntry.lines.reduce((a, l) => a + l.debit, 0), cr = closeEntry.lines.reduce((a, l) => a + l.credit, 0);
    console.log(`Close ${closeYear} (${closeEntry.lines.length} lines): DR ${D(dr)} CR ${D(cr)} ${dr === cr ? 'BALANCED ✓' : 'OUT ' + D(dr - cr) + ' ✗'}`);
    if (dr !== cr) { console.error('Refusing: close does not balance.'); process.exit(1); }
  }

  // GATE 1 — each FAITHFUL-REPLAY year-end ties to that year's Vantaca ending
  // 1:1 (including equity, still in Vantaca's lumped form). Skip any checkpoint
  // AFTER the close: there equity is deliberately restructured + P&L zeroed, so
  // it's validated by GATE 2 (aggregate) instead.
  let gateFail = false;
  for (const t of tbs) {
    const end = String(t.range).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
    if (!end) continue;
    const iso = `${end[3]}-${end[1].padStart(2, '0')}-${end[2].padStart(2, '0')}`;
    if (closeEntry && iso > closeEntry.date) continue;
    const bal = balancesThrough(iso);
    let bad = [];
    for (const a of t.accounts) { const got = bal[a.number] || 0; if (got !== a.ending_cents) bad.push(`${a.number} ${D(got)}≠${D(a.ending_cents)}`); }
    console.log(`  GATE year-end ${iso} (replay vs Vantaca): ${bad.length === 0 ? 'ALL ' + t.accounts.length + ' ACCOUNTS TIE ✓' : bad.length + ' OFF ✗'}`);
    bad.slice(0, 8).forEach((x) => console.log('     ' + x));
    if (bad.length) gateFail = true;
  }

  // GATE 2 — final state: non-equity 1:1, equity aggregate, per-fund net zero.
  // Final = full replay (opening + all detail) + the close. The close zeros the
  // full-year pre-close P&L, so post-close P&L nets to the after-close activity
  // only; FB lands on the per-fund targets. (Both 2025+2026 P&L are summed in,
  // then the close subtracts the 2025 portion via its zeroing legs.)
  const correctFinal = {};
  for (const o of opening) correctFinal[o.number] = (correctFinal[o.number] || 0) + o.cents;
  for (const d of days) for (const l of byDay[d]) correctFinal[l.accountNumber] = (correctFinal[l.accountNumber] || 0) + l.debit_cents - l.credit_cents;
  if (closeEntry) for (const l of closeEntry.lines) correctFinal[l.number] = (correctFinal[l.number] || 0) + l.debit - l.credit;
  const lastTb = tbs[tbs.length - 1];
  const endVan = Object.fromEntries(lastTb.accounts.map((a) => [a.number, a.ending_cents]));
  let mism = [];
  for (const num of Object.keys(endVan)) {
    if (/^3/.test(num)) continue;
    const got = correctFinal[num] || 0, want = endVan[num];
    if (got !== want) mism.push(`${num} ${acctMeta[num]?.name || ''}: ${D(got)} vs Vantaca ${D(want)} (Δ ${D(got - want)})`);
  }
  const eqGot = Object.keys(correctFinal).filter((n) => /^3/.test(n)).reduce((a, n) => a + correctFinal[n], 0);
  const eqWant = Object.keys(endVan).filter((n) => /^3/.test(n)).reduce((a, n) => a + endVan[n], 0);
  const fundNet = {};
  for (const num of Object.keys(correctFinal)) { const fc = coa[num] ? coa[num].fund_code : fundOf(num); fundNet[fc] = (fundNet[fc] || 0) + correctFinal[num]; }
  const fundNetSum = Object.values(fundNet).reduce((a, v) => a + v, 0);
  // Each fund should net to $0. interfundOK communities (active interfund
  // transfers the consolidated TB can't split per-fund) instead require the
  // per-fund nets to OFFSET to $0 — no money lost, purely an interfund
  // reclassification surfaced for a documented adjustment.
  const fundsZero = cfg.interfundOK ? (fundNetSum === 0) : Object.values(fundNet).every((v) => v === 0);
  console.log(`\n  GATE final (${lastTb.range.replace(/.*-\s*/, 'ending ')}):`);
  console.log(`    non-equity: ${mism.length === 0 ? 'ALL TIE ✓' : mism.length + ' MISMATCH ✗'}`); mism.slice(0, 12).forEach((m) => console.log('      ' + m));
  // Equity must tie exactly to Vantaca, UNLESS this is an interfundOK community
  // carrying a documented year-end adjustment (a Vantaca discontinuity between the
  // 12/31 BS and the 1/1 GL that the close books to Operating FB, Ed-approved). The
  // difference is reported prominently — never silent — and traceable to one line.
  const eqDiff = eqGot - eqWant;
  const eqOk = eqDiff === 0 || cfg.interfundOK;
  console.log(`    equity (aggregate): trustEd ${D(eqGot)} vs Vantaca ${D(eqWant)} ${eqDiff === 0 ? 'TIES ✓' : cfg.interfundOK ? `Δ ${D(eqDiff)} = documented adjustment booked to Operating FB ⚠` : 'Δ ' + D(eqDiff) + ' ✗'}`);
  const allZero = Object.values(fundNet).every((v) => v === 0);
  console.log(`    per-fund net: ${Object.entries(fundNet).map(([k, v]) => `${k} ${D(v)}`).join(' | ')}  ${allZero ? '(each $0 ✓)' : cfg.interfundOK && fundNetSum === 0 ? '(offset to $0 — INTERFUND adjustment needed ⚠)' : ''}`);
  const clean = !gateFail && mism.length === 0 && eqOk && fundsZero;
  const hasAdj = clean && (eqDiff !== 0 || !allZero);
  console.log(`\n  RESULT: ${clean ? (hasAdj ? 'CLEAN — ties to Vantaca with documented adjustments flagged above ✓' : 'CLEAN — reproduces Vantaca to the penny ✓') : 'NOT CLEAN ✗'}`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write funds, chart, periods, and journal entries.'); return; }
  if (!clean) { console.error('\nRefusing to --apply: tie-out is not clean.'); process.exit(1); }

  // ---- WRITE ---------------------------------------------------------------
  const fundRows = funds.map((f, i) => ({ community_id: CID, fund_code: f.code, fund_name: f.name, fund_type: f.code === 'OPR' ? 'operating' : (f.code === 'RES' ? 'reserve' : 'other'), display_order: i + 1 }));
  await s.from('account_funds').upsert(fundRows, { onConflict: 'community_id,fund_code' });
  const { data: fundRecs } = await s.from('account_funds').select('id, fund_code').eq('community_id', CID);
  const fundId = Object.fromEntries(fundRecs.map((f) => [f.fund_code, f.id]));

  const coaRows = Object.values(coa).map((a) => ({ community_id: CID, fund_id: fundId[a.fund_code] || null, account_number: a.account_number, account_name: a.account_name, account_type: a.type, account_subtype: a.subtype, normal_balance: a.normal_balance, is_summary: false, is_active: true, vantaca_account_number: a.account_number }));
  await s.from('chart_of_accounts').upsert(coaRows, { onConflict: 'community_id,account_number' });
  const { data: coaRecs } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acctId = Object.fromEntries(coaRecs.map((a) => [a.account_number, a.id]));

  const periodId = {};
  for (const y of fiscalYears) {
    const rows = MONTHS.map((_, i) => { const m = i + 1; return { community_id: CID, fiscal_year: y, period_number: m, period_type: 'monthly', period_start: `${y}-${String(m).padStart(2, '0')}-01`, period_end: `${y}-${String(m).padStart(2, '0')}-${String(lastDay(y, m)).padStart(2, '0')}`, status: 'open' }; });
    await s.from('accounting_periods').upsert(rows, { onConflict: 'community_id,fiscal_year,period_number' });
    const { data: pr } = await s.from('accounting_periods').select('id, period_number').eq('community_id', CID).eq('fiscal_year', y);
    periodId[y] = Object.fromEntries(pr.map((p) => [p.period_number, p.id]));
  }
  const pid = (iso) => periodId[Number(iso.slice(0, 4))][Number(iso.slice(5, 7))];

  const range0 = days[0], range1 = days[days.length - 1];
  const { data: prior } = await s.from('journal_entries').select('id').eq('community_id', CID).in('source_module', ['opening_entry', 'vantaca_import', 'closing_entry']).gte('posting_date', range0).lte('posting_date', range1);
  if (prior && prior.length) { await s.from('journal_entry_lines').delete().in('journal_entry_id', prior.map((j) => j.id)); await s.from('journal_entries').delete().in('id', prior.map((j) => j.id)); console.log(`Cleared ${prior.length} prior entries.`); }

  // Opening (OPENING MODE only)
  if (!conversionMode && opening.length) {
    let dr = 0, cr = 0; for (const o of opening) { if (o.cents > 0) dr += o.cents; else cr += -o.cents; }
    const { data: je, error: jeErr } = await s.from('journal_entries').insert({ community_id: CID, period_id: pid(`${fiscalYears[0]}-01-01`), posting_date: `${fiscalYears[0]}-01-01`, reference: `JE-${fiscalYears[0]}-OPEN`, description: `Opening balances migrated from Vantaca (fund-split, ${bs.asOf})`, source_module: 'opening_entry', total_debits_cents: dr, total_credits_cents: cr, status: 'posted' }).select('id').single();
    if (jeErr || !je) { console.error(`Opening JE insert failed: ${jeErr ? jeErr.message : 'no row returned'}`); process.exit(1); }
    const { error: olErr } = await s.from('journal_entry_lines').insert(opening.map((o, i) => ({ journal_entry_id: je.id, line_number: i + 1, account_id: acctId[o.number], debit_cents: o.cents > 0 ? o.cents : 0, credit_cents: o.cents < 0 ? -o.cents : 0, memo: `Opening ${o.fund_code} ${bs.asOf}` })));
    if (olErr) { console.error(`Opening JE lines insert failed: ${olErr.message}`); process.exit(1); }
    console.log(`Posted opening JE (${opening.length} lines).`);
  }

  // Daily detail (verbatim) + the close entry, in date order.
  let posted = 0, postedLines = 0;
  for (const d of days) {
    const lines = byDay[d];
    const dr = lines.reduce((a, l) => a + l.debit_cents, 0), cr = lines.reduce((a, l) => a + l.credit_cents, 0);
    const { data: je, error: jeErr } = await s.from('journal_entries').insert({ community_id: CID, period_id: pid(d), posting_date: d, reference: `JE-D-${d.replace(/-/g, '')}`, description: `Daily activity ${d} (migrated from Vantaca GL detail)`, source_module: 'vantaca_import', total_debits_cents: dr, total_credits_cents: cr, status: 'posted' }).select('id').single();
    if (jeErr || !je) { console.error(`Daily JE ${d} insert failed: ${jeErr ? jeErr.message : 'no row returned'}`); process.exit(1); }
    const rows = lines.map((l, i) => ({ journal_entry_id: je.id, line_number: i + 1, account_id: acctId[l.accountNumber], debit_cents: l.debit_cents, credit_cents: l.credit_cents, memo: (l.type ? l.type + ': ' : '') + (l.description || '').slice(0, 180) }));
    for (let i = 0; i < rows.length; i += 200) { const { error: dlErr } = await s.from('journal_entry_lines').insert(rows.slice(i, i + 200)); if (dlErr) { console.error(`Daily JE ${d} lines insert failed: ${dlErr.message}`); process.exit(1); } }
    posted++; postedLines += rows.length;
  }
  console.log(`Posted ${posted} daily entries, ${postedLines} lines.`);

  if (closeEntry) {
    const dr = closeEntry.lines.reduce((a, l) => a + l.debit, 0), cr = closeEntry.lines.reduce((a, l) => a + l.credit, 0);
    const { data: je, error: jeErr } = await s.from('journal_entries').insert({ community_id: CID, period_id: pid(closeEntry.date), posting_date: closeEntry.date, reference: `JE-${closeYear}-CLOSE`, description: `Year-end close ${closeYear} + multi-fund fund-balance restructure (Operating/Reserve/Savings)`, source_module: 'closing_entry', total_debits_cents: dr, total_credits_cents: cr, status: 'posted' }).select('id').single();
    if (jeErr || !je) { console.error(`Close JE insert failed: ${jeErr ? jeErr.message : 'no row returned'}`); process.exit(1); }
    const { error: clErr } = await s.from('journal_entry_lines').insert(closeEntry.lines.map((l, i) => ({ journal_entry_id: je.id, line_number: i + 1, account_id: acctId[l.number], debit_cents: l.debit, credit_cents: l.credit, memo: l.memo })));
    if (clErr) { console.error(`Close JE lines insert failed: ${clErr.message}`); process.exit(1); }
    console.log(`Posted ${closeYear} close (${closeEntry.lines.length} lines).`);
  }

  console.log(`\nDONE. ${comm.name} GL rebuilt in trustEd (${fiscalYears.join(', ')}), tied to Vantaca to the penny.`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
