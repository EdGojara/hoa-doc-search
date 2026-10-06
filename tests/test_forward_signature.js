// ============================================================================
// tests/test_forward_signature.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// A forward to a teammate goes out as a complete, signed Claire email.
//
// The forward path in api/email_triage.js built its signature by calling
// claireSignatureParts(). That helper was removed when the nine signature files
// collapsed into lib/email/persona_signature.js, and both calls sat inside a
// try/catch that swallowed the TypeError. So every forward went out UNSIGNED:
// no name, no logo, no headshot, and nothing anywhere said so. A silent failure.
//
// This test pins three things:
//   1. The forward signature is Claire's, with her roster name, and every
//      cid: image it references has a matching inline attachment (headshot AND
//      logo), de-duplicated against what the forward already carries.
//   2. A failure to build it is logged, never swallowed, and never blocks the
//      forward.
//   3. No caller anywhere requires a member a signature module does not export.
//      That is the class of bug, not just this instance of it.
//
//   node tests/test_forward_signature.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROSTER } = require('../lib/team/roster');
const { claireForwardSignature } = require('../lib/email/claire_signature');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const claire = ROSTER.find((r) => r.persona === 'claire');
const cids = (html) => [...String(html).matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]);

console.log('\nThe forward signature');

check('is Claire\'s signature, with her roster name and the community', () => {
  assert.ok(claire, 'no claire in the roster');
  const sig = claireForwardSignature('Waterview', []);
  assert.ok(sig.html, 'forward signature HTML is empty: the forward would go out unsigned');
  assert.ok(sig.html.includes(claire.name), 'signature does not carry Claire\'s name (' + claire.name + ')');
  assert.ok(sig.html.includes(claire.signature_title), 'signature does not carry Claire\'s title');
  assert.ok(sig.html.includes('Waterview'), 'signature does not name the community');
});

check('references the headshot and the logo', () => {
  const refs = cids(claireForwardSignature('Waterview', []).html);
  assert.ok(refs.includes('headshot'), 'no cid:headshot in the signature');
  assert.ok(refs.includes('bedrocklogo'), 'no cid:bedrocklogo in the signature');
});

check('every cid: it references has a matching inline attachment', () => {
  const sig = claireForwardSignature('Waterview', []);
  for (const cid of cids(sig.html)) {
    const a = sig.attachments.find((x) => x.contentId === cid);
    assert.ok(a, 'cid:' + cid + ' is referenced but not attached: the image would break');
    assert.strictEqual(a.isInline, true, cid + ' is not marked inline');
    assert.strictEqual(a['@odata.type'], '#microsoft.graph.fileAttachment', cid + ' is not a Graph fileAttachment');
    assert.ok(a.contentBytes && a.contentBytes.length > 100, cid + ' has no bytes');
  }
});

check('does not re-attach an image the forward already carries', () => {
  const existing = [
    { name: 'invoice.pdf', contentType: 'application/pdf', contentBytes: 'AAAA' },
    { name: 'bedrock-logo.png', contentId: 'bedrocklogo', isInline: true, contentBytes: 'BBBB' },
  ];
  const sig = claireForwardSignature('Waterview', existing);
  assert.ok(!sig.attachments.some((a) => a.contentId === 'bedrocklogo'), 'logo attached twice');
  // The combined set the forward actually sends still covers every reference.
  const sent = existing.concat(sig.attachments);
  for (const cid of cids(sig.html)) {
    assert.ok(sent.some((a) => a.contentId === cid), 'cid:' + cid + ' missing from the sent attachments');
  }
  const ids = sent.map((a) => a.contentId).filter(Boolean);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate contentIds in the sent attachments');
});

check('tolerates no community and no existing attachments', () => {
  const sig = claireForwardSignature(null, undefined);
  assert.ok(sig.html.includes(claire.name));
  assert.ok(Array.isArray(sig.attachments));
});

console.log('\nA failure is logged, not swallowed');

check('a broken signature builder warns with context and returns empty, not a throw', () => {
  const psPath = require.resolve('../lib/email/persona_signature');
  const csPath = require.resolve('../lib/email/claire_signature');
  const realPs = require.cache[psPath];
  const realCs = require.cache[csPath];
  const origWarn = console.warn;
  const warnings = [];
  try {
    delete require.cache[csPath];
    require.cache[psPath] = Object.assign(Object.create(Object.getPrototypeOf(realPs)), realPs, {
      exports: Object.assign({}, realPs.exports, { signatureParts: () => { throw new Error('boom'); } }),
    });
    const stubbed = require('../lib/email/claire_signature');
    console.warn = (...a) => warnings.push(a.join(' '));
    const sig = stubbed.claireForwardSignature('Waterview', [], 'msg-123');
    assert.deepStrictEqual(sig, { html: '', attachments: [] });
    assert.ok(warnings.some((w) => /msg-123/.test(w) && /boom/.test(w)),
      'no console.warn naming the message and the error: ' + JSON.stringify(warnings));
  } finally {
    console.warn = origWarn;
    require.cache[psPath] = realPs;
    require.cache[csPath] = realCs;
  }
});

console.log('\nNo caller uses a signature helper that does not exist');

check('the forward path no longer calls claireSignatureParts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'email_triage.js'), 'utf8');
  assert.ok(!/\.claireSignatureParts\b/.test(src), 'api/email_triage.js still calls claireSignatureParts');
  assert.ok(/claireForwardSignature\(/.test(src), 'api/email_triage.js forward path does not use claireForwardSignature');
});

check('every member required from a *_signature module is actually exported', () => {
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) files.push(p);
    }
  })(ROOT);
  const problems = [];
  const reqRe = /(?:\{([\w$\s,:]*)\}\s*=\s*)?require\(\s*['"]([^'"]*email\/[a-z_]*signature)['"]\s*\)(?:\.([A-Za-z_$][\w$]*))?/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(reqRe)) {
      const [, destructured, spec, member] = m;
      let mod;
      try { mod = require(path.resolve(path.dirname(file), spec)); }
      catch (e) { problems.push(path.relative(ROOT, file) + ': cannot load ' + spec + ' (' + e.message + ')'); continue; }
      // `{ html, attachments } = require(x).buildFoo(...)` destructures the
      // RESULT, not the module, so only check destructuring when no member follows.
      const names = member ? [member]
        : (destructured || '').split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
      for (const n of names) {
        if (!(n in mod)) problems.push(path.relative(ROOT, file) + ': ' + spec + ' has no export "' + n + '"');
      }
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n    '));
});

if (!process.exitCode) console.log('\n✓ Forward signature: all ' + passed + ' checks passed.\n');
else console.error('\nForward signature: FAILURES above.\n');
