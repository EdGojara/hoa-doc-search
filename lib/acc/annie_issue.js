// ============================================================================
// lib/acc/annie_issue.js  (Ed 2026-11-18)
// ----------------------------------------------------------------------------
// ANNIE ISSUES HER OWN ROUTINE DECISIONS. Ed: "Do not introduce unnecessary
// staff approval or sending steps." When Annie's review of a case settles on a
// decision she may make (lib/acc/decision_authority: a routine application in a
// community with a written ACC delegation on file), Annie sends the decision
// letter herself through the SAME finalize path staff use (seal the record,
// email from Annie's mailbox, append the finalization record, close the case).
// Every guard on that path still applies: authority gate, stale-letter check,
// [STAFF: ...] placeholders, IP-leak screen, the transport guard (applicant
// only), the atomic claim (never sent twice), and the denial appeal notice.
//
// Event-driven, never polled: called right after a review is written (intake,
// re-review, a new document), and once by the owner for cases already waiting.
// Anything Annie may not issue (Ed's two exceptions, a committee/Board matter,
// an incomplete case, no applicant email, a letter that fails a guard) stays in
// the queue for a person, with the reason logged.
//
//   registerIssuer(fn)                  server.js registers the finalize core:
//                                       fn(id, body) -> { status, json }
//   issueIfReady(supabase, id, {dryRun, source}) -> { issued | skipped, ... }
// ============================================================================
const DA = require('./decision_authority');

let issuer = null;
function registerIssuer(fn) { issuer = typeof fn === 'function' ? fn : null; }

const t = (x) => (x ? Date.parse(x) : NaN);

// Which letter Annie sends, and the review it was drafted from. A staff-edited
// working draft for the same decision, drafted from the current review, is
// kept (staff may fix wording; they never change the decision). Otherwise
// Annie's own draft from her latest review.
function letterFor(row, outcome) {
  const reviewAt = DA.reviewAt(row);
  const draftCurrent = row.letter_body && row.letter_draft_review_at && reviewAt && t(row.letter_draft_review_at) + 1000 >= t(reviewAt)
    && (!row.decision_type || row.decision_type === outcome);
  if (draftCurrent) return { body_text: row.letter_body, basis: row.letter_draft_review_at, source: 'working_draft' };
  if (row.current_review_at && row.current_letter_body) return { body_text: row.current_letter_body, basis: row.current_review_at, source: 'current_review' };
  if (!row.current_review_at && row.ai_letter_body) return { body_text: row.ai_letter_body, basis: row.created_at || null, source: 'intake_review' };
  return null;
}

async function delegationFor(supabase, communityId) {
  if (!communityId) return null;
  const { data, error } = await supabase.from('communities').select('acc_delegation').eq('id', communityId).maybeSingle();
  if (error) { if (!/acc_delegation|does not exist/i.test(error.message || '')) console.warn('[annie-issue] delegation lookup failed:', error.message); return null; }
  return data && data.acc_delegation && typeof data.acc_delegation === 'object' ? data.acc_delegation : null;
}

async function issueIfReady(supabase, id, { dryRun = false, source = 'event' } = {}) {
  try {
    if (!DA.aiDecisionsEnabled()) return { id, skipped: 'agent decisions are turned off (ACC_AI_DECISIONS_ENABLED=false)' };
    const { data: row, error } = await supabase.from('acc_decisions').select('*').eq('id', id).maybeSingle();
    if (error) return { id, skipped: `could not load the case (${error.message})` };
    if (!row) return { id, skipped: 'case not found' };
    if (!['pending_review', 'awaiting_info'].includes(row.status)) return { id, skipped: `case is ${row.status}` };
    // Existing backlog: held until Ed reviews its history (lib/acc/backlog_hold).
    if (require('./backlog_hold').isBacklogHeld(row)) return { id, reference: row.reference_number || null, skipped: 'backlog hold: Ed reviews this case\'s history before any decision letter is sent' };
    const a = DA.authorityFor({ ...row, acc_delegation: await delegationFor(supabase, row.community_id) });
    if (a.record_valid) return { id, skipped: 'a decision is already recorded on the case; a person issues it' };
    if (a.route === 'request_more_info') return await requestInfoIfReady(row, a, { dryRun, source, supabase });
    if (a.route !== 'annie_decides') return { id, skipped: `${a.route.replace(/_/g, ' ')}: ${a.route_detail}` };
    if (!a.annie || !a.annie.ok) return { id, skipped: (a.annie && a.annie.error) || 'Annie has not decided this case' };
    const to = String(row.submitter_email || '').trim();
    if (!to) return { id, skipped: 'no applicant email on the case; a person must mail the letter' };
    const letter = letterFor(row, a.annie.outcome);
    if (!letter) return { id, skipped: 'no letter drafted from Annie\'s review' };
    const plan = { id, reference: row.reference_number || null, community: row.community_name || null, decision_type: a.annie.outcome, to, letter_source: letter.source, authority: a.annie.authority };
    if (dryRun) return { ...plan, would_issue: true };
    if (!issuer) return { ...plan, skipped: 'the issuer is not registered (server not started)' };
    const r = await issuer(id, { decision_type: a.annie.outcome, body_text: letter.body_text, to_email: to, send: true, draft_basis_review_at: letter.basis });
    if (r && r.status === 200 && r.json && r.json.final) {
      console.log(`[annie-issue] ${source}: Annie issued ${a.annie.outcome} for ${row.reference_number || id} to the applicant`);
      return { ...plan, issued: true, email_sent: !!(r.json.email && r.json.email.sent), finalization_id: r.json.finalization_id || null };
    }
    const why = (r && r.json && (r.json.error || r.json.code)) || `status ${r && r.status}`;
    console.error(`[annie-issue] ${source}: Annie could NOT issue ${row.reference_number || id} (left in the queue): ${why}`);
    return { ...plan, skipped: why };
  } catch (e) {
    console.error(`[annie-issue] ${source}: ${id} failed (left in the queue): ${e.message}`);
    return { id, skipped: e.message };
  }
}

// ANNIE REQUESTS THE MISSING INFORMATION HERSELF (Ed 2026-11-26). An incomplete
// application used to wait for staff to send Annie's drafted request ("staff can
// send"), so a homeowner who sent an incomplete application heard nothing. A
// request for information decides nothing; it goes through the same finalize
// path (request_more_info keeps the case open; the transport guard still refuses
// any letter that reads as an approval or denial). Only on a CURRENT case: the
// historical backlog is held above, and nothing old is sent without Ed.
//   * the review in effect must itself recommend requesting information (a case
//     routed here for a reason the letter does not cover stays with a person);
//   * once per review: a request already recorded on the case after that
//     review, by Annie or by staff, is never sent again.
function infoRequestsEnabled() {
  return !/^(0|false|off|no|disabled)$/i.test(String(process.env.ACC_AI_INFO_REQUESTS || '').trim());
}
function alreadyRequested(row) {
  if (row.decision_type !== 'request_more_info') return false;
  const reviewAt = DA.reviewAt(row);
  return !reviewAt || !(t(row.updated_at) < t(reviewAt));
}
async function requestInfoIfReady(row, a, { dryRun = false, source = 'event', supabase = null } = {}) {
  const id = row.id;
  if (!infoRequestsEnabled()) return { id, skipped: 'automatic information requests are turned off (ACC_AI_INFO_REQUESTS=off)' };
  const rec = row.current_review_at ? row.current_ai_recommendation : row.ai_recommendation;
  if (rec !== 'request_more_info') return { id, skipped: `request more info: ${a.route_detail}; the review recommends ${String(rec || 'nothing').replace(/_/g, ' ')}, so a person words the request` };
  if (alreadyRequested(row)) return { id, skipped: 'the information request for this review was already sent' };
  const applicant = String(row.submitter_email || '').trim();
  if (!applicant) return { id, skipped: 'no applicant email on the case; a person must contact the homeowner' };
  // First contact (no receipt yet): this message is also the receipt, so it goes
  // to everyone the receipt would have reached (the applicant and a forwarding
  // property manager), never staff (Ed 2026-11-26).
  const to = row.acknowledged_at ? applicant : (require('./acknowledge').receiptRecipients(row).join(', ') || applicant);
  const letter = letterFor(row, 'request_more_info');
  if (!letter) return { id, skipped: 'no request drafted from the review' };
  const plan = { id, reference: row.reference_number || null, community: row.community_name || null, decision_type: 'request_more_info', to, letter_source: letter.source };
  // The letter also approves or denies part of the application (several
  // improvements, different outcomes): handle each improvement on its own and
  // send ONE coordinated email, instead of stalling the whole application
  // (Ed 2026-11-26, lib/acc/multi_item; scar WAT-ARC-2026-0054).
  const MI = require('./multi_item');
  if (MI.mixesOutcomes(letter.body_text)) {
    if (dryRun) return { ...plan, would_split_improvements: true };
    if (!issuer) return { ...plan, skipped: 'the issuer is not registered (server not started)' };
    try {
      const r = await MI.respondMultiItem(supabase, id, { issuer });
      if (r.email_sent) { console.log(`[annie-issue] ${source}: ${row.reference_number || id} answered per improvement in one email`); return { ...plan, requested_info: true, split: r.children, email_sent: true }; }
      return { ...plan, skipped: `several improvements: ${r.detail || r.status}` };
    } catch (e) { return { ...plan, skipped: `several improvements: ${e.message}` }; }
  }
  if (dryRun) return { ...plan, would_request_info: true };
  if (!issuer) return { ...plan, skipped: 'the issuer is not registered (server not started)' };
  const r = await issuer(id, { decision_type: 'request_more_info', body_text: letter.body_text, to_email: to, send: true });
  if (r && r.status === 200 && r.json && r.json.email && r.json.email.sent) {
    console.log(`[annie-issue] ${source}: Annie requested more information on ${row.reference_number || id}`);
    return { ...plan, requested_info: true, email_sent: true };
  }
  const why = (r && r.json && (r.json.error || r.json.code)) || `status ${r && r.status}`;
  console.error(`[annie-issue] ${source}: Annie could NOT send the information request for ${row.reference_number || id} (left in the queue): ${why}`);
  return { ...plan, skipped: why };
}

// Fire-and-forget form for write paths: never throws, never blocks the caller.
function issueIfReadySoon(supabase, id, opts) {
  setImmediate(() => { issueIfReady(supabase, id, opts).catch(() => {}); });
}

module.exports = { registerIssuer, issueIfReady, issueIfReadySoon, letterFor, alreadyRequested };
