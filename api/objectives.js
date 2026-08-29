// ============================================================================
// api/objectives.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The operator board. Objectives are what makes the team an operator, not a
// system of record: goals the team is actively driving to closure. This surface
// lets a human see every open objective, its state and next step, what has gone
// stale, and the timeline — and drive a stalled one (the persona proposes the
// next action; nothing sends). Staff-gated.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const O = require('../lib/team/objectives');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
function safe(err) { try { return require('./_safe_error').safeErrorMessage(err); } catch (_) { return 'Something went wrong'; } }
function _missing(err) { const m = `${err && err.message || ''} ${err && err.code || ''}`; return /could not find|does not exist|42P01|PGRST20[45]|schema cache/i.test(m); }

// The board: open objectives with their state, plus which are stalled.
router.get('/', async (req, res) => {
  try {
    let q = supabase.from('objectives').select('*').in('status', O.OPEN_STATUSES).order('last_activity_at', { ascending: true }).limit(500);
    if (req.query.communityId) q = q.eq('community_id', req.query.communityId);
    const { data, error } = await q;
    if (error) { if (_missing(error)) return res.json({ ok: true, notReady: true, objectives: [] }); throw error; }
    const now = Date.now();
    const objectives = (data || []).map((o) => ({
      ...o,
      stalled: (o.next_action_due && new Date(o.next_action_due).getTime() < now)
        || (o.last_activity_at && (now - new Date(o.last_activity_at).getTime()) > 72 * 3600 * 1000),
    }));
    res.json({ ok: true, objectives });
  } catch (err) { console.error('[objectives] list failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('objectives').select('*').eq('id', req.params.id).limit(1);
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'not_found' });
    const events = await O.objectiveEvents(supabase, req.params.id);
    res.json({ ok: true, objective: data[0], events });
  } catch (err) { console.error('[objectives] get failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

// Open an objective from a message (or by hand). Safe — it only creates the
// tracking record; it sends nothing.
router.post('/open', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title_required' });
    const o = await O.openObjective(supabase, {
      communityId: b.communityId, title: b.title, goal: b.goal, objectiveType: b.objectiveType,
      ownerPersona: b.ownerPersona, residentEmail: b.residentEmail, contactId: b.contactId,
      propertyId: b.propertyId, conversationId: b.conversationId, nextAction: b.nextAction,
      nextActionDue: b.nextActionDue, sourceMessageId: b.sourceMessageId, status: b.status,
    });
    if (!o) return res.status(409).json({ error: 'Objectives table not set up yet — apply migration 399.' });
    res.json({ ok: true, objective: o });
  } catch (err) { console.error('[objectives] open failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

router.post('/:id/advance', async (req, res) => {
  try {
    const b = req.body || {};
    const o = await O.advanceObjective(supabase, req.params.id, { status: b.status, nextAction: b.nextAction, nextActionDue: b.nextActionDue, actor: b.actor || 'human', note: b.note });
    res.json({ ok: true, objective: o });
  } catch (err) { console.error('[objectives] advance failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

router.post('/:id/close', async (req, res) => {
  try {
    const o = await O.closeObjective(supabase, req.params.id, { reason: (req.body || {}).reason, actor: (req.body || {}).actor || 'human' });
    res.json({ ok: true, objective: o });
  } catch (err) { console.error('[objectives] close failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

// The anti-ghosting loop: what has gone stale and needs a next step. This is the
// difference from Vantaca — the system revisits its own open work instead of
// waiting for a human to remember.
router.get('/stalled/list', async (req, res) => {
  try {
    const stalled = await O.findStalled(supabase, { staleHours: parseInt(req.query.staleHours, 10) || 72, communityId: req.query.communityId });
    res.json({ ok: true, stalled });
  } catch (err) { console.error('[objectives] stalled failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

module.exports = router;
