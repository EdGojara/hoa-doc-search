// One-shot script: render sample HTML for the proposal + management agreement
// so Ed can see them in a browser before the rest of the New Business module
// is built. Writes both to ~/Downloads as HTML (open in any browser).

const fs = require('fs');
const path = require('path');

const { renderProposalHTML } = require('../lib/contracts/proposal');
const { renderManagementAgreementHTML } = require('../lib/contracts/management_agreement');

// ---------------- Sample PROPOSAL data (a fake prospect) ----------------
const sampleProspect = {
  community_name: 'Taj Residences',
  community_address: 'Richmond, TX 77407',
  community_legal_entity_name: 'Taj Residences Homeowners Association, Inc.',
  lot_count_estimated: 180,
  per_lot_monthly_fee: 3.50,
  monthly_fee_override: null,
  term_months: 12,
  target_start_date: '2026-07-01',
  current_manager: 'Generic Property Management, LLC',
};
const samplePrimaryContact = {
  name: 'Sarah Patel',
  role: 'President',
  email: 's.patel@example.com',
  phone: '(281) 555-0142',
};
const sampleProposalDefaults = { default_term_months: 12 };

// ---------------- Sample MANAGEMENT AGREEMENT data (Canyon Gate-shaped) ----------------
const sampleContract = {
  id: 'sample',
  version: 1,
  effective_date: '2025-11-01',
  end_date: null,
  payment_terms: 'Net 30',
  lot_count: 250,
  per_lot_monthly_fee: 10.00,
  monthly_fee_override: null,
  term_months: 12,
};
const sampleCommunity = {
  id: 'sample-community',
  name: 'Canyon Gate at Cinco Ranch',
  address: '20422 Canyon Gate Blvd., Katy, TX 77450',
  legal_entity_name: 'Canyon Gate at Cinco Ranch Home Owners Association, Inc.',
};
const sampleAgreementDefaults = {
  default_term_months: 12,
  contract_body_template: `<p>This Management Agreement (the "Agreement") is entered into as of {{effective_date}} between {{community_legal_entity}} (the "Association") and {{bedrock_legal_name}} ("Bedrock" or "Managing Agent") for an initial term of {{term_summary}}, renewing annually thereafter unless terminated as provided herein.</p>

<p><strong>Appointment.</strong> The Association hereby appoints Bedrock as its Managing Agent. Bedrock accepts the appointment subject to the terms and conditions set forth in this Agreement and the Exhibits attached hereto.</p>

<p><strong>Compensation.</strong> The Association shall pay Bedrock the monthly management fee identified below, payable monthly in advance. The monthly fee may be adjusted annually by the lesser of (i) the percentage increase in the U.S. City Average Consumer Price Index for All Urban Consumers (CPI-U), or (ii) five percent (5%), effective each January 1, subject to Board approval as part of the annual budget process.</p>

<p><strong>Termination.</strong> The Association may terminate this Agreement with cause on thirty (30) days' written notice, or without cause on sixty (60) days' written notice. Upon termination by the Association, the Association shall pay all amounts due through the effective date of termination plus an additional amount equal to the lesser of (i) three (3) months of base monthly management fees or (ii) the balance of fees remaining in the current term.</p>

<p><strong>Notices.</strong> All notices under this Agreement shall be sent to {{bedrock_legal_name}}, {{bedrock_address}}, with email copy to info@bedrocktx.com.</p>

<p><em>Note: This sample uses placeholder text in place of the full legal body. In production this template will hold Articles I–V (Responsibilities, Insurance, Term, Compensation, Miscellaneous) of the actual Bedrock management agreement.</em></p>

{{rate_sheet}}
{{signature_block}}`,
};
const sampleFixedItems = [
  { description: 'Monthly Management Fee', monthly_amount: 2500, sort_order: 1 },
  { description: 'Website and Homeowner/Board Portals', monthly_amount: 150, sort_order: 2 },
  { description: 'Onsite Staff (4 days/week)', monthly_amount: 2700, sort_order: 3 },
];
const sampleReimbursables = [
  { category: 'transition_setup', description: 'One-Time Transition Set-Up Fee', billing_method: 'at_cost', unit_price: 500, sort_order: 1 },
  { category: 'bw_copies', description: 'Black & White copies (excl. annual statements and meeting notices)', billing_method: 'per_unit', unit_price: 0.15, sort_order: 2 },
  { category: 'color_copies', description: 'Color copies (excl. annual statements and meeting notices)', billing_method: 'per_unit', unit_price: 0.25, sort_order: 3 },
  { category: 'annual_statement_billing', description: 'Annual Statement Billing & Annual Meeting Notice Mailings', billing_method: 'per_lot_plus_postage', unit_price: 3.00, sort_order: 4 },
  { category: 'work_outside', description: 'Work conducted outside of normal management functions', billing_method: 'hourly', unit_price: 75, sort_order: 5 },
  { category: 'event_staffing', description: 'Staffing community events', billing_method: 'hourly', unit_price: 35, sort_order: 6 },
  { category: 'postage', description: 'Postage (otherwise not listed)', billing_method: 'at_cost', unit_price: null, sort_order: 7 },
  { category: 'nsf', description: 'Insufficient Check Charge', billing_method: 'per_unit', unit_price: 35, sort_order: 8 },
];
const sampleOwnerCharges = [
  { category: 'mediation', description: 'Mediation / Court Appearances', fee_amount: 150, notes: 'per hour', sort_order: 1 },
  { category: 'late_reminder', description: 'Assessment Collection Late Reminder Notice', fee_amount: 25, sort_order: 2 },
  { category: 'assessment_certified_demand', description: 'Assessment Collection Certified Demand Letter', fee_amount: 50, sort_order: 3 },
  { category: 'deed_restriction_certified_demand', description: 'Deed Restriction Certified Demand Letter', fee_amount: 35, sort_order: 4 },
  { category: 'nsf_owner', description: 'Insufficient Check Charge', fee_amount: 35, sort_order: 5 },
  { category: 'attorney_referral', description: 'Accounts referred to Attorneys for Legal Action', fee_amount: 50, sort_order: 6 },
  { category: 'payment_plan', description: 'Payment Plan Fee', fee_amount: 35, sort_order: 7 },
  { category: 'arc_application', description: 'ARC Application Processing Fee', fee_amount: 25, sort_order: 8 },
];

// ---------------- Render + write ----------------
async function main() {
  const downloads = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');
  if (!fs.existsSync(downloads)) fs.mkdirSync(downloads, { recursive: true });

  const proposalHtml = await renderProposalHTML({
    prospect: sampleProspect,
    primaryContact: samplePrimaryContact,
    contacts: [samplePrimaryContact],
    defaults: sampleProposalDefaults,
    today: new Date('2026-05-15'),
  });
  const proposalPath = path.join(downloads, 'PREVIEW_Bedrock_Proposal_Taj_Residences.html');
  fs.writeFileSync(proposalPath, proposalHtml, 'utf8');

  const agreementHtml = await renderManagementAgreementHTML({
    contract: sampleContract,
    community: sampleCommunity,
    defaults: sampleAgreementDefaults,
    fixedItems: sampleFixedItems,
    reimbursables: sampleReimbursables,
    ownerCharges: sampleOwnerCharges,
  });
  const agreementPath = path.join(downloads, 'PREVIEW_Bedrock_Management_Agreement_Canyon_Gate.html');
  fs.writeFileSync(agreementPath, agreementHtml, 'utf8');

  console.log('Proposal preview:  ' + proposalPath);
  console.log('Agreement preview: ' + agreementPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
