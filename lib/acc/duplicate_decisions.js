// ============================================================================
// lib/acc/duplicate_decisions.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// A second DECIDED ACC decision for the same project re-bills the ARC fee — the
// intake already warns a reviewer about it (lib/acc/pending_intake.js), but ones
// that slipped through only surface when the numbers are reconciled against
// Vantaca. As billing moves onto trustEd, this finds those pairs BEFORE they
// double-bill: the same property, both 'decided', close together in time.
//
// It PROPOSES (keep the earliest, the original decision; the later ones are the
// accidental re-issues, per the intake dedup rule). A human confirms and archives
// the duplicate — never auto-archived, because a genuine REVISION (a changed
// dimension, a different shingle) is one project but a legitimately different
// record. Same shape as lib/ap/duplicate_vendors.js.
// ============================================================================

const WINDOW_DAYS = 45;
const normAddr = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function findDuplicateAccDecisions(supabase, { communityId, windowDays = WINDOW_DAYS } = {}) {
  let q = supabase.from('acc_decisions')
    .select('id, community_id, community_name, homeowner_name, homeowner_address, project_summary, decision_type, status, created_at')
    .eq('status', 'decided');
  if (communityId) q = q.eq('community_id', communityId);
  const { data, error } = await q.limit(5000);
  if (error) throw error;

  // group by community + normalized address (fall back to name when no address)
  const byKey = new Map();
  for (const d of data || []) {
    const key = `${d.community_id}|${normAddr(d.homeowner_address || d.homeowner_name)}`;
    if (!normAddr(d.homeowner_address || d.homeowner_name)) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(d);
  }

  const groups = [];
  for (const [, decs] of byKey) {
    if (decs.length < 2) continue;
    decs.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    // only flag ones close in time — a fence this year and a roof next year is not a dup
    const near = [];
    for (let i = 1; i < decs.length; i++) {
      const gap = (new Date(decs[i].created_at) - new Date(decs[i - 1].created_at)) / 864e5;
      if (gap <= windowDays) { if (!near.includes(decs[i - 1])) near.push(decs[i - 1]); near.push(decs[i]); }
    }
    if (near.length < 2) continue;
    near.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    groups.push({
      community_name: near[0].community_name,
      homeowner_name: near[0].homeowner_name,
      homeowner_address: near[0].homeowner_address,
      count: near.length,
      suggested_keep_id: near[0].id, // the earliest = the original
      decisions: near.map((d) => ({ id: d.id, created_at: d.created_at, project_summary: d.project_summary, decision_type: d.decision_type })),
    });
  }
  return groups.sort((a, b) => new Date(b.decisions[0].created_at || 0) - new Date(a.decisions[0].created_at || 0));
}

// Archive the duplicate(s) — keep one 'decided', so it bills once. Never deletes.
async function archiveDuplicateDecisions(supabase, { keepId, archiveIds, by }) {
  if (!keepId || !Array.isArray(archiveIds) || !archiveIds.length) throw new Error('keep_and_archive_required');
  if (archiveIds.includes(keepId)) throw new Error('cannot_archive_the_kept_decision');
  const { data } = await supabase.from('acc_decisions')
    .update({ status: 'archived' })
    .in('id', archiveIds).select('id');
  return { archived: (data || []).length, kept: keepId };
}

module.exports = { findDuplicateAccDecisions, archiveDuplicateDecisions };
