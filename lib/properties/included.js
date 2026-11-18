// Included properties (migration 568): a property row marked excluded_at is not a lot (an import
// artifact kept for history). It never counts as a home and is never billed. Until 568 is applied
// the column does not exist; the read then runs without the filter, so nothing breaks in between.
//   const { data, count, error } = await included((q) => supabase.from('properties').select(...).eq(...)(q));
async function included(build) {
  const r = await build(true);
  if (r && r.error && /excluded_at/.test(r.error.message || '')) return build(false);
  return r;
}
const onlyIncluded = (q, on) => (on ? q.is('excluded_at', null) : q);
module.exports = { included, onlyIncluded };
