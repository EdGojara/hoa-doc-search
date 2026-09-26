// academy/team/governance.js  (DESIGN, sandbox; not loaded by production)
// ----------------------------------------------------------------------------
// Community governance bodies (Ed 2026-09-26): never assume a generic
// "compliance committee". A body exists for an agent only if it is established
// FOR THAT COMMUNITY, backed by a source, and active on the date in question.
//
// Record: { name, type, scope, source, active_from, active_to }
//   type   acc | arc | board_committee | nominating | other
//   scope  what it may decide (from the source), e.g. "approve or deny exterior
//          modifications under ACC Guidelines"
//   source the governing document or board resolution that establishes it
//
// Production home (proposed, not applied): table community_governance_bodies
// (community_id FK, same columns), see academy/docs/SCHEMA_PLAN.md. In the
// sandbox, bodies come from a case's community_context.governance_bodies.
// ----------------------------------------------------------------------------

const TYPES = ['acc', 'arc', 'board_committee', 'nominating', 'other'];

function valid(b) {
  return b && b.name && TYPES.includes(b.type) && b.scope && b.source && b.active_from;
}

// Bodies an agent may name for this community on this date. Anything without a
// source or outside its active dates does not exist for the agent.
function bodiesFor(communityContext = {}, asOf = new Date().toISOString().slice(0, 10)) {
  return (communityContext.governance_bodies || []).filter((b) => valid(b) && b.active_from <= asOf && (!b.active_to || b.active_to >= asOf));
}

// The body (if any) that decides a given kind of request, else null. ACC/ARC
// decisions fall back to the board when no body is established.
function decidingBody(communityContext, kind) {
  const bodies = bodiesFor(communityContext);
  if (kind === 'architectural') return bodies.find((b) => b.type === 'acc' || b.type === 'arc') || null;
  return null;
}

function governanceBlock(communityContext) {
  const bodies = bodiesFor(communityContext);
  if (!bodies.length) return 'GOVERNANCE BODIES FOR THIS COMMUNITY: none on record. The board decides what the governing documents give it; do not name any committee.';
  return 'GOVERNANCE BODIES FOR THIS COMMUNITY (only these exist; name no others):\n'
    + bodies.map((b) => `- ${b.name} (${b.type.toUpperCase()}): ${b.scope}. Source: ${b.source}.`).join('\n');
}

module.exports = { TYPES, bodiesFor, decidingBody, governanceBlock, valid };
