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
