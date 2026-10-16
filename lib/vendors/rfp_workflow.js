// ============================================================================
// lib/vendors/rfp_workflow.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// Puts a proposal / competing-bid matter on the community's RFP / Bid Workflow
// record (the existing Vendor tab workflow: bid_requests + vendor_proposals +
// vendor_comparisons + rfp_decision_log), instead of doing the comparison only
// inside Amanda's email.
//
//   prepareComparison()   detect -> gather (email attachments, library documents,
//                         proposals already on file; no re-upload) -> extract new
//                         documents -> pull financial facts with their confidence ->
//                         build the record -> plan the writes -> (write) -> render
//                         the Board's executive summary
//
// Write mode is a deployment switch, not a code change:
//   AMANDA_RFP_WORKFLOW = dry_run (default) | write | off
//     dry_run  everything is computed and returned (and shown to the reviewer),
//              nothing is written. Safe default until migration 531 is applied.
//     write    creates/updates the workflow record ("C. Skip, just compare"),
//              associates proposals, stores the analysis + audit trail.
//     off      no comparison work at all.
// Never: posts entries, approves, eliminates a bid, marks a finalist, creates a
// vendor, or sends email. Routine vendor diligence is QUEUED on the record
// (status queued_not_sent); sending is a separate, allowlisted step.
// ============================================================================
const crypto = require('crypto');
const C = require('./proposal_comparison');

const BUCKET = 'documents';
const MODES = ['off', 'dry_run', 'write'];
function workflowMode(env = process.env) { const m = String(env.AMANDA_RFP_WORKFLOW || 'dry_run').toLowerCase(); return MODES.includes(m) ? m : 'dry_run'; }

// Project category from the words in play. Values are vendor_service_categories keys.
const CATEGORY_WORDS = [
  ['security', /\b(camera|cctv|surveillance|video|lpr|license plate|security|access control|gate guard)\b/i],
  ['pool_management', /\b(pool|aquatic)\b/i],
  ['landscape_maintenance', /\b(landscap|mow|irrigation)\b/i],
  ['painting', /\bpaint/i],
  ['repair', /\b(repair|fence|gate)\b/i],
];
function inferProject(text, communityName, today) {
  const cat = (CATEGORY_WORDS.find(([, re]) => re.test(text)) || ['other'])[0];
  const topic = /\b(camera|cctv|surveillance|video)\b/i.test(text) ? 'Security Camera System' : cat === 'other' ? 'Vendor Proposals' : cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { service_category: cat, title: `${topic} ${String(today).slice(0, 4)}${communityName ? ` (${communityName})` : ''}`, keyword: (text.match(/\b(camera|surveillance|security|pool|landscap\w*|paint\w*|fence|gate)\b/i) || [null])[0] };
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|lp|corp|co|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Resolve a vendor READ-ONLY against Vendor 360 (same rule as AP intake's
 * resolveVendor: active vendors, exact normalized name or dba, one hit only).
 * Never creates a vendor: an unresolved proposal keeps vendor_id null and the
 * printed name, so a missing vendor record never blocks a comparison.
 */
async function resolveVendorReadOnly(supabase, name, mgmtId) {
  if (!name) return { vendor_id: null, method: 'none' };
  const { data, error } = await supabase.from('vendors').select('id, name, dba').eq('management_company_id', mgmtId).neq('is_active', false).limit(2000);
  if (error) return { vendor_id: null, method: 'lookup_failed', error: error.message };
  const n = normName(name); const first = n.split(' ')[0];
  const exact = (data || []).filter((v) => normName(v.name) === n || (v.dba && normName(v.dba) === n));
  if (exact.length === 1) return { vendor_id: exact[0].id, method: 'name', vendor_name: exact[0].name };
  const loose = (data || []).filter((v) => normName(v.name).split(' ')[0] === first && first.length >= 4);
  if (loose.length === 1 && !exact.length) return { vendor_id: null, method: 'candidate', candidate: loose[0] };
  return { vendor_id: null, method: exact.length > 1 ? 'ambiguous' : 'unresolved' };
}

/** Proposals already on the workflow for this community (reused, never re-extracted). */
async function loadExisting(supabase, communityId, category) {
  const out = { proposals: [], bidRequests: [], library: [], errors: [] };
  const [vp, br] = await Promise.all([
    supabase.from('vendor_proposals').select('id, bid_request_id, proposer_company_name, vendor_name_raw, service_category, file_hash, extracted_data, created_at').eq('community_id', communityId).order('created_at', { ascending: false }).limit(200),
    supabase.from('bid_requests').select('id, title, status, service_category, created_at').eq('community_id', communityId).order('created_at', { ascending: false }).limit(50),
  ]);
  if (vp.error) out.errors.push(`vendor_proposals: ${vp.error.message}`); else out.proposals = (vp.data || []).filter((p) => !category || p.service_category === category || !p.service_category);
  if (br.error) out.errors.push(`bid_requests: ${br.error.message}`); else out.bidRequests = br.data || [];
  return out;
}

async function loadLibrary(supabase, communityId, keyword) {
  if (!keyword) return { docs: [] };
  const { data, error } = await supabase.from('library_documents').select('id, title, category, file_path, file_hash, created_at').eq('community_id', communityId).ilike('title', `%${keyword}%`).order('created_at', { ascending: false }).limit(20);
  if (error) return { docs: [], error: error.message };
  return { docs: data || [] };
}

/**
 * The full comparison for one inbound message. Read-only unless mode === 'write'.
 *   attachments        [{filename, buffer}] already fetched (else fetched from Graph)
 *   factsDetailed      boardDecisionFactsDetailed() result (else retrieved here)
 *   extract            injectable extractor (tests); defaults to proposal_extract
 */
async function prepareComparison({ supabase, communityId, communityName, email = {}, mailbox, graphId, attachments = null, today, mode = workflowMode(), factsDetailed = null, extract = null, mgmtId = null, greetingName = null, linkBase = null, retrieveDocs = null, intent = null, reprocess = null, previewCache = null } = {}) {
  // reprocess: { requested_by, reason } - explicit only; extracts fresh and reports the difference, never swaps it in.
  // previewCache: { get(sha) -> extracted_data | null, put(sha, extracted_data) } - local, never the database.
  const V = require('./line_item_versions');
  const extractionLog = [];
  if (mode === 'off') return { is_matter: false, mode };
  const asOf = today || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const body = `${email.subject || ''}\n${email.body || email.body_preview || ''}`;
  const attNames = attachments ? attachments.map((a) => ({ name: a.filename, isInline: false })) : (email.attachments || []).map((a) => ({ name: a.name || a.filename, isInline: !!a.isInline }));
  const project = inferProject(`${body}\n${attNames.map((a) => a.name).join('\n')}`, communityName, asOf);
  const existing = await loadExisting(supabase, communityId, project.service_category);
  const det = C.detectComparisonMatter({ subject: email.subject, body: email.body || email.body_preview, attachments: attNames, existingProposals: existing.proposals });
  if (!det.is_matter) return { is_matter: false, mode, detection: det };

  const notes = [...existing.errors];
  // Question first: the sender's intent is read before anything else and stored with the analysis.
  const theIntent = intent || require('../team/intent').extractIntent({ subject: email.subject, body: email.body || email.body_preview, sender_name: email.sender_name || null });
  const requirements = C.boardRequirements(body);
  const mgmt = mgmtId || require('../company').BEDROCK_MGMT_CO_ID;

  // Gather: proposals on file first (by file hash), then the attachments, then the library.
  const items = []; const byHash = {}; const documents = [];
  for (const p of existing.proposals) {
    const approvedV = V.currentUsable(p.extracted_data);
    const saved = approvedV ? approvedV.items : ((p.extracted_data && p.extracted_data.comparison_items) || null);
    if (p.file_hash) byHash[p.file_hash] = (byHash[p.file_hash] || []).concat([p]);
    if (saved) for (const it of saved) items.push({ ...it, line_items_stored: Array.isArray(it.line_items), line_items_status: approvedV ? approvedV.status : 'pending_approval', line_items_source: approvedV ? `stored v${approvedV.version} (${approvedV.status})` : 'stored (unversioned)', existing_proposal_id: p.id, document: { ...(it.document || {}), source_kind: 'vendor_proposal', ref: p.id } });
  }
  let files = attachments;
  if (!files && mailbox && graphId) {
    try { files = await require('../email/graph_attachments').fetchAllAttachmentBuffers(mailbox, graphId); if (files.failed && files.failed.length) notes.push(`attachments not downloaded: ${files.failed.map((f) => f.filename).join(', ')}`); }
    catch (e) { notes.push(`attachments unavailable: ${e.message}`); files = []; }
  }
  const lib = await loadLibrary(supabase, communityId, project.keyword);
  if (lib.error) notes.push(`library documents unavailable: ${lib.error}`);
  const extractor = extract || ((buf, meta) => require('./proposal_extract').extractProposals(buf, meta));
  const received = String(email.received_at || email.receivedDateTime || asOf).slice(0, 10);
  for (const f of (files || []).filter((x) => x.isPdf !== false && /\.pdf$/i.test(x.filename || ''))) {
    const sha = crypto.createHash('sha256').update(f.buffer).digest('hex');
    documents.push({ filename: f.filename, sha256: sha, size_bytes: f.buffer.length, buffer: f.buffer, origin: 'email_attachment' });
    if (byHash[sha]) {
      // Already on the workflow: re-associate, never re-extract or re-upload. A copy received
      // again is still recorded, so classification can show it as the duplicate it is.
      const usableV = V.currentUsable(byHash[sha][0].extracted_data);
      const saved = byHash[sha].flatMap((p) => ((V.currentUsable(p.extracted_data) || {}).items || (p.extracted_data || {}).comparison_items || []).map((it) => ({ ...it, line_items_stored: Array.isArray(it.line_items), line_items_status: usableV ? usableV.status : 'pending_approval', line_items_source: 'stored', key: `${it.key}@${received}`, same_file_as: it.key, document: { ...(it.document || {}), source_kind: 'email_attachment', filename: f.filename, sha256: sha, received_at: received } })));
      items.push(...saved);
      extractionLog.push({ file: f.filename, sha256: sha, source: usableV ? `stored v${usableV.version} (${usableV.status})` : 'stored', extracted: false });
      // Explicit reprocessing of a stored document: extract fresh, report the difference against the
      // approved version, never swap it in (the approved items above are what the analysis uses).
      if (reprocess) {
        const fresh = await extractor(f.buffer, { filename: f.filename, source_kind: 'email_attachment', received_at: received, message: email.subject || null });
        const ed = byHash[sha][0].extracted_data || {};
        const next = V.addVersion(ed, { items: fresh.items || [], document_sha256: sha, reason: reprocess.reason, requested_by: reprocess.requested_by });
        const v = next.line_item_versions[next.line_item_versions.length - 1];
        extractionLog.push({ file: f.filename, sha256: sha, source: 'fresh (reprocess, not stored)', extracted: true, version: v.version, compared: v.compared_with || null, review_flag: v.review_flag || null, differs: v.differs_from_approved || [] });
      }
      continue;
    }
    // Not on the workflow yet: the local preview cache first (dry runs), else extract once.
    const cached = previewCache ? previewCache.get(sha) : null;
    const cachedV = cached ? V.currentUsable(cached) : null;
    let fresh = null; let src;
    if (cachedV && !reprocess) { src = `preview cache v${cachedV.version} (${cachedV.status})`; }
    else {
      fresh = await extractor(f.buffer, { filename: f.filename, source_kind: 'email_attachment', received_at: received, message: email.subject || null });
      src = reprocess ? 'fresh (reprocess)' : 'fresh extraction';
      assertNoneDropped(f.filename, fresh);
      if (fresh.diagnostic && fresh.diagnostic.invalid && fresh.diagnostic.invalid.length) notes.push(`extraction issues in ${f.filename}: ${JSON.stringify(fresh.diagnostic.invalid).slice(0, 400)}`);
      if (previewCache && (fresh.items || []).length) {
        const next = V.addVersion(cached || {}, { items: fresh.items || [], document_sha256: sha, reason: reprocess ? reprocess.reason : 'preview extraction', requested_by: reprocess ? reprocess.requested_by : null, preview: true });
        previewCache.put(sha, next);
        const v = next.line_item_versions[next.line_item_versions.length - 1];
        extractionLog.push({ file: f.filename, sha256: sha, source: src, extracted: true, cached_as_version: v.version, compared: v.compared_with || null, review_flag: v.review_flag || null, differs: v.differs_from_approved || [] });
      } else extractionLog.push({ file: f.filename, sha256: sha, source: src, extracted: true, proposals: (fresh.items || []).length });
    }
    if (!fresh) extractionLog.push({ file: f.filename, sha256: sha, source: src, extracted: false });
    const useItems = fresh ? (fresh.items || []) : cachedV.items;
    // Not stored on the record: counts are provisional until the line items are stored.
    for (const it of useItems) items.push({ ...it, line_items_stored: false, line_items_status: fresh ? 'not_yet_stored' : 'preview', line_items_source: src, _new_document_sha: sha });
  }
  for (const d of lib.docs) if (d.file_hash && !byHash[d.file_hash]) documents.push({ filename: d.title, sha256: d.file_hash, origin: 'library_document', library_document_id: d.id, file_path: d.file_path, not_extracted: true });

  // Financial facts with their confidence (reuse the board facts retrieval).
  let facts = factsDetailed;
  if (!facts) { try { facts = await require('../amanda/decision_ready').boardDecisionFactsDetailed(supabase, communityId, body, { today: asOf }); } catch (e) { notes.push(`financial facts unavailable: ${e.message}`); facts = null; } }

  // What trustEd already knows about this community and topic (prior decisions, contracts, spend,
  // projects, reserve components, Board correspondence, Vendor 360). Never the message being answered.
  let context = [];
  try {
    const cx = await require('./community_context').gatherCommunityContext(supabase, {
      communityId, communityName, category: project.service_category, proposalVendors: [...new Set(items.map((i) => i.vendor_name).filter(Boolean))],
      excludeMessageIds: [email.id, email.source_message_id].filter(Boolean), currentMessage: { id: email.id || null, graph_id: email.graph_id || graphId || null, internet_message_id: email.internet_message_id || null, conversation_id: email.conversation_id || null, subject: email.subject, received_at: email.received_at || email.receivedDateTime || null }, today: asOf, retrieveDocs,
    });
    context = cx.findings; if (cx.errors.length) notes.push(`community context partly unavailable: ${cx.errors.join('; ')}`);
  } catch (e) { notes.push(`community context unavailable: ${e.message}`); }

  const record = C.buildComparisonRecord({ intent: theIntent, context, community: { id: communityId, name: communityName }, project, proposals: items, requirements, facts: facts ? { mode: facts.mode, cash_label: facts.cash_label, funds: facts.funds, budget: facts.budget && { label: facts.budget.label, reason: facts.budget.reason, lines: facts.budget.lines || [] }, payables: facts.payables } : null, today: asOf, source: { message_subject: email.subject || null, received_at: received, from: email.sender_email || email.from || null } });
  record.notes = notes;
  record.documents = documents.map(({ buffer, ...d }) => d);

  // Vendor resolution, read-only. Unresolved never blocks the comparison.
  for (const n of record.proposals) {
    if (n.status === 'duplicate') continue;
    n.vendor_resolution = await resolveVendorReadOnly(supabase, n.vendor_name, mgmt);
  }

  const plan = planWrites(record, { communityId, communityName, mgmtId: mgmt, existing, items, documents });
  let written = null;
  if (mode === 'write') written = await applyWrites(supabase, plan, { documents });
  const rfpId = written ? written.bid_request_id : plan.bid_request.id || null;
  const link = rfpId ? `${linkBase || process.env.TRUSTED_URL || 'https://my.bedrocktxai.com'}/?tab=vendor&rfp=${rfpId}` : null;
  const summary = C.renderBoardSummary(record, { greetingName: greetingName || 'Board', link });
  // Every proposal that went in must come out in the classification (duplicates included). Loud, never silent.
  const fedIn = items.length; const classified = record.proposals.length;
  const unexplained = record.proposals.filter((n) => !n.status || !n.status_reason || (n.status === 'duplicate' && !n.duplicate_of));
  if (classified !== fedIn || unexplained.length) throw new Error(`comparison completeness check failed: ${fedIn} proposal(s) discovered, ${classified} carried into the comparison${unexplained.length ? `, ${unexplained.length} without a classified reason (${unexplained.map((n) => n.key).join(', ')})` : ''}`);
  record.extraction_log = extractionLog;
  return { is_matter: true, mode, detection: det, record, plan, written, link, summary, extraction_log: extractionLog, block: promptBlock(record, summary, mode, link) };
}

/** Extraction returned N proposals; all N must survive parsing. Otherwise fail the run with the counts. */
function assertNoneDropped(file, r) {
  const d = (r && r.diagnostic) || {};
  const returned = Number(d.returned_count || 0); const parsed = (r.items || []).length;
  if (returned > parsed) throw new Error(`extraction dropped ${returned - parsed} of ${returned} proposal(s) in ${file}${(d.truncated || []).length ? ` (${d.truncated.join('; ')})` : ''}${(d.invalid || []).length ? ` (${JSON.stringify(d.invalid).slice(0, 300)})` : ''}`);
  if (!parsed) throw new Error(`extraction returned no proposals for ${file}${d.error ? `: ${d.error}` : ''}`);
}

/** Everything that WOULD be written, in order. Pure. */
function planWrites(record, { communityId, communityName, mgmtId, existing = {}, items = [] }) {
  const open = (existing.bidRequests || []).find((b) => ['draft', 'collecting', 'evaluating'].includes(b.status) && b.service_category === record.project.service_category);
  const bid_request = open
    ? { op: 'update', table: 'bid_requests', id: open.id, patch: { status: record.workflow.status } }
    : { op: 'insert', table: 'bid_requests', row: { management_company_id: mgmtId, community_id: communityId, service_category: record.project.service_category, title: record.project.title, status: record.workflow.status } };
  const proposals = [];
  for (const n of record.proposals) {
    if (n.status === 'duplicate') continue;   // associated by the audit trail to its original, never inserted twice
    const item = items.find((i) => i.key === n.key) || {};
    const comparison = { status: n.status, normalized: n, classified_at: record.as_of, by: 'Amanda' };
    if (item.existing_proposal_id) {
      proposals.push({ op: 'update', table: 'vendor_proposals', id: item.existing_proposal_id, key: n.key, patch: { comparison }, set_bid_request: true });
    } else {
      proposals.push({ op: 'insert', table: 'vendor_proposals', key: n.key, document_sha: (n.source || {}).sha256 || item._new_document_sha || null, row: {
        management_company_id: mgmtId, community_id: communityId, community: communityName || null, service_category: record.project.service_category,
        document_type: 'project_bid', proposer_company_name: n.vendor_name, vendor_name_raw: n.vendor_name, vendor_id: (n.vendor_resolution || {}).vendor_id || null,
        proposal_date: n.document_date, proposal_number: n.quote_number, total_amount: n.upfront_cents == null ? null : n.upfront_cents / 100,
        term_months: n.contract_term_months, outcome: n.status === 'expired' ? 'expired' : 'pending', is_finalist: false,
        file_hash: (n.source || {}).sha256 || null, file_size_bytes: (n.source || {}).size_bytes || null,
        extracted_data: { ...require('./line_item_versions').addVersion({}, { items: [stripRuntime(item)], document_sha256: (n.source || {}).sha256 || item._new_document_sha || null, reason: 'initial extraction', requested_by: 'Amanda' }), comparison, source: n.source },
      } });
    }
  }
  const rec = record.proposals.find((n) => n.key === (record.recommendation || {}).key);
  const comparison = { op: 'insert', table: 'vendor_comparisons', row: {
    management_company_id: mgmtId, community: communityName || null, document_type: 'project_bid', service_category: record.project.service_category,
    recommendation_vendor_id: rec && rec.vendor_resolution ? rec.vendor_resolution.vendor_id : null,
    recommendation_summary: rec ? `${rec.vendor_name}: base installed cost ${C.money(rec.upfront_total_cents)} incl. estimated tax; ${record.horizon_months}-month cost of the recommended configuration ${C.money(rec.tco_cents)}${rec.addon_monthly_cents ? `; optional add-on ${C.money(rec.addon_monthly_cents)}/month (not recommended; with it the ${record.horizon_months}-month total would be ${C.money(rec.tco_with_addons_cents)})` : ''}` : 'No approvable proposal yet',
    reasoning: record.ranking.not_viable.map((x) => `${x.vendor_name}: ${x.reasons.join('; ')}`).join(' | '),
    analysis_data: record, schema_version: record.schema_version,
  } };
  const audit = record.audit.map((a) => ({ op: 'insert', table: 'rfp_decision_log', key: a.proposal_key || null, row: { action: a.action, reason: a.note, operator: a.actor } }));
  return { bid_request, proposals, comparison, audit };
}
const stripRuntime = (i) => { const { _new_document_sha, existing_proposal_id, quantities, line_items_stored, line_items_source, line_items_status, ...rest } = i || {}; return rest; };

/** Apply a plan. Only called in write mode. Every failure is reported, never swallowed. */
async function applyWrites(supabase, plan, { documents = [] } = {}) {
  const out = { bid_request_id: null, proposal_ids: {}, comparison_id: null, audit_written: 0, errors: [] };
  const br = plan.bid_request;
  if (br.op === 'insert') {
    const { data, error } = await supabase.from('bid_requests').insert(br.row).select('id').single();
    if (error) { out.errors.push(`bid_requests insert: ${error.message}`); return out; }
    out.bid_request_id = data.id;
  } else {
    const { error } = await supabase.from('bid_requests').update(br.patch).eq('id', br.id);
    if (error) out.errors.push(`bid_requests update: ${error.message}`);
    out.bid_request_id = br.id;
  }
  for (const p of plan.proposals) {
    if (p.op === 'update') {
      const { data: cur, error: ce } = await supabase.from('vendor_proposals').select('extracted_data, bid_request_id').eq('id', p.id).maybeSingle();
      if (ce) { out.errors.push(`vendor_proposals read ${p.id}: ${ce.message}`); continue; }
      const patch = { extracted_data: { ...((cur && cur.extracted_data) || {}), comparison: p.patch.comparison } };
      if (!cur || !cur.bid_request_id) patch.bid_request_id = out.bid_request_id;
      const { error } = await supabase.from('vendor_proposals').update(patch).eq('id', p.id);
      if (error) out.errors.push(`vendor_proposals update ${p.id}: ${error.message}`); else out.proposal_ids[p.key] = p.id;
      continue;
    }
    const row = { ...p.row, bid_request_id: out.bid_request_id };
    const doc = documents.find((d) => d.sha256 === p.document_sha && d.buffer);
    if (doc) {
      const path = `rfps/${out.bid_request_id}/${doc.sha256.slice(0, 12)}_${String(doc.filename).replace(/[^A-Za-z0-9._-]/g, '_')}`;
      const { error: ue } = await supabase.storage.from(BUCKET).upload(path, doc.buffer, { contentType: 'application/pdf', upsert: false });
      if (ue && !/already exists/i.test(ue.message || '')) out.errors.push(`storage ${doc.filename}: ${ue.message}`); else row.file_path = path;
    }
    const { data, error } = await supabase.from('vendor_proposals').insert(row).select('id').single();
    if (error) out.errors.push(`vendor_proposals insert ${p.key}: ${error.message}`); else out.proposal_ids[p.key] = data.id;
  }
  const { data: cmp, error: cmpErr } = await supabase.from('vendor_comparisons').insert({ ...plan.comparison.row, bid_request_id: out.bid_request_id, proposal_ids: Object.values(out.proposal_ids) }).select('id').single();
  if (cmpErr) out.errors.push(`vendor_comparisons insert: ${cmpErr.message}`); else out.comparison_id = cmp.id;
  for (const a of plan.audit) {
    const { error } = await supabase.from('rfp_decision_log').insert({ ...a.row, bid_request_id: out.bid_request_id, proposal_id: a.key ? (out.proposal_ids[a.key] || null) : null });
    if (error) { out.errors.push(`rfp_decision_log: ${error.message} (apply migration 531; the trail is also stored in vendor_comparisons.analysis_data.audit)`); break; }
    out.audit_written++;
  }
  if (out.errors.length) console.warn('[rfp_workflow] write issues:', JSON.stringify(out.errors));
  return out;
}

/** The block Amanda's drafting prompt receives. */
function promptBlock(record, summary, mode, link) {
  const rows = record.proposals.filter((n) => n.status !== 'duplicate').map((n) => `- ${n.vendor_name} (${n.document_date || 'undated'}): ${n.status} (${n.status_reason}); upfront ${C.money(n.upfront_total_cents)} incl. tax; counted monthly ${C.money(n.recurring_counted_monthly_cents)}; ${record.horizon_months}-month cost ${C.money(n.tco_cents)}${n.addon_monthly_cents ? `; optional add-on ${C.money(n.addon_monthly_cents)}/month (not recommended; with it the ${record.horizon_months}-month total would be ${C.money(n.tco_with_addons_cents)})` : ''}`).join('\n');
  return `COMPARISON (prepared on the RFP / Bid Workflow${mode === 'write' ? '' : ' as a dry run, not yet saved'}${link ? `: ${link}` : ''}). The detailed analysis lives on that record; your email is the short executive summary. Do not reproduce the table.\n${rows}\nOpen items queued with vendors (not sent yet): ${record.open_items.filter((i) => i.material).map((i) => `${i.vendor}: ${i.topic}`).join('; ') || 'none'}.\nDRAFT EXECUTIVE SUMMARY (use it as the body; adjust the greeting and wording only, keep every figure):\n${summary}`;
}

module.exports = { assertNoneDropped, workflowMode, inferProject, resolveVendorReadOnly, loadExisting, prepareComparison, planWrites, applyWrites, promptBlock };
