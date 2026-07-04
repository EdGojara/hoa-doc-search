// ============================================================================
// api/agendas.js — saved meeting agendas (Ed 2026-07-02)
// ----------------------------------------------------------------------------
// Persist an agenda so it can be (1) emailed to the membership with the meeting
// notice, (2) auto-pulled into the board packet's Agenda section later, (3)
// kept as the association record. Matched to a packet on community + meeting
// date. The agenda body itself is produced by the existing /generate-agenda
// endpoint; this just stores/serves the result.
//
// Mounted at /api/agendas:
//   GET    /            ?community_id      list (newest first)
//   POST   /            save an agenda
//   GET    /:id
//   PATCH  /:id
//   DELETE /:id
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const TYPES = ['regular', 'annual', 'special', 'budget', 'emergency', 'executive', 'organizational'];
const { sendEmail, isConfigured: emailConfigured } = require('../lib/notifications/email');
const emailCampaigns = require('./email_campaigns'); // exposes .resolveRecipients (paged)

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TYPE_LABEL = { regular: 'Regular Board Meeting', annual: 'Annual Meeting', special: 'Special Meeting', budget: 'Budget Meeting', emergency: 'Emergency Meeting', executive: 'Executive Session', organizational: 'Organizational Meeting' };

// Render the member-facing notice + agenda email (community-branded, plain and
// clear). The agenda body is monospace-preserved so its formatting survives.
function renderNoticeEmailHtml(agenda, communityName) {
  const typeLabel = TYPE_LABEL[agenda.meeting_type] || 'Meeting';
  const dateLabel = agenda.meeting_date ? new Date(agenda.meeting_date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '(date to be announced)';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;">
    <div style="border-bottom:3px solid #D4AF37;padding-bottom:10px;margin-bottom:16px;">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#0B1D34;font-weight:700;">${esc(communityName)}</div>
      <h2 style="margin:6px 0 2px;color:#0B1D34;">Notice of ${esc(typeLabel)}</h2>
    </div>
    <p style="font-size:14px;line-height:1.6;">You are hereby notified of the following meeting of ${esc(communityName)}:</p>
    <table style="font-size:14px;line-height:1.7;margin:0 0 16px;">
      <tr><td style="padding-right:12px;color:#555;"><strong>Date</strong></td><td>${esc(dateLabel)}</td></tr>
      ${agenda.meeting_time ? `<tr><td style="padding-right:12px;color:#555;"><strong>Time</strong></td><td>${esc(agenda.meeting_time)}</td></tr>` : ''}
      ${agenda.location ? `<tr><td style="padding-right:12px;color:#555;"><strong>Location</strong></td><td>${esc(agenda.location)}</td></tr>` : ''}
    </table>
    <h3 style="color:#0B1D34;border-bottom:1px solid #e5e7eb;padding-bottom:4px;">Agenda</h3>
    <pre style="font-family:Arial,Helvetica,sans-serif;font-size:13.5px;line-height:1.6;white-space:pre-wrap;">${esc(agenda.full_text || '')}</pre>
    <div style="margin-top:22px;border-top:1px solid #e5e7eb;padding-top:8px;font-size:11px;color:#94a3b8;">Sent on behalf of ${esc(communityName)} by Bedrock Association Management.</div>
  </div>`;
}

// Resolve the member recipients for an agenda's community (owners with an email
// on file), deduped + paged (no 1000-row truncation), plus an INDEPENDENT
// property count so the operator can sanity-check coverage before sending.
async function resolveNoticeRecipients(agenda) {
  const recipients = await emailCampaigns.resolveRecipients({
    scope: 'single_community', target_community_id: agenda.community_id, audience: 'owners_only',
  });
  const withEmail = (recipients || []).filter((r) => r.email);
  // Independent cross-check source: total properties in the community.
  const { count: propertyCount } = await supabase.from('properties')
    .select('*', { count: 'exact', head: true }).eq('community_id', agenda.community_id);
  return { recipients: withEmail, property_count: propertyCount || 0 };
}

// --- POST /:id/notice-blast/preview — recipients + rendered email, NO send ---
router.post('/:id/notice-blast/preview', async (req, res) => {
  try {
    const { data: agenda } = await supabase.from('meeting_agendas').select('*, communities:community_id(name)').eq('id', req.params.id).maybeSingle();
    if (!agenda) return res.status(404).json({ error: 'not_found' });
    const communityName = (agenda.communities && agenda.communities.name) || 'the Association';
    const { recipients, property_count } = await resolveNoticeRecipients(agenda);
    res.json({
      ok: true,
      community_name: communityName,
      recipient_count: recipients.length,
      property_count,
      email_configured: emailConfigured ? emailConfigured() : false,
      sample: recipients.slice(0, 5).map((r) => ({ name: r.full_name, email: r.email })),
      subject: `Notice of ${TYPE_LABEL[agenda.meeting_type] || 'Meeting'} — ${communityName}`,
      email_html: renderNoticeEmailHtml(agenda, communityName),
    });
  } catch (err) {
    console.error('[agendas] notice preview failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- POST /:id/notice-blast/send — send after explicit confirm --------------
// Guard: the operator confirms a recipient count from the preview; if a fresh
// resolve doesn't match that count, refuse (409) so we never silently email a
// different/truncated set than what was reviewed.
router.post('/:id/notice-blast/send', express.json(), async (req, res) => {
  try {
    if (!(emailConfigured && emailConfigured())) return res.status(503).json({ error: 'email_not_configured' });
    const expected = Number((req.body || {}).expected_count);
    if (!Number.isFinite(expected)) return res.status(400).json({ error: 'expected_count_required', hint: 'Run preview first, then confirm its count.' });

    const { data: agenda } = await supabase.from('meeting_agendas').select('*, communities:community_id(name)').eq('id', req.params.id).maybeSingle();
    if (!agenda) return res.status(404).json({ error: 'not_found' });
    const communityName = (agenda.communities && agenda.communities.name) || 'the Association';
    const { recipients } = await resolveNoticeRecipients(agenda);

    if (recipients.length !== expected) {
      return res.status(409).json({ error: 'recipient_count_changed', message: `The recipient list is now ${recipients.length}, not the ${expected} you reviewed. Re-open the preview before sending.`, recipient_count: recipients.length });
    }
    if (!recipients.length) return res.status(400).json({ error: 'no_recipients' });

    const subject = `Notice of ${TYPE_LABEL[agenda.meeting_type] || 'Meeting'} — ${communityName}`;
    const html = renderNoticeEmailHtml(agenda, communityName);
    let sent = 0, failed = 0;
    for (const r of recipients) {
      // eslint-disable-next-line no-await-in-loop
      const result = await sendEmail({ to: r.email, subject, html }).catch((e) => ({ ok: false, error: e.message }));
      if (result && result.ok !== false) sent++; else failed++;
    }
    res.json({ ok: true, sent, failed, recipient_count: recipients.length });
  } catch (err) {
    console.error('[agendas] notice send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    let q = supabase.from('meeting_agendas')
      .select('id, community_id, meeting_date, meeting_type, meeting_time, location, title, status, updated_at, communities:community_id(name)')
      .order('meeting_date', { ascending: false, nullsFirst: false }).order('updated_at', { ascending: false }).limit(500);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ agendas: (data || []).map((a) => ({ ...a, community_name: a.communities ? a.communities.name : null })) });
  } catch (err) {
    console.error('[agendas] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.full_text || !String(b.full_text).trim()) return res.status(400).json({ error: 'agenda_text_required' });
    const type = TYPES.includes(b.meeting_type) ? b.meeting_type : 'regular';
    // Accept community_id OR community_name (the nav dropdown passes the name).
    let communityId = b.community_id || null;
    let comm = null;
    if (communityId) {
      ({ data: comm } = await supabase.from('communities').select('name, management_company_id').eq('id', communityId).maybeSingle());
    } else if (b.community_name) {
      ({ data: comm } = await supabase.from('communities').select('id, name, management_company_id').eq('management_company_id', BEDROCK_MGMT_CO_ID).ilike('name', b.community_name).maybeSingle());
      communityId = comm && comm.id;
    }
    if (!communityId) return res.status(400).json({ error: 'community_required', hint: 'Provide community_id or a valid community_name.' });
    b.community_id = communityId;
    const row = {
      management_company_id: (comm && comm.management_company_id) || BEDROCK_MGMT_CO_ID,
      community_id: b.community_id,
      meeting_date: b.meeting_date || null,
      meeting_type: type,
      meeting_time: b.meeting_time || null,
      location: b.location || null,
      title: b.title || `${type[0].toUpperCase() + type.slice(1)} Meeting Agenda`,
      full_text: String(b.full_text),
      items: Array.isArray(b.items) ? b.items : null,
      status: b.status === 'final' ? 'final' : 'draft',
      created_by: b.created_by || 'staff',
    };
    const { data, error } = await supabase.from('meeting_agendas').insert(row).select('*').single();
    if (error) throw error;
    res.json({ agenda: data });
  } catch (err) {
    console.error('[agendas] create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('meeting_agendas').select('*, communities:community_id(name)').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ agenda: { ...data, community_name: data.communities ? data.communities.name : null } });
  } catch (err) {
    console.error('[agendas] get failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const allowed = ['meeting_date', 'meeting_type', 'meeting_time', 'location', 'title', 'full_text', 'items', 'status'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.status && !['draft', 'final'].includes(patch.status)) return res.status(400).json({ error: 'bad_status' });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('meeting_agendas').update(patch).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json({ agenda: data });
  } catch (err) {
    console.error('[agendas] patch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('meeting_agendas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[agendas] delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
