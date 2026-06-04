// ============================================================================
// lib/reports/render_bedrock_drv.js
// ----------------------------------------------------------------------------
// Monthly DRV (Deed Restriction Violation) community newsletter summary.
// Single-page format — Ed 2026-06-04 directive. Compressed all spacing,
// type sizes, and card heights vs. the gold-standard reference so the
// whole artifact fits on one Letter page even with 6+ categories + 3
// message paragraphs + 3 bullets.
//
// Layout (one page, top to bottom):
//   - Centered header: community name + subtitle + month + navy rule
//   - "Month DRV Snapshot" — 4 light-blue compact cards
//   - "Top Violation Types — Month" — striped table
//   - "Message" — 3 short paragraphs
//   - "Top 3 Things to Watch This Month" — 3 bullets
// No footer (community-newsletter content, no Bedrock chrome).
// ============================================================================

const PDFDocument = require('pdfkit');

// Brand palette matched to Ed's gold-standard.
const NAVY        = '#1F3864';
const NAVY_DEEP   = '#0B1D34';
const NAVY_ITALIC = '#2E5395';
const LIGHT_BLUE  = '#DEEBF7';
const TABLE_HEAD  = '#1F3864';
const TEXT_DARK   = '#1A1A1A';
const TEXT_MID    = '#374151';

const s = (v, fallback = '') => {
  if (v == null) return fallback;
  const str = String(v);
  return str === 'undefined' || str === 'null' ? fallback : str;
};

// Strip legal-entity suffixes so the header reads "Lake of Pine Forest"
// instead of "Lake of Pine Forest Homeowners Association, Inc". Mirrors
// the helper in api/reports.js — duplicated here to keep the renderer
// self-contained and avoid a cross-module require at hot path.
function _shortCommunityName(name) {
  if (!name) return '';
  let v = String(name).trim();
  v = v.replace(/,?\s*(Inc|LLC|L\.L\.C\.|Corp|Corporation)\.?\s*$/i, '');
  v = v.replace(/\s+(Homeowners Association|Property Owners Association|Community Association)\s*$/i, '');
  v = v.replace(/\s+(HOA|POA|CA)\s*$/i, '');
  return v.replace(/\s+/g, ' ').trim();
}

function monthOnlyFromLabel(periodLabel) {
  if (!periodLabel) return '';
  const m = String(periodLabel).match(/^([A-Za-z]+)\s+\d{4}$/);
  return m ? m[1] : periodLabel;
}

async function renderBedrockDrvPdf(data) {
  return new Promise((resolve, reject) => {
    // Tight margins for one-page fit. Top/bottom 36pt (vs default 72)
    // gives us 720pt of usable vertical room on Letter.
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 36, bottom: 36, left: 54, right: 54 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const monthOnly = data.period_month_only || monthOnlyFromLabel(data.period_label) || '';

      // ===== Centered header (compact) =====
      // Strip legal suffixes so "Lake of Pine Forest Homeowners
      // Association, Inc" displays as "Lake of Pine Forest" — matches the
      // gold-standard's clean header.
      const headerName = _shortCommunityName(data.community_name) || s(data.community_name, '(Community)');
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(18)
         .text(headerName, 54, 36, { align: 'center', width: 504 });
      doc.fillColor(TEXT_MID).font('Helvetica').fontSize(11)
         .text('Community Update — Deed Restriction Violations (DRV)', 54, doc.y + 2, { align: 'center', width: 504 });
      doc.fillColor(NAVY_ITALIC).font('Helvetica-Oblique').fontSize(10)
         .text(s(data.period_label, ''), 54, doc.y + 2, { align: 'center', width: 504 });

      // Horizontal navy rule
      doc.save();
      doc.strokeColor(NAVY).lineWidth(1.2);
      const ruleY = doc.y + 6;
      doc.moveTo(54, ruleY).lineTo(558, ruleY).stroke();
      doc.restore();
      doc.y = ruleY + 8;

      // ===== Snapshot section =====
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(12)
         .text(`${monthOnly} DRV Snapshot`, 54, doc.y);

      const m = data.metrics || {};
      const cards = [
        { label: 'First Notices Issued',  value: m.first_notices_issued ?? 0 },
        { label: 'Second Notices Issued', value: m.second_notices_issued ?? 0 },
        { label: 'Violations Resolved',   value: m.violations_resolved ?? 0 },
        { label: 'Certified Letters Sent',value: m.certified_letters_sent ?? 0 },
      ];

      // Metric cards: compact 56pt tall, 22pt number, 8.5pt label.
      const cardsY = doc.y + 6;
      const cardW = 117;
      const gap = 12;
      const startX = 54 + ((504 - (cards.length * cardW + (cards.length - 1) * gap)) / 2);
      cards.forEach((c, i) => {
        const x = startX + i * (cardW + gap);
        doc.save();
        doc.roundedRect(x, cardsY, cardW, 56, 4).fill(LIGHT_BLUE);
        doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(22)
           .text(String(c.value), x + 6, cardsY + 8, { width: cardW - 12, align: 'center' });
        doc.fillColor(TEXT_MID).font('Helvetica').fontSize(8.5)
           .text(c.label, x + 6, cardsY + 38, { width: cardW - 12, align: 'center' });
        doc.restore();
      });
      doc.y = cardsY + 62;

      // ===== Top Violation Types table =====
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(12)
         .text(`Top Violation Types — ${monthOnly}`, 54, doc.y);

      const topCats = Array.isArray(data.top_categories) ? data.top_categories.slice(0, 8) : [];
      const tableX = 54;
      const tableW = 504;
      const colTypeW = 400;
      const colPctW = tableW - colTypeW;
      const rowH = 18;

      const tableTop = doc.y + 6;
      // Header row
      doc.save();
      doc.rect(tableX, tableTop, tableW, rowH).fill(TABLE_HEAD);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5)
         .text('Violation Type', tableX + 10, tableTop + 5, { width: colTypeW - 12 });
      doc.text('% of Total', tableX + colTypeW + 8, tableTop + 5, { width: colPctW - 12, align: 'center' });
      doc.restore();
      doc.y = tableTop + rowH;

      // Data rows — alternating tint
      for (let i = 0; i < topCats.length; i++) {
        const cat = topCats[i];
        const y0 = doc.y;
        if (i % 2 === 1) {
          doc.save();
          doc.rect(tableX, y0, tableW, rowH).fill(LIGHT_BLUE);
          doc.restore();
        }
        // Cell borders (subtle)
        doc.save();
        doc.strokeColor('#d9e2ef').lineWidth(0.4);
        doc.rect(tableX, y0, tableW, rowH).stroke();
        doc.moveTo(tableX + colTypeW, y0).lineTo(tableX + colTypeW, y0 + rowH).stroke();
        doc.restore();
        doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(9.5)
           .text(s(cat.category, '—'), tableX + 10, y0 + 5, { width: colTypeW - 16, height: rowH });
        doc.fillColor(NAVY_DEEP).font('Helvetica').fontSize(9.5)
           .text(`${cat.percentage ?? 0}%`, tableX + colTypeW + 8, y0 + 5, { width: colPctW - 16, align: 'center' });
        doc.y = y0 + rowH;
      }

      // ===== Message section =====
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(12)
         .text('Message', 54, doc.y + 10);
      doc.y += 4;
      const paragraphs = Array.isArray(data.message_paragraphs) ? data.message_paragraphs.filter(Boolean) : [];
      for (const p of paragraphs) {
        doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(10)
           .text(s(p), 54, doc.y, { width: 504, lineGap: 1.5 });
        doc.y += 4;  // small gap between paragraphs
      }

      // ===== Top 3 Things to Watch =====
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(12)
         .text('Top 3 Things to Watch This Month', 54, doc.y + 6);
      doc.y += 4;
      const items = Array.isArray(data.top_3_to_watch) ? data.top_3_to_watch.filter(Boolean) : [];
      for (const item of items) {
        const y0 = doc.y;
        doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(10)
           .text('•', 70, y0, { width: 8 });
        doc.text(s(item), 82, y0, { width: 476, lineGap: 1.5 });
        doc.y += 2;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderBedrockDrvPdf };
