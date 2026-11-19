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

// Fire-and-forget form for write paths: never throws, never blocks the caller.
function issueIfReadySoon(supabase, id, opts) {
  setImmediate(() => { issueIfReady(supabase, id, opts).catch(() => {}); });
}

module.exports = { registerIssuer, issueIfReady, issueIfReadySoon, letterFor };
