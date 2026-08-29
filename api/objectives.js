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
const R = require('../lib/team/reconcile');

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

// The decision ledger for one objective (the reconciliation trail).
router.get('/:id/decisions', async (req, res) => {
  try {
    const { data, error } = await supabase.from('objective_decisions').select('*').eq('objective_id', req.params.id).order('created_at', { ascending: false }).limit(50);
    if (error) { if (_missing(error)) return res.json({ ok: true, notReady: true, decisions: [] }); throw error; }
    res.json({ ok: true, decisions: data || [] });
  } catch (err) { console.error('[objectives] decisions failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

// Reconcile from a real inbound message (dark). Builds the event from the message
// and attaches/opens + reconciles the affected objectives. On-demand only — this
// is where a model call may happen, and only when there's something new.
router.post('/reconcile-event', async (req, res) => {
  try {
    const messageId = (req.body || {}).messageId;
    if (!messageId) return res.status(400).json({ error: 'messageId_required' });
    const em = await supabase.from('email_messages')
      .select('id, community_id, sender_email, resolved_contact_id, resolved_property_id, subject, ai_summary, body_preview')
      .eq('id', messageId).limit(1);
    if (em.error) throw em.error;
    if (!em.data || !em.data.length) return res.status(404).json({ error: 'message_not_found' });
    const m = em.data[0];
    const out = await R.reconcileForEvent(supabase, {
      messageId: m.id, communityId: m.community_id, senderEmail: m.sender_email,
      contactId: m.resolved_contact_id, propertyId: m.resolved_property_id,
      subject: m.subject, summary: m.ai_summary || m.body_preview,
    });
    res.json({ ok: true, ...out });
  } catch (err) { console.error('[objectives] reconcile-event failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

// The drive tick (dark): revisit stalled objectives. Capped + cost-guarded, so
// most short-circuit with no model call. Manual/on-demand — NO always-on cron.
router.post('/drive', async (req, res) => {
  try {
    const out = await R.driveTick(supabase, { communityId: (req.body || {}).communityId });
    res.json({ ok: true, ...out });
  } catch (err) { console.error('[objectives] drive failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

// The exception-rate metric — the operating number. Of the decisions made, how
// many could Trusted carry vs. how many need a human (escalation / policy
// authority boundary), plus agreement once decisions are graded. Measured from
// day one.
router.get('/metrics/exceptions', async (req, res) => {
  try {
    const { fetchAll } = require('../lib/db/fetch_all');
    let rows;
    try { rows = await fetchAll(supabase, 'objective_decisions', { select: 'verdict, confidence, authorization_boundary, human_outcome, agreement', orderBy: 'created_at' }); }
    catch (e) { if (_missing(e)) return res.json({ ok: true, notReady: true }); throw e; }
    const total = rows.length;
    const byVerdict = {}; let needsHuman = 0, graded = 0, agreed = 0;
    for (const r of rows) {
      byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
      if (r.verdict === 'ESCALATE' || r.authorization_boundary) needsHuman++;
      if (r.human_outcome) { graded++; if (r.agreement === 'agree') agreed++; }
    }
    const autonomyEligible = total - needsHuman;   // dark: "could have carried" (still human-reviewed)
    res.json({
      ok: true, total, byVerdict,
      needs_human: needsHuman, autonomy_eligible: autonomyEligible,
      autonomy_eligible_pct: total ? Math.round((autonomyEligible / total) * 100) : null,
      graded, agreement_pct: graded ? Math.round((agreed / graded) * 100) : null,
    });
  } catch (err) { console.error('[objectives] metrics failed:', err.message); res.status(500).json({ error: safe(err) }); }
});

module.exports = router;
