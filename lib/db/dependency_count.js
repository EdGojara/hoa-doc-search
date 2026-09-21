// ============================================================================
// lib/db/dependency_count.js
// ----------------------------------------------------------------------------
// QUERY ERROR ≠ ZERO RESULTS.
//
// Scar (2026-09-20): a Phase 2a dependency verification used `.select('id')`
// as a generic existence probe. `portal_user_properties` has a COMPOSITE PK and
// no `id` column, so PostgREST returned an error — which the caller swallowed
// and read as "0 rows." 13 portal grants were declared "clear" while still
// pointing at properties about to be deleted (CASCADE). The failure looked
// exactly like a true empty result.
//
// This helper makes that class impossible: it counts references
// COLUMN-AGNOSTICALLY (never selects a named column that might not exist) and
// THROWS on any error (bad column, missing table, permission denied) instead of
// returning 0. Use it for every "does anything still reference X" check.
// ============================================================================

/**
 * Count rows in `table` whose `column` is in `values`. Column-agnostic
 * (`select('*', head, count)`), so a missing/renamed `id` never breaks it.
 * THROWS on any query error — an error is never silently treated as zero.
 * @returns {Promise<number>}
 */
async function countRefs(sb, table, column, values) {
  const list = Array.isArray(values) ? values : [values];
  if (list.length === 0) return 0;
  const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true }).in(column, list);
  if (error) {
    throw new Error(`countRefs(${table}.${column}) query failed (NOT zero rows): ${error.message || error.code || 'unknown error'}`);
  }
  // A missing table / unresolvable relationship returns count=null with NO
  // error object (PostgREST head-count quirk). A real count is always a number,
  // so a null count is a failed query, never a legitimate zero.
  if (count == null) {
    throw new Error(`countRefs(${table}.${column}) returned null count (missing table/relation) — NOT zero rows`);
  }
  return count;
}

module.exports = { countRefs };
