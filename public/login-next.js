// ============================================================================
// public/login-next.js — which post-login destinations are allowed
// ----------------------------------------------------------------------------
// Shared by /login.html (both where ?next= is stored and where it is used) and
// tests/test_login_next.js.
//
// Allowed:
//   - a same-site path with no query or hash: /^\/[A-Za-z0-9/_-]*$/ (unchanged);
//   - EXACTLY "/?workspace=legacy", the explicit legacy-workspace escape hatch
//     (Issue #6). Without this, a signed-out staffer opening the legacy link
//     would sign in and land on the new home instead of the workspace they
//     asked for. No other query string is accepted.
// ============================================================================
(function (root) {
  'use strict';
  var PATH_ONLY = /^\/[A-Za-z0-9/_-]*$/;
  var LEGACY = '/?workspace=legacy';
  function isSafeNext(n) {
    if (typeof n !== 'string' || !n) return false;
    return PATH_ONLY.test(n) || n === LEGACY;
  }
  var api = { isSafeNext: isSafeNext, LEGACY: LEGACY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXLoginNext = api;
})(typeof window !== 'undefined' ? window : this);
