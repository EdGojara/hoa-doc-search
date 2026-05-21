// ============================================================================
// Reserve Studies API
// ----------------------------------------------------------------------------
// Mounted at /api/reserve-studies.
//
// Endpoints:
//   GET    /components                          list components (filterable by community)
//   GET    /components/:id                      single component with lifetime totals
//   POST   /components                          create component
//   PATCH  /components/:id                      update component
//   DELETE /components/:id                      delete (RESTRICT — won't cascade expenditures)
//
//   GET    /components/:id/expenditures         list expenditures for a component
//   POST   /components/:id/expenditures         record a new expenditure
//   PATCH  /expenditures/:id                    update expenditure
//   DELETE /expenditures/:id                    delete expenditure
//
//   GET    /community/:community_id/summary     dashboard view (totals, urgency, recent spend)
//   GET    /community/:community_id/map         data for the board reserve map (pins + colors)
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// ----------------------------------------------------------------------------
// Components
// ----------------------------------------------------------------------------

router.get('/components', async (req, res) => {
  try {
    let q = supabase
      .from('v_reserve_components_with_totals')
      .select('*')
      .order('display_order')
      .order('component_name');
    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.category) q = q.eq('category', req.query.category);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ components: data || [] });
  } catch (err) {
    console.error('[reserve-studies] components list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/components/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_reserve_components_with_totals')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json(data);
  } catch (err) {
    console.error('[reserve-studies] component detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/components', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!body.component_name) return res.status(400).json({ error: 'component_name_required' });
    if (!body.category) return res.status(400).json({ error: 'category_required' });

    const row = {
      community_id: body.community_id,
      component_name: body.component_name.trim(),
      category: body.category,
      description: body.description || null,
      amenity_id: body.amenity_id || null,
      installed_or_built_year: body.installed_or_built_year || null,
      useful_life_years: body.useful_life_years || null,
      remaining_useful_life_years: body.remaining_useful_life_years || null,
      current_cost_estimate_cents: body.current_cost_estimate_cents || null,
      future_cost_estimate_cents: body.future_cost_estimate_cents || null,
      inflation_factor: body.inflation_factor || null,
      next_scheduled_replacement_year: body.next_scheduled_replacement_year || null,
      condition: body.condition || null,
      last_inspection_date: body.last_inspection_date || null,
      status: body.status || 'active',
      lat: body.lat || null,
      lng: body.lng || null,
      pin_label_override: body.pin_label_override || null,
      source_document_id: body.source_document_id || null,
      source_section: body.source_section || null,
      notes: body.notes || null,
      photo_storage_path: body.photo_storage_path || null,
      display_order: body.display_order || 100,
    };
    const { data, error } = await supabase
      .from('reserve_components')
      .insert(row)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, component: data });
  } catch (err) {
    console.error('[reserve-studies] component create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/components/:id', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const allowedFields = [
      'component_name', 'category', 'description', 'amenity_id',
      'installed_or_built_year', 'useful_life_years', 'remaining_useful_life_years',
      'current_cost_estimate_cents', 'future_cost_estimate_cents',
      'inflation_factor', 'next_scheduled_replacement_year',
      'condition', 'last_inspection_date', 'status',
      'lat', 'lng', 'pin_label_override',
      'source_document_id', 'source_section', 'notes', 'photo_storage_path',
      'display_order',
    ];
    const patch = {};
    for (const k of allowedFields) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
    const { data, error } = await supabase
      .from('reserve_components')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, component: data });
  } catch (err) {
    console.error('[reserve-studies] component update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete('/components/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('reserve_components')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[reserve-studies] component delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Expenditures
// ----------------------------------------------------------------------------

router.get('/components/:id/expenditures', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reserve_expenditures')
      .select('*, invoice_doc:invoice_doc_id(id, title, file_path)')
      .eq('component_id', req.params.id)
      .order('expenditure_date', { ascending: false });
    if (error) throw error;
    res.json({ expenditures: data || [] });
  } catch (err) {
    console.error('[reserve-studies] expenditures list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/components/:id/expenditures', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.amount_cents) return res.status(400).json({ error: 'amount_cents_required' });
    if (!body.expenditure_date) return res.status(400).json({ error: 'expenditure_date_required' });
    if (!body.type) return res.status(400).json({ error: 'type_required' });

    // Need community_id — pull from the parent component
    const { data: comp, error: cErr } = await supabase
      .from('reserve_components')
      .select('community_id')
      .eq('id', req.params.id)
      .single();
    if (cErr) throw cErr;

    const row = {
      component_id: req.params.id,
      community_id: comp.community_id,
      amount_cents: body.amount_cents,
      expenditure_date: body.expenditure_date,
      type: body.type,
      description: body.description || null,
      vendor_name: body.vendor_name || null,
      invoice_number: body.invoice_number || null,
      invoice_doc_id: body.invoice_doc_id || null,
      funded_from: body.funded_from || null,
      notes: body.notes || null,
      recorded_by: body.recorded_by || null,
    };
    const { data, error } = await supabase
      .from('reserve_expenditures')
      .insert(row)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, expenditure: data });
  } catch (err) {
    console.error('[reserve-studies] expenditure create failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/expenditures/:id', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const allowedFields = [
      'amount_cents', 'expenditure_date', 'type', 'description',
      'vendor_name', 'invoice_number', 'invoice_doc_id', 'funded_from', 'notes',
    ];
    const patch = {};
    for (const k of allowedFields) {
      if (k in (req.body || {})) patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
    const { data, error } = await supabase
      .from('reserve_expenditures')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, expenditure: data });
  } catch (err) {
    console.error('[reserve-studies] expenditure update failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete('/expenditures/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('reserve_expenditures')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[reserve-studies] expenditure delete failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Community summary + map data
// ----------------------------------------------------------------------------

router.get('/community/:community_id/summary', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_reserve_community_summary')
      .select('*')
      .eq('community_id', req.params.community_id)
      .maybeSingle();
    if (error) throw error;
    res.json(data || {});
  } catch (err) {
    console.error('[reserve-studies] community summary failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/community/:community_id/map', async (req, res) => {
  try {
    // Pull components for the board reserve map
    const { data: comps, error: cErr } = await supabase
      .from('v_reserve_components_with_totals')
      .select('*')
      .eq('community_id', req.params.community_id)
      .eq('status', 'active')
      .order('display_order');
    if (cErr) throw cErr;

    // Get community + boundary
    const { data: community } = await supabase
      .from('communities')
      .select('id, name, slug')
      .eq('id', req.params.community_id)
      .maybeSingle();

    let boundary = null;
    let center = null;
    try {
      const { data: bData } = await supabase
        .rpc('community_boundary_geojson', { p_community_id: req.params.community_id });
      if (bData && bData.boundary) {
        boundary = { type: 'Feature', geometry: bData.boundary, properties: { name: community?.name } };
        const coords = bData.boundary.coordinates?.[0] || [];
        if (coords.length) {
          center = {
            lat: coords.reduce((s, c) => s + c[1], 0) / coords.length,
            lng: coords.reduce((s, c) => s + c[0], 0) / coords.length,
          };
        }
      }
    } catch (_) { /* boundary not critical */ }

    res.json({
      community,
      boundary,
      center,
      components: comps || [],
    });
  } catch (err) {
    console.error('[reserve-studies] map data failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
