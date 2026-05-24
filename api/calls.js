// ============================================================================
// api/calls.js — Calls Dashboard backend
// ----------------------------------------------------------------------------
// Mounted at /api/calls. Powers the new "Calls" tab in trustEd UI.
//
// Endpoints:
//   GET   /api/calls/list           List calls with filters (status, date,
//                                   community, compliance). Returns a flat
//                                   array shaped for the dashboard table.
//   GET   /api/calls/:id            Full call detail (transcript + brief +
//                                   handoff info) for the row-expand view.
//   PATCH /api/calls/:id/follow-up  Update follow-up status, add notes,
//                                   mark resolved. Body fields:
//                                     status: 'open' | 'in_progress' | 'done' | 'dismissed'
//                                     internal_notes: string (appended, not replaced)
//
// Staff-auth gate applies normally — these are admin endpoints. No public
// exemption needed (unlike the Vapi webhook).
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
router.use(express.json({ limit: '64kb' }));

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// GET /api/calls/list
// Query params:
//   status        — 'open' | 'in_progress' | 'done' | 'dismissed' | 'all'
//                   (default 'open,in_progress' — the active queue)
//   community_id  — UUID, filter to one community
//   compliance    — '1' to filter to compliance_flag=true rows
//   since         — ISO date, default 30 days ago
//   limit         — default 200, max 500
// ---------------------------------------------------------------------------
router.get('/list', async (req, res) => {
  try {
    const statusParam = String(req.query.status || 'open,in_progress').toLowerCase();
    const statuses = statusParam === 'all'
      ? null
      : statusParam.split(',').map((s) => s.trim()).filter((s) =>
          ['open', 'in_progress', 'done', 'dismissed'].includes(s));
    const communityId = req.query.community_id ? String(req.query.community_id) : null;
    const complianceOnly = req.query.compliance === '1' || req.query.compliance === 'true';
    const since = req.query.since
      ? String(req.query.since)
      : new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '200', 10)));

    let q = supabase
      .from('homeowner_calls')
      .select(`
        id, call_sid, community_id, caller_phone, caller_homeowner_id,
        status, started_at, ended_at, duration_seconds, turn_count,
        brief, compliance_flag, compliance_reason,
        follow_up_status, respond_by_at, resolved_at, internal_notes,
        handoff_offered, handoff_accepted, handoff_reason,
        communities:community_id(name),
        contacts:caller_homeowner_id(full_name, preferred_name)
      `)
      .gte('started_at', since)
      .order('respond_by_at', { ascending: true, nullsLast: true })
      .order('started_at', { ascending: false })
      .limit(limit);

    if (statuses && statuses.length > 0) {
      // Include rows whose follow_up_status matches.
      q = q.in('follow_up_status', statuses);
    } else if (statusParam === 'all') {
      // No filter — return all calls including those without a follow-up.
    }
    if (communityId) q = q.eq('community_id', communityId);
    if (complianceOnly) q = q.eq('compliance_flag', true);

    const { data, error } = await q;
    if (error) throw error;

    // Flatten for the dashboard. Computed `caller_display_name` prefers
    // preferred_name, falls back to full_name, falls back to phone.
    const rows = (data || []).map((c) => {
      const contact = c.contacts || {};
      const callerDisplayName = contact.preferred_name
        || contact.full_name
        || (c.caller_phone ? c.caller_phone : 'Unknown');
      const community = c.communities ? c.communities.name : null;
      const brief = c.brief || {};
      return {
        id: c.id,
        call_sid: c.call_sid,
        community_id: c.community_id,
        community_name: community,
        caller_display_name: callerDisplayName,
        caller_phone: c.caller_phone,
        started_at: c.started_at,
        ended_at: c.ended_at,
        duration_seconds: c.duration_seconds,
        turn_count: c.turn_count,
        status: c.status,
        // Brief-derived columns surfaced for table view
        concern: brief.concern || null,
        category: brief.category || null,
        next_step: brief.next_step || null,
        owner: brief.owner || null,
        escalate: brief.escalate === true || brief.escalate === 'true',
        // Compliance + follow-up state
        compliance_flag: c.compliance_flag,
        compliance_reason: c.compliance_reason,
        follow_up_status: c.follow_up_status,
        respond_by_at: c.respond_by_at,
        resolved_at: c.resolved_at,
        internal_notes: c.internal_notes,
        // Handoff metadata
        handoff_offered: c.handoff_offered,
        handoff_accepted: c.handoff_accepted,
        handoff_reason: c.handoff_reason,
      };
    });

    res.json({ ok: true, count: rows.length, calls: rows });
  } catch (err) {
    console.error('[calls/list]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/calls/:id
// Full detail including transcript — used by the row-expand view.
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const { data, error } = await supabase
      .from('homeowner_calls')
      .select(`
        *,
        communities:community_id(name),
        contacts:caller_homeowner_id(full_name, preferred_name, primary_phone)
      `)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'call_not_found' });
    res.json({ ok: true, call: data });
  } catch (err) {
    console.error('[calls/get]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/calls/:id/follow-up
// Update follow-up status, append notes, mark resolved.
// Body:
//   { status?: 'open'|'in_progress'|'done'|'dismissed',
//     notes_append?: string,            // appended to internal_notes with timestamp
//     respond_by_at?: ISO string }      // optional override
// ---------------------------------------------------------------------------
router.patch('/:id/follow-up', async (req, res) => {
  try {
    const id = String(req.params.id);
    const body = req.body || {};

    // Allowlist fields
    const allowedStatuses = ['open', 'in_progress', 'done', 'dismissed'];
    const patch = {};

    if (body.status) {
      if (!allowedStatuses.includes(body.status)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      patch.follow_up_status = body.status;
      if (body.status === 'done' || body.status === 'dismissed') {
        patch.resolved_at = new Date().toISOString();
      } else {
        // Reopening — clear resolved_at
        patch.resolved_at = null;
      }
    }

    if (body.respond_by_at) {
      // Validate it's a parseable date
      const d = new Date(body.respond_by_at);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'invalid_respond_by_at' });
      }
      patch.respond_by_at = d.toISOString();
    }

    // Notes are appended, not replaced — preserve history of who-said-what.
    // Each note is timestamp-prefixed for readability.
    if (body.notes_append && String(body.notes_append).trim()) {
      const { data: existing } = await supabase
        .from('homeowner_calls')
        .select('internal_notes')
        .eq('id', id)
        .maybeSingle();
      const prior = (existing && existing.internal_notes) || '';
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const newLine = `[${stamp}] ${String(body.notes_append).trim()}`;
      patch.internal_notes = prior ? `${prior}\n${newLine}` : newLine;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no_changes_specified' });
    }

    const { data, error } = await supabase
      .from('homeowner_calls')
      .update(patch)
      .eq('id', id)
      .select('id, follow_up_status, respond_by_at, resolved_at, internal_notes')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'call_not_found' });

    res.json({ ok: true, call: data });
  } catch (err) {
    console.error('[calls/follow-up patch]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
