// ============================================================================
// scripts/seed_community_gl.js
// ----------------------------------------------------------------------------
// Stand up a community's GL foundation at ZERO balance: funds, a standard HOA
// chart of accounts (fund-tagged, normal-balance set), 12 monthly accounting
// periods for the fiscal year, and §209.0063-aware AR charge types mapped to
// their GL revenue + receivable accounts. No journal entries, no charges — the
// books open at zero. Idempotent (upserts on the natural unique keys).
//
//   node scripts/seed_community_gl.js --community=august-meadows --year=2026
//
// Requires migration 231 (service_role grants) applied first, or every write
// hits permission denied (42501).
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const slug = arg('community');
const YEAR = parseInt(arg('year', '2026'), 10);

// Standard HOA chart of accounts. fund: 'OPR' | 'RES' | null(shared).
// normal_balance: assets/expenses debit; liabilities/equity/revenue credit.
const COA = [
  // Operating — Assets
  ['1010', 'Operating Cash', 'asset', 'cash', 'debit', 'OPR'],
  ['1200', 'Assessments Receivable', 'asset', 'receivable', 'debit', 'OPR'],
  ['1210', 'Allowance for Doubtful Accounts', 'asset', 'receivable', 'credit', 'OPR'],
  // Operating — Liabilities
  ['2010', 'Accounts Payable', 'liability', 'current_liability', 'credit', 'OPR'],
  ['2110', 'Prepaid Assessments', 'liability', 'current_liability', 'credit', 'OPR'],
  // Operating — Equity
  ['3010', 'Operating Fund Balance', 'equity', 'fund_balance', 'credit', 'OPR'],
  // Operating — Revenue
  ['4010', 'Assessment Income', 'revenue', 'assessment', 'credit', 'OPR'],
  ['4020', 'Late Fee Income', 'revenue', 'fee', 'credit', 'OPR'],
  ['4030', 'Interest Income', 'revenue', 'interest', 'credit', 'OPR'],
  ['4040', 'Collection & Attorney Fee Income', 'revenue', 'fee', 'credit', 'OPR'],
  ['4050', 'Fine Income', 'revenue', 'fee', 'credit', 'OPR'],
  ['4090', 'Other Income', 'revenue', 'other', 'credit', 'OPR'],
  // Operating — Expenses
  ['5010', 'Management Fees', 'expense', 'operating_expense', 'debit', 'OPR'],
  ['5020', 'Landscaping', 'expense', 'operating_expense', 'debit', 'OPR'],
  ['5030', 'Utilities', 'expense', 'operating_expense', 'debit', 'OPR'],
  ['5040', 'Insurance', 'expense', 'operating_expense', 'debit', 'OPR'],
  ['5050', 'Repairs & Maintenance', 'expense', 'operating_expense', 'debit', 'OPR'],
  ['5060', 'Legal & Professional', 'expense', 'operating_expense', 'debit', 'OPR'],
  ['5070', 'Administrative', 'expense', 'operating_expense', 'debit', 'OPR'],
  ['5900', 'Reserve Contribution', 'expense', 'transfer', 'debit', 'OPR'],
  // Reserve — Assets / Equity / Revenue / Expense
  ['1015', 'Reserve Cash', 'asset', 'cash', 'debit', 'RES'],
  ['3020', 'Reserve Fund Balance', 'equity', 'fund_balance', 'credit', 'RES'],
  ['4520', 'Reserve Contributions', 'revenue', 'transfer', 'credit', 'RES'],
  ['4530', 'Reserve Interest Income', 'revenue', 'interest', 'credit', 'RES'],
  ['6010', 'Reserve Expenditures', 'expense', 'reserve_expense', 'debit', 'RES'],
];

// AR charge types → §209.0063 payment-application priority + GL mapping.
// gl_revenue / gl_receivable are account_numbers resolved to ids below.
// type_code, display_name, category (§209.0063), tx_priority_step (1=highest),
// gl_revenue account, gl_receivable account. Priority follows §209.0063 payment
// application order: delinquent assessment → interest → collection/attorney →
// records → other attorney → fines → other fees.
const CHARGE_TYPES = [
  ['assessment_regular',   'Regular Assessment',          'assessment',                      1, '4010', '1200'],
  ['interest',             'Interest',                    'interest',                        2, '4030', '1200'],
  ['attorney_fee_collection','Collection / Attorney Fee', 'attorney_fee_assessment_related', 3, '4040', '1200'],
  ['records_request_fee',  'Records Request Fee',         'records_request_fee',             4, '4090', '1200'],
  ['attorney_fee_other',   'Attorney Fee (Other)',        'attorney_fee_other',              5, '4040', '1200'],
  ['fine',                 'Fine',                        'fine',                            6, '4050', '1200'],
  ['late_fee',             'Late Fee',                    'late_fee',                        7, '4020', '1200'],
  ['certified_mail_fee',   'Certified Mail Fee',          'other',                           7, '4090', '1200'],
  ['transfer_fee',         'Transfer Fee',                'transfer_fee',                    7, '4090', '1200'],
  ['resale_certificate_fee','Resale Certificate Fee',     'resale_certificate_fee',          7, '4090', '1200'],
  ['nsf_fee',              'NSF / Returned Payment Fee',  'nsf_fee',                         7, '4090', '1200'],
];

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

(async () => {
  if (!slug) { console.error('need --community=<slug>'); process.exit(1); }
  const { data: comm, error: cErr } = await s.from('communities').select('id, name').eq('slug', slug).maybeSingle();
  if (cErr) { console.error('community lookup failed:', cErr.message); process.exit(1); }
  if (!comm) { console.error('community not found:', slug); process.exit(1); }
  const CID = comm.id;
  console.log(`Seeding GL for ${comm.name} (${slug}), FY ${YEAR}`);

  // 1) Funds
  const fundsSeed = [
    { community_id: CID, fund_code: 'OPR', fund_name: 'Operating Fund', fund_type: 'operating', display_order: 1 },
    { community_id: CID, fund_code: 'RES', fund_name: 'Reserve Fund', fund_type: 'reserve', display_order: 2 },
  ];
  const { error: fErr } = await s.from('account_funds').upsert(fundsSeed, { onConflict: 'community_id,fund_code' });
  if (fErr) { console.error('funds upsert failed:', fErr.message); process.exit(1); }
  const { data: funds } = await s.from('account_funds').select('id, fund_code').eq('community_id', CID);
  const fundId = Object.fromEntries((funds || []).map((f) => [f.fund_code, f.id]));
  console.log(`  funds: ${(funds || []).length}`);

  // 2) Chart of accounts
  const coaSeed = COA.map(([num, name, type, subtype, nb, fund]) => ({
    community_id: CID, fund_id: fund ? fundId[fund] : null,
    account_number: num, account_name: name, account_type: type, account_subtype: subtype,
    normal_balance: nb, is_summary: false, is_active: true,
  }));
  const { error: coaErr } = await s.from('chart_of_accounts').upsert(coaSeed, { onConflict: 'community_id,account_number' });
  if (coaErr) { console.error('CoA upsert failed:', coaErr.message); process.exit(1); }
  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acctId = Object.fromEntries((coa || []).map((a) => [a.account_number, a.id]));
  console.log(`  chart of accounts: ${(coa || []).length}`);

  // 3) Accounting periods (12 monthly)
  const periodsSeed = MONTHS.map((_, i) => {
    const m = i + 1;
    return {
      community_id: CID, fiscal_year: YEAR, period_number: m, period_type: 'monthly',
      period_start: `${YEAR}-${String(m).padStart(2, '0')}-01`,
      period_end: `${YEAR}-${String(m).padStart(2, '0')}-${String(lastDay(YEAR, m)).padStart(2, '0')}`,
      status: 'open',
    };
  });
  const { error: pErr } = await s.from('accounting_periods').upsert(periodsSeed, { onConflict: 'community_id,fiscal_year,period_number' });
  if (pErr) { console.error('periods upsert failed:', pErr.message); process.exit(1); }
  console.log(`  accounting periods: ${periodsSeed.length} (FY ${YEAR} monthly)`);

  // 4) AR charge types (GL-mapped)
  const ctSeed = CHARGE_TYPES.map(([code, name, cat, prio, rev, recv], i) => ({
    community_id: CID, type_code: code, display_name: name, category: cat, tx_priority_step: prio,
    gl_revenue_account_id: acctId[rev] || null, gl_receivable_account_id: acctId[recv] || null,
    is_active: true, display_order: i + 1,
  }));
  const { error: ctErr } = await s.from('ar_charge_types').upsert(ctSeed, { onConflict: 'community_id,type_code' });
  if (ctErr) { console.error('charge types upsert failed:', ctErr.message); process.exit(1); }
  console.log(`  AR charge types: ${ctSeed.length}`);

  // 5) Confirm zero balance (no posted journal entries)
  const { count: jeCount } = await s.from('journal_entries').select('id', { count: 'exact', head: true }).eq('community_id', CID);
  console.log(`\nDONE. ${comm.name} books are OPEN at zero balance (${jeCount || 0} journal entries).`);
})();
