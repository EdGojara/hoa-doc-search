// ============================================================================
// api/messaging.js — Messaging System Phase 1 API
// ----------------------------------------------------------------------------
// Mount path: /api/messaging (registered in server.js).
//
// Endpoints (Phase 1):
//   GET    /threads                                staff master inbox (filterable, paginated)
//   POST   /threads                                create a new thread (staff or homeowner)
//   GET    /threads/:id                            thread detail + messages + property context
//   PATCH  /threads/:id                            assign / change status / change subject
//   POST   /threads/:id/messages                   send a message (staff or homeowner)
//   GET    /threads/:id/messages                   list messages (paginated)
//   POST   /threads/:id/propose-close              staff hits "Propose Close" — triggers 24h ack
//   POST   /threads/:id/acknowledge-close          homeowner agrees to close (or staff override)
//   POST   /threads/:id/reopen                     reopen a closed thread
//   GET    /threads/:id/audit                      replay history from thread_audit_log
//
//   GET    /portal/threads                         homeowner-side: their threads across all owned properties
//   GET    /portal/properties/:propertyId/threads  homeowner-side: threads for one property
//
//   GET    /metrics/staff/:staffId                 per-staff dashboard
//   GET    /metrics/community/:communityId         per-community dashboard
//   GET    /metrics/portfolio                      Ed's overall view
//
// Auth model (Phase 1):
//   - Staff endpoints use the existing resolveUserRole admin/staff check.
//   - /portal/* endpoints (homeowner-facing) use the existing magic-link
//     cookie auth from the homeowner portal (separate code path; wires in
//     when we hook up the portal UI).
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { computeFirstResponseDueAt } = require('../lib/messaging/sla_engine');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// JSON body limit per CLAUDE.md convention.
const json64 = express.json({ limit: '64kb' });
const json256 = express.json({ limit: '256kb' });  // larger for message bodies with attachments metadata

// =============================================================================
// GET /threads  — staff master inbox
//
// Query params:
//   community_id   — filter by community
//   assigned_to    — staff user id ('me' resolves to current user)
//   status         — filter by next_action_status (csv allowed)
//   has_unread     — true to show only threads with unread messages
//   include_closed — default false; set true to include closed threads
//   q              — text search across subject + property address + owner name
//   sort           — last_message (default) | created | days_open
//   limit, offset  — pagination (hard cap 200)
// =============================================================================
router.get('/threads', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const includeClosed = String(req.query.include_closed || 'false') === 'true';
    const communityId = req.query.community_id ? String(req.query.community_id) : null;
    const assignedTo = req.query.assigned_to ? String(req.query.assigned_to) : null;
    const statusFilter = req.query.status ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) : null;

    let q = supabase
      .from('homeowner_threads')
      .select(`
        id, community_id, property_id, primary_contact_id,
        subject, topic_tag, next_action_status,
        assigned_staff_id, claire_state,
        last_message_at, last_homeowner_message_at, last_staff_message_at,
        last_responder_type, last_responder_id,
        first_response_due_at, first_responded_at,
        breached_yellow_at, breached_red_at, breached_overdue_at,
        closure_proposed_at, closed_at, closed_reason,
        created_at, updated_at,
        communities:community_id(name),
        properties:property_id(street_address, lot_number),
        contacts:primary_contact_id(first_name, last_name, email_primary)
      `, { count: 'exact' })
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (!includeClosed) q = q.neq('next_action_status', 'closed');
    if (communityId) q = q.eq('community_id', communityId);
    if (assignedTo) q = q.eq('assigned_staff_id', assignedTo);
    if (statusFilter && statusFilter.length > 0) q = q.in('next_action_status', statusFilter);

    q = q.range(offset, offset + limit - 1);
    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });

    // Decorate with SLA color + days_open
    const decorated = (data || []).map((row) => {
      const slaColor = (() => {
        if (row.next_action_status === 'closed') return 'gray';
        if (row.first_responded_at) return 'gray';
        if (row.breached_overdue_at) return 'overdue';
        if (row.breached_red_at) return 'red';
        if (row.breached_yellow_at) return 'yellow';
        return 'green';
      })();
      const daysOpen = row.created_at
        ? Math.floor((Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      return { ...row, sla_color: slaColor, days_open: daysOpen };
    });

    res.json({ threads: decorated, total: count || 0, limit, offset });
  } catch (err) {
    console.error('[messaging] GET /threads failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// POST /threads  — create a new thread
//
// Body: {
//   community_id, property_id, primary_contact_id, subject,
//   topic_tag (optional), initial_message: { body_text, sender_type, sender_id, channel }
// }
//
// If initial_message provided, also creates the first message in one call.
// =============================================================================
router.post('/threads', json64, async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['community_id', 'property_id', 'primary_contact_id', 'subject'];
    for (const f of required) {
      if (!b[f]) return res.status(400).json({ error: `${f}_required` });
    }

    // Compute SLA due date if initial message is inbound from homeowner
    const isHomeownerInitiated = b.initial_message?.sender_type === 'homeowner';
    const firstResponseDueAt = isHomeownerInitiated
      ? computeFirstResponseDueAt(new Date()).toISOString()
      : null;

    const insertRow = {
      community_id: b.community_id,
      property_id: b.property_id,
      primary_contact_id: b.primary_contact_id,
      subject: String(b.subject).slice(0, 200),
      topic_tag: b.topic_tag || null,
      first_response_due_at: firstResponseDueAt,
      next_action_status: isHomeownerInitiated ? 'awaiting_staff_first_response' : 'awaiting_homeowner',
      assigned_staff_id: b.assigned_staff_id || null,
    };

    const { data: thread, error: insErr } = await supabase
      .from('homeowner_threads')
      .insert(insertRow)
      .select()
      .single();
    if (insErr) return res.status(500).json({ error: safeErrorMessage(insErr) });

    // Insert initial message if provided
    if (b.initial_message?.body_text) {
      const m = b.initial_message;
      const direction = (m.sender_type === 'homeowner') ? 'inbound' : 'outbound';
      const { error: msgErr } = await supabase.from('messages').insert({
        thread_id: thread.id,
        direction,
        sender_type: m.sender_type || 'system',
        sender_id: m.sender_id || null,
        sender_display_name: m.sender_display_name || null,
        channel: m.channel || 'portal',
        body_text: m.body_text,
        attachments_jsonb: m.attachments || [],
      });
      if (msgErr) console.warn('[messaging] initial message insert failed:', msgErr.message);
    }

    res.status(201).json({ thread });
  } catch (err) {
    console.error('[messaging] POST /threads failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// GET /threads/:id  — thread detail with messages + property context
// =============================================================================
router.get('/threads/:id', async (req, res) => {
  try {
    const { data: thread, error: thErr } = await supabase
      .from('homeowner_threads')
      .select(`
        *,
        communities:community_id(name),
        properties:property_id(id, street_address, lot_number, community_id),
        contacts:primary_contact_id(id, first_name, last_name, email_primary, phone_primary, mailing_address)
      `)
      .eq('id', req.params.id)
      .maybeSingle();
    if (thErr) return res.status(500).json({ error: safeErrorMessage(thErr) });
    if (!thread) return res.status(404).json({ error: 'not_found' });

    const { data: messages } = await supabase
      .from('messages')
      .select('*')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true });

    // Other threads on this property (sibling context per design)
    const { data: siblingThreads } = await supabase
      .from('homeowner_threads')
      .select('id, subject, next_action_status, last_message_at, created_at')
      .eq('property_id', thread.property_id)
      .neq('id', thread.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(10);

    // Other properties owned by this contact
    const { data: otherProperties } = await supabase
      .from('property_owners')
      .select(`
        property_id,
        properties:property_id(id, street_address, lot_number, community_id, communities:community_id(name))
      `)
      .eq('contact_id', thread.primary_contact_id);

    res.json({
      thread,
      messages: messages || [],
      sibling_threads: siblingThreads || [],
      other_properties: (otherProperties || []).map((p) => p.properties).filter(Boolean),
    });
  } catch (err) {
    console.error('[messaging] GET /threads/:id failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// PATCH /threads/:id  — operator edits (assign, status, subject)
// =============================================================================
const ALLOWED_PATCH_FIELDS = [
  'subject', 'topic_tag', 'next_action_status',
  'assigned_staff_id', 'claire_state',
];
router.patch('/threads/:id', json64, async (req, res) => {
  try {
    const patch = {};
    for (const f of ALLOWED_PATCH_FIELDS) {
      if (req.body[f] !== undefined) patch[f] = req.body[f];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_allowed_fields' });
    const { data, error } = await supabase
      .from('homeowner_threads')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ thread: data });
  } catch (err) {
    console.error('[messaging] PATCH /threads/:id failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// POST /threads/:id/messages  — send a message
//
// Body: {
//   sender_type ('staff' | 'homeowner' | 'claire'),
//   sender_id, sender_display_name,
//   channel ('portal' | 'sms' | 'email' | 'push'),
//   body_text, body_html, attachments: [{type, url, filename, size_bytes, mime}]
// }
//
// Status auto-flips via the thread-activity-sync trigger. SLA first-response
// auto-captures on first outbound staff/claire message. No app-level work.
// =============================================================================
router.post('/threads/:id/messages', json256, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.body_text) return res.status(400).json({ error: 'body_text_required' });
    if (!b.sender_type || !['staff', 'homeowner', 'claire', 'system'].includes(b.sender_type)) {
      return res.status(400).json({ error: 'sender_type_required' });
    }
    const direction = (b.sender_type === 'homeowner') ? 'inbound' : 'outbound';
    const row = {
      thread_id: req.params.id,
      direction,
      sender_type: b.sender_type,
      sender_id: b.sender_id || null,
      sender_display_name: b.sender_display_name || null,
      channel: b.channel || 'portal',
      body_text: b.body_text,
      body_html: b.body_html || null,
      attachments_jsonb: b.attachments || [],
    };
    const { data, error } = await supabase
      .from('messages')
      .insert(row)
      .select()
      .single();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.status(201).json({ message: data });
  } catch (err) {
    console.error('[messaging] POST /threads/:id/messages failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// POST /threads/:id/propose-close
//
// Empty-chair lens: staff doesn't close unilaterally. They propose; homeowner
// has 24 hours; auto-closes if silent (handled by sla_engine scheduled job).
//
// Body: { staff_id, message_body? }
//   - message_body: the actual close-proposal message text (operator can edit)
//   - if not provided, uses the standard boilerplate
// =============================================================================
router.post('/threads/:id/propose-close', json64, async (req, res) => {
  try {
    const b = req.body || {};
    const closureMessage = b.message_body || 'We think this is resolved. If you don\'t reply within 24 hours, we\'ll close the thread. Reply if you need anything else.';

    // Update the thread state
    const nowIso = new Date().toISOString();
    const { data: thread, error: thErr } = await supabase
      .from('homeowner_threads')
      .update({
        next_action_status: 'closure_pending',
        closure_proposed_at: nowIso,
        closure_proposed_by_staff_id: b.staff_id || null,
      })
      .eq('id', req.params.id)
      .select()
      .single();
    if (thErr) return res.status(500).json({ error: safeErrorMessage(thErr) });

    // Send the close-proposal message (system message, but credited to staff)
    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .insert({
        thread_id: req.params.id,
        direction: 'outbound',
        sender_type: 'system',
        sender_id: b.staff_id || null,
        sender_display_name: b.sender_display_name || 'Bedrock',
        channel: 'portal',
        body_text: closureMessage,
        record_ownership: 'association_record',
      })
      .select()
      .single();
    if (msgErr) console.warn('[messaging] closure-proposal message insert failed:', msgErr.message);

    res.json({ thread, message: msg });
  } catch (err) {
    console.error('[messaging] propose-close failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// POST /threads/:id/acknowledge-close
//
// Homeowner-side acknowledgment ("yes resolved, thanks!") OR staff override.
// Body: { acknowledger_type ('homeowner' | 'staff'), acknowledger_id, override_reason? }
// =============================================================================
router.post('/threads/:id/acknowledge-close', json64, async (req, res) => {
  try {
    const b = req.body || {};
    const nowIso = new Date().toISOString();
    const closedReason = b.acknowledger_type === 'staff' ? 'staff_override' : 'homeowner_agreed';
    const { data, error } = await supabase
      .from('homeowner_threads')
      .update({
        next_action_status: 'closed',
        closure_acknowledged_at: nowIso,
        closed_at: nowIso,
        closed_reason: closedReason,
      })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ thread: data });
  } catch (err) {
    console.error('[messaging] acknowledge-close failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// POST /threads/:id/reopen — staff reopens a closed thread
// =============================================================================
router.post('/threads/:id/reopen', json64, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('homeowner_threads')
      .update({
        next_action_status: 'awaiting_staff_followup',
        closed_at: null,
        closed_reason: 'reopened',
        closure_proposed_at: null,
        closure_acknowledged_at: null,
      })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ thread: data });
  } catch (err) {
    console.error('[messaging] reopen failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// GET /threads/:id/audit — replay history
// =============================================================================
router.get('/threads/:id/audit', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('thread_audit_log')
      .select('*')
      .eq('thread_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ events: data || [] });
  } catch (err) {
    console.error('[messaging] audit failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// GET /portal/threads  — homeowner's threads across all owned properties
// Auth: requires homeowner-portal magic-link cookie (separate auth path).
// For Phase 1 we accept a contact_id query param + verify it matches the
// signed cookie. Wires up properly when portal UI integrates.
// =============================================================================
router.get('/portal/threads', async (req, res) => {
  try {
    // Resolve identity from the signed portal cookie — DON'T trust
    // a client-supplied contact_id (Ed 2026-06-08 audit found this
    // was open for any caller to read any homeowner's threads).
    const { resolvePortalUser } = require('./portal');
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });

    // Look up which contact this portal user is linked to (cookie → user → contact)
    const { data: pUser } = await supabase
      .from('portal_users')
      .select('contact_id, status')
      .eq('id', portalUserId)
      .maybeSingle();
    if (!pUser || pUser.status === 'revoked') return res.status(401).json({ error: 'session_invalid' });
    const contactId = pUser.contact_id;
    if (!contactId) return res.json({ threads: [] });

    // Get the homeowner's property_ids via property_ownerships (the
    // canonical ownership table; the older property_owners typo from
    // before this audit was a non-existent table).
    const { data: properties } = await supabase
      .from('property_ownerships')
      .select('property_id')
      .eq('contact_id', contactId)
      .is('end_date', null);
    const propertyIds = (properties || []).map((p) => p.property_id).filter(Boolean);
    if (propertyIds.length === 0) return res.json({ threads: [] });

    const { data, error } = await supabase
      .from('homeowner_threads')
      .select(`
        id, community_id, property_id, subject, topic_tag, next_action_status,
        last_message_at, last_responder_type, created_at,
        properties:property_id(street_address, lot_number),
        communities:community_id(name)
      `)
      .in('property_id', propertyIds)
      .neq('next_action_status', 'closed')
      .order('last_message_at', { ascending: false, nullsFirst: false });
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ threads: data || [] });
  } catch (err) {
    console.error('[messaging] portal threads failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// GET /portal/properties/:propertyId/threads — threads for ONE property
// =============================================================================
router.get('/portal/properties/:propertyId/threads', async (req, res) => {
  try {
    // Same auth pattern as /portal/threads — resolve identity from the
    // signed cookie. Additionally verify the property is one the signed-in
    // homeowner has access to (no enumeration of other people's threads).
    const { resolvePortalUser } = require('./portal');
    const { portalUserId } = resolvePortalUser(req);
    if (!portalUserId) return res.status(401).json({ error: 'not_signed_in' });

    const propertyId = req.params.propertyId;
    const { data: scope } = await supabase
      .from('portal_user_properties')
      .select('property_id')
      .eq('portal_user_id', portalUserId)
      .eq('property_id', propertyId)
      .is('revoked_at', null)
      .maybeSingle();
    if (!scope) return res.status(403).json({ error: 'property_not_in_scope' });

    const { data, error } = await supabase
      .from('homeowner_threads')
      .select(`
        id, subject, topic_tag, next_action_status,
        last_message_at, last_responder_type, created_at,
        properties:property_id(street_address, lot_number),
        communities:community_id(name)
      `)
      .eq('property_id', propertyId)
      .order('last_message_at', { ascending: false, nullsFirst: false });
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    res.json({ threads: data || [] });
  } catch (err) {
    console.error('[messaging] portal property threads failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// GET /metrics/staff/:staffId — per-staff dashboard data
// Phase 1 returns the data shape; the UI rendering happens client-side.
// =============================================================================
router.get('/metrics/staff/:staffId', async (req, res) => {
  try {
    const staffId = req.params.staffId;
    const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: threads } = await supabase
      .from('homeowner_threads')
      .select('id, created_at, first_responded_at, closed_at, closed_reason, next_action_status, breached_yellow_at, breached_red_at, breached_overdue_at')
      .eq('assigned_staff_id', staffId)
      .gte('created_at', sinceIso);

    const rows = threads || [];
    const totalHandled = rows.length;
    const responded = rows.filter((r) => r.first_responded_at);
    const respondTimesMs = responded.map((r) => new Date(r.first_responded_at) - new Date(r.created_at));
    respondTimesMs.sort((a, b) => a - b);
    const medianMs = respondTimesMs[Math.floor(respondTimesMs.length / 2)] || 0;
    const breachedRed = rows.filter((r) => r.breached_red_at).length;
    const overdueNow = rows.filter((r) => r.breached_overdue_at && r.next_action_status !== 'closed').length;
    const resolved = rows.filter((r) => r.next_action_status === 'closed').length;

    res.json({
      staff_id: staffId,
      window_days: 30,
      threads_handled: totalHandled,
      median_first_response_minutes: Math.round(medianMs / 60000),
      threads_breaching_red: breachedRed,
      overdue_now: overdueNow,
      resolved_count: resolved,
      resolution_rate: totalHandled > 0 ? Math.round((resolved / totalHandled) * 100) : 0,
    });
  } catch (err) {
    console.error('[messaging] metrics/staff failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// GET /metrics/portfolio — Ed's view
// =============================================================================
router.get('/metrics/portfolio', async (_req, res) => {
  try {
    const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: threads } = await supabase
      .from('homeowner_threads')
      .select('id, community_id, next_action_status, breached_overdue_at, closed_at, first_responded_at, created_at')
      .gte('created_at', sinceIso);

    const rows = threads || [];
    const byCommunityMap = new Map();
    for (const r of rows) {
      const k = r.community_id;
      const c = byCommunityMap.get(k) || { community_id: k, total: 0, resolved: 0, overdue: 0 };
      c.total += 1;
      if (r.next_action_status === 'closed') c.resolved += 1;
      if (r.breached_overdue_at && r.next_action_status !== 'closed') c.overdue += 1;
      byCommunityMap.set(k, c);
    }

    res.json({
      window_days: 30,
      total_threads: rows.length,
      total_resolved: rows.filter((r) => r.next_action_status === 'closed').length,
      total_overdue: rows.filter((r) => r.breached_overdue_at && r.next_action_status !== 'closed').length,
      by_community: Array.from(byCommunityMap.values()),
    });
  } catch (err) {
    console.error('[messaging] metrics/portfolio failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
