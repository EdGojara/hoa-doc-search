// ============================================================================
// lib/reports/bedrock_pdf_chrome.js
// ----------------------------------------------------------------------------
// Shared PDFKit chrome (brand mark, header lockup, footer, Central-time
// formatters) for every Bedrock-rendered customer-facing PDF. Extracted
// 2026-06-04 when the Reports module needed the same lockup as the
// meeting-checkin quorum-evidence PDF. One canonical implementation =
// one place to update when the brand evolves.
// ============================================================================

const path = require('path');
const fs = require('fs');

const BEDROCK_MARK_PATH = path.join(__dirname, '..', '..', 'public', 'brand-assets', 'bedrock-mark-email-2x.png');

// Render the Bedrock master mark at the given coordinates. Gracefully
// no-ops if the file is missing so a missing asset doesn't crash the
// whole PDF render. Caller is responsible for any text alongside it.
function drawBedrockMark(doc, x, y, h, opts = {}) {
  try {
    if (!fs.existsSync(BEDROCK_MARK_PATH)) {
      console.warn('[bedrock_pdf_chrome] brand mark missing at:', BEDROCK_MARK_PATH);
      return;
    }
    doc.image(BEDROCK_MARK_PATH, x, y, { height: h });
  } catch (e) {
    console.warn('[bedrock_pdf_chrome] mark draw failed:', e?.message, opts);
  }
}

// Draw the canonical Bedrock header: lockup at top-left + small subtitle
// under it identifying the service brand. Called by every Bedrock-
// rendered customer-facing PDF for consistency.
function drawHeader(doc, opts = {}) {
  const { subtitle = 'Association Management  ·  Community. Simplified.' } = opts;
  drawBedrockMark(doc, 54, 48, 40);
  doc.font('Helvetica').fontSize(8).fillColor('#7a7a7a')
     .text(subtitle, 54, 96, { width: 280 });
}

// Central-time formatters — server runs UTC on Render, anything that
// hits toLocaleString() unqualified is 5-6 hours off. Per CLAUDE.md
// timezone rule, format-on-display in America/Chicago.
function fmtCentralTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    });
  } catch (_) { return ''; }
}

function fmtCentralDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Chicago',
    });
  } catch (_) { return ''; }
}

function fmtCentralDateTime(d) {
  try {
    return d.toLocaleString('en-US', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago',
    }) + ' CT';
  } catch (_) { return d.toISOString(); }
}

// Render the canonical Bedrock footer on every page. Called from a
// bufferPages walk after the body content is laid out. Sets generated
// timestamp + page X of Y + service brand line. Always Central time.
function drawFooter(doc, opts = {}) {
  const {
    serviceName = 'Bedrock Association Management',
    platformLabel = 'trustEd platform',
    pageWidth = 612,
    leftMargin = 54,
  } = opts;
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc.font('Helvetica').fontSize(7).fillColor('#bbb')
       .text(
         `Generated ${fmtCentralDateTime(new Date())} by ${serviceName} · ${platformLabel} · page ${i + 1} of ${pages.count}`,
         leftMargin, 760,
         { align: 'center', width: pageWidth - (leftMargin * 2) }
       );
  }
}

module.exports = {
  drawBedrockMark,
  drawHeader,
  drawFooter,
  fmtCentralTime,
  fmtCentralDate,
  fmtCentralDateTime,
  BEDROCK_MARK_PATH,
};
