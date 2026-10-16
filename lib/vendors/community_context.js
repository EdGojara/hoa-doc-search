// ============================================================================
// lib/vendors/community_context.js  (Ed 2026-10-16: "trustEd context must
// materially improve Amanda's analysis")
// ----------------------------------------------------------------------------
// Amanda's value is documents + community context + financial context +
// historical context + policy/contract context + execution. A comparison that
// anyone could reproduce by uploading the same PDFs to a generic AI is not good
// enough. Before she recommends on a material vendor or project decision she
// reads what trustEd already knows about THIS community and THIS topic:
//
//   prior Board decisions        board_motions
//   contracts                    vendor_contracts (current and past)
//   Vendor 360                   vendors (W-9 / status) for the proposing vendors
//   prior spend                  ap_invoices (24 months) for topic vendors
//   projects / incidents         vendor_projects + vendor_project_events
//   reserve information          reserve_components
//   Board requirements/preferences  email_messages on the topic (never the message
//                                being answered: a record never cites itself)
//   governing documents          optional retriever (getRelevantChunks) when passed
//
// Read-only. Only findings that bear on the decision survive: each must match the
// topic or a proposing vendor, and each carries a source tag
// ("trustEd:<table>") so the analysis and the Board summary can say which
// conclusions rest on community records rather than the uploaded proposal.
// Absence is reported only where it changes the decision (no existing contract
// to overlap; no reserve component for the asset).
// ============================================================================

const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Topic vocabularies. A finding must hit one of these words (or a proposing vendor).
const TOPICS = {
  security: /\b(camera|cameras|surveillance|video|cctv|lpr|license plate|recording|security|guard|patrol|access control|access|gate|alarm|monitoring)\b/i,
  pool_management: /\b(pool|aquatic|swim)\b/i,
  landscape_maintenance: /\b(landscap|mow|irrigation|tree)\w*/i,
  painting: /\bpaint\w*/i,
  repair: /\b(repair|fence|gate)\b/i,
};
const SECURITY_VENDOR = /\b(security|protect\w*|gate|access|alarm|alert|camera|monitor\w*|surveil\w*|guard)\b/i;
const firstWord = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find((w) => w.length >= 4) || '';

function topicMatcher(category, extraWords = []) {
  const base = TOPICS[category] || null;
  const extra = extraWords.filter(Boolean).map((w) => new RegExp(`\\b${String(w).replace(/[^a-z0-9]/gi, '')}`, 'i'));
  return (text) => !!text && ((base && base.test(text)) || extra.some((re) => re.test(text)));
}

/**
 * Gather community context for a topic. Pure over the rows the client returns
 * (relevance filtering is done here, so it is testable with a seeded fake).
 *   proposalVendors   vendor names on the proposals
 *   excludeMessageIds / currentMessage {subject, received_at}: the message being answered
 *   retrieveDocs      optional async (query) => [{title, text}] (getRelevantChunks)
 */
async function gatherCommunityContext(supabase, { communityId, communityName, category, topicWords = [], proposalVendors = [], excludeMessageIds = [], currentMessage = null, today, retrieveDocs = null } = {}) {
  const asOf = today || new Date().toISOString().slice(0, 10);
  const since = `${Number(asOf.slice(0, 4)) - 2}${asOf.slice(4)}`;
  // The proposing vendors' names count as topic words: a Board thread titled "iTech Proposal" is on topic.
  const isTopic = topicMatcher(category, [...topicWords, ...proposalVendors.map(firstWord)]);
  const vendorWords = proposalVendors.map(firstWord).filter(Boolean);
  const isProposalVendor = (name) => vendorWords.includes(firstWord(name));
  const findings = []; const errors = [];
  const add = (source, kind, text, data = {}, lens = 'operational') => findings.push({ source: `trustEd:${source}`, kind, text, lens, data });
  const read = async (label, q) => { try { const { data, error } = await q; if (error) throw error; return data || []; } catch (e) { errors.push(`${label}: ${e.message}`); return null; } };

  const [motions, contracts, invoices, projects, reserve, emails, vendors] = await Promise.all([
    read('board_motions', supabase.from('board_motions').select('id, title, status, closed_at, outcome_note, created_at').eq('community_id', communityId).order('created_at', { ascending: false }).limit(200)),
    read('vendor_contracts', supabase.from('vendor_contracts').select('id, vendor_id, vendor_name_raw, service_category, service_description, annualized_amount, effective_date, end_date, status, coi_on_file, w9_on_file, notes').eq('community_id', communityId).order('effective_date', { ascending: false }).limit(200)),
    read('ap_invoices', supabase.from('ap_invoices').select('vendor_id, total_cents, invoice_date, status, notes, vendors(name)').eq('community_id', communityId).gte('invoice_date', since).order('invoice_date', { ascending: false }).limit(1000)),
    read('vendor_projects', supabase.from('vendor_projects').select('id, title, category, stage, stage_since, vendor_name, description, status_note, estimated_cost_cents').eq('community_id', communityId).order('stage_since', { ascending: false }).limit(200)),
    read('reserve_components', supabase.from('reserve_components').select('id, component_name, category, description, remaining_useful_life_years, useful_life_years').eq('community_id', communityId).limit(500)),
    read('email_messages', supabase.from('email_messages').select('id, graph_id, internet_message_id, conversation_id, subject, body_preview, sender_email, sender_name, received_at, direction').eq('community_id', communityId).order('received_at', { ascending: false }).limit(300)),
    proposalVendors.length ? read('vendors', supabase.from('vendors').select('id, name, dba, w9_on_file, status, is_active').neq('is_active', false).limit(2000)) : Promise.resolve([]),
  ]);

  // Prior Board decisions on the topic.
  for (const m of (motions || []).filter((x) => isTopic(`${x.title} ${x.outcome_note || ''}`)).slice(0, 5)) {
    add('board_motions', 'board_decision', `Board motion "${m.title}" ${m.status}${m.closed_at ? ` ${String(m.closed_at).slice(0, 10)}` : ''}${m.outcome_note ? ` (${String(m.outcome_note).slice(0, 100)})` : ''}.`, { id: m.id }, 'operational');
  }

  // Contracts on the topic: overlap, budget-line commitments, and the absence of one for the asset.
  const topicContracts = (contracts || []).filter((k) => isTopic(`${k.service_category || ''} ${k.service_description || ''} ${k.vendor_name_raw || ''}`) || isProposalVendor(k.vendor_name_raw));
  for (const k of topicContracts.filter((x) => ['active', 'expiring'].includes(x.status)).slice(0, 6)) {
    add('vendor_contracts', 'contract', `Active ${k.service_category || 'service'} contract: ${k.vendor_name_raw || 'vendor'}${k.annualized_amount ? `, ${money(Math.round(Number(k.annualized_amount) * 100))}/yr` : ''}${k.end_date ? ` through ${k.end_date}` : ''}${k.service_description ? ` (${String(k.service_description).slice(0, 80)})` : ''}.`, { id: k.id, annual_cents: k.annualized_amount ? Math.round(Number(k.annualized_amount) * 100) : null, vendor: k.vendor_name_raw, category: k.service_category }, 'financial');
  }
  if (contracts && category === 'security') {
    const camera = (contracts || []).some((k) => /\b(camera|surveillance|video|cctv)\b/i.test(`${k.service_description || ''} ${k.vendor_name_raw || ''}`) && ['active', 'expiring'].includes(k.status));
    if (!camera) add('vendor_contracts', 'no_overlap', 'No active camera or video-surveillance contract is on file, so a new system does not overlap or require terminating an existing agreement.', {}, 'contract');
  }

  // Prior spend with topic vendors (the community's own bills only).
  if (invoices) {
    const byV = {};
    for (const i of invoices) {
      const n = i.vendors && i.vendors.name; if (!n || i.status === 'voided') continue;
      if (!(isProposalVendor(n) || (category === 'security' ? SECURITY_VENDOR.test(n) : isTopic(n)))) continue;
      const v = (byV[n] = byV[n] || { total: 0, n: 0, last: '' }); v.total += Number(i.total_cents || 0); v.n += 1; if ((i.invoice_date || '') > v.last) v.last = i.invoice_date;
    }
    const rows = Object.entries(byV).sort((a, b) => b[1].total - a[1].total).slice(0, 6);
    if (rows.length) add('ap_invoices', 'prior_spend', `Related spend in the last 24 months: ${rows.map(([n, v]) => `${n} ${money(v.total)} (${v.n} bill${v.n === 1 ? '' : 's'}, last ${v.last})`).join('; ')}.`, { vendors: rows.map(([n, v]) => ({ name: n, total_cents: v.total, bills: v.n, last: v.last })) }, 'financial');
    for (const pv of proposalVendors) {
      if (!Object.keys(byV).some((n) => isProposalVendor(n) && firstWord(n) === firstWord(pv))) continue;
      add('ap_invoices', 'vendor_history', `${pv} has billed this community before.`, {}, 'operational');
    }
  }

  // Open or recent projects on the topic.
  for (const p of (projects || []).filter((x) => isTopic(`${x.title} ${x.category} ${x.description || ''}`) && !['cancelled'].includes(x.stage)).slice(0, 4)) {
    add('vendor_projects', 'project', `Project "${p.title}" is ${String(p.stage).replace(/_/g, ' ')} since ${String(p.stage_since || '').slice(0, 10)}${p.vendor_name ? ` (${p.vendor_name})` : ''}.`, { id: p.id }, 'operational');
  }

  // Reserve components for the asset; absence matters for the funding decision.
  if (reserve) {
    const comp = reserve.filter((c) => isTopic(`${c.component_name} ${c.category || ''} ${c.description || ''}`) && /\b(camera|surveillance|video|cctv|security system|access control)\b/i.test(`${c.component_name} ${c.category || ''}`));
    if (comp.length) for (const c of comp.slice(0, 4)) add('reserve_components', 'reserve_component', `Reserve study component "${c.component_name}"${c.remaining_useful_life_years != null ? `, remaining useful life ${c.remaining_useful_life_years} yr` : ''}.`, { id: c.id, camera: /camera|surveillance|video|cctv/i.test(c.component_name) }, 'financial');
    if (category === 'security' && !comp.some((c) => /camera|surveillance|video|cctv/i.test(`${c.component_name} ${c.category || ''}`))) {
      add('reserve_components', 'no_reserve_component', 'The reserve study on file has no camera or video-surveillance component, so paying for the system from Reserve is a Board funding decision, not a scheduled reserve expenditure.', {}, 'financial');
    }
  }

  // Board requirements and preferences expressed in earlier correspondence on the topic.
  // Never the message being answered (or a stored copy of it): a record never cites itself.
  const excluded = new Set(excludeMessageIds.filter(Boolean));
  const cur = currentMessage || {};
  // The message being answered, by any identifier, and any later copy in its thread (a reply quoting it,
  // a forward with the same subject): a record never cites itself.
  const ids = new Set([cur.id, cur.graph_id, cur.internet_message_id].filter(Boolean));
  const normSubj = (x) => String(x || '').toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
  const curDay = String(cur.received_at || '').slice(0, 10);
  const isCurrent = (e) => excluded.has(e.id) || ids.has(e.id) || ids.has(e.graph_id) || ids.has(e.internet_message_id)
    || (cur.conversation_id && e.conversation_id === cur.conversation_id && (!cur.received_at || String(e.received_at || '') >= String(cur.received_at)))
    || (cur.subject && normSubj(e.subject) === normSubj(cur.subject) && (!curDay || String(e.received_at || '').slice(0, 10) >= curDay));
  const aboutAsset = (t) => /\b(camera|cameras|surveillance|video|cctv|lpr|license plate|recording)\b/i.test(t) || vendorWords.some((w) => new RegExp(`\\b${w}`, 'i').test(t));
  const topicMail = (emails || []).filter((e) => !isCurrent(e) && aboutAsset(`${e.subject || ''} ${e.body_preview || ''}`));
  for (const e of topicMail.slice(0, 4)) {
    add('email_messages', 'prior_communication', `${String(e.received_at || '').slice(0, 10)} ${e.direction === 'outbound' ? 'Bedrock to the Board' : `from ${e.sender_name || e.sender_email}`}: "${String(e.subject || '').slice(0, 60)}": ${String(e.body_preview || '').replace(/\s+/g, ' ').slice(0, 180)}`, { id: e.id }, 'operational');
  }

  // Vendor 360 for the proposing vendors: in the directory? W-9 recorded?
  for (const pv of proposalVendors) {
    const hits = (vendors || []).filter((v) => firstWord(v.name) === firstWord(pv) || (v.dba && firstWord(v.dba) === firstWord(pv)));
    if (!hits.length) add('vendors', 'vendor_360', `${pv} is not in Vendor 360 yet; a vendor record (W-9, certificate of insurance) is needed before any payment.`, { vendor_key: firstWord(pv), w9_on_file: null, missing: true }, 'contract');
    else if (hits.length === 1) add('vendors', 'vendor_360', `${hits[0].name} is in Vendor 360; W-9 ${hits[0].w9_on_file === true ? 'on file' : hits[0].w9_on_file === false ? 'not on file' : 'status not recorded'}.`, { id: hits[0].id, vendor_key: firstWord(pv), w9_on_file: hits[0].w9_on_file === undefined ? null : hits[0].w9_on_file }, 'contract');
  }

  // Governing documents / policy, when a retriever is supplied (getRelevantChunks hybrid retrieval).
  if (typeof retrieveDocs === 'function') {
    try {
      const chunks = await retrieveDocs(`${communityName || ''} ${category} cameras security spending authority reserve contract approval`);
      for (const c of (chunks || []).filter((x) => isTopic(`${x.title || ''} ${x.text || ''}`) || /spending|authority|approv|contract/i.test(x.text || '')).slice(0, 2)) add('documents', 'policy', `${c.title || 'Governing document'}: ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 200)}`, {}, 'contract');
    } catch (e) { errors.push(`documents: ${e.message}`); }
  }

  return { findings, errors, as_of: asOf };
}

module.exports = { gatherCommunityContext, topicMatcher, TOPICS, firstWord };
