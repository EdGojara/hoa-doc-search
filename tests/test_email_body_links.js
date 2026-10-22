// tests/test_email_body_links.js  (Ed 2026-10-22)
// Bare web addresses in a persona email body render as clickable links, and
// nothing else in the body changes.
const assert = require('assert');
const { buildPersonaEmail, _linkify } = require('../lib/email/persona_signature');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); } }

check('a bare https URL becomes a link', () => {
  assert.strictEqual(_linkify('see https://bedrocktx.com today'), 'see <a href="https://bedrocktx.com" style="color:#0B1D34;">https://bedrocktx.com</a> today');
});
check('trailing punctuation stays outside the link', () => {
  assert.match(_linkify('Visit https://bedrocktxai.com.'), /href="https:\/\/bedrocktxai\.com"[^>]*>https:\/\/bedrocktxai\.com<\/a>\.$/);
});
check('escaped text cannot inject markup through a URL', () => {
  const html = buildPersonaEmail('maggie', 'Hi,\n\nhttps://x.example/"><script>alert(1)</script>\n\nThanks,\nMaggie', null, '').html;
  assert.ok(!/<script>/i.test(html));
});
check("Maggie's introduction renders both websites as links", () => {
  const body = 'Hi Melody,\n\nOur sites:\n\nBedrock Association Management: https://bedrocktx.com\nBedrock Intelligence: https://bedrocktxai.com\n\nWarm regards,\nMaggie';
  const html = buildPersonaEmail('maggie', body, null, '').html;
  assert.match(html, /<a href="https:\/\/bedrocktx\.com"/);
  assert.match(html, /<a href="https:\/\/bedrocktxai\.com"/);
});
check('a body with no URL is unchanged', () => {
  const body = 'Hi,\n\nNo links here.\n\nThanks,\nClaire';
  assert.ok(!/<a href="http/.test(buildPersonaEmail('claire', body, null, '').html));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
