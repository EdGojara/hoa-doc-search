// ============================================================================
// lib/reports/render_bedrock_drv.js
// ----------------------------------------------------------------------------
// Render the monthly DRV (Deed Restriction Violation) community newsletter
// summary. Audience is homeowners — community content for the HOA's
// newsletter, no Bedrock lockup at the top. Matches Ed's gold-standard
// LOPF April 2026 layout exactly (2026-06-04).
//
// Layout (single page, may wrap to second):
//   - Centered header: community name (large navy) + subtitle + month
//     (italic indigo) + horizontal navy rule
//   - "Month DRV Snapshot" — 4 light-blue metric cards (enforcement-step
//     counts: 1st Notices / 2nd Notices / Resolved / Certified Letters)
//   - "Top Violation Types — Month" — table with navy header + light-blue
//     alternating rows + percentages
//   - "Message" — 3 short paragraphs in warm newsletter tone
//   - "Top 3 Things to Watch This Month" — bulleted action items
//
// Data structure expected:
//   {
//     community_name: string,
//     period_label: string,                  // "April 2026"
//     period_month_only: string | null,      // "April" — derived if absent
//     metrics: {
//       first_notices_issued: number,
//       second_notices_issued: number,
//       violations_resolved: number,
//       certified_letters_sent: number,
//     },
//     top_categories: [{ category: string, percentage: number }],
//     message_paragraphs: [p1, p2, p3],      // AI-generated, 3 paragraphs
//     top_3_to_watch: [string, string, string],
//   }
// ============================================================================

const PDFDocument = require('pdfkit');
const { drawFooter } = require('./bedrock_pdf_chrome');

// Brand palette matched to the gold-standard's visual identity.
const NAVY        = '#1F3864';   // header text, table header, rules
const NAVY_DEEP   = '#0B1D34';   // metric values, section headings
const NAVY_ITALIC = '#2E5395';   // italic month line
const LIGHT_BLUE  = '#DEEBF7';   // metric card bg + alt table rows
const TABLE_HEAD  = '#1F3864';   // table header background
const TEXT_DARK   = '#1A1A1A';
const TEXT_MID    = '#374151';
const TEXT_LIGHT  = '#6B7280';

const s = (v, fallback = '') => {
  if (v == null) return fallback;
  const str = String(v);
  return str === 'undefined' || str === 'null' ? fallback : str;
};

function monthOnlyFromLabel(periodLabel) {
  if (!periodLabel) return '';
  // "April 2026" -> "April"; falls through to original on unexpected shape.
  const m = String(periodLabel).match(/^([A-Za-z]+)\s+\d{4}$/);
  return m ? m[1] : periodLabel;
}

async function renderBedrockDrvPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const monthOnly = data.period_month_only || monthOnlyFromLabel(data.period_label) || '';

      // ===== Centered header =====
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(22)
         .text(s(data.community_name, '(Community)'), 54, 54, { align: 'center', width: 504 });
      doc.fillColor(TEXT_MID).font('Helvetica').fontSize(13)
         .text('Community Update — Deed Restriction Violations (DRV)', 54, doc.y + 4, { align: 'center', width: 504 });
      doc.fillColor(NAVY_ITALIC).font('Helvetica-Oblique').fontSize(12)
         .text(s(data.period_label, ''), 54, doc.y + 4, { align: 'center', width: 504 });

      // Horizontal navy rule
      doc.moveDown(0.6);
      doc.save();
      doc.strokeColor(NAVY).lineWidth(1.5);
      doc.moveTo(54, doc.y).lineTo(558, doc.y).stroke();
      doc.restore();

      // ===== Snapshot section =====
      doc.moveDown(0.8);
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(15)
         .text(`${monthOnly} DRV Snapshot`, 54, doc.y);
      doc.moveDown(0.5);

      const m = data.metrics || {};
      const cards = [
        { label: 'First Notices Issued',  value: m.first_notices_issued ?? 0 },
        { label: 'Second Notices Issued', value: m.second_notices_issued ?? 0 },
        { label: 'Violations Resolved',   value: m.violations_resolved ?? 0 },
        { label: 'Certified Letters Sent',value: m.certified_letters_sent ?? 0 },
      ];

      // Metric cards: light-blue bg, navy bold number on top, label below.
      const cardsY = doc.y;
      const cardW = 117;
      const gap = 12;
      const startX = 54 + ((504 - (cards.length * cardW + (cards.length - 1) * gap)) / 2);
      cards.forEach((c, i) => {
        const x = startX + i * (cardW + gap);
        doc.save();
        doc.roundedRect(x, cardsY, cardW, 70, 4).fill(LIGHT_BLUE);
        doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(28)
           .text(String(c.value), x + 6, cardsY + 12, { width: cardW - 12, align: 'center' });
        doc.fillColor(TEXT_MID).font('Helvetica').fontSize(9.5)
           .text(c.label, x + 6, cardsY + 48, { width: cardW - 12, align: 'center' });
        doc.restore();
      });
      doc.y = cardsY + 70;

      // ===== Top Violation Types table =====
      doc.moveDown(1.2);
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(15)
         .text(`Top Violation Types — ${monthOnly}`, 54, doc.y);
      doc.moveDown(0.4);

      const topCats = Array.isArray(data.top_categories) ? data.top_categories.slice(0, 8) : [];
      const tableX = 54;
      const tableW = 504;
      const colTypeW = 380;
      const colPctW = tableW - colTypeW;
      const rowH = 26;

      // Header row
      const headerY = doc.y;
      doc.save();
      doc.rect(tableX, headerY, tableW, rowH).fill(TABLE_HEAD);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
         .text('Violation Type', tableX + 12, headerY + 8, { width: colTypeW - 12 });
      doc.text('% of Total', tableX + colTypeW + 12, headerY + 8, { width: colPctW - 12, align: 'center' });
      doc.restore();
      doc.y = headerY + rowH;

      // Data rows — alternating light-blue tint
      doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(10.5);
      for (let i = 0; i < topCats.length; i++) {
        const cat = topCats[i];
        if (doc.y + rowH > 720) doc.addPage();
        const y0 = doc.y;
        if (i % 2 === 1) {
          // Light-blue tint on odd (1-indexed even) rows for striped look
          doc.save();
          doc.rect(tableX, y0, tableW, rowH).fill(LIGHT_BLUE);
          doc.restore();
        }
        // Cell borders (subtle)
        doc.save();
        doc.strokeColor('#d9e2ef').lineWidth(0.5);
        doc.rect(tableX, y0, tableW, rowH).stroke();
        doc.moveTo(tableX + colTypeW, y0).lineTo(tableX + colTypeW, y0 + rowH).stroke();
        doc.restore();
        doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(10.5)
           .text(s(cat.category, '—'), tableX + 12, y0 + 8, { width: colTypeW - 18, height: rowH });
        doc.fillColor(NAVY_DEEP).font('Helvetica').fontSize(10.5)
           .text(`${cat.percentage ?? 0}%`, tableX + colTypeW + 12, y0 + 8, { width: colPctW - 18, align: 'center' });
        doc.y = y0 + rowH;
      }

      // ===== Message section =====
      doc.moveDown(1.2);
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(15)
         .text('Message', 54, doc.y);
      doc.moveDown(0.4);
      doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(11);
      const paragraphs = Array.isArray(data.message_paragraphs) ? data.message_paragraphs.filter(Boolean) : [];
      for (const p of paragraphs) {
        if (doc.y > 700) doc.addPage();
        doc.text(s(p), 54, doc.y, { width: 504, lineGap: 2 });
        doc.moveDown(0.6);
      }

      // ===== Top 3 Things to Watch =====
      if (doc.y + 100 > 720) doc.addPage();
      doc.moveDown(0.6);
      doc.fillColor(NAVY_DEEP).font('Helvetica-Bold').fontSize(15)
         .text('Top 3 Things to Watch This Month', 54, doc.y);
      doc.moveDown(0.4);
      doc.fillColor(TEXT_DARK).font('Helvetica').fontSize(11);
      const items = Array.isArray(data.top_3_to_watch) ? data.top_3_to_watch.filter(Boolean) : [];
      for (const item of items) {
        if (doc.y > 720) doc.addPage();
        // Bullet + text
        const y0 = doc.y;
        doc.text('•', 72, y0, { width: 10 });
        doc.text(s(item), 86, y0, { width: 472, lineGap: 2 });
        doc.moveDown(0.4);
      }

      drawFooter(doc, { serviceName: 'Bedrock Association Management' });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderBedrockDrvPdf };
