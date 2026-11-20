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
// SCANLINE: lib/payments/lockbox.js (verified per association; see there).
// ============================================================================

// Bedrock management-company block (same on every community Bedrock manages).
const { currentOwnerBalance, currentOwnerActivity } = require('../ar/current_owner_ledger');
const { addresseeOf } = require('../mail/mailing_address');

const MGMT = {
  name: 'Bedrock Association Management LLC',
  // Bedrock's office (lib/brand.js is the single source; office moved Nov 2026).
  line1: require('../brand').service.address,
  city: require('../brand').service.addressCityStateZip,
  phone: '832-588-2485',
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (cents) => '$' + (Math.round(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => { if (!d) return ''; try { return new Date(String(d).length <= 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-US'); } catch (_) { return ''; } };

// ---- data ------------------------------------------------------------------
// billing (annual statement run): { year, assessment_cents, due_date: 'YYYY-MM-DD' }
//   The statement then shows the prior balance and the year's annual assessment
//   (like Vantaca's annual statement) and asks for prior balance + assessment.
//   The assessment must come from an APPROVED rate (scripts/build_annual_statements
//   refuses otherwise); this module never invents an amount.
async function buildStatementData(supabase, propertyId, { asOf, billing = null } = {}) {
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

  // Balance + activity: the CURRENT OWNER's tenure only (committed batches, on
  // the lot's current account). A prior owner's rows, legacy accounts and
  // reverted/superseded import batches never appear on this owner's statement.
  const bal = await currentOwnerBalance(supabase, propertyId);
  const balanceCents = bal ? bal.balance_cents : 0;

  const assocName = comm?.hoa_legal_name || comm?.legal_name || comm?.name || 'Your Association';
  const acctNumber = owner.vantaca_account_id || owner.trusted_account_number || '';
  // The whole addressee block comes from the one mailing-address resolver (mig
  // 549): never the mailing street with the property's city or ZIP.
  const { source: addrSource, ...addr } = addresseeOf(owner, owner, owner.owner_name || 'Property Owner');
  // Verified association lockbox, else a pay-to PO Box, else c/o Bedrock's
  // office (lib/payments/remit_address: the same answer the portal shows).
  const remit = require('../payments/remit_address').remitTo(comm, assocName, { mgmtName: MGMT.name });

  let activity; let payCents; let dueDate = '';
  if (billing) {
    const cents = Math.round(Number(billing.assessment_cents));
    if (!Number.isFinite(cents) || cents <= 0) throw new Error('billing_assessment_required');
    activity = [
      { date: null, description: '-- Prior Balance --', charge_cents: 0, payment_cents: 0, total_cents: balanceCents, prior: true },
      { date: billing.due_date, description: `${billing.year} Annual Assessment`, charge_cents: cents, payment_cents: 0, total_cents: balanceCents + cents },
    ];
    payCents = Math.max(0, balanceCents + cents);
    dueDate = billing.due_date;
  } else {
    const tx = await currentOwnerActivity(supabase, propertyId, { ascending: true, limit: 300 });
    activity = (tx || []).map((t) => ({
      date: t.transaction_date,
      description: t.description || '',
      charge_cents: (t.amount_cents || 0) > 0 ? t.amount_cents : 0,
      payment_cents: (t.amount_cents || 0) < 0 ? -t.amount_cents : 0,
      total_cents: t.running_balance_cents,
    }));
    payCents = balanceCents;
  }

  const data = {
    asOf: asOfDate,
    association: { name: assocName },
    community_name: comm?.name || null,
    mgmt: MGMT,
    account_number: acctNumber,
    due_date: dueDate ? fmtDate(dueDate) : '',
    balance_cents: payCents,
    prior_balance_cents: balanceCents,
    addressee: addr,
    addressee_source: addrSource || null,
    property_label: `${acctNumber} - ${owner.street_address || ''}`.trim(),
    property_address: owner.street_address || '',
    notice: `Annual Assessments are due on January 1st and are delinquent after January 31st to avoid any penalties. Your balance may reflect a prior balance. If you have any questions, please contact our office at ${MGMT.phone}.`,
    activity,
    remit: { name: remit.name, block: remit.block },
    lockbox: remit.lockbox ? { bank: remit.lockbox.bank, association_code: remit.lockbox.association_code, scanline_verified: !!remit.lockbox.scanline_verified } : null,
    owner_name_raw: owner.owner_name || '',
  };
  data.scanline = buildScanline(data, remit.lockbox);
  return data;
}

// ---- scanline ---------------------------------------------------------------
// Bank coupon OCR line from the association's VERIFIED lockbox only
// (lib/payments/lockbox.js). No lockbox, or an account/amount the line cannot
// encode: no scanline at all, never a guessed one.
function buildScanline(data, lockbox) {
  const LB = require('../payments/lockbox');
  const lb = lockbox !== undefined ? lockbox : (data && data.lockbox ? LB.lockboxFor(data.community_name) : null);
  return LB.buildScanline(lb, { accountNumber: data.account_number, ownerName: data.owner_name_raw, amountCents: data.balance_cents });
}

// ---- render ----------------------------------------------------------------
// One Letter page per statement: the coupon is pinned to the bottom and the
// scanline prints inside the bank band (0.25-0.5 in from the bottom edge,
// 0.25 in clear border), OCR-A 12pt at 10 characters per inch.
const OCR_FONT = "'StatementOCR','OCR A Extended','OCR-A','OCRA','OCR A Std',monospace";
function statementPage(d, { sampleLabel = null } = {}) {
  const rows = d.activity.length
    ? d.activity.slice(-14).map((a) => `<tr${a.prior ? ' class="prior"' : ''}>
        <td>${esc(a.date ? String(a.date).slice(0, 10) : '')}</td>
        <td>${esc(a.description)}</td>
        <td class="num">${a.charge_cents ? money(a.charge_cents) : ''}</td>
        <td class="num">${a.payment_cents ? money(a.payment_cents) : ''}</td>
        <td class="num">${a.total_cents != null ? money(a.total_cents) : ''}</td></tr>`).join('')
    : `<tr class="prior"><td></td><td>-- Prior Balance --</td><td class="num"></td><td class="num"></td><td class="num">${money(d.balance_cents)}</td></tr>`;
  return `<section class="page${sampleLabel ? ' has-banner' : ''}">
  ${sampleLabel ? `<div class="sample">${esc(sampleLabel)}</div>` : ''}
  ${sampleLabel ? `<div class="banner">${esc(sampleLabel)}${d.sample_note ? `<div class="bnote">${esc(d.sample_note)}</div>` : ''}</div>` : ''}
  <div class="assoc">${esc(d.association.name)}<br>c/o ${esc(d.mgmt.name)}<br>${esc(d.mgmt.line1)}<br>${esc(d.mgmt.city)}</div>
  <div class="mid">
    <div class="to">${esc(d.addressee.name)}<br>${esc(d.addressee.street)}<br>${esc(d.addressee.cityline)}</div>
    <div class="box">
      <div class="title"><b>ACCOUNT STATEMENT</b><span>as of ${esc(fmtDate(d.asOf))}</span></div>
      <table class="acct"><tr><th>Account Number</th><th>Due Date</th><th>Pay This Amount</th></tr>
        <tr><td>${esc(d.account_number || '')}</td><td>${esc(d.due_date || '')}</td><td>${money(d.balance_cents)}</td></tr></table>
      <div class="notice">${esc(d.notice)}</div>
    </div>
  </div>
  <table class="activity">
    <thead><tr><th class="d">Date</th><th>Description</th><th class="num">Charges</th><th class="num">Payments</th><th class="num">Total</th></tr></thead>
    <tbody><tr class="prop"><td></td><td colspan="4">Property: ${esc(d.property_label)}</td></tr>${rows}</tbody>
  </table>
  <div class="coupon">
    <div class="detach">Please detach and return this portion with your payment.</div>
    <div class="cgrid">
      <div class="cleft">
        <div class="cassoc">${esc(d.remit.name)}</div>
        <div>${esc(d.addressee.name)}<br>RE: ${esc(d.property_label)}<br>${esc(d.addressee.street)}<br>${esc(d.addressee.cityline)}</div>
        <div class="mailhd">Mail Checks to:</div>
        <div>${esc(d.remit.block).replace(/\n/g, '<br>')}</div>
      </div>
      <div class="cright">
        <div class="payrow"><b>PAY THIS AMOUNT:</b><b>${money(d.balance_cents)}</b></div>
        <div class="payrow"><b>DUE DATE:</b><b>${esc(d.due_date || '')}</b></div>
        <div class="acctrow"><span>Account Number:</span><b>${esc(d.account_number || '')}</b></div>
        <div class="instr">Please include your account number on your check. Make check payable to your association. Please allow 10 to 15 business days for processing or pay through your owner portal for instant processing.</div>
      </div>
    </div>
    ${d.scanline ? `<div class="scan">${esc(d.scanline)}</div>` : ''}
  </div>
</section>`;
}

const STATEMENT_CSS = `
  @page { size: 8.5in 11in; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 10.5pt; }
  .page { position: relative; width: 8.5in; height: 11in; padding: 0.55in 0.6in 0 0.6in; page-break-after: always; overflow: hidden; background: #fff; }
  .page:last-child { page-break-after: auto; }
  .sample { position: absolute; top: 4.4in; left: 0; width: 8.5in; text-align: center; font-size: 28pt; font-weight: 700; color: rgba(200,0,0,.2); transform: rotate(-16deg); }
  .page.has-banner { padding-top: 0.95in; }
  .banner { position: absolute; top: 0.12in; left: 0.6in; right: 0.6in; border: 2px solid #c00; color: #c00; font-weight: 700; font-size: 11pt; text-align: center; padding: 3px 6px; background: #fff; }
  .bnote { font-weight: 400; font-size: 8pt; color: #800; margin-top: 1px; }
  .assoc { line-height: 1.45; font-size: 10pt; }
  .mid { display: flex; justify-content: space-between; margin-top: 0.18in; }
  .to { margin-top: 0.55in; line-height: 1.45; font-size: 10pt; width: 3.4in; }
  .box { width: 3.9in; }
  .title { display: flex; justify-content: space-between; align-items: baseline; font-size: 13pt; }
  .title span { font-size: 9pt; }
  table.acct { width: 100%; border-collapse: collapse; margin-top: 2px; }
  table.acct th { background: #000; color: #fff; font-weight: 400; font-size: 9pt; padding: 3px; }
  table.acct td { border: 1px solid #000; text-align: center; font-size: 9pt; padding: 3px; }
  .notice { border: 1px solid #000; background: #ffffc4; font-size: 8pt; padding: 3px 4px; min-height: 0.85in; }
  table.activity { width: 100%; border-collapse: collapse; margin-top: 0.22in; border: 1px solid #000; font-size: 10pt; }
  table.activity th { background: #000; color: #fff; text-align: left; padding: 4px 8px; }
  table.activity th.num, table.activity td.num { text-align: right; }
  table.activity td { padding: 2px 8px; }
  table.activity tr.prior td, table.activity tr.prop td { background: #e6e6e6; }
  .coupon { position: absolute; left: 0.6in; right: 0.6in; bottom: 0; height: 3.15in; }
  .detach { border-top: 1px dashed #000; text-align: center; font-size: 8pt; font-style: italic; padding-top: 1px; }
  .cgrid { display: flex; justify-content: space-between; margin-top: 0.08in; font-size: 10pt; line-height: 1.4; }
  .cleft { width: 4.1in; padding-left: 0.12in; }
  .cassoc { font-size: 12.5pt; }
  .mailhd { font-weight: 700; font-size: 11.5pt; margin: 0.12in 0 0.04in; }
  .cright { width: 2.95in; }
  .payrow { display: flex; justify-content: space-between; font-size: 12pt; margin-bottom: 2px; }
  .acctrow { display: flex; justify-content: space-between; margin: 0.1in 0; font-size: 10pt; }
  .instr { font-size: 9.5pt; line-height: 1.25; margin-top: 0.12in; }
  .scan { position: absolute; right: 0; bottom: 0.27in; font-family: ${OCR_FONT}; font-size: 12pt; letter-spacing: 0; white-space: pre; line-height: 1; }
  @media screen { body { background: #e9edf2; } .page { margin: 16px auto; box-shadow: 0 2px 14px rgba(0,0,0,.18); } }
`;

function renderStatementHTML(d, opts = {}) {
  return renderStatementsHTML([d], opts);
}
// Many statements, one per page, for a print batch.
// ocrFontDataUri: a data: URI of an OCR-A TrueType file. Print runs pass it so
// the PDF embeds OCR-A itself; a browser that cannot resolve the installed face
// by name silently falls back to a monospace font the bank cannot read.
function renderStatementsHTML(list, { sampleLabel = null, title = 'Account Statements', ocrFontDataUri = null } = {}) {
  const face = ocrFontDataUri ? `@font-face { font-family: 'StatementOCR'; src: url(${ocrFontDataUri}) format('truetype'); }` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${face}${STATEMENT_CSS}</style></head>
<body>${list.map((d) => statementPage(d, { sampleLabel })).join('\n')}</body></html>`;
}

module.exports = { buildStatementData, renderStatementHTML, renderStatementsHTML, buildScanline, OCR_FONT };
