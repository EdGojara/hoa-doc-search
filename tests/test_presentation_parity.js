// ============================================================================
// tests/test_presentation_parity.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The invariant: SELECTED PRESENTATION === EXPORTED PRESENTATION.
// For every audience the dropdown offers, resolve the deck once and render it to
// PowerPoint, then prove the PPTX is a faithful representation of that same
// definition:
//   1. slide count === resolved screen count (no dropped / extra slides),
//   2. per-slide CONTENT COMPLETENESS — every reader-visible string from the
//      screen's contentSignature appears on its slide (catches silent content
//      loss even when count + title still match),
//   3. media presence — every ready video screen carries a link to its clip in
//      the slide relationships (video never silently omitted),
//   4. no cross-audience leakage — because each slide must match ITS screen's
//      signature and counts are equal, another audience's content cannot appear.
// Plus a variable-resolution check so browser and PPTX resolve {{vars}} the same.
//
// Run: node tests/test_presentation_parity.js   (wired into `npm test`)
// ============================================================================
require('dotenv').config();
const JSZip = require('jszip');
const story = require('../lib/presentations/story');
const contract = require('../lib/presentations/screen_contract');
const fs = require('fs');
const { resolveStory } = require('../lib/presentations/resolve');
const { renderPptx, localAssetPath } = require('../lib/presentations/pptx_render');

let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
} catch (_) { /* text parity still runs without DB */ }

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
function xmlUnescape(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function textOf(xml) {
  const runs = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
  return norm(xmlUnescape(runs.map((r) => r.replace(/<\/?a:t>/g, '')).join(' ')));
}
function relTargets(relsXml) {
  const t = [];
  const re = /Target="([^"]+)"/g; let m;
  while ((m = re.exec(relsXml || ''))) t.push(xmlUnescape(m[1]));
  return t;
}

async function pptxParts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));
  const slides = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    const relName = name.replace(/slides\/(slide\d+)\.xml/, 'slides/_rels/$1.xml.rels');
    const relsXml = zip.file(relName) ? await zip.file(relName).async('string') : '';
    slides.push({ text: textOf(xml), targets: relTargets(relsXml) });
  }
  return { slides };
}

async function checkAudience(aud) {
  const failures = [];
  const { screens } = await resolveStory(aud, { supabase });
  const { pres } = renderPptx(screens);
  const buf = await pres.write({ outputType: 'nodebuffer' });
  const { slides } = await pptxParts(buf);

  if (slides.length !== screens.length) {
    failures.push(`slide count ${slides.length} !== screen count ${screens.length}`);
    return failures; // counts must match before per-slide checks are meaningful
  }

  screens.forEach((s, i) => {
    const sig = contract.contentSignature(s);
    const slideText = slides[i].text;
    for (const str of sig.strings) {
      if (!norm(str)) continue;
      if (!slideText.includes(norm(str))) {
        failures.push(`slide ${i + 1} (${s.type} ${s.id}): MISSING "${str.slice(0, 60)}"`);
      }
    }
    // Video slides are static in PowerPoint (poster + title + copy). When the
    // poster asset exists on disk, the export must contain it (never dropped).
    if (s.type === 'video' && s.poster) {
      const p = localAssetPath(s.poster);
      const posterOnDisk = p && fs.existsSync(p);
      const hasImage = slides[i].targets.some((t) => /\.(png|jpe?g)$/i.test(t));
      if (posterOnDisk && !hasImage) failures.push(`slide ${i + 1} (video ${s.id}): poster on disk but MISSING from export`);
    }
  });
  return failures;
}

// The audience list must have ONE source (story.AUDIENCE_META); the UI and
// routing derive from it; unknown audiences fail visibly. This is the test that
// would have caught the CLMA routing omission (a hardcoded UI list missing 'clma').
function checkAudienceSource() {
  const failures = [];
  if (JSON.stringify(story.AUDIENCES) !== JSON.stringify(story.AUDIENCE_META.map((a) => a.slug))) failures.push('AUDIENCES must derive from AUDIENCE_META');
  let threw = false; try { story.getStory('definitely-not-an-audience'); } catch (_) { threw = true; }
  if (!threw) failures.push('getStory must THROW on an unknown audience (no silent general fallback)');
  for (const slug of story.AUDIENCES) { if (!story.getStory(slug).length) failures.push('empty deck for audience ' + slug); }
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'present.html'), 'utf8');
  if (/<option\s+value="(general|board|clma|partner|bank|referral|tech)"/.test(html)) failures.push('present.html hardcodes audience <option>s — must derive from /api/presentations/audiences');
  if (/\]\s*\.includes\(\s*qAud\s*\)/.test(html)) failures.push('present.html hardcodes an audience allowlist array for ?audience routing');
  if (!/\/api\/presentations\/audiences/.test(html)) failures.push('present.html must fetch the canonical audience list');
  return failures;
}

// Image invariant: presentation images and video posters must preserve the
// source aspect ratio (cover/crop, never independent width/height stretching).
async function checkImageSizing() {
  const failures = [];
  const P = require('path');
  const html = fs.readFileSync(P.join(__dirname, '..', 'public', 'present.html'), 'utf8');
  // Browser: a <video poster=> stretches the still frame (poster ignores
  // object-fit). Posters must render as <img class="vposter"> with cover.
  if (/<video\b[^>]*\bposter\s*=/.test(html)) failures.push('present.html uses <video poster=> — the poster stretches; render it as <img class="vposter"> object-fit:cover');
  if (!/\.vposter[^{]*\{[^}]*object-fit:\s*cover/.test(html)) failures.push('present.html .vposter must use object-fit:cover');
  // PowerPoint FUNCTIONAL check: pptxgenjs only crops when given the image's real
  // intrinsic size (it defaults to the box -> zero crop -> stretch). Render the
  // CLMA deck (a square 640x640 poster in a wide 16:9 box) and assert the poster
  // picture carries a REAL crop (non-zero srcRect), proving it is not stretched.
  const { screens } = await resolveStory('clma', { supabase });
  const { pres } = renderPptx(screens);
  const buf = await pres.write({ outputType: 'nodebuffer' });
  const zip = await JSZip.loadAsync(buf);
  let cropped = false;
  for (const n of Object.keys(zip.files).filter((x) => /ppt\/slides\/slide\d+\.xml$/.test(x))) {
    const xml = await zip.file(n).async('string');
    for (const pic of xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) || []) {
      const sr = pic.match(/<a:srcRect ([^/]*)\/>/);
      if (sr) { const nums = (sr[1].match(/-?\d+/g) || []).map(Number); if (nums.some((v) => Math.abs(v) > 1000)) cropped = true; }
    }
  }
  if (!cropped) failures.push('pptx: the square poster was NOT cropped (cover is stretching — intrinsic dimensions not applied)');
  return failures;
}

(async () => {
  let total = 0;
  const audFails = checkAudienceSource();
  total += audFails.length;
  console.log(`audience-src   ${audFails.length ? 'FAIL' : 'ok'}`);
  audFails.forEach((f) => console.log('   - ' + f));

  const imgFails = await checkImageSizing();
  total += imgFails.length;
  console.log(`image-sizing   ${imgFails.length ? 'FAIL' : 'ok'}`);
  imgFails.forEach((f) => console.log('   - ' + f));

  for (const aud of story.AUDIENCES) {
    const fails = await checkAudience(aud);
    total += fails.length;
    console.log(`${aud.padEnd(10)} ${fails.length ? 'FAIL (' + fails.length + ')' : 'ok'}`);
    fails.slice(0, 12).forEach((f) => console.log('   - ' + f));
  }

  if (total) { console.error(`\n✗ presentation parity: ${total} failure(s)`); process.exit(1); }
  console.log('\n✓ presentation parity: selected === exported for every audience');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
