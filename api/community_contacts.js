// ============================================================================
// Community contacts directory API
// ----------------------------------------------------------------------------
// Mounted at /api/community-contacts.
//
//   GET    /community/:community_id           list all (grouped by category)
//   GET    /by-slug/:slug                     public lookup by slug + trash schedule
//   POST   /                                  create
//   PATCH  /:id                               update
//   DELETE /:id                               delete
//   PATCH  /community/:community_id/trash-schedule  update trash JSONB
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

const CATEGORY_LABELS = {
  emergency: 'Emergency',
  utility: 'Utilities & services',
  trash: 'Trash & recycling',
  tv_internet: 'TV / Internet',
  community: 'Community contacts',
  other: 'Other',
};
const CATEGORY_ORDER = ['emergency', 'utility', 'trash', 'tv_internet', 'community', 'other'];

// Helper — group contacts by category in CATEGORY_ORDER sequence
function groupByCategory(rows) {
  const buckets = {};
  for (const r of rows) {
    if (!buckets[r.category]) buckets[r.category] = [];
    buckets[r.category].push(r);
  }
  return CATEGORY_ORDER
    .filter(cat => buckets[cat]?.length)
    .map(cat => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      contacts: buckets[cat],
    }));
}

// GET /community/:community_id — staff-facing list (all contacts including unpublished)
router.get('/community/:community_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('community_contacts')
      .select('*')
      .eq('community_id', req.params.community_id)
      .order('category')
      .order('display_order');
    if (error) throw error;

    const { data: community } = await supabase
      .from('communities')
      .select('id, name, slug, trash_schedule')
      .eq('id', req.params.community_id)
      .maybeSingle();

    res.json({
      community,
      contacts: data || [],
      grouped: groupByCategory((data || []).filter(c => c.is_published)),
    });
  } catch (err) {
    console.error('[community-contacts] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /by-slug/:slug — homeowner-facing endpoint (published only)
router.get('/by-slug/:slug', async (req, res) => {
  try {
    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, slug, trash_schedule')
      .eq('slug', req.params.slug)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    const { data: contacts, error } = await supabase
      .from('community_contacts')
      .select('id, category, name, phone, email, url, notes, display_order')
      .eq('community_id', community.id)
      .eq('is_published', true)
      .order('display_order');
    if (error) throw error;

    res.json({
      community: { name: community.name, slug: community.slug },
      trash_schedule: community.trash_schedule || null,
      grouped: groupByCategory(contacts || []),
    });
  } catch (err) {
    console.error('[community-contacts] by-slug failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST / — create a contact
router.post('/', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!body.category)     return res.status(400).json({ error: 'category_required' });
    if (!body.name)         return res.status(400).json({ error: 'name_required' });

    const row = {
      community_id:  body.community_id,
      category:      body.category,
      name:          body.name.trim(),
      phone:         body.phone?.trim() || null,
      email:         body.email?.trim() || null,
      url:           body.url?.trim() || null,
      notes:         body.notes?.trim() || null,
      display_order: body.display_order || 100,
      is_published:  body.is_published !== false,
    };
    const { data, error } = await supabase
      .from('community_contacts')
      .insert(row)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, contact: data });
  } catch (err) {
    console.error('[community-contacts] create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /:id — update a contact
router.patch('/:id', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const allowed = ['category', 'name', 'phone', 'email', 'url', 'notes',
                     'display_order', 'is_published'];
    const patch = {};
    for (const k of allowed) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
    const { data, error } = await supabase
      .from('community_contacts')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, contact: data });
  } catch (err) {
    console.error('[community-contacts] update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('community_contacts')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[community-contacts] delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PATCH /community/:community_id/trash-schedule
router.patch('/community/:community_id/trash-schedule', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const schedule = req.body?.trash_schedule || null;
    const { data, error } = await supabase
      .from('communities')
      .update({ trash_schedule: schedule })
      .eq('id', req.params.community_id)
      .select('id, name, slug, trash_schedule')
      .single();
    if (error) throw error;
    res.json({ ok: true, community: data });
  } catch (err) {
    console.error('[community-contacts] trash-schedule update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
