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
// Ed 2026-10-21 (issue #241): amanda.jpg is the approved photo (lib/team/persona_images.json);
// the v2 portrait is kept byte-identical as amanda_legacy_v2.jpg.
const CURRENT_SHA = '60688c5c973c2fedcd6677ba6107e3a5641f1b09c1a478f49b768327a8e33241';   // 378px square of amanda-professional-email
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

check('amanda.jpg is the approved 2026-10-21 photo (378x378 square, never upscaled), not v1 or v2', () => {
  const f = path.join(TEAM, 'amanda.jpg');
  assert.strictEqual(sha(f), CURRENT_SHA, 'amanda.jpg must be the approved photo; a deliberate replacement updates this test');
  assert.notStrictEqual(sha(f), V1_PORTRAIT_SHA); assert.notStrictEqual(sha(f), V2_PORTRAIT_SHA);
  assert.deepStrictEqual(jpegSize(f), { w: 378, h: 378 });
});
check('the v2 portrait is preserved byte-identical as amanda_legacy_v2.jpg', () => {
  assert.strictEqual(sha(path.join(TEAM, 'amanda_legacy_v2.jpg')), V2_PORTRAIT_SHA);
});
check('nothing is upscaled: every stored Amanda file is at or below its approved source (378x506 crops; office portrait 1360x1157)', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8')).amanda;
  const dir = path.join(ROOT, map.dir);
  const names = Object.keys(map.photos).sort((x, y) => y.length - x.length);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
    const owner = names.find((n) => f.startsWith(n));
    assert.ok(owner, `${f} belongs to no mapped photo`);
    const [w, h] = map.photos[owner].native_px || [378, 506];
    const d = jpegSize(path.join(dir, f));
    assert.ok(d && d.w <= w && d.h <= h, `${f} is ${d && d.w}x${d && d.h}, source ${w}x${h}`);
  }
});
check('the approved office portrait is stored at native 1360x1157 and designated for profile + website introduction only', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8')).amanda;
  assert.deepStrictEqual(jpegSize(path.join(ROOT, map.dir, 'amanda-office-portrait.jpg')), { w: 1360, h: 1157 });
  assert.strictEqual(map.placements.profile.photo, 'amanda-office-portrait-square');
  assert.strictEqual(map.placements.website_introduction.photo, 'amanda-office-portrait');
  assert.strictEqual(map.placements.email_signature.photo, 'canonical_square');
  assert.strictEqual(map.placements.chat_avatar.photo, 'amanda-direct-camera-square');
});
check('identity: face v2 is the reference, the excluded high-resolution set is not used, and M365 is untouched', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8')).amanda;
  assert.match(map.identity_reference.authority, /amanda_legacy_v2\.jpg/);
  assert.match(map.high_resolution_review.result, /^EXCLUDED/);
  assert.strictEqual(map.placements.microsoft_365.photo, 'unchanged');
  for (const k of ['about_us_team', 'informational']) assert.strictEqual(map.placements[k].photo, null, k);
});
check('the persona image map owns amanda.jpg; every mapped photo exists; no other teammate is mapped', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(map).filter((k) => !k.startsWith('_')), ['amanda', 'paige', 'phoebe', 'maggie', 'claire', 'annie', 'miranda']);
  assert.strictEqual(map.amanda.canonical_square.out, 'public/assets/presentations/team/amanda.jpg');
  for (const k of Object.keys(map.amanda.photos)) assert.ok(fs.existsSync(path.join(ROOT, map.amanda.dir, k + '.jpg')), k);
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
  assert.match(resolve, /LEGACY_VIDEO_POSTER = \{ amanda: 'amanda_legacy_v1', paige: 'paige_legacy_v1', claire: 'claire_legacy_2026-10-22' \}/);
  assert.match(resolve, /LEGACY_VIDEO_POSTER\[seg\.persona\] \|\| seg\.persona/);
});

// ---- Paige (Ed 2026-10-21): new photos of the SAME woman; production face kept for video ----
const PAIGE_V1_SHA = '81984853868b1718c09bb4bac7e92132ffa0cbc2bef69052c0df0d5effa55bd1';   // registry: 640px derivative of canon bbc6c052
const PAIGE_CURRENT_SHA = '5f06ec32de3db24db0cc7bb5f210ed067a082202589455b1179d028ebb0e40c6';
check('paige.jpg is the 2026-10-21 headshot (640x640), and v1 is preserved byte-identical as paige_legacy_v1.jpg', () => {
  assert.strictEqual(sha(path.join(TEAM, 'paige.jpg')), PAIGE_CURRENT_SHA, 'a deliberate replacement updates this test');
  assert.deepStrictEqual(jpegSize(path.join(TEAM, 'paige.jpg')), { w: 640, h: 640 });
  assert.strictEqual(sha(path.join(TEAM, 'paige_legacy_v1.jpg')), PAIGE_V1_SHA);
});
check('Paige video posters show her production face (the face the videos show)', () => {
  const story = fs.readFileSync(path.join(ROOT, 'lib', 'presentations', 'story.js'), 'utf8');
  assert.ok(!/team\/paige\.jpg/.test(story), 'no Paige video poster on paige.jpg');
  assert.strictEqual((story.match(/team\/paige_legacy_v1\.jpg/g) || []).length, 3);
});
check('Paige: nothing upscaled; identity reference is the production original; HeyGen and M365 unchanged', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8')).paige;
  assert.match(map.identity_reference.authority, /bbc6c052/);
  assert.strictEqual(map.placements.heygen_avatar.photo, 'unchanged');
  assert.strictEqual(map.placements.microsoft_365.photo, 'unchanged');
  const dir = path.join(ROOT, map.dir);
  const names = Object.keys(map.photos).sort((x, y) => y.length - x.length);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
    const owner = names.find((n) => f.startsWith(n)); assert.ok(owner, f);
    const [w, h] = map.photos[owner].native_px; const d = jpegSize(path.join(dir, f));
    assert.ok(d.w <= w && d.h <= h, `${f} ${d.w}x${d.h} > ${w}x${h}`);
  }
});

// ---- Phoebe (Ed 2026-10-21): two logo-corrected photos added; production photo untouched ----
const PHOEBE_ORIGINAL_SHA = '11d41bd3378f6ed6c8e2d8c7b871c5fddf285a9d1b408100126c1dce77b10b95';   // HeyGen group source
// The SVG is text: git may check it out with CRLF on Windows, so it is hashed with line endings
// normalized to LF, which equals the bytes stored in git and served in production.
const LOCKUP_SVG_SHA = '3fa0b7e9f1bfbe8a953afc67db018d54fb2234bfddde8b098690e3223341c536';
const shaText = (f) => crypto.createHash('sha256').update(fs.readFileSync(f).toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');
check('phoebe.jpg is still her original production portrait (byte-identical)', () => {
  assert.strictEqual(sha(path.join(TEAM, 'phoebe.jpg')), PHOEBE_ORIGINAL_SHA);
});
check('Phoebe: photos stored at or below native size; profile, HeyGen and M365 unchanged; logo correction documented', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8')).phoebe;
  assert.strictEqual(map.canonical_square, null);
  for (const k of ['profile_and_avatars', 'heygen_avatar', 'microsoft_365']) assert.strictEqual(map.placements[k].photo, 'unchanged', k);
  const dir = path.join(ROOT, map.dir);
  const names = Object.keys(map.photos).sort((x, y) => y.length - x.length);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
    const owner = names.find((n) => f.startsWith(n)); assert.ok(owner, f);
    const [w, h] = map.photos[owner].native_px; const d = jpegSize(path.join(dir, f));
    assert.ok(d.w <= w && d.h <= h, `${f} ${d.w}x${d.h} > ${w}x${h}`);
  }
  for (const p of Object.values(map.photos)) {
    assert.match(p.logo_correction, /bedrock-lockup-reversed-compact\.png/);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'brand-assets', 'bedrock-lockup-reversed-compact.png')));
  }
});
check('brand: the approved lockup is unchanged; the light-on-dark versions exist and are registered in lib/brand.js', () => {
  assert.strictEqual(shaText(path.join(ROOT, 'public', 'brand-assets', 'bedrock-lockup.svg')), LOCKUP_SVG_SHA);
  const brand = require(path.join(ROOT, 'lib', 'brand.js'));
  const logos = (brand.BRAND || brand).logos || brand.logos;
  assert.strictEqual(logos.fullLockup, '/brand-assets/bedrock-lockup.svg');
  for (const k of ['fullLockupReversed', 'fullLockupReversedCompact']) {
    assert.ok(logos[k], k);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', logos[k])), logos[k]);
  }
});

// ---- Maggie (Ed 2026-10-22): new blonde/light-brown look; the brunette portrait is kept as a backup ----
const MAGGIE_CURRENT_SHA = '52009c0c87ffceda1fe101fb62eeb5464cbcde35baff2e88fa3e3a7ddb74c5ce';
const MAGGIE_PREVIOUS_SHA = 'a50bd2f20175ba2b0536eaea36dcfbe149fc201a7880e9cd24b9ef4d6c1174e8';   // brunette, 2026-09-09
check('maggie.jpg is the 2026-10-22 portrait (640x640); the previous portrait is preserved byte-identical', () => {
  assert.strictEqual(sha(path.join(TEAM, 'maggie.jpg')), MAGGIE_CURRENT_SHA, 'a deliberate replacement updates this test');
  assert.deepStrictEqual(jpegSize(path.join(TEAM, 'maggie.jpg')), { w: 640, h: 640 });
  assert.strictEqual(sha(path.join(TEAM, 'maggie_legacy_2026-10-22.jpg')), MAGGIE_PREVIOUS_SHA);
});
check('Maggie: her email signature reads team-internal/maggie.jpg, which is byte-identical to team/maggie.jpg', () => {
  assert.strictEqual(sha(path.join(ROOT, 'public', 'assets', 'presentations', 'team-internal', 'maggie.jpg')), MAGGIE_CURRENT_SHA);
});
check('Maggie: nothing upscaled; M365 and the portal video portrait unchanged until Ed approves', () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8')).maggie;
  assert.strictEqual(map.canonical_square.out, 'public/assets/presentations/team/maggie.jpg');
  assert.strictEqual(map.placements.microsoft_365.photo, 'unchanged');
  assert.strictEqual(map.placements.portal_video_visit.photo, 'unchanged');
  const dir = path.join(ROOT, map.dir);
  const names = Object.keys(map.photos).sort((x, y) => y.length - x.length);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
    const owner = names.find((n) => f.startsWith(n)); assert.ok(owner, f);
    const [w, h] = map.photos[owner].native_px; const d = jpegSize(path.join(dir, f));
    assert.ok(d.w <= w && d.h <= h, `${f} ${d.w}x${d.h} > ${w}x${h}`);
  }
});

// ---- Claire, Annie, Miranda (Ed 2026-10-22): the 10/21 website portraits become their TrustEd portraits ----
const CAM = {
  claire: { current: 'f97d69fd58571c7a862481465fc516c8fda60018edf6434f4b8730aa674f7232', previous: 'a3f63910631113536831c315085e0e6cd896b41a14a6623a542421e108177488' },
  annie: { current: '772132ed8e8d222f095d5d39fec57e0109fb0b3c72955f8610546b811c38df9f', previous: '0d81c7a568ff4a64edbf6d3274e992e79929eab1a36c3687557a93efe66f413a' },
  miranda: { current: '83c779a515dd418d94f1bd08e49d30e5dabb25bd00b0fd508979b5dfab6394d1', previous: 'aa09642662b7d379cd403322dfdabf126bc06c5426aa81a9aeb6bd8a6dc87060' },
};
for (const [k, s] of Object.entries(CAM)) {
  check(`${k}.jpg is the 2026-10-22 portrait (640x640); the previous portrait is preserved byte-identical`, () => {
    assert.strictEqual(sha(path.join(TEAM, k + '.jpg')), s.current, 'a deliberate replacement updates this test');
    assert.deepStrictEqual(jpegSize(path.join(TEAM, k + '.jpg')), { w: 640, h: 640 });
    assert.strictEqual(sha(path.join(TEAM, k + '_legacy_2026-10-22.jpg')), s.previous);
  });
  check(`${k}: only the cropped square is stored (no AI-drawn sign or screen); nothing upscaled; M365, HeyGen and portal face unchanged`, () => {
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8'))[k];
    for (const pl of ['microsoft_365', 'heygen_avatar', 'portal_video_visit']) assert.strictEqual(map.placements[pl].photo, 'unchanged', pl);
    const dir = path.join(ROOT, map.dir);
    const [name, ph] = Object.entries(map.photos)[0];
    assert.ok(ph.crop && ph.crop.w === ph.crop.h, 'stored photo is the square crop');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jpg'))) {
      const dd = jpegSize(path.join(dir, f));
      assert.ok(dd.w <= ph.crop.w && dd.h <= ph.crop.h, `${f} ${dd.w}x${dd.h} exceeds the crop`);
      assert.strictEqual(dd.w, dd.h, `${f} is square`);
    }
  });
}
check("Claire's team videos keep a poster that matches the face they show", () => {
  const resolve = fs.readFileSync(path.join(ROOT, 'lib', 'presentations', 'resolve.js'), 'utf8');
  assert.match(resolve, /claire: 'claire_legacy_2026-10-22'/);
  assert.ok(fs.existsSync(path.join(TEAM, 'claire_legacy_2026-10-22.jpg')));
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
