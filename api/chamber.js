// ============================================================================
// api/chamber.js — CHAMBER: live board-meeting streaming to authenticated
// homeowners inside the portal. The broadcast/governance layer on top of the
// existing meeting record (meeting_agendas). trustEd owns auth-scoped viewing,
// live agenda sync, request-to-speak, executive-session cutoff, and recording
// retention; the video transport stays with a provider via an embed URL.
//
// Endpoints:
//   Moderator (staff/board):
//     POST   /broadcasts                 create a broadcast (optionally linked to an agenda)
//     GET    /broadcasts?community_id=    list
//     PATCH  /broadcasts/:id             go live / end / exec-session / advance item / recording
//     GET    /broadcasts/:id/speak       the request-to-speak queue
//     PATCH  /speak/:id                  allow / deny / mark speaking / done
//   Homeowner (authenticated viewer):
//     GET    /live?community_id=         the live (or next) meeting for the portal card
//     POST   /broadcasts/:id/speak       request to speak
//     POST   /broadcasts/:id/viewer      presence heartbeat ("attending online")
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

const VIEWER_STALE_SECONDS = 45; // presence considered offline after this

async function attendingCount(broadcastId) {
  const cutoff = new Date(Date.now() - VIEWER_STALE_SECONDS * 1000).toISOString();
  const { count } = await supabase.from('meeting_broadcast_viewers')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId).gte('last_seen_at', cutoff);
  return count || 0;
}

// Resolve the agenda items for a broadcast (from the linked meeting_agenda).
async function agendaFor(b) {
  if (!b || !b.meeting_agenda_id) return { items: [], agenda: null };
  const { data: ag } = await supabase.from('meeting_agendas')
    .select('id, title, meeting_date, meeting_time, location, items, full_text, status')
    .eq('id', b.meeting_agenda_id).maybeSingle();
  let items = [];
  if (ag && Array.isArray(ag.items)) items = ag.items.map((it) => (typeof it === 'string' ? { topic: it } : it));
  return { items, agenda: ag || null };
}

// ---- Moderator: create -----------------------------------------------------
router.post('/broadcasts', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community_id) return res.status(400).json({ error: 'community_id_required' });
    const row = {
      community_id: b.community_id,
      meeting_agenda_id: b.meeting_agenda_id || null,
      title: b.title || null,
      scheduled_at: b.scheduled_at || null,
      provider: ['zoom', 'mux', 'cloudflare', 'youtube', 'other'].includes(b.provider) ? b.provider : 'other',
      player_embed_url: b.player_embed_url || null,
      hls_url: b.hls_url || null,
      retention_policy: ['retain', 'delete_after_minutes_approved', 'delete_after_days'].includes(b.retention_policy) ? b.retention_policy : 'delete_after_minutes_approved',
      consent_notice: b.consent_notice || 'This meeting is recorded and streamed live to verified members of the association.',
      status: 'scheduled',
      created_by: b.created_by || null,
    };
    const { data, error } = await supabase.from('meeting_broadcasts').insert(row).select('*').single();
    if (error) throw error;
    res.json({ broadcast: data });
  } catch (err) {
    console.error('[chamber] create broadcast failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Moderator: list -------------------------------------------------------
router.get('/broadcasts', async (req, res) => {
  try {
    const { community_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase.from('meeting_broadcasts')
      .select('*').eq('community_id', community_id)
      .order('scheduled_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ broadcasts: data || [] });
  } catch (err) {
    console.error('[chamber] list broadcasts failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Moderator: update (go live / end / exec-session / advance / recording) -
router.patch('/broadcasts/:id', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const patch = {};
    const allowed = ['title', 'scheduled_at', 'provider', 'player_embed_url', 'hls_url', 'current_item_index', 'exec_session', 'recording_url', 'recording_available', 'retention_policy', 'consent_notice', 'meeting_agenda_id'];
    for (const k of allowed) if (k in b) patch[k] = b[k];
    // Lifecycle transitions stamp timestamps.
    if (b.status && ['scheduled', 'live', 'ended', 'canceled'].includes(b.status)) {
      patch.status = b.status;
      if (b.status === 'live') { patch.started_at = new Date().toISOString(); patch.exec_session = false; }
      if (b.status === 'ended') { patch.ended_at = new Date().toISOString(); patch.exec_session = false; }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields' });
    const { data, error } = await supabase.from('meeting_broadcasts').update(patch).eq('id', id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'broadcast_not_found' });
    res.json({ broadcast: data });
  } catch (err) {
    console.error('[chamber] update broadcast failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Homeowner: the live (or next) meeting for the portal Chamber card ------
router.get('/live', async (req, res) => {
  try {
    const { community_id, contact_id } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    // Prefer a live broadcast; else the soonest upcoming scheduled one.
    let { data: live } = await supabase.from('meeting_broadcasts')
      .select('*').eq('community_id', community_id).eq('status', 'live')
      .order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (!live) {
      const { data: up } = await supabase.from('meeting_broadcasts')
        .select('*').eq('community_id', community_id).eq('status', 'scheduled')
        .order('scheduled_at', { ascending: true, nullsFirst: false }).limit(1).maybeSingle();
      live = up || null;
    }
    if (!live) return res.json({ broadcast: null });
    const { items, agenda } = await agendaFor(live);
    const attending = live.status === 'live' ? await attendingCount(live.id) : 0;
    // The homeowner's own speak-request state, if any.
    let my_request = null;
    if (contact_id) {
      const { data: mr } = await supabase.from('meeting_speak_requests')
        .select('id, status, allotted_seconds, allowed_at').eq('broadcast_id', live.id).eq('contact_id', contact_id)
        .not('status', 'in', '(done,denied,withdrawn)').order('requested_at', { ascending: false }).limit(1).maybeSingle();
      my_request = mr || null;
    }
    // Executive session (or non-live) hides the video source entirely.
    const canWatch = live.status === 'live' && !live.exec_session;
    res.json({
      broadcast: {
        id: live.id, title: live.title || (agenda && agenda.title) || 'Board Meeting',
        status: live.status, exec_session: !!live.exec_session,
        scheduled_at: live.scheduled_at || (agenda && agenda.meeting_date) || null,
        started_at: live.started_at, current_item_index: live.current_item_index,
        provider: live.provider,
        player_embed_url: canWatch ? live.player_embed_url : null,
        hls_url: canWatch ? live.hls_url : null,
        consent_notice: live.consent_notice,
        recording_available: !!live.recording_available, recording_url: live.recording_available ? live.recording_url : null,
      },
      agenda: agenda ? { id: agenda.id, title: agenda.title, location: agenda.location, meeting_time: agenda.meeting_time } : null,
      items, attending, my_request,
    });
  } catch (err) {
    console.error('[chamber] live failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Homeowner: request to speak -------------------------------------------
router.post('/broadcasts/:id/speak', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    if (!b.display_name) return res.status(400).json({ error: 'display_name_required' });
    const { data: bc } = await supabase.from('meeting_broadcasts').select('id, community_id, status').eq('id', id).maybeSingle();
    if (!bc) return res.status(404).json({ error: 'broadcast_not_found' });
    // Don't duplicate an open request from the same person.
    if (b.contact_id) {
      const { data: existing } = await supabase.from('meeting_speak_requests')
        .select('id').eq('broadcast_id', id).eq('contact_id', b.contact_id)
        .in('status', ['requested', 'allowed', 'speaking']).maybeSingle();
      if (existing) return res.json({ request: existing, already: true });
    }
    const { data, error } = await supabase.from('meeting_speak_requests').insert({
      broadcast_id: id, community_id: bc.community_id, contact_id: b.contact_id || null,
      display_name: b.display_name, property_address: b.property_address || null, topic: b.topic || null,
    }).select('*').single();
    if (error) throw error;
    res.json({ request: data });
  } catch (err) {
    console.error('[chamber] speak request failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Moderator: the speak queue --------------------------------------------
router.get('/broadcasts/:id/speak', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('meeting_speak_requests')
      .select('*').eq('broadcast_id', id).order('requested_at', { ascending: true });
    if (error) throw error;
    res.json({ requests: data || [] });
  } catch (err) {
    console.error('[chamber] speak queue failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Moderator: allow / deny / speaking / done -----------------------------
router.patch('/speak/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const patch = {};
    if (b.status && ['requested', 'allowed', 'speaking', 'done', 'denied', 'withdrawn'].includes(b.status)) {
      patch.status = b.status;
      if (b.status === 'allowed') patch.allowed_at = new Date().toISOString();
      if (b.status === 'done') patch.ended_at = new Date().toISOString();
    }
    if (Number.isFinite(Number(b.allotted_seconds))) patch.allotted_seconds = parseInt(b.allotted_seconds, 10);
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields' });
    const { data, error } = await supabase.from('meeting_speak_requests').update(patch).eq('id', id).select('*').maybeSingle();
    if (error) throw error;
    res.json({ request: data });
  } catch (err) {
    console.error('[chamber] speak update failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Homeowner: presence heartbeat -----------------------------------------
router.post('/broadcasts/:id/viewer', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const { data: bc } = await supabase.from('meeting_broadcasts').select('id, community_id').eq('id', id).maybeSingle();
    if (!bc) return res.status(404).json({ error: 'broadcast_not_found' });
    const now = new Date().toISOString();
    if (b.contact_id) {
      await supabase.from('meeting_broadcast_viewers').upsert({
        broadcast_id: id, community_id: bc.community_id, contact_id: b.contact_id,
        display_name: b.display_name || null, last_seen_at: now,
      }, { onConflict: 'broadcast_id,contact_id' });
    }
    res.json({ attending: await attendingCount(id) });
  } catch (err) {
    console.error('[chamber] viewer heartbeat failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
