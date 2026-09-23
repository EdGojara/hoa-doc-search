// ============================================================================
// lib/meetings/roster.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// The community's active board roster (board_members) and the transcript's
// speaker mappings, in the shape the Transcript tab, Paige's analysis and the
// validator all share. One reader so they can never disagree about who is on
// the board.
// ============================================================================
const { fetchAll } = require('../db/fetch_all');

async function boardRoster(supabase, communityId) {
  const rows = await fetchAll(supabase, 'board_members', { select: 'id, name, position, is_active, community_id', filters: { community_id: communityId, is_active: true }, orderBy: 'name' });
  return rows.map((r) => ({ id: r.id, name: r.name, position: r.position || null }));
}

async function speakerMappings(supabase, transcriptId) {
  const rows = await fetchAll(supabase, 'meeting_speaker_mappings', { select: 'speaker, role, board_member_id, display_name, updated_at', filters: { transcript_id: transcriptId }, orderBy: 'speaker' });
  return rows;
}

const ROLE_LABEL = { board_member: 'Board member', manager: 'Manager', vendor: 'Vendor', homeowner: 'Homeowner', other: 'Other' };

/** Label for a speaker number given mappings + roster: "Sunny Meadows (President)" / "Manager" / "Speaker 2". */
function speakerLabel(speaker, mappings, roster) {
  const m = (mappings || []).find((x) => x.speaker === speaker);
  if (!m) return speaker == null ? 'Unknown speaker' : `Speaker ${speaker + 1}`;
  if (m.role === 'board_member') {
    const b = (roster || []).find((r) => r.id === m.board_member_id);
    if (b) return `${b.name}${b.position ? ` (${b.position})` : ''}`;
  }
  return m.display_name ? `${m.display_name} (${ROLE_LABEL[m.role]})` : ROLE_LABEL[m.role];
}

module.exports = { boardRoster, speakerMappings, speakerLabel, ROLE_LABEL };
