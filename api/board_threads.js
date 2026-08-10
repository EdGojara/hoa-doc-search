// =============================================================================
// Board Discussion API — secure in-platform board messaging
// =============================================================================
// Mounted at /api/board-threads. A board can talk here (per-motion or a general
// thread) instead of email/text; history is kept as an association record.
//
// AUTH reuses the board portal core: requireBoardViewer + canSeeCommunity. Read
// is open to any viewer of the community (board member or staff/admin). POST
// requires a real poster — a board member on their own session, or staff/admin.
// A staff "view as" read-only preview (acting_as) can READ but not post.
// =============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireBoardViewer, canSeeCommunity, scopeCommunityIds, boardCommunitiesForEmail } = require('../lib/portal/board_access');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const router = express.Router();
const EPOCH = '1970-01-01T00:00:00Z';

// The identity that may POST. Null when the caller may only read (the read-only
// "view as" preview).
function poster(viewer) {
  if (!viewer) return null;
  if (viewer.kind === 'staff') return { email: viewer.email, name: viewer.name || viewer.email, role: 'manager' };
  if (viewer.kind === 'board' && !viewer.acting_as) return { email: viewer.email, name: viewer.name || viewer.email, role: 'board' };
  return null;
}
function viewerEmail(viewer) { return viewer && viewer.email ? String(viewer.email).trim().toLowerCase() : null; }

async function getOrCreateGeneral(communityId, createdBy) {
  const { data } = await supabase.from('board_threads').select('*').eq('community_id', communityId).eq('kind', 'general').maybeSingle();
  if (data) return data;
  const { data: created, error } = await supabase.from('board_threads')
    .insert({ management_company_id: BEDROCK_MGMT_CO_ID, community_id: communityId, kind: 'general', title: 'Board discussion', created_by: createdBy || null })
    .select('*').single();
  if (error) { const { data: again } = await supabase.from('board_threads').select('*').eq('community_id', communityId).eq('kind', 'general').maybeSingle(); return again; }
  return created;
}
async function getOrCreateMotionThread(motion, createdBy) {
  const { data } = await supabase.from('board_threads').select('*').eq('motion_id', motion.id).eq('kind', 'motion').maybeSingle();
  if (data) return data;
  const { data: created, error } = await supabase.from('board_threads')
    .insert({ management_company_id: BEDROCK_MGMT_CO_ID, community_id: motion.community_id, kind: 'motion', motion_id: motion.id, title: motion.title, created_by: createdBy || null })
    .select('*').single();
  if (error) { const { data: again } = await supabase.from('board_threads').select('*').eq('motion_id', motion.id).eq('kind', 'motion').maybeSingle(); return again; }
  return created;
}

// Unread = messages after the reader's cursor, not authored by them.
async function unreadCount(threadId, email) {
  if (!email) return 0;
  const { data: r } = await supabase.from('board_thread_reads').select('last_read_at').eq('thread_id', threadId).eq('reader_email', email).maybeSingle();
  const since = r ? r.last_read_at : EPOCH;
  const { count } = await supabase.from('board_messages')
    .select('id', { count: 'exact', head: true })
    .eq('thread_id', threadId).gt('created_at', since).neq('author_email', email);
  return count || 0;
}
async function markRead(threadId, email) {
  if (!email) return;
  try { await supabase.from('board_thread_reads').upsert({ thread_id: threadId, reader_email: email, last_read_at: new Date().toISOString() }, { onConflict: 'thread_id,reader_email' }); } catch (_) {}
}

async function loadThreadAuthorized(req, res, viewer) {
  const { data: thread, error } = await supabase.from('board_threads').select('*').eq('id', req.params.threadId).maybeSingle();
  if (error) throw error;
  if (!thread) { res.status(404).json({ error: 'thread_not_found' }); return null; }
  if (!canSeeCommunity(viewer, thread.community_id)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return thread;
}

// ---------------------------------------------------------------------------
// GET /api/board-threads/community/:id/threads
//   The general thread + every motion thread for a community, with unread.
// ---------------------------------------------------------------------------
router.get('/community/:id/threads', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden' });
    const general = await getOrCreateGeneral(communityId, poster(viewer)?.email);
    const { data: threads, error } = await supabase.from('board_threads')
      .select('*').eq('community_id', communityId).order('last_message_at', { ascending: false, nullsFirst: false }).limit(300);
    if (error) throw error;
    const email = viewerEmail(viewer);
    const out = [];
    for (const t of (threads || [])) out.push({ ...t, unread: await unreadCount(t.id, email) });
    res.json({ general_thread_id: general ? general.id : null, threads: out, can_post: !!poster(viewer) });
  } catch (err) {
    console.error('[board_threads] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/board-threads/community/:id/general — open (create) the general thread.
router.get('/community/:id/general', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    if (!canSeeCommunity(viewer, req.params.id)) return res.status(403).json({ error: 'forbidden' });
    const t = await getOrCreateGeneral(req.params.id, poster(viewer)?.email);
    if (!t) return res.status(500).json({ error: 'thread_unavailable' });
    return sendThread(res, viewer, t);
  } catch (err) { console.error('[board_threads] general failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /api/board-threads/motion/:motionId — open (create) the motion thread.
router.get('/motion/:motionId', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const { data: motion, error } = await supabase.from('board_motions').select('id, community_id, title').eq('id', req.params.motionId).maybeSingle();
    if (error) throw error;
    if (!motion) return res.status(404).json({ error: 'motion_not_found' });
    if (!canSeeCommunity(viewer, motion.community_id)) return res.status(403).json({ error: 'forbidden' });
    const t = await getOrCreateMotionThread(motion, poster(viewer)?.email);
    if (!t) return res.status(500).json({ error: 'thread_unavailable' });
    return sendThread(res, viewer, t);
  } catch (err) { console.error('[board_threads] motion thread failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /api/board-threads/thread/:threadId — messages; marks read for the viewer.
router.get('/thread/:threadId', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const thread = await loadThreadAuthorized(req, res, viewer);
    if (!thread) return;
    return sendThread(res, viewer, thread);
  } catch (err) { console.error('[board_threads] thread failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

async function sendThread(res, viewer, thread) {
  const { data: messages, error } = await supabase.from('board_messages')
    .select('id, author_email, author_name, author_role, body, created_at')
    .eq('thread_id', thread.id).order('created_at', { ascending: true }).limit(1000);
  if (error) throw error;
  const email = viewerEmail(viewer);
  await markRead(thread.id, email);
  res.json({ thread, messages: messages || [], can_post: !!poster(viewer), my_email: email });
}

// ---------------------------------------------------------------------------
// POST /api/board-threads/thread/:threadId/messages   — post a message
// ---------------------------------------------------------------------------
router.post('/thread/:threadId/messages', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const thread = await loadThreadAuthorized(req, res, viewer);
    if (!thread) return;
    const who = poster(viewer);
    if (!who) return res.status(403).json({ error: 'read_only_preview', message: 'Exit the board-member preview to post.' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'empty' });

    const { data: msg, error } = await supabase.from('board_messages').insert({
      thread_id: thread.id, community_id: thread.community_id,
      author_email: String(who.email).trim().toLowerCase(), author_name: who.name, author_role: who.role, body,
    }).select('id, author_email, author_name, author_role, body, created_at').single();
    if (error) throw error;

    const nowIso = new Date().toISOString();
    await supabase.from('board_threads').update({ last_message_at: nowIso, message_count: (thread.message_count || 0) + 1 }).eq('id', thread.id);
    await markRead(thread.id, String(who.email).trim().toLowerCase()); // author has read their own
    res.json({ ok: true, message: msg });
  } catch (err) {
    console.error('[board_threads] post failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/board-threads/unread — total unread for the viewer across the
//   communities they can see (drives the portal badge + admin oversight).
// ---------------------------------------------------------------------------
router.get('/unread', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const email = viewerEmail(viewer);
    const scope = scopeCommunityIds(viewer);
    let q = supabase.from('board_threads').select('id, community_id');
    if (scope !== 'all') { if (!scope.length) return res.json({ unread: 0, by_community: {} }); q = q.in('community_id', scope); }
    const { data: threads, error } = await q.limit(2000);
    if (error) throw error;
    let total = 0; const byCommunity = {};
    for (const t of (threads || [])) {
      const u = await unreadCount(t.id, email);
      if (u) { total += u; byCommunity[t.community_id] = (byCommunity[t.community_id] || 0) + u; }
    }
    res.json({ unread: total, by_community: byCommunity });
  } catch (err) { console.error('[board_threads] unread failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---------------------------------------------------------------------------
// POST /api/board-threads/send-digests — the once-a-day quiet digest. Staff;
//   also schedulable. No-ops (records nothing) while BOARD_NOTIFY_ENABLED is off.
// ---------------------------------------------------------------------------
router.post('/send-digests', express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    if (viewer.kind !== 'staff') return res.status(403).json({ error: 'staff_only' });
    const { sendBoardDigests } = require('../lib/board/discussion_digest'); // lazy → no load cycle
    const stats = await sendBoardDigests({ windowHours: 20 });
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('[board_threads] send-digests failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router, unreadCount, getOrCreateGeneral };
