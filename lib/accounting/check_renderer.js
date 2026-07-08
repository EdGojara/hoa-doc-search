// ============================================================================
// check_renderer.js — render AP checks for BLANK check stock (check-on-top)
// ----------------------------------------------------------------------------
// trustEd prints the ENTIRE check onto blank security stock: payee, date,
// numeric + written amount, memo, signature, and the MICR line at the bottom
// (routing + account + check number in E-13B). Blank stock is the right choice
// for Bedrock because there's a separate bank account per community — one paper
// supply, software prints the correct community's MICR per check.
//
// CATASTROPHIC-OUTPUT SURFACE. A wrong amount-in-words line, a transposed MICR
// digit, or a duplicated check number is a bank-rejection / fraud event. The
// number-to-words converter is unit-tested; the check number comes from the
// race-safe reserve_next_check_number() sequencer; the check_register enforces
// UNIQUE(bank_account, check#).
//
// MICR FONT: the .micr line uses the E-13B font family. The actual E-13B font
// file must be installed at public/fonts/ and the bank must confirm it accepts
// laser-printed MICR (most do, via image clearing) BEFORE live printing. Until
// then renderChecksPDF stamps a NON-NEGOTIABLE watermark so a draft can't be
// mistaken for a live check. See markReadyForPrint().
// ============================================================================

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', ' Thousand', ' Million', ' Billion'];

function threeDigitsToWords(n) {
  let out = '';
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) out += ONES[h] + ' Hundred';
  if (rest) {
    if (out) out += ' ';
    if (rest < 20) out += ONES[rest];
    else {
      out += TENS[Math.floor(rest / 10)];
      if (rest % 10) out += '-' + ONES[rest % 10];
    }
  }
  return out;
}

// Integer dollars -> English words. "Four Hundred Seventy-Six"
function dollarsToWords(dollars) {
  if (dollars === 0) return 'Zero';
  const groups = [];
  let n = dollars;
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  let out = '';
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    out += (out ? ' ' : '') + threeDigitsToWords(groups[i]) + SCALES[i];
  }
  return out;
}

// The legal amount line: "Four Hundred Seventy-Six and 30/100"
function amountToWords(cents) {
  if (!Number.isFinite(cents) || cents < 0) throw new Error('amountToWords: cents must be a non-negative number');
  const dollars = Math.floor(cents / 100);
  const c = cents % 100;
  return `${dollarsToWords(dollars)} and ${String(c).padStart(2, '0')}/100`;
}

function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateLong(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// E-13B symbols (the .micr font maps these to the magnetic glyphs):
//   ⑆ transit (brackets the routing #)   ⑈ on-us (account / aux check #)
// Business-check field order, left to right:
//   [aux on-us: check#]  [transit: routing]  [on-us: account]
function formatMicr({ routing, account, checkNumber }) {
  const r = String(routing || '').replace(/\D/g, '');
  const a = String(account || '').replace(/\D/g, '');
  const c = String(checkNumber || '').replace(/\D/g, '');
  // E-13B: ⑆ transit (routing), ⑈ on-us (aux check# + account)
  // [aux on-us: check#]  [transit: routing]  [on-us: account]
  return `⑈${c}⑈ ⑆${r}⑆ ${a}⑈`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// ----------------------------------------------------------------------------
// One check = check-on-top + a remittance advice listing the invoices paid.
//   check: {
//     check_number, issue_date, amount_cents, memo,
//     payee_name, payee_address_lines: [..],
//     invoices: [{ invoice_number, invoice_date, description, amount_cents }],
//   }
//   bankConfig: {
//     account_name, bank_name, routing, account_number, company_address_lines: [..],
//     signature_image_data_url?, signature_image_data_url_secondary?,
//     dual_sig_threshold_cents?, ready_for_print (bool),
//   }
// ----------------------------------------------------------------------------
function renderOneCheck(check, bankConfig) {
  const amt = check.amount_cents;
  const words = amountToWords(amt);
  const micr = formatMicr({ routing: bankConfig.routing, account: bankConfig.account_number, checkNumber: check.check_number });
  const dual = bankConfig.dual_sig_threshold_cents != null && amt >= bankConfig.dual_sig_threshold_cents;

  const sig = (url) => url
    ? `<img class="sigimg" src="${esc(url)}" alt="" />`
    : '';

  const payeeAddr = (check.payee_address_lines || []).filter(Boolean).map((l) => esc(l)).join('<br>');
  const coAddr = (bankConfig.company_address_lines || []).filter(Boolean).map((l) => esc(l)).join('<br>');

  const invRows = (check.invoices || []).map((iv) => `
    <tr>
      <td>${esc(iv.invoice_number || '')}</td>
      <td>${esc(fmtDateLong(iv.invoice_date))}</td>
      <td>${esc(iv.description || '')}</td>
      <td class="r">${fmtMoney(iv.amount_cents)}</td>
    </tr>`).join('');

  const stub = (label) => `
    <div class="stub">
      <div class="stub-head">
        <div><b>${esc(bankConfig.account_name || '')}</b><div class="muted">${label}</div></div>
        <div class="r"><div>Check #${esc(check.check_number)}</div><div>${esc(fmtDateLong(check.issue_date))}</div></div>
      </div>
      <div class="stub-payee">${esc(check.payee_name)}</div>
      <table class="inv"><thead><tr><th>Invoice</th><th>Date</th><th>Description</th><th class="r">Amount</th></tr></thead>
        <tbody>${invRows || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody>
        <tfoot><tr><td colspan="3" class="r"><b>Total paid</b></td><td class="r"><b>${fmtMoney(amt)}</b></td></tr></tfoot>
      </table>
    </div>`;

  return `
  <div class="page">
    ${bankConfig.ready_for_print ? '' : '<div class="void-wm">NON-NEGOTIABLE&nbsp;·&nbsp;DRAFT</div>'}
    <!-- ===== CHECK (top 3.5in) ===== -->
    <div class="check">
      <div class="ck-top">
        <div class="ck-co">
          <div class="co-name">${esc(bankConfig.account_name || '')}</div>
          <div class="muted">${coAddr}</div>
        </div>
        <div class="ck-meta">
          <div class="ck-num">${esc(check.check_number)}</div>
          <div class="bankname muted">${esc(bankConfig.bank_name || '')}</div>
          <div class="dateline"><span class="lbl">Date</span> ${esc(fmtDateLong(check.issue_date))}</div>
        </div>
      </div>

      <div class="ck-pay">
        <div class="pay-to">
          <span class="lbl">Pay to the<br>order of</span>
          <span class="payee">${esc(check.payee_name)}</span>
        </div>
        <div class="amt-box">${fmtMoney(amt)}<span class="cents-star">*</span></div>
      </div>

      <div class="ck-words">${esc(words)} <span class="dollars">DOLLARS</span><span class="fill"></span></div>

      <div class="ck-bottom">
        <div class="ck-addr">${esc(check.payee_name)}<br>${payeeAddr}</div>
        <div class="ck-sig">
          <div class="sigblock">${sig(bankConfig.signature_image_data_url)}<div class="sigline">Authorized Signature</div></div>
          ${dual ? `<div class="sigblock">${sig(bankConfig.signature_image_data_url_secondary)}<div class="sigline">Second Signature (required ≥ ${fmtMoney(bankConfig.dual_sig_threshold_cents)})</div></div>` : ''}
        </div>
      </div>

      <div class="ck-memo"><span class="lbl">Memo</span> ${esc(check.memo || '')}</div>
      <div class="micr">${esc(micr)}</div>
    </div>

    ${stub('Remittance advice — retain for your records')}
    ${stub('Remittance advice — payer copy')}
  </div>`;
}

const PAGE_CSS = `
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111; }
  .page { position: relative; width: 8.5in; height: 11in; padding: 0; page-break-after: always; }
  .muted { color: #555; font-size: 9pt; }
  .lbl { font-size: 7pt; color: #777; text-transform: uppercase; letter-spacing: .04em; }
  .r { text-align: right; }
  /* MICR E-13B — @font-face is injected dynamically (embedded) by micrFontFaceCss(). */
  .micr { font-family: 'MICR', 'Courier New', monospace; font-size: 16pt; letter-spacing: 2px;
          position: absolute; left: .55in; bottom: .18in; }
  .void-wm { position: absolute; top: 1.3in; left: 0; right: 0; text-align: center; transform: rotate(-18deg);
             font-size: 54pt; font-weight: 800; color: rgba(190,0,0,.18); letter-spacing: 6px; pointer-events: none; }

  .check { position: relative; height: 3.5in; padding: .35in .55in .2in; border-bottom: 1px dashed #bbb; }
  .ck-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .co-name { font-size: 12pt; font-weight: 700; }
  .ck-meta { text-align: right; }
  .ck-num { font-size: 13pt; font-weight: 700; }
  .dateline { margin-top: 18px; font-size: 10pt; }
  .ck-pay { display: flex; align-items: flex-end; gap: 14px; margin-top: .5in; }
  .pay-to { flex: 1; display: flex; align-items: flex-end; gap: 10px; border-bottom: 1px solid #111; padding-bottom: 2px; }
  .payee { font-size: 12pt; font-weight: 600; }
  .amt-box { min-width: 1.6in; text-align: right; font-size: 13pt; font-weight: 700; border: 1px solid #111; padding: 4px 10px; }
  .cents-star { color: #999; }
  .ck-words { margin-top: 16px; font-size: 11pt; border-bottom: 1px solid #111; padding-bottom: 3px; display: flex; align-items: baseline; }
  .ck-words .dollars { margin-left: 8px; font-weight: 700; }
  .ck-words .fill { flex: 1; border-bottom: 0; }
  .ck-bottom { display: flex; justify-content: space-between; align-items: flex-end; margin-top: .35in; }
  .ck-addr { font-size: 9.5pt; line-height: 1.3; }
  .ck-sig { display: flex; gap: 24px; }
  .sigblock { width: 2.2in; text-align: center; }
  .sigimg { max-height: .4in; max-width: 2in; display: block; margin: 0 auto -2px; }
  .sigline { border-top: 1px solid #111; padding-top: 2px; font-size: 8pt; color: #555; }
  .ck-memo { position: absolute; left: .55in; bottom: .5in; font-size: 9.5pt; }

  .stub { height: 3.55in; padding: .3in .55in; border-bottom: 1px dashed #bbb; }
  .stub:last-child { border-bottom: none; }
  .stub-head { display: flex; justify-content: space-between; align-items: flex-start; }
  .stub-payee { margin: 8px 0; font-weight: 600; }
  table.inv { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  table.inv th { text-align: left; border-bottom: 1px solid #888; padding: 3px 6px; font-size: 8pt; color: #555; text-transform: uppercase; }
  table.inv td { padding: 3px 6px; border-bottom: 1px solid #eee; }
  table.inv tfoot td { border-top: 1px solid #111; border-bottom: none; padding-top: 5px; }
`;

// Build the @font-face for the MICR line. puppeteer renders via setContent (no
// host), so a URL to /fonts won't resolve — the font MUST be embedded. Reads a
// bundled E-13B font from public/fonts and inlines it as a data-URI. If none is
// bundled, falls back to any OS-installed MICR font (won't exist on Render) then
// monospace — which is NOT magnetically valid, so checks must not go live until
// a real font is bundled. See micrFontInstalled().
const _fontFs = require('fs');
const _fontPath = require('path');
let _micrFaceCache = null;
function micrFontFaceCss() {
  if (_micrFaceCache !== null) return _micrFaceCache;
  const dir = _fontPath.join(__dirname, '..', '..', 'public', 'fonts');
  for (const [f, mime] of [['micr.woff2', 'font/woff2'], ['micr.ttf', 'font/truetype'], ['MICR.ttf', 'font/truetype']]) {
    try {
      const p = _fontPath.join(dir, f);
      if (_fontFs.existsSync(p)) {
        const b64 = _fontFs.readFileSync(p).toString('base64');
        _micrFaceCache = `@font-face{font-family:'MICR';src:url(data:${mime};base64,${b64});}`;
        return _micrFaceCache;
      }
    } catch (_) { /* keep trying */ }
  }
  _micrFaceCache = `@font-face{font-family:'MICR';src:local('MICR Encoding'),local('GnuMICR'),local('MICRE13B');}`;
  return _micrFaceCache;
}
function micrFontInstalled() {
  const dir = _fontPath.join(__dirname, '..', '..', 'public', 'fonts');
  return ['micr.woff2', 'micr.ttf', 'MICR.ttf'].some((f) => { try { return _fontFs.existsSync(_fontPath.join(dir, f)); } catch (_) { return false; } });
}

function renderChecksHTML(checks, bankConfig) {
  const pages = (checks || []).map((c) => renderOneCheck(c, bankConfig)).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${micrFontFaceCss()}${PAGE_CSS}</style></head><body>${pages}</body></html>`;
}

// HTML -> PDF buffer via puppeteer (same launch flags as the other renderers).
async function renderChecksPDF(checks, bankConfig) {
  const puppeteer = require('puppeteer');
  const html = renderChecksHTML(checks, bankConfig);
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { amountToWords, dollarsToWords, formatMicr, renderChecksHTML, renderChecksPDF, micrFontInstalled };
