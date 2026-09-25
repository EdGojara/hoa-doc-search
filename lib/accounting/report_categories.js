// ============================================================================
// lib/accounting/report_categories.js — presentation grouping for statements.
// ----------------------------------------------------------------------------
// Reporting categories Phase 1 (Ed 2026-09-25). The GL account stays the
// accounting truth; report_categories + account_report_map (migration 463) say
// how each account PRESENTS on a statement. One grouping function serves Budget
// vs Actual, the Income Statement vs Budget, and (later) board packages.
//
// Rules this module guarantees:
//   * Grouping never changes a number. Every subtotal is the sum of the rows
//     under it; section totals are summed from the rows themselves, and the
//     tree is checked to tie before it is returned.
//   * An account with no mapping lands in a visible "Unmapped" bucket inside
//     its section and is included in every total. Nothing is dropped.
//   * A community with no categories gets has_mapping=false and callers keep
//     their existing presentation.
// ============================================================================

const STATEMENT = 'income_statement';
const UNMAPPED_LABEL = 'Unmapped (needs a report category)';

// Read one community's categories + account mapping for a statement.
async function loadReportMapping(supabase, community_id, statement = STATEMENT) {
  const [cats, maps] = await Promise.all([
    supabase.from('report_categories')
      .select('id, section, name, report_label, parent_category_id, display_order, is_active')
      .eq('community_id', community_id).eq('statement', statement)
      .order('display_order').order('name').limit(2000),
    supabase.from('account_report_map')
      .select('account_id, category_id, display_order')
      .eq('community_id', community_id).eq('statement', statement)
      .order('account_id').limit(5000),
  ]);
  if (cats.error) throw cats.error;
  if (maps.error) throw maps.error;
  return buildMapping(cats.data || [], maps.data || []);
}

// Pure: categories + map rows -> lookup structure.
function buildMapping(categories, mapRows) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const byAccount = new Map();
  for (const m of mapRows) {
    const leaf = byId.get(m.category_id);
    if (!leaf) continue;                                   // defensive: treated as Unmapped
    const top = leaf.parent_category_id ? byId.get(leaf.parent_category_id) : leaf;
    if (!top) continue;
    byAccount.set(m.account_id, { top, sub: leaf.parent_category_id ? leaf : null, display_order: m.display_order });
  }
  return { has_mapping: categories.length > 0, categories, byAccount };
}

const label = (c) => (c.report_label && c.report_label.trim()) || c.name;
const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const addInto = (dst, row, keys) => { for (const k of keys) dst[k] += Number(row[k] || 0); };
const sumRows = (rows, keys) => { const t = zero(keys); rows.forEach((r) => addInto(t, r, keys)); return t; };
const byOrder = (a, b) => (a.display_order ?? 100) - (b.display_order ?? 100) || String(a.name).localeCompare(String(b.name));

/**
 * Group statement rows by the mapping.
 * @param rows      rows with account_id, account_type ('revenue'|'expense'), account_number, fund_code, and amount keys
 * @param mapping   from buildMapping / loadReportMapping
 * @param amountKeys which numeric fields to subtotal
 * @returns { has_mapping, amount_keys, sections:[{section, label, categories:[...], unmapped, totals}], totals:{revenue, expense, net}, unmapped_count }
 */
function groupStatementRows(rows, mapping, amountKeys) {
  const sections = [];
  let unmappedCount = 0;
  const rowOrder = (a, b) => {
    const ma = mapping.byAccount.get(a.account_id), mb = mapping.byAccount.get(b.account_id);
    return ((ma && ma.display_order) ?? 1e9) - ((mb && mb.display_order) ?? 1e9)
      || String(a.account_number).localeCompare(String(b.account_number))
      || String(a.fund_code || '').localeCompare(String(b.fund_code || ''));
  };
  for (const section of ['revenue', 'expense']) {
    const secRows = rows.filter((r) => r.account_type === section);
    const topMap = new Map();   // top.id -> { cat, direct:[], subs: Map(sub.id -> {cat, rows}) }
    const unmapped = [];
    for (const r of secRows) {
      const m = mapping.byAccount.get(r.account_id);
      if (!m || m.top.section !== section) { unmapped.push(r); continue; }
      let t = topMap.get(m.top.id);
      if (!t) { t = { cat: m.top, direct: [], subs: new Map() }; topMap.set(m.top.id, t); }
      if (!m.sub) { t.direct.push(r); continue; }
      let s = t.subs.get(m.sub.id);
      if (!s) { s = { cat: m.sub, rows: [] }; t.subs.set(m.sub.id, s); }
      s.rows.push(r);
    }
    const categories = [...topMap.values()].sort((a, b) => byOrder(a.cat, b.cat)).map((t) => {
      const subcategories = [...t.subs.values()].sort((a, b) => byOrder(a.cat, b.cat)).map((s) => {
        const srows = s.rows.slice().sort(rowOrder);
        return { id: s.cat.id, name: s.cat.name, label: label(s.cat), rows: srows, totals: sumRows(srows, amountKeys) };
      });
      const direct = t.direct.slice().sort(rowOrder);
      const all = [...direct, ...subcategories.flatMap((s) => s.rows)];
      return { id: t.cat.id, name: t.cat.name, label: label(t.cat), rows: direct, subcategories, totals: sumRows(all, amountKeys) };
    });
    unmappedCount += unmapped.length;
    const umRows = unmapped.slice().sort(rowOrder);
    const totals = sumRows(secRows, amountKeys);
    // Tie-out: categories + unmapped must equal the section's own rows, exactly.
    const check = sumRows([...categories.flatMap((c) => [...c.rows, ...c.subcategories.flatMap((s) => s.rows)]), ...umRows], amountKeys);
    for (const k of amountKeys) {
      if (check[k] !== totals[k]) throw new Error(`report grouping does not tie (${section} ${k}: ${check[k]} vs ${totals[k]})`);
    }
    sections.push({
      section, label: section === 'revenue' ? 'Revenue' : 'Expenses',
      categories,
      unmapped: { label: UNMAPPED_LABEL, rows: umRows, totals: sumRows(umRows, amountKeys) },
      totals,
    });
  }
  const rev = sections[0].totals, exp = sections[1].totals;
  const net = zero(amountKeys); for (const k of amountKeys) net[k] = rev[k] - exp[k];
  return { has_mapping: mapping.has_mapping, amount_keys: amountKeys, sections, totals: { revenue: rev, expense: exp, net }, unmapped_count: unmappedCount };
}

module.exports = { STATEMENT, UNMAPPED_LABEL, loadReportMapping, buildMapping, groupStatementRows };
