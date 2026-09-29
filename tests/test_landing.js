#!/usr/bin/env node
// ============================================================================
// tests/test_landing.js  (Issue #6, staff landing)
// ----------------------------------------------------------------------------
// Locks the landing decision (public/app/landing-core.js) and the served
// script's flags (lib/app/landing_script.js):
//   - lands only for a plain "/" or "/index.html" with the flag on;
//   - NEVER for a hash (/#tab=inspect), any query (?workspace=legacy, OAuth
//     ?code=&state=), device/tab legacy mode, flag off, or app disabled;
//   - ?workspace=legacy sets the tab-scoped legacy marker;
//   - TRUSTED_LANDING defaults OFF; TRUSTED_APP_DISABLED forces it off (no
//     loop with disabled /app/* redirecting to "/").
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const { shouldLandOnNewShell, run, KEYS } = require('../public/app/landing-core.js');
const { landingFlags, landingScript } = require('../lib/app/landing_script.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}
const on = (over) => Object.assign({ enabled: true, appDisabled: false, pathname: '/', search: '', hash: '', deviceLegacy: false, tabLegacy: false }, over);

// Minimal browser: location with replace(), localStorage, sessionStorage.
function fakeWin(url, stores) {
  const u = new URL(url, 'https://my.bedrocktxai.com');
  const mk = (seed) => { const m = new Map(Object.entries(seed || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
  const win = { location: { pathname: u.pathname, search: u.search, hash: u.hash, replaced: null, replace(to) { this.replaced = to; } },
    localStorage: mk(stores && stores.local), sessionStorage: mk(stores && stores.session) };
  return win;
}

console.log('test_landing');

t('plain "/" and "/index.html" land when the flag is on', () => {
  assert.strictEqual(shouldLandOnNewShell(on()), true);
  assert.strictEqual(shouldLandOnNewShell(on({ pathname: '/index.html' })), true);
});

t('legacy hash deep link /#tab=inspect never lands', () => {
  assert.strictEqual(shouldLandOnNewShell(on({ hash: '#tab=inspect' })), false);
});

t('?workspace=legacy never lands', () => {
  assert.strictEqual(shouldLandOnNewShell(on({ search: '?workspace=legacy' })), false);
});

t('OAuth callback ?code=&state= never lands', () => {
  assert.strictEqual(shouldLandOnNewShell(on({ search: '?code=abc&state=xyz' })), false);
});

t('any other query, other paths, device or tab legacy never land', () => {
  assert.strictEqual(shouldLandOnNewShell(on({ search: '?x=1' })), false);
  assert.strictEqual(shouldLandOnNewShell(on({ pathname: '/admin/accounting' })), false);
  assert.strictEqual(shouldLandOnNewShell(on({ pathname: '/app/today' })), false);
  assert.strictEqual(shouldLandOnNewShell(on({ deviceLegacy: true })), false);
  assert.strictEqual(shouldLandOnNewShell(on({ tabLegacy: true })), false);
});

t('flag off or app disabled never lands', () => {
  assert.strictEqual(shouldLandOnNewShell(on({ enabled: false })), false);
  assert.strictEqual(shouldLandOnNewShell(on({ appDisabled: true })), false);
});

t('run(): plain "/" with flag on replaces to /app/today', () => {
  const w = fakeWin('/');
  assert.strictEqual(run(w, { enabled: true, appDisabled: false }), true);
  assert.strictEqual(w.location.replaced, '/app/today');
});

t('run(): /#tab=inspect stays put', () => {
  const w = fakeWin('/#tab=inspect');
  assert.strictEqual(run(w, { enabled: true, appDisabled: false }), false);
  assert.strictEqual(w.location.replaced, null);
});

t('run(): ?workspace=legacy stays put AND marks the tab legacy; a later plain "/" in that tab stays too', () => {
  const w = fakeWin('/?workspace=legacy');
  assert.strictEqual(run(w, { enabled: true, appDisabled: false }), false);
  assert.strictEqual(w.sessionStorage.getItem(KEYS.tab), '1');
  const again = fakeWin('/', { session: { [KEYS.tab]: '1' } });
  assert.strictEqual(run(again, { enabled: true, appDisabled: false }), false);
});

t('run(): device legacy choice stays put', () => {
  const w = fakeWin('/', { local: { [KEYS.device]: 'legacy' } });
  assert.strictEqual(run(w, { enabled: true, appDisabled: false }), false);
});

t('run(): blocked storage never throws and never blocks the legacy app', () => {
  const w = fakeWin('/');
  w.localStorage = { getItem() { throw new Error('blocked'); } };
  w.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => run(w, { enabled: false, appDisabled: false }));
  assert.strictEqual(w.location.replaced, null);
});

t('flags: TRUSTED_LANDING defaults OFF; only "1" turns it on', () => {
  assert.deepStrictEqual(landingFlags({}), { enabled: false, appDisabled: false });
  assert.strictEqual(landingFlags({ TRUSTED_LANDING: 'true' }).enabled, false);
  assert.strictEqual(landingFlags({ TRUSTED_LANDING: '1' }).enabled, true);
});

t('served script embeds the flags; app disabled forces no landing (no loop)', () => {
  const src = landingScript({ TRUSTED_LANDING: '1', TRUSTED_APP_DISABLED: '1' });
  assert.ok(src.includes('"enabled":true') && src.includes('"appDisabled":true'));
  // Execute the served script in a sandbox with a plain "/": it must not redirect.
  const w = fakeWin('/');
  new Function('window', src)(w);
  assert.strictEqual(w.location.replaced, null);
  const w2 = fakeWin('/');
  new Function('window', landingScript({ TRUSTED_LANDING: '1' }))(w2);
  assert.strictEqual(w2.location.replaced, '/app/today');
  const w3 = fakeWin('/');
  new Function('window', landingScript({}))(w3);
  assert.strictEqual(w3.location.replaced, null, 'default off');
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
