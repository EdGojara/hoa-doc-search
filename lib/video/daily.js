// ============================================================================
// lib/video/daily.js
// ----------------------------------------------------------------------------
// Thin wrapper over Daily's REST API (https://docs.daily.co/reference) for
// Chamber's branded two-way rooms. Gated on DAILY_API_KEY — when it's unset the
// caller falls back to a free Jitsi room, so nothing breaks before the key is
// added. Daily removes the meet.jit.si "waiting for a moderator / login failed"
// friction: rooms start instantly, the host holds an owner token, invitees just
// open the URL. (Ed 2026-08-12.)
// ============================================================================

const DAILY_API = 'https://api.daily.co/v1';

function dailyEnabled() { return !!process.env.DAILY_API_KEY; }

async function dailyFetch(path, opts = {}) {
  const r = await fetch(`${DAILY_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON */ }
  if (!r.ok) throw new Error(j.info || j.error || `Daily API ${r.status}: ${text.slice(0, 120)}`);
  return j;
}

// Create a room. Public so members + invitees join by URL with no login and no
// moderator wait (host control comes from the owner token below). Webinar mode
// starts everyone muted/cam-off. Rooms auto-expire so they don't accumulate.
async function createRoom({ webinar = false, expSeconds = 8 * 3600 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + expSeconds;
  const body = {
    privacy: 'public',
    properties: {
      exp,
      enable_chat: true,
      enable_screenshare: true,
      enable_prejoin_ui: false,
      start_video_off: !!webinar,
      start_audio_off: !!webinar,
    },
  };
  const room = await dailyFetch('/rooms', { method: 'POST', body: JSON.stringify(body) });
  return { name: room.name, url: room.url };
}

// A meeting token. is_owner=true makes the holder the moderator (mute others,
// manage the webinar, end the room). Host uses this; members/invitees don't need one.
async function meetingToken({ roomName, isOwner = false, userName, expSeconds = 8 * 3600 }) {
  const exp = Math.floor(Date.now() / 1000) + expSeconds;
  const props = { room_name: roomName, is_owner: !!isOwner, exp };
  if (userName) props.user_name = userName;
  const j = await dailyFetch('/meeting-tokens', { method: 'POST', body: JSON.stringify({ properties: props }) });
  return j.token;
}

module.exports = { dailyEnabled, createRoom, meetingToken };
