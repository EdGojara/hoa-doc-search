// tests/test_agent_browser_guard.js  (Ed 2026-10-23) — the guarded browser enforces each skill's
// explicit declaration: only declared actions on the declared page with the expected live label,
// only declared hosts (network layer), forbidden labels refused even when declared, only declared
// reads, no typing. Runs real Chrome against a local page; no outside site is contacted.
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || require('path').join(__dirname, '..', '.cache', 'puppeteer');
const assert = require('assert');
const express = require('express');
const puppeteer = require('puppeteer');
const { createGuard, validateDeclaration, hostAllowed, onPage } = require('../lib/agent_browser/guard');
const NF = require('../lib/agent_browser/skills/newfirst_login_navigation');

const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('PURE: host allowlist and page matching', () => {
  assert.strictEqual(hostAllowed('https://www.newfirst.com/x', ['www.newfirst.com']), true);
  assert.strictEqual(hostAllowed('https://poda.robo.secureinternetbank.com/ebc', ['www.newfirst.com']), false);
  assert.strictEqual(hostAllowed('https://www.newfirst.com.evil.test/', ['www.newfirst.com']), false);
  assert.strictEqual(onPage('https://www.newfirst.com/', { host: 'www.newfirst.com', path: '/' }), true);
  assert.strictEqual(onPage('https://www.newfirst.com/contact/', { host: 'www.newfirst.com', path: '/' }), false);
});

check('DECLARATION: a goto to an undeclared host, a click without label or page, and unknown action types are rejected', () => {
  assert.throws(() => validateDeclaration({ id: 'x', version: 1, hosts: ['a.test'], actions: { go: { type: 'goto', url: 'https://b.test/' } } }), /not on the declared hosts/);
  assert.throws(() => validateDeclaration({ id: 'x', version: 1, hosts: ['a.test'], actions: { c: { type: 'click', selector: '#x' } } }), /needs selector, expected label and page/);
  assert.throws(() => validateDeclaration({ id: 'x', version: 1, hosts: ['a.test'], actions: { t: { type: 'type', selector: '#x' } } }), /not supported/);
});

check('NEWFIRST v1: www.newfirst.com only; no typing, no Login, no banking host', () => {
  const d = NF.declaration;
  validateDeclaration(d);
  assert.deepStrictEqual(d.hosts, ['www.newfirst.com']);
  assert.ok(Object.values(d.actions).every((a) => a.type === 'goto' || a.type === 'click'));
  assert.ok(!Object.values(d.actions).some((a) => a.type === 'click' && /login|submit/i.test(String(a.selector) + String(a.label))), 'no Login click declared');
  assert.ok(d.forbidden.test('Login') && d.forbidden.test('Sign in'), 'Login refused as a second check');
  assert.ok(!/secureinternetbank/.test(JSON.stringify(d.hosts)), 'the banking host is not reachable');
});

check('LIVE (local page): declared steps run; undeclared action, wrong label, forbidden label, off-host request and undeclared read are all refused', async () => {
  const app = express();
  app.get('/', (req, res) => res.send(`<!doctype html><html><body>
    <a id="tab" href="#" onclick="document.getElementById('f').style.display='block';return false;">Business</a>
    <form id="f" style="display:none"><input id="u" placeholder="Enter Username"><input id="p" type="password"><input id="go" type="submit" value="Login"></form>
    <button id="pay">Approve payment</button><a id="mislabeled" href="#">Personal</a>
    <img src="https://tracker.example.invalid/pixel.png"></body></html>`));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); const host = `127.0.0.1:${srv.address().port}`;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const g = createGuard({ page, declaration: { id: 't', version: 1, hosts: [host], forbidden: /log ?in/i,
      actions: {
        open: { type: 'goto', url: `http://${host}/` },
        business: { type: 'click', page: { host, path: '/' }, selector: '#tab', label: /^Business$/, waitFor: '#u' },
        wrong_label: { type: 'click', page: { host, path: '/' }, selector: '#mislabeled', label: /^Business$/ },
        pay: { type: 'click', page: { host, path: '/' }, selector: '#pay', label: /payment/i },
        login: { type: 'click', page: { host, path: '/' }, selector: '#go', label: /Login/ },
      },
      read: { username: '#u', password: '#p' } } });
    await g.start();
    await g.do('open'); await g.do('business');
    const u = await g.read('username'); const p = await g.read('password');
    assert.ok(u.visible && p.visible && p.type === 'password', 'declared reads see the fields after the declared click');
    await assert.rejects(() => g.do('type_password'), (e) => e.status === 'blocked', 'undeclared action refused');
    await assert.rejects(() => g.do('wrong_label'), (e) => e.status === 'failed' && /not what wrong_label expects/.test(e.reason), 'live label must match the declaration');
    await assert.rejects(() => g.do('pay'), (e) => e.status === 'needs_human', 'a declared but forbidden label is still refused');
    await assert.rejects(() => g.do('login'), (e) => e.status === 'needs_human', "the skill's own forbidden list refuses Login");
    await assert.rejects(() => g.read('anything_else'), (e) => e.status === 'blocked', 'undeclared read refused');
    assert.ok(g.blocked.some((b) => b.kind === 'host' && b.host === 'tracker.example.invalid'), 'off-host request aborted at the network layer');
    assert.ok(g.steps.length >= 3 && g.shots.length >= 3 && g.shots.every((s) => /^[0-9a-f]{64}$/.test(s.sha256)), 'every step has a screenshot with SHA-256');
    assert.strictEqual(typeof g.type, 'undefined', 'there is no generic typing method');
  } finally { await browser.close(); srv.close(); }
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log('  ✓ ' + n); }
    catch (e) { fail += 1; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
  }
  console.log(`\nagent_browser_guard: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
