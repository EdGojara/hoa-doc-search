// ============================================================================
// lib/onboarding/source_period.js  (Ed 2026-10-17) — cutoff-aware source history
// ----------------------------------------------------------------------------
// A legacy system's transaction-history export often runs past the conversion
// cutoff (it is exported on the day someone asks for it). The source is the
// authority only THROUGH the cutoff, so a history that extends past it is
// sliced, deterministically, to the approved source period:
//
//   * every dated detail row on or before the cutoff is kept, every later row
//     is dropped (and counted);
//   * each account's ending balance becomes its balance AT the cutoff, and it
//     must roll forward exactly: opening + (charges - payments) through the
//     cutoff = the last running balance the source printed on/before it;
//   * the report's period end becomes the cutoff, and the slice records the
//     date the source actually printed, so the provenance stays honest.
//
// Pure and canonical: it works on canonical rows (canonical.js domains), never
// on a provider's format, so any adapter whose history parses into
// homeowner_account + homeowner_txn rows gets it. Adapters stay parsers.
// Nothing is guessed: a row with no date, or an account that does not roll
// forward, FAILS the slice control and the slice is not applied.
// ============================================================================
const C = require('./controls');

// Canonical dated-detail pairs: an account summary domain and its dated detail domain.
const DATED_DETAIL = Object.freeze([
  Object.freeze({ account: 'homeowner_account', detail: 'homeowner_txn' }),
]);

const isSliceable = (report) => !!report && Array.isArray(report.rows)
  && DATED_DETAIL.some((d) => report.rows.some((r) => r.domain === d.detail) && report.rows.some((r) => r.domain === d.account));

// The date a report runs through (canonical: period.end, else as_of).
const reportEnd = (report) => (report && ((report.period && report.period.end) || report.as_of)) || null;

// Does a report cover the cutoff, so that slicing yields the source position AT the cutoff?
function coversCutoff(report, cutoff) {
  const end = reportEnd(report); const start = report && report.period && report.period.start;
  return !!(end && end >= cutoff && (!start || start <= cutoff));
}

function sliceReport(type, report, cutoff) {
  const problems = []; const out = []; let kept = 0; let dropped = 0; const accounts = [];
  for (const pair of DATED_DETAIL) {
    const detail = report.rows.filter((r) => r.domain === pair.detail);
    const byAcct = new Map();
    for (const r of detail) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) { problems.push({ artifact_type: type, source_account_key: r.source_account_key, problem: 'a detail row has no date; the history cannot be sliced', locator: r.provenance && r.provenance.locator }); continue; }
      if (!byAcct.has(r.source_account_key)) byAcct.set(r.source_account_key, []);
      byAcct.get(r.source_account_key).push(r);
    }
    for (const a of report.rows.filter((r) => r.domain === pair.account)) {
      const rows = byAcct.get(a.source_account_key) || [];
      const keep = rows.filter((r) => r.date <= cutoff); const drop = rows.length - keep.length;
      kept += keep.length; dropped += drop;
      const opening = Number(a.opening_cents || 0);
      // Roll-forward through the cutoff: opening + charges + payments (canonical payments are signed,
      // negative) = the last printed balance kept.
      const rolled = keep.reduce((t, r) => t + Number(r.charge_cents || 0) + Number(r.payment_cents || 0), opening);
      const last = keep.length ? keep[keep.length - 1] : null;
      const printed = last && last.balance_cents !== undefined && last.balance_cents !== null ? Number(last.balance_cents) : opening;
      if (rolled !== printed) problems.push({ artifact_type: type, source_account_key: a.source_account_key, problem: 'does not roll forward to the cutoff', opening_cents: opening, rolled_cents: rolled, printed_cents: printed });
      if (drop || a.as_of !== cutoff) accounts.push({ source_account_key: a.source_account_key, printed_as_of: a.as_of, printed_ending_cents: Number(a.ending_cents), ending_at_cutoff_cents: printed, rows_after_cutoff: drop });
      out.push({ ...a, as_of: cutoff, ending_cents: printed, row_count: keep.length, ...(a.as_of !== cutoff ? { sliced_from_as_of: a.as_of, printed_ending_cents: Number(a.ending_cents) } : {}) });
      for (const r of keep) out.push(r);
    }
  }
  const rest = report.rows.filter((r) => !DATED_DETAIL.some((d) => r.domain === d.account || r.domain === d.detail));
  const end = reportEnd(report);
  const sliced = { ...report, rows: [...out, ...rest], ...(report.period ? { period: { ...report.period, end: cutoff } } : {}), ...(report.as_of ? { as_of: cutoff } : {}),
    slice: { printed_end: end, cutoff, rows_kept: kept, rows_after_cutoff: dropped } };
  return { sliced, problems, record: { artifact_type: type, printed_end: end, cutoff, rows_kept: kept, rows_after_cutoff: dropped, accounts_changed: accounts.length, accounts: accounts.slice(0, 500) } };
}

/**
 * Slice every report that runs past the cutoff to the source period.
 * Returns { parsed, slices, controls }: the sliced parsed source (unchanged when
 * nothing runs past the cutoff), one record per sliced report, and the control.
 * A FAIL applies NO slice (the caller records the failure; nothing is guessed).
 */
function sliceToCutoff(parsed, cutoff) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cutoff || ''))) throw new Error('sliceToCutoff needs the cutoff (YYYY-MM-DD)');
  const next = { ...parsed }; const slices = []; const problems = [];
  for (const [type, report] of Object.entries(parsed || {})) {
    const end = reportEnd(report);
    if (!end || end <= cutoff || !isSliceable(report)) continue;
    if (!coversCutoff(report, cutoff)) { problems.push({ artifact_type: type, problem: `the report starts after the cutoff (${report.period && report.period.start})` }); continue; }
    const r = sliceReport(type, report, cutoff);
    problems.push(...r.problems); next[type] = r.sliced; slices.push(r.record);
  }
  const controls = slices.length || problems.length
    ? [C.holds('normalize.history_sliced_to_cutoff', { label: `Every history that runs past the cutoff ${cutoff} is sliced to it and every account rolls forward exactly (opening + charges + signed payments = the balance the source printed on/before the cutoff)`, failures: problems })]
    : [];
  return { parsed: problems.length || !slices.length ? parsed : next, slices: problems.length ? [] : slices, controls };
}

module.exports = { sliceToCutoff, isSliceable, coversCutoff, reportEnd, DATED_DETAIL };
