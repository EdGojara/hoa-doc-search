// ============================================================================
// lib/vendors/proposal_save.js  (Ed 2026-10-16: one-time save with selective confidence)
// ----------------------------------------------------------------------------
// Saves reviewed proposal data onto the RFP / Bid Workflow so ordinary reruns read
// stored, approved facts instead of extracting again. Each proposal is saved in a mode
// chosen EXPLICITLY in a plan file (never inferred from vendor names):
//
//   full                 the full normalized proposal + all reconciled line items (quantity,
//                        category, page, excerpt, certainty) + version/audit metadata.
//   proposal_facts_only  vendor, date, expiry, upfront price, recurring charges, contract term,
//                        monitoring/service structure, major scope, source references. NO line
//                        items and NO camera/license counts as facts.
//   historical_minimal   vendor, date, upfront price, source pages, and the replaced-by link.
//
// Ed chose option (a): CREATE one bid_requests row and one vendor_proposals row per canonical
// proposal. Duplicate copies are references on the canonical row (source_documents), never rows.
// No vendor is created (vendor_id stays null unless the plan names an existing vendor id), no
// file is uploaded (each row points at its existing email attachment / library document), and
// no rfp_decision_log row is written (migration 531 is not applied): the audit trail lives in
// extracted_data.audit.
//
// IDEMPOTENT. planSave() reads a read-only snapshot of what already exists and matches each
// planned proposal by community + source document sha256 + proposal key + this RFP (never by
// vendor name). A full, consistent prior save is a no-op ("already saved"). Anything partial or
// inconsistent is a CONFLICT with ids, and nothing is written.
//
// Approval provenance: a chat instruction is recorded as approval.channel 'chat_instruction'
// with a label and approved_by_user_id null, never as an authenticated approver.
// Pure: planSave() returns every row and field; scripts/save_proposal_data.js writes only with --apply.
// ============================================================================
const C = require('./proposal_comparison');
const V = require('./line_item_versions');

const MODES = ['full', 'proposal_facts_only', 'historical_minimal'];
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|lp|corp|co|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** Validate a plan file. Throws with every problem listed. */
function validatePlan(plan) {
  const e = [];
  if (!plan || typeof plan !== 'object') throw new Error('plan must be a JSON object');
  if (!plan.community_id) e.push('community_id is required');
  if (plan.storage_mode !== 'create') e.push('storage_mode must be "create" (Ed chose option (a))');
  if (!plan.bid_request || !plan.bid_request.title || !plan.bid_request.service_category) e.push('bid_request.title and bid_request.service_category are required');
  const a = plan.approval || {};
  if (!['chat_instruction', 'in_app'].includes(a.channel)) e.push('approval.channel must be "chat_instruction" or "in_app"');
  if (!a.approved_by_label) e.push('approval.approved_by_label is required');
  if (a.channel === 'chat_instruction' && a.approved_by_user_id != null) e.push('approval.approved_by_user_id must be null for a chat instruction');
  if (!Array.isArray(plan.proposals) || !plan.proposals.length) e.push('proposals[] is required');
  const keys = new Set();
  for (const [i, p] of (plan.proposals || []).entries()) {
    if (!p.document_sha256) e.push(`proposals[${i}].document_sha256 is required`);
    if (!p.proposal_key) e.push(`proposals[${i}].proposal_key is required`);
    if (keys.has(p.proposal_key)) e.push(`proposals[${i}].proposal_key ${p.proposal_key} is listed twice`);
    keys.add(p.proposal_key);
    if (!MODES.includes(p.mode)) e.push(`proposals[${i}].mode must be one of ${MODES.join(', ')} (it is never inferred)`);
    if (p.mode === 'historical_minimal' && !p.replaced_by_key) e.push(`proposals[${i}].replaced_by_key is required for historical_minimal`);
  }
  if (e.length) throw new Error(`invalid save plan:\n  - ${e.join('\n  - ')}`);
  return true;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

/** Exactly the fields each mode stores. */
function project(item, mode, { replacedBy = null } = {}) {
  const doc = pick(item.document || {}, ['source_kind', 'filename', 'pages', 'sha256', 'size_bytes', 'received_at', 'message', 'ref']);
  const base = { key: item.key, vendor_name: item.vendor_name, document_date: item.document_date || null, document: doc, save_mode: mode };
  const pr = item.pricing || {};
  if (mode === 'full') {
    const { quantities, line_items_stored, line_items_status, line_items_source, _new_document_sha, existing_proposal_id, same_file_as, ...rest } = item;
    return { ...rest, save_mode: mode };
  }
  if (mode === 'proposal_facts_only') {
    const scope = pick(item.scope || {}, ['summary', 'retention_days']);   // no locations, no counts
    return {
      ...base,
      quote_number: item.quote_number || null, revision: item.revision ?? null, expires_on: item.expires_on || null, budgetary: !!item.budgetary,
      pricing: { upfront_cents: Number.isInteger(pr.upfront_cents) ? pr.upfront_cents : null, tax_rate_pct: pr.tax_rate_pct ?? null, tax_included: !!pr.tax_included, unpriced: !!pr.unpriced || (!Number.isInteger(pr.upfront_cents) && !(pr.recurring || []).length),
        recurring: (pr.recurring || []).map((r) => pick(r, ['label', 'monthly_cents', 'required', 'min_term_months', 'auto_renews', 'taxable', 'provides'])) },
      model: pick(item.model || {}, ['ownership', 'monitoring', 'cloud_access']),
      scope, other_terms: item.other_terms || [], timing: item.timing || null, warranty: item.warranty || null, payment_terms: item.payment_terms || null,
    };
  }
  return { ...base, pricing: { upfront_cents: Number.isInteger(pr.upfront_cents) ? pr.upfront_cents : null, ...(pr.unpriced ? { unpriced: true } : {}) }, replaced_by: replacedBy };
}

/**
 * The save, reconciled against what already exists.
 *   itemsByDoc  { sha256: [extracted items] } (the reviewed preview-cache version)
 *   snapshot    read-only current state: { bid_requests, vendor_proposals, vendors, library_documents }
 * Returns { inserts, noops, conflicts, vendor_matches, record, summary }. Nothing here writes.
 */
function planSave(plan, itemsByDoc, { mgmtId, communityName = null, today, at = new Date().toISOString(), snapshot = {} } = {}) {
  validatePlan(plan);
  const cat = plan.bid_request.service_category;
  const chosen = plan.proposals.map((p) => {
    const it = (itemsByDoc[p.document_sha256] || []).find((x) => x.key === p.proposal_key);
    if (!it) throw new Error(`proposal ${p.proposal_key} not found in document ${p.document_sha256.slice(0, 12)} (nothing is saved for a proposal we cannot see)`);
    return { p, item: { ...it, document: { ...(it.document || {}), sha256: p.document_sha256 } } };
  });
  const record = C.buildComparisonRecord({ community: { id: plan.community_id, name: communityName }, project: { title: plan.bid_request.title, service_category: cat }, proposals: chosen.map((c) => c.item), requirements: plan.requirements || {}, facts: null, today });
  const byKey = Object.fromEntries(record.proposals.map((n) => [n.key, n]));
  const approval = { channel: plan.approval.channel, approved_by_label: plan.approval.approved_by_label, approved_by_user_id: plan.approval.channel === 'chat_instruction' ? null : (plan.approval.approved_by_user_id || null), at: plan.approval.approved_at || at };

  const inserts = []; const noops = []; const conflicts = []; const vendorMatches = [];
  // ---- the RFP: this community + category + title
  const bids = (snapshot.bid_requests || []).filter((b) => b.community_id === plan.community_id && b.service_category === cat && b.title === plan.bid_request.title);
  if (bids.length > 1) conflicts.push(`${bids.length} bid_requests already match "${plan.bid_request.title}" (${bids.map((b) => b.id).join(', ')})`);
  const bid = bids.length === 1 ? bids[0] : null;
  if (!bid) inserts.push({ table: 'bid_requests', ref: 'bid_request', row: { management_company_id: mgmtId, community_id: plan.community_id, community: communityName, service_category: cat, vendor_type: plan.bid_request.vendor_type || 'Security Services', title: plan.bid_request.title, status: 'evaluating' } });
  else noops.push({ table: 'bid_requests', id: bid.id, note: 'already exists' });

  // ---- proposals: matched by community + sha256 + proposal key; never by vendor name
  const shas = new Set(plan.proposals.map((p) => p.document_sha256));
  const plannedKeysBySha = {};
  for (const p of plan.proposals) (plannedKeysBySha[p.document_sha256] = plannedKeysBySha[p.document_sha256] || new Set()).add(p.proposal_key);
  const existingRows = (snapshot.vendor_proposals || []).filter((r) => r.community_id === plan.community_id && shas.has(r.file_hash));
  for (const r of existingRows) {
    const k = (r.extracted_data || {}).proposal_key;
    if (!k || !plannedKeysBySha[r.file_hash].has(k)) conflicts.push(`vendor_proposals ${r.id} has the same source file (${String(r.file_hash).slice(0, 12)}) but is not one of the planned proposals (proposal_key ${k || 'none'})`);
  }
  let matched = 0;
  for (const { p, item } of chosen) {
    const m = existingRows.filter((r) => r.file_hash === p.document_sha256 && (r.extracted_data || {}).proposal_key === p.proposal_key);
    if (m.length > 1) { conflicts.push(`${m.length} vendor_proposals rows already exist for ${p.proposal_key} (${m.map((r) => r.id).join(', ')})`); continue; }
    if (m.length === 1) {
      const r = m[0]; matched++;
      if (!bid || r.bid_request_id !== bid.id) conflicts.push(`vendor_proposals ${r.id} (${p.proposal_key}) is attached to bid_request ${r.bid_request_id || 'none'}, not ${bid ? bid.id : 'the planned new request'}`);
      else if ((r.extracted_data || {}).save_mode !== p.mode) conflicts.push(`vendor_proposals ${r.id} (${p.proposal_key}) was saved as ${(r.extracted_data || {}).save_mode}, the plan says ${p.mode}`);
      else noops.push({ table: 'vendor_proposals', id: r.id, ref: p.proposal_key, note: 'already saved' });
      continue;
    }
    // Not saved yet.
    const n = byKey[item.key] || {};
    const stored = project(item, p.mode, { replacedBy: p.replaced_by_key || null });
    const ed = V.approveVersion(V.addVersion({}, { items: [stored], document_sha256: p.document_sha256, reason: `one-time save (${p.mode})`, requested_by: approval.approved_by_label, at: approval.at }), 1, { approval_channel: approval.channel, approved_by_label: approval.approved_by_label, approved_by_user_id: approval.approved_by_user_id, at: approval.at });
    // Sources: the existing email attachment(s) from the plan, plus any library document with the same hash. No uploads.
    const libs = (snapshot.library_documents || []).filter((d) => d.file_hash && (d.file_hash === p.document_sha256 || (p.duplicates || []).some((x) => x.document_sha256 === d.file_hash)));
    const source_documents = [
      ...(p.sources || []).map((s) => ({ ...s, role: 'canonical' })),
      ...libs.map((d) => ({ kind: 'library_document', library_document_id: d.id, title: d.title, sha256: d.file_hash, role: d.file_hash === p.document_sha256 ? 'canonical' : 'duplicate' })),
      ...(p.duplicates || []).map((d) => ({ kind: 'duplicate_copy', ...d, role: 'duplicate' })),
    ];
    // Vendor: never created; matched only by an explicit existing id. Exact-name candidates are reported, not used.
    const exact = (snapshot.vendors || []).filter((v) => v.is_active !== false && normName(v.name) === normName(item.vendor_name));
    const byId = p.vendor_id ? (snapshot.vendors || []).find((v) => v.id === p.vendor_id) : null;
    if (p.vendor_id && !byId) conflicts.push(`plan names vendor_id ${p.vendor_id} for ${p.proposal_key}, but no such vendor exists`);
    vendorMatches.push({ ref: p.proposal_key, vendor_name: item.vendor_name, vendor_id: byId ? byId.id : null, exact_name_candidates: exact.map((v) => ({ id: v.id, name: v.name })) });
    const audit = [
      { action: 'associate', at: approval.at, note: `Saved to the RFP / Bid Workflow from ${source_documents.map((s) => s.kind).join(' + ') || 'the reviewed extraction'}; no upload.` },
      { action: 'classify', at: approval.at, note: `${n.status}: ${n.status_reason}` },
      { action: 'approve', at: approval.at, note: `Saved as ${p.mode}; approved by ${approval.approved_by_label} via ${approval.channel}.` },
    ];
    inserts.push({ table: 'vendor_proposals', ref: p.proposal_key, row: {
      management_company_id: mgmtId, community_id: plan.community_id, community: communityName, bid_request_id: bid ? bid.id : '<bid_request.id>',
      service_category: cat, document_type: 'project_bid', proposer_company_name: item.vendor_name, vendor_name_raw: item.vendor_name, vendor_id: byId ? byId.id : null,
      filename: (item.document || {}).filename || null, proposal_date: item.document_date || null, proposal_number: item.quote_number || null,
      total_amount: Number.isInteger((item.pricing || {}).upfront_cents) ? item.pricing.upfront_cents / 100 : null, currency: 'USD',
      term_months: n.contract_term_months || null, outcome: n.status === 'expired' ? 'expired' : 'pending', is_finalist: false,
      extraction_status: 'extracted', file_hash: p.document_sha256, file_size_bytes: (item.document || {}).size_bytes || null, file_path: null,
      extracted_data: { ...ed, proposal_key: p.proposal_key, save_mode: p.mode, classification: { status: n.status || null, status_reason: n.status_reason || null, replaced_by: p.replaced_by_key || null }, source_documents, audit },
    } });
  }
  // Partial state: the RFP exists but not every planned proposal is on it, or some proposals exist without the RFP.
  if (bid && matched < chosen.length) conflicts.push(`bid_request ${bid.id} exists with ${matched} of ${chosen.length} planned proposals (partial save); not adding rows silently`);
  if (!bid && matched > 0) conflicts.push(`${matched} planned proposal(s) already exist but their bid_request does not`);
  const summary = conflicts.length ? `CONFLICT: ${conflicts.length} problem(s); nothing will be written`
    : !inserts.length ? '0 inserts, 0 updates, already saved'
    : `${inserts.length} insert(s) (${inserts.filter((i) => i.table === 'bid_requests').length} bid_requests, ${inserts.filter((i) => i.table === 'vendor_proposals').length} vendor_proposals), 0 updates, 0 vendors, 0 uploads, 0 rfp_decision_log`;
  return { inserts: conflicts.length ? [] : inserts, planned_inserts: inserts, noops, conflicts, vendor_matches: vendorMatches, record, summary };
}

/** The snapshot as it would be after the inserts (fake ids), for the simulated second run. */
function layerSaved(snapshot, inserts) {
  const s = { bid_requests: [...(snapshot.bid_requests || [])], vendor_proposals: [...(snapshot.vendor_proposals || [])], vendors: snapshot.vendors || [], library_documents: snapshot.library_documents || [] };
  let bidId = null; let n = 0;
  for (const i of inserts) {
    if (i.table === 'bid_requests') { bidId = `simulated-bid-request`; s.bid_requests.push({ id: bidId, ...i.row }); }
    else s.vendor_proposals.push({ id: `simulated-vp-${++n}`, ...i.row, bid_request_id: i.row.bid_request_id === '<bid_request.id>' ? bidId : i.row.bid_request_id });
  }
  return s;
}

/**
 * Board-summary sentence for an excluded proposal, from its deterministic reasons only (stable,
 * decision-relevant facts). Ed's exact wording where the facts support it.
 */
function exclusionSentence(vendorShort, reasons) {
  const has = (re) => (reasons || []).some((r) => re.test(r));
  if (has(/no price provided/) && has(/monitoring/)) return `${vendorShort} is not a viable current alternative because no executable price was provided and the design incorporates monitoring the Board has said it does not want.`;
  if (has(/quote expired/) && has(/monitoring-heavy/)) return `${vendorShort} is not recommended because the quote is expired and the package is built around substantial recurring monitoring/service costs the Board has said it does not want.`;
  return null;
}

module.exports = { MODES, validatePlan, project, planSave, layerSaved, exclusionSentence };
