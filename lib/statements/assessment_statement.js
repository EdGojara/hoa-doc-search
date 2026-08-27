// ============================================================================
// lib/statements/assessment_statement.js  (Ed 2026-08-27)
// ----------------------------------------------------------------------------
// The homeowner ASSESSMENT STATEMENT — a Bedrock-rendered replacement for the
// Vantaca statement (Statement.pdf), built to the same shape Ed sent:
//   • header: association + c/o management company + address
//   • account bar: Account Number | Due Date | Pay This Amount
//   • addressee + assessment notice
//   • activity table: DATE | DESCRIPTION | CHARGES | PAYMENTS | TOTAL
//   • a detachable remittance coupon with the mail-to address and a SCANLINE
//     the bank's lockbox reads.
//
// Data is canonical, not freestyled:
//   • owner + mailing address  → v_current_property_owners
//   • current balance          → v_homeowner_current_balance (AR SSOT, cents)
//   • activity                 → homeowner_transactions
// This is a catastrophic-output surface (money, goes to homeowners): the render
// pulls from the validated views and never invents a number.
//
// SCANLINE: the format below mirrors the SHAPE of Vantaca's remittance line
// (account + name + amount + check digit) as a starting point. The exact layout
// the lockbox reads gets finalized WITH NewFirst — buildScanline is the single
// place to change it. (Ed: "work with new first to figure out how best to
// format for lockbox.")
// ============================================================================

// Bedrock management-company block (same on every community Bedrock manages).
const MGMT = {
  name: 'Bedrock Association Management LLC',
  line1: '12808 W Airport Blvd STE 253',
  city: 'Sugar Land, TX 77478',
  phone: '832-588-2485',
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (cents) => '$' + (Math.round(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => { if (!d) return ''; try { return new Date(String(d).length <= 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-US'); } catch (_) { return ''; } };

// ---- data ------------------------------------------------------------------
async function buildStatementData(supabase, propertyId, { asOf } = {}) {
  const asOfDate = asOf ? new Date(asOf) : new Date();

  const { data: owner, error: oe } = await supabase
    .from('v_current_property_owners').select('*').eq('property_id', propertyId).maybeSingle();
  if (oe) throw oe;
  if (!owner) throw new Error('property_not_found');

  const { data: comm, error: ce } = await supabase
    .from('communities')
    .select('name, legal_name, hoa_legal_name, hoa_address, letter_pay_to_name, letter_pay_to_address')
    .eq('id', owner.community_id).maybeSingle();
  if (ce) throw ce;

  // Balance (AR SSOT). A property can fan out to >1 vantaca account — sum.
  const { data: balRows, error: be } = await supabase
    .from('v_homeowner_current_balance').select('balance_cents').eq('property_id', propertyId);
  if (be) throw be;
  const balanceCents = (balRows || []).reduce((s, r) => s + (r.balance_cents || 0), 0);

  // Activity — oldest first, so the running balance reads top to bottom.
  const { data: tx, error: te } = await supabase
    .from('homeowner_transactions')
    .select('transaction_date, description, txn_type, amount_cents, running_balance_cents')
    .eq('property_id', propertyId)
    .order('transaction_date', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(300);
  if (te) throw te;

  const assocName = comm?.hoa_legal_name || comm?.legal_name || comm?.name || 'Your Association';
  const acctNumber = owner.vantaca_account_id || owner.trusted_account_number || '';
  const addr = {
    name: owner.owner_name || 'Property Owner',
    street: owner.owner_mailing_street || owner.street_address || '',
    cityline: [owner.owner_mailing_city || owner.city, owner.owner_mailing_state || owner.state, owner.owner_mailing_zip || owner.zip].filter(Boolean).join(', ').replace(/, ([A-Z]{2}), /, ', $1 '),
  };

  const data = {
    asOf: asOfDate,
    association: { name: assocName },
    mgmt: MGMT,
    account_number: acctNumber,
    due_date: '', // annual assessment due Jan 1 — left blank on a $0/mid-year statement, like Vantaca
    balance_cents: balanceCents,
    addressee: addr,
    property_label: `${acctNumber} - ${owner.street_address || ''}`.trim(),
    property_address: owner.street_address || '',
    notice: `Annual Assessments are due on January 1st and are delinquent after January 31st to avoid any penalties. Your balance may reflect a prior balance. If you have any questions, please contact our office at ${MGMT.phone}.`,
    activity: (tx || []).map((t) => ({
      date: t.transaction_date,
      description: t.description || '',
      charge_cents: (t.amount_cents || 0) > 0 ? t.amount_cents : 0,
      payment_cents: (t.amount_cents || 0) < 0 ? -t.amount_cents : 0,
      total_cents: t.running_balance_cents,
    })),
    remit: {
      name: comm?.letter_pay_to_name || assocName,
      block: comm?.letter_pay_to_address || `${assocName}\nc/o ${MGMT.name}\n${MGMT.line1}\n${MGMT.city}`,
    },
    owner_name_raw: owner.owner_name || '',
  };
  data.scanline = buildScanline(data);
  return data;
}

// ---- scanline (placeholder shape; finalized with NewFirst) -----------------
// Vantaca sample: "0000 000101 0000000010110814 GEISSLER0000 000000 6"
// Shape: <pad> <seq> <16-digit account> <LASTNAME><pad> <amount> <checkdigit>.
function buildScanline(data) {
  const acct = String(data.account_number || '').replace(/\D/g, '').padStart(16, '0');
  const last = (String(data.owner_name_raw || '').split(/[,&]/)[0].trim().split(/\s+/).pop() || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12);
  const amt = String(Math.max(0, Math.round(data.balance_cents || 0))).padStart(6, '0');
  const core = `0000 000101 ${acct} ${last}0000 ${amt}`;
  // Simple mod-10 check digit over the digits, so the line is self-consistent.
  const digits = core.replace(/\D/g, '');
  let sum = 0; for (let i = 0; i < digits.length; i++) sum += Number(digits[i]);
  const check = (10 - (sum % 10)) % 10;
  return `${core} ${check}`;
}

// ---- render ----------------------------------------------------------------
function renderStatementHTML(d) {
  const rows = d.activity.length
    ? d.activity.map((a) => `<tr>
        <td>${esc(fmtDate(a.date))}</td>
        <td>${esc(a.description)}</td>
        <td class="num">${a.charge_cents ? money(a.charge_cents) : ''}</td>
        <td class="num">${a.payment_cents ? money(a.payment_cents) : ''}</td>
        <td class="num">${a.total_cents != null ? money(a.total_cents) : ''}</td></tr>`).join('')
    : `<tr><td>${esc(fmtDate(d.asOf))}</td><td>&mdash; Prior Balance &mdash;</td><td class="num"></td><td class="num"></td><td class="num">${money(d.balance_cents)}</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Account Statement — ${esc(d.addressee.name)}</title>
<style>
  @page { size: letter; margin: 0.6in; }
  * { box-sizing:border-box; }
  body { font-family:Arial,Helvetica,sans-serif; color:#1a2230; font-size:12px; margin:0; }
  .sheet { width:7.3in; margin:0 auto; }
  .row { display:flex; justify-content:space-between; }
  .assoc { font-weight:700; font-size:13px; line-height:1.35; }
  .assoc .sub { font-weight:400; }
  .title { text-align:right; }
  .title h1 { font-size:17px; letter-spacing:.06em; margin:0; color:#0B1D34; }
  .title .asof { color:#555; font-size:11.5px; margin-top:2px; }
  .acctbar { display:grid; grid-template-columns:1fr 1fr 1fr; border:1px solid #333; margin:16px 0 14px; }
  .acctbar > div { padding:6px 10px; border-right:1px solid #333; }
  .acctbar > div:last-child { border-right:0; }
  .acctbar .lbl { font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; color:#555; }
  .acctbar .val { font-weight:700; font-size:13px; }
  .who { display:flex; justify-content:space-between; gap:24px; margin-bottom:14px; }
  .who .to { line-height:1.4; }
  .who .notice { font-size:10.5px; color:#444; max-width:3.6in; line-height:1.45; }
  table.activity { width:100%; border-collapse:collapse; }
  table.activity th { text-align:left; border-bottom:1.5px solid #333; padding:5px 6px; font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
  table.activity th.num, table.activity td.num { text-align:right; }
  table.activity td { padding:5px 6px; border-bottom:1px solid #eee; }
  table.activity .proprow td { font-weight:700; background:#f6f7f9; border-bottom:1px solid #ddd; }
  .detach { border-top:1px dashed #888; margin:26px 0 10px; padding-top:6px; text-align:center; font-size:10px; color:#666; letter-spacing:.03em; }
  .coupon { border:1px solid #333; padding:12px 14px; }
  .coupon .crow { display:flex; justify-content:space-between; gap:20px; }
  .coupon .amt { text-align:right; }
  .coupon .lbl { font-size:9.5px; text-transform:uppercase; color:#555; letter-spacing:.04em; }
  .coupon .big { font-weight:700; font-size:14px; }
  .coupon .mailto { margin-top:10px; display:flex; justify-content:space-between; gap:20px; font-size:11px; line-height:1.4; }
  .coupon .instr { font-size:10px; color:#555; max-width:2.9in; line-height:1.4; }
  .scan { font-family:'OCR B','Courier New',monospace; font-size:14px; letter-spacing:1px; margin-top:14px; padding-top:8px; border-top:1px solid #ccc; }
  .foot { margin-top:12px; font-size:9px; color:#9aa5b1; text-align:center; }
  @media screen { body { background:#eef1f5; padding:24px; } .sheet { background:#fff; padding:0.6in; box-shadow:0 4px 20px rgba(0,0,0,.15); } }
</style></head>
<body><div class="sheet">
  <div class="row">
    <div class="assoc">${esc(d.association.name)}<div class="sub">c/o ${esc(d.mgmt.name)}<br>${esc(d.mgmt.line1)}<br>${esc(d.mgmt.city)}</div></div>
    <div class="title"><h1>ACCOUNT STATEMENT</h1><div class="asof">as of ${esc(fmtDate(d.asOf))}</div></div>
  </div>

  <div class="acctbar">
    <div><div class="lbl">Account Number</div><div class="val">${esc(d.account_number || '—')}</div></div>
    <div><div class="lbl">Due Date</div><div class="val">${esc(d.due_date || '')}&nbsp;</div></div>
    <div><div class="lbl">Pay This Amount</div><div class="val">${money(d.balance_cents)}</div></div>
  </div>

  <div class="who">
    <div class="to">${esc(d.addressee.name)}<br>${esc(d.addressee.street)}<br>${esc(d.addressee.cityline)}</div>
    <div class="notice">${esc(d.notice)}</div>
  </div>

  <table class="activity">
    <thead><tr><th>Date</th><th>Description</th><th class="num">Charges</th><th class="num">Payments</th><th class="num">Total</th></tr></thead>
    <tbody>
      <tr class="proprow"><td colspan="5">Property: ${esc(d.property_label)}</td></tr>
      ${rows}
    </tbody>
  </table>

  <div class="detach">Please detach and return this portion with your payment.</div>

  <div class="coupon">
    <div class="crow">
      <div><div class="big">${esc(d.remit.name)}</div>${esc(d.addressee.name)}<br><span class="lbl">RE:</span> ${esc(d.property_label)}</div>
      <div class="amt"><div class="lbl">Pay This Amount</div><div class="big">${money(d.balance_cents)}</div><div class="lbl" style="margin-top:6px;">Due Date</div><div>${esc(d.due_date || '')}&nbsp;</div><div class="lbl" style="margin-top:6px;">Account Number</div><div>${esc(d.account_number || '')}</div></div>
    </div>
    <div class="mailto">
      <div><div class="lbl">Mail Checks To</div>${esc(d.remit.block).replace(/\n/g, '<br>')}</div>
      <div class="instr">Please include your account number on your check. Make check payable to your association. Please allow 10 to 15 business days for processing, or pay through your owner's portal for instant processing.</div>
    </div>
    <div class="scan">${esc(d.scanline)}</div>
  </div>

  <div class="foot">Rendered by Bedrock Intelligence &middot; ${esc(d.association.name)}</div>
</div></body></html>`;
}

module.exports = { buildStatementData, renderStatementHTML, buildScanline };
