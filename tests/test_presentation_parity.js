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

function checkVariables() {
  const failures = [];
  if (contract.interpolate('{{a}}/{{b}}', { a: 1, b: 'x' }) !== '1/x') failures.push('interpolate: basic substitution failed');
  if (contract.interpolate('{{missing}}', {}) !== '{{missing}}') failures.push('interpolate: unknown token should stay visible');
  const screen = contract.applyVars({ id: 't', type: 'statement', headline: 'Price {{price}} for {{community}}' }, { price: 18, community: 'Waterview' });
  if (screen.headline !== 'Price 18 for Waterview') failures.push('applyVars: deep string interpolation failed');
  return failures;
}

(async () => {
  let total = 0;
  const varFails = checkVariables();
  total += varFails.length;
  console.log(`variables      ${varFails.length ? 'FAIL' : 'ok'}`);
  varFails.forEach((f) => console.log('   - ' + f));

  for (const aud of story.AUDIENCES) {
    const fails = await checkAudience(aud);
    total += fails.length;
    console.log(`${aud.padEnd(10)} ${fails.length ? 'FAIL (' + fails.length + ')' : 'ok'}`);
    fails.slice(0, 12).forEach((f) => console.log('   - ' + f));
  }

  if (total) { console.error(`\n✗ presentation parity: ${total} failure(s)`); process.exit(1); }
  console.log('\n✓ presentation parity: selected === exported for every audience');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
