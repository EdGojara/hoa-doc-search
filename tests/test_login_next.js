#!/usr/bin/env node
// ============================================================================
// tests/test_login_next.js  (Issue #6, staff landing: legacy escape survives
// sign-in)
// ----------------------------------------------------------------------------
// Locks public/login-next.js isSafeNext():
//   - "/?workspace=legacy" is accepted (the explicit legacy escape hatch);
//   - normal path-only next values behave exactly as before;
//   - every other query string, hash, absolute URL, protocol-relative URL or
//     look-alike is rejected (no open redirect, no arbitrary query);
// and that login.html can actually load it signed out (staff-gate allowlist)
// with a fallback to the old path-only rule if it ever fails to load.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isSafeNext, LEGACY } = require('../public/login-next.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}

console.log('test_login_next');

t('the legacy escape hatch survives: "/?workspace=legacy" is accepted', () => {
  assert.strictEqual(LEGACY, '/?workspace=legacy');
  assert.strictEqual(isSafeNext('/?workspace=legacy'), true);
});

t('path-only next unchanged', () => {
  for (const ok of ['/', '/admin/tessa', '/app/today', '/app/communities/abc-123', '/admin/accounting']) assert.strictEqual(isSafeNext(ok), true, ok);
});

t('arbitrary query strings rejected', () => {
  for (const bad of ['/?workspace=legacy&x=1', '/?x=1&workspace=legacy', '/?workspace=Legacy', '/?workspace=legacy#tab=ap', '/admin/accounting?view=ar', '/?code=abc&state=xyz', '/?workspace=legacy ', '/?workspace=legacy%26next=//evil.com']) {
    assert.strictEqual(isSafeNext(bad), false, bad);
  }
});

t('open-redirect shapes rejected', () => {
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '', null, undefined, 42, '/#tab=inspect', '/%2F%2Fevil.com']) {
    assert.strictEqual(isSafeNext(bad), false, String(bad));
  }
});

t('login.html loads login-next.js, and the staff gate lets it through signed out', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  assert.ok(html.includes('<script src="/login-next.js"></script>'));
  assert.ok((html.match(/TXLoginNext\.isSafeNext/g) || []).length === 2, 'used where next is stored AND where it is used');
  assert.ok((html.match(/window\.TXLoginNext \? TXLoginNext\.isSafeNext\((qp|n)\) : \/\^\\\/\[A-Za-z0-9\/_-\]\*\$\/\.test\((qp|n)\)/g) || []).length === 2, 'falls back to the old path-only rule if the file fails to load');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("/^\\/login-next\\.js$/,"), 'login-next.js is on the staff-gate public allowlist');
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
