// ============================================================================
// lib/voice/call_cache.js — per-call in-memory cache
// ----------------------------------------------------------------------------
// Stash expensive lookups (community profile, playbook entries, anything
// constant for the duration of a call) by call_id so subsequent turns
// don't re-fetch from Supabase.
//
// Without this: every Vapi LLM webhook turn does a fresh round of
// buildCommunityContextBlock() + caller-ID resolution + (potentially)
// playbook fetch. Adds 200-500ms per turn on data that doesn't change
// during the call.
//
// With this: first turn does the lookup, stashes by call_id. Every
// subsequent turn reads from memory. Cache entries auto-expire after
// 10 minutes (longer than any normal call).
//
// Single-process scope. If trustEd ever scales to multiple Render
// instances, we'd need to move this to Redis. Today's traffic doesn't
// justify the complexity.
// ============================================================================

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const _store = new Map();
// Map<callId, { value, expiresAt }>

function _now() { return Date.now(); }

function _pruneExpired() {
  const now = _now();
  for (const [k, entry] of _store.entries()) {
    if (entry.expiresAt <= now) _store.delete(k);
  }
}

/**
 * Get the cached entry for a callId. Returns null if missing or expired.
 */
function getCall(callId) {
  if (!callId) return null;
  const entry = _store.get(callId);
  if (!entry) return null;
  if (entry.expiresAt <= _now()) {
    _store.delete(callId);
    return null;
  }
  return entry.value;
}

/**
 * Set the cached entry for a callId. Always overwrites.
 * value shape (current usage): {
 *   community: { id, name, profileBlock }   // resolved once at call start
 *   caller:    { id, first_name, full_name } // ditto
 *   resolvedAt: number                       // epoch ms
 * }
 */
function setCall(callId, value) {
  if (!callId) return;
  // Prune occasionally to prevent unbounded growth from never-ending
  // call_ids. Cheap O(n) sweep at most once per write.
  if (_store.size > 100) _pruneExpired();
  _store.set(callId, { value, expiresAt: _now() + TTL_MS });
}

/**
 * Drop the cached entry for a callId. Called at end-of-call-report time.
 */
function clearCall(callId) {
  if (!callId) return;
  _store.delete(callId);
}

module.exports = { getCall, setCall, clearCall };
