// ============================================================================
// lib/vendors/line_items.js  (Ed 2026-10-16: "do not rely on a fresh model-derived
// total on each run")
// ----------------------------------------------------------------------------
// Quantities that affect scope, licensing or contract review come from STORED line
// items, totalled in code. The model extracts line items once per document (keyed by
// the document's SHA-256, stored on the proposal record in
// vendor_proposals.extracted_data.comparison_items[].line_items); every count and dollar
// total after that is computed here, deterministically. Same stored items in, the same
// bytes out, on every run.
//
// Each line item: { description, category, quantity, unit, unit_price_cents,
//   extended_cents, page, excerpt, certainty: 'certain'|'uncertain', uncertain_reason }
// Categories: camera_new, camera_reused, license, recorder, network, labor, cloud_recurring,
//   materials_labor (a lump sum), other.
// Scope statements (what the narrative or cover says, with its page) are cross-checked
// against the itemized table:
//   scope_statements: [{ category, quantity, page, excerpt }]
//
// Cross-checks, never a silent pick:
//   - the line-item dollar sum must equal the printed subtotal
//   - a narrative quantity must equal the itemized quantity for the same category
// A disagreement or an item marked uncertain makes the quantity UNCERTAIN: it renders
// as "N per page X; M per page Y, unconfirmed" and becomes a named open item.
// No stored line items -> counts come from an in-memory extraction, labelled
// "not yet stored", and every count is provisional.
// ============================================================================

const CATEGORIES = ['camera_new', 'camera_reused', 'license', 'recorder', 'network', 'labor', 'cloud_recurring', 'materials_labor', 'other'];
const QTY_FIELDS = { cameras_new: ['camera_new'], cameras_reused: ['camera_reused'], licenses: ['license'] };

const sum = (xs) => xs.reduce((t, x) => t + x, 0);
const pagesOf = (items) => [...new Set(items.map((i) => i.page).filter((p) => p != null))].sort((a, b) => a - b);

/** Validate one line item (shape only). */
function validateLineItem(li) {
  const e = [];
  if (!li || typeof li !== 'object') return ['not an object'];
  if (!li.description) e.push('description missing');
  if (!CATEGORIES.includes(li.category)) e.push(`category ${li.category} not in ${CATEGORIES.join('|')}`);
  if (li.quantity != null && !(Number.isFinite(Number(li.quantity)) && Number(li.quantity) >= 0)) e.push('quantity invalid');
  for (const k of ['unit_price_cents', 'extended_cents']) if (li[k] != null && !Number.isInteger(li[k])) e.push(`${k} must be integer cents`);
  if (li.page != null && !Number.isInteger(li.page)) e.push('page must be an integer');
  if (li.certainty && !['certain', 'uncertain'].includes(li.certainty)) e.push('certainty must be certain|uncertain');
  return e;
}

/**
 * Deterministic quantities and totals from line items. Pure.
 * Returns { status, provisional, fields: { cameras_new, cameras_reused, cameras_total, licenses,
 *   embedded_server_cameras }, values (numbers), uncertain: [{ field, values:[{value, page, source}], reason }],
 *   subtotal: { items_cents, printed_cents, matches }, provenance: { field: [{page, excerpt, quantity}] }, errors }
 */
function computeQuantities(item) {
  const lis = Array.isArray(item && item.line_items) ? item.line_items : null;
  const status = !lis ? 'none' : item.line_items_stored === true ? 'stored' : 'not_yet_stored';
  const out = { status, provisional: status !== 'stored', values: {}, uncertain: [], provenance: {}, subtotal: null, errors: [] };
  if (!lis) return out;
  lis.forEach((li, i) => { const e = validateLineItem(li); if (e.length) out.errors.push(`line ${i + 1}: ${e.join('; ')}`); });
  const statements = Array.isArray(item.scope_statements) ? item.scope_statements : [];

  for (const [field, cats] of Object.entries(QTY_FIELDS)) {
    const rows = lis.filter((li) => cats.includes(li.category));
    const stmts = statements.filter((s) => cats.includes(s.category));
    if (!rows.length && !stmts.length) { out.values[field] = null; continue; }
    // Table quantity first; when only the narrative states it, the narrative is the source.
    const tableQty = rows.length ? sum(rows.map((r) => Number(r.quantity || 0))) : null;
    const stmtQty = stmts.length ? sum(stmts.map((s) => Number(s.quantity || 0))) : null;
    const value = tableQty != null ? tableQty : stmtQty;
    out.values[field] = value;
    out.provenance[field] = [...rows.map((r) => ({ page: r.page ?? null, excerpt: r.excerpt || r.description, quantity: Number(r.quantity || 0), source: 'itemized' })),
      ...stmts.map((s) => ({ page: s.page ?? null, excerpt: s.excerpt || null, quantity: Number(s.quantity || 0), source: 'narrative' }))];
    const reasons = [];
    if (tableQty != null && stmtQty != null && tableQty !== stmtQty) reasons.push('the itemized table and the narrative disagree');
    for (const r of rows.filter((x) => x.certainty === 'uncertain')) reasons.push(r.uncertain_reason || `"${r.description}" is ambiguous`);
    if (reasons.length) {
      const vals = [];
      if (tableQty != null) vals.push({ value: tableQty, page: pagesOf(rows).join('-') || null, source: 'itemized' });
      if (stmtQty != null && stmtQty !== tableQty) vals.push({ value: stmtQty, page: pagesOf(stmts).join('-') || null, source: 'narrative' });
      out.uncertain.push({ field, values: vals, reason: reasons.join('; ') });
    }
  }
  const nw = out.values.cameras_new; const ru = out.values.cameras_reused;
  out.values.cameras_total = nw == null && ru == null ? null : (nw || 0) + (ru || 0);
  out.values.embedded_server_cameras = sum(lis.filter((li) => li.embedded_server === true).map((li) => Number(li.quantity || 0)));
  if (out.uncertain.some((u) => ['cameras_new', 'cameras_reused'].includes(u.field))) out.uncertain.push({ field: 'cameras_total', values: [], reason: 'depends on an unconfirmed camera count' });

  // Dollar cross-check: the priced lines must add up to the printed subtotal.
  const priced = lis.filter((li) => Number.isInteger(li.extended_cents));
  const printed = Number.isInteger(item.printed_subtotal_cents) ? item.printed_subtotal_cents : null;
  if (priced.length) {
    const itemsCents = sum(priced.map((li) => li.extended_cents));
    out.subtotal = { items_cents: itemsCents, printed_cents: printed, matches: printed == null ? null : itemsCents === printed };
    if (printed != null && itemsCents !== printed) out.uncertain.push({ field: 'upfront_cents', values: [{ value: itemsCents, page: pagesOf(priced).join('-') || null, source: 'line items' }, { value: printed, page: item.printed_subtotal_page ?? null, source: 'printed subtotal' }], reason: 'the line items do not add up to the printed subtotal' });
  }
  return out;
}

/** "N per page X; M per page Y, unconfirmed" (or the value alone when certain). */
function renderQuantity(q, field, { unit = '' } = {}) {
  const u = (q.uncertain || []).find((x) => x.field === field);
  const v = q.values ? q.values[field] : null;
  if (u && u.values.length > 1) return `${u.values.map((x) => `${x.value}${unit} per page ${x.page ?? '?'}`).join('; ')}, unconfirmed`;
  if (u) return `${v}${unit} (unconfirmed: ${u.reason})`;
  return v == null ? null : `${v}${unit}`;
}

/**
 * Apply computed quantities onto an extracted proposal item: the scope counts become the
 * computed values (never the model's own totals), and the item carries `quantities`.
 * Items with no line items keep their counts but are marked provisional ('none').
 */
function applyLineItems(item) {
  const q = computeQuantities(item);
  const scope = { ...(item.scope || {}) };
  if (q.status !== 'none') {
    scope.cameras_new = q.values.cameras_new; scope.cameras_reused = q.values.cameras_reused;
    scope.cameras_total = q.values.cameras_total; scope.licenses = q.values.licenses;
    scope.embedded_server_cameras = q.values.embedded_server_cameras;
  }
  return { ...item, scope, quantities: q };
}

module.exports = { CATEGORIES, validateLineItem, computeQuantities, renderQuantity, applyLineItems };
