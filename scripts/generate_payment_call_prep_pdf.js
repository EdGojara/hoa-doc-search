// ============================================================================
// generate_payment_call_prep_pdf.js
// ----------------------------------------------------------------------------
// One-off generator for Ed's call-prep document.
// Output: ~/OneDrive/Desktop/Payment_Architecture_Call_Prep_2026-05-22.pdf
//
// Captures the strategic context + the specific questions Ed needs to ask
// Melody (Vantaca) and the Stripe rep so he walks into both calls with a
// clear hypothesis to test rather than an open-ended fishing expedition.
// ============================================================================

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const NAVY = '#1A3050';
const GOLD = '#D4AF37';
const INK = '#1a1a1a';
const MUTED = '#6a7d8e';

const outPath = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'OneDrive', 'Desktop',
  'Payment_Architecture_Call_Prep_2026-05-22.pdf'
);

const doc = new PDFDocument({ size: 'LETTER', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
doc.pipe(fs.createWriteStream(outPath));

// ============================================================================
// Helpers
// ============================================================================
function H1(text) {
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20).text(text);
  doc.moveDown(0.3);
}
function H2(text, opts = {}) {
  if (opts.newPage) doc.addPage();
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(14).text(text);
  doc.fillColor(GOLD).rect(56, doc.y, 100, 2).fill();
  doc.moveDown(0.6);
}
function H3(text) {
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11.5).text(text);
  doc.moveDown(0.2);
}
function P(text) {
  doc.fillColor(INK).font('Helvetica').fontSize(10.5).text(text, { lineGap: 2, paragraphGap: 4 });
}
function Q(num, question, followups = []) {
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10.5).text(`Q${num}. `, { continued: true });
  doc.fillColor(INK).font('Helvetica-Bold').text(question, { lineGap: 2 });
  if (followups.length) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5);
    followups.forEach(f => doc.text(`   • ${f}`, { lineGap: 1.5 }));
  }
  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text('   Answer: ___________________________________________', { lineGap: 8 });
  doc.font('Helvetica').fontSize(10.5);
  doc.moveDown(0.3);
}
function Note(text) {
  const y = doc.y;
  doc.fillColor(GOLD).rect(56, y, 4, 1).fill(); // marker
  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10).text(text, 62, y, { width: 500, lineGap: 2 });
  doc.moveDown(0.5);
  doc.fillColor(INK).font('Helvetica').fontSize(10.5);
}

// ============================================================================
// Cover / title
// ============================================================================
// Gold cornerstone
doc.fillColor(GOLD);
const csX = 56, csY = 56, csW = 24, csH = 30;
doc.moveTo(csX, csY).lineTo(csX + csW, csY).lineTo(csX + csW * 0.95, csY + csH * 0.25).lineTo(csX + csW * 0.05, csY + csH * 0.25).closePath().fill();
doc.moveTo(csX + csW * 0.06, csY + csH * 0.31).lineTo(csX + csW * 0.94, csY + csH * 0.31).lineTo(csX + csW * 0.89, csY + csH * 0.61).lineTo(csX + csW * 0.11, csY + csH * 0.61).closePath().fill();
doc.moveTo(csX + csW * 0.13, csY + csH * 0.67).lineTo(csX + csW * 0.87, csY + csH * 0.67).lineTo(csX + csW * 0.83, csY + csH).lineTo(csX + csW * 0.17, csY + csH).closePath().fill();

doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('BEDROCK ASSOCIATION MANAGEMENT', 90, 60);
doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text('Strategic call prep · confidential', 90, 74);

doc.moveDown(3);
H1('Payment Architecture: Call Prep');
doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(11).text('For calls with Melody Hess (Vantaca) and Stripe representative', { lineGap: 2 });
doc.fillColor(MUTED).font('Helvetica').fontSize(10).text('Prepared 2026-05-22', { lineGap: 8 });
doc.moveDown(1);

// ============================================================================
// Strategic context
// ============================================================================
H2('Strategic context');
P('On a Stripe sales call, you learned VantacaPay is Stripe under the hood with a ~0.8% markup. Vantaca is also restricting Bedrock\'s bank choice (refusing your preferred regional bank). The bank they put Bedrock with has been unworkable.');
doc.moveDown(0.3);
P('The recommended path is direct Stripe Connect for ALL payments (assessments + non-assessment), with the HOA as the Connect destination account so money still flows to the HOA\'s bank account (anti-commingling discipline UNCHANGED). Bedrock then pushes payment data to Vantaca for GL posting — via API if Vantaca exposes one, or daily batch file if not.');
doc.moveDown(0.3);
P('Long-term direction: Bedrock\'s mirror becomes the source of truth for owner-facing balance, statements, and AR. Vantaca shrinks to back-office GL only. Same system-as-operator pattern that\'s been applied to DRV / ACC / reserves.');

doc.moveDown(0.5);
H3('Economic stake');
P('At current scale (7 communities × ~1,000 doors × $200/mo = $1.4M/yr in collections), the 0.8% markup is ~$11K/yr to VantacaPay. At franchise scale (50 communities), the same arithmetic = ~$960K/yr. Capturing it is pure margin.');

doc.moveDown(0.5);
H3('The discipline that must NOT change');
P('HOA assessment money never touches Bedrock\'s operating account, even temporarily. Stripe Connect pattern: each HOA is a connected merchant; charge splits at processor with application_fee_amount flowing to Bedrock and the rest settling directly to the HOA. One transaction, automatic split, zero commingling.');

doc.moveDown(0.5);
H3('Phased migration (don\'t jump straight to end-state)');
P('Phase 1 (now): direct Stripe Connect; daily batch file to Vantaca for GL posting. Saves 0.8% immediately, doesn\'t require Vantaca API.');
P('Phase 2 (3-6 mo): build Bedrock AR mirror; run in parallel with Vantaca; reconcile daily.');
P('Phase 3 (12+ mo): Bedrock generates statements + collections; Vantaca is GL of record only.');
P('Phase 4 (optional): replace Vantaca with cheaper GL (QuickBooks + class tracking, or HOA-specific GL).');

// ============================================================================
// Vantaca call (Melody)
// ============================================================================
H2('Questions for Melody / Vantaca', { newPage: true });

P('Frame the call positively: "We\'re working through how to integrate payments and want to understand the technical options before making decisions on the bank side." Don\'t reveal you found out about the 0.8% markup — let them disclose it, or note their evasion if they don\'t. Their willingness to discuss the markup honestly is itself a data point.');
doc.moveDown(0.4);

H3('Payment-posting integration');
Q(1, 'Does Vantaca expose a documented API for payment posting?', [
  'What\'s the auth flow (OAuth? API key? IP allow-list?)',
  'Rate limit? Idempotency model (so retries don\'t double-post)?',
  'Cost — included in subscription, or per-call?',
]);
Q(2, 'What\'s the payment-import batch file format if API isn\'t available?', [
  'CSV, fixed-width, IIF, OFX, or something proprietary?',
  'Can it ingest Stripe-flavored data (gross amount, processor fee, net, Stripe charge ID, owner reference)?',
  'How does Vantaca match the payment to an owner — by account number, name, address, or external ID?',
]);
Q(3, 'How does the system handle reversals — chargebacks, NSF returns, refunds?', [
  'If a Stripe payment fails 3 days after posting, can Vantaca reverse the posting cleanly?',
  'Does the reversal preserve the audit trail?',
]);

doc.moveDown(0.3);
H3('Bank flexibility');
Q(4, 'If Bedrock handles the payment processing (we own the Stripe merchant relationship) and just posts data to Vantaca, does the bank restriction still apply?', [
  'The current objection is "VantacaPay won\'t integrate with your regional bank." If we\'re not using VantacaPay, that constraint should disappear.',
  'Confirm whether Vantaca needs banking visibility at all when payment processing is external.',
]);

doc.moveDown(0.3);
H3('Pricing transparency');
Q(5, 'What\'s the markup or fee VantacaPay adds on top of the underlying processor rate?', [
  'Be direct. If they evade, that\'s the answer.',
  'Verify against Stripe\'s direct standard rate (2.9% + $0.30 for credit; 0.8% capped at $5 for ACH).',
]);
Q(6, 'What\'s the contract term — month-to-month, annual, multi-year? Termination clause?', [
  'Doesn\'t need acting on tonight; changes negotiating posture going forward.',
  'If there\'s an early-termination fee, get the dollar number.',
]);

doc.moveDown(0.3);
H3('Roadmap');
Q(7, 'Is Vantaca moving toward "bring your own processor" support?', [
  'If yes, when? If no, why not?',
  'Their answer here tells you whether they see direct-Stripe as a competitive threat (likely yes) or a roadmap item (probably no).',
]);

Note('If Vantaca is hostile to the direct-Stripe + batch-import architecture, that confirms they\'re extracting rent and the migration is the right move. If they\'re cooperative and have a clean API/import path, the migration becomes mechanically easy — they keep getting their subscription revenue, Bedrock keeps the 0.8%.');

// ============================================================================
// Stripe call
// ============================================================================
H2('Questions for Stripe', { newPage: true });

P('Frame: "We\'re an HOA management company looking at running our own Stripe Connect implementation. Each HOA we manage would be a connected merchant; we\'d collect a small platform fee. Want to understand the operational model before committing."');
doc.moveDown(0.4);

H3('Connect account model');
Q(8, 'For each HOA-as-Connect-merchant, which Connect type fits — Express, Custom, or Standard?', [
  'Boards aren\'t going to log into a Stripe dashboard. Express may be the right balance of KYC simplicity + dashboard access.',
  'Custom = Bedrock owns all the UX; Stripe is invisible to boards. Higher PCI burden but cleanest UX.',
  'Standard requires the HOA to fully own the Stripe account — wrong fit.',
]);
Q(9, 'What\'s the KYC/onboarding flow for a new HOA?', [
  'How long does it typically take from "start onboarding" to "can accept payments"?',
  'What documents does the board need (EIN, governing docs, bank account info, beneficial owners)?',
  'For a multi-board HOA with rotating members, who signs as the "responsible party"?',
]);
Q(10, 'What\'s the platform fee model?', [
  'application_fee_amount per charge — does it have a minimum or maximum?',
  'Can it be a flat fee or a percentage?',
  'Does Bedrock\'s platform fee get withheld from Stripe\'s payout to the HOA automatically?',
]);

doc.moveDown(0.3);
H3('Payment methods');
Q(11, 'Pricing for ACH vs. card on Connect?', [
  'Most homeowners prefer ACH for recurring HOA dues (lower fee).',
  'Verify ACH on Connect is the same 0.8% capped at $5 as direct Stripe.',
  'How long does ACH take to clear / settle to the HOA\'s account?',
]);
Q(12, 'Does Connect support recurring billing (Subscriptions API) for monthly assessments?', [
  'Most assessment plans are monthly recurring — homeowner authorizes once, billed automatically every month.',
  'How are failed retries handled (smart retry logic, dunning emails)?',
  'Can subscriptions be paused / restructured (e.g., for hardship payment plans)?',
]);

doc.moveDown(0.3);
H3('Reporting + reconciliation');
Q(13, 'How does Stripe report payments to Bedrock for posting into Vantaca?', [
  'Webhook on charge.succeeded / payment_intent.succeeded — preferred for real-time.',
  'Daily exports / reports — backup or batch path.',
  'Does the report include the gross / fee / net / connected account / application fee breakdown?',
]);
Q(14, 'For chargebacks on a Connect charge — who is liable?', [
  'If a homeowner disputes an assessment payment, does the dispute hit the HOA\'s Stripe account or Bedrock\'s platform account?',
  'Important for: anti-commingling discipline AND for boards understanding their exposure.',
]);

doc.moveDown(0.3);
H3('Bedrock-specific');
Q(15, 'What\'s the path to switch from VantacaPay → direct Stripe Connect?', [
  'Migration support? Onboarding tools for the existing 7 HOAs?',
  'Anyone at Stripe who\'s helped an HOA platform make this exact transition?',
]);
Q(16, 'Reference customers — any other HOA management or property management companies running Connect at scale?', [
  'Useful for benchmarking the architecture.',
  'They may or may not name them — but a "yes we have several" or "you\'d be one of the first" is signal.',
]);

Note('Push Stripe to commit a sales engineer or solutions architect for the Phase 1 build. The Connect onboarding flow + webhook architecture + ACH settlement timing all benefit from one direct integration contact at Stripe rather than going through generic docs.');

// ============================================================================
// Decision criteria
// ============================================================================
H2('Decision criteria after the calls', { newPage: true });

H3('Path forward if Vantaca has a clean API or import:');
P('Direct Stripe Connect + daily batch file (or API push if available) → Vantaca GL. Saves 0.8% immediately. Phase 2 mirror build follows in 3-6 months. Vantaca keeps its subscription; Bedrock captures the processor margin.');

doc.moveDown(0.4);
H3('Path forward if Vantaca refuses bank-flexibility OR has hostile API/import terms:');
P('Same Phase 1 architecture is still right, but the relationship is now adversarial — accelerate Phase 2-4. Plan for full Vantaca replacement at 18-24 months. Start vetting alternative GL systems (HOAStart, AppFolio, or QuickBooks-with-class-tracking depending on scale).');

doc.moveDown(0.4);
H3('Red flags from Stripe call:');
P('• Connect onboarding takes 30+ days per HOA → wrong product for HOA pace.');
P('• Application fee structure is rigid (% only, no flat) → may not work for low-dollar non-assessment items.');
P('• Chargeback liability lands on Bedrock\'s platform account, not the HOA → reconsider liability structure.');

doc.moveDown(0.4);
H3('Anti-commingling check (NON-NEGOTIABLE):');
P('Whatever architecture lands, HOA assessment money must NEVER pass through Bedrock\'s operating account. The Stripe Connect pattern with HOA as destination is designed for this. Verify the chosen path preserves it. If any proposed architecture routes assessment money through a Bedrock account "for clearing" — reject.');

doc.moveDown(0.5);
H2('Quick reference — phased migration');
const phaseTbl = [
  ['Phase 1 — Now (transitional)', 'Direct Stripe Connect for assessments + non-assessment. Daily batch file to Vantaca for GL. Vantaca still owns statements, AR, collections. Saves 0.8% immediately.'],
  ['Phase 2 — 3-6 months', 'Build Bedrock AR mirror (balances, aging, statements). Run in parallel with Vantaca. Reconcile daily.'],
  ['Phase 3 — 12+ months', 'Bedrock generates statements + runs collections from the mirror. Vantaca is GL of record only.'],
  ['Phase 4 — Optional', 'Replace Vantaca with cheaper GL when math shifts. Migration is straightforward — Bedrock owns the operational data.'],
];
phaseTbl.forEach(([title, body]) => {
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(10.5).text(title);
  doc.fillColor(INK).font('Helvetica').fontSize(10).text(body, { lineGap: 2, paragraphGap: 6 });
});

// Footer
doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8).text(
  'Bedrock Association Management · Strategic call prep · Confidential',
  56, 750, { width: 500, align: 'center' }
);

doc.end();
console.log('Wrote PDF to:', outPath);
