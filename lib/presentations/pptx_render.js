// ============================================================================
// lib/presentations/pptx_render.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The PowerPoint renderer for the canonical presentation definition. It takes a
// RESOLVED deck (from resolve.resolveStory) and renders each screen by its
// `type`, so the exported .pptx is a representation of the SAME definition the
// browser draws from present.html. Content lives in the screen; only layout
// lives here. See project_presentation_dual_source_tech_debt.
//
//   resolved screens -> renderPptx(screens, opts) -> pptxgenjs presentation
//
// One builder per screen type (the nine proven types). A screen whose type has
// no builder throws — we never silently omit a slide. Every reader-visible
// string on a screen is placed on the slide; the parity test
// (test_presentation_parity) asserts that by extracting the slide text and
// checking it against contentSignature().
//
// VIDEO (Ed 2026-09-20): PowerPoint is the static, portable leave-behind, not an
// interactive player. A video slide exports the poster + title + copy + layout;
// the live browser deck is where video plays. No embed, no hyperlink, no player.
// ============================================================================
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const sizeOf = require('image-size');
const { COLORS, LOGO_PATH } = require('./shared');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Map a browser asset path ("/assets/...", "/logos/...") to a file on disk.
function localAssetPath(webPath) {
  if (!webPath || typeof webPath !== 'string') return null;
  if (!webPath.startsWith('/')) return null;
  const p = path.join(PUBLIC_DIR, webPath.replace(/^\/+/, ''));
  return p;
}
function fileExists(p) { try { return !!p && fs.existsSync(p); } catch (_) { return false; } }

// pptxgenjs sizing (cover/contain) preserves aspect ONLY when it knows the
// image's intrinsic size — but in Node it defaults that to the placement box,
// so cover/contain collapse to a zero crop and the image STRETCHES to the box.
// We read the real dimensions and pass them as the addImage w/h (which pptxgenjs
// uses as the intrinsic size), so the crop is computed correctly. This is the
// one primitive every photo/poster goes through. (Ed 2026-09-20 distortion fix.)
function intrinsicInches(p) {
  try { const d = sizeOf(p); return (d && d.width && d.height) ? { w: d.width / 96, h: d.height / 96 } : null; }
  catch (_) { return null; }
}
// Fill a box, cropping to preserve aspect (object-fit: cover).
function addCover(slide, pres, p, x, y, w, h) {
  const d = intrinsicInches(p);
  if (d) slide.addImage({ path: p, x, y, w: d.w, h: d.h, sizing: { type: 'cover', w, h } });
  else { slide.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { color: '1B2350' } }); } // dims unreadable: never stretch — show a plate
}
// Fit within a box, preserving aspect (object-fit: contain).
function addContain(slide, pres, p, x, y, w, h) {
  const d = intrinsicInches(p);
  if (d) slide.addImage({ path: p, x, y, w: d.w, h: d.h, sizing: { type: 'contain', w, h } });
  else slide.addImage({ path: p, x, y, w, h });
}

// 16:9 stage is 10 x 5.625 inches. One shared grid so every slide lines up.
const GX = 0.6;               // left/right margin
const GW = 10 - GX * 2;       // content width
const THEME = {
  dark:  { bg: COLORS.NAVY_DEEP, fg: COLORS.WHITE,  muted: COLORS.ICE,        rule: '2A3566',   card: '1B2350' },
  light: { bg: COLORS.WHITE,     fg: COLORS.NAVY,   muted: COLORS.SLATE,      rule: COLORS.RULE, card: COLORS.OFFWHITE },
};
function theme(s) { return s && s.theme === 'dark' ? THEME.dark : THEME.light; }

const FOOT = 'trustEd  ·  bEdrock Intelligence';

function baseSlide(pres, s) {
  const t = theme(s);
  const slide = pres.addSlide();
  slide.background = { color: t.bg };
  if (s.label) slide.addText(String(s.label).toUpperCase(), { x: GX, y: 0.42, w: GW, h: 0.3, fontFace: 'Calibri', fontSize: 10.5, color: t.muted, charSpacing: 3, bold: true, margin: 0 });
  slide.addText(FOOT, { x: GX, y: 5.25, w: GW, h: 0.25, fontFace: 'Calibri', fontSize: 9, color: t.muted, charSpacing: 2, margin: 0 });
  return { slide, t };
}
function addHeadline(slide, t, text, y = 0.95, size = 30) {
  slide.addText(String(text || ''), { x: GX, y, w: GW, h: 1.0, fontFace: 'Calibri', fontSize: size, bold: true, color: t.fg, margin: 0, valign: 'top' });
}
function addBody(slide, t, text, y, h = 1.0, size = 15) {
  if (!text) return;
  slide.addText(String(text), { x: GX, y, w: GW, h, fontFace: 'Calibri', fontSize: size, color: t.muted, margin: 0, valign: 'top' });
}
function addFootnote(slide, t, text) {
  if (!text) return;
  slide.addText(String(text), { x: GX, y: 4.75, w: GW, h: 0.4, fontFace: 'Calibri', fontSize: 12, italic: true, color: t.muted, margin: 0 });
}

// -------- per-type builders. Each returns nothing; adds one slide. -----------
function buildCover(pres, s) {
  const t = theme(s);
  const slide = pres.addSlide();
  slide.background = { color: t.bg };
  if (fileExists(LOGO_PATH)) addContain(slide, pres, LOGO_PATH, GX, 0.5, 1.35, 0.4);
  if (s.kicker) slide.addText(s.kicker, { x: GX, y: 1.5, w: GW, h: 0.35, fontFace: 'Calibri', fontSize: 13, color: t.muted, bold: true, charSpacing: 2, margin: 0 });
  slide.addText(String(s.title || ''), { x: GX, y: 1.95, w: GW, h: 1.2, fontFace: 'Calibri', fontSize: 54, bold: true, color: t.fg, margin: 0 });
  if (s.tagline) slide.addText(s.tagline, { x: GX, y: 3.2, w: GW, h: 0.5, fontFace: 'Calibri', fontSize: 20, italic: true, color: t.muted, margin: 0 });
  const pf = s.prepared_for;
  if (pf && (pf.org || (pf.attendees || []).length || pf.date)) {
    const lines = [];
    if (pf.org) lines.push({ text: pf.org, options: { bold: true, fontSize: 15, color: t.fg, breakLine: true } });
    if ((pf.attendees || []).length) lines.push({ text: pf.attendees.join('   ·   '), options: { fontSize: 12.5, color: t.muted, breakLine: true } });
    if (pf.date) lines.push({ text: pf.date, options: { fontSize: 12.5, italic: true, color: t.muted } });
    slide.addText('PREPARED FOR', { x: GX, y: 4.05, w: GW, h: 0.25, fontFace: 'Calibri', fontSize: 9.5, bold: true, charSpacing: 2, color: t.muted, margin: 0 });
    slide.addText(lines, { x: GX, y: 4.35, w: GW, h: 0.9, fontFace: 'Calibri', margin: 0, valign: 'top' });
  }
  slide.addText(FOOT, { x: GX, y: 5.25, w: GW, h: 0.25, fontFace: 'Calibri', fontSize: 9, color: t.muted, charSpacing: 2, margin: 0 });
}

function buildClosing(pres, s) {
  const t = theme(s);
  const slide = pres.addSlide();
  slide.background = { color: t.bg };
  slide.addText(String(s.title || ''), { x: GX, y: 1.9, w: GW, h: 1.6, fontFace: 'Calibri', fontSize: 44, bold: true, color: t.fg, margin: 0, valign: 'middle' });
  if (s.kicker) slide.addText(s.kicker, { x: GX, y: 3.6, w: GW, h: 0.4, fontFace: 'Calibri', fontSize: 13, color: t.muted, charSpacing: 2, margin: 0 });
  slide.addText(FOOT, { x: GX, y: 5.25, w: GW, h: 0.25, fontFace: 'Calibri', fontSize: 9, color: t.muted, charSpacing: 2, margin: 0 });
}

function buildColumnsBlock(slide, t, columns, y) {
  const n = columns.length || 1;
  const gap = 0.3;
  const w = (GW - gap * (n - 1)) / n;
  columns.forEach((c, i) => {
    const x = GX + i * (w + gap);
    slide.addText(String(c.header || '').toUpperCase(), { x, y, w, h: 0.3, fontFace: 'Calibri', fontSize: 11, bold: true, charSpacing: 1.5, color: t.fg, margin: 0 });
    const items = (c.items || []).map((it) => ({ text: String(it), options: { fontSize: 13, color: t.muted, bullet: { characterCode: '2022' }, breakLine: true, paraSpaceAfter: 4 } }));
    if (items.length) slide.addText(items, { x, y: y + 0.35, w, h: 3.0, fontFace: 'Calibri', margin: 0, valign: 'top' });
  });
}

function buildStatement(pres, s) {
  const { slide, t } = baseSlide(pres, s);
  addHeadline(slide, t, s.headline);
  let y = 2.0;
  if (s.body) { addBody(slide, t, s.body, y, 1.1); y += 1.2; }
  if (Array.isArray(s.columns) && s.columns.length) { buildColumnsBlock(slide, t, s.columns, Math.max(y, 2.2)); }
  if (s.image) {
    const p = localAssetPath(s.image);
    if (fileExists(p)) addContain(slide, pres, p, GX, 2.2, GW, 2.0);
    else slide.addShape(pres.shapes.RECTANGLE, { x: GX, y: 2.2, w: GW, h: 2.0, fill: { color: t.card }, line: { color: t.rule, width: 1 } });
    if (s.image_caption) slide.addText(String(s.image_caption), { x: GX, y: 4.3, w: GW, h: 0.3, fontFace: 'Calibri', fontSize: 11.5, italic: true, color: t.muted, align: 'center', margin: 0 });
  }
  if (s.cta && s.cta.label) {
    const label = s.cta.href ? `${s.cta.label}  ›  ${s.cta.href}` : s.cta.label;
    slide.addText(label, { x: GX, y: 4.35, w: GW, h: 0.35, fontFace: 'Calibri', fontSize: 12.5, bold: true, color: t.fg, margin: 0, hyperlink: s.cta.href ? { url: s.cta.href } : undefined });
    if (s.cta.note) slide.addText(s.cta.note, { x: GX, y: 4.7, w: GW, h: 0.3, fontFace: 'Calibri', fontSize: 11, italic: true, color: t.muted, margin: 0 });
  } else {
    addFootnote(slide, t, s.footnote);
  }
}

function buildPoints(pres, s) {
  const { slide, t } = baseSlide(pres, s);
  addHeadline(slide, t, s.headline);
  let y = s.body ? 2.05 : 1.9;
  if (s.body) addBody(slide, t, s.body, 1.85, 0.5, 14);
  const pts = s.points || [];
  const rowH = Math.min(0.9, (4.6 - y) / Math.max(pts.length, 1));
  pts.forEach((p, i) => {
    const ry = y + i * rowH;
    if (p.n) slide.addText(String(p.n), { x: GX, y: ry, w: 0.9, h: rowH, fontFace: 'Calibri', fontSize: 15, bold: true, color: t.muted, margin: 0, valign: 'top' });
    const head = p.head ? [{ text: String(p.head), options: { bold: true, fontSize: 14.5, color: t.fg, breakLine: true } }] : [];
    const body = p.body ? [{ text: String(p.body), options: { fontSize: 12.5, color: t.muted } }] : [];
    if (head.length || body.length) slide.addText([...head, ...body], { x: GX + 1.0, y: ry, w: GW - 1.0, h: rowH, fontFace: 'Calibri', margin: 0, valign: 'top' });
  });
  addFootnote(slide, t, s.footnote);
}

function buildColumns(pres, s) {
  const { slide, t } = baseSlide(pres, s);
  addHeadline(slide, t, s.headline);
  let y = 1.95;
  if (s.body) { addBody(slide, t, s.body, y, 0.6, 15); y += 0.7; }
  buildColumnsBlock(slide, t, s.columns || [], y);
  addFootnote(slide, t, s.footnote);
}

function buildCompare(pres, s) {
  const { slide, t } = baseSlide(pres, s);
  addHeadline(slide, t, s.headline);
  if (s.body) addBody(slide, t, s.body, 1.9, 0.6, 14);
  const y = s.body ? 2.6 : 2.2;
  const gap = 0.4, w = (GW - gap) / 2;
  [['left', s.left], ['right', s.right]].forEach(([, side], i) => {
    if (!side) return;
    const x = GX + i * (w + gap);
    slide.addShape(pres.shapes.RECTANGLE, { x, y, w, h: 2.0, fill: { color: t.card }, line: { color: t.rule, width: 1 } });
    slide.addText([
      { text: String(side.label || '').toUpperCase(), options: { fontSize: 10.5, bold: true, charSpacing: 1.5, color: t.muted, breakLine: true, paraSpaceAfter: 6 } },
      { text: String(side.head || ''), options: { fontSize: 16, bold: true, color: t.fg, breakLine: true, paraSpaceAfter: 4 } },
      { text: String(side.sub || ''), options: { fontSize: 12.5, color: t.muted } },
    ], { x: x + 0.25, y: y + 0.2, w: w - 0.5, h: 1.6, fontFace: 'Calibri', margin: 0, valign: 'top' });
  });
}

function buildRoadmap(pres, s) {
  const { slide, t } = baseSlide(pres, s);
  addHeadline(slide, t, s.headline);
  const ms = s.milestones || [];
  const n = ms.length || 1;
  const gap = 0.3, w = (GW - gap * (n - 1)) / n;
  ms.forEach((m, i) => {
    const x = GX + i * (w + gap);
    slide.addShape(pres.shapes.RECTANGLE, { x, y: 2.2, w, h: 2.2, fill: { color: t.card }, line: { color: t.rule, width: 1 } });
    slide.addText([
      { text: String(m.when || '').toUpperCase(), options: { fontSize: 11, bold: true, charSpacing: 1, color: t.muted, breakLine: true, paraSpaceAfter: 5 } },
      { text: String(m.head || ''), options: { fontSize: 14, bold: true, color: t.fg, breakLine: true, paraSpaceAfter: 3 } },
      { text: String(m.body || ''), options: { fontSize: 11.5, color: t.muted } },
    ], { x: x + 0.2, y: 2.4, w: w - 0.4, h: 1.8, fontFace: 'Calibri', margin: 0, valign: 'top' });
  });
}

function buildTeam(pres, s) {
  const { slide, t } = baseSlide(pres, s);
  addHeadline(slide, t, s.headline, 0.95, 28);
  if (s.body) addBody(slide, t, s.body, 1.75, 0.4, 13);
  const members = s.members || [];
  if (!members.length) return;
  const perRow = Math.min(members.length, 8);
  const gap = 0.15, w = (GW - gap * (perRow - 1)) / perRow;
  members.slice(0, 16).forEach((m, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const x = GX + col * (w + gap), y = 2.2 + row * 1.35;
    const p = localAssetPath(m.img);
    if (fileExists(p)) addCover(slide, pres, p, x, y, w, 0.85);
    else slide.addShape(pres.shapes.RECTANGLE, { x, y, w, h: 0.85, fill: { color: t.card }, line: { color: t.rule, width: 1 } });
    slide.addText([
      { text: String(m.name || ''), options: { fontSize: 9.5, bold: true, color: t.fg, breakLine: true } },
      { text: String(m.role || ''), options: { fontSize: 7.5, color: t.muted } },
    ], { x, y: y + 0.9, w, h: 0.4, align: 'center', fontFace: 'Calibri', margin: 0, valign: 'top' });
  });
}

// PowerPoint is the static, portable, editable leave-behind — not an
// interactive player. A video screen exports its meaningful static content:
// the poster, the title, the copy, the layout. The live browser deck is where
// video plays. No embed, no hyperlink, no fallback machinery. (Ed 2026-09-20.)
function buildVideo(pres, s) {
  const { slide, t } = baseSlide(pres, s);
  addHeadline(slide, t, s.headline, 0.95, 30);
  if (s.body) addBody(slide, t, s.body, 1.85, 0.9, 14);
  const vx = GX, vy = 2.9, vw = Math.min(GW, 4.2), vh = 2.0;
  const posterPath = localAssetPath(s.poster);
  if (fileExists(posterPath)) addCover(slide, pres, posterPath, vx, vy, vw, vh);
  else slide.addShape(pres.shapes.RECTANGLE, { x: vx, y: vy, w: vw, h: vh, fill: { color: t.card }, line: { color: t.rule, width: 1 } });
  slide.addText('VIDEO', { x: vx + 0.15, y: vy + vh - 0.42, w: 1.2, h: 0.28, fontFace: 'Calibri', fontSize: 10, bold: true, charSpacing: 2, color: COLORS.WHITE, fill: { color: '000000', transparency: 35 }, align: 'center', margin: 0 });
}

const BUILDERS = { cover: buildCover, closing: buildClosing, statement: buildStatement, points: buildPoints, columns: buildColumns, compare: buildCompare, roadmap: buildRoadmap, team: buildTeam, video: buildVideo };

// Render a resolved deck to a pptxgenjs presentation. One slide per screen, in
// order. An unknown screen type throws (never a silent drop).
function renderPptx(screens, opts = {}) {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';
  pres.author = 'bEdrock Intelligence';
  pres.title = opts.title || 'trustEd';
  for (const s of screens) {
    const b = BUILDERS[s.type];
    if (!b) throw new Error('pptx_render: no builder for screen type ' + JSON.stringify(s.type) + ' (id=' + s.id + ')');
    b(pres, s);
  }
  return { pres };
}

module.exports = { renderPptx, localAssetPath, THEME };
