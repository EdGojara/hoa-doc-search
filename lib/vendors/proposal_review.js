// ============================================================================
// lib/vendors/proposal_review.js  (Ed 2026-10-16: multi-lens risk and
// completeness review for material proposals, contracts and capital projects)
// ----------------------------------------------------------------------------
// Amanda reviews a material proposal the way an experienced community manager
// with a CPA, attorney-risk and risk-management mindset would. She never holds
// herself out as legal counsel: contract findings are FLAGS for counsel review
// ("missing", "unclear", "one-sided", "adverse"), never legal conclusions.
//
// Four lenses, each finding tagged with where it came from:
//   operational   does it solve the Board's problem; scope gaps; schedule; failure
//   financial     cost, TCO, tax, payment terms, budget and cash impact (with the
//                 data-confidence label), reserve eligibility, change-order exposure
//   contract      term, renewal, termination, warranty, indemnity, liability,
//                 insurance, equipment and data ownership, export, cyber/privacy,
//                 service levels, subcontractors, venue, change orders, acceptance
//   risk          delay, downtime, power/internet, retention and data loss, cyber,
//                 vendor dependency, implementation, risk shifted onto the HOA
//
//   source: 'proposal' | 'board_message' | 'trustEd:<table>'  (community context)
//
// Output sections (stored on the RFP / Bid Workflow record): strengths,
// weaknesses_risks, missing_documents, required_conditions, counsel_review,
// community_context_used, and THREE SEPARATE conclusions: vendor recommendation,
// project recommendation, contract readiness. A recommended vendor's weaknesses
// are never hidden.
// ============================================================================

const money0 = (c) => '$' + Math.round(Number(c || 0) / 100).toLocaleString('en-US');
const money = (c) => (c == null ? 'not priced' : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Contract terms an executable agreement should address. legal: true = counsel-review class.
const CONTRACT_TERMS = [
  ['term_renewal', 'term, renewal and auto-renewal', true],
  ['termination', 'termination rights', true],
  ['cancellation_penalty', 'cancellation penalties', true],
  ['warranty', 'warranty', false],
  ['indemnification', 'indemnification', true],
  ['limitation_of_liability', 'limitation of liability', true],
  ['insurance', 'insurance requirements', true],
  ['equipment_ownership', 'ownership of installed equipment', true],
  ['data_ownership', 'ownership and control of video, data, credentials and cloud records', true],
  ['data_export', 'access to and export of data after termination', true],
  ['cybersecurity_privacy', 'cybersecurity and privacy obligations', true],
  ['service_levels', 'service levels and response times', false],
  ['subcontractors', 'subcontractor responsibility', true],
  ['governing_law', 'governing law and venue', true],
  ['change_orders', 'change-order authorization', true],
  ['acceptance', 'acceptance criteria', false],
];

// Documents an executable package should include. relevant(n) decides when one applies.
const DOCUMENTS = [
  ['contract', 'full contract or master services agreement', () => true],
  ['terms', 'terms and conditions', () => true],
  ['sow', 'statement of work', () => true],
  ['warranty_schedule', 'warranty schedule', () => true],
  ['sla', 'service level agreement', (n) => n.recurring.length > 0],
  ['maintenance', 'maintenance agreement', (n) => n.recurring.length > 0],
  ['cloud_terms', 'cloud and data-storage terms', (n) => !!n.cloud_access || /camera|video/i.test(n.scope.summary || '')],
  ['privacy_security', 'privacy and security terms', (n) => !!n.cloud_access || /camera|video|lpr/i.test(n.scope.summary || '')],
  ['coi', 'certificate of insurance', () => true],
  ['w9', 'W-9', () => true],
  ['equipment_specs', 'equipment specifications', () => true],
  ['schedule', 'implementation schedule', () => true],
  ['change_order_policy', 'change-order policy', (n) => n.budgetary || !!n.change_order_exposure],
  ['price_validity', 'pricing validity / expiration date', () => true],
  ['termination_schedule', 'termination schedule', (n) => n.recurring.length > 0],
];

function termStatus(item, n, key) {
  const ct = (item && item.contract_terms) || {};
  if (ct[key]) return ct[key];
  // Derived from the normalized structure when the extraction did not report the term.
  if (key === 'warranty') return n.warranty ? { status: 'addressed', text: n.warranty } : { status: 'absent' };
  if (key === 'insurance') return n.insurance ? { status: 'addressed', text: n.insurance } : { status: 'absent' };
  if (key === 'equipment_ownership') return n.ownership === 'association' ? { status: 'partial', text: 'implied by a materials-and-labor purchase price; no title clause' } : { status: 'absent' };
  if (key === 'change_orders') return n.change_order_exposure ? { status: 'adverse', text: n.change_order_exposure } : { status: 'absent' };
  if (key === 'term_renewal') { const r = n.recurring.find((x) => x.auto_renews); return r ? { status: 'partial', text: `${r.label} renews automatically` } : { status: 'absent' }; }
  return { status: 'absent' };
}

/** Locations other proposals covered that this one does not (scope gaps visible only by comparison). */
function scopeGaps(n, others) {
  const mine = new Set((n.scope.locations || []).map((l) => l.toLowerCase().replace(/house/, 'house')));
  const norm = (l) => l.toLowerCase().replace(/\bclub ?house\b/, 'club house').replace(/\bguard (?:house|shack)\b/, 'guard shack');
  const mineN = new Set([...mine].map(norm));
  const gaps = new Set();
  for (const o of others) for (const l of o.scope.locations || []) if (!mineN.has(norm(l))) gaps.add(l);
  return [...gaps];
}

/**
 * Review one proposal. `context` = gatherCommunityContext().findings.
 * Pure. Returns the structured sections and the three conclusions.
 */
function reviewProposal(n, { item = {}, requirements = {}, facts = null, context = [], others = [], funding = null, boardNotes = [] } = {}) {
  const F = { strengths: [], weaknesses_risks: [], missing_documents: [], required_conditions: [], counsel_review: [], community_context_used: [] };
  const add = (sec, lens, text, source = 'proposal', severity = 'material', brief = null) => F[sec].push({ lens, text, source, severity, brief });
  const ctx = (kind) => context.filter((c) => c.kind === kind);
  const useCtx = (c) => { if (!F.community_context_used.some((x) => x.text === c.text)) F.community_context_used.push({ source: c.source, kind: c.kind, text: c.text }); return c.source; };

  // ---------------- operational
  if (requirements.ownership && n.ownership === 'association') add('strengths', 'operational', 'The association owns the equipment, as the Board asked.');
  if (requirements.monitoring === false && (!n.monitoring || n.monitoring === 'none')) add('strengths', 'operational', 'Record-and-store system with no monitoring service, as the Board asked.');
  if (n.scope.cameras_reused) add('strengths', 'operational', `Reuses ${n.scope.cameras_reused} existing cameras, so only ${n.scope.cameras_new} new units are bought.`);
  if (/lpr|license plate/i.test(`${n.scope.summary || ''}`) || (item.scope && /lpr/i.test(JSON.stringify(item.scope)))) add('strengths', 'operational', 'License-plate cameras at the guard shack address the gate incidents the Board described.', 'board_message');
  const gaps = scopeGaps(n, others);
  if (gaps.length) add('weaknesses_risks', 'operational', `Does not cover ${gaps.join(', ')}, which other proposals included. Confirm the Board accepts that coverage.`, 'proposal', 'material', `it does not cover ${gaps.join(', ')}`);
  if (!n.implementation_timing) {
    const when = (boardNotes || []).find((x) => /^schedule/.test(x));
    add('weaknesses_risks', 'operational', `No installation schedule in the proposal${when ? '; the Board was told installation would not start before December' : ''}. With cameras down, delay leaves the gate and amenities without usable video.`, when ? 'board_message' : 'proposal');
  }
  for (const a of n.assumptions || []) if (/power|network|wiring|internet/i.test(a)) add('weaknesses_risks', 'risk', `Dependency the HOA must supply: ${a}.`);

  // ---------------- financial
  const plan = n.recurring.find((r) => r.counted && !r.required);
  add('strengths', 'financial', `Lowest ${n.horizon_months / 12}-year cost among the options that fit: ${money(n.tco_cents)} (${money(n.upfront_total_cents)} installed with tax${plan ? ` plus ${money(plan.monthly_cents)}/month` : ''}).`);
  if (n.budgetary) add('weaknesses_risks', 'financial', 'Budgetary bid: the price may change after the pre-installation survey.', 'proposal', 'material', 'the price is budgetary and can change after the site survey');
  if (/fault|change order/i.test(n.change_order_exposure || '')) add('weaknesses_risks', 'financial', 'Existing system faults are expected to need troubleshooting and likely a change order, which is unpriced.', 'proposal', 'material', 'existing faults will likely mean an unpriced change order');
  if (plan && plan.taxable == null) add('weaknesses_risks', 'financial', `Sales tax on the ${money(plan.monthly_cents)}/month plan is not stated.`, 'proposal', 'minor');
  if (/50%/.test(n.payment_terms || '')) add('weaknesses_risks', 'financial', `Payment terms: ${n.payment_terms}.`, 'proposal', 'minor');
  // Budget line for the recurring plan, against the contracts already committed to it (community context).
  const security = facts && facts.budget && (facts.budget.lines || []).find((l) => /security/i.test(l.account_name || ''));
  const committed = ctx('contract').filter((c) => /security/i.test(c.data.category || ''));
  if (plan && security && committed.length) {
    const annual = committed.reduce((t, c) => t + (c.data.annual_cents || 0), 0);
    const room = security.budget_cents - annual;
    committed.forEach(useCtx);
    add(room >= plan.monthly_cents * 12 ? 'strengths' : 'weaknesses_risks', 'financial', `${security.account_number} ${security.account_name} is budgeted at ${money(security.budget_cents)} against ${money(annual)}/yr of active security contracts (${committed.map((c) => c.data.vendor).join(', ')}), leaving about ${money(room)}/yr for the ${money(plan.monthly_cents * 12)}/yr plan${facts.budget.label && facts.budget.label !== 'verified' ? ' (provisional)' : ''}.`, committed[0].source, 'material', `${security.account_name} has about ${money0(room)}/yr left after the ${committed.map((c) => c.data.vendor.split(' ').slice(0, 2).join(' ')).join(' and ')} contracts, ${room >= plan.monthly_cents * 12 ? 'enough' : 'not enough'} for the plan's ${money0(plan.monthly_cents * 12)}/yr`);
  }
  const noReserve = ctx('no_reserve_component')[0];
  if (noReserve && funding && funding.source === 'reserve') add('weaknesses_risks', 'financial', 'There is no camera component in the reserve study on file, so Reserve funding is the Board\'s funding decision rather than a scheduled reserve expenditure.', useCtx(noReserve), 'material', 'the reserve study has no camera component, so Reserve funding is the Board\'s call');
  if (funding && funding.label && funding.label !== 'verified') add('weaknesses_risks', 'financial', `The ${funding.fund || 'fund'} balance behind the funding recommendation is ${funding.label} (${funding.reason || 'not yet reconciled'}); treat affordability as preliminary.`, 'trustEd:books');
  const noOverlap = ctx('no_overlap')[0];
  if (noOverlap) add('strengths', 'contract', 'No existing camera contract to overlap or terminate.', useCtx(noOverlap), 'material', 'no camera contract is on file to overlap or terminate');

  // ---------------- contract / legal-risk (flags only, never conclusions)
  const terms = CONTRACT_TERMS.map(([key, label, legal]) => ({ key, label, legal, ...termStatus(item, n, key) }));
  for (const t of terms) {
    if (t.status === 'addressed') continue;
    const how = t.status === 'absent' ? 'not addressed' : t.status === 'partial' ? `only partly addressed${t.text ? ` ("${String(t.text).slice(0, 90)}")` : ''}` : `appears one-sided or adverse${t.text ? ` ("${String(t.text).slice(0, 90)}")` : ''}`;
    if (t.legal) F.counsel_review.push({ term: t.key, label: t.label, status: t.status, note: `${t.label}: ${how} in the documents provided. Flag for counsel review; no legal conclusion is drawn here.` });
  }
  const legalGaps = F.counsel_review.length;
  if (legalGaps) add('weaknesses_risks', 'contract', `The proposal is not a complete contract: ${legalGaps} of ${CONTRACT_TERMS.filter((x) => x[2]).length} contract terms that should be in writing (termination, indemnity, limitation of liability, insurance, data ownership and access, cybersecurity and privacy, change-order authorization among them) are missing or unclear.`, 'proposal', 'material', 'it is a proposal, not a full contract');
  if (terms.find((t) => t.key === 'warranty' && t.status !== 'addressed')) add('weaknesses_risks', 'contract', 'Warranty terms are not stated.');

  // ---------------- risk management
  if (n.scope.retention_days == null) add('weaknesses_risks', 'risk', 'The recording-retention period is not stated; storage capacity alone does not say how many days of video are kept after an incident.', 'proposal', 'material', 'the retention period is not stated');
  if (n.cloud_access === 'with_plan') add('weaknesses_risks', 'risk', `Remote and cloud access appears only inside the optional ${plan ? money(plan.monthly_cents) + '/month ' : ''}plan; if the plan lapses, remote access may go with it. Cost and dependency need confirming.`, 'proposal', 'material', 'cloud access depends on the optional plan');
  if (/network/i.test((n.assumptions || []).join(' '))) add('weaknesses_risks', 'risk', 'The system joins the association\'s network and offers cloud access, with no cybersecurity or privacy terms for video and license-plate data.');
  if ((item.other_terms || []).concat(n.other_terms || []).some((x) => /renew/i.test(x))) add('weaknesses_risks', 'risk', 'The plan renews automatically and the notice wording is unclear.', 'proposal', 'minor');
  if (/exclu|faults|addressed as they present/i.test(`${(n.exclusions || []).join(' ')} ${item.scope && item.scope.summary || ''}`)) add('weaknesses_risks', 'risk', 'Pre-existing faults and extra power are excluded, so that risk sits with the HOA unless capped in the contract.', 'proposal', 'minor');
  if (/plan|loaner|advance replacement/i.test(JSON.stringify(n.recurring))) add('strengths', 'risk', 'The plan includes health alerts, priority response and loaner or advance-replacement cameras, which limits downtime.');
  if (/battery|ups/i.test(`${n.scope.summary || ''} ${n.scope.storage || ''}`)) add('strengths', 'risk', 'Battery backup on each server.');

  // ---------------- documents (never assume the proposal is the contract package)
  const included = new Set((item.documents_included || ['proposal']).map((d) => String(d).toLowerCase()));
  const vk = require('./community_context').firstWord(n.vendor_name);
  const v360 = ctx('vendor_360').find((c) => c.data && c.data.vendor_key === vk);
  for (const [key, label, relevant] of DOCUMENTS) {
    if (!relevant(n)) continue;
    if (included.has(key)) continue;
    if (key === 'w9' && v360 && v360.data.w9_on_file === true) { useCtx(v360); continue; }
    if (key === 'w9' && v360) { F.missing_documents.push({ key, label, note: v360.data.missing ? 'vendor is not in Vendor 360' : 'W-9 not recorded in Vendor 360', source: useCtx(v360) }); continue; }
    if (key === 'price_validity' && n.expires_on) continue;
    if (key === 'schedule' && n.implementation_timing) continue;
    if (key === 'equipment_specs' && included.has('equipment list')) continue;
    if (key === 'sow' && included.has('scope of work')) continue;
    F.missing_documents.push({ key, label, note: key === 'price_validity' ? 'no expiration date, so the price could change before signing' : null, source: key === 'w9' && v360 ? useCtx(v360) : 'proposal' });
  }
  for (const r of item.references_not_attached || []) F.missing_documents.push({ key: 'referenced', label: r, note: 'referenced in the proposal but not provided', source: 'proposal' });

  // ---------------- required conditions before signing (what makes the contract ready)
  const cond = (text, short, source = 'proposal') => { if (!F.required_conditions.some((c) => c.text === text)) F.required_conditions.push({ text, short, source }); };
  if (n.budgetary || n.change_order_exposure) cond('A fixed scope and not-to-exceed price after the pre-installation survey, with no change order without written Board approval.', 'a not-to-exceed price after the site survey');
  if (n.scope.cameras_total && n.scope.licenses != null && n.scope.licenses < n.scope.cameras_total - (n.scope.embedded_server_cameras || 0)) cond(`A camera-by-camera schedule showing licensing for all ${n.scope.cameras_total} cameras.`, `a camera schedule (${n.scope.cameras_total} cameras, ${n.scope.licenses} licenses)`);
  if (n.scope.retention_days == null) cond('The guaranteed number of days of video retention.', 'days of video retention');
  if (n.cloud_access === 'with_plan') cond('The cost of remote and cloud access, and whether it requires the plan.', 'cloud-access cost');
  if (terms.find((t) => t.key === 'warranty' && t.status !== 'addressed')) cond('A written warranty (parts and labor) and the manufacturer warranties.', 'warranty');
  if (terms.find((t) => t.key === 'insurance' && t.status !== 'addressed')) cond('A certificate of insurance naming the association as additional insured.', 'certificate of insurance');
  if (!n.implementation_timing) cond('Confirmed installation dates.', 'installation dates');
  if (legalGaps) cond(`The full contract terms, reviewed by counsel (${F.counsel_review.length} terms missing or unclear).`, 'the full contract terms for counsel review');
  if (F.missing_documents.some((d) => d.key === 'w9')) cond('A W-9 on file in Vendor 360 before the first payment.', 'W-9', v360 ? v360.source : 'proposal');

  // Community context that bears on this decision but was not used above.
  for (const kind of ['prior_communication', 'board_decision', 'vendor_history', 'project', 'reserve_component', 'policy']) for (const c of ctx(kind)) useCtx(c);
  return F;
}

/** Three separate conclusions. A preferred vendor is not a signable contract. */
function conclusions(record, review) {
  const rec = record.proposals.find((n) => n.key === (record.recommendation || {}).key);
  const outstanding = review ? review.required_conditions.length : 0;
  return {
    vendor_recommendation: rec ? { vendor: rec.vendor_name, basis: `the only current proposal that fits the Board's requirements; lowest ${record.horizon_months / 12}-year cost among those that fit` } : { vendor: null, basis: 'no approvable proposal on file' },
    project_recommendation: rec ? { decision: 'proceed', basis: 'the existing system has cameras down and the Board has asked to act quickly' } : { decision: 'hold', basis: 'no approvable proposal yet' },
    contract_readiness: rec ? { ready: outstanding === 0, outstanding, label: outstanding === 0 ? 'ready to sign' : `not ready to sign, ${outstanding} item${outstanding === 1 ? '' : 's'} outstanding` } : { ready: false, outstanding: null, label: 'no contract yet' },
  };
}

module.exports = { reviewProposal, conclusions, CONTRACT_TERMS, DOCUMENTS, scopeGaps };
