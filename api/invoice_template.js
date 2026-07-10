// ============================================================================
// Bedrock Invoice Template
// ----------------------------------------------------------------------------
// Server-side renderer that produces the invoice HTML used by Puppeteer
// to generate the final PDF. Mirrors the design Ed signed off on in
// public/invoice_preview.html, but parameterized for any invoice in the DB.
//
// Logo is embedded as base64 so the PDF doesn't depend on network at render
// time (works in Puppeteer with no static-server bridge required).
// ============================================================================

const fs = require('fs');
const path = require('path');
const BRAND = require('../lib/brand');

// Load logo once at module init. Current brand lockup (same mark the email
// signatures use) — a wide horizontal "Bedrock Association Management" lockup.
const logoPath = path.join(__dirname, '..', 'public', 'brand-assets', 'bedrock-mark-email-2x.png');
let logoSrc = '';
try {
  const b64 = fs.readFileSync(logoPath).toString('base64');
  logoSrc = `data:image/png;base64,${b64}`;
} catch (err) {
  console.error('[invoice_template] logo load failed:', err.message);
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQty(q) {
  const n = Number(q);
  if (Number.isNaN(n)) return q;
  // Show whole numbers without decimals; show fractions with up to 2.
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function parseDate(d) {
  if (!d) return null;
  // Accept 'YYYY-MM-DD' or full ISO; force UTC interpretation to avoid TZ shifts.
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return new Date(d);
}

function fmtDateShort(d) {
  const dt = parseDate(d);
  if (!dt) return '—';
  return `${MONTHS_SHORT[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

function fmtPeriodRange(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s) return '';
  if (!e) return `${MONTHS_LONG[s.getUTCMonth()]} ${s.getUTCDate()}, ${s.getUTCFullYear()}`;
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const sameMonth = sameYear && s.getUTCMonth() === e.getUTCMonth();
  if (sameMonth) {
    return `${MONTHS_LONG[s.getUTCMonth()]} ${s.getUTCDate()}–${e.getUTCDate()}, ${s.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${MONTHS_LONG[s.getUTCMonth()]} ${s.getUTCDate()} – ${MONTHS_LONG[e.getUTCMonth()]} ${e.getUTCDate()}, ${s.getUTCFullYear()}`;
  }
  return `${MONTHS_LONG[s.getUTCMonth()]} ${s.getUTCDate()}, ${s.getUTCFullYear()} – ${MONTHS_LONG[e.getUTCMonth()]} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
}

function fmtPeriodMonthYear(d) {
  const dt = parseDate(d);
  if (!dt) return '';
  return `${MONTHS_LONG[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/**
 * Render the full invoice HTML.
 *
 * @param {object} args
 * @param {object} args.invoice          - row from `invoices`
 * @param {Array}  args.lineItems        - rows from `invoice_line_items`
 * @param {object} args.community        - row from `communities`
 * @param {object} args.managementCo     - row from `management_companies`
 * @returns {string} Full HTML document.
 */
function renderInvoiceHTML({ invoice, lineItems, community, managementCo }) {
  const inv = invoice || {};
  const items = lineItems || [];
  const comm = community || {};
  const mgmt = managementCo || {};

  const isBuilder = inv.invoice_type === 'builder_arc';
  const periodLabel = fmtPeriodRange(inv.service_period_start, inv.service_period_end);
  const periodNote = isBuilder
    ? `${fmtPeriodMonthYear(inv.service_period_start)} architectural submissions received, billed in arrears`
    : inv.invoice_type === 'activity'
      ? `${fmtPeriodMonthYear(inv.service_period_start)} activity, billed in arrears`
      : `${fmtPeriodMonthYear(inv.service_period_start)} fees, billed in advance`;
  const typeLabel = isBuilder ? 'Builder ARC' : inv.invoice_type === 'activity' ? 'Activity' : 'Fixed';

  const dueDateLabel = inv.due_date ? fmtDateShort(inv.due_date) : 'On receipt';
  const invoiceDateLabel = fmtDateShort(inv.invoice_date);

  const rows = items.map(li => `
        <tr>
          <td><div class="li-description">${escapeHtml(li.description)}${li.manual_override ? ` <span class="li-override" title="${escapeHtml(li.manual_override_reason || '')}">(adjusted)</span>` : ''}</div></td>
          <td class="center">${fmtQty(li.qty)}</td>
          <td class="right">${money(li.unit_price)}</td>
          <td class="right">${money(li.amount)}</td>
        </tr>`).join('');

  const subtotal = inv.subtotal != null ? Number(inv.subtotal) : 0;
  const total = inv.total != null ? Number(inv.total) : subtotal;

  // Bedrock company info — pulled from management_companies row when present,
  // with a hard-coded fallback so we never produce an invoice with empty
  // identification.
  const mgmtName = mgmt.name || BRAND.service.name;
  const mgmtLegal = mgmt.legal_name || BRAND.service.legal;
  const mgmtAddress = mgmt.address || BRAND.service.addressInline;
  const mgmtPhone = mgmt.contact_phone || BRAND.service.phone;
  const mgmtEmail = mgmt.contact_email || BRAND.service.email;

  // Address rendering: if address has commas, split on ", " and render
  // street on first line, city/state/zip on second.
  const addrParts = mgmtAddress.split(/,\s*/);
  let mgmtAddrTop, mgmtAddrBottom;
  if (addrParts.length >= 4) {
    // street, suite, city, state zip
    mgmtAddrTop = addrParts.slice(0, 2).join(', ');
    mgmtAddrBottom = addrParts.slice(2).join(', ');
  } else if (addrParts.length === 3) {
    mgmtAddrTop = addrParts[0];
    mgmtAddrBottom = addrParts.slice(1).join(', ');
  } else {
    mgmtAddrTop = mgmtAddress;
    mgmtAddrBottom = '';
  }

  const commName = comm.name || '(community)';
  const commLegal = comm.legal_name || commName;

  // "Billed to" block. HOA invoices go to the association c/o Bedrock. Builder
  // ARC invoices go straight to the builder (Lennar / DRB) at their own mailing
  // address — no "c/o Bedrock" line, and referencing the community they cover.
  let billedToHtml;
  if (isBuilder) {
    const recName = inv.recipient_name || 'Builder';
    const recAddr = (inv.recipient_address || '').split(/,\s*/).filter(Boolean);
    const addrTop = recAddr.length >= 3 ? recAddr.slice(0, recAddr.length - 2).join(', ') : recAddr[0] || '';
    const addrBottom = recAddr.length >= 3 ? recAddr.slice(recAddr.length - 2).join(', ') : recAddr.slice(1).join(', ');
    billedToHtml = `
          <strong>${escapeHtml(recName)}</strong><br>
          ${addrTop ? `${escapeHtml(addrTop)}<br>` : ''}${addrBottom ? `${escapeHtml(addrBottom)}<br>` : ''}
          <span style="color:var(--ink-muted); font-size:12px;">Architectural review — ${escapeHtml(commName)}</span>`;
  } else {
    billedToHtml = `
          <strong>${escapeHtml(commLegal)}</strong><br>
          c/o ${escapeHtml(mgmtName)}<br>
          ${escapeHtml(mgmtAddrTop)}${mgmtAddrBottom ? `<br>${escapeHtml(mgmtAddrBottom)}` : ''}`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Invoice ${escapeHtml(inv.invoice_number || '')} — ${escapeHtml(commName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bedrock-navy: #315A87;
      --bedrock-navy-deep: #1F3A5F;
      --bedrock-navy-tint: #EAF0F7;
      --ink: #1a1a1a;
      --ink-soft: #4a4a4a;
      --ink-muted: #888;
      --rule: #E5E7EB;
      --rule-soft: #F1F2F4;
      --paper: #ffffff;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: var(--ink);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      font-feature-settings: "tnum" 1, "ss01" 1;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      width: 8.5in;
      min-height: 11in;
      margin: 0 auto;
      padding: 0.45in 0.7in 0.6in;
      background: var(--paper);
      display: flex;
      flex-direction: column;
    }
    header {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 32px;
      padding-bottom: 16px;
      border-bottom: 2px solid var(--bedrock-navy);
    }
    .brand img { width: 260px; height: auto; display: block; }
    .doc-title { text-align: right; line-height: 1.1; }
    .doc-kind {
      font-weight: 700;
      font-size: 20px;
      letter-spacing: 0.18em;
      color: var(--bedrock-navy);
      text-transform: uppercase;
    }
    .doc-number {
      font-weight: 500;
      font-size: 13px;
      color: var(--ink-soft);
      margin-top: 6px;
      font-feature-settings: "tnum" 1;
    }
    .meta {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 32px;
      padding: 24px 0;
      border-bottom: 1px solid var(--rule);
    }
    .meta-block .label {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .meta-block .body {
      font-size: 13px;
      color: var(--ink);
      line-height: 1.45;
    }
    .meta-block .body strong { font-weight: 600; }
    .meta-dates {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .meta-dates .label {
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--ink-muted);
    }
    .meta-dates .value {
      font-weight: 500;
      font-size: 13px;
      color: var(--ink);
      font-feature-settings: "tnum" 1;
    }
    .service-period {
      margin: 24px 0 16px 0;
      padding: 14px 18px;
      background: var(--bedrock-navy-tint);
      border-left: 3px solid var(--bedrock-navy);
      border-radius: 0 4px 4px 0;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .service-period-label {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--bedrock-navy-deep);
    }
    .service-period-value {
      font-size: 16px;
      font-weight: 600;
      color: var(--bedrock-navy-deep);
    }
    .service-period-note {
      font-size: 11px;
      color: var(--ink-muted);
      margin-top: 4px;
      font-style: italic;
    }
    .line-items {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }
    .line-items thead th {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--ink-muted);
      padding: 12px 8px 10px;
      text-align: left;
      border-bottom: 1px solid var(--rule);
    }
    .line-items thead th.right { text-align: right; }
    .line-items thead th.center { text-align: center; }
    .line-items tbody td {
      padding: 14px 8px;
      font-size: 13px;
      border-bottom: 1px solid var(--rule-soft);
      vertical-align: top;
    }
    .line-items tbody td.right { text-align: right; font-feature-settings: "tnum" 1; }
    .line-items tbody td.center { text-align: center; font-feature-settings: "tnum" 1; }
    .line-items tbody tr:last-child td { border-bottom: 1px solid var(--rule); }
    .li-description { font-weight: 500; color: var(--ink); }
    .li-override {
      font-size: 11px;
      color: #a60;
      font-weight: 400;
      margin-left: 4px;
    }
    .totals {
      margin-top: 16px;
      display: flex;
      justify-content: flex-end;
    }
    .totals-table {
      min-width: 280px;
      border-collapse: collapse;
    }
    .totals-table td {
      padding: 6px 0;
      font-size: 13px;
      font-feature-settings: "tnum" 1;
    }
    .totals-table td:first-child {
      color: var(--ink-soft);
      padding-right: 32px;
      text-align: right;
    }
    .totals-table td:last-child {
      text-align: right;
      font-weight: 500;
    }
    .totals-table tr.grand td {
      border-top: 1px solid var(--bedrock-navy);
      padding-top: 12px;
      padding-bottom: 4px;
      font-size: 18px;
      font-weight: 700;
    }
    .totals-table tr.grand td:first-child { color: var(--bedrock-navy-deep); }
    .totals-table tr.grand td:last-child { color: var(--bedrock-navy-deep); }
    .remit {
      margin-top: 36px;
      padding: 18px 20px;
      background: #FAFBFC;
      border: 1px solid var(--rule);
      border-radius: 6px;
    }
    .remit .label {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .remit .body {
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--ink);
    }
    footer {
      margin-top: auto;
      padding-top: 24px;
      border-top: 1px solid var(--rule);
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .footer-tag {
      font-size: 11px;
      color: var(--ink-muted);
      letter-spacing: 0.04em;
      line-height: 1.5;
    }
    .footer-tag .tagline {
      display: block;
      color: var(--bedrock-navy);
      font-weight: 600;
      letter-spacing: 0.06em;
      margin-top: 2px;
    }
    .footer-meta {
      font-size: 11px;
      color: var(--ink-muted);
      text-align: right;
      line-height: 1.5;
    }
    @page { size: letter; margin: 0; }
  </style>
</head>
<body>
  <div class="page">

    <header>
      <div class="brand">
        <img src="${logoSrc}" alt="${escapeHtml(mgmtName)}">
      </div>
      <div class="doc-title">
        <div class="doc-kind">Invoice</div>
        <div class="doc-number">No. ${escapeHtml(inv.invoice_number || '')}</div>
      </div>
    </header>

    <section class="meta">
      <div class="meta-block">
        <div class="label">Billed to</div>
        <div class="body">${billedToHtml}
        </div>
      </div>
      <div class="meta-block">
        <div class="label">Issued by</div>
        <div class="body">
          <strong>${escapeHtml(mgmtLegal)}</strong><br>
          ${escapeHtml(mgmtAddrTop)}${mgmtAddrBottom ? `<br>${escapeHtml(mgmtAddrBottom)}` : ''}<br>
          ${escapeHtml(mgmtPhone)}
        </div>
      </div>
      <div class="meta-block">
        <div class="meta-dates">
          <div>
            <div class="label">Invoice date</div>
            <div class="value">${escapeHtml(invoiceDateLabel)}</div>
          </div>
          <div>
            <div class="label">Due</div>
            <div class="value">${escapeHtml(dueDateLabel)}</div>
          </div>
          <div>
            <div class="label">Type</div>
            <div class="value">${escapeHtml(typeLabel)}</div>
          </div>
        </div>
      </div>
    </section>

    <div class="service-period">
      <div>
        <div class="service-period-label">Service period</div>
        <div class="service-period-note">${escapeHtml(periodNote)}</div>
      </div>
      <div class="service-period-value">${escapeHtml(periodLabel)}</div>
    </div>

    <table class="line-items">
      <thead>
        <tr>
          <th>Description</th>
          <th class="center">Qty</th>
          <th class="right">Rate</th>
          <th class="right">Amount</th>
        </tr>
      </thead>
      <tbody>${rows || `
        <tr><td colspan="4" style="text-align:center; color:var(--ink-muted); padding:24px;">No line items.</td></tr>`}
      </tbody>
    </table>

    <div class="totals">
      <table class="totals-table">
        <tr>
          <td>Subtotal</td>
          <td>${money(subtotal)}</td>
        </tr>
        <tr>
          <td>Adjustments</td>
          <td>—</td>
        </tr>
        <tr class="grand">
          <td>Total due</td>
          <td>${money(total)}</td>
        </tr>
      </table>
    </div>

    <div class="remit">
      <div class="label">Questions</div>
      <div class="body">
        Reach out to accounting at <strong>${escapeHtml(mgmtEmail)}</strong> · ${escapeHtml(mgmtPhone)}.
        Reference invoice <strong>${escapeHtml(inv.invoice_number || '')}</strong>.
      </div>
    </div>

    <footer>
      <div class="footer-tag">
        ${escapeHtml(mgmtLegal)}
        <span class="tagline">${BRAND.service.tagline}</span>
      </div>
      <div class="footer-meta">
        ${escapeHtml(mgmtAddress)}<br>
        ${BRAND.service.website}
      </div>
    </footer>

  </div>
</body>
</html>`;
}

module.exports = { renderInvoiceHTML };
