#!/usr/bin/env node
// Build a teammate's approved photo set from lib/team/persona_images.json
// (Ed 2026-10-21, issue #241). One command per update:
//   node scripts/build_persona_images.js amanda <folder-with-approved-pngs>
// Writes, never upscaling:
//   <dir>/<photo>.jpg          every approved photo at its native size
//   <dir>/<photo>-square.jpg   a square crop where the map gives square_crop_top_px
//   team/<persona>.jpg         the canonical square every surface reads
// The current canonical square is copied to team/<persona>_legacy_<stamp>.jpg
// first if it differs and no backup of those bytes exists yet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createCanvas, loadImage } = require('canvas');

const ROOT = path.join(__dirname, '..');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'team', 'persona_images.json'), 'utf8'));
const QUALITY = 0.88;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// crop: { x, y, w, h } region of the source (e.g. to leave a window out);
// width: output width, only ever DOWN (a source is never upscaled).
async function jpeg(src, { square = false, top = 0, crop = null, width = null } = {}) {
  const img = await loadImage(src);
  const r = crop || { x: 0, y: 0, w: img.width, h: img.height };
  const side = Math.min(r.w, r.h);
  const sw = square ? side : r.w; const sh = square ? side : r.h;
  const sy = r.y + (square ? Math.max(0, Math.min(top, r.h - side)) : 0);
  const sx = r.x + (square ? Math.round((r.w - side) / 2) : 0);
  const scale = width && width < sw ? width / sw : 1;
  const w = Math.round(sw * scale); const h = Math.round(sh * scale);
  const c = createCanvas(w, h); const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return c.toBuffer('image/jpeg', { quality: QUALITY });
}

(async () => {
  const [persona, srcDir] = process.argv.slice(2);
  const m = MAP[persona];
  if (!m || !srcDir) { console.error('usage: node scripts/build_persona_images.js <persona> <folder>   personas:', Object.keys(MAP).filter((k) => !k.startsWith('_')).join(', ')); process.exit(2); }
  const dir = path.join(ROOT, m.dir); fs.mkdirSync(dir, { recursive: true });
  for (const [name, p] of Object.entries(m.photos)) {
    const src = path.join(srcDir, `${name}.png`);
    if (!fs.existsSync(src)) throw new Error(`missing approved photo ${src}`);
    fs.writeFileSync(path.join(dir, `${name}.jpg`), await jpeg(src, { crop: p.crop || null }));
    if (p.square_crop_top_px != null) fs.writeFileSync(path.join(dir, `${name}-square.jpg`), await jpeg(src, { square: true, top: p.square_crop_top_px, crop: p.crop || null }));
    // A headshot square from a named region of a larger photo: { x, y, size }.
    if (p.square_region) {
      const r = p.square_region;
      fs.writeFileSync(path.join(dir, `${name}-square.jpg`), await jpeg(src, { crop: { x: r.x, y: r.y, w: r.size, h: r.size } }));
      for (const w of (p.square_widths || []).filter((x) => x < r.size)) fs.writeFileSync(path.join(dir, `${name}-square-${w}.jpg`), await jpeg(src, { crop: { x: r.x, y: r.y, w: r.size, h: r.size }, width: w }));
    }
    // Responsive widths for large placements (website, profile): only widths
    // below the source's own width are written.
    const extra = [];
    const srcW = p.crop ? p.crop.w : (await loadImage(src)).width;
    for (const w of (p.widths || []).filter((x) => x < srcW)) {
      fs.writeFileSync(path.join(dir, `${name}-${w}.jpg`), await jpeg(src, { crop: p.crop || null, width: w })); extra.push(w);
    }
    console.log(`  ${m.dir}/${name}.jpg${p.square_crop_top_px != null || p.square_region ? ' (+ square)' : ''}${extra.length ? ` (+ ${extra.join('/')}w)` : ''}`);
  }
  const cs = m.canonical_square;
  // No canonical_square: the teammate's production square (team/<persona>.jpg) is not
  // managed here yet and is left exactly as it is.
  if (!cs) { console.log(`  team/${persona}.jpg left unchanged (no canonical_square in the map)`); return; }
  const out = path.join(ROOT, cs.out);
  // region: { x, y, size } frames the face in a larger photo; width downsizes
  // (e.g. 640, the size every surface was built for). Never upscales.
  const next = cs.region
    ? await jpeg(path.join(srcDir, `${cs.from}.png`), { crop: { x: cs.region.x, y: cs.region.y, w: cs.region.size, h: cs.region.size }, width: cs.width || null })
    : await jpeg(path.join(srcDir, `${cs.from}.png`), { square: true, top: cs.crop_top_px, width: cs.width || null });
  if (fs.existsSync(out)) {
    const cur = fs.readFileSync(out);
    const teamDir = path.dirname(out);
    const backedUp = fs.readdirSync(teamDir).filter((f) => f.startsWith(`${persona}_legacy`)).some((f) => sha(fs.readFileSync(path.join(teamDir, f))) === sha(cur));
    if (sha(cur) !== sha(next) && !backedUp) {
      const b = path.join(teamDir, `${persona}_legacy_${new Date().toISOString().slice(0, 10)}.jpg`);
      fs.copyFileSync(out, b); console.log(`  backed up the current square to ${path.relative(ROOT, b)}`);
    }
  }
  fs.writeFileSync(out, next);
  console.log(`  ${cs.out} (canonical square from ${cs.from})`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
