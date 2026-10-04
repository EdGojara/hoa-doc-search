// tests/test_team_portraits.js  (Issue #29, 2026-10-04) — Amanda's repo portrait is her CURRENT
// canonical face (character registry face v2), so the team-photo sync (scripts/set_team_photos.js,
// which uploads team/<persona>.jpg to Microsoft 365) can only ever set v2. The old face (v1) is
// kept byte-identical as amanda_legacy_v1.jpg, used only as the poster of videos rendered with it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TEAM = path.join(ROOT, 'public', 'assets', 'presentations', 'team');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const V2_PORTRAIT_SHA = 'e25ef24e07ba4fb1b4e1fca4786da1bdd35ab538c01c7d28bbf577a8ce7e0ddb';   // 640px crop of master 601c6d92…
const V1_PORTRAIT_SHA = '7ad707acfc137b2eb161d48d81d82d2f5e34eb7f6ba8fe7631b62f1a7df7d2cf';   // registry character_assets, face v1 derived
const tests = []; const check = (n, fn) => tests.push([n, fn]);

function jpegSize(file) {   // read SOF0/SOF2 dimensions without an image library
  const b = fs.readFileSync(file); let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1]; const len = b.readUInt16BE(i + 2);
    if (m === 0xc0 || m === 0xc2) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

check('amanda.jpg is the face-v2 portrait (640x640 JPEG), never the old v1 headshot', () => {
  const f = path.join(TEAM, 'amanda.jpg');
  assert.strictEqual(sha(f), V2_PORTRAIT_SHA, 'amanda.jpg must be the v2 portrait; a deliberate replacement updates this test');
  assert.notStrictEqual(sha(f), V1_PORTRAIT_SHA);
  assert.deepStrictEqual(jpegSize(f), { w: 640, h: 640 });
});

check('the old face is preserved byte-identical as amanda_legacy_v1.jpg', () => {
  assert.strictEqual(sha(path.join(TEAM, 'amanda_legacy_v1.jpg')), V1_PORTRAIT_SHA);
});

check('team-photo sync uploads team/amanda.jpg for amanda, so it can only set v2', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'set_team_photos.js'), 'utf8');
  assert.match(src, /path\.join\(__dirname, '\.\.', 'public', 'assets', 'presentations', 'team'\)/, 'reads the team portrait folder');
  assert.match(src, /\['amanda', g\.AMANDA_MAILBOX\]/, 'amanda maps to the mailbox identity');
  assert.match(src, /path\.join\(DIR, persona\+'\.jpg'\)/, 'uploads <persona>.jpg, i.e. amanda.jpg');
  assert.ok(!/legacy/i.test(src), 'never uploads the legacy portrait');
});

check('registry seed: v2 owns amanda.jpg as a derived asset; v1 points at the legacy file', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'character_seed', 'amanda_albright.json'), 'utf8'));
  const v1 = seed.components.find((c) => c.key === 'face.v1'); const v2 = seed.components.find((c) => c.key === 'face.v2');
  const v2d = v2.assets.find((a) => a.repo === 'public/assets/presentations/team/amanda.jpg');
  assert.ok(v2d && v2d.role === 'derived' && v2d.parent_file === 'amanda_candidate_v2_2026-09-26.png');
  assert.ok(!v1.assets.some((a) => a.repo === 'public/assets/presentations/team/amanda.jpg'), 'v1 no longer claims amanda.jpg');
  assert.ok(v1.assets.some((a) => a.repo === 'public/assets/presentations/team/amanda_legacy_v1.jpg' && a.role === 'derived'));
});

check('old-face video posters use the legacy portrait (poster matches the video)', () => {
  const story = fs.readFileSync(path.join(ROOT, 'lib', 'presentations', 'story.js'), 'utf8');
  assert.match(story, /poster: '\/assets\/presentations\/team\/amanda_legacy_v1\.jpg', video_topic: 'clma_amanda_management'/);
  assert.ok(!/team\/amanda\.jpg', video_topic/.test(story), 'no old-face video poster on amanda.jpg');
  const resolve = fs.readFileSync(path.join(ROOT, 'lib', 'presentations', 'resolve.js'), 'utf8');
  assert.match(resolve, /LEGACY_VIDEO_POSTER = \{ amanda: 'amanda_legacy_v1' \}/);
  assert.match(resolve, /LEGACY_VIDEO_POSTER\[seg\.persona\] \|\| seg\.persona/);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log('  ✓ ' + n); }
    catch (e) { fail += 1; console.log('  ✗ ' + n + '\n    ' + e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
