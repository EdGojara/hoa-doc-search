// ============================================================================
// api/amanda.js  (Issue #29 Phase 2A) — the in-app door to the Amanda request contract
// ----------------------------------------------------------------------------
// POST /api/amanda/request  { text, community_id?, refs?: {kind,id}, objective_id? }
// Admin-gated (same audience as the Amanda Operations card). The actor is the
// signed-in session user; any actor/name in the body is ignored. Proposals only:
// lib/amanda/request.js never executes a domain action. A small per-user rate
// limit bounds model spend (at most one model call per request anyway).
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { handleRequest } = require('../lib/amanda/request');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));
let _sb = null;
const sb = () => (_sb || (_sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)));

const WINDOW_MS = 10 * 60 * 1000; const MAX_PER_WINDOW = 30;
const hits = new Map();
function rateLimited(key, now = Date.now()) {
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}

router.post('/request', async (req, res) => {
  const u = await requireAdmin(req, res); if (!u) return;
  const actor = { email: u.email, name: u.full_name || null };
  if (rateLimited(actor.email)) return res.status(429).json({ ok: false, error: 'rate_limited', reply: 'Give Amanda a few minutes; too many requests in a row.' });
  const b = req.body || {};
  try {
    const Anthropic = require('../lib/ai/anthropic');
    const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
    const out = await handleRequest({ channel: 'app', actor, text: b.text, community_id: b.community_id, refs: b.refs, objective_id: b.objective_id }, { supabase: sb(), anthropic });
    console.log('[amanda.request]', JSON.stringify({ actor: actor.email, intent: out.intent, durable: out.durable, objective: out.objective && out.objective.id, model_calls: out.model_calls, ok: out.ok, error: out.error || null }));
    // tracking_failed is a real failure (work was NOT accepted), so it is a non-2xx with the plain-text reason in the body
    const status = out.ok ? 200 : out.error === 'empty' || out.error === 'too_long' ? 400 : out.error === 'tracking_failed' ? 409 : 200;
    res.status(status).json(out);
  } catch (e) {
    console.error('[amanda.request] failed:', e.message);
    res.status(500).json({ ok: false, error: safeErrorMessage(e) });
  }
});

module.exports = router;
