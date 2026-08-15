// =============================================================================
// lib/bd/render.js — renders the BD card assets for any person on the roster
// =============================================================================
//
// Three artifacts, one source of truth (lib/bd/people.js):
//
//   scan.png   Full-screen QR on white. The image you open and hold out when
//              someone is scanning. Almost entirely QR by design.
//   card.png   The branded card with details visible. The one you text or
//              email to someone.
//   cards.pdf  Ten 3.5x2in cards on US Letter with crop marks, for actual paper.
//
// WHY THE QR CARRIES THE vCARD AND NOT A LINK
// -------------------------------------------
// A QR that encodes a URL needs the server up, the network reachable, and the
// page to load, at the exact moment someone is standing there waiting. A QR
// that encodes the vCard itself is decoded locally by the phone's camera: no
// server, no wifi, no signal, nothing to be down. At a conference that
// difference is the whole product, so the vCard is the default everywhere and
// the link is the alternate.
//
// WHAT DRIVES SCAN RELIABILITY (measured, not assumed)
// ----------------------------------------------------
// Screen pixels per QR module, far more than error-correction level. A large
// code at ECC M beat a smaller code at ECC H on every degradation tested
// (blur, glare, rotation, low light), because raising ECC adds modules and
// shrinks each one. Hence: short payload, ECC M, and the QR made as physically
// large as each surface allows. tests/test_bd_card.js locks the payload size.
//
// Rendering goes through puppeteer + HTML, matching how the rest of this
// codebase produces PDFs (see api/billing.js invoice render).
// =============================================================================

const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const { buildVCard, publicPerson } = require('./people');

const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const INK_SOFT = '#A8B2C4';
const INK_FAINT = '#7A869C';

// -----------------------------------------------------------------------------
// QR
// -----------------------------------------------------------------------------
// SVG so it stays crisp at any output size, and so the modules land on exact
// pixel boundaries when puppeteer rasterizes it. ECC M per the note above.
async function qrSvg(person) {
  return QRCode.toString(buildVCard(person, { scan: true }), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    color: { dark: NAVY, light: '#FFFFFF' },
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// The lockup ships as a file in public/brand-assets. Inlined as a data URI so
// the rendered page has no network dependency at all — puppeteer runs with
// setContent and would otherwise be racing a localhost fetch.
const fs = require('fs');
const path = require('path');
let _markCache = null;
function markDataUri() {
  if (_markCache) return _markCache;
  const p = path.join(__dirname, '..', '..', 'public', 'brand-assets',
    'bedrock-mark-email-2x.png');
  try {
    _markCache = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (err) {
    // A missing logo must not take the whole card down — the contact details
    // and the QR are what matter. Render without it and say so in the log.
    console.warn('[bd] brand mark not readable, rendering without it:', err.message);
    _markCache = '';
  }
  return _markCache;
}

// Shared font stack. Segoe UI exists on Windows dev machines; Render runs
// Linux, so the fallbacks matter and are listed explicitly rather than left to
// a bare sans-serif.
const FONT = "'Segoe UI', 'Helvetica Neue', Helvetica, 'DejaVu Sans', Arial, sans-serif";

// -----------------------------------------------------------------------------
// scan.png — the one held out for scanning
// -----------------------------------------------------------------------------
function scanHTML(p, svg) {
  const mark = markDataUri();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 1080px 1920px; margin: 0 }
    * { box-sizing: border-box }
    body { margin:0; width:1080px; height:1920px; background:#fff;
           font-family:${FONT}; display:flex; flex-direction:column;
           align-items:center; }
    .mark { width:300px; margin:90px 0 0 }
    .qr { width:980px; margin:60px 0 0 }
    .qr svg { width:100%; height:auto; display:block }
    .cap { margin-top:86px; font-size:38px; font-weight:700; letter-spacing:4px;
           color:${NAVY} }
    .nm { margin-top:34px; font-size:52px; font-weight:700; color:${NAVY} }
    .org { margin-top:14px; font-size:34px; color:#78828F }
  </style></head><body>
    ${mark ? `<img class="mark" src="${mark}" alt="">` : ''}
    <div class="qr">${svg}</div>
    <div class="cap">SCAN TO SAVE MY CONTACT</div>
    <div class="nm">${esc(p.displayName)}</div>
    <div class="org">${esc(p.orgShort || '')}</div>
  </body></html>`;
}

// -----------------------------------------------------------------------------
// card.png — the branded card with details visible
// -----------------------------------------------------------------------------
function cardHTML(p, svg) {
  const mark = markDataUri();
  const line = (label, val) => (val
    ? `<div class="ln"><span class="lbl">${esc(label)}</span> ${esc(val)}</div>`
    : '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 1080px 1920px; margin: 0 }
    * { box-sizing: border-box }
    body { margin:0; width:1080px; height:1920px; background:${NAVY};
           font-family:${FONT}; color:#fff; display:flex; flex-direction:column;
           align-items:center; text-align:center; }
    .frame { position:absolute; inset:26px; border:3px solid #2E425E;
             border-radius:34px; pointer-events:none }
    .mark { width:360px; margin:86px 0 0 }
    .nm { margin-top:64px; font-size:74px; font-weight:700; line-height:1.05 }
    .role { margin-top:22px; font-size:33px; color:${GOLD} }
    .role2 { margin-top:14px; font-size:29px; color:${INK_SOFT} }
    .panel { margin-top:48px; width:860px; background:#fff; border-radius:30px;
             padding:34px 34px 26px }
    .panel svg { width:740px; height:auto; display:block; margin:0 auto }
    .pcap { margin-top:30px; font-size:30px; font-weight:700; letter-spacing:3px;
            color:${NAVY} }
    .rows { margin-top:40px }
    .ln { font-size:34px; color:${INK_SOFT}; margin-top:14px }
    .ln:first-child { font-size:40px; font-weight:700; color:#fff; margin-top:0 }
    .lbl { color:${INK_FAINT} }
    .ln:first-child .lbl { color:${INK_SOFT} }
    /* margin-top:auto rather than absolute positioning. Absolute took the
       footer out of flow, so it printed straight through the email line as
       soon as a third phone number was added. Flow layout can't collide. */
    .foot { margin-top:auto; margin-bottom:58px; width:100% }
    .rule { width:300px; height:1px; background:#54441E; margin:0 auto 22px }
    .web { font-size:34px; font-weight:700; color:${GOLD} }
    .addr { margin-top:16px; font-size:24px; color:${INK_FAINT} }
  </style></head><body>
    <div class="frame"></div>
    ${mark ? `<img class="mark" src="${mark}" alt="">` : ''}
    <div class="nm">${esc(p.displayName)}</div>
    <div class="role">${esc(p.title || '')}${p.orgShort ? ' &middot; ' + esc(p.orgShort) : ''}</div>
    ${p.titleSecondary && p.orgSecondary
      ? `<div class="role2">${esc(p.titleSecondary)}, ${esc(p.orgSecondary)}</div>` : ''}
    <div class="panel">${svg}<div class="pcap">SCAN TO SAVE MY CONTACT</div></div>
    <div class="rows">
      ${line('Cell', p.phoneCell)}
      ${line('Direct', p.phoneDirect)}
      ${line('Office', p.phoneOffice)}
      ${p.email ? `<div class="ln">${esc(p.email)}</div>` : ''}
    </div>
    <div class="foot">
      <div class="rule"></div>
      <div class="web">${esc((p.websites[0] || {}).label || '')}</div>
      <div class="addr">${esc(p.addressLine1 || '')} &middot; ${esc(p.addressLine2 || '')}</div>
    </div>
  </body></html>`;
}

// -----------------------------------------------------------------------------
// cards.pdf — 10-up printable sheet
// -----------------------------------------------------------------------------
// The QR is sized to nearly the full 2in card height on purpose. At the 1.2in
// it started as, a printed card needed a close steady photo to read; enlarged,
// it reads from a casual snapshot. Crop marks sit in the sheet margins only so
// nothing prints across a card face.
function printSheetHTML(p, svg) {
  const one = `
    <div class="card">
      <div class="qbed">${svg}</div>
      <div class="txt">
        <div class="nm">${esc(p.displayName)}</div>
        <div class="role">${esc(p.title || '')}</div>
        <div class="org">${esc(p.orgShort || '')}</div>
        ${p.phoneCell ? `<div class="ph strong">C &nbsp;${esc(p.phoneCell)}</div>` : ''}
        ${p.phoneDirect ? `<div class="ph">D &nbsp;${esc(p.phoneDirect)}</div>` : ''}
        ${p.phoneOffice ? `<div class="ph">O &nbsp;${esc(p.phoneOffice)}</div>` : ''}
        <div class="em">${esc(p.email || '')}</div>
        <div class="web">${esc((p.websites[0] || {}).label || '')}</div>
        <div class="scan">SCAN TO SAVE MY CONTACT</div>
      </div>
    </div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0 }
    * { box-sizing: border-box }
    body { margin:0; width:8.5in; height:11in; font-family:${FONT};
           display:flex; align-items:center; justify-content:center }
    .sheet { width:7in; display:flex; flex-wrap:wrap }
    .card { width:3.5in; height:2in; background:${NAVY}; color:#fff;
            display:flex; align-items:center; padding:0.09in;
            border:0.5pt dashed #C8C8C8 }
    .qbed { background:#fff; border-radius:0.04in; padding:0.05in;
            line-height:0; flex:0 0 auto }
    .qbed svg { width:1.72in; height:1.72in; display:block }
    .txt { padding-left:0.14in; min-width:0 }
    .nm { font-size:12.5pt; font-weight:700; line-height:1.1 }
    .role { font-size:8pt; color:${GOLD}; margin-top:2pt }
    .org { font-size:7.5pt; color:${INK_SOFT} }
    .ph { font-size:7.5pt; color:${INK_SOFT}; margin-top:1.5pt }
    .ph.strong { font-size:9pt; font-weight:700; color:#fff; margin-top:5pt }
    .em { font-size:7pt; color:${INK_SOFT}; margin-top:3pt }
    .web { font-size:7pt; color:${GOLD} }
    .scan { font-size:5.5pt; font-weight:700; color:${INK_FAINT};
            letter-spacing:0.4pt; margin-top:5pt }
  </style></head><body><div class="sheet">${one.repeat(10)}</div></body></html>`;
}

// -----------------------------------------------------------------------------
// Puppeteer plumbing
// -----------------------------------------------------------------------------
// One browser launch per request, closed in a finally. Same flags the invoice
// renderer uses — --no-sandbox is required on Render's container.
async function withPage(html, width, height, fn) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    if (width && height) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
    }
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return await fn(page);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* swallow */ } }
  }
}

async function renderScanPng(person) {
  const p = publicPerson(person);
  const svg = await qrSvg(person);
  return withPage(scanHTML(p, svg), 1080, 1920,
    (page) => page.screenshot({ type: 'png' }));
}

async function renderCardPng(person) {
  const p = publicPerson(person);
  const svg = await qrSvg(person);
  return withPage(cardHTML(p, svg), 1080, 1920,
    (page) => page.screenshot({ type: 'png' }));
}

async function renderPrintPdf(person) {
  const p = publicPerson(person);
  const svg = await qrSvg(person);
  return withPage(printSheetHTML(p, svg), null, null, async (page) => Buffer.from(
    await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
    }),
  ));
}

module.exports = {
  qrSvg,
  renderScanPng,
  renderCardPng,
  renderPrintPdf,
  // exported for tests
  scanHTML,
  cardHTML,
  printSheetHTML,
};
