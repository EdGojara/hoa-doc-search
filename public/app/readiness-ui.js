// ============================================================================
// public/app/readiness-ui.js — how Data Readiness statuses look and read
// (Issue #6). Shared by /app/communities and /app/communities/:id.
// Status values come from lib/community/data_readiness.js (S).
// ============================================================================
(function (root) {
  'use strict';
  // order = worst first (matches SEVERITY on the server)
  var META = {
    error:                   { label: 'Error',          pill: 'bad',  group: 'act',   dot: 'var(--tx-bad)',   plain: 'A control failed or the data couldn’t be read.' },
    partial:                 { label: 'Partial',        pill: 'warn', group: 'act',   dot: 'var(--tx-warn)',  plain: 'Some of it is here; the missing part is listed.' },
    imported_not_reconciled: { label: 'Not reconciled', pill: 'warn', group: 'act',   dot: 'var(--tx-warn)',  plain: 'Imported, but the check that proves it hasn’t passed or can’t run yet.' },
    in_progress:             { label: 'In progress',    pill: 'info', group: 'act',   dot: 'var(--tx-info)',  plain: 'Started, not finished or posted.' },
    not_imported:            { label: 'Not imported',   pill: 'info', group: 'act',   dot: 'var(--tx-rule)',  plain: 'Nothing on file yet.' },
    imported_not_verified:   { label: 'Not verified',   pill: 'mute', group: 'quiet', dot: 'var(--tx-text-2)', plain: 'Imported, but there’s no source total to prove it’s complete.' },
    ready:                   { label: 'Ready',          pill: 'ok',   group: 'quiet', dot: 'var(--tx-ok)',    plain: 'Proven by a stored control.' },
    not_applicable:          { label: 'Not applicable', pill: 'mute', group: 'na',    dot: 'var(--tx-subtle)', plain: 'Not ours to import for this community.' },
  };
  var ORDER = Object.keys(META);
  function meta(s) { return META[s] || { label: s, pill: 'mute', group: 'act', dot: 'var(--tx-rule)', plain: '' }; }
  function pill(s) { var m = meta(s); return '<span class="tx-pill tx-pill--' + m.pill + '">' + m.label + '</span>'; }
  function lifecycle(c) {
    var ms = c && c.management_status;
    if (ms === 'terminating' || ms === 'terminated') return { label: 'Leaving', pill: 'mute', quiet: true };
    if (ms === 'prospect') return { label: 'Prospect', pill: 'info', quiet: true };
    if (ms === 'onboarding') return { label: 'Onboarding', pill: 'info', quiet: false };
    return { label: 'Active', pill: 'ok', quiet: false };
  }
  var api = { META: META, ORDER: ORDER, meta: meta, pill: pill, lifecycle: lifecycle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXReady = api;
})(typeof window !== 'undefined' ? window : this);
