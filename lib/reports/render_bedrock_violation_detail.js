// ============================================================================
// lib/reports/render_bedrock_violation_detail.js
// ----------------------------------------------------------------------------
// Render a Bedrock-branded single-violation case record PDF. Used for the
// individual violation detail / drilldown view (the "Violation (7).pdf"
// Ed sent 2026-06-04 was the source example). One property, one
// violation, full enforcement timeline.
//
// Layout:
//   Page 1: header + property/owner block + violation summary card +
//           status banner + dates + cure deadline + notes.
//   Page 2+: enforcement action timeline (chronological).
// ============================================================================

const PDFDocument = require('pdfkit');
const { drawHeader, drawFooter, fmtCentralDate } = require('./bedrock_pdf_chrome');

const STATUS_COLOR = {
  open:              { fg: '#7f1d1d', bg: '#fee2e2', border: '#b91c1c', label: 'Open' },
  closed:            { fg: '#14532d', bg: '#dcfce7', border: '#15803d', label: 'Closed' },
  resolved:          { fg: '#14532d', bg: '#dcfce7', border: '#15803d', label: 'Resolved' },
  courtesy:          { fg: '#1e3a8a', bg: '#dbeafe', border: '#1e3a8a', label: 'Courtesy' },
  first_notice:      { fg: '#78350f', bg: '#fef3c7', border: '#b45309', label: '1st Notice' },
  second_notice:     { fg: '#92400e', bg: '#fed7aa', border: '#c2410c', label: '2nd Notice' },
  fine_pending:      { fg: '#581c87', bg: '#ede9fe', border: '#6d28d9', label: 'Fine Pending' },
  fine_assessed:     { fg: '#581c87', bg: '#e9d5ff', border: '#7e22ce', label: 'Fine Assessed' },
  hearing_scheduled: { fg: '#0c4a6e', bg: '#cffafe', border: '#0e7490', label: 'Hearing Scheduled' },
  hearing_held:      { fg: '#0c4a6e', bg: '#bae6fd', border: '#0369a1', label: 'Hearing Held' },
  unknown:           { fg: '#374151', bg: '#f3f4f6', border: '#9ca3af', label: 'Unknown' },
};

const ACTION_LABELS = {
  inspection:         'Inspection',
  courtesy_notice:    'Courtesy Notice',
  first_notice:       'First Notice',
  second_notice:      'Second Notice',
  fine_assessed:      'Fine Assessed',
  hearing_scheduled:  'Hearing Scheduled',
  hearing_held:       'Hearing Held',
  homeowner_contact:  'Homeowner Contact',
  photo_documented:   'Photo Documented',
  resolved:           'Resolved',
  note_added:         'Note Added',
  other:              'Action',
};

const s = (v, fallback = '') => {
  if (v == null) return fallback;
  const str = String(v);
  return str === 'undefined' || str === 'null' ? fallback : str;
};

async function renderBedrockViolationDetailPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // ----- Page 1 -----
      drawHeader(doc);

      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(20)
         .text(s(data.community_name, '(Community)'), 54, 140, { align: 'center', width: 504 });
      doc.fillColor('#374151').font('Helvetica').fontSize(13)
         .text('Violation Case Record', 54, doc.y + 4, { align: 'center', width: 504 });
      if (data.violation_type) {
        doc.fillColor('#6b7280').font('Helvetica-Oblique').fontSize(11)
           .text(s(data.violation_type), 54, doc.y + 4, { align: 'center', width: 504 });
      }

      // Status banner
      doc.moveDown(1.2);
      const statusKey = (data.current_status || 'unknown').toLowerCase();
      const sc = STATUS_COLOR[statusKey] || STATUS_COLOR.unknown;
      const bannerY = doc.y;
      doc.save();
      doc.roundedRect(54, bannerY, 504, 36, 6).fillAndStroke(sc.bg, sc.border);
      doc.fillColor(sc.fg).font('Helvetica-Bold').fontSize(13)
         .text(`Current Status: ${sc.label}`, 54, bannerY + 11, { width: 504, align: 'center' });
      doc.restore();
      doc.y = bannerY + 46;

      // Two-column property + owner block
      const colY = doc.y;
      const leftX = 54, rightX = 311;
      const colW = 247;

      // Property column
      doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(9).text('PROPERTY', leftX, colY);
      doc.moveDown(0.3);
      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(13).text(s(data.property_address, '—'), leftX, doc.y, { width: colW });
      if (data.lot_number) {
        doc.fillColor('#6b7280').font('Helvetica').fontSize(10).text(`Lot ${s(data.lot_number)}`, leftX, doc.y + 2, { width: colW });
      }

      // Owner column (start at same Y as left column header)
      doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(9).text('OWNER OF RECORD', rightX, colY);
      const rightStartY = colY + 14;
      doc.fillColor('#0B1D34').font('Helvetica').fontSize(11).text(s(data.owner_name, '—'), rightX, rightStartY, { width: colW });
      let ownerYCursor = doc.y;
      if (data.owner_mailing_address) {
        doc.fillColor('#374151').font('Helvetica').fontSize(9.5).text(s(data.owner_mailing_address), rightX, ownerYCursor + 2, { width: colW });
        ownerYCursor = doc.y;
      }
      const contactLine = [data.owner_phone, data.owner_email].filter(Boolean).join('  ·  ');
      if (contactLine) {
        doc.fillColor('#6b7280').font('Helvetica').fontSize(9).text(s(contactLine), rightX, ownerYCursor + 2, { width: colW });
      }

      // Make sure y advances past whichever column is taller
      const leftEndY = doc.y;
      doc.y = Math.max(leftEndY, ownerYCursor + 16);

      // Date + cure deadline metrics row
      doc.moveDown(0.8);
      const datesY = doc.y;
      const dateCards = [
        { label: 'Date Opened',     value: fmtCentralDate(data.date_opened) || '—', color: '#0B1D34' },
        { label: 'Last Action',     value: fmtCentralDate(data.date_last_action) || '—', color: '#4338ca' },
        { label: 'Cure Deadline',   value: fmtCentralDate(data.cure_deadline) || '—', color: data.cure_deadline ? '#b91c1c' : '#9ca3af' },
        { label: 'Fine Amount',     value: data.fine_amount != null ? `$${Number(data.fine_amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '—', color: data.fine_amount ? '#7e22ce' : '#9ca3af' },
      ];
      const cardW = 116;
      const gap = 12;
      const startX = 54 + ((504 - (dateCards.length * cardW + (dateCards.length - 1) * gap)) / 2);
      dateCards.forEach((c, i) => {
        const x = startX + i * (cardW + gap);
        doc.save();
        doc.roundedRect(x, datesY, cardW, 50, 6).fillAndStroke('#f9fafb', '#e5e7eb');
        doc.fillColor('#6b7280').font('Helvetica').fontSize(8.5)
           .text(c.label, x + 6, datesY + 8, { width: cardW - 12, align: 'center' });
        doc.fillColor(c.color).font('Helvetica-Bold').fontSize(13)
           .text(c.value, x + 6, datesY + 24, { width: cardW - 12, align: 'center' });
        doc.restore();
      });
      doc.y = datesY + 60;

      // Violation description
      if (data.violation_description) {
        doc.moveDown(0.5);
        doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(11).text('Description', 54, doc.y);
        doc.moveDown(0.3);
        doc.fillColor('#374151').font('Helvetica').fontSize(10.5)
           .text(s(data.violation_description), 54, doc.y, { width: 504, lineGap: 2 });
      }

      // Current notes / next step
      if (data.current_notes) {
        doc.moveDown(0.7);
        doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(11).text('Notes / Next Step', 54, doc.y);
        doc.moveDown(0.3);
        doc.save();
        const notesY = doc.y;
        doc.roundedRect(54, notesY - 2, 504, 0, 4).stroke('#e5e7eb'); // placeholder
        doc.restore();
        doc.fillColor('#1a1a1a').font('Helvetica-Oblique').fontSize(10.5)
           .text(s(data.current_notes), 60, notesY + 4, { width: 492, lineGap: 2 });
        doc.moveDown(0.4);
      }

      // ----- Action timeline -----
      const actions = Array.isArray(data.actions) ? data.actions : [];

      // Sort actions oldest -> newest. Items missing dates sink to the
      // bottom of their bucket but are still rendered.
      const sortedActions = actions.slice().sort((a, b) => {
        const ad = a.date || '9999-12-31';
        const bd = b.date || '9999-12-31';
        return ad.localeCompare(bd);
      });

      const TIMELINE_HEADER_HEIGHT = 40;
      const MIN_ROWS = 4;
      const ROW_HEIGHT = 38;
      const tableMinHeight = TIMELINE_HEADER_HEIGHT + (MIN_ROWS * ROW_HEIGHT);
      if (doc.y + tableMinHeight > 720) doc.addPage();
      else doc.moveDown(1.0);

      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(13)
         .text('Enforcement Timeline', 54, doc.y);
      doc.fillColor('#7a7a7a').font('Helvetica').fontSize(9)
         .text(`${sortedActions.length} action${sortedActions.length === 1 ? '' : 's'} on file, chronological.`, 54, doc.y + 2);
      doc.moveDown(0.7);

      if (sortedActions.length === 0) {
        doc.fillColor('#6b7280').font('Helvetica-Oblique').fontSize(10)
           .text('No actions recorded.', 54, doc.y + 6, { align: 'center', width: 504 });
      } else {
        // Timeline rows with a left rail + dot per entry
        const railX = 76;
        for (let i = 0; i < sortedActions.length; i++) {
          const a = sortedActions[i];
          try {
            if (doc.y + ROW_HEIGHT > 720) doc.addPage();
            const y0 = doc.y;

            // Left rail line (skip top half for first row, bottom half for last)
            doc.save();
            doc.strokeColor('#d1d5db').lineWidth(1);
            const railTop = i === 0 ? y0 + 6 : y0 - 4;
            const railBottom = i === sortedActions.length - 1 ? y0 + 12 : y0 + ROW_HEIGHT + 4;
            doc.moveTo(railX, railTop).lineTo(railX, railBottom).stroke();
            doc.restore();

            // Dot
            const actionType = (a.action_type || 'other').toLowerCase();
            const isImportant = ['fine_assessed','hearing_held','resolved'].includes(actionType);
            doc.save();
            doc.circle(railX, y0 + 9, isImportant ? 4 : 3).fillAndStroke(isImportant ? '#6d28d9' : '#0B1D34', '#0B1D34');
            doc.restore();

            // Date column
            doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(9)
               .text(fmtCentralDate(a.date) || '—', 54, y0 + 1, { width: 20 });

            // Action type + actor
            const label = ACTION_LABELS[actionType] || (a.action_type || 'Action');
            doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(10.5)
               .text(label, railX + 14, y0, { width: 470 });
            if (a.actor) {
              doc.fillColor('#6b7280').font('Helvetica').fontSize(9)
                 .text(`by ${s(a.actor)}`, railX + 14, doc.y + 1, { width: 470 });
            }
            if (a.notes) {
              doc.fillColor('#374151').font('Helvetica').fontSize(9.5)
                 .text(s(a.notes), railX + 14, doc.y + 2, { width: 470, lineGap: 1 });
            }

            // Move cursor to next row position (deterministic spacing)
            doc.y = y0 + ROW_HEIGHT;
          } catch (rowErr) {
            console.warn(`[render_bedrock_violation_detail] action ${i} render failed:`, rowErr?.message);
          }
        }
      }

      drawFooter(doc, { serviceName: 'Bedrock Association Management' });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderBedrockViolationDetailPdf };
