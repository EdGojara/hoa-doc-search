// ============================================================================
// lib/acc/owner_preflight.js  (Ed 2026-11-26, Owner Authorization Service, ARC/ACC)
// ----------------------------------------------------------------------------
// The checks the ACC finalize path (server.js _accFinalizeHandler) runs before
// it issues a decision or a request for information, WITHOUT writing anything:
// the case is open, the letter has no placeholder or internal-only phrase, and
// the decision is authorized (a recorded decision, Annie's routine decision under
// the written delegation, or the owner's / committee's decision as given). Run
// before a decision is offered to the owner in an authorization package, so the
// package never lists something the finalize path would refuse. The finalize
// path itself runs every check again when the item executes.
// ============================================================================

const DA = require('./decision_authority');
const { OPEN_STATUSES, PLACEHOLDER_RE } = require('./finalize');
const { screenForLeaks } = require('../voice/leak_filter');

async function delegationFor(supabase, communityId) {
  if (!communityId) return null;
  const { data, error } = await supabase.from('communities').select('id, acc_delegation').eq('id', communityId).maybeSingle();
  if (error) { if (!/acc_delegation|does not exist/i.test(error.message || '')) throw new Error(`delegation lookup: ${error.message}`); return null; }
  return data && data.acc_delegation && typeof data.acc_delegation === 'object' ? data.acc_delegation : null;
}

// Same rule as server.js _accResolveAuthorityDocument: a cited instrument must be on file for the community.
async function authorityDocumentError(supabase, dec, rec) {
  const ab = rec.authority_basis || {};
  if (!ab.library_document_id) return null;
  const { data: doc, error } = await supabase.from('library_documents').select('id, title, community_id').eq('id', ab.library_document_id).maybeSingle();
  if (error) return `the cited instrument could not be checked (${error.message})`;
  if (!doc || doc.community_id !== dec.community_id) return 'the cited instrument is not on file for this community';
  ab.library_document_title = doc.title;
  return null;
}

/** { ok, error?, final, decided_by?, route? } for issuing `body` on case `id` as `actor`. */
async function preflight(supabase, { id, body = {}, actor, managementCompanyId = null }) {
  let q = supabase.from('acc_decisions').select('*').eq('id', id);
  if (managementCompanyId) q = q.eq('management_company_id', managementCompanyId);
  const { data: dec, error } = await q.maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!dec) return { ok: false, error: 'case not found' };
  if (!OPEN_STATUSES.includes(dec.status)) return { ok: false, error: `the case is ${dec.status}` };
  const decisionType = String(body.decision_type || '').trim();
  const text = String(body.body_text || '');
  if (!text.trim()) return { ok: false, error: 'the letter is empty' };
  if (PLACEHOLDER_RE.test(text)) return { ok: false, error: 'the letter still has a [STAFF: ...] placeholder' };
  const screen = screenForLeaks(text, { audience: 'customer', autoRewrite: true, formalLetter: true });
  if (screen.blocks.length) return { ok: false, error: 'the letter contains internal-only phrases: ' + screen.blocks.map((b) => b.matches.join(', ')).join('; ') };
  if (decisionType === 'request_more_info') return { ok: true, final: false };
  const delegation = await delegationFor(supabase, dec.community_id);
  let decRow = dec;
  if (body.decision_record) {
    const built = DA.recordDecision(actor, { ...body.decision_record, outcome: body.decision_record.outcome || decisionType }, dec);
    if (built.error) return { ok: false, error: built.error };
    const docErr = await authorityDocumentError(supabase, dec, built.rec);
    if (docErr) return { ok: false, error: docErr };
    decRow = { ...dec, decision_record: built.rec };
  } else if (!DA.authorityFor(dec).record_valid) {
    const annie = DA.annieDecisionFor(dec, delegation);
    if (annie.rec && annie.rec.outcome === decisionType) decRow = { ...dec, decision_record: annie.rec };
    else if (annie.rec) return { ok: false, error: `Annie's decision is ${annie.rec.outcome.replace(/_/g, ' ')}, not ${decisionType.replace(/_/g, ' ')}` };
  }
  const authz = DA.checkFinalDecision({ ...decRow, acc_delegation: delegation }, { decisionType, texts: [text], actor, requireIssuer: true });
  if (!authz.ok) return { ok: false, error: authz.error };
  return { ok: true, final: true, decided_by: decRow.decision_record ? decRow.decision_record.decided_by : null, route: authz.auth && authz.auth.route };
}

module.exports = { preflight, delegationFor, authorityDocumentError };
