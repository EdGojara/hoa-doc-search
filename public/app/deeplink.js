// public/app/deeplink.js  (Issue #29 Phase 1 refinement) — navigation-only deep links
// Pure parsers shared by the legacy workspace (index.html) and /admin/ap, so the
// Operations Feed's "Take action" can open the EXACT controlled record:
//   /#tab=ap&invoice=<uuid>      Payables, then that bill's detail
//   /#tab=acc&decision=<uuid>    ACC review mode, then that decision
//   /admin/ap?exception=<uuid>   the intake-exception row, scrolled + highlighted
// A bare "#tab=key" keeps working exactly as before. A missing or invalid id
// falls back to just the tab (never an error, never a guess). Opening a record
// uses the page's own read path; every action stays behind its existing route.
(function (root) {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var RECORD_KEYS = { ap: 'invoice', acc: 'decision' };

  // "#tab=ap&invoice=<uuid>" -> { tab: 'ap', record: { kind: 'invoice', id } }
  function parseTabHash(hash) {
    var h = String(hash || '');
    var m = /^#tab=([a-z0-9-]+)(?:&(.*))?$/i.exec(h);
    if (!m) return null;
    var out = { tab: m[1], record: null };
    var want = RECORD_KEYS[m[1].toLowerCase()];
    if (want && m[2]) {
      var params = {};
      m[2].split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
      var id = params[want];
      if (id && UUID.test(id)) out.record = { kind: want, id: id.toLowerCase() };
    }
    return out;
  }

  // "?exception=<uuid>" -> "<uuid>" or null
  function parseExceptionParam(search) {
    var m = /[?&]exception=([^&#]*)/.exec(String(search || ''));
    if (!m) return null;
    var id = decodeURIComponent(m[1]);
    return UUID.test(id) ? id.toLowerCase() : null;
  }

  var api = { parseTabHash: parseTabHash, parseExceptionParam: parseExceptionParam, UUID: UUID };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXDeepLink = api;
})(typeof window !== 'undefined' ? window : this);
