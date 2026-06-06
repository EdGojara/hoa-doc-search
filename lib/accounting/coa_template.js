// ============================================================================
// lib/accounting/coa_template.js — HOA standard Chart of Accounts template
// ----------------------------------------------------------------------------
// Modeled on Vantaca's standard HOA CoA convention so migration from Vantaca
// is one-to-one. Used by onboardCommunityToGL() to seed a new community's
// chart of accounts in one shot.
//
// NUMBERING:
//   1xxxx — Assets
//   2xxxx — Liabilities
//   3xxxx — Equity / Fund Balance
//   4xxxx — Revenue
//   5xxxx — Operating Expenses
//   6xxxx — Reserve Expenses
//   7xxxx — Capital / Special Projects
//
// FUNDS: Operating + Reserve seeded by default. Additional funds
// (Special Assessment, Capital Improvement) added per-community as needed.
//
// Each account has:
//   - number, name, type, subtype, normal_balance
//   - is_summary (rollup parents) vs detail (postable)
//   - parent_number (for rollup hierarchy)
//   - fund_code ('OPR', 'RES', or null for shared)
//   - vantaca_account_number (typically same as our number — explicit for
//     clarity at migration time)
//
// This template can be REFINED per Ed's actual Vantaca CoA export when
// available. The current version is industry-standard HOA accounting.
// ============================================================================

// Standard fund definitions
const STANDARD_FUNDS = [
  { code: 'OPR', name: 'Operating Fund', type: 'operating', display_order: 1 },
  { code: 'RES', name: 'Reserve Fund', type: 'reserve', display_order: 2 },
];

// Standard chart of accounts (HOA pattern, Vantaca-aligned)
// fund_code: 'OPR' for operating-specific, 'RES' for reserve-specific,
//            null for accounts that may flow to either fund
const STANDARD_COA = [
  // ===== ASSETS (1xxxx) =====
  { number: '10000', name: 'CURRENT ASSETS', type: 'asset', subtype: 'header', normal_balance: 'debit', is_summary: true, parent_number: null, fund_code: null },

  // Cash
  { number: '10100', name: 'Cash — Operating', type: 'asset', subtype: 'cash', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },
  { number: '10200', name: 'Cash — Reserve', type: 'asset', subtype: 'cash', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'RES' },
  { number: '10300', name: 'Cash — Money Market', type: 'asset', subtype: 'cash', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'RES' },
  { number: '10400', name: 'Petty Cash', type: 'asset', subtype: 'cash', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },

  // Receivables
  { number: '12000', name: 'Accounts Receivable — Assessments', type: 'asset', subtype: 'receivable', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },
  { number: '12100', name: 'Accounts Receivable — Late Fees', type: 'asset', subtype: 'receivable', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },
  { number: '12200', name: 'Accounts Receivable — Special Assessments', type: 'asset', subtype: 'receivable', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: null },
  { number: '12300', name: 'Accounts Receivable — Other', type: 'asset', subtype: 'receivable', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },
  { number: '12900', name: 'Allowance for Doubtful Accounts', type: 'asset', subtype: 'contra_receivable', normal_balance: 'credit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },

  // Other current
  { number: '13000', name: 'Prepaid Expenses', type: 'asset', subtype: 'current_asset', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },
  { number: '13100', name: 'Prepaid Insurance', type: 'asset', subtype: 'current_asset', normal_balance: 'debit', is_summary: false, parent_number: '10000', fund_code: 'OPR' },

  // Reserve investments
  { number: '14000', name: 'INVESTMENTS', type: 'asset', subtype: 'header', normal_balance: 'debit', is_summary: true, parent_number: null, fund_code: null },
  { number: '14100', name: 'Reserve Investments — CDs', type: 'asset', subtype: 'investment', normal_balance: 'debit', is_summary: false, parent_number: '14000', fund_code: 'RES' },
  { number: '14200', name: 'Reserve Investments — Treasury', type: 'asset', subtype: 'investment', normal_balance: 'debit', is_summary: false, parent_number: '14000', fund_code: 'RES' },

  // ===== LIABILITIES (2xxxx) =====
  { number: '20000', name: 'CURRENT LIABILITIES', type: 'liability', subtype: 'header', normal_balance: 'credit', is_summary: true, parent_number: null, fund_code: null },
  { number: '20100', name: 'Accounts Payable', type: 'liability', subtype: 'payable', normal_balance: 'credit', is_summary: false, parent_number: '20000', fund_code: 'OPR' },
  { number: '20200', name: 'Accrued Expenses', type: 'liability', subtype: 'accrued', normal_balance: 'credit', is_summary: false, parent_number: '20000', fund_code: 'OPR' },
  { number: '20300', name: 'Prepaid Assessments (Deferred Revenue)', type: 'liability', subtype: 'deferred_revenue', normal_balance: 'credit', is_summary: false, parent_number: '20000', fund_code: 'OPR' },
  { number: '20400', name: 'Security Deposits Held', type: 'liability', subtype: 'deposit_held', normal_balance: 'credit', is_summary: false, parent_number: '20000', fund_code: 'OPR' },
  { number: '20500', name: 'Sales Tax Payable', type: 'liability', subtype: 'tax_payable', normal_balance: 'credit', is_summary: false, parent_number: '20000', fund_code: 'OPR' },

  // ===== EQUITY / FUND BALANCE (3xxxx) =====
  { number: '30000', name: 'FUND BALANCE', type: 'equity', subtype: 'header', normal_balance: 'credit', is_summary: true, parent_number: null, fund_code: null },
  { number: '30100', name: 'Fund Balance — Operating', type: 'equity', subtype: 'fund_balance', normal_balance: 'credit', is_summary: false, parent_number: '30000', fund_code: 'OPR' },
  { number: '30200', name: 'Fund Balance — Reserve', type: 'equity', subtype: 'fund_balance', normal_balance: 'credit', is_summary: false, parent_number: '30000', fund_code: 'RES' },
  { number: '30900', name: 'Current Year Net Income (Closing)', type: 'equity', subtype: 'closing', normal_balance: 'credit', is_summary: false, parent_number: '30000', fund_code: null },

  // ===== REVENUE (4xxxx) =====
  { number: '40000', name: 'REVENUE', type: 'revenue', subtype: 'header', normal_balance: 'credit', is_summary: true, parent_number: null, fund_code: null },
  { number: '40100', name: 'Assessment Income — Regular', type: 'revenue', subtype: 'assessment_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40150', name: 'Assessment Income — Reserve Contribution', type: 'revenue', subtype: 'assessment_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'RES' },
  { number: '40200', name: 'Assessment Income — Special Assessment', type: 'revenue', subtype: 'assessment_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: null },
  { number: '40300', name: 'Late Fees', type: 'revenue', subtype: 'fee_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40310', name: 'NSF / Returned Check Fees', type: 'revenue', subtype: 'fee_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40320', name: 'Transfer / Resale Certificate Fees', type: 'revenue', subtype: 'fee_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40330', name: 'Fines & Violations', type: 'revenue', subtype: 'fee_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40340', name: 'Architectural Review Fees', type: 'revenue', subtype: 'fee_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40400', name: 'Clubhouse / Amenity Rental Income', type: 'revenue', subtype: 'rental_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40500', name: 'Interest Income — Operating', type: 'revenue', subtype: 'interest_income', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },
  { number: '40510', name: 'Interest Income — Reserve', type: 'revenue', subtype: 'interest_income', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'RES' },
  { number: '40900', name: 'Other Income', type: 'revenue', subtype: 'other_revenue', normal_balance: 'credit', is_summary: false, parent_number: '40000', fund_code: 'OPR' },

  // ===== OPERATING EXPENSES (5xxxx) =====
  { number: '50000', name: 'OPERATING EXPENSES', type: 'expense', subtype: 'header', normal_balance: 'debit', is_summary: true, parent_number: null, fund_code: null },

  // Management + admin
  { number: '50100', name: 'Management Fees', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50200', name: 'Audit / Tax Preparation', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50300', name: 'Legal Fees — General', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50310', name: 'Legal Fees — Collections', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50400', name: 'Office Supplies', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50410', name: 'Postage / Printing', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50500', name: 'Bank Charges', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  // Insurance
  { number: '50600', name: 'Insurance — Property/Liability', type: 'expense', subtype: 'insurance', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50610', name: 'Insurance — D&O', type: 'expense', subtype: 'insurance', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50620', name: 'Insurance — Workers Comp', type: 'expense', subtype: 'insurance', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  // Utilities
  { number: '50700', name: 'Utilities — Electric', type: 'expense', subtype: 'utility', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50710', name: 'Utilities — Water / Sewer', type: 'expense', subtype: 'utility', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50720', name: 'Utilities — Gas', type: 'expense', subtype: 'utility', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50730', name: 'Utilities — Trash / Recycling', type: 'expense', subtype: 'utility', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  // Grounds + amenities
  { number: '50800', name: 'Landscaping', type: 'expense', subtype: 'grounds', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50810', name: 'Landscape Enhancements', type: 'expense', subtype: 'grounds', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50820', name: 'Tree Maintenance', type: 'expense', subtype: 'grounds', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50830', name: 'Irrigation', type: 'expense', subtype: 'grounds', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  { number: '50900', name: 'Pool — Service Contract', type: 'expense', subtype: 'amenity', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50910', name: 'Pool — Chemicals / Supplies', type: 'expense', subtype: 'amenity', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '50920', name: 'Pool — Repairs', type: 'expense', subtype: 'amenity', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  { number: '51000', name: 'Janitorial / Common Area Cleaning', type: 'expense', subtype: 'maintenance', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '51100', name: 'Security / Patrol', type: 'expense', subtype: 'security', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '51110', name: 'Gate Access / Key Fob System', type: 'expense', subtype: 'security', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  // Repairs + maintenance
  { number: '51200', name: 'Repairs & Maintenance — Common Areas', type: 'expense', subtype: 'maintenance', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '51210', name: 'Repairs & Maintenance — Amenities', type: 'expense', subtype: 'maintenance', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '51220', name: 'Repairs & Maintenance — Fencing', type: 'expense', subtype: 'maintenance', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  // Misc
  { number: '51900', name: 'Bad Debt Expense', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },
  { number: '51999', name: 'Other Operating Expenses', type: 'expense', subtype: 'admin', normal_balance: 'debit', is_summary: false, parent_number: '50000', fund_code: 'OPR' },

  // ===== RESERVE EXPENSES (6xxxx) =====
  { number: '60000', name: 'RESERVE EXPENDITURES', type: 'expense', subtype: 'header', normal_balance: 'debit', is_summary: true, parent_number: null, fund_code: null },
  { number: '60100', name: 'Reserve — Roofing', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60110', name: 'Reserve — Painting', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60120', name: 'Reserve — Paving / Parking', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60130', name: 'Reserve — Pool Resurfacing', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60140', name: 'Reserve — HVAC / Mechanical', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60150', name: 'Reserve — Fencing / Walls', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60160', name: 'Reserve — Playground / Amenity Replacement', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60170', name: 'Reserve Study Costs', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },
  { number: '60900', name: 'Reserve — Other', type: 'expense', subtype: 'reserve_expenditure', normal_balance: 'debit', is_summary: false, parent_number: '60000', fund_code: 'RES' },

  // ===== CAPITAL / SPECIAL PROJECTS (7xxxx) =====
  { number: '70000', name: 'CAPITAL IMPROVEMENTS', type: 'expense', subtype: 'header', normal_balance: 'debit', is_summary: true, parent_number: null, fund_code: null },
  { number: '70100', name: 'Capital Improvement — Project Cost', type: 'expense', subtype: 'capital', normal_balance: 'debit', is_summary: false, parent_number: '70000', fund_code: null },
  { number: '70900', name: 'Special Project Expenses', type: 'expense', subtype: 'capital', normal_balance: 'debit', is_summary: false, parent_number: '70000', fund_code: null },
];

/**
 * Seed the standard CoA + funds for a community.
 * Idempotent — if community already has funds/accounts, returns existing
 * counts without duplicating.
 */
async function onboardCommunityToGL({ community_id, supabase }) {
  if (!community_id) throw new Error('community_id_required');

  // Check existing
  const { data: existingFunds } = await supabase
    .from('account_funds')
    .select('id, fund_code')
    .eq('community_id', community_id);
  const { data: existingAccounts } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number')
    .eq('community_id', community_id);

  // Skip already-set-up communities
  if ((existingFunds || []).length > 0 && (existingAccounts || []).length > 0) {
    return {
      already_set_up: true,
      funds_count: existingFunds.length,
      accounts_count: existingAccounts.length,
    };
  }

  // Insert funds
  let fundsByCode = {};
  if ((existingFunds || []).length === 0) {
    const fundRows = STANDARD_FUNDS.map((f) => ({
      community_id,
      fund_code: f.code,
      fund_name: f.name,
      fund_type: f.type,
      display_order: f.display_order,
      is_active: true,
    }));
    const { data: insertedFunds, error: fundErr } = await supabase
      .from('account_funds').insert(fundRows).select('*');
    if (fundErr) throw fundErr;
    fundsByCode = Object.fromEntries((insertedFunds || []).map((f) => [f.fund_code, f.id]));
  } else {
    fundsByCode = Object.fromEntries((existingFunds || []).map((f) => [f.fund_code, f.id]));
  }

  // Pass 1: insert all accounts WITHOUT parent_account_id (we don't have UUIDs yet)
  const accountRows = STANDARD_COA.map((a) => ({
    community_id,
    fund_id: a.fund_code ? (fundsByCode[a.fund_code] || null) : null,
    account_number: a.number,
    account_name: a.name,
    account_type: a.type,
    account_subtype: a.subtype || null,
    normal_balance: a.normal_balance,
    is_summary: a.is_summary,
    is_active: true,
    vantaca_account_number: a.number,           // 1:1 default; refine after Vantaca export review
  }));

  const { data: insertedAccounts, error: acctErr } = await supabase
    .from('chart_of_accounts').insert(accountRows).select('id, account_number');
  if (acctErr) throw acctErr;

  // Pass 2: set parent_account_id by mapping account_number → id
  const idByNumber = Object.fromEntries((insertedAccounts || []).map((a) => [a.account_number, a.id]));
  const updates = STANDARD_COA
    .filter((a) => a.parent_number && idByNumber[a.parent_number] && idByNumber[a.number])
    .map(async (a) => {
      return supabase.from('chart_of_accounts')
        .update({ parent_account_id: idByNumber[a.parent_number] })
        .eq('id', idByNumber[a.number]);
    });
  await Promise.all(updates);

  return {
    already_set_up: false,
    funds_count: Object.keys(fundsByCode).length,
    accounts_count: insertedAccounts.length,
  };
}

/**
 * Open the first accounting period for a community starting from a go-live date.
 * Default cadence is monthly. Caller provides start date (e.g. '2026-06-01')
 * and the number of months ahead to pre-create (default 12).
 */
async function openInitialPeriods({ community_id, supabase, start_date, months_ahead = 12 }) {
  if (!community_id || !start_date) throw new Error('community_id_and_start_date_required');

  const start = new Date(start_date + 'T12:00:00Z');
  const rows = [];
  for (let i = 0; i < months_ahead; i++) {
    const periodStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const periodEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 0));
    rows.push({
      community_id,
      fiscal_year: periodStart.getUTCFullYear(),
      period_number: periodStart.getUTCMonth() + 1,
      period_type: 'monthly',
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      status: i === 0 ? 'open' : 'open',   // all open until explicitly closed
    });
  }
  // Skip rows that already exist (unique constraint guard)
  const { data: existing } = await supabase
    .from('accounting_periods')
    .select('fiscal_year, period_number')
    .eq('community_id', community_id);
  const existingKey = new Set((existing || []).map((p) => `${p.fiscal_year}-${p.period_number}`));
  const toInsert = rows.filter((r) => !existingKey.has(`${r.fiscal_year}-${r.period_number}`));
  if (toInsert.length === 0) return { inserted: 0 };
  const { error } = await supabase.from('accounting_periods').insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length };
}

module.exports = { STANDARD_FUNDS, STANDARD_COA, onboardCommunityToGL, openInitialPeriods };
