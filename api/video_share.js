// ============================================================================
// api/video_share.js  (Ed 2026-09-13)
// ----------------------------------------------------------------------------
// Quick, private, revocable video links for demoing the AI team (or a one-off
// message like Priya in Hindi for a single resident). Ed uploads a mini video,
// gets ONE unguessable link, sends it, and takes it down when done.
//
// The file lives in a PRIVATE 'videos' bucket. The public watch route mints a
// short-lived signed playback URL on each view, so "take down" (active=false)
// truly revokes access: no new playback URL is ever issued after that.
//
//   Admin (requireAdmin):
//     GET    /api/video-share/list                list every share, newest first
//     POST   /api/video-share/create              start one; returns a signed UPLOAD url
//     POST   /api/video-share/:token/finalize     mark upload complete (uploaded=true)
//     POST   /api/video-share/:token/takedown     active=false (link goes dead)
//     POST   /api/video-share/:token/restore      active=true
//     DELETE /api/video-share/:token              delete file + row (permanent)
//
//   Public (no auth) — the recipient with the link:
//     GET    /api/video-share/play/:token         metadata + short-lived play url
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const heygen = require('../lib/video/heygen');
const roster = require('../lib/team/roster');
const QRCode = require('qrcode');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

const BUCKET = 'videos';
const PLAY_TTL = 60 * 60 * 4;   // signed playback URL good for 4 hours per view
// Where a prospect's "get in touch" goes on a demo video: Maggie Sullivan, our
// BD / Director of Growth (Ed 2026-09-13). Pulled from the one mailbox constant
// so it can't drift; overridable per deployment.
let MAGGIE_MAILBOX = 'maggie@bedrocktx.com';
try { MAGGIE_MAILBOX = require('../lib/email/graph_send').MAGGIE_MAILBOX || MAGGIE_MAILBOX; } catch (_) {}
const CTA_EMAIL = process.env.DEMO_CTA_EMAIL || MAGGIE_MAILBOX;
const CTA_PHONE = process.env.DEMO_CTA_PHONE || '(832) 588-2485';

// Friendly display name for the featured teammate, straight off the one roster.
function personaName(persona) {
  if (!persona) return null;
  try { const m = require('../lib/team/roster').get(persona); if (m) return m.name; } catch (_) {}
  return null;
}

const safeName = (s) => String(s || 'video').replace(/[^\w.-]+/g, '_').slice(-80) || 'video';

// ---- Admin: list --------------------------------------------------------
router.get('/list', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { data, error } = await supabase
      .from('video_shares')
      .select('token, title, recipient_name, persona, community_id, content_type, file_size, uploaded, active, view_count, last_viewed_at, created_at, demo, caption, source, render_status, render_error')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    const rows = (data || []).map((r) => ({ ...r, persona_name: personaName(r.persona) }));
    res.json({ videos: rows });
  } catch (err) {
    console.error('[video-share] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Admin: the AI teammates you can feature (from the one roster) ------
router.get('/personas', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const people = require('../lib/team/roster').people();
    // Front-office + specialist faces a resident/prospect would meet; skip the
    // owner-only and internal-ops people.
    const list = people
      .filter((m) => m.persona && m.name && !m.owner_only && m.tier !== 'internal_ops')
      .map((m) => ({ persona: m.persona, name: m.name, title: m.title || '' }));
    res.json({ personas: list });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Admin: create (returns a signed upload URL) ------------------------
router.post('/create', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { title, recipient_name, persona, community_id, filename, content_type, demo, caption } = req.body || {};
    if (!content_type || !/^video\//.test(String(content_type))) {
      return res.status(400).json({ error: 'video_file_required', detail: 'Pick a video file.' });
    }
    const token = crypto.randomBytes(16).toString('hex');       // 32 chars, unguessable
    const storage_path = `${token}/${safeName(filename)}`;

    const { data: signed, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(storage_path);
    if (sErr) throw sErr;

    const { error: iErr } = await supabase.from('video_shares').insert({
      token, title: title || null, recipient_name: recipient_name || null,
      persona: persona || null, community_id: community_id || null,
      storage_path, content_type, uploaded: false, active: true,
      demo: !!demo, caption: (caption && String(caption).trim()) || null,
      created_by: admin.email || admin.full_name || null,
    });
    if (iErr) throw iErr;

    // signed.token is the ONE-TIME upload token the browser passes to
    // uploadToSignedUrl(path, token, file). Distinct from our share token.
    res.json({ token, path: storage_path, uploadToken: signed.token, signedUrl: signed.signedUrl });
  } catch (err) {
    console.error('[video-share] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Admin: finalize (browser finished the direct upload) ---------------
router.post('/:token/finalize', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { file_size } = req.body || {};
    const { data, error } = await supabase.from('video_shares')
      .update({ uploaded: true, file_size: file_size || null })
      .eq('token', req.params.token).select('token').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[video-share] finalize failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Admin: take down / restore ----------------------------------------
async function setActive(req, res, active) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { data, error } = await supabase.from('video_shares')
      .update({ active }).eq('token', req.params.token).select('token').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, active });
  } catch (err) {
    console.error('[video-share] setActive failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
}
router.post('/:token/takedown', (req, res) => setActive(req, res, false));
router.post('/:token/restore', (req, res) => setActive(req, res, true));

// ---- Admin: delete (permanent) -----------------------------------------
router.delete('/:token', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { data: row, error } = await supabase.from('video_shares')
      .select('storage_path').eq('token', req.params.token).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'not_found' });
    try { await supabase.storage.from(BUCKET).remove([row.storage_path]); } catch (e) { console.warn('[video-share] file remove:', e.message); }
    await supabase.from('video_shares').delete().eq('token', req.params.token);
    res.json({ ok: true });
  } catch (err) {
    console.error('[video-share] delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Admin: GENERATE a video from a script (HeyGen), kept private -------
// Reuses the SAME render pipeline as the explainer library (heygen.renderExplainer
// + videoStatus), but the finished mp4 lands in the PRIVATE videos bucket and
// becomes a one-off private link, not a public explainer.
router.post('/generate', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const { script, persona, title, recipient_name, demo, caption } = req.body || {};
    if (!script || !String(script).trim()) return res.status(400).json({ error: 'script_required', detail: 'Write what the teammate should say.' });
    if (!heygen.heygenEnabled()) return res.status(503).json({ error: 'heygen_not_configured', detail: 'Video generation is not turned on.' });
    const who = String(persona || '').trim();
    const m = roster.get(who);
    if (!who || !m) return res.status(400).json({ error: 'persona_required', detail: 'Pick which teammate is speaking.' });
    if (!heygen.avatarIdFor(who)) return res.status(400).json({ error: 'no_avatar', detail: `${m.name || who} has no video avatar configured yet.` });

    // The teammate's own language (Priya = Hindi), so the script and the render
    // can never disagree. Falls back to English for the general front office.
    const lang = ['en', 'es', 'zh', 'hi'].includes(m.language) ? m.language : 'en';
    const token = crypto.randomBytes(16).toString('hex');
    const storage_path = `${token}/generated.mp4`;

    let videoId;
    try {
      videoId = await heygen.renderExplainer({ script: String(script).trim(), language: lang, persona: who, title: title || null });
    } catch (e) {
      return res.status(502).json({ error: safeErrorMessage(e) });
    }

    const { error: iErr } = await supabase.from('video_shares').insert({
      token, title: title || null, recipient_name: recipient_name || null,
      persona: who, storage_path, content_type: 'video/mp4',
      source: 'generated', provider_video_id: videoId, render_status: 'rendering',
      language: lang, script: String(script).trim(),
      demo: !!demo, caption: (caption && String(caption).trim()) || null,
      uploaded: false, active: true,
      created_by: admin.email || admin.full_name || null,
    });
    if (iErr) throw iErr;
    res.json({ token, render_status: 'rendering' });
  } catch (err) {
    console.error('[video-share] generate failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Poll a generation. When HeyGen reports done, copy the mp4 into the PRIVATE
// bucket (the provider URL expires), then mark it uploaded + ready.
router.get('/generate-status/:token', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { data: row, error } = await supabase.from('video_shares')
      .select('token, storage_path, provider_video_id, render_status, uploaded')
      .eq('token', req.params.token).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.render_status !== 'rendering' || !row.provider_video_id) {
      return res.json({ render_status: row.render_status, uploaded: row.uploaded });
    }

    const st = await heygen.videoStatus(row.provider_video_id);
    if (st.status === 'completed' && st.video_url) {
      let bytes = 0;
      try {
        const r = await fetch(st.video_url);
        if (!r.ok) throw new Error(`provider fetch ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) throw new Error('provider returned an empty file');
        bytes = buf.length;
        const { error: upErr } = await supabase.storage.from(BUCKET)
          .upload(row.storage_path, buf, { contentType: 'video/mp4', upsert: true });
        if (upErr) throw upErr;
      } catch (copyErr) {
        // Rendered but not copied yet; stay 'rendering' so the next poll retries
        // while the provider link is still alive.
        return res.json({ render_status: 'rendering', note: 'finishing' });
      }
      await supabase.from('video_shares').update({
        render_status: 'ready', uploaded: true, file_size: bytes,
        duration_seconds: st.duration || null,
      }).eq('token', row.token);
      return res.json({ render_status: 'ready', uploaded: true });
    }
    if (st.status === 'failed') {
      await supabase.from('video_shares').update({ render_status: 'failed', render_error: (st.error || 'render failed').slice(0, 500) }).eq('token', row.token);
      return res.json({ render_status: 'failed', error: st.error || 'render failed' });
    }
    res.json({ render_status: 'rendering' });
  } catch (err) {
    console.error('[video-share] generate-status failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Public: QR code for a link (scan to open, no typing/photographing) -
// Public like the BD card QR: it only encodes the shareable /v/ URL, which is
// not sensitive, and an <img> tag can't send an auth header. Encodes the URL
// as given without a DB lookup, so it reveals nothing about whether a video
// exists.
router.get('/:token/qr.svg', async (req, res) => {
  try {
    const token = String(req.params.token || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
    const base = process.env.TRUSTED_URL || (req.protocol + '://' + req.get('host'));
    const url = `${base.replace(/\/$/, '')}/v/${token}`;
    const svg = await QRCode.toString(url, {
      type: 'svg', errorCorrectionLevel: 'H', margin: 1,
      color: { dark: '#0B1D34', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(svg);
  } catch (err) {
    console.error('[video-share] qr failed:', err.message);
    return res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---- Public: play (the recipient with the link) ------------------------
router.get('/play/:token', async (req, res) => {
  try {
    const { data: row, error } = await supabase.from('video_shares')
      .select('token, title, recipient_name, persona, community_id, storage_path, content_type, uploaded, active, view_count, demo, caption')
      .eq('token', req.params.token).maybeSingle();
    if (error) throw error;
    // One shape for every "can't play" case so the token can't be probed for
    // whether a given video ever existed.
    if (!row || !row.uploaded || !row.active) return res.status(410).json({ gone: true });

    const { data: signed, error: pErr } = await supabase.storage
      .from(BUCKET).createSignedUrl(row.storage_path, PLAY_TTL);
    if (pErr || !signed) return res.status(410).json({ gone: true });

    let communityName = null;
    if (row.community_id) {
      try { const { data: c } = await supabase.from('communities').select('name').eq('id', row.community_id).maybeSingle(); communityName = c && c.name; } catch (_) {}
    }

    // Best-effort view metering; never blocks playback.
    try {
      await supabase.from('video_shares')
        .update({ view_count: (row.view_count || 0) + 1, last_viewed_at: new Date().toISOString() })
        .eq('token', row.token);
    } catch (_) {}

    res.json({
      title: row.title || null,
      recipient_name: row.recipient_name || null,
      persona: row.persona || null,
      persona_name: personaName(row.persona),
      community: communityName,
      content_type: row.content_type || 'video/mp4',
      play_url: signed.signedUrl,
      caption: row.caption || null,
      // The soft call-to-action is shown only on videos flagged as a demo, so a
      // resident's personal message never carries a sales prompt.
      cta: row.demo ? { email: CTA_EMAIL, phone: CTA_PHONE } : null,
    });
  } catch (err) {
    console.error('[video-share] play failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
