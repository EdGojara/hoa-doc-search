// ============================================================================
// lib/reports/render_bedrock_drv.js
// ----------------------------------------------------------------------------
// Render a Bedrock-branded monthly DRV summary for the COMMUNITY NEWSLETTER.
// Audience is homeowners — so no property addresses, no owner names, no
// per-row PII. Aggregate counts + category breakdown + friendly tone only.
//
// Ed 2026-06-04: this is the version that goes into LOPF's monthly
// homeowner newsletter (vs. the operator-facing internal DRV log which is
// a separate artifact). Layout favors brevity and warm tone over detail.
//
// One-page artifact:
//   - Header lockup + community + "April 2026 Compliance Snapshot"
//   - Brief friendly intro paragraph
//   - Big metric row (Total · Resolved · Still Open · New This Month)
//   - "Most-common items this month" — category list with bar chart
//   - Reminder paragraph (if a category dominates, highlight what to watch)
//   - Sign-off line + contact
// ============================================================================

const PDFDocument = require('pdfkit');
const { drawHeader, drawFooter } = require('./bedrock_pdf_chrome');

const s = (v, fallback = '') => {
  if (v == null) return fallback;
  const str = String(v);
  return str === 'undefined' || str === 'null' ? fallback : str;
};

// Friendly category renaming — Vantaca's internal labels can be cryptic
// ("VIO-TRASH") or clinical. Newsletter version reads naturally to a
// homeowner. Extensible: add aliases as new violation types appear.
const FRIENDLY_CATEGORY = (raw) => {
  if (!raw) return 'Other';
  const lower = String(raw).toLowerCase();
  if (lower.includes('trash') || lower.includes('recycling') || lower.includes('garbage')) return 'Trash cans visible from street';
  if (lower.includes('lawn') || lower.includes('grass') || lower.includes('mow')) return 'Lawn / grass maintenance';
  if (lower.includes('weed')) return 'Weeds in beds';
  if (lower.includes('fence')) return 'Fence condition or unapproved installation';
  if (lower.includes('paint') || lower.includes('exterior')) return 'Exterior paint or condition';
  if (lower.includes('roof')) return 'Roof condition';
  if (lower.includes('parking') || lower.includes('vehicle')) return 'Parking / vehicle';
  if (lower.includes('pet') || lower.includes('animal') || lower.includes('dog')) return 'Pet / animal';
  if (lower.includes('arc') || lower.includes('arch') || lower.includes('mod')) return 'Architectural — unapproved modification';
  if (lower.includes('pool')) return 'Pool / amenity';
  if (lower.includes('sign')) return 'Signage';
  if (lower.includes('storage') || lower.includes('shed')) return 'Storage / shed';
  return raw; // fall through to the original label if no friendly match
};

async function renderBedrockDrvPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawHeader(doc);

      // Friendly title
      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(20)
         .text(s(data.community_name, '(Community)'), 54, 140, { align: 'center', width: 504 });
      doc.fillColor('#374151').font('Helvetica').fontSize(13)
         .text(`${s(data.period_label, '')} Compliance Snapshot`, 54, doc.y + 4, { align: 'center', width: 504 });
      doc.fillColor('#6b7280').font('Helvetica-Oblique').fontSize(11)
         .text('A quick look at deed restriction items across the community this month.', 54, doc.y + 4, { align: 'center', width: 504 });

      // Compute aggregates — derive from violations array if summary block is
      // sparse, so this renderer is robust to partial extraction.
      const violations = Array.isArray(data.violations) ? data.violations : [];
      const summary = data.summary || {};
      const totalCount = summary.total_violations ?? violations.length;
      const closedCount = summary.closed_count ?? violations.filter((v) => /closed|resolved/i.test(v.status || '')).length;
      const openCount = summary.open_count ?? Math.max(0, totalCount - closedCount);
      const newCount = summary.new_this_period ?? null;

      // Big metric row — friendly labels, no admin jargon.
      doc.moveDown(1.5);
      const cardsY = doc.y;
      const cards = [
        { label: 'Items reviewed',  value: totalCount,          color: '#0B1D34' },
        { label: 'Resolved',         value: closedCount,         color: '#15803d' },
        { label: 'Still in progress',value: openCount,           color: '#b45309' },
        { label: 'New this month',   value: newCount ?? '—',     color: '#6d28d9' },
      ];
      const cardW = 116, gap = 12;
      const startX = 54 + ((504 - (cards.length * cardW + (cards.length - 1) * gap)) / 2);
      cards.forEach((c, i) => {
        const x = startX + i * (cardW + gap);
        doc.save();
        doc.roundedRect(x, cardsY, cardW, 60, 6).fillAndStroke('#f9fafb', '#e5e7eb');
        doc.fillColor('#6b7280').font('Helvetica').fontSize(8.5)
           .text(c.label, x + 8, cardsY + 9, { width: cardW - 16, align: 'center' });
        doc.fillColor(c.color).font('Helvetica-Bold').fontSize(24)
           .text(String(c.value), x + 8, cardsY + 24, { width: cardW - 16, align: 'center' });
        doc.restore();
      });
      doc.y = cardsY + 60;

      // Most-common categories. Use the by_category block if present;
      // otherwise derive from violations array. Friendly-rename the labels.
      let categories = Array.isArray(data.by_category) && data.by_category.length > 0
        ? data.by_category.map((c) => ({ category: FRIENDLY_CATEGORY(c.category), count: c.count || 0 }))
        : null;
      if (!categories) {
        // Derive from violations array
        const tally = new Map();
        for (const v of violations) {
          const k = FRIENDLY_CATEGORY(v.violation_type || 'Other');
          tally.set(k, (tally.get(k) || 0) + 1);
        }
        categories = Array.from(tally.entries()).map(([category, count]) => ({ category, count }));
      }
      // Re-combine duplicate friendly names + sort by count desc
      const combined = new Map();
      for (const c of categories) {
        combined.set(c.category, (combined.get(c.category) || 0) + (c.count || 0));
      }
      const sortedCats = Array.from(combined.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      if (sortedCats.length > 0) {
        doc.moveDown(1.5);
        doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(13)
           .text('Most common items this month', 54, doc.y);
        doc.moveDown(0.5);

        const maxCount = Math.max(...sortedCats.map((c) => c.count), 1);
        const labelW = 280;
        const barColX = 54 + labelW + 16;
        const barMaxW = 180;
        for (const c of sortedCats) {
          if (doc.y > 660) doc.addPage();
          const y0 = doc.y;
          doc.fillColor('#374151').font('Helvetica').fontSize(11)
             .text(s(c.category, ''), 54, y0, { width: labelW });
          // Bar
          const barW = Math.max(2, (c.count / maxCount) * barMaxW);
          doc.save();
          doc.roundedRect(barColX, y0 + 3, barMaxW, 12, 3).fillAndStroke('#f3f4f6', '#e5e7eb');
          doc.roundedRect(barColX, y0 + 3, barW, 12, 3).fill('#6d28d9');
          doc.restore();
          doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(11)
             .text(String(c.count), barColX + barMaxW + 8, y0, { width: 28 });
          doc.y = y0 + 20;
        }
      }

      // Friendly reminder paragraph. If a category is dominant (>=30% of
      // total), call it out specifically. Otherwise generic.
      doc.moveDown(1.2);
      let reminder = '';
      if (sortedCats.length > 0 && totalCount > 0) {
        const top = sortedCats[0];
        const topShare = top.count / totalCount;
        if (topShare >= 0.30) {
          reminder = `The most common item this month was ${top.category.toLowerCase()} — accounting for about ${Math.round(topShare * 100)}% of what we reviewed. A quick check around your property can help keep our community looking its best.`;
        } else {
          reminder = `No single category dominated this month — most items were resolved quickly with a friendly note. Thank you for keeping our community looking great.`;
        }
      } else {
        reminder = `A quiet month with little to report. Thank you for keeping our community looking great.`;
      }
      doc.save();
      doc.roundedRect(54, doc.y, 504, 50, 8).fillAndStroke('#f5f3ff', '#c4b5fd');
      doc.fillColor('#4c1d95').font('Helvetica').fontSize(11)
         .text(reminder, 66, doc.y + 12, { width: 480, lineGap: 2 });
      doc.restore();
      doc.y += 60;

      // Sign-off
      doc.moveDown(0.8);
      doc.fillColor('#6b7280').font('Helvetica').fontSize(10.5)
         .text('Questions about a notice you received? Reach out anytime — we\'re here to help you sort it out.', 54, doc.y, { width: 504, align: 'center', lineGap: 2 });
      doc.moveDown(0.4);
      doc.fillColor('#0B1D34').font('Helvetica-Bold').fontSize(11)
         .text('Bedrock Association Management', 54, doc.y, { align: 'center', width: 504 });
      doc.fillColor('#7a7a7a').font('Helvetica-Oblique').fontSize(9)
         .text('on behalf of your Board of Directors', 54, doc.y + 2, { align: 'center', width: 504 });

      drawFooter(doc, { serviceName: 'Bedrock Association Management' });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderBedrockDrvPdf };
