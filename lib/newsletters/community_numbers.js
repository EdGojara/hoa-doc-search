// ============================================================================
// lib/newsletters/community_numbers.js  (Ed 2026-09-07)
// ----------------------------------------------------------------------------
// "Waterview By The Numbers" + "Project Watch" — the proof-of-work sections.
// Residents constantly ask "what does the HOA actually do with our money?" This
// answers it every month from REAL platform data, which is content no aggregator
// (or generic newsletter tool) can produce. Transparency = trust.
//
// Discipline (Ed 2026-09-07):
//  - POSITIVE, work-showing metrics only. Never surface raw violation counts in a
//    resident newsletter — a big number reads as a strict/unpleasant HOA and cuts
//    against the community-not-enforcement tone.
//  - Report the PRIOR completed month ("By the Numbers — August" on a September
//    issue), so figures are whole-month, not a partial current month.
//  - Only include a stat that is non-zero; omit the section entirely if empty.
// ============================================================================

function priorMonthBounds(isoMonth) {
  const first = new Date(`${isoMonth}-01T12:00:00`);
  const priorEnd = new Date(first); // start of the issue month = end of prior month
  const priorStart = new Date(first); priorStart.setMonth(priorStart.getMonth() - 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  const label = priorStart.toLocaleDateString('en-US', { month: 'long' });
  return { start: iso(priorStart), end: iso(priorEnd), label };
}

async function countIn(supabase, table, communityId, dateCol, start, end) {
  try {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true })
      .eq('community_id', communityId).gte(dateCol, start).lt(dateCol, `${end}T00:00:00`);
    if (error) { console.warn(`[numbers] ${table}:`, error.message); return 0; }
    return count || 0;
  } catch (e) { console.warn(`[numbers] ${table}:`, e.message); return 0; }
}

// The month's proof-of-work figures. Returns { label, stats: [{value, label}] }.
async function gatherNumbers(supabase, communityId, issueMonth) {
  const { start, end, label } = priorMonthBounds(issueMonth);
  const [acc, requests, messages] = await Promise.all([
    countIn(supabase, 'acc_decisions', communityId, 'created_at', start, end),
    countIn(supabase, 'work_items', communityId, 'created_at', start, end),
    countIn(supabase, 'email_messages', communityId, 'created_at', start, end),
  ]);
  const stats = [];
  if (acc) stats.push({ value: acc, label: acc === 1 ? 'Architectural request reviewed' : 'Architectural requests reviewed' });
  if (requests) stats.push({ value: requests, label: requests === 1 ? 'Homeowner request handled' : 'Homeowner requests handled' });
  if (messages) stats.push({ value: messages, label: 'Resident messages handled' });
  return { label, stats };
}

// Friendly status for a project stage.
const STAGE_LABEL = {
  planning: 'Planning', scoping: 'Scoping', bidding: 'Bids requested', bids: 'Bids received',
  awarded: 'Awarded', scheduled: 'Scheduled', in_progress: 'In progress', active: 'In progress',
  underway: 'In progress', on_hold: 'On hold', review: 'Board reviewing', complete: 'Complete', completed: 'Complete', done: 'Complete',
};
function stageLabel(p) {
  if (p.completed_at) return 'Complete';
  const raw = String(p.stage || p.status || '').toLowerCase().replace(/[\s-]+/g, '_');
  return STAGE_LABEL[raw] || (raw ? raw.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Underway');
}

const EMAIL_DECISION_LABEL = {
  approved: 'Approved', completed: 'Complete', in_progress: 'In progress',
  proposed: 'Board reviewing', deferred: 'On hold', declined: 'Not approved',
};

// Active + recently-completed community projects for "Project Watch".
// PREFERS the CONFIRMED project decisions extracted from staff email — the
// reconciled truth a human approved — because vendor_projects drifts from reality
// (it printed "Board Deciding" for an already-approved soccer-field irrigation).
// Falls back to vendor_projects when a community hasn't been reconciled yet.
// (Ed 2026-09-08.)
async function gatherProjects(supabase, communityId) {
  try {
    const { data: confirmed } = await supabase.from('project_email_decisions')
      .select('project, status, decided_on, updated_at')
      .eq('community_id', communityId).eq('review_status', 'confirmed')
      .order('decided_on', { ascending: false, nullsFirst: false }).limit(30);
    if (confirmed && confirmed.length) {
      const now = Date.now();
      const rows = confirmed.filter((p) => {
        if (p.status !== 'completed') return true;               // keep active work
        const when = p.decided_on ? new Date(p.decided_on).getTime() : new Date(p.updated_at || 0).getTime();
        return (now - when) < 60 * 864e5;                        // + recent wins
      }).slice(0, 6);
      return rows.map((p) => ({ name: p.project, status: EMAIL_DECISION_LABEL[p.status] || 'Underway', done: p.status === 'completed' }));
    }
  } catch (e) { console.warn('[numbers] email-decision projects:', e.message); /* table may not exist yet — fall through */ }
  try {
    const { data, error } = await supabase.from('vendor_projects')
      .select('title, category, stage, completed_at, percent_complete, is_major, target_date, next_action_note, updated_at')
      .eq('community_id', communityId).order('is_major', { ascending: false }).order('updated_at', { ascending: false }).limit(30);
    if (error) { console.warn('[numbers] projects:', error.message); return []; }
    const now = Date.now();
    const rows = (data || []).filter((p) => {
      // keep active projects + anything completed in the last ~45 days (a recent win)
      if (!p.completed_at) return true;
      return (now - new Date(p.completed_at).getTime()) < 45 * 864e5;
    }).slice(0, 6);
    return rows.map((p) => ({ name: p.title || 'Community project', status: stageLabel(p), done: !!p.completed_at }));
  } catch (e) { console.warn('[numbers] projects:', e.message); return []; }
}

module.exports = { gatherNumbers, gatherProjects };
