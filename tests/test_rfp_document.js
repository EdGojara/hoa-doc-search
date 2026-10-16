// =============================================================================
// tests/test_rfp_document.js: the vendor-neutral RFP guard, encoded
// =============================================================================
//
// Ed 2026-10-16: the Board President asked to "scrub the numbers on this proposal
// and create an RFP." The RFP must reach every bidder with the same scope, pricing
// form and compliance matrix, carry none of the baseline vendor's names or prices,
// and its Board decision state must never say "proceed" (the Treasurer read that
// as authorization to execute). These tests prove the validator refuses each
// failure, that the camera schedule reconciles to the STORED line items, and that
// returned responses compare on the same totals.
//
// Run: node tests/test_rfp_document.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const R = require('../lib/vendors/rfp_document');
const { renderRfpHtml } = require('../lib/vendors/rfp_document_render');
const { planWrite } = require('../scripts/save_rfp_document');
const plan = require('../scripts/plans/canyon_gate_camera_rfp.json');
const stored = require('./fixtures/rfp-document/itech-2026-stored-v1.json');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const governing = { source: 'email_messages', email_message_id: plan.governing_instruction.email_message_id, received_at: '2026-10-16T15:34:15+00:00', from_role: 'Board President', subject: 'Create RFP', summary: plan.governing_instruction.summary };
const build = (p = plan) => R.buildRfpDocument(p, { governingInstruction: governing, baselineLineItemVersion: 1 });
const validate = (doc) => R.validateRfpDocument(doc, { baselineItem: stored.item, expectedDecisionState: plan.expected_decision_state });

check('the Canyon Gate plan builds a document that passes every check', () => {
  const v = validate(build());
  assert.deepStrictEqual(v.errors, []);
});

check('camera schedule reconciles to the stored line items: 13 reused, 6 replacement, 8 new, 27 total', () => {
  const doc = build();
  assert.deepStrictEqual([doc.camera_totals.reused, doc.camera_totals.replacement, doc.camera_totals.new, doc.camera_totals.total], [13, 6, 8, 27]);
  const r = R.reconcileScheduleToBaseline(doc.camera_schedule, stored.item);
  assert.ok(r.ok, r.errors.join('; '));
  assert.strictEqual(r.baseline.licenses, 20);
  assert.strictEqual(r.baseline.embedded_server_cameras, 2);
});

check('a schedule that drops a camera is refused against the stored counts', () => {
  const p = clone(plan); p.document.camera_schedule = p.document.camera_schedule.filter((c) => c.id !== 'GS-08');
  const v = validate(build(p));
  assert.ok(!v.ok && v.errors.some((e) => /stored line items say 14/.test(e)), v.errors.join('; '));
});

check('Hugh\'s "cloud storage/access" stays in the base bid: both are Board-basis requirements and counted in the totals', () => {
  const d = build();
  const cloud = d.compliance_matrix.filter((r) => r.section === 'cloud_access_vs_storage');
  assert.ok(cloud.some((r) => /^Cloud storage .* base bid/.test(r.requirement)) && cloud.some((r) => /^Cloud access included in the base bid/.test(r.requirement)));
  assert.ok(cloud.every((r) => r.basis === 'board'));
  assert.ok(d.pricing_form.rules.some((r) => /cloud storage and cloud access/.test(r)));
  const t = R.computeResponseTotals({ one_time: oneTime(), recurring: [{ label: 'Cloud storage', feature: 'cloud storage, 27 cameras, 30 days', monthly_cents: 30000, required: true, is_monitoring: false, why_not_separate: 'off-site storage is a hosted service', non_monitoring_alternative: 'not monitoring' }] });
  assert.strictEqual(t.totals.five_year_cents - t.totals.base_installed_cents, 30000 * 60);
});

check('every one of Ed\'s required sections is present, and a missing one is refused', () => {
  for (const k of R.REQUIRED_SECTIONS.security_cameras) assert.ok(build().sections.some((s) => s.key === k), `missing ${k}`);
  const p = clone(plan); p.document.sections = p.document.sections.filter((s) => s.key !== 'cloud_access_vs_storage');
  assert.ok(validate(build(p)).errors.some((e) => e === 'section missing: cloud_access_vs_storage'));
});

check('the baseline vendor or a brand in vendor-facing text is refused', () => {
  for (const [where, text] of [['sections', 'Use a Digital Watchdog server.'], ['camera', 'iTech LPR camera'], ['clarification', 'Confirm DW licensing.']]) {
    const p = clone(plan);
    if (where === 'sections') p.document.sections[1].items.push(text);
    if (where === 'camera') p.document.camera_schedule[0].minimum_spec = text;
    if (where === 'clarification') p.document.clarification_items.push({ id: 'Q-99', audience: 'all_bidders', text });
    const v = validate(build(p));
    assert.ok(v.errors.some((e) => /baseline vendor or brand/.test(e)), `${where}: ${v.errors.join('; ')}`);
  }
});

check('a price in vendor-facing text is refused (the numbers are scrubbed)', () => {
  for (const text of ['Budget is $44,619.75.', 'Comparable systems run 44,619.75 installed.', 'Plan is 440.00 per month.']) {
    const p = clone(plan); p.document.sections[0].body.push(text);
    assert.ok(validate(build(p)).errors.some((e) => /price in vendor-facing text/.test(e)), text);
  }
});

check('management items and the decision state may name the baseline vendor; they never reach vendors', () => {
  const doc = build();
  assert.ok(doc.clarification_items.some((c) => c.audience === 'management' && /ITECH/.test(c.text)));
  assert.strictEqual(doc.decision_state.vendor_direction, 'iTech currently preferred');
  const html = renderRfpHtml(doc, { audience: 'vendor' });
  for (const term of plan.forbidden_terms) assert.ok(!new RegExp(`(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)`, 'i').test(html), `vendor copy contains ${term}`);
  assert.ok(!/\$\s?\d/.test(html), 'vendor copy contains a dollar amount');
  assert.ok(!/Not authorized|Vendor direction|M-0\d|Conflict-of-interest/.test(html), 'vendor copy carries Board or management content');
});

check('the Board copy carries the exact decision-state wording and Board items, never management items', () => {
  const html = renderRfpHtml(build(), { audience: 'board' });
  for (const k of R.DECISION_STATE_KEYS) assert.ok(html.includes(plan.expected_decision_state[k].replace(/&/g, '&amp;')), k);
  assert.ok(/Coverage: four locations only.*(Ed Gojara, Friday, October 16, 2026)/.test(html), 'decided B-01 rendered with attribution');
  assert.ok(/Confirm the response deadline/.test(html), 'open B-03 still listed');
  assert.ok(!/Netwatch material|498a15b3/.test(html));
  assert.ok(!/—/.test(html) && !/\bproceed\b/i.test(html), 'em dash or "proceed" in the Board copy');
});

check('"proceed" in any decision-state line is refused, and the wording must be exact', () => {
  const p = clone(plan); p.expected_decision_state.management_action = 'Proceed';
  const doc = build(p);
  const v = R.validateRfpDocument(doc, { expectedDecisionState: plan.expected_decision_state });
  assert.ok(v.errors.some((e) => /uses "proceed"/.test(e)));
  assert.ok(v.errors.some((e) => /must read exactly "Build\/issue RFP and complete diligence"/.test(e)));
});

check('an em dash anywhere Board-facing is refused', () => {
  const p = clone(plan); p.document.board_requirements[0].text = 'Own it — all of it.';
  assert.ok(validate(build(p)).errors.some((e) => /banned text/.test(e)));
});

check('the content hash is stable across runs and ignores the audit trail and version', () => {
  const a = build(); const b = build();
  assert.strictEqual(a.content_sha256, b.content_sha256);
  b.audit = [{ at: 'x' }]; b.version = 7;
  assert.strictEqual(R.contentHash(b), a.content_sha256);
});

// ---- save script: pure planning over the inputs it reads ----------------------
const inputs = () => ({
  br: { id: plan.bid_request_id, community_id: plan.community_id, title: 'Security Camera System 2026 (Canyon Gate at Cinco Ranch)', status: 'evaluating', structured_rfp: null },
  bp: { id: plan.baseline.proposal_id, bid_request_id: plan.bid_request_id, file_hash: plan.baseline.document_sha256, extracted_data: { approved_line_item_version: 1, line_item_versions: [{ version: 1, status: 'approved', items: [stored.item] }] } },
  em: { id: plan.governing_instruction.email_message_id, mailbox: 'amandaalbright@bedrocktx.com', sender_email: 'president@canyongateatcincoranch.com', subject: 'Create RFP', received_at: '2026-10-16T15:34:15+00:00', community_id: plan.community_id, body_full: '<p>Amanda, can you scrub the numbers on this proposal and create an RFP for me quickly?</p>' },
});

check('save plan: first run writes structured_rfp + scope_summary only, as a draft, status untouched', () => {
  const r = planWrite(plan, inputs(), { now: '2026-10-16T18:00:00Z' });
  assert.ok(r.ok, r.errors.join('; '));
  assert.deepStrictEqual(Object.keys(r.patch).sort(), ['scope_summary', 'structured_rfp']);
  assert.strictEqual(r.doc.document_status, 'draft_for_review');
  assert.strictEqual(r.doc.issued_at, null);
  assert.strictEqual(r.doc.audit.length, 1);
  assert.strictEqual(r.doc.governing_instruction.email_message_id, 'ad9a18d5-5eb3-40bd-abd4-8b36ac505e1c');
  assert.ok(!JSON.stringify(r.doc.baseline).includes('4461975'), 'baseline reference must not carry pricing');
});

check('save plan: a second run over the saved state is "already saved" (idempotent)', () => {
  const first = planWrite(plan, inputs(), { now: '2026-10-16T18:00:00Z' });
  const i = inputs(); i.br.structured_rfp = first.doc;
  const second = planWrite(plan, i, { now: '2026-10-17T09:00:00Z' });
  assert.ok(second.ok && second.unchanged, second.errors.join('; '));
  assert.strictEqual(second.doc.audit.length, 1);
});

check('save plan: an issued or Board-approved document is never overwritten', () => {
  const first = planWrite(plan, inputs());
  const i = inputs(); i.br.structured_rfp = { ...first.doc, document_status: 'issued', content_sha256: 'other' };
  assert.ok(planWrite(plan, i).errors.some((e) => /never overwritten/.test(e)));
});

check('save plan: refuses when the governing email is missing or is not Hugh\'s instruction', () => {
  const a = inputs(); a.em = null;
  assert.ok(planWrite(plan, a).errors.some((e) => /not found \(email ingest is manual/.test(e)));
  const b = inputs(); b.em.sender_email = 'someone@example.com';
  assert.ok(planWrite(plan, b).errors.some((e) => /sender/.test(e)));
});

check('save plan: refuses without an APPROVED stored line-item version', () => {
  const i = inputs(); i.bp.extracted_data = { line_item_versions: [{ version: 1, status: 'pending_approval', items: [stored.item] }] };
  assert.ok(planWrite(plan, i).errors.some((e) => /no APPROVED stored line-item version/.test(e)));
});

// ---- responses compared apples to apples ------------------------------------------
const doc = build();
const fullPackage = Object.fromEntries(R.CONTRACT_PACKAGE.map(([k]) => [k, true]));
const allComply = doc.compliance_matrix.map((r) => ({ id: r.id, response: 'comply' }));
const schedule = doc.camera_schedule.map((c) => ({ id: c.id, location: c.location, disposition: c.disposition }));
function oneTime(o = {}) { return { equipment: 2000000, labor: 1200000, cabling_conduit: 300000, network_equipment: 250000, servers_storage: 500000, software_licenses: 150000, freight: 20000, tax: 300000, permits: 0, other_one_time: 0, ...o }; }

check('totals: base = one-time lines incl. tax; first year and five year add only REQUIRED non-monitoring recurring', () => {
  const r = R.computeResponseTotals({ one_time: oneTime(), recurring: [
    { label: 'Remote access relay', feature: 'remote viewing', monthly_cents: 2500, required: true, is_monitoring: false, why_not_separate: 'the platform relay is the only no-port-forwarding path', non_monitoring_alternative: 'VPN appliance, 900.00 one time' },
    { label: 'Health plan', feature: 'alerts and support', monthly_cents: 44000, required: false, is_monitoring: true },
  ], stated_totals: { base_installed_cents: 4720000, first_year_cents: 4750000, five_year_cents: 4870000 } });
  assert.deepStrictEqual([r.totals.base_installed_cents, r.totals.first_year_cents, r.totals.five_year_cents], [4720000, 4750000, 4870000]);
  assert.strictEqual(r.totals.optional_monthly_cents, 44000);
  assert.deepStrictEqual(r.issues, []);
});

check('a monitoring charge marked required stays out of the base and is flagged', () => {
  const r = R.computeResponseTotals({ one_time: oneTime(), recurring: [{ label: 'Monitoring', feature: 'cloud access', monthly_cents: 44000, required: true, is_monitoring: true, why_not_separate: 'x', non_monitoring_alternative: 'y' }], stated_totals: {} });
  assert.strictEqual(r.totals.five_year_cents, r.totals.base_installed_cents);
  assert.ok(r.recurring[0].problems.some((x) => /excluded from the base bid/.test(x)));
});

check('a required recurring charge without the why and the alternative is incomplete; a wrong stated total is flagged', () => {
  const r = R.computeResponseTotals({ one_time: oneTime({ permits: undefined }), recurring: [{ label: 'VMS subscription', feature: 'recording software', monthly_cents: 1000, required: true }], stated_totals: { base_installed_cents: 1, first_year_cents: 1, five_year_cents: 1 } });
  assert.ok(r.recurring[0].problems.some((x) => /why/.test(x)) && r.recurring[0].problems.some((x) => /alternative/.test(x)));
  assert.ok(r.issues.some((x) => /permits/.test(x)));
  assert.ok(r.issues.some((x) => /does not equal the lines/.test(x)));
});

check('compareResponses lines up bidders on the same form; exceptions need explanations; licenses below cameras flagged', () => {
  const t = R.computeResponseTotals({ one_time: oneTime(), recurring: [] }).totals;
  const proposals = [
    { id: 'a', proposer_company_name: 'Bidder A', extracted_data: { rfp_response: { rfp_content_sha256: doc.content_sha256, compliance: allComply, contract_package: fullPackage, camera_schedule: schedule, licenses: 27, pricing: { one_time: oneTime(), recurring: [], stated_totals: { base_installed_cents: t.base_installed_cents, first_year_cents: t.first_year_cents, five_year_cents: t.five_year_cents } } } } },
    { id: 'b', proposer_company_name: 'Bidder B', extracted_data: { rfp_response: { rfp_content_sha256: 'old', compliance: [...allComply.slice(1), { id: 'R-01', response: 'exception' }], contract_package: { proposal: true }, camera_schedule: schedule.slice(0, 26), licenses: 20, pricing: { one_time: oneTime(), recurring: [] } } } },
    { id: 'c', proposer_company_name: 'Old proposal, no RFP response', extracted_data: {} },
  ];
  const c = R.compareResponses(doc, proposals);
  assert.strictEqual(c.rows.length, 2);
  const [a, b] = c.rows;
  assert.ok(a.complete && a.answers_current_version, JSON.stringify(a.pricing_issues.concat(a.schedule_issues)));
  assert.ok(!b.complete && !b.answers_current_version);
  assert.ok(b.compliance.incomplete.some((x) => x.id === 'R-01' && x.issue === 'explanation required'));
  assert.ok(b.schedule_issues.some((x) => /26 cameras/.test(x)) && b.schedule_issues.some((x) => /20 licenses for 26 cameras/.test(x)));
  assert.strictEqual(b.contract_package_missing.length, R.CONTRACT_PACKAGE.length - 1);
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
