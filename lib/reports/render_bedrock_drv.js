// ============================================================================
// lib/reports/render_bedrock_drv.js
// ----------------------------------------------------------------------------
// Render a Bedrock-branded monthly DRV summary PDF from the structured
// data extracted from a Vantaca source. Brand-the-output rule per Ed's
// memory (feedback_brand_the_output.md): every customer-facing artifact
// is Bedrock-rendered, never a forwarded vendor PDF.
//
// Page 1: header + community + period + summary metrics + category
//         breakdown.
// Page 2+: violation log table — one row per violation with property,
//          owner, type, status, dates, next action.
// ============================================================================

const PDFDocument = require('pdfkit');
const { drawHeader, drawFooter, fmtCentralDate } = require('./bedrock_pdf_chrome');

// Status -> color mapping for the visual indicator at each row.
const STATUS_COLOR = {
  open:           { fg: '#7f1d1d', bg: '#fee2e2', label: 'Open' },
  closed:         { fg: '#14532d', bg: '#dcfce7', label: 'Closed' },
  resolved:       { fg: '#14532d', bg: '#dcfce7', label: 'Resolved' },
  courtesy:       { fg: '#1e3a8a', bg: '#dbeafe', label: 'Courtesy' },
  first_notice:   { fg: '#78350f', bg: '#fef3c7', label: '1st Notice' },
  second_notice:  { fg: '#92400e', bg: '#fed7aa', label: '2nd Notice' },
  fine_pending:   { fg: '#581c87', bg: '#ede9fe', label: 'Fine Pending' },
  fine_assessed:  { fg: '#581c87', bg: '#e9d5ff', label: 'Fine Assessed' },
  unknown:        { fg: '#374151', bg: '#f3f4f6', label: 'Unknown' },
};

const s = (v, fallback = '') => {
  if (v == null) return fallback;
  const str = String(v);
  return str === 'undefined' || str === 'null' ? fallback : str;
};

async function renderBedrockDrvPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // ----- Page 1 header + title -----
      drawHeader(doc);

      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(20)
         .text(s(data.community_name, '(Community)'), 54, 140, { align: 'center', width: 504 });
      doc.fillColor('#374151').font('Helvetica').fontSize(13)
         .text('Deed Restriction Violation Summary', 54, doc.y + 4, { align: 'center', width: 504 });
      doc.fillColor('#6b7280').font('Helvetica-Oblique').fontSize(11)
         .text(s(data.period_label, ''), 54, doc.y + 4, { align: 'center', width: 504 });

      // ----- Summary cards -----
      doc.moveDown(1.5);
      const cardsY = doc.y;
      const cards = [
        { label: 'Total Violations', value: data.summary?.total_violations ?? '—', color: '#0B1D34' },
        { label: 'Open',             value: data.summary?.open_count       ?? '—', color: '#b91c1c' },
        { label: 'Closed',           value: data.summary?.closed_count     ?? '—', color: '#15803d' },
        { label: 'New This Period',  value: data.summary?.new_this_period  ?? '—', color: '#6d28d9' },
      ];
      const cardW = 116;
      const gap = 12;
      const startX = 54 + ((504 - (cards.length * cardW + (cards.length - 1) * gap)) / 2);
      cards.forEach((c, i) => {
        const x = startX + i * (cardW + gap);
        doc.save();
        doc.roundedRect(x, cardsY, cardW, 60, 6).fillAndStroke('#f9fafb', '#e5e7eb');
        doc.fillColor('#6b7280').font('Helvetica').fontSize(8.5)
           .text(c.label, x + 10, cardsY + 9, { width: cardW - 20, align: 'center' });
        doc.fillColor(c.color).font('Helvetica-Bold').fontSize(22)
           .text(String(c.value), x + 10, cardsY + 24, { width: cardW - 20, align: 'center' });
        doc.restore();
      });
      doc.y = cardsY + 60;

      // ----- Category breakdown -----
      if (Array.isArray(data.by_category) && data.by_category.length > 0) {
        doc.moveDown(1.2);
        doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(12).text('Breakdown by Category', 54, doc.y);
        doc.moveDown(0.4);
        doc.fillColor('#1a1a1a').font('Helvetica').fontSize(10);
        const colW = 252;
        let catX = 54;
        let catY = doc.y;
        const maxCount = Math.max(...data.by_category.map((c) => c.count || 0), 1);
        for (let i = 0; i < data.by_category.length; i++) {
          const c = data.by_category[i];
          if (catY > 660) { catY = doc.y; catX = 54 + colW + 16; } // wrap to 2nd column
          // Row: category label + bar + count
          doc.fillColor('#374151').font('Helvetica').fontSize(9.5)
             .text(s(c.category, ''), catX, catY, { width: colW - 50 });
          const barWidth = ((c.count || 0) / maxCount) * 60;
          doc.save();
          doc.roundedRect(catX + colW - 75, catY + 1, 60, 9, 2).fillAndStroke('#f3f4f6', '#e5e7eb');
          if (barWidth > 0) {
            doc.roundedRect(catX + colW - 75, catY + 1, barWidth, 9, 2).fill('#6d28d9');
          }
          doc.restore();
          doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(9.5)
             .text(String(c.count || 0), catX + colW - 12, catY, { width: 20, align: 'right' });
          catY += 16;
        }
        doc.y = Math.max(doc.y, catY) + 4;
      }

      // ----- Violation log -----
      // Soft break: only addPage if the table won't fit; otherwise continue.
      const TABLE_HEADER_HEIGHT = 50;
      const MIN_ROWS = 6;
      const ROW_HEIGHT = 18;
      const tableMinHeight = TABLE_HEADER_HEIGHT + (MIN_ROWS * ROW_HEIGHT);
      if (doc.y + tableMinHeight > 720) doc.addPage();
      else doc.moveDown(1.2);

      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(13)
         .text('Violation Log', 54, doc.y);
      doc.fillColor('#7a7a7a').font('Helvetica').fontSize(9)
         .text(`Per-property detail (${(data.violations || []).length} entries).`, 54, doc.y + 2);
      doc.moveDown(0.7);

      // Column layout: address (170), type (130), status (75), opened (60), next action (rest)
      const colX = { addr: 54, type: 230, status: 365, opened: 445, next: 510 };
      const colWidths = { addr: 172, type: 130, status: 76, opened: 62, next: 96 };

      // Header row
      const headerY = doc.y;
      doc.fillColor('#f3f4f6');
      doc.rect(54, headerY - 2, 504, 18).fill();
      doc.fillColor('#374151').font('Helvetica-Bold').fontSize(8.5);
      doc.text('PROPERTY', colX.addr, headerY + 3, { width: colWidths.addr });
      doc.text('VIOLATION', colX.type, headerY + 3, { width: colWidths.type });
      doc.text('STATUS',    colX.status, headerY + 3, { width: colWidths.status });
      doc.text('OPENED',    colX.opened, headerY + 3, { width: colWidths.opened });
      doc.text('NEXT',      colX.next,   headerY + 3, { width: colWidths.next });
      doc.y = headerY + 22;
      doc.fillColor('#1a1a1a').font('Helvetica').fontSize(8.5);

      const violations = Array.isArray(data.violations) ? data.violations : [];
      for (let i = 0; i < violations.length; i++) {
        const v = violations[i];
        try {
          if (doc.y + ROW_HEIGHT > 720) doc.addPage();
          const y0 = doc.y;
          // Alternating row tint for readability
          if (i % 2 === 0) {
            doc.save().fillColor('#fafafa');
            doc.rect(54, y0 - 2, 504, ROW_HEIGHT).fill();
            doc.restore();
          }
          doc.fillColor('#1a1a1a').font('Helvetica').fontSize(8.5);
          doc.text(s(v.property_address, '—'), colX.addr, y0, { width: colWidths.addr, height: ROW_HEIGHT });
          doc.text(s(v.violation_type, '—'), colX.type, y0, { width: colWidths.type, height: ROW_HEIGHT });

          // Status pill
          const statusKey = (v.status || 'unknown').toLowerCase();
          const sc = STATUS_COLOR[statusKey] || STATUS_COLOR.unknown;
          doc.save();
          doc.roundedRect(colX.status, y0 - 1, colWidths.status - 4, 12, 6).fill(sc.bg);
          doc.fillColor(sc.fg).font('Helvetica-Bold').fontSize(7)
             .text(sc.label, colX.status, y0 + 1, { width: colWidths.status - 4, align: 'center' });
          doc.restore();

          doc.fillColor('#374151').font('Helvetica').fontSize(8);
          doc.text(fmtCentralDate(v.date_opened) || '—', colX.opened, y0, { width: colWidths.opened, height: ROW_HEIGHT });
          doc.text(s(v.next_action, '—'), colX.next, y0, { width: colWidths.next, height: ROW_HEIGHT });
          doc.y = y0 + ROW_HEIGHT;
        } catch (rowErr) {
          console.warn(`[render_bedrock_drv] row ${i} render failed:`, rowErr?.message);
        }
      }

      if (violations.length === 0) {
        doc.fillColor('#6b7280').font('Helvetica-Oblique').fontSize(10)
           .text('No violations in this period.', 54, doc.y + 6, { align: 'center', width: 504 });
      }

      // Footer on every page
      drawFooter(doc, { serviceName: 'Bedrock Association Management' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderBedrockDrvPdf };
