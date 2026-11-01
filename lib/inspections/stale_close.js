// ============================================================================
// lib/inspections/stale_close.js  (Ed 2026-11-01: activity-driven, not polling)
// ----------------------------------------------------------------------------
// An inspection left 'in_progress' with no GPS ping for N hours (default 4) is the
// 'operator forgot to click End drive' case: it is closed as 'captured', ended at
// its last ping (or start + N hours). Same rule the 2-hour scheduler job applied,
// now run when the Active Drives list is read, the only place a stale drive shows.
// A drive that is still pinging is never touched. Never throws.
// ============================================================================
async function closeStaleInspections(supabase, { staleHours = Number(process.env.INSPECTION_STALE_HOURS || 4), log = console } = {}) {
  try {
    const cutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
    const { data: stale, error } = await supabase
      .from('inspections')
      .select('id, started_at, last_ping_at')
      .eq('status', 'in_progress')
      .or(`last_ping_at.lt.${cutoffIso},and(last_ping_at.is.null,started_at.lt.${cutoffIso})`)
      .limit(200);
    if (error) { log.warn('[inspections] stale close-out lookup failed:', error.message); return { ok: false, error: error.message }; }
    let closed = 0;
    for (const s of stale || []) {
      const endedAt = s.last_ping_at || new Date(new Date(s.started_at).getTime() + staleHours * 60 * 60 * 1000).toISOString();
      const { error: upErr } = await supabase.from('inspections')
        .update({ status: 'captured', ended_at: endedAt, notes: `Auto-closed after ${staleHours}h of no GPS pings. Inspector tablet may have closed without End being tapped.` })
        .eq('id', s.id).eq('status', 'in_progress');
      if (upErr) log.warn('[inspections] stale close-out failed:', JSON.stringify({ id: s.id, error: upErr.message })); else closed += 1;
    }
    return { ok: true, closed, found: (stale || []).length };
  } catch (e) { log.warn('[inspections] stale close-out threw:', e.message); return { ok: false, error: e.message }; }
}

module.exports = { closeStaleInspections };
