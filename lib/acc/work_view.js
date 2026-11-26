// ============================================================================
// lib/acc/work_view.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// WHERE EACH ARCHITECTURAL APPLICATION BELONGS, AND WHAT HAPPENS NEXT.
// Ed: "Annie's default queue should contain only genuinely current, actionable
// applications." Separate views:
//   current            Annie's working queue: intake, receipt, review, request
//                      for information, her decision within delegated authority
//   waiting_applicant  Annie asked the homeowner/builder for something; nothing
//                      new has arrived since
//   waiting_decision   the decision belongs to Ed, the Committee or the Board
//                      (or Ed's backlog hold)
//   historical         older unresolved applications past their review period,
//                      and applications in communities Bedrock no longer
//                      manages: Amanda's oversight, never Annie's daily queue,
//                      and nothing goes to the homeowner without Ed
//   completed          decided, archived (duplicate / superseded) or withdrawn
//
// Every open application carries its receipt date, deadline, the person
// responsible and the next action. Computed, never stored, so it cannot drift
// from the case. Annie owns review; Amanda owns oversight, deadlines and
// escalations; Ed decides his two exceptions and anything held.
//
// Why completed / duplicate / historical cases cluttered the queue (the
// recurrence this prevents): the queue had one "Submitted" bucket for every
// open row, so (1) duplicates re-filed by the July/October leak-check backfills
// beside a case staff had already decided, (2) cases on Ed's backlog hold, and
// (3) Eaglewood cases after Bedrock stopped managing it all sat next to new
// work forever. Now a possible duplicate is flagged with its decided twin, the
// held/expired backlog goes to the historical view, and ended communities never
// reach Annie.
//
//   workView(row, { authority, community, twins, now }) -> {
//     view, received_at, received_basis, deadline, deadline_basis, overdue,
//     responsible, next_action, flags[] }
// ============================================================================
const DA = require('./decision_authority');
const BH = require('./backlog_hold');
const RP = require('./review_periods');

const DAY = 86400000;
const OPEN = ['pending_review', 'awaiting_info', 'finalizing'];
const t = (x) => (x ? Date.parse(x) : NaN);
const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }) : null);

// Did Annie (or staff) already send the request for information for the review
// in effect? (Same rule as lib/acc/annie_issue alreadyRequested.)
function infoRequested(row) {
  if (row.decision_type !== 'request_more_info') return false;
  const reviewAt = DA.reviewAt(row);
  return !reviewAt || !(t(row.updated_at) < t(reviewAt));
}

// A DECIDED application at the same property within 45 days: this open one is
// probably a duplicate or a superseded first version. Flagged, never auto-archived
// (a genuine revision is a separate record).
function decidedTwin(row, twins = []) {
  const at = t(row.received_at || row.created_at);
  return (twins || []).filter((o) => o.id !== row.id && o.status === 'decided' && Math.abs(t(o.created_at) - at) <= 45 * DAY)
    .sort((a, b) => Math.abs(t(a.created_at) - at) - Math.abs(t(b.created_at) - at))[0] || null;
}

function workView(row = {}, { authority = null, community = null, twins = [], now = new Date() } = {}) {
  const status = row.status || 'pending_review';
  const received_at = row.received_at || row.created_at || null;
  const received_basis = row.received_at ? (row.received_at_basis || 'recorded') : 'opened';
  if (!OPEN.includes(status)) {
    return { view: 'completed', received_at, received_basis, deadline: null, deadline_basis: null, overdue: false, responsible: null, next_action: status === 'decided' ? 'Decision issued' : status === 'archived' ? (row.duplicate_of_id ? 'Archived as a duplicate' : 'Archived') : status.replace(/_/g, ' '), flags: [] };
  }
  const a = authority || DA.authorityFor(row);
  const period = RP.reviewPeriodFor(row.community_name, community);
  const deadline = received_at ? RP.deadlineFrom(received_at, period) : null;
  const overdue = !!(deadline && t(deadline) < now.getTime());
  const base = { received_at, received_basis, deadline, deadline_basis: period.label, overdue, flags: [] };
  const flags = base.flags;
  const twin = decidedTwin(row, twins);
  if (twin) flags.push(`possible duplicate of ${twin.reference_number || 'a decided application'} (decided ${fmt(twin.decided_at || twin.created_at)})`);

  // Bedrock no longer manages the community: records stay, no new work.
  if (community && require('../community/lifecycle').isEnded(community, now)) {
    return { ...base, view: 'historical', responsible: 'Amanda (oversight)', next_action: `${row.community_name || 'This community'} is no longer managed by Bedrock: no action or correspondence; hand over with the association records`, flags: [...flags, 'community no longer managed'] };
  }
  const held = BH.isBacklogHeld(row);
  if (held && overdue) {
    return { ...base, view: 'historical', responsible: 'Amanda (oversight); Ed decides',
      next_action: twin ? `Confirm it duplicates ${twin.reference_number || 'the decided application'} and archive it` : 'Annie prepares a recommended disposition, Amanda reviews, Ed decides. Nothing is sent to the homeowner without Ed.',
      flags: [...flags, 'historical: past its review period'] };
  }
  if (!row.acknowledged_at && !held) flags.push('receipt not yet sent to the homeowner');
  if (twin) return { ...base, view: 'current', responsible: 'Annie', next_action: `Confirm whether it duplicates ${twin.reference_number || 'the decided application'}: archive it, or review it as a new request` , flags };
  if (a.route === 'request_more_info' && (status === 'awaiting_info' || infoRequested(row))) return { ...base, view: 'waiting_applicant', responsible: 'Homeowner or builder', next_action: `Waiting for the requested information; Annie re-reviews as soon as it arrives${held ? ' (any decision stays on the backlog hold)' : ''}`, flags };
  if (held) return { ...base, view: 'waiting_decision', responsible: 'Ed (backlog hold)', next_action: `On Ed's backlog hold: Annie ${a.annie && a.annie.ok ? `would issue ${a.annie.outcome.replace(/_/g, ' ')}` : 'proceeds'} once Ed releases it`, flags };
  if (a.record_valid) return { ...base, view: 'current', responsible: 'Annie', next_action: 'Send the recorded decision letter', flags };
  if (a.route === 'owner_review_required') return { ...base, view: 'waiting_decision', responsible: 'Ed', next_action: a.owner_reviewed ? 'Ed reviewed it: record the decision' : `Ed decides: ${(a.owner_triggers || []).map((x) => x.replace(/_/g, ' ')).join(', ') || 'owner review'}`, flags };
  if (a.route === 'committee_or_board_required') return { ...base, view: 'waiting_decision', responsible: row.acc_delegation && row.acc_delegation.reserved_to === 'developer' ? 'Developer (Declarant)' : 'Committee or Board', next_action: 'Decision by the body the documents name; Amanda tracks the deadline', flags };
  if (a.route === 'request_more_info') {
    if (status === 'awaiting_info' || infoRequested(row)) return { ...base, view: 'waiting_applicant', responsible: 'Homeowner or builder', next_action: 'Waiting for the requested information; Annie re-reviews as soon as it arrives', flags };
    return { ...base, view: 'current', responsible: 'Annie', next_action: row.submitter_email ? 'Annie sends the request for the missing information' : 'No applicant email on file: contact the homeowner for the missing information', flags };
  }
  if (a.route === 'no_approval_required') return { ...base, view: 'current', responsible: 'Annie', next_action: 'No approval required: Annie tells the homeowner and closes it', flags };
  if (a.annie && a.annie.ok) return { ...base, view: 'current', responsible: 'Annie', next_action: `Annie issues her decision (${a.annie.outcome.replace(/_/g, ' ')})`, flags };
  if (a.route === 'annie_decides' || !DA.reviewAt(row)) return { ...base, view: 'current', responsible: 'Annie', next_action: DA.reviewAt(row) ? 'Annie completes her review' : 'Annie reviews the application', flags };
  return { ...base, view: 'waiting_decision', responsible: 'Committee or Board', next_action: a.route_detail || 'Decision by the Committee or Board', flags };
}

module.exports = { workView, decidedTwin, infoRequested, OPEN };
