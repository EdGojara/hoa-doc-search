// ============================================================================
// lib/accounting/bs_categories.js — the standard balance-sheet categories, by ROLE
// ----------------------------------------------------------------------------
// Balance-sheet presentation is grouped only by a mapping a person approved,
// never inferred from account names (migration 505). This module is the ONE
// definition of the standard categories each durable account ROLE presents
// under, shared by:
//   * scripts/propose_balance_sheet_mapping.js — proposals for existing accounts
//     from roles found in the data (bank accounts, recognition schedules, equity);
//   * Kat's cutoff corrections (lib/accounting/cutoff_adjustments.js) — an
//     account Kat proposes to CREATE for a role (Accrued Expenses, Prepaid
//     Expenses) is mapped to that role's category as part of the owner's in-app
//     approval of the addition. The role is why the account exists, so nothing is
//     guessed; the approval screen names the category the owner is approving.
// A community that already has a category of that name (at any level, e.g.
// Canyon Gate's "Accrued liabilities" under "Other liabilities") uses it; one
// without it gets the standard top-level category created on that approval.
// ============================================================================

const CATS = {
  cash: { section: 'asset', name: 'Cash & cash equivalents', display_order: 10 },
  reserve: { section: 'asset', name: 'Reserve & investment accounts', display_order: 20 },
  prepaid: { section: 'asset', name: 'Prepaids', display_order: 40, aliases: ['prepaid expenses', 'prepaid assets'] },
  accrued: { section: 'liability', name: 'Accrued liabilities', display_order: 15, aliases: ['accrued expenses'] },
  deferred: { section: 'liability', name: 'Deferred assessments', display_order: 20 },
  fund_balance: { section: 'equity', name: 'Fund balance', display_order: 10 },
};

// Pure: the community's existing category for a role (same section; the standard name or one of
// its accepted names, any level). The standard name wins over an alias.
function findCategory(categories, role) {
  const c = CATS[role]; if (!c) return null;
  const live = (categories || []).filter((x) => x.section === c.section && x.is_active !== false);
  const nm = (x) => String(x.name || '').trim().toLowerCase();
  return live.find((x) => nm(x) === c.name.toLowerCase()) || live.find((x) => (c.aliases || []).includes(nm(x))) || null;
}

// What an addition's approval will do on the balance sheet (stored on the proposal; shown to the owner).
function plannedCategory(categories, role) {
  const c = CATS[role]; if (!c) return null;
  const hit = findCategory(categories, role);
  return hit ? { id: hit.id, name: hit.name, role } : { id: null, name: c.name, role, create: true };
}

// The category id for a role in this community, creating the standard top-level one if absent.
async function ensureCategory(supabase, community_id, role, actor) {
  const c = CATS[role]; if (!c) throw Object.assign(new Error(`unknown balance-sheet role ${role}`), { code: 'invalid_input' });
  const { data: cats, error } = await supabase.from('report_categories').select('id, section, name, is_active').eq('community_id', community_id).eq('statement', 'balance_sheet').limit(2000);
  if (error) throw new Error(`balance-sheet categories: ${error.message}`);
  const hit = findCategory(cats, role);
  if (hit) return { id: hit.id, name: hit.name, created: false };
  const { data: ins, error: ie } = await supabase.from('report_categories').insert({ community_id, statement: 'balance_sheet', section: c.section, name: c.name, display_order: c.display_order, is_active: true, updated_by: actor }).select('id').single();
  if (ie) throw new Error(`balance-sheet category ${c.name}: ${ie.message}`);
  return { id: ins.id, name: c.name, created: true };
}

module.exports = { CATS, findCategory, plannedCategory, ensureCategory };
