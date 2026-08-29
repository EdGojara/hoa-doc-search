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
        select: 'persona, disposition, confidence, grounded, reserved_gate, escalation_reasons, created_at',
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
      });
      L.total++;
      if (r.disposition === 'auto_ok') L.auto_ok++; else if (r.disposition === 'needs_review') L.needs_review++;
      if (r.confidence && L.conf[r.confidence] != null) L.conf[r.confidence]++;
      if (r.grounded) L.grounded++;
      if (r.reserved_gate) L.reserved++;
      for (const reason of (r.escalation_reasons || [])) L.reasons[reason] = (L.reasons[reason] || 0) + 1;
      if (!lastRun || (r.created_at && r.created_at > lastRun)) lastRun = r.created_at;
    }
    const lanesOut = Object.values(lanes).map((L) => ({
      ...L,
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
