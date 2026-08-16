// ============================================================================
// api/claire.js — VIRTUAL CLAIRE  (Ed 2026-08-16)
// ----------------------------------------------------------------------------
// The door to the embodied assistant. Homeowners, board members and staff all
// arrive here; lib/claire/scope.js decides which of them is standing there and
// what they may see. There is ONE Claire behind all three doors — the same
// reasoning core that answers the phone (lib/voice/reason.streamTurn), the same
// unified retrieval, the same persona. Only scope and permission change.
//
// Endpoints:
//   Any signed-in visitor:
//     GET  /me                        who am I, is video available, what may I do
//     POST /session/start             open a visit  → session id + honest-AI opener
//     POST /session/:id/avatar-token  short-lived HeyGen token (key stays server-side)
//     POST /session/:id/turn          one exchange, streamed back sentence by sentence
//     POST /session/:id/heartbeat     meter the avatar minutes + enforce the cap
//     POST /session/:id/handoff       hand to a human
//     POST /session/:id/end           close out, write the cost ledger
//     GET  /explainers                the pre-rendered library (free to replay)
//   Staff only:
//     GET  /avatars                   candidate faces, used once to pick Claire
//     POST /explainers                write + render an explainer
//     GET  /explainers/:id            poll a render
//
// Two things here are load-bearing and easy to mistake for ceremony:
//
//   1. The guardrail runs BEFORE the model, every turn, server-side. A face is
//      read as authority; a prompt instruction is a request, not a control.
//      See lib/claire/guardrails.js + tests/test_claire_guardrails.js.
//   2. Avatar minutes are metered and capped server-side. Streaming bills by
//      the minute, so an open tab left overnight is a bill. The cap is not a
//      UX preference, it is the spend control.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff } = require('./_require_admin');
const { resolveVisitor, resolveVisitCommunity } = require('../lib/claire/scope');
const { screen, honestOpener } = require('../lib/claire/guardrails');
const heygen = require('../lib/video/heygen');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

router.use(express.json({ limit: '256kb' }));

// A visit may sit idle this long before the server treats it as abandoned. Cuts
// the tail case the cap alone misses: a tab closed without an /end call.
const IDLE_EXPIRE_SECONDS = 180;

// ---- helpers ---------------------------------------------------------------

async function communityById(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('communities').select('id, name').eq('id', id).maybeSingle();
  if (error) { console.warn('[claire] community read failed:', error.message); return null; }
  return data || null;
}

// Load a session AND prove it belongs to the visitor making the request. Never
// trust a session id on its own: it is a bearer token for someone's own
// correspondence with the association.
async function loadOwnedSession(req, res) {
  const visitor = await resolveVisitor(req);
  if (!visitor) { res.status(401).json({ error: 'not_signed_in' }); return null; }
  const { data: s, error } = await supabase
    .from('claire_sessions').select('*').eq('id', req.params.id).maybeSingle();
  if (error) { console.error('[claire] session read failed:', error.message); res.status(500).json({ error: safeErrorMessage(error) }); return null; }
  if (!s) { res.status(404).json({ error: 'session_not_found' }); return null; }

  const mine =
    (visitor.role === 'homeowner' && s.portal_user_id && s.portal_user_id === visitor.portalUserId) ||
    (visitor.role === 'board' && s.board_email && visitor.email
      && s.board_email.toLowerCase() === visitor.email.toLowerCase()) ||
    (visitor.role === 'staff' && s.visitor_email && visitor.email
      && s.visitor_email.toLowerCase() === visitor.email.toLowerCase());
  if (!mine) { res.status(403).json({ error: 'not_your_session' }); return null; }
  return { visitor, session: s };
}

async function nextSeq(sessionId) {
  const { count, error } = await supabase
    .from('claire_session_turns').select('id', { count: 'exact', head: true }).eq('session_id', sessionId);
  if (error) { console.warn('[claire] seq count failed:', error.message); return Date.now() % 100000; }
  return (count || 0) + 1;
}

async function logTurn(sessionId, speaker, text, extra = {}) {
  const row = { session_id: sessionId, seq: await nextSeq(sessionId), speaker, text: text || null, ...extra };
  const { error } = await supabase.from('claire_session_turns').insert(row);
  // A transcript that silently fails to write is worse than none: it looks
  // complete. Log loudly, but never fail the visitor's turn over it.
  if (error) console.error('[claire] TRANSCRIPT WRITE FAILED', sessionId, speaker, error.message);
}

function centsFor(seconds) {
  return Math.round((Math.max(0, seconds) / 60) * heygen.streamingCentsPerMinute());
}

// ---- who is at the door ----------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const visitor = await resolveVisitor(req);
    if (!visitor) return res.status(401).json({ error: 'not_signed_in' });
    let communities = [];
    if (visitor.communityIds === 'all') {
      const { data } = await supabase.from('communities').select('id, name').order('name');
      communities = data || [];
    } else if (visitor.communityIds.length) {
      const { data } = await supabase.from('communities').select('id, name').in('id', visitor.communityIds).order('name');
      communities = data || [];
    }
    res.json({
      visitor: {
        role: visitor.role,
        name: visitor.name,
        first_name: (visitor.name || '').trim().split(/\s+/)[0] || null,
        email: visitor.email,
        seconds_cap: visitor.secondsCap,
      },
      communities,
      // The page degrades honestly rather than showing a dead "start video"
      // button: no key or the switch off means voice-and-text Claire.
      video: { available: heygen.streamingEnabled(), avatar_configured: !!heygen.claireAvatarId() },
    });
  } catch (err) {
    console.error('[claire] /me failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- open a visit ----------------------------------------------------------
router.post('/session/start', async (req, res) => {
  try {
    const visitor = await resolveVisitor(req);
    if (!visitor) return res.status(401).json({ error: 'not_signed_in' });

    const communityId = resolveVisitCommunity(visitor, (req.body || {}).community_id);
    if (!communityId) {
      return res.status(403).json({
        error: 'community_required',
        detail: 'Pick which community this visit is about.',
        choices: visitor.communityIds === 'all' ? 'all' : visitor.communityIds,
      });
    }
    const community = await communityById(communityId);
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    const language = (req.body || {}).language === 'es' ? 'es' : 'en';
    const surface = ['visit', 'chamber', 'kiosk'].includes((req.body || {}).surface) ? (req.body || {}).surface : 'visit';

    const row = {
      community_id: communityId,
      role: visitor.role,
      portal_user_id: visitor.portalUserId || null,
      board_email: visitor.role === 'board' ? visitor.email : null,
      visitor_name: visitor.name || null,
      visitor_email: visitor.email || null,
      property_id: visitor.propertyId || null,
      surface,
      broadcast_id: (req.body || {}).broadcast_id || null,
      language,
      status: 'active',
      avatar_provider: heygen.streamingEnabled() ? 'heygen' : 'none',
      avatar_id: heygen.claireAvatarId(),
      seconds_cap: visitor.secondsCap,
    };
    const { data: s, error } = await supabase.from('claire_sessions').insert(row).select('*').single();
    if (error) throw error;

    const firstName = (visitor.name || '').trim().split(/\s+/)[0] || null;
    const opener = honestOpener(community.name, firstName, language);
    await logTurn(s.id, 'claire', opener);

    res.json({
      session: {
        id: s.id, role: s.role, language: s.language, surface: s.surface,
        seconds_cap: s.seconds_cap, community: { id: community.id, name: community.name },
      },
      opener,
      video: { available: heygen.streamingEnabled(), avatar_id: heygen.claireAvatarId() },
    });
  } catch (err) {
    console.error('[claire] session start failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- the avatar token ------------------------------------------------------
// The browser opens the WebRTC session with this. HEYGEN_API_KEY never ships to
// a page: a key on a public surface is an unmetered bill anyone can run up.
router.post('/session/:id/avatar-token', async (req, res) => {
  try {
    const ctx = await loadOwnedSession(req, res);
    if (!ctx) return;
    if (ctx.session.status !== 'active') return res.status(409).json({ error: 'session_not_active' });
    if (!heygen.streamingEnabled()) return res.status(503).json({ error: 'video_unavailable', detail: 'Claire is available by voice and text right now.' });
    if (!heygen.claireAvatarId()) return res.status(503).json({ error: 'avatar_not_configured', detail: 'No Claire avatar has been selected yet.' });

    const token = await heygen.createStreamingToken();
    res.json({ token, avatar_id: heygen.claireAvatarId(), voice_id: heygen.claireVoiceId(ctx.session.language), seconds_cap: ctx.session.seconds_cap });
  } catch (err) {
    console.error('[claire] avatar token failed:', err.message);
    res.status(502).json({ error: safeErrorMessage(err) });
  }
});

// ---- one exchange ----------------------------------------------------------
// Streams back sentence by sentence (SSE) so the avatar starts speaking on the
// first clause instead of after the whole answer. Same reason the phone bridge
// speaks per sentence: waiting for a complete paragraph reads as a hang.
router.post('/session/:id/turn', async (req, res) => {
  const ctx = await loadOwnedSession(req, res);
  if (!ctx) return;
  const { visitor, session } = ctx;
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text_required' });
  if (session.status !== 'active') return res.status(409).json({ error: 'session_not_active' });

  await logTurn(session.id, 'visitor', text);

  // THE GATE — before the model, every turn, no exceptions.
  const verdict = screen(text, session.role);
  if (!verdict.allow) {
    await logTurn(session.id, 'claire', verdict.reply, { blocked_reason: verdict.reason });
    await supabase.from('claire_sessions')
      .update({ handoff_requested: true, handoff_reason: verdict.reason })
      .eq('id', session.id);
    return res.json({ blocked: true, reason: verdict.reason, sentences: [verdict.reply], reply: verdict.reply });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  let full = '';
  try {
    const community = await communityById(session.community_id);
    const caller = {
      contact: { first_name: (visitor.name || '').trim().split(/\s+/)[0] || null, full_name: visitor.name || null },
      property: session.property_id ? { id: session.property_id, community_id: session.community_id } : null,
      community,
    };

    // History from the transcript so a reconnect mid-visit doesn't amnesia the
    // conversation. Server-side state, not the browser's — the client is a
    // cache, never the source of truth.
    const { data: prior } = await supabase.from('claire_session_turns')
      .select('speaker, text').eq('session_id', session.id).order('seq').limit(40);
    const history = (prior || [])
      .filter((t) => t.text && t.speaker !== 'system' && t.text !== text)
      .map((t) => ({ role: t.speaker === 'visitor' ? 'user' : 'assistant', content: t.text }));

    const { streamTurn } = require('../lib/voice/reason');
    const personaPack = session.language === 'es'
      ? (() => { try { const p = require('../lib/voice/reason_isabella'); return p.personaPack || p; } catch (_) { return undefined; } })()
      : undefined;

    for await (const chunk of streamTurn({ utterance: text, history, community, caller, personaPack })) {
      if (typeof chunk !== 'string') continue;  // control objects (passthrough tools) don't apply on video
      full += (full ? ' ' : '') + chunk;
      send('sentence', { text: chunk });
    }
    if (!full) {
      full = 'Sorry, I lost that one. Could you say it again?';
      send('sentence', { text: full });
    }
    await logTurn(session.id, 'claire', full);
    send('done', { reply: full });
    res.end();
  } catch (err) {
    console.error('[claire] turn failed:', err.stack || err.message);
    const fallback = 'Sorry, I am having trouble on my end right now. Want me to get someone from the team to follow up?';
    await logTurn(session.id, 'claire', fallback, { blocked_reason: 'turn_error' });
    send('sentence', { text: fallback });
    send('done', { reply: fallback, error: true });
    res.end();
  }
});

// ---- the meter -------------------------------------------------------------
// The browser reports elapsed avatar seconds; the SERVER decides whether the
// visit continues. A client-side timer is a suggestion, and the thing being
// limited is money.
router.post('/session/:id/heartbeat', async (req, res) => {
  try {
    const ctx = await loadOwnedSession(req, res);
    if (!ctx) return;
    const { session } = ctx;
    if (session.status !== 'active') return res.json({ active: false, status: session.status, seconds_remaining: 0 });

    const reported = Math.max(0, Math.round(Number((req.body || {}).avatar_seconds) || 0));
    // Never let a client walk the meter backwards.
    const seconds = Math.max(session.avatar_seconds || 0, reported);
    const remaining = Math.max(0, session.seconds_cap - seconds);

    if (remaining <= 0) {
      await supabase.from('claire_sessions').update({
        status: 'ended', ended_at: new Date().toISOString(),
        avatar_seconds: seconds, est_cost_cents: centsFor(seconds), end_reason: 'time_cap',
      }).eq('id', session.id);
      await logTurn(session.id, 'system', `Visit ended at the ${Math.round(session.seconds_cap / 60)} minute cap.`);
      return res.json({ active: false, status: 'ended', seconds_remaining: 0, reason: 'time_cap' });
    }

    await supabase.from('claire_sessions')
      .update({ avatar_seconds: seconds, est_cost_cents: centsFor(seconds) }).eq('id', session.id);
    res.json({ active: true, seconds_remaining: remaining, seconds_used: seconds });
  } catch (err) {
    console.error('[claire] heartbeat failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- hand to a human -------------------------------------------------------
router.post('/session/:id/handoff', async (req, res) => {
  try {
    const ctx = await loadOwnedSession(req, res);
    if (!ctx) return;
    const reason = String((req.body || {}).reason || 'visitor_requested').slice(0, 200);
    await supabase.from('claire_sessions')
      .update({ handoff_requested: true, handoff_reason: reason, status: 'handoff' }).eq('id', ctx.session.id);
    await logTurn(ctx.session.id, 'system', `Handoff requested: ${reason}`);
    res.json({ ok: true, message: 'I have passed this to the team with everything we covered, so you will not have to repeat it.' });
  } catch (err) {
    console.error('[claire] handoff failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- close out -------------------------------------------------------------
router.post('/session/:id/end', async (req, res) => {
  try {
    const ctx = await loadOwnedSession(req, res);
    if (!ctx) return;
    const { session } = ctx;
    const reported = Math.max(0, Math.round(Number((req.body || {}).avatar_seconds) || 0));
    const seconds = Math.max(session.avatar_seconds || 0, reported);
    const status = session.status === 'handoff' ? 'handoff' : 'ended';
    const { error } = await supabase.from('claire_sessions').update({
      status, ended_at: new Date().toISOString(), avatar_seconds: seconds,
      est_cost_cents: centsFor(seconds),
      end_reason: String((req.body || {}).reason || 'visitor_ended').slice(0, 100),
    }).eq('id', session.id);
    if (error) throw error;
    res.json({ ok: true, avatar_seconds: seconds, est_cost_cents: centsFor(seconds) });
  } catch (err) {
    console.error('[claire] end failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- the pre-rendered library ----------------------------------------------
// Free to replay. Anything identical for every viewer lives here and never runs
// as a live session.
router.get('/explainers', async (req, res) => {
  try {
    const visitor = await resolveVisitor(req);
    if (!visitor) return res.status(401).json({ error: 'not_signed_in' });
    let q = supabase.from('claire_explainers')
      .select('id, topic, language, title, video_url, duration_seconds, community_id')
      .eq('status', 'ready').order('topic');
    if (req.query.topic) q = q.eq('topic', String(req.query.topic));
    if (req.query.language) q = q.eq('language', String(req.query.language) === 'es' ? 'es' : 'en');
    const { data, error } = await q;
    if (error) throw error;
    // Portfolio-wide explainers (community_id NULL) plus any scoped to a
    // community this visitor may actually see.
    const rows = (data || []).filter((e) => !e.community_id
      || visitor.communityIds === 'all'
      || (Array.isArray(visitor.communityIds) && visitor.communityIds.includes(e.community_id)));
    res.json({ explainers: rows });
  } catch (err) {
    console.error('[claire] explainers list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- staff: pick the face --------------------------------------------------
router.get('/avatars', async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return;
    if (!heygen.heygenEnabled()) return res.status(503).json({ error: 'heygen_not_configured' });
    res.json({ avatars: await heygen.listStreamingAvatars(), current: heygen.claireAvatarId() });
  } catch (err) {
    console.error('[claire] avatar list failed:', err.message);
    res.status(502).json({ error: safeErrorMessage(err) });
  }
});

// ---- staff: write + render an explainer ------------------------------------
router.post('/explainers', async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return;
    const b = req.body || {};
    const topic = String(b.topic || '').trim();
    const title = String(b.title || '').trim();
    const script = String(b.script || '').trim();
    const language = b.language === 'es' ? 'es' : 'en';
    if (!topic || !title || !script) return res.status(400).json({ error: 'topic_title_and_script_required' });
    if (!heygen.heygenEnabled()) return res.status(503).json({ error: 'heygen_not_configured' });

    const { data: row, error } = await supabase.from('claire_explainers').insert({
      topic, title, script, language,
      community_id: b.community_id || null,
      avatar_id: heygen.claireAvatarId(),
      status: 'rendering',
    }).select('*').single();
    if (error) throw error;

    try {
      const videoId = await heygen.renderExplainer({ script, language });
      await supabase.from('claire_explainers').update({ provider_video_id: videoId }).eq('id', row.id);
      res.json({ explainer: { ...row, provider_video_id: videoId } });
    } catch (e) {
      // Record WHY it failed on the row. A render that fails silently leaves a
      // permanently "rendering" entry nobody can diagnose.
      await supabase.from('claire_explainers').update({ status: 'failed', render_error: e.message.slice(0, 500) }).eq('id', row.id);
      res.status(502).json({ error: safeErrorMessage(e), explainer_id: row.id });
    }
  } catch (err) {
    console.error('[claire] explainer create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- staff: poll a render --------------------------------------------------
router.get('/explainers/:id', async (req, res) => {
  try {
    if (!await requireStaff(req, res)) return;
    const { data: row, error } = await supabase.from('claire_explainers').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status !== 'rendering' || !row.provider_video_id) return res.json({ explainer: row });

    const st = await heygen.videoStatus(row.provider_video_id);
    const patch = {};
    if (st.status === 'completed' && st.video_url) {
      patch.status = 'ready'; patch.video_url = st.video_url; patch.duration_seconds = st.duration;
    } else if (st.status === 'failed') {
      patch.status = 'failed'; patch.render_error = st.error || 'render failed';
    }
    if (Object.keys(patch).length) {
      const { data: updated } = await supabase.from('claire_explainers').update(patch).eq('id', row.id).select('*').single();
      return res.json({ explainer: updated || { ...row, ...patch } });
    }
    res.json({ explainer: row, provider_status: st.status });
  } catch (err) {
    console.error('[claire] explainer status failed:', err.message);
    res.status(502).json({ error: safeErrorMessage(err) });
  }
});

// Sweep abandoned visits. A tab closed without /end would otherwise sit 'active'
// forever and its minutes would never land in the cost ledger.
async function expireIdleSessions() {
  const cutoff = new Date(Date.now() - IDLE_EXPIRE_SECONDS * 1000).toISOString();
  const { data, error } = await supabase.from('claire_sessions')
    .update({ status: 'expired', ended_at: new Date().toISOString(), end_reason: 'idle_timeout' })
    .eq('status', 'active').lt('updated_at', cutoff).select('id');
  if (error) { console.warn('[claire] idle sweep failed:', error.message); return 0; }
  if (data && data.length) console.log(`[claire] expired ${data.length} idle visit(s)`);
  return (data || []).length;
}

module.exports = { router, expireIdleSessions };
