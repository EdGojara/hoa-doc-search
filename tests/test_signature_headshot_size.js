// ============================================================================
// tests/test_signature_headshot_size.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// A signature headshot cannot blow up in a reply chain.
//
// Tessa's face showed at full size partway down a thread. The <img> already said
// width="64" height="64", but the embedded file was the 640x640 portrait, and a
// recipient's client re-rendering the quoted message rewrites or drops the
// sizing, so the image fell back to its native 640px. The fix is in the bytes:
// the embedded asset is signature-sized, so the worst any client can do is show
// it at its own ~120px.
//
// Asserted for every teammate who signs email, not just Tessa, plus the logo.
//
//   node tests/test_signature_headshot_size.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROSTER } = require('../lib/team/roster');
const opsRoster = require('../lib/team/bedrock_ops');
const { buildPersonaEmail, HEADSHOT_DISPLAY_PX, HEADSHOT_ASSET_PX } = require('../lib/email/persona_signature');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// Pixel dimensions from the image header (JPEG SOFn or PNG IHDR).
function dims(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  assert.ok(buf[0] === 0xFF && buf[1] === 0xD8, 'not a JPEG or PNG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no JPEG frame header');
}

// Everyone with a roster entry and a headshot on disk: the nine community signers
// plus the internal-ops agents that also send branded mail.
const TEAM = path.join(__dirname, '..', 'public', 'assets', 'presentations', 'team');
const INTERNAL = path.join(__dirname, '..', 'public', 'assets', 'presentations', 'team-internal');
const personas = [...new Set(ROSTER.concat(opsRoster.BEDROCK_OPS).filter((m) => m.signature_title).map((m) => m.persona))];
assert.ok(personas.includes('tessa'), 'tessa signs email');

console.log('\nThe source portraits are large (why this test exists)');
check('tessa.jpg on disk is far larger than a signature', () => {
  const d = dims(fs.readFileSync(path.join(TEAM, 'tessa.jpg')));
  assert.ok(d.w >= 320, 'source is ' + d.w + 'px');
});

console.log('\nEvery signer: explicit dimensions, small embedded bytes, correct CID');
for (const persona of personas) {
  const dir = opsRoster.isInternalPersona(persona) ? INTERNAL : TEAM;
  if (!fs.existsSync(path.join(dir, persona + '.jpg'))) continue;
  const { html, attachments } = buildPersonaEmail(persona, 'Body.', 'Lakes of Pine Forest');

  check(persona + ': <img> has HTML width/height attributes, not just CSS', () => {
    const tag = (html.match(/<img[^>]*src="cid:headshot"[^>]*>/) || [])[0];
    assert.ok(tag, 'no headshot <img>');
    assert.match(tag, new RegExp(' width="' + HEADSHOT_DISPLAY_PX + '"'));
    assert.match(tag, new RegExp(' height="' + HEADSHOT_DISPLAY_PX + '"'));
    assert.match(tag, new RegExp('max-width:' + HEADSHOT_DISPLAY_PX + 'px'));
  });

  check(persona + ': headshot is an inline CID attachment matching the <img>', () => {
    const a = attachments.filter((x) => x.contentId === 'headshot');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].isInline, true);
    assert.strictEqual(a[0].contentType, 'image/jpeg');
    assert.strictEqual(a[0]['@odata.type'], '#microsoft.graph.fileAttachment');
  });

  check(persona + ': embedded headshot is square and at most ' + HEADSHOT_ASSET_PX + 'px', () => {
    const buf = Buffer.from(attachments.find((x) => x.contentId === 'headshot').contentBytes, 'base64');
    const d = dims(buf);
    assert.strictEqual(d.w, d.h, 'aspect ratio');
    assert.ok(d.w >= 100 && d.w <= HEADSHOT_ASSET_PX, persona + ' embeds ' + d.w + 'px');
    assert.ok(buf.length < 20 * 1024, persona + ' embeds ' + buf.length + ' bytes');
  });
}

console.log('\nThe logo cannot blow up either');
check('logo <img> has explicit dimensions and its native size is at most 2x display', () => {
  const { html, attachments } = buildPersonaEmail('tessa', 'Body.');
  assert.match(html, /<img src="cid:bedrocklogo" width="150" height="45"/);
  const d = dims(Buffer.from(attachments.find((x) => x.contentId === 'bedrocklogo').contentBytes, 'base64'));
  assert.ok(d.w <= 300 && d.h <= 90, 'logo is ' + d.w + 'x' + d.h);
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : ''));
