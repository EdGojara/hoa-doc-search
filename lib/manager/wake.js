// ============================================================================
// lib/manager/wake.js  (Issue #27 Phase 1) — the one cheap wake-candidate path
// ----------------------------------------------------------------------------
// A domain write path calls emitWake() AFTER its own work is done. It is a
// single de-duplicated insert into manager_wakes: no model, no reads of other
// tables, no business action. It NEVER throws and never changes the caller's
// result, so an AP bill loads exactly as before whether or not the wake lands.
//
// Dedup: (kind, source id, state) -> one row (UNIQUE dedup_key, insert with
// ON CONFLICT DO NOTHING). A repeated event at the same state is a no-op.
// The sweep, not this call, decides what (if anything) Amanda should do.
//
// Visibility: a real failure is logged (console.warn with context) and written
// to system_errors (/admin/errors) through the SAME client the caller passed in,
// never a separately constructed one (so a faked client in a test can never
// reach production; that happened once, see the test). Before migration 489 is applied the table
// does not exist; that is expected, so it is a single quiet warning, not noise.
// Off switch: AMANDA_MANAGER=off.
// ============================================================================
const { canon, sha } = require('./subjects');

let warnedMissing = false;
const isMissingTable = (e) => /manager_wakes|does not exist|42P01|PGRST20[45]|schema cache/i.test(`${e && e.message || ''} ${e && e.code || ''}`);
const enabled = () => String(process.env.AMANDA_MANAGER || '').trim().toLowerCase() !== 'off';

function dedupKey(kind, sourceId, state) { return `${kind}:${sourceId}:${sha(canon(state || {})).slice(0, 24)}`; }

// emitWake(supabase, { kind, sourceTable, sourceId, communityId, wakeReason, state }, { captureError })
// Returns { ok, emitted?, skipped?, reason? } and never throws.
async function emitWake(supabase, w = {}, { captureError } = {}) {
  try {
    if (!enabled()) return { ok: true, skipped: 'disabled' };
    if (!supabase || !w.kind || !w.sourceId) return { ok: false, skipped: 'incomplete' };
    const row = {
      community_id: w.communityId || null, kind: w.kind, source_table: w.sourceTable, source_id: String(w.sourceId),
      wake_reason: String(w.wakeReason || w.kind).slice(0, 200), dedup_key: dedupKey(w.kind, w.sourceId, w.state), status: 'pending',
    };
    const { error } = await supabase.from('manager_wakes').upsert(row, { onConflict: 'dedup_key', ignoreDuplicates: true });
    if (error) throw error;
    return { ok: true, emitted: true, dedup_key: row.dedup_key };
  } catch (e) {
    if (isMissingTable(e)) {
      if (!warnedMissing) { warnedMissing = true; console.warn('[manager.wake] manager_wakes not present yet (migration 489 not applied); wakes skipped'); }
      return { ok: false, skipped: 'not_deployed' };
    }
    console.warn('[manager.wake] emit failed', JSON.stringify({ kind: w.kind, source_id: w.sourceId, error: e && e.message }));
    const err = { method: 'WAKE', path: `manager_wakes/${w.kind}`, statusCode: 0, message: `wake not recorded for ${w.kind} ${w.sourceId}: ${e && e.message}` };
    try {
      if (captureError) await captureError(err);
      else if (supabase && typeof supabase.from === 'function') {
        await supabase.from('system_errors').insert({ method: err.method, path: err.path, status_code: null, error_message: String(err.message).slice(0, 2000), user_agent: 'manager.wake' });
      }
    } catch (_) { /* never propagate */ }
    return { ok: false, reason: e && e.message };
  }
}

module.exports = { emitWake, dedupKey, enabled };
