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
//
// ANNUAL RUN EXTRAS (Ed 2026-11-22):
//   * the notice (delinquency) sentence comes from the run (each association's
//     collection policy), never a hard-coded rule; the default states none;
//   * an optional portal ANNOUNCEMENT page before each statement, rendered from
//     a validated JSON input (resolveAnnouncement), never free text; its fee
//     lines come from lib/payments/fee_quote (the same lines the portal shows);
//   * the coupon names exactly one online channel (trustEd), and only when an
//     announcement says so; it never claims "instant processing".
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
const moneyAbs = (cents) => '$' + (Math.round(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (c) => (Number(c) < 0 ? '-' : '') + moneyAbs(Math.abs(Number(c) || 0));
const fmtDate = (d) => { if (!d) return ''; try { return new Date(String(d).length <= 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-US'); } catch (_) { return ''; } };

// ---- data ------------------------------------------------------------------
// billing (annual statement run): { year, assessment_cents, due_date: 'YYYY-MM-DD' }
//   The statement then shows the prior balance and the year's annual assessment
//   (like Vantaca's annual statement) and asks for prior balance + assessment.
//   The assessment must come from an APPROVED rate (scripts/build_annual_statements
//   refuses otherwise); this module never invents an amount.
// noticeText: the run's delinquency wording (the association's collection
//   policy). Omitted: a neutral notice that states no delinquency rule.
const DEFAULT_NOTICE = `Your balance may include a prior balance. If you have any questions, please contact our office at ${MGMT.phone}.`;
// A ledger line in plain words for the homeowner: processor payout references
// and settlement dates are bank bookkeeping, not part of what the owner paid.
function activityLabel(t) {
  const d = String(t.description || '').trim();
  if (t.txn_type === 'payment' || /^payment\b/i.test(d) || /^chk #/i.test(d)) {
    const chk = /(?:chk|check)\s*#?\s*(\d{2,})/i.exec(d);
    const how = chk ? `check #${chk[1]}` : /card/i.test(d) ? 'card' : /e-?check|ach/i.test(d) ? 'eCheck' : null;
    if (t.amount_cents < 0) return how ? `Payment received (${how})` : 'Payment received';
  }
  if (/^interest \d{4}/i.test(d)) return 'Late interest';
  if (/^interest correction\b/i.test(d)) return 'Late interest adjustment';
  if (/failed return|bank return/i.test(d)) return 'Returned payment fee';
  if (/^returned payment/i.test(d)) return 'Returned payment';
  return d.replace(/\s*\((?:settled|deposited)[^)]*\)/ig, '').replace(/\s*VPAY payout \d{4}-\d{2}-\d{2}/ig, '').slice(0, 80) || 'Account activity';
}

// Balance forward + the payments, credits and charges since activity_from. The
// opening figure is DERIVED (balance less the listed lines), so the statement
// always foots to the ledger; a ledger whose lines do not add up to the balance
// view is refused, never printed.
const MAX_ACTIVITY = 9;
const mdyDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${+m[2]}/${+m[3]}/${m[1]}` : String(iso || ''); };
function activityWindow(ledger, balanceCents, from) {
  const all = ledger || [];
  const total = all.reduce((a, r) => a + Number(r.amount_cents || 0), 0);
  if (total !== balanceCents) throw new Error(`ledger lines total ${total}, balance is ${balanceCents}: held for review`);
  let rows = all.filter((r) => String(r.transaction_date).slice(0, 10) >= from && Number(r.amount_cents || 0) !== 0);
  if (rows.length > MAX_ACTIVITY) rows = rows.slice(-MAX_ACTIVITY);
  const opening = balanceCents - rows.reduce((a, r) => a + Number(r.amount_cents || 0), 0);
  // The balance forward is the balance BEFORE the first line shown (later than activity_from
  // when older lines were folded in), so the label always names that date.
  const forwardBefore = rows.length ? String(rows[0].transaction_date).slice(0, 10) : from;
  return { opening, rows, forwardBefore };
}

async function buildStatementData(supabase, propertyId, { asOf, billing = null, noticeText = null } = {}) {
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
    let opening = balanceCents; let since = []; let forwardBefore = null;
    if (billing.activity_from) ({ opening, rows: since, forwardBefore } = activityWindow(await currentOwnerActivity(supabase, propertyId, { ascending: true }), balanceCents, billing.activity_from));
    let run = opening;
    activity = [
      { date: null, description: billing.activity_from ? `-- Balance Forward (before ${mdyDate(forwardBefore)}) --` : '-- Prior Balance --', charge_cents: 0, payment_cents: 0, total_cents: opening, prior: true },
      ...since.map((r) => { const c = Number(r.amount_cents); run += c; return { date: r.transaction_date, description: activityLabel(r), charge_cents: c > 0 ? c : 0, payment_cents: c < 0 ? -c : 0, total_cents: run }; }),
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
    notice: noticeText && String(noticeText).trim() ? String(noticeText).trim() : DEFAULT_NOTICE,
    activity,
    // What is due when: a prior balance is already due; the new assessment is not yet.
    due_split: billing && balanceCents > 0 ? [{ label: 'Prior balance, due now', cents: balanceCents }, { label: `${billing.year} assessment, due ${fmtDate(billing.due_date)}`, cents: Math.round(Number(billing.assessment_cents)) }]
      : billing && balanceCents < 0 ? [{ label: `${billing.year} assessment, due ${fmtDate(billing.due_date)}`, cents: Math.round(Number(billing.assessment_cents)) }, { label: 'Less credit on account', cents: balanceCents }] : null,
    disclosure: billing && billing.disclosure ? String(billing.disclosure).trim() : null,
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
function statementPage(d, { sampleLabel = null, ann = null } = {}) {
  const rows = d.activity.length
    ? d.activity.slice(-14).map((a) => `<tr${a.prior ? ' class="prior"' : ''}>
        <td class="d">${esc(a.date ? fmtDate(a.date) : '')}</td>
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
  ${d.disclosure ? `<div class="disclosure">${esc(d.disclosure)}</div>` : ''}
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
        ${d.due_split ? d.due_split.map((x) => `<div class="splitrow"><span>${esc(x.label)}</span><span>${money(x.cents)}</span></div>`).join('') : ''}
        <div class="acctrow"><span>Account Number:</span><b>${esc(d.account_number || '')}</b></div>
        <div class="instr">${couponInstructions(d, ann)}</div>
      </div>
    </div>
    ${d.scanline ? `<div class="scan">${esc(d.scanline)}</div>` : ''}
  </div>
</section>`;
}

// An account handled by counsel: the year's assessment and the firm to contact.
// No balance, no coupon, no remittance address, no online payment. Counsel
// approves the wording and the mailing before it is used; a bankruptcy account
// never gets one (the builder leaves it out).
const COUNSEL_MESSAGE = 'Your account is currently being handled by legal counsel. Please contact the law firm listed below regarding your account balance and payment arrangements.';
function counselNoticePage(d, { year, assessment_cents, due_date, firm, sampleLabel = null }) {
  if (!firm || !firm.name || !(firm.lines || []).length) throw new Error('counsel_notice_needs_firm_contact');
  return `<section class="page${sampleLabel ? ' has-banner' : ''}">
  ${sampleLabel ? `<div class="sample">${esc(sampleLabel)}</div><div class="banner">${esc(sampleLabel)}</div>` : ''}
  <div class="assoc">${esc(d.association.name)}<br>c/o ${esc(d.mgmt.name)}<br>${esc(d.mgmt.line1)}<br>${esc(d.mgmt.city)}</div>
  <div class="mid">
    <div class="to">${esc(d.addressee.name)}<br>${esc(d.addressee.street)}<br>${esc(d.addressee.cityline)}</div>
    <div class="box">
      <div class="title"><b>NOTICE OF ${esc(String(year))} ASSESSMENT</b><span>${esc(fmtDate(d.asOf))}</span></div>
      <table class="acct"><tr><th>Account Number</th><th>Due Date</th><th>${esc(String(year))} Annual Assessment</th></tr>
        <tr><td>${esc(d.account_number || '')}</td><td>${esc(fmtDate(due_date))}</td><td>${money(assessment_cents)}</td></tr></table>
    </div>
  </div>
  <div class="cnote">
    <p>Property: ${esc(d.property_address)}</p>
    <p>The ${esc(String(year))} annual assessment for this property is ${money(assessment_cents)}, due ${esc(fmtDate(due_date))}. This notice states the ${esc(String(year))} assessment only. It is not a statement of your account balance.</p>
    <p><b>${esc(COUNSEL_MESSAGE)}</b></p>
    <p class="firm"><b>${esc(firm.name)}</b><br>${firm.lines.map(esc).join('<br>')}</p>
  </div>
  ${d.disclosure ? `<div class="disclosure">${esc(d.disclosure)}</div>` : ''}
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
  .disclosure { margin-top: 0.14in; border: 1px solid #000; padding: 5px 8px; font-size: 9pt; line-height: 1.35; }
  .cnote { margin-top: 0.5in; font-size: 11pt; line-height: 1.5; }
  .cnote .firm { margin-left: 0.3in; }
  .coupon { position: absolute; left: 0.6in; right: 0.6in; bottom: 0; height: 3.15in; }
  .detach { border-top: 1px dashed #000; text-align: center; font-size: 8pt; font-style: italic; padding-top: 1px; }
  .cgrid { display: flex; justify-content: space-between; margin-top: 0.08in; font-size: 10pt; line-height: 1.4; }
  .cleft { width: 4.1in; padding-left: 0.12in; }
  .cassoc { font-size: 12.5pt; }
  .mailhd { font-weight: 700; font-size: 11.5pt; margin: 0.12in 0 0.04in; }
  .cright { width: 2.95in; }
  .payrow { display: flex; justify-content: space-between; font-size: 12pt; margin-bottom: 2px; }
  .splitrow { display: flex; justify-content: space-between; font-size: 9.5pt; line-height: 1.3; }
  table.activity td.d { white-space: nowrap; width: 0.95in; }
  .acctrow { display: flex; justify-content: space-between; margin: 0.1in 0; font-size: 10pt; }
  .instr { font-size: 9.5pt; line-height: 1.25; margin-top: 0.12in; }
  .scan { position: absolute; right: 0; bottom: 0.27in; font-family: ${OCR_FONT}; font-size: 12pt; letter-spacing: 0; white-space: pre; line-height: 1; }
  @media screen { body { background: #e9edf2; } .page { margin: 16px auto; box-shadow: 0 2px 14px rgba(0,0,0,.18); } }
`;

// ---- portal announcement (annual run) -----------------------------------------
// Input: a JSON file per association (scripts/build_annual_statements --announce).
// Facts only; every sentence below is fixed here, so the page cannot freestyle.
//   {
//     "schema": "trusted.statement_announcement.v1",
//     "community": "<communities.name>",          must match the run
//     "year": 2027,                                must match --year
//     "portal_url": "https://.../portal-login.html",
//     "portal_features": ["arc", ...],             keys of PORTAL_FEATURES; each
//                                                  must be live in the community's
//                                                  portal_module_config
//     "switch_date": "YYYY-MM-DD",                 first day online payment is
//                                                  trustEd only
//     "vantaca_end_date": "YYYY-MM-DD",            last day Vantaca takes online
//                                                  payments (must be before the
//                                                  switch date: one channel at a time)
//     "notice_text": "...",                        statement notice (collection policy)
//     "support": { "email": "...", "phone": "..." },
//     "preview_note": "..."                        preview banner only (optional)
//   }
// A value written as "[[...]]" is a PLACEHOLDER for a decision not yet made:
// allowed (and highlighted) in a preview, refused in a final run. Keys starting
// with "_" are comments and ignored. Unknown keys are refused.
// Fees come from communities.portal_module_config.payment_fees (lib/payments/
// fee_quote). Not configured: a final run refuses; a preview shows
// PREVIEW_FEE_CONFIG labeled as pending.
const PORTAL_FEATURES = {
  arc: 'Submit an architectural (ARC) request and follow it to a decision',
  compliance: 'See any compliance notices for your home',
  messages: 'Send a message to our team',
  events: 'See community events',
  share_news: 'Read community news',
  vendor_directory: 'Use the community vendor directory',
  claire: 'Ask Claire, our AI assistant, questions about your community',
  documents: "Read your community's governing documents",
  financials: 'See your account balance and activity',
};
// Proposed schedule (Ed 2026-11-21), PREVIEW ONLY until set per association.
const PREVIEW_FEE_CONFIG = Object.freeze({ card_fee_bps: 350, debit_card_fee_bps: null, ach_fee_cents: 295, ach_tier_threshold_cents: 35000, ach_fee_above_cents: 595 });
const ANN_SCHEMA = 'trusted.statement_announcement.v1';
const ANN_KEYS = ['schema', 'community', 'year', 'portal_url', 'portal_features', 'switch_date', 'vantaca_end_date', 'notice_text', 'support', 'preview_note'];

const isPlaceholder = (v) => typeof v === 'string' && /^\[\[[\s\S]*\]\]$/.test(v.trim());
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const longDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// -> { ok, errors: [], warnings: [], ann }
// community: { name, portal_module_config }. preview: placeholders and pending
// fees allowed (and flagged), never in a final run.
function resolveAnnouncement(raw, { community, year = null, preview = false } = {}) {
  const FQ = require('../payments/fee_quote');
  const errors = []; const warnings = [];
  const bad = (msg) => errors.push(msg);
  const held = (msg) => (preview ? warnings.push(msg) : errors.push(msg));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['announcement must be a JSON object'], warnings, ann: null };
  for (const k of Object.keys(raw)) if (!k.startsWith('_') && !ANN_KEYS.includes(k)) bad(`unknown announcement field "${k}"`);
  if (raw.schema !== ANN_SCHEMA) bad(`schema must be "${ANN_SCHEMA}"`);
  if (!community || raw.community !== community.name) bad(`announcement is for "${raw.community}", not "${community && community.name}"`);
  if (year != null && Number(raw.year) !== Number(year)) bad(`announcement year ${raw.year} does not match the run year ${year}`);

  // A text field: a real value, or a placeholder (preview only).
  const text = (key, v, { required = true } = {}) => {
    if (v == null || String(v).trim() === '') { if (required) bad(`${key} is required`); return null; }
    if (typeof v !== 'string') { bad(`${key} must be text`); return null; }
    if (isPlaceholder(v)) { held(`${key} is still a placeholder: ${v.trim()}`); return { ph: v.trim().slice(2, -2).trim() }; }
    return { text: v.trim() };
  };
  const date = (key, v) => {
    const t = text(key, v);
    if (!t || t.ph) return t;
    if (!ISO_DATE.test(t.text) || Number.isNaN(Date.parse(t.text + 'T00:00:00Z'))) { bad(`${key} must be YYYY-MM-DD`); return null; }
    return { text: longDate(t.text), iso: t.text };
  };

  let portal = text('portal_url', raw.portal_url);
  if (portal && portal.text) {
    try {
      const u = new URL(portal.text);
      if (u.protocol !== 'https:') bad('portal_url must be https');
      portal = { text: portal.text, display: (u.host + u.pathname).replace(/\/$/, '') };
    } catch (_) { bad('portal_url is not a valid URL'); portal = null; }
  } else if (portal && portal.ph) portal = { ph: portal.ph };

  const cfg = (community && community.portal_module_config && typeof community.portal_module_config === 'object') ? community.portal_module_config : {};
  const features = [];
  if (!Array.isArray(raw.portal_features) || !raw.portal_features.length) bad('portal_features must list at least one feature');
  else {
    for (const k of raw.portal_features) {
      if (!PORTAL_FEATURES[k]) { bad(`unknown portal feature "${k}" (known: ${Object.keys(PORTAL_FEATURES).join(', ')})`); continue; }
      const live = cfg[k] && cfg[k].status === 'live';
      if (!live) held(`portal feature "${k}" is not live for ${community && community.name}`);
      features.push({ key: k, text: PORTAL_FEATURES[k], pending: !live });
    }
  }

  const switchDate = date('switch_date', raw.switch_date);
  const vantacaEnd = date('vantaca_end_date', raw.vantaca_end_date);
  if (switchDate && vantacaEnd && switchDate.iso && vantacaEnd.iso && !(vantacaEnd.iso < switchDate.iso)) {
    bad('vantaca_end_date must be before switch_date (only one online payment channel open at a time)');
  }
  const notice = text('notice_text', raw.notice_text, { required: false });
  if (notice && notice.ph) bad('notice_text cannot be a placeholder (it prints on every statement)');

  const sup = raw.support && typeof raw.support === 'object' ? raw.support : {};
  const email = text('support.email', sup.email);
  const phone = text('support.phone', sup.phone);
  if (email && email.text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.text)) bad('support.email is not an email address');
  if (phone && phone.text && (phone.text.replace(/\D/g, '').length < 10)) bad('support.phone is not a phone number');

  const fc = FQ.feeConfigFromCommunity(community);
  let fees;
  if (fc.ok) fees = { lines: FQ.feeScheduleLines(fc.config), pending: false };
  else if (preview) {
    warnings.push(`payment fees are not configured for ${community && community.name} (${fc.detail}); the preview shows the proposed schedule, labeled pending`);
    fees = { lines: FQ.feeScheduleLines(PREVIEW_FEE_CONFIG), pending: true };
  } else bad(`payment fees are not configured for ${community && community.name}: set communities.portal_module_config.payment_fees (${fc.detail})`);

  const ok = errors.length === 0;
  return {
    ok, errors, warnings,
    ann: ok ? {
      year: Number(raw.year), portal, features, switch_date: switchDate, vantaca_end_date: vantacaEnd,
      notice_text: notice && notice.text ? notice.text : null,
      support: { email, phone }, fees,
      preview_note: typeof raw.preview_note === 'string' && raw.preview_note.trim() ? raw.preview_note.trim() : null,
    } : null,
  };
}

// A resolved field -> HTML (a placeholder prints highlighted, never as fact).
const fv = (f) => (!f ? '' : f.ph ? `<span class="ph">[${esc(f.ph)}]</span>` : esc(f.display || f.text));

// Coupon payment line. Checks always; online only when the run's announcement
// names trustEd (one online channel, never "instant processing").
function couponInstructions(d, ann = null) {
  if (!ann) return 'Please include your account number on your check. Make check payable to your association. Please allow 10 to 15 business days for processing.';
  return `Make your check payable to ${esc(d.remit.name)} and write your account number on it. Allow 10 to 15 business days for mailed checks. `
    + `Starting ${fv(ann.switch_date)}, you can also pay online in the trustEd portal at ${fv(ann.portal)} (processing fee applies; see enclosed notice).`;
}

function announcementPage(d, ann, { sampleLabel = null } = {}) {
  const a = esc(d.association.name);
  const feat = ann.features.map((f) => `<li>${esc(f.text)}${f.pending ? ' <span class="ph">[not live yet for this association]</span>' : ''}</li>`).join('');
  const fee = ann.fees.lines;
  const feeItems = [`<li>Credit or debit card: ${esc(fee.card)}${fee.debit ? `; ${esc(fee.debit)}` : ''}</li>`, `<li>Bank account (ACH): ${esc(fee.ach)}</li>`].join('');
  const pending = ann.fees.pending ? ' <span class="ph">[PENDING: fees are not yet configured for this association; the proposed schedule is shown]</span>' : '';
  const note = d.sample_note || ann.preview_note;
  return `<section class="page ann${sampleLabel ? ' has-banner' : ''}">
  ${sampleLabel ? `<div class="sample">${esc(sampleLabel)}</div>` : ''}
  ${sampleLabel ? `<div class="banner">${esc(sampleLabel)}${note ? `<div class="bnote">${esc(note)}</div>` : ''}</div>` : ''}
  <div class="ahead"><div class="aname">${a}</div><div class="asub">c/o ${esc(d.mgmt.name)} &middot; ${esc(d.mgmt.line1)} &middot; ${esc(d.mgmt.city)}</div></div>
  <h1>Your new trustEd homeowner portal</h1>
  <p>${a} is moving its homeowner portal and online payments from Vantaca to trustEd, the homeowner portal from ${esc(d.mgmt.name)}. Your ${esc(ann.year)} annual assessment statement is enclosed.</p>
  <h2>What you can do in trustEd</h2>
  <ul>${feat}</ul>
  <h2>How to sign in (no password)</h2>
  <ol>
    <li>Go to <b>${fv(ann.portal)}</b></li>
    <li>Enter the email address we have on file for you. We will email you a sign-in link.</li>
    <li>Open the email and click the link, then click <b>Sign in</b> on the page that opens.</li>
  </ol>
  <p class="small">Each link works once. If yours has expired, enter your email again for a new one. No email on file, or want to use a different one? Email <b>${fv(ann.support.email)}</b> or call <b>${fv(ann.support.phone)}</b> and we will set you up.</p>
  <h2>How to pay</h2>
  <p><b>Online in trustEd</b> (starting ${fv(ann.switch_date)}): sign in and choose Pay. A processing fee is added to online payments:${pending}</p>
  <ul>${feeItems}</ul>
  <p class="small">The fee and your total are shown before you confirm a payment. The processing fee is separate from your assessment. There is no fee to pay by check.</p>
  <p><b>By check:</b> make your check payable to <b>${esc(d.remit.name)}</b>, write your account number <b>${esc(d.account_number || '')}</b> on the check, and mail it with the coupon at the bottom of your statement to:</p>
  <div class="remit">${esc(d.remit.block).replace(/\n/g, '<br>')}</div>
  <h2>Changes from Vantaca</h2>
  <ul>
    <li>Starting ${fv(ann.switch_date)}, trustEd is the only place to pay online. Online payments through the Vantaca portal end on ${fv(ann.vantaca_end_date)}.</li>
    <li><b>Automatic payments do not transfer.</b> If you pay automatically through Vantaca, that automatic payment ends on ${fv(ann.vantaca_end_date)}. To keep paying automatically, sign in to trustEd and set up autopay again.</li>
    <li>Checks are still accepted. Your account number does not change.</li>
  </ul>
  <p class="small">Questions? Email ${fv(ann.support.email)} or call ${fv(ann.support.phone)}.</p>
</section>`;
}

const ANNOUNCE_CSS = `
  .ann { font-size: 10pt; line-height: 1.3; }
  .ann h1 { font-size: 16pt; margin: 0.1in 0 0.04in; color: #1A3050; }
  .ann h2 { font-size: 11.5pt; margin: 0.09in 0 0.02in; color: #1A3050; }
  .ann ul, .ann ol { margin: 0.02in 0 0.02in 0.1in; padding-left: 0.2in; }
  .ann li { margin: 1px 0; }
  .ann p { margin: 0.04in 0; }
  .ann .small { font-size: 9pt; }
  .ahead { border-bottom: 2px solid #D4AF37; padding-bottom: 4px; }
  .aname { font-size: 13pt; font-weight: 700; }
  .asub { font-size: 8.5pt; color: #444; }
  .remit { margin: 0.02in 0 0.03in 0.3in; font-weight: 700; line-height: 1.25; }
  .ph { background: #fff3a6; color: #7a4b00; font-weight: 700; padding: 0 2px; }
`;

function renderStatementHTML(d, opts = {}) {
  return renderStatementsHTML([d], opts);
}
// Many statements, one per page, for a print batch.
// ocrFontDataUri: a data: URI of an OCR-A TrueType file. Print runs pass it so
// the PDF embeds OCR-A itself; a browser that cannot resolve the installed face
// by name silently falls back to a monospace font the bank cannot read.
// announcement: a resolveAnnouncement().ann; its page prints before each
// statement (it carries that homeowner's account number and remit address).
function renderCounselNoticesHTML(list, { sampleLabel = null, title = 'Assessment Notices', year, assessment_cents, due_date } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STATEMENT_CSS}</style></head><body>${list.map((x) => counselNoticePage(x.d, { year, assessment_cents, due_date, firm: x.firm, sampleLabel })).join('\n')}</body></html>`;
}

function renderStatementsHTML(list, { sampleLabel = null, title = 'Account Statements', ocrFontDataUri = null, announcement = null } = {}) {
  const face = ocrFontDataUri ? `@font-face { font-family: 'StatementOCR'; src: url(${ocrFontDataUri}) format('truetype'); }` : '';
  const ann = announcement || null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${face}${STATEMENT_CSS}${ann ? ANNOUNCE_CSS : ''}</style></head>
<body>${list.map((d) => (ann ? announcementPage(d, ann, { sampleLabel }) + '\n' : '') + statementPage(d, { sampleLabel, ann })).join('\n')}</body></html>`;
}

module.exports = {
  buildStatementData, activityWindow, activityLabel, renderCounselNoticesHTML, COUNSEL_MESSAGE, renderStatementHTML, renderStatementsHTML, buildScanline, OCR_FONT,
  resolveAnnouncement, couponInstructions, isPlaceholder, PORTAL_FEATURES, PREVIEW_FEE_CONFIG, DEFAULT_NOTICE,
};
