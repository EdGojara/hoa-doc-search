// tests/test_home_dashboard_script.js  (Ed 2026-10-23) — regression: the Home dashboard hung on
// "Loading your tiles…" and the Today panel stayed empty because one unescaped apostrophe in a
// Finance menu label ('🤖 Kat's browser runs', PR #275) made the browser drop the whole main
// script block, which also holds the tile loader, its 5-second fallback and the Today loader.
// This pins that the block holding them parses. (scripts/check_inline_scripts.js covers every
// page; this names the Home dashboard so a failure says what users will see.)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
const blocks = []; const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m;
while ((m = re.exec(html))) if (!/\bsrc\s*=/.test(m[1])) blocks.push(m[2]);
const home = blocks.find((b) => b.includes('function homeRender()') && b.includes('_wireHomeInitialRender'));
let pass = 0, fail = 0;
const check = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } };

check('the Home dashboard block (tiles, their fallback, Today, menus) is found', () => {
  assert.ok(home, 'no inline block defines homeRender and _wireHomeInitialRender');
  assert.ok(home.includes("getElementById('todayBody')"), 'the Today loader lives in the same block');
  assert.ok(home.includes("id: '__agent_browser'"), 'the Finance menu config lives in the same block');
});
check('that block parses (a syntax error drops every function in it: tiles hang, Today stays empty)', () => {
  new vm.Script(home, { filename: 'index.html#home-block' });
});
check("the Kat's browser runs label is a valid string", () => {
  assert.match(home, /label: '🤖 Kat\\'s browser runs'/);
});

console.log(`\nhome_dashboard_script: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
