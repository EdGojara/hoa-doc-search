// ============================================================================
// api/authorization.js  (Ed 2026-11-25: Owner Authorization Service)
// ----------------------------------------------------------------------------
// Read-only views of the shared authorization ledger (lib/authorization,
// migration 577). Owner only.
//   GET /api/authorization/events?community_id=&authorization_id=&grant_id=&limit=
//   GET /api/authorization/follow-ups?coordinator=ai-team:amanda
//       executed / failed events the coordinator has not yet reported on
//   GET /api/authorization/policy   teammates, channels and which channels may
//       authorize each sensitivity tier
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireOwner } = require('./_require_admin');
const AZ = require('../lib/authorization');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const fail = (res, what, err) => { console.error(`[authorization] ${what} failed:`, err.message); res.status(500).json({ error: safeErrorMessage(err) }); };
const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''));

router.get('/events', async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    let q = supabase.from('authorization_events').select('*').order('occurred_at', { ascending: false }).limit(limit);
    for (const k of ['community_id', 'authorization_id', 'grant_id']) if (isUuid(req.query[k])) q = q.eq(k, req.query[k]);
    if (req.query.action_type) q = q.eq('action_type', String(req.query.action_type));
    if (req.query.target_id) q = q.eq('target_id', String(req.query.target_id));
    const { data, error } = await q;
    if (error) {
      if (/authorization_events|does not exist|schema cache/i.test(error.message || '')) return res.status(409).json({ error: 'The authorization ledger needs migration 577 (pending).' });
      throw error;
    }
    res.json({ events: data || [] });
  } catch (err) { fail(res, 'events', err); }
});

router.get('/follow-ups', async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const coordinator = AZ.isTeammate(req.query.coordinator) ? String(req.query.coordinator) : AZ.COORDINATOR;
    res.json({ coordinator, follow_ups: await AZ.pendingFollowUps(supabase, { coordinator }) });
  } catch (err) { fail(res, 'follow-ups', err); }
});

router.get('/policy', async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    res.json({ teammates: AZ.TEAMMATES, coordinator: AZ.COORDINATOR, channels: AZ.CHANNELS, tier_channels: AZ.TIER_CHANNELS, read_back: AZ.READ_BACK,
      actions: Object.values(AZ.ACTIONS).map((a) => ({ type: a.type, label: a.label, executor: a.executor, tier: typeof a.tier === 'function' ? 'varies' : a.tier, executable: a.executable })) });
  } catch (err) { fail(res, 'policy', err); }
});

module.exports = router;
