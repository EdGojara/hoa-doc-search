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
    ws['!cols'] = [{ wch: 46 }, ...m.columns.map(() => ({ wch: 16 }))];
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

async function pdfBuffer(models, { title } = {}) {
  const puppeteer = require('puppeteer');
  const html = renderDocument(models, { title });
  const list = Array.isArray(models) ? models : [models];
  const m0 = list[0];
  const life = m0.lifecycle && m0.lifecycle.status === 'closed' ? m0.lifecycle.label : 'DRAFT – PERIOD NOT CLOSED';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    return await page.pdf({
      format: 'Letter', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;color:#7B8394;width:100%;padding:0 0.55in;display:flex;justify-content:space-between;"><span>${esc(m0.community.legal_name || m0.community.name)}</span><span style="letter-spacing:.12em;color:${m0.lifecycle && m0.lifecycle.status === 'closed' ? '#1F5F43' : '#8E2A22'};">${esc(life)}</span></div>`,
      footerTemplate: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;color:#7B8394;width:100%;padding:0 0.55in;display:flex;justify-content:space-between;"><span>Prepared by Bedrock Association Management from trustEd</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
  } finally { await browser.close(); }
}

module.exports = { xlsxBuffer, csvDetail, pdfBuffer, CSV_COLS };
