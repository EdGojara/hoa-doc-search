// ============================================================================
// lib/applications/committee.js — ACC committee vote tallying + quorum logic
// ----------------------------------------------------------------------------
// Ed 2026-06-09 — When a community uses acc_majority or acc_unanimous workflow,
// the send-decision step routes through here instead of going direct to email.
//
// Quorum rules (per migration 210):
//   - acc_majority:  ceil(active_members / 2) approvals needed; ANY deny pauses
//   - acc_unanimous: ALL active members must approve; any deny pauses
//
// Vote shapes (application_committee_votes table):
//   approve | deny | request_more_info | abstain
//
// "Pause" = forwarded back to Bedrock staff for a follow-up decision (re-route
// to second committee round, accept the denial, etc.). Encoded by setting the
// application back to pending_committee_review and logging.
// ============================================================================

async function getActiveCommitteeMembers(supabase, communityId) {
  const { data } = await supabase
    .from('community_arc_committee')
    .select('id, contact_id, is_chair')
    .eq('community_id', communityId)
    .eq('is_active', true)
    .is('removed_at', null);
  return data || [];
}

async function tallyVotes(supabase, applicationId) {
  const { data } = await supabase
    .from('application_committee_votes')
    .select('committee_member_contact_id, vote, voted_at')
    .eq('application_id', applicationId);
  const rows = data || [];
  const counts = { approve: 0, deny: 0, request_more_info: 0, abstain: 0, total: rows.length };
  const voters = new Set();
  for (const r of rows) {
    counts[r.vote] = (counts[r.vote] || 0) + 1;
    voters.add(r.committee_member_contact_id);
  }
  return { counts, voters, rows };
}

/**
 * Evaluate whether quorum is met for the configured workflow.
 *
 * @param {object} args
 * @param {'acc_majority'|'acc_unanimous'} args.workflow
 * @param {number} args.minApprovals  - community override (0 = use default rule for workflow)
 * @param {number} args.activeMemberCount
 * @param {{approve:number, deny:number, request_more_info:number, abstain:number}} args.counts
 * @returns {{ outcome: 'pending'|'approved'|'denied'|'needs_more_info', reason: string, threshold: number }}
 */
function evaluateQuorum({ workflow, minApprovals, activeMemberCount, counts }) {
  // Any deny vote (in either workflow) pauses the auto-send. Bedrock staff
  // decides what to do next (re-route, accept denial, etc.)
  if (counts.deny > 0) {
    return {
      outcome: 'denied',
      reason: `committee member(s) voted to deny`,
      threshold: 0,
    };
  }
  if (counts.request_more_info > 0) {
    return {
      outcome: 'needs_more_info',
      reason: `committee member(s) requested more info`,
      threshold: 0,
    };
  }

  let needed;
  if (minApprovals && minApprovals > 0) {
    needed = minApprovals;
  } else if (workflow === 'acc_unanimous') {
    needed = activeMemberCount;
  } else {
    // acc_majority default — ceil(N/2)
    needed = Math.ceil(activeMemberCount / 2);
  }

  if (counts.approve >= needed) {
    return {
      outcome: 'approved',
      reason: `${counts.approve} of ${activeMemberCount} approved (needed ${needed})`,
      threshold: needed,
    };
  }
  return {
    outcome: 'pending',
    reason: `${counts.approve} of ${needed} approvals so far`,
    threshold: needed,
  };
}

module.exports = {
  getActiveCommitteeMembers,
  tallyVotes,
  evaluateQuorum,
};
