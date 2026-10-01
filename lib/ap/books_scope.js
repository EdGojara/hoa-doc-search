// ============================================================================
// lib/ap/books_scope.js  (Issue #14, Ed 2026-10-01)
// ----------------------------------------------------------------------------
// Some communities' books are NOT kept in trustEd (Eaglewood: financials kept
// in Vantaca, the system of record; never converted). AP backfill and
// reconciliation must leave them alone, and their absence from trustEd's AP/GL
// is expected, not missing data. Same rule as lib/community/data_readiness.js:
// financials_active = false, or books_of_record set to anything but 'trusted'.
// Pure.
// ============================================================================
function outsideTrustedBooks(c) {
  if (!c) return null;
  if (c.financials_active === false || (c.books_of_record && c.books_of_record !== 'trusted')) {
    const where = c.books_of_record && c.books_of_record !== 'trusted' ? (c.books_of_record === 'vantaca' ? 'Vantaca' : c.books_of_record) : 'another system';
    return `${c.name || 'this community'}'s financials are kept in ${where}, not trustEd: excluded from AP backfill and reconciliation`;
  }
  return null;
}
module.exports = { outsideTrustedBooks };
