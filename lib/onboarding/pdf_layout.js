// ============================================================================
// lib/onboarding/pdf_layout.js  (Issue #15) — layout-preserving PDF text
// ----------------------------------------------------------------------------
// Turns an ORIGINAL legacy report PDF into text laid out like
// `pdftotext -layout` (columns kept apart by runs of spaces), using pdfjs-dist
// (already a production dependency), so customers upload reports exactly as
// the legacy system exports them. Deterministic, no AI.
//
// Each text item's x/y position is mapped onto a character grid: items on the
// same baseline form a line; the column = x / (median character width).
// The adapters never trust this blindly: every parse is re-added against the
// report's own printed totals (extraction controls), so a layout mistake fails
// a control instead of producing a wrong number.
// ============================================================================

let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs'));

async function pdfToLayoutText(buffer) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str && it.str.trim() !== '').map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height || 10 }));
    if (!items.length) { pages.push(''); continue; }
    const widths = items.filter((it) => it.str.length > 0 && it.w > 0).map((it) => it.w / it.str.length).sort((a, b) => a - b);
    const cw = Math.max(widths[Math.floor(widths.length / 2)] || 5, 1) * 0.9;   // a bit narrower keeps column gaps visible
    // group by baseline (tolerance = 40% of the median glyph height)
    const hs = items.map((it) => it.h).sort((a, b) => a - b); const tol = Math.max((hs[Math.floor(hs.length / 2)] || 10) * 0.4, 1.5);
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) { const r = rows.find((row) => Math.abs(row.y - it.y) <= tol); if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] }); }
    rows.sort((a, b) => b.y - a.y);
    const out = [];
    // typical gap between consecutive baselines = the "single spacing" of this page
    const gaps = []; for (let k = 1; k < rows.length; k++) gaps.push(rows[k - 1].y - rows[k].y);
    gaps.sort((a, b) => a - b);
    const single = gaps.length ? gaps[Math.floor(gaps.length * 0.25)] : 12;
    let prevY = null;
    for (const r of rows) {
      if (prevY !== null && prevY - r.y > single * 1.8) out.push('');        // one blank line for a real vertical gap
      prevY = r.y;
      r.items.sort((a, b) => a.x - b.x);
      // merge items that touch / sit one space apart into words and phrases
      const runs = [];
      for (const it of r.items) {
        const last = runs[runs.length - 1];
        const gap = last ? it.x - (last.x + last.w) : Infinity;
        if (last && gap < cw * 1.3) { last.str += (gap > cw * 0.25 ? ' ' : '') + it.str; last.w = it.x + it.w - last.x; }
        else runs.push({ ...it });
      }
      let line = '';
      for (const run of runs) {
        const col = Math.max(0, Math.round(run.x / cw));
        if (line.length) line += ' '.repeat(Math.max(2, col - line.length));   // separate columns by 2+ spaces
        else line += ' '.repeat(col);
        line += run.str;
      }
      out.push(line.replace(/\s+$/, ''));
    }
    pages.push(out.join('\n'));
  }
  return pages.join('\n\f');
}

module.exports = { pdfToLayoutText };
