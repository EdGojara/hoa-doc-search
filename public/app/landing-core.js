// ============================================================================
// public/app/landing-core.js — should this page load land on the new shell?
// (Issue #6, staff landing)
// ----------------------------------------------------------------------------
// PURE decision, shared by the browser (inlined into /app-landing.js, which
// runs at the very top of index.html's <head>) and node tests
// (tests/test_landing.js).
//
// Lands on /app/today ONLY when every one of these holds:
//   - the landing flag is on (TRUSTED_LANDING=1) and the new app isn't disabled
//     (TRUSTED_APP_DISABLED=1);
//   - the path is exactly "/" or "/index.html";
//   - there is NO hash: legacy deep links (/#tab=inspect) keep working, and the
//     server never sees hashes, which is why this runs in the browser;
//   - there is NO query: OAuth callbacks (?code=&state=), ?workspace=legacy and
//     any other parameter keep going to the legacy app;
//   - this device hasn't chosen the legacy workspace (localStorage) and this
//     browser tab isn't in legacy mode (sessionStorage).
// ============================================================================
(function (root) {
  'use strict';
  var KEYS = { device: 'tx.workspace', tab: 'tx.legacy' };

  function shouldLandOnNewShell(s) {
    s = s || {};
    if (!s.enabled || s.appDisabled) return false;
    var path = String(s.pathname || '');
    if (path !== '/' && path !== '/index.html') return false;
    if (s.hash && s.hash !== '#') return false;
    if (s.search && s.search !== '?') return false;
    if (s.deviceLegacy || s.tabLegacy) return false;
    return true;
  }

  // Runs in the browser from /app-landing.js. Storage access is wrapped: a
  // blocked or unavailable storage must never stop the legacy app loading.
  function run(win, flags) {
    var loc = win.location;
    var deviceLegacy = false, tabLegacy = false;
    try { deviceLegacy = win.localStorage.getItem(KEYS.device) === 'legacy'; } catch (_) {}
    try {
      // ?workspace=legacy both suppresses the redirect (it's a query) and puts
      // this tab in legacy mode so reloads and in-app navigation stay put.
      if (/(^|[?&])workspace=legacy(&|$)/.test(loc.search || '')) win.sessionStorage.setItem(KEYS.tab, '1');
      tabLegacy = win.sessionStorage.getItem(KEYS.tab) === '1';
    } catch (_) {}
    var go = shouldLandOnNewShell({
      enabled: flags.enabled, appDisabled: flags.appDisabled,
      pathname: loc.pathname, search: loc.search, hash: loc.hash,
      deviceLegacy: deviceLegacy, tabLegacy: tabLegacy,
    });
    if (go) loc.replace('/app/today');
    return go;
  }

  var api = { shouldLandOnNewShell: shouldLandOnNewShell, run: run, KEYS: KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXLanding = api;
})(typeof window !== 'undefined' ? window : this);
