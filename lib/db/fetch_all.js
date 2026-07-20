// ============================================================================
// lib/db/fetch_all.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// The ONE sanctioned way to read every row for a query. PostgREST caps every
// response at the server's `db-max-rows` (default 1,000) and SILENTLY drops the
// rest — `.limit(5000)` / `.range(0, 9999)` come back with 1,000 rows and no
// error. This has bitten us repeatedly (Waterview 1,171 voters read as 1,000;
// live vote tallies under-counted; a trustEd-number backfill that missed 123
// Waterview rows). Two failure modes, both fixed here:
//   1) not looping past the first page  -> truncated result read as complete
//   2) paging with .range() but NO stable ORDER BY -> pages drift, so rows are
//      duplicated AND others are skipped (the 123-row miss)
//
// fetchAll() ALWAYS paginates AND ALWAYS orders (default by `id`), so it is
// correct at any community size regardless of the server cap. Use it for every
// "all rows for community/election/property X" read. scripts/check_pagination.js
// fails `npm test` on a raw paginating `.range()` that isn't ordered, so the
// broken hand-rolled version can't ship.
//
//   const rows = await fetchAll(supabase, 'properties',
//     { select: 'id, street_address', filters: { community_id: cid } });
//
//   // arbitrary filters (.or/.gte/.not/.in): pass a builder that returns a
//   // FRESH query each call; fetchAll adds the order + range per page.
//   const rows = await fetchAllQuery(() =>
//     supabase.from('journal_entries').select('*').eq('community_id', cid)
//             .gte('posting_date', start), { orderBy: 'posting_date' });
// ============================================================================

const DEFAULT_PAGE = 1000;   // match PostgREST's cap; smaller pages just add round-trips
const DEFAULT_CAP = 500000;  // runaway backstop — far above any real community

// Simple form: table + eq/in filters. Orders by `orderBy` (default 'id').
async function fetchAll(client, table, opts = {}) {
  const { select = '*', filters = {}, orderBy = 'id', ascending = true, pageSize = DEFAULT_PAGE, cap = DEFAULT_CAP } = opts;
  return fetchAllQuery(() => {
    let q = client.from(table).select(select);
    for (const [k, v] of Object.entries(filters)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
    return q;
  }, { orderBy, ascending, pageSize, cap });
}

// Builder form: buildQuery() must return a FRESH PostgREST query (no order/range
// applied); fetchAllQuery applies a stable order + range for each page.
async function fetchAllQuery(buildQuery, opts = {}) {
  const { orderBy = 'id', ascending = true, pageSize = DEFAULT_PAGE, cap = DEFAULT_CAP } = opts;
  const out = [];
  for (let from = 0; from < cap; from += pageSize) {
    const { data, error } = await buildQuery().order(orderBy, { ascending }).range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) return out;   // short page = last page
  }
  throw new Error(`fetchAll exceeded ${cap} rows — refusing to loop unbounded (widen cap only if a table legitimately has more)`);
}

module.exports = { fetchAll, fetchAllQuery };
