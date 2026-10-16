// ============================================================================
// lib/vendors/rfp_document.js  (Ed 2026-10-16: "convert it into a vendor-neutral
// RFP inside trustEd")
// ----------------------------------------------------------------------------
// The structured RFP document that lives on the RFP / Bid Workflow record
// (bid_requests.structured_rfp, schema 'trusted.rfp.v2'). One record carries the
// whole cycle: the Board's instruction, the vendor-neutral scope every bidder
// receives, the pricing form and compliance matrix every bidder answers, and the
// responses that come back (vendor_proposals.extracted_data.rfp_response), compared
// apples to apples.
//
// Same family as the insurance RFP (lib/insurance_rfp_validate.js): the document
// withholds the baseline vendor and its price, and a validator REFUSES a document
// that leaks either, misses a required section, or carries a decision state that
// could be read as authorization. A clean-looking RFP is never one click from going
// out half-built or carrying a competitor's number.
//
// Pure: no DB, no network. Writers (scripts/save_rfp_document.js) and readers
// (GET /api/vendors/rfps/:id/document) both go through validateRfpDocument.
// Nothing here sends, issues or awards anything.
// ============================================================================

const crypto = require('crypto');
const { money } = require('./proposal_comparison');
const { computeQuantities } = require('./line_items');

const SCHEMA = 'trusted.rfp.v2';
// draft_for_review -> board_approved_to_issue -> issued -> closed. Only a person
// in the app moves a document past draft_for_review; scripts refuse to.
const DOCUMENT_STATUSES = ['draft_for_review', 'board_approved_to_issue', 'issued', 'closed'];

// Ed's required structured sections for a security camera system RFP, in order.
const CAMERA_SECTIONS = [
  ['instructions', 'Instructions to bidders'],
  ['scope_of_work', 'Scope of work'],
  ['camera_schedule', 'Camera-by-camera schedule'],
  ['camera_disposition', 'Reused, replacement and new cameras'],
  ['equipment_specifications', 'Equipment specifications'],
  ['servers_storage', 'Servers and storage'],
  ['licensing', 'Licensing'],
  ['remote_access', 'Remote access'],
  ['cloud_access_vs_storage', 'Cloud access versus cloud storage'],
  ['retention', 'Expected retention days'],
  ['monitoring', 'No active monitoring'],
  ['cabling_network', 'Cabling, conduit and network'],
  ['power', 'Power assumptions'],
  ['change_orders', 'Change-order controls'],
  ['warranty', 'Warranties'],
  ['support_maintenance', 'Optional support and maintenance'],
  ['ownership', 'Ownership of equipment, data and administrator credentials'],
  ['cybersecurity_privacy', 'Cybersecurity and privacy'],
  ['insurance', 'Insurance and licensing'],
  ['contract_terms', 'Contract terms'],
  ['installation_schedule', 'Installation schedule'],
  ['testing_acceptance', 'Testing and acceptance'],
  ['pricing', 'Pricing'],
];
const REQUIRED_SECTIONS = { security_cameras: CAMERA_SECTIONS.map(([k]) => k) };

// Every bidder prices the same lines. Tax is its own line; nothing is "assumed included".
const PRICING_ONE_TIME = [
  ['equipment', 'Equipment (cameras, mounts, enclosures)'],
  ['labor', 'Installation labor'],
  ['cabling_conduit', 'Cabling and conduit'],
  ['network_equipment', 'Network equipment (switches, wireless links, enclosures)'],
  ['servers_storage', 'Servers, recorders and storage'],
  ['software_licenses', 'Software and licenses (one-time)'],
  ['freight', 'Freight and delivery'],
  ['tax', 'Sales tax'],
  ['permits', 'Permits'],
  ['other_one_time', 'Other one-time charges (itemize)'],
];
const PRICING_RECURRING_FIELDS = [
  ['label', 'Name of the charge'],
  ['feature', 'Exact feature or function it provides'],
  ['amount', 'Monthly or annual amount'],
  ['required', 'Required for a function the Association asked for? (yes or no)'],
  ['is_monitoring', 'Includes any monitoring, alerting by the bidder, or dispatch? (yes or no)'],
  ['why_not_separate', 'If required: why the function cannot be provided without this charge'],
  ['non_monitoring_alternative', 'If required: the non-monitoring alternative and its price'],
  ['term', 'Minimum term, renewal and cancellation terms'],
];
const PRICING_TOTALS = [
  ['base_installed', 'Base installed total', 'all one-time lines, including sales tax'],
  ['first_year', 'First-year total', 'base installed total plus 12 months of every REQUIRED recurring charge'],
  ['five_year', 'Five-year total', 'base installed total plus 60 months of every REQUIRED recurring charge'],
];
const CONTRACT_PACKAGE = [
  ['proposal', 'Signed proposal'],
  ['scope', 'Scope of work and camera schedule as bid'],
  ['terms_conditions', 'Terms and conditions'],
  ['warranty', 'Warranty terms (installation and manufacturer)'],
  ['sla_support', 'SLA and support terms'],
  ['maintenance_agreement', 'Maintenance agreement, if any is offered'],
  ['cloud_data_terms', 'Cloud and data terms'],
  ['privacy_security_terms', 'Privacy and security terms'],
  ['renewal_cancellation', 'Renewal and cancellation terms for every recurring charge'],
  ['certificate_of_insurance', 'Certificate of insurance naming the Association as additional insured'],
];
const COMPLIANCE_RESPONSES = ['comply', 'exception', 'not_applicable'];
const DECISION_STATE_KEYS = ['vendor_direction', 'management_action', 'contract_readiness', 'board_authorization', 'execution_status'];
const DECISION_STATE_LABELS = {
  vendor_direction: 'Vendor direction', management_action: 'Management action', contract_readiness: 'Contract readiness',
  board_authorization: 'Board authorization', execution_status: 'Execution status',
};
const HORIZON_MONTHS = 60;

// Text that must never appear in board- or vendor-facing copy.
const BANNED_ANYWHERE = [/—/, /\bClaude\b/i, /\bAnthropic\b/i];
// "Proceed" read as authorization to execute (Kevin, Treasurer, 2026-10-16). Never in a decision state.
const PROCEED_RE = /\bproceed(?:s|ed|ing)?\b/i;
const MONEY_RE = /\$\s?\d|\b\d{1,3}(?:,\d{3})+\.\d{2}\b|\b\d+\.\d{2}\s*(?:\/\s*mo|per month|a month|monthly)\b/i;

/** Canonical JSON (sorted keys) so the content hash is stable across runs. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** Hash of the document content: audit trail, timestamps and the hash itself excluded. */
function contentHash(doc) {
  const { audit, content_sha256, prepared_at, version, ...rest } = doc || {};
  return crypto.createHash('sha256').update(canonical(rest)).digest('hex');
}

/**
 * Assemble the structured document from a content plan (scripts/plans/*.json). Pure.
 * The pricing form and contract package always come from the constants above, so
 * every RFP of a template asks every bidder the same questions.
 */
function buildRfpDocument(plan, { governingInstruction = null, baselineLineItemVersion = null, version = 1 } = {}) {
  const d = plan.document || {};
  const doc = {
    schema: SCHEMA, template: plan.template, document_status: 'draft_for_review', issued_at: null, version,
    // 'diligence' (normalize scope with one preferred vendor) or 'competitive' (open bid). Board copy only.
    purpose: plan.purpose || null, purpose_label: plan.purpose_label || null,
    title: d.title, community: d.community, association_legal_name: d.association_legal_name, issuer: d.issuer,
    project: d.project, board_requirements: d.board_requirements || [],
    governing_instruction: governingInstruction,
    decision_state: { ...(plan.expected_decision_state || {}) },
    // A detail line shown under a decision-state line (Board copy and panel only).
    decision_state_notes: { ...(plan.decision_state_notes || {}) },
    sections: d.sections || [],
    camera_schedule: d.camera_schedule || [],
    camera_totals: cameraTotals(d.camera_schedule),
    compliance_matrix: d.compliance_matrix || [],
    pricing_form: {
      one_time: PRICING_ONE_TIME.map(([key, label]) => ({ key, label })),
      recurring_fields: PRICING_RECURRING_FIELDS.map(([key, label]) => ({ key, label })),
      totals: PRICING_TOTALS.map(([key, label, formula]) => ({ key, label, formula })),
      horizon_months: HORIZON_MONTHS,
      rules: (d.pricing_form && d.pricing_form.rules) || [],
    },
    contract_package: CONTRACT_PACKAGE.map(([key, label]) => ({ key, label })),
    contract_package_note: d.contract_package_note || null,
    clarification_items: d.clarification_items || [],
    schedule: d.schedule || null,
    submission: d.submission || null,
    // Internal only: never rendered to vendors. No pricing is stored here.
    baseline: plan.baseline ? { ...plan.baseline, line_item_version: baselineLineItemVersion } : null,
    neutrality: { forbidden_terms: plan.forbidden_terms || [] },
  };
  doc.content_sha256 = contentHash(doc);
  return doc;
}

/** Camera totals from the schedule, by disposition and location. Pure. */
function cameraTotals(schedule) {
  const rows = Array.isArray(schedule) ? schedule : [];
  const t = { reused: 0, replacement: 0, new: 0, total: rows.length, by_location: {} };
  for (const r of rows) {
    if (r.disposition in t) t[r.disposition] += 1;
    const loc = (t.by_location[r.location] = t.by_location[r.location] || { reused: 0, replacement: 0, new: 0, total: 0 });
    if (r.disposition in loc) loc[r.disposition] += 1;
    loc.total += 1;
  }
  return t;
}

/**
 * Cross-check the schedule against the baseline's STORED, approved line items
 * (lib/vendors/line_items.js). Counts are never re-derived from the PDF here:
 * reused = stored cameras_reused, replacement + new = stored cameras_new, and each
 * location's count equals the stored narrative statements for that location.
 */
function reconcileScheduleToBaseline(schedule, baselineItem) {
  const errors = [];
  const q = computeQuantities({ ...baselineItem, line_items_status: 'approved' });
  const t = cameraTotals(schedule);
  if (q.uncertain.some((u) => ['cameras_new', 'cameras_reused', 'cameras_total'].includes(u.field))) errors.push('baseline camera counts are unconfirmed in the stored line items');
  if (t.reused !== q.values.cameras_reused) errors.push(`schedule has ${t.reused} reused cameras; stored line items say ${q.values.cameras_reused}`);
  if (t.replacement + t.new !== q.values.cameras_new) errors.push(`schedule has ${t.replacement + t.new} replacement + new cameras; stored line items say ${q.values.cameras_new}`);
  if (t.total !== q.values.cameras_total) errors.push(`schedule has ${t.total} cameras; stored line items say ${q.values.cameras_total}`);
  const byLoc = {};
  for (const s of baselineItem.scope_statements || []) {
    if (!s.location || !['camera_new', 'camera_reused'].includes(s.category)) continue;
    const k = `${s.location}|${s.category === 'camera_reused' ? 'reused' : 'new'}`;
    byLoc[k] = (byLoc[k] || 0) + Number(s.quantity || 0);
  }
  for (const [k, want] of Object.entries(byLoc)) {
    const [loc, kind] = k.split('|');
    const l = t.by_location[loc] || { reused: 0, replacement: 0, new: 0 };
    const have = kind === 'reused' ? l.reused : l.replacement + l.new;
    if (have !== want) errors.push(`${loc}: schedule has ${have} ${kind === 'reused' ? 'reused' : 'replacement + new'} cameras; stored statements say ${want}`);
  }
  return { ok: errors.length === 0, errors, totals: t, baseline: q.values };
}

/** Every string a vendor will read, with where it came from. */
function vendorFacingStrings(doc) {
  const out = [];
  const push = (where, s) => { if (typeof s === 'string' && s.trim()) out.push({ where, text: s }); };
  push('title', doc.title); push('project.summary', doc.project && doc.project.summary);
  for (const s of doc.sections || []) { push(`${s.key}.title`, s.title); (s.body || []).forEach((b, i) => push(`${s.key}.body[${i}]`, b)); (s.items || []).forEach((b, i) => push(`${s.key}.items[${i}]`, b)); }
  for (const r of doc.camera_schedule || []) for (const k of ['location', 'mounting', 'function', 'minimum_spec', 'notes']) push(`camera ${r.id}.${k}`, r[k]);
  for (const r of doc.compliance_matrix || []) push(`compliance ${r.id}`, r.requirement);
  for (const c of doc.clarification_items || []) if (c.audience === 'all_bidders') push(`clarification ${c.id}`, c.text);
  for (const r of (doc.pricing_form && doc.pricing_form.rules) || []) push('pricing_form.rules', r);
  for (const m of (doc.schedule && doc.schedule.timeline) || []) if (!m.board_only) { push('schedule', m.milestone); push('schedule', m.note); }
  push('submission.instructions', doc.submission && doc.submission.instructions);
  return out;
}
/** Board-facing strings: everything vendor-facing plus the Board-only parts. */
function boardFacingStrings(doc) {
  const out = vendorFacingStrings(doc);
  for (const k of DECISION_STATE_KEYS) out.push({ where: `decision_state.${k}`, text: String((doc.decision_state || {})[k] || '') });
  for (const [k, v] of Object.entries(doc.decision_state_notes || {})) out.push({ where: `decision_state_notes.${k}`, text: String(v || '') });
  for (const c of doc.clarification_items || []) if (c.audience === 'board') out.push({ where: `clarification ${c.id}`, text: c.text });
  for (const r of doc.board_requirements || []) out.push({ where: 'board_requirements', text: r.text });
  if (doc.governing_instruction) out.push({ where: 'governing_instruction', text: doc.governing_instruction.summary || '' });
  if (doc.purpose_label) out.push({ where: 'purpose_label', text: doc.purpose_label });
  for (const m of (doc.schedule && doc.schedule.timeline) || []) if (m.board_only) out.push({ where: 'schedule', text: `${m.milestone} ${m.note || ''}` });
  if (doc.schedule && doc.schedule.basis) out.push({ where: 'schedule.basis', text: doc.schedule.basis });
  return out.filter((x) => x.text);
}

/**
 * Validate a structured RFP document. Returns { ok, errors, warnings }.
 * opts.forbiddenTerms: baseline vendor and brand names that must not reach vendors.
 * opts.baselineItem: the baseline's stored line-item item, for the count cross-check.
 * opts.expectedDecisionState: exact wording the Board summary uses.
 */
function validateRfpDocument(doc, { forbiddenTerms = null, baselineItem = null, expectedDecisionState = null } = {}) {
  if (!forbiddenTerms) forbiddenTerms = (doc && doc.neutrality && doc.neutrality.forbidden_terms) || [];
  const errors = []; const warnings = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['document missing'], warnings };
  if (doc.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!DOCUMENT_STATUSES.includes(doc.document_status)) errors.push(`document_status must be one of ${DOCUMENT_STATUSES.join('|')}`);
  if (doc.document_status === 'draft_for_review' && doc.issued_at) errors.push('a draft cannot carry issued_at');
  if (doc.purpose != null && !['diligence', 'competitive'].includes(doc.purpose)) errors.push('purpose must be diligence|competitive');

  // Sections: every required one, in order, with content.
  const req = REQUIRED_SECTIONS[doc.template] || null;
  if (!req) errors.push(`unknown template ${doc.template}`);
  const keys = (doc.sections || []).map((s) => s.key);
  for (const k of req || []) {
    const s = (doc.sections || []).find((x) => x.key === k);
    if (!s) errors.push(`section missing: ${k}`);
    else if (!(s.body || []).length && !(s.items || []).length) errors.push(`section empty: ${k}`);
  }
  if (req && keys.filter((k) => req.includes(k)).join() !== req.filter((k) => keys.includes(k)).join()) warnings.push('sections are not in the standard order');
  if (new Set(keys).size !== keys.length) errors.push('duplicate section keys');

  // Camera schedule.
  const cams = doc.camera_schedule || [];
  if (doc.template === 'security_cameras') {
    if (!cams.length) errors.push('camera schedule is empty');
    const ids = cams.map((c) => c.id);
    if (new Set(ids).size !== ids.length) errors.push('duplicate camera ids');
    for (const c of cams) {
      if (!['reused', 'replacement', 'new'].includes(c.disposition)) errors.push(`camera ${c.id}: disposition must be reused|replacement|new`);
      if (!c.location) errors.push(`camera ${c.id}: location missing`);
      if (!c.function) errors.push(`camera ${c.id}: function missing`);
    }
    if (baselineItem) { const r = reconcileScheduleToBaseline(cams, baselineItem); errors.push(...r.errors); }
  }

  // Pricing form and contract package carry every required line.
  const pf = doc.pricing_form || {};
  for (const [k] of PRICING_ONE_TIME) if (!(pf.one_time || []).some((l) => l.key === k)) errors.push(`pricing form missing one-time line: ${k}`);
  for (const [k] of PRICING_RECURRING_FIELDS) if (!(pf.recurring_fields || []).some((l) => l.key === k)) errors.push(`pricing form missing recurring field: ${k}`);
  for (const [k] of PRICING_TOTALS) if (!(pf.totals || []).some((l) => l.key === k)) errors.push(`pricing form missing total: ${k}`);
  for (const [k] of CONTRACT_PACKAGE) if (!(doc.contract_package || []).some((l) => l.key === k)) errors.push(`contract package missing: ${k}`);

  // Compliance matrix: unique ids, each tied to a real section, and every section answerable.
  const cm = doc.compliance_matrix || [];
  const cmIds = cm.map((r) => r.id);
  if (!cm.length) errors.push('compliance matrix is empty');
  if (new Set(cmIds).size !== cmIds.length) errors.push('duplicate compliance ids');
  for (const r of cm) { if (!keys.includes(r.section)) errors.push(`compliance ${r.id}: unknown section ${r.section}`); if (!r.requirement) errors.push(`compliance ${r.id}: requirement text missing`); }
  for (const k of (req || []).filter((x) => !['instructions', 'pricing', 'camera_schedule'].includes(x))) if (!cm.some((r) => r.section === k)) errors.push(`compliance matrix has no requirement for section ${k}`);

  // Decision state: all five, exact when expected, never "proceed".
  const ds = doc.decision_state || {};
  for (const k of DECISION_STATE_KEYS) {
    if (!ds[k]) errors.push(`decision_state.${k} missing`);
    else if (PROCEED_RE.test(ds[k])) errors.push(`decision_state.${k} uses "proceed", which reads as authorization to execute`);
    if (expectedDecisionState && ds[k] !== expectedDecisionState[k]) errors.push(`decision_state.${k} must read exactly "${expectedDecisionState[k]}"`);
  }

  for (const [k, v] of Object.entries(doc.decision_state_notes || {})) if (PROCEED_RE.test(String(v))) errors.push(`decision_state_notes.${k} uses "proceed", which reads as authorization to execute`);

  // Neutrality: no price, no baseline vendor or brand, in anything a vendor reads.
  for (const { where, text } of vendorFacingStrings(doc)) {
    if (MONEY_RE.test(text)) errors.push(`price in vendor-facing text (${where}): "${text.slice(0, 80)}"`);
    for (const term of forbiddenTerms) if (new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(text)) errors.push(`baseline vendor or brand "${term}" in vendor-facing text (${where})`);
  }
  for (const { where, text } of boardFacingStrings(doc)) for (const re of BANNED_ANYWHERE) if (re.test(text)) errors.push(`banned text ${re} in ${where}`);
  if (!doc.schedule || !doc.schedule.recommended_response_deadline) errors.push('recommended response deadline missing');
  if (!doc.governing_instruction) warnings.push('no governing instruction recorded');
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Responses: what each bidder returns, compared apples to apples.
// vendor_proposals.extracted_data.rfp_response = {
//   rfp_content_sha256, bidder_name, received_at,
//   compliance: [{ id, response: comply|exception|not_applicable, explanation }],
//   pricing: { one_time: { equipment: cents, ... }, recurring: [{ label, feature, monthly_cents | annual_cents,
//     required, is_monitoring, why_not_separate, non_monitoring_alternative, min_term_months, auto_renews }],
//     stated_totals: { base_installed_cents, first_year_cents, five_year_cents } },
//   camera_schedule: [{ id, disposition }], licenses, retention_days, earliest_start, duration_days,
//   contract_package: { proposal: true, ... } }
// ---------------------------------------------------------------------------

/** Deterministic totals from a response's pricing form. Pure. */
function computeResponseTotals(pricing = {}) {
  const issues = [];
  const ot = pricing.one_time || {};
  const missing = PRICING_ONE_TIME.map(([k]) => k).filter((k) => !Number.isInteger(ot[k]));
  if (missing.length) issues.push(`one-time lines not priced (enter 0 if none): ${missing.join(', ')}`);
  const base = PRICING_ONE_TIME.reduce((t, [k]) => t + (Number.isInteger(ot[k]) ? ot[k] : 0), 0);
  const recurring = (pricing.recurring || []).map((r) => {
    const monthly = Number.isInteger(r.monthly_cents) ? r.monthly_cents : Number.isInteger(r.annual_cents) ? Math.round(r.annual_cents / 12) : null;
    const problems = [];
    if (monthly == null) problems.push('amount missing');
    if (!r.feature) problems.push('feature not identified');
    if (r.required) {
      if (!r.why_not_separate) problems.push('required, but does not explain why the function cannot be provided separately');
      if (!r.non_monitoring_alternative) problems.push('required, but no non-monitoring alternative identified');
    }
    // Monitoring is never in the base bid, even if the bidder calls it required.
    const inBase = !!r.required && !r.is_monitoring;
    if (r.required && r.is_monitoring) problems.push('includes monitoring, which is excluded from the base bid; shown as a conditional add-on for the Board');
    return { label: r.label || '(unnamed)', feature: r.feature || null, monthly_cents: monthly, required: !!r.required, is_monitoring: !!r.is_monitoring, in_base: inBase, auto_renews: r.auto_renews ?? null, min_term_months: r.min_term_months ?? null, problems };
  });
  const reqMonthly = recurring.filter((r) => r.in_base && r.monthly_cents != null).reduce((t, r) => t + r.monthly_cents, 0);
  const optMonthly = recurring.filter((r) => !r.in_base && r.monthly_cents != null).reduce((t, r) => t + r.monthly_cents, 0);
  const totals = { base_installed_cents: base, first_year_cents: base + reqMonthly * 12, five_year_cents: base + reqMonthly * HORIZON_MONTHS,
    required_monthly_cents: reqMonthly, optional_monthly_cents: optMonthly, five_year_with_options_cents: base + (reqMonthly + optMonthly) * HORIZON_MONTHS };
  // Stated totals must equal computed ones; a disagreement is shown, never silently picked.
  const st = pricing.stated_totals || {};
  for (const [k, , ] of PRICING_TOTALS) {
    const key = `${k}_cents`;
    if (!Number.isInteger(st[key])) issues.push(`${k.replace('_', ' ')} total not stated`);
    else if (st[key] !== totals[key]) issues.push(`stated ${k.replace('_', ' ')} total ${money(st[key])} does not equal the lines (${money(totals[key])})`);
  }
  return { totals, recurring, issues };
}

/** Compliance answers against the matrix. Pure. */
function scoreCompliance(matrix, answers = []) {
  const byId = Object.fromEntries((answers || []).map((a) => [a.id, a]));
  const rows = (matrix || []).map((r) => {
    const a = byId[r.id];
    const response = a && COMPLIANCE_RESPONSES.includes(a.response) ? a.response : null;
    const issue = !a ? 'no answer' : !response ? `answer "${a.response}" is not Comply, Exception or Not Applicable`
      : (response !== 'comply' && !String(a.explanation || '').trim()) ? 'explanation required' : null;
    return { id: r.id, section: r.section, requirement: r.requirement, response, explanation: (a && a.explanation) || null, issue };
  });
  const count = (x) => rows.filter((r) => r.response === x).length;
  return { rows, comply: count('comply'), exception: count('exception'), not_applicable: count('not_applicable'), unanswered: rows.filter((r) => !r.response).length, exceptions: rows.filter((r) => r.response === 'exception'), incomplete: rows.filter((r) => r.issue) };
}

/** Camera counts from a response's schedule, through the same deterministic counter. */
function responseCameraCounts(resp) {
  const lines = (resp.camera_schedule || []).map((c) => ({ description: `${c.id} ${c.location || ''}`.trim(), category: c.disposition === 'reused' ? 'camera_reused' : 'camera_new', quantity: 1, certainty: 'certain' }));
  if (!lines.length) return null;
  return computeQuantities({ line_items: lines, line_items_status: 'approved' }).values;
}

/**
 * Compare every response on the record against the RFP. Pure.
 * proposals: vendor_proposals rows; only those with extracted_data.rfp_response count.
 * Returns { rows: [...], not_responded_note } — never ranks, never recommends.
 */
function compareResponses(doc, proposals = []) {
  const rows = [];
  for (const p of proposals) {
    const resp = p && p.extracted_data && p.extracted_data.rfp_response;
    if (!resp) continue;
    const pricing = computeResponseTotals(resp.pricing);
    const compliance = scoreCompliance(doc.compliance_matrix, resp.compliance);
    const pkg = CONTRACT_PACKAGE.map(([k, label]) => ({ key: k, label, provided: !!(resp.contract_package || {})[k] }));
    const cams = responseCameraCounts(resp);
    const scheduleIssues = [];
    const want = cameraTotals(doc.camera_schedule);
    if (cams && cams.cameras_total !== want.total) scheduleIssues.push(`bid covers ${cams.cameras_total} cameras; the RFP schedule has ${want.total}`);
    if (!cams) scheduleIssues.push('no camera schedule returned');
    if (resp.licenses != null && cams && Number(resp.licenses) < cams.cameras_total) scheduleIssues.push(`${resp.licenses} licenses for ${cams.cameras_total} cameras; the bidder must say which cameras are unlicensed and why`);
    rows.push({
      proposal_id: p.id, bidder: resp.bidder_name || p.proposer_company_name, received_at: resp.received_at || null,
      answers_current_version: !!(resp.rfp_content_sha256 && resp.rfp_content_sha256 === doc.content_sha256),
      totals: pricing.totals, recurring: pricing.recurring, pricing_issues: pricing.issues,
      compliance: { comply: compliance.comply, exception: compliance.exception, not_applicable: compliance.not_applicable, unanswered: compliance.unanswered, exceptions: compliance.exceptions, incomplete: compliance.incomplete },
      contract_package: pkg, contract_package_missing: pkg.filter((x) => !x.provided).map((x) => x.label),
      cameras: cams, licenses: resp.licenses ?? null, retention_days: resp.retention_days ?? null, earliest_start: resp.earliest_start || null, duration_days: resp.duration_days ?? null,
      schedule_issues: scheduleIssues,
      complete: !pricing.issues.length && !compliance.incomplete.length && !pkg.some((x) => !x.provided) && !scheduleIssues.length,
    });
  }
  return { rows, horizon_months: HORIZON_MONTHS };
}

module.exports = {
  SCHEMA, DOCUMENT_STATUSES, CAMERA_SECTIONS, REQUIRED_SECTIONS, PRICING_ONE_TIME, PRICING_RECURRING_FIELDS, PRICING_TOTALS,
  CONTRACT_PACKAGE, COMPLIANCE_RESPONSES, DECISION_STATE_KEYS, DECISION_STATE_LABELS, HORIZON_MONTHS,
  canonical, contentHash, buildRfpDocument, cameraTotals, reconcileScheduleToBaseline, vendorFacingStrings, boardFacingStrings,
  validateRfpDocument, computeResponseTotals, scoreCompliance, responseCameraCounts, compareResponses,
};
