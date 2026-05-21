// ============================================================================
// Ownership Change Proposals API
// ----------------------------------------------------------------------------
// Mounted at /api/ownership-proposals.
//
// Endpoints:
//   GET  /                  — queue list (filterable by community/status/age)
//   GET  /:id               — single proposal detail
//   POST /:id/approve       — approve + transition ownership atomically (RPC)
//   POST /:id/reject        — reject with reason (RPC)
//
// Per project_property_data_architecture + Task #28: ownership transitions
// from Vantaca imports get queued here for staff review. Staff approves
// from this queue; the approve_ownership_proposal() RPC handles closing
// the old ownership row + opening the new one + linking contact in one
// atomic transaction.
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ============================================================================
// GET /api/ownership-proposals
// Query: community_id?, status? (pending|approved|rejected|all), q? (search)
// ============================================================================
router.get('/', async (req, res) => {
  try {
    let q = supabase
      .from('v_ownership_proposals_queue')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    const status = req.query.status || 'pending';
    if (status !== 'all') q = q.eq('status', status);
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.q) {
      const like = `%${String(req.query.q).replace(/[%_]/g, '')}%`;
      q = q.or(`street_address.ilike.${like},current_owner_name.ilike.${like},proposed_owner_name.ilike.${like},vantaca_account_id.ilike.${like}`);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    q = q.range(offset, offset + limit - 1);

    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ items: data || [], total: count || 0, limit, offset });
  } catch (err) {
    console.error('[ownership-proposals] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// GET /api/ownership-proposals/:id
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_ownership_proposals_queue')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json(data);
  } catch (err) {
    console.error('[ownership-proposals] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/ownership-proposals/:id/approve
// Body: { reviewed_by: required, notes: optional }
// Calls approve_ownership_proposal RPC — closes old ownership, inserts new
// ownership, links contact (creates or matches by email), all atomic.
// ============================================================================
router.post('/:id/approve', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { reviewed_by, notes } = req.body || {};
    if (!reviewed_by) return res.status(400).json({ error: 'reviewed_by_required' });

    const { data, error } = await supabase.rpc('approve_ownership_proposal', {
      p_proposal_id: req.params.id,
      p_reviewed_by: reviewed_by,
      p_notes: notes || null,
    });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[ownership-proposals] approve failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /api/ownership-proposals/:id/reject
// Body: { reviewed_by: required, notes: required (reason) }
// ============================================================================
router.post('/:id/reject', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { reviewed_by, notes } = req.body || {};
    if (!reviewed_by) return res.status(400).json({ error: 'reviewed_by_required' });
    if (!notes) return res.status(400).json({ error: 'rejection_reason_required' });

    const { data, error } = await supabase.rpc('reject_ownership_proposal', {
      p_proposal_id: req.params.id,
      p_reviewed_by: reviewed_by,
      p_notes: notes,
    });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[ownership-proposals] reject failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
