// ============================================================================
// lib/statements/export.js  (Ed 2026-10-09, month-end close PR C)
// ----------------------------------------------------------------------------
// Exports of a statement model, all through the one renderer:
//   xlsxBuffer(models)   one sheet per statement; real numbers (dollars), "n/a"
//                        text where a value is not available in TrustEd
//   csvDetail(rows)      the transactions behind a statement (drill.detailRows)
//   pdfBuffer(models)    the printed package: renderDocument() in headless
//                        Chrome, Letter, repeated table headers, page numbers
// ============================================================================

const { xlsxRows, renderDocument } = require('./render');

function xlsxBuffer(models) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const list = Array.isArray(models) ? models : [models];
  const used = new Set();
  for (const m of list) {
    const rows = xlsxRows(m);
    const aoa = rows.map((r) => (Array.isArray(r) ? r : r.cells));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Number formats: money with parentheses for negatives and "–" for zero; % for variance %.
    const pctCols = new Set(m.columns.map((c, i) => (c.is_pct ? i + 1 : -1)).filter((i) => i > 0));
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; R++) for (let C = 1; C <= range.e.c; C++) {
      const ref = XLSX.utils.encode_cell({ r: R, c: C }); const cell = ws[ref];
      if (cell && cell.t === 'n') cell.z = pctCols.has(C) ? '0.0%;(0.0%);"–"' : '#,##0.00;(#,##0.00);"–"';
    }
    ws['!cols'] = [{ wch: 46 }, ...m.columns.map((c) => ({ wch: c.is_text ? 70 : 16 }))];
    let name = (m.kind === 'balance_sheet' ? 'Balance Sheet' : `Income vs Budget ${m.fund === 'all' ? '' : m.fund}`).trim().slice(0, 31);
    while (used.has(name)) name = `${name.slice(0, 28)} ${used.size}`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const CSV_COLS = ['section', 'category', 'account_number', 'account_name', 'fund', 'posting_date', 'reference', 'description', 'origin', 'source_module', 'amount', 'is_opening_carryforward', 'journal_entry_id'];
function csvDetail(rows) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) lines.push(CSV_COLS.map((k) => q(k === 'amount' ? (r.amount_cents / 100).toFixed(2) : r[k])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Printable area of the package page: Letter landscape 11in x 8.5in, @page margins
// 0.62in top, 0.6in bottom, 0.45in sides (renderDocument). 96 CSS px per inch.
const PRINT_W_PX = Math.floor((11 - 0.9) * 96), PRINT_H_PX = Math.floor((8.5 - 0.62 - 0.6) * 96);
// A statement marked .fit1 (the balance sheet) must print on one page: if it is taller than the
// printable height it is scaled down to fit, never below FIT_MIN (legibility); a statement that
// would need more than that keeps its normal size and continues on the next page.
const FIT_MIN = 0.72;
function fitScale(heightPx, availPx = PRINT_H_PX) {
  if (!(heightPx > availPx)) return 1;
  const z = Math.floor((availPx / heightPx) * 0.985 * 1000) / 1000;
  return z >= FIT_MIN ? z : 1;
}
async function fitOnePage(page) {
  const heights = await page.evaluate(() => [...document.querySelectorAll('.fit1')].map((el) => el.getBoundingClientRect().height));
  const zooms = heights.map((h) => fitScale(h));
  if (zooms.some((z) => z !== 1)) await page.evaluate((zs) => { [...document.querySelectorAll('.fit1')].forEach((el, i) => { if (zs[i] !== 1) el.style.zoom = String(zs[i]); }); }, zooms);
  for (let i = 0; i < heights.length; i++) if (zooms[i] === 1 && heights[i] > PRINT_H_PX) console.warn('[statements] balance sheet does not fit one page even at minimum scale', { height_px: Math.round(heights[i]), avail_px: PRINT_H_PX });
  return zooms;
}
async function pdfBuffer(models, { title } = {}) {
  const puppeteer = require('puppeteer');
  const html = renderDocument(models, { title });
  const list = Array.isArray(models) ? models : [models];
  const m0 = list[0];
  const life = (m0.lifecycle && m0.lifecycle.label) || 'DRAFT – PERIOD NOT CLOSED';
  // Header/footer templates carry no charset: non-ASCII goes out as entities.
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[\u0080-\uffff]/g, (c) => `&#${c.charCodeAt(0)};`);
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    // Lay out at the printable width (Letter landscape less the @page margins in render.js) so the
    // fit measurement below matches the printed page.
    await page.setViewport({ width: PRINT_W_PX, height: PRINT_H_PX });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    await fitOnePage(page);
    // Every page carries the association, the statement, its status, the reporting period and
    // the page number (Ed 2026-10-13: a page separated from the package still says what it is).
    const bva = list.every((m) => m.kind === 'income_budget' && (m.columns || []).some((c) => c.is_var));
    const pe = (m0.period && (m0.period.period_end || m0.period.as_of)) || '';
    const period = pe ? `Month ended ${new Date(`${pe.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })}` : '';
    const band = 'font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#4A5468;width:100%;padding:0 0.45in;display:flex;justify-content:space-between;';
    return await page.pdf({
      format: 'Letter', landscape: true, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: `<div style="${band}"><span>${esc(m0.community.legal_name || m0.community.name)}${bva ? ` · ${esc(m0.title)}` : ''}</span><span style="letter-spacing:.1em;font-weight:bold;color:${m0.lifecycle && m0.lifecycle.status === 'closed' ? '#1F5F43' : '#8E2A22'};">${esc(life)}</span></div>`,
      footerTemplate: `<div style="${band}"><span>Prepared by Bedrock Association Management</span><span>${esc(period)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
  } finally { await browser.close(); }
}

module.exports = { xlsxBuffer, csvDetail, pdfBuffer, CSV_COLS, fitScale, PRINT_H_PX };
