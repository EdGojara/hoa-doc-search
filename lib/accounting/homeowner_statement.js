// ============================================================================
// lib/accounting/homeowner_statement.js
// ----------------------------------------------------------------------------
// Render a homeowner account statement as branded HTML (-> PDF via puppeteer,
// same path as invoices/letters). Catastrophic-output surface: every number is
// rendered from the validated account data + ledger, never freestyled. Bedrock
// Association Management branding; addressed to the owner by name; bespoke
// (community, dates, lot). No "Dear Homeowner".
// ============================================================================
const BRAND = require('../brand');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (c) => { const n = Number(c || 0) / 100; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const longDate = (d) => { const dt = new Date(String(d) + (String(d).length <= 10 ? 'T00:00:00' : '')); return Number.isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }); };

const AGE = [['current', 'Current'], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d91_120', '91–120'], ['d120_plus', '120+']];

function renderStatementHTML({ owner = {}, communityName, statementDate, total_cents, by_category = [], buckets = {}, ledger = [], ledgerThrough }) {
  const svc = BRAND.service;
  const navy = '#0B1D34', gold = '#D4AF37', stone = '#6B7280', light = '#F2F4F7';
  const mailing = owner.owner_mailing_address || [owner.owner_mailing_street, owner.owner_mailing_city, owner.owner_mailing_state, owner.owner_mailing_zip].filter(Boolean).join(', ');
  const dueLabel = total_cents > 0 ? 'Balance Due' : (total_cents < 0 ? 'Credit Balance' : 'Balance');

  const agingRow = AGE.map(([k, l]) => `<td style="text-align:center;padding:6px 4px;"><div style="font-size:9px;color:${stone};text-transform:uppercase;letter-spacing:.5px;">${l}</div><div style="font-weight:700;">${buckets[k] ? fmt(buckets[k]) : '—'}</div></td>`).join('');
  const catRows = by_category.length
    ? by_category.map((c) => `<tr><td style="padding:4px 0;">${esc(c.category)}</td><td style="text-align:right;font-variant-numeric:tabular-nums;">${fmt(c.cents)}</td></tr>`).join('')
    : `<tr><td colspan="2" style="padding:4px 0;color:${stone};">Account paid in full — thank you.</td></tr>`;
  const ledgerRows = ledger.map((e) => `<tr>
      <td style="padding:5px 8px;white-space:nowrap;color:${stone};">${esc(String(e.entry_date || '').slice(0, 10))}</td>
      <td style="padding:5px 8px;">${esc(e.description || '')}</td>
      <td style="padding:5px 8px;text-align:right;font-variant-numeric:tabular-nums;">${Number(e.charge_cents) ? fmt(e.charge_cents) : ''}</td>
      <td style="padding:5px 8px;text-align:right;font-variant-numeric:tabular-nums;color:#047857;">${Number(e.payment_cents) ? '(' + fmt(e.payment_cents) + ')' : ''}</td>
      <td style="padding:5px 8px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${fmt(e.running_balance_cents)}</td>
    </tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: ${navy}; margin: 0; font-size: 12px; }
    .page { padding: 48px 54px; }
    .gold { color: ${gold}; } .stone { color: ${stone}; }
    table { width: 100%; border-collapse: collapse; }
    h1,h2,h3 { margin: 0; }
  </style></head><body><div class="page">

    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${gold};padding-bottom:14px;">
      <div>
        <div style="font-size:20px;font-weight:800;letter-spacing:.5px;">${esc(svc.name)}</div>
        <div style="font-size:11px;color:${gold};font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">${esc(svc.tagline)}</div>
        <div style="font-size:10.5px;color:${stone};margin-top:6px;line-height:1.5;">${esc(svc.addressInline)}<br>${esc(svc.phone)} · ${esc(svc.email)} · ${esc(svc.website)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:17px;font-weight:700;">Account Statement</div>
        <div style="font-size:11px;color:${stone};margin-top:2px;">${esc(communityName || '')}</div>
        <div style="font-size:11px;color:${stone};">Statement date: <strong style="color:${navy};">${longDate(statementDate)}</strong></div>
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;margin-top:22px;gap:24px;">
      <div style="font-size:12.5px;line-height:1.6;">
        <div style="font-size:10px;color:${stone};text-transform:uppercase;letter-spacing:1px;">Account holder</div>
        <div style="font-weight:700;font-size:14px;">${esc(owner.owner_name || '')}</div>
        <div>${esc(owner.street_address || '')}</div>
        ${mailing && mailing !== owner.street_address ? `<div style="color:${stone};font-size:11px;margin-top:3px;">Mailing: ${esc(mailing)}</div>` : ''}
        ${owner.vantaca_account_id ? `<div style="color:${stone};font-size:11px;">Account #${esc(owner.vantaca_account_id)}</div>` : ''}
      </div>
      <div style="min-width:210px;background:${light};border-radius:10px;padding:16px 18px;text-align:right;">
        <div style="font-size:10px;color:${stone};text-transform:uppercase;letter-spacing:1px;">${dueLabel}</div>
        <div style="font-size:30px;font-weight:800;color:${total_cents > 0 ? '#b91c1c' : (total_cents < 0 ? '#047857' : navy)};">${fmt(total_cents)}</div>
        ${total_cents > 0 ? `<div style="font-size:10.5px;color:${stone};margin-top:2px;">Due upon receipt</div>` : ''}
      </div>
    </div>

    ${total_cents > 0 ? `<div style="margin-top:18px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
      <div style="background:${navy};color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:6px 10px;">Aging</div>
      <table><tr>${agingRow}</tr></table></div>` : ''}

    <div style="display:flex;gap:24px;margin-top:22px;">
      <div style="flex:1;">
        <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:${navy};border-bottom:1px solid #e5e7eb;padding-bottom:5px;margin-bottom:6px;">Balance by category</h3>
        <table style="font-size:12px;">${catRows}
          <tr style="border-top:2px solid ${navy};font-weight:800;"><td style="padding-top:6px;">Total</td><td style="text-align:right;padding-top:6px;">${fmt(total_cents)}</td></tr></table>
      </div>
    </div>

    <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:${navy};border-bottom:1px solid #e5e7eb;padding-bottom:5px;margin:26px 0 0;">Account activity${ledgerThrough ? ` <span style="font-weight:400;color:${stone};text-transform:none;letter-spacing:0;">through ${longDate(ledgerThrough)}</span>` : ''}</h3>
    <table style="font-size:11.5px;margin-top:6px;">
      <thead><tr style="border-bottom:1.5px solid ${navy};text-align:left;color:${stone};font-size:10px;text-transform:uppercase;letter-spacing:.5px;">
        <th style="padding:5px 8px;">Date</th><th style="padding:5px 8px;">Description</th>
        <th style="padding:5px 8px;text-align:right;">Charges</th><th style="padding:5px 8px;text-align:right;">Payments</th><th style="padding:5px 8px;text-align:right;">Balance</th></tr></thead>
      <tbody>${ledgerRows || `<tr><td colspan="5" style="padding:8px;color:${stone};">No activity in this period.</td></tr>`}</tbody>
    </table>

    <div style="margin-top:30px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:${stone};line-height:1.6;">
      ${total_cents > 0
      ? `Please remit <strong style="color:${navy};">${fmt(total_cents)}</strong> to ${esc(svc.name)}. Pay online, by mail, or through your homeowner portal. Questions about your account? Reach us at ${esc(svc.phone)} or ${esc(svc.email)} — we're happy to help.`
      : `Your account is current — thank you. Questions? Reach us at ${esc(svc.phone)} or ${esc(svc.email)}.`}
      <div style="margin-top:10px;color:#9ca3af;font-size:9.5px;">${esc(svc.legal)} · ${esc(svc.addressCityStateZip)} · Managed on trustEd</div>
    </div>

  </div></body></html>`;
}

module.exports = { renderStatementHTML };
