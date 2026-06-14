// ============================================================================
// lib/enforcement/category_aliases.js — category equivalence helpers
// ----------------------------------------------------------------------------
// Ed 2026-06-13: Vantaca-imported categories ("Sod yard") and trustEd's
// standard categories ("lawn_dead_patches") are semantically equivalent but
// have different primary_category_id values. The escalation engine's per-
// category prior-lookup misses these prior violations.
//
// This helper expands any category to include all its CONFIRMED aliases, so
// the engine sees a unified history regardless of which category label the
// import path happened to use.
//
// Only 'confirmed' aliases take effect — 'ai_suggested' rows are visible in
// the admin UI for review but don't affect engine math until the operator
// confirms them.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Given a category_id, return an array of category_ids that includes:
 *   - The input category_id itself
 *   - All categories aliased TO this one (confirmed)
 *   - The canonical category this aliases to (if this IS an alias), AND
 *     siblings that share that canonical.
 *
 * Result is deduplicated. Use this directly in `.in('primary_category_id', [...])`
 * when querying priors.
 *
 * @param {string} categoryId
 * @returns {Promise<string[]>}
 */
async function expandCategoryToAliases(categoryId) {
  if (!categoryId) return [];
  const ids = new Set([categoryId]);

  // 1. Categories aliased TO this one (this category is canonical for them)
  const { data: aliasingMe } = await supabase
    .from('enforcement_category_aliases')
    .select('alias_category_id')
    .eq('canonical_category_id', categoryId)
    .eq('status', 'confirmed');
  for (const r of (aliasingMe || [])) ids.add(r.alias_category_id);

  // 2. If THIS category is an alias to something else, find the canonical
  // and all siblings that share it.
  const { data: amAlias } = await supabase
    .from('enforcement_category_aliases')
    .select('canonical_category_id')
    .eq('alias_category_id', categoryId)
    .eq('status', 'confirmed')
    .maybeSingle();
  if (amAlias && amAlias.canonical_category_id) {
    ids.add(amAlias.canonical_category_id);
    const { data: siblings } = await supabase
      .from('enforcement_category_aliases')
      .select('alias_category_id')
      .eq('canonical_category_id', amAlias.canonical_category_id)
      .eq('status', 'confirmed');
    for (const r of (siblings || [])) ids.add(r.alias_category_id);
  }

  return [...ids];
}

/**
 * Returns the canonical category_id for a given category_id. If this is an
 * alias, returns the canonical it maps to. Otherwise returns itself.
 */
async function getCanonicalCategory(categoryId) {
  if (!categoryId) return null;
  const { data } = await supabase
    .from('enforcement_category_aliases')
    .select('canonical_category_id')
    .eq('alias_category_id', categoryId)
    .eq('status', 'confirmed')
    .maybeSingle();
  return (data && data.canonical_category_id) || categoryId;
}

module.exports = {
  expandCategoryToAliases,
  getCanonicalCategory,
};
