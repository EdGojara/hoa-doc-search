// lib/enforcement/stage_audit.js  (Ed 2026-10-23)
// ----------------------------------------------------------------------------
// A manual stage change is an enforcement decision: it needs a reason and a
// record of who made it, when, and from what stage to what stage. Used by
// advance-stage (Reduce records the same facts through reduce_plan.js).
// ----------------------------------------------------------------------------
const LABEL = {
  courtesy_1: 'Courtesy 1', courtesy_2: 'Courtesy 2', certified_209: 'Certified §209',
  fine_assessed: 'Fine assessed', hearing_notice: 'Hearing notice', legal_referral: 'Legal referral',
  lien_filed: 'Lien filed', other: 'Other',
};
const label = (s) => LABEL[s] || s;

// Returns null when the reason is acceptable, or an error body for a 400.
function reasonError(reason) {
  if (!String(reason || '').trim()) {
    return { error: 'reason_required', detail: 'Say why the stage is being advanced; it goes on the audit trail.' };
  }
  return null;
}

// The audit record for one manual stage change.
function stageChangeAudit({ action, actor, previousStage, newStage, reason, at }) {
  const who = (actor && (actor.full_name || actor.email)) || 'Staff';
  const when = at || new Date().toISOString();
  return {
    subject: `Stage ${action}: ${previousStage} → ${newStage}`,
    content: `${who} ${action} this case from ${label(previousStage)} to ${label(newStage)} on ${when}. Reason: ${String(reason).trim()}`,
    sent_by_user_id: (actor && actor.id) || null,
    sent_at: when,
  };
}

module.exports = { reasonError, stageChangeAudit };
