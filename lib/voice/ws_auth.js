// ============================================================================
// lib/voice/ws_auth.js  (Issue #29, 2026-10-04)
// ----------------------------------------------------------------------------
// WHO MAY OPEN A BROWSER VOICE SOCKET.
//
// WebSocket upgrades never pass through Express, so the staff gate and the
// /api/claire route checks never ran on them. Anyone who knew the path could
// open /api/claire/stt-stream and hold a Deepgram stream billed to Bedrock, and
// /api/claire-live/stream the same for the GPT-Live PoC. This module is the
// check the upgrade handler in server.js runs BEFORE handleUpgrade, so an
// unauthenticated client never gets a socket at all.
//
// It reuses the one identity gate (lib/claire/scope.resolveVisitor) and the one
// ownership rule (scope.ownsSession) the HTTP routes use. No fourth auth system.
//
//   STT relay   : signed-in visitor + a LIVE claire_sessions row they own,
//                 named by ?session=<uuid>. The visit is the unit we already
//                 meter and cap; the mic stream rides on it.
//   Claire Live : staff only (it is a PoC linked from /admin/systems).
//
// Every accepted socket also gets a hard max duration (armMaxDuration), so a
// forgotten tab cannot hold a metered stream open forever.
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ceilings for one socket. The STT socket uses the visit's own seconds_cap
// (600 homeowner / 1800 staff+board) but never more than this.
const STT_MAX_SECONDS = 1800;
const LIVE_MAX_SECONDS = 600;

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 500: 'Internal Server Error' };

// Real dependencies are required lazily: scope.js builds a Supabase client at
// load, and tests inject fakes without ever touching it.
function realDeps() {
  const scope = require('../claire/scope');
  return {
    resolveVisitor: scope.resolveVisitor,
    ownsSession: scope.ownsSession,
    loadSession: async (id) => {
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const { data, error } = await sb.from('claire_sessions')
        .select('id, status, portal_user_id, board_email, visitor_email, language, seconds_cap')
        .eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },
  };
}

function queryParam(req, name) {
  try { return new URL(req.url || '', 'http://localhost').searchParams.get(name) || ''; }
  catch (_) { return ''; }
}

/**
 * Authorize a browser upgrade to /api/claire/stt-stream.
 * Returns { ok:true, visitor, session, maxSeconds } or { ok:false, status, reason }.
 * Never throws: any failure to establish identity is a denial.
 */
async function authorizeSttUpgrade(req, deps) {
  const d = deps || realDeps();
  const sessionId = queryParam(req, 'session');
  if (!UUID_RE.test(sessionId)) return { ok: false, status: 400, reason: 'session_required' };

  let visitor = null;
  try { visitor = await d.resolveVisitor(req); }
  catch (e) { return { ok: false, status: 401, reason: 'visitor_resolve_failed' }; }
  if (!visitor) return { ok: false, status: 401, reason: 'not_signed_in' };

  let session = null;
  try { session = await d.loadSession(sessionId); }
  catch (e) { return { ok: false, status: 500, reason: 'session_read_failed' }; }
  if (!session) return { ok: false, status: 404, reason: 'session_not_found' };
  if (!d.ownsSession(visitor, session)) return { ok: false, status: 403, reason: 'not_your_session' };
  if (session.status !== 'active') return { ok: false, status: 409, reason: 'session_not_active' };

  const cap = Number(session.seconds_cap) > 0 ? Number(session.seconds_cap) : 600;
  return { ok: true, visitor, session, maxSeconds: Math.min(cap, STT_MAX_SECONDS) };
}

/**
 * Authorize a browser upgrade to /api/claire-live/stream (GPT-Live PoC).
 * Staff only. Returns { ok:true, visitor, maxSeconds } or { ok:false, status, reason }.
 */
async function authorizeLiveUpgrade(req, deps) {
  const d = deps || realDeps();
  let visitor = null;
  try { visitor = await d.resolveVisitor(req); }
  catch (e) { return { ok: false, status: 401, reason: 'visitor_resolve_failed' }; }
  if (!visitor) return { ok: false, status: 401, reason: 'not_signed_in' };
  // A mimicked visitor resolves as the person being viewed, never as staff, so
  // view-as cannot be used to reach a staff-only socket.
  if (visitor.role !== 'staff') return { ok: false, status: 403, reason: 'staff_only' };
  return { ok: true, visitor, maxSeconds: LIVE_MAX_SECONDS };
}

/** Refuse an upgrade on the raw socket with a plain HTTP status, then drop it. */
function rejectUpgrade(socket, status) {
  const code = STATUS_TEXT[status] ? status : 403;
  try {
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${code} ${STATUS_TEXT[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  } catch (_) { /* socket already gone */ }
  try { socket.destroy(); } catch (_) {}
}

/**
 * Close the socket after maxSeconds no matter what. Policy-violation close code
 * (1008) so the client can tell a cap from a crash. Returns the timer.
 */
function armMaxDuration(ws, maxSeconds, label) {
  // A missing or nonsense cap falls back to 10 minutes, never "no cap".
  const secs = Number(maxSeconds) > 0 ? Number(maxSeconds) : 600;
  const ms = secs * 1000;
  const timer = setTimeout(() => {
    console.log(`[${label || 'ws'}] max duration ${maxSeconds}s reached, closing`);
    try { ws.close(1008, 'max_duration'); } catch (_) {}
    // A peer that ignores the close handshake still gets cut off.
    setTimeout(() => { try { ws.terminate && ws.terminate(); } catch (_) {} }, 5000).unref?.();
  }, ms);
  if (timer.unref) timer.unref();
  try { ws.on('close', () => clearTimeout(timer)); } catch (_) {}
  return timer;
}

module.exports = {
  authorizeSttUpgrade, authorizeLiveUpgrade, rejectUpgrade, armMaxDuration,
  STT_MAX_SECONDS, LIVE_MAX_SECONDS,
};
