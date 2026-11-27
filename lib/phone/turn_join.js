// ============================================================================
// lib/phone/turn_join.js  (2026-11-28: Claire's phone turns survive voice-shell resends)
// ----------------------------------------------------------------------------
// ElevenLabs resends a turn every few seconds while it is still being answered
// (seen on Ed's 11-27 Talk to Amanda call: 49 tool calls, no answer). Amanda's
// engine handles this itself (lib/amanda/conversation.js runTurn, #508). Claire's
// phone brain uses the same rule through this helper:
//   - one computation per turn, independent of the HTTP request that started it
//   - a resend of the SAME turn (same conversation through the last thing the
//     caller said; conversation.turnKey) joins it and gets only what was not
//     delivered yet
//   - a new utterance supersedes (aborts) the running turn
// So a verification code is never sent twice by a resend.
// ============================================================================
const JOIN_WINDOW_MS = 45 * 1000;
const _flights = new Map(); // scope -> flight

/**
 * produce(emit, signal) -> Promise<result>. emit(text) streams to every joined request.
 * Returns the producer's result, plus { joined } for a resend.
 */
async function joinTurn({ scope, key, produce, onText, signal }) {
  let f = _flights.get(scope);
  const joinable = !!(f && f.key === key && (!f.done || Date.now() - f.doneAt < JOIN_WINDOW_MS));
  if (!joinable) {
    if (f && !f.done) f.ctrl.abort();
    const ctrl = new AbortController();
    f = { key, ctrl, chunks: [], delivered: 0, subs: new Set(), done: false, doneAt: 0, result: null };
    _flights.set(scope, f);
    const flight = f;
    f.promise = Promise.resolve().then(() => produce((t) => { flight.chunks.push(t); for (const s of flight.subs) s(t); }, ctrl.signal))
      .then((r) => { flight.result = r || {}; }, (e) => { flight.result = { error: e.message }; })
      .finally(() => { flight.done = true; flight.doneAt = Date.now(); for (const s of flight.subs) s(null); flight.subs.clear(); });
  }
  const flight = f;
  for (let i = flight.delivered; i < flight.chunks.length; i++) onText(flight.chunks[i]);
  flight.delivered = Math.max(flight.delivered, flight.chunks.length);
  if (!flight.done) {
    await new Promise((resolve) => {
      const finish = () => { flight.subs.delete(sub); if (signal) signal.removeEventListener('abort', finish); resolve(); };
      const sub = (t) => { if (t === null || (signal && signal.aborted)) return finish(); onText(t); flight.delivered = flight.chunks.length; };
      flight.subs.add(sub);
      if (signal) { if (signal.aborted) finish(); else signal.addEventListener('abort', finish); }
    });
  }
  return { ...(flight.result || {}), joined: joinable || undefined };
}

function _resetForTests() { _flights.clear(); }

module.exports = { joinTurn, JOIN_WINDOW_MS, _resetForTests };
