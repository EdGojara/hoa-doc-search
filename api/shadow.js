// ============================================================================
// api/shadow.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The shadow-mode surface: run trained personas against real inbound mail (send
// nothing) and read the per-lane scoreboard. This is how a persona earns its
// go-live — you watch it match the desk on real mail before flipping it from
// propose to execute. Staff-gated; nothing here sends.
//
// COST NOTE: POST /run fires one grounded model call per message shadowed (plus
// the persona's usual grounding reads), so it is on-demand and capped, never
// inline on the live ingest path.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { runShadowForEmail } = require('../lib/team/shadow');
const { fetchAll } = require('../lib/db/fetch_all');
const { requireAdmin } = require('./_require_admin');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MGMT = '00000000-0000-0000-0000-000000000001';
function safe(err) { try { return require('./_safe_error').safeErrorMessage(err); } catch (_) { return 'Something went wrong'; } }
function _isMissingTable(err) {
  const m = `${err && err.message || ''} ${err && err.code || ''}`;
  return /could not find|does not exist|42P01|PGRST20[45]|schema cache/i.test(m);
}

// Replay recent real inbound through the personas and record what each would do.
// body: { limit=25, communityId?, personas?:[...] }  (limit hard-capped at 100)
router.post('/run', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.body && req.body.limit, 10) || 25, 1), 100);
    const communityId = (req.body && req.body.communityId) || null;

    // Cheap existence probe FIRST — never fire a batch of model calls (real $)
    // against a table that isn't there yet.
    const probe = await supabase.from('shadow_drafts').select('id').limit(1);
    if (probe.error && _isMissingTable(probe.error)) {
      return res.status(409).json({ error: 'Shadow table not set up yet — apply migration 396 in the Supabase SQL editor and refresh.' });
    }

    let q = supabase.from('email_messages')
      .select('id, internet_message_id, subject, body_full, body_preview, sender_name, sender_email, classification, community_id, resolved_property_id, received_at')
      .eq('direction', 'inbound')
      .not('community_id', 'is', null)     // need a community to ground against
      .order('received_at', { ascending: false })
      .limit(limit);
    if (communityId) q = q.eq('community_id', communityId);
    const { data: rows, error } = await q;
    if (error) throw error;

    // resolve community names once
    const cids = [...new Set((rows || []).map((r) => r.community_id).filter(Boolean))];
    const nameById = {};
    if (cids.length) {
      const cm = await supabase.from('communities').select('id, name').in('id', cids);
      if (!cm.error) for (const c of cm.data) nameById[c.id] = c.name;
    }

    const byPersona = {};
    let recorded = 0, skipped = 0, errored = 0;
    // sequential: keeps model load gentle and the run predictable
    for (const row of (rows || [])) {
      const out = await runShadowForEmail(supabase, row, { communityName: nameById[row.community_id] || null });
      const p = out.persona || 'unknown';
      byPersona[p] = byPersona[p] || { recorded: 0, skipped: 0, error: 0 };
      if (out.status === 'recorded') { recorded++; byPersona[p].recorded++; }
      else if (out.status === 'skipped' || out.status === 'exists') { skipped++; byPersona[p].skipped++; }
      else { errored++; byPersona[p].error++; }
    }
    res.json({ ok: true, scanned: (rows || []).length, recorded, skipped, errored, byPersona });
  } catch (err) {
    console.error('[shadow] run failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// Per-lane scoreboard: volume, disposition mix, grounded/reserved rates, and the
// most common escalation reasons. This is the "who is ready to go live" view.
router.get('/summary', async (req, res) => {
  try {
    // Paginate via the sanctioned helper — a plain .limit(10000) is silently
    // capped at 1000 by PostgREST and would undercount at scale (truncation scar).
    let data;
    try {
      data = await fetchAll(supabase, 'shadow_drafts', {
        select: 'persona, disposition, confidence, grounded, reserved_gate, escalation_reasons, ed_rating, created_at',
        orderBy: 'created_at',
      });
    } catch (error) {
      if (_isMissingTable(error)) return res.json({ ok: true, notReady: true, lastRun: null, total: 0, lanes: [] });
      throw error;
    }

    const lanes = {};
    let lastRun = null;
    for (const r of (data || [])) {
      const L = lanes[r.persona] || (lanes[r.persona] = {
        persona: r.persona, total: 0, auto_ok: 0, needs_review: 0,
        conf: { high: 0, medium: 0, low: 0 }, grounded: 0, reserved: 0, reasons: {},
        graded: 0, meets_bar: 0, needs_work: 0,   // the Ed benchmark
      });
      L.total++;
      if (r.disposition === 'auto_ok') L.auto_ok++; else if (r.disposition === 'needs_review') L.needs_review++;
      if (r.confidence && L.conf[r.confidence] != null) L.conf[r.confidence]++;
      if (r.grounded) L.grounded++;
      if (r.reserved_gate) L.reserved++;
      if (r.ed_rating) { L.graded++; if (r.ed_rating === 'meets_bar') L.meets_bar++; else if (r.ed_rating === 'needs_work') L.needs_work++; }
      for (const reason of (r.escalation_reasons || [])) L.reasons[reason] = (L.reasons[reason] || 0) + 1;
      if (!lastRun || (r.created_at && r.created_at > lastRun)) lastRun = r.created_at;
    }
    const lanesOut = Object.values(lanes).map((L) => ({
      ...L,
      // THE go-live metric: does it meet Ed's bar (only counts graded drafts).
      meets_bar_rate: L.graded ? Math.round((L.meets_bar / L.graded) * 100) : null,
      auto_ok_rate: L.total ? Math.round((L.auto_ok / L.total) * 100) : 0,
      grounded_rate: L.total ? Math.round((L.grounded / L.total) * 100) : 0,
      top_reasons: Object.entries(L.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ reason: k, n })),
    })).sort((a, b) => b.total - a.total);

    res.json({ ok: true, lastRun, total: (data || []).length, lanes: lanesOut });
  } catch (err) {
    console.error('[shadow] summary failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// The grading queue: ungraded shadow drafts, each paired with the real inbound
// message and — as CONTRAST, never the benchmark — what the staff actually sent
// on that thread. Ed grades these against HIS bar. Staff-viewable; only the
// rating (POST /rate) is owner-gated.
async function staffReplyFor(row) {
  if (!row) return null;
  // the human's actual reply = an outbound message on the same conversation
  const src = await supabase.from('email_messages')
    .select('conversation_id, received_at').eq('id', row.source_email_id).limit(1);
  if (src.error || !src.data || !src.data.length || !src.data[0].conversation_id) return null;
  const conv = src.data[0].conversation_id;
  const out = await supabase.from('email_messages')
    .select('body_full, body_preview, sent_at, received_at').eq('conversation_id', conv)
    .eq('direction', 'outbound').order('sent_at', { ascending: true }).limit(1);
  if (out.error || !out.data || !out.data.length) return null;
  const m = out.data[0];
  return { text: m.body_full || m.body_preview || '', at: m.sent_at || m.received_at || null };
}

router.get('/to-grade', async (req, res) => {
  try {
    const persona = req.query.persona || null;
    let q = supabase.from('shadow_drafts')
      .select('id, persona, community_id, source_email_id, subject, sender_email, audience, disposition, confidence, disposition_reason, grounded, reserved_gate, reserved_reason, escalation_reasons, body_text, created_at')
      .is('ed_rating', null).order('created_at', { ascending: false })
      .limit(Math.min(parseInt(req.query.limit, 10) || 12, 40));
    if (persona) q = q.eq('persona', persona);
    const { data, error } = await q;
    if (error) {
      if (_isMissingTable(error)) return res.json({ ok: true, notReady: true, items: [] });
      throw error;
    }
    // attach the real inbound body + the staff contrast for each
    const items = [];
    for (const d of (data || [])) {
      let inbound = null;
      const em = await supabase.from('email_messages')
        .select('subject, body_full, body_preview, sender_name, sender_email, received_at').eq('id', d.source_email_id).limit(1);
      if (!em.error && em.data && em.data.length) {
        const e = em.data[0];
        inbound = { subject: e.subject, body: e.body_full || e.body_preview || '', sender_name: e.sender_name, sender_email: e.sender_email, received_at: e.received_at };
      }
      const staff = await staffReplyFor(d);
      items.push({ ...d, inbound, staff });
    }
    res.json({ ok: true, items });
  } catch (err) {
    console.error('[shadow] to-grade failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// Grade a draft against Ed's bar. OWNER-GATED on purpose: the whole point is
// that the benchmark is Ed's judgment, not any staffer's. rating is required;
// note is why it missed; rewrite is Ed's own version (the gold training signal).
router.post('/rate', async (req, res) => {
  try {
    const ed = await requireAdmin(req, res); if (!ed) return; // 403 already sent
    const { id, rating, note, rewrite } = req.body || {};
    if (!id || !['meets_bar', 'needs_work'].includes(rating)) {
      return res.status(400).json({ error: 'id_and_valid_rating_required' });
    }
    // snapshot the staff contrast at grade time so the graded record is self-contained
    const cur = await supabase.from('shadow_drafts').select('id, source_email_id').eq('id', id).limit(1);
    if (cur.error) throw cur.error;
    if (!cur.data || !cur.data.length) return res.status(404).json({ error: 'not_found' });
    const staff = await staffReplyFor(cur.data[0]);

    const patch = {
      ed_rating: rating, ed_note: note || null, ed_rewrite: rewrite || null,
      ed_rated_at: new Date().toISOString(), ed_rated_by: ed.full_name || ed.email || 'owner',
      staff_reply_text: staff ? staff.text : null, staff_reply_at: staff ? staff.at : null,
    };
    const { error } = await supabase.from('shadow_drafts').update(patch).eq('id', id);
    if (error) throw error;
    res.json({ ok: true, id, rating });
  } catch (err) {
    console.error('[shadow] rate failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

// Recent shadow drafts for a lane, to eyeball what it actually wrote.
router.get('/samples', async (req, res) => {
  try {
    const persona = req.query.persona;
    let q = supabase.from('shadow_drafts')
      .select('id, persona, subject, sender_email, audience, disposition, confidence, disposition_reason, grounded, reserved_gate, reserved_reason, escalation_reasons, body_text, created_at')
      .order('created_at', { ascending: false }).limit(Math.min(parseInt(req.query.limit, 10) || 15, 50));
    if (persona) q = q.eq('persona', persona);
    const { data, error } = await q;
    if (error) {
      if (_isMissingTable(error)) return res.json({ ok: true, notReady: true, samples: [] });
      throw error;
    }
    res.json({ ok: true, samples: data || [] });
  } catch (err) {
    console.error('[shadow] samples failed:', err.message);
    res.status(500).json({ error: safe(err) });
  }
});

module.exports = router;
