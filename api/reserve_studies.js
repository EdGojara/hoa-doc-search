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
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { parseReserveAdvisorsWorkbook } = require('../lib/reserve_advisors_parser');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// ----------------------------------------------------------------------------
// Reserve study versions + funding plan
// ----------------------------------------------------------------------------

// GET /community/:community_id/study — active study metadata + version history
router.get('/community/:community_id/study', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reserve_study_versions')
      .select('*')
      .eq('community_id', req.params.community_id)
      .order('inspection_date', { ascending: false });
    if (error) throw error;
    res.json({
      active: (data || []).find(s => s.is_active) || null,
      history: data || [],
    });
  } catch (err) {
    console.error('[reserve-studies] study list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /community/:community_id/funding-plan — projected + actuals per year
router.get('/community/:community_id/funding-plan', async (req, res) => {
  try {
    // Get the active study so we can scope to its funding plan version
    const { data: active } = await supabase
      .from('reserve_study_versions')
      .select('id, inspection_date, fiscal_year')
      .eq('community_id', req.params.community_id)
      .eq('is_active', true)
      .maybeSingle();
    if (!active) return res.json({ active_study: null, years: [] });

    const { data, error } = await supabase
      .from('v_reserve_funding_actuals')
      .select('*')
      .eq('community_id', req.params.community_id)
      .eq('reserve_study_version_id', active.id)
      .order('fiscal_year');
    if (error) throw error;
    res.json({ active_study: active, years: data || [] });
  } catch (err) {
    console.error('[reserve-studies] funding plan failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// Excel import — Reserve Advisors v7.0 spreadsheet
// ----------------------------------------------------------------------------

// POST /import/preview — accepts an Excel upload, returns parsed structure
// (study metadata + components + funding plan). Staff confirms in UI before
// committing. Stateless; nothing written until commit.
router.post('/import/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const result = parseReserveAdvisorsWorkbook(req.file.buffer);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[reserve-studies] import preview failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /import/commit — accepts confirmed study + components + funding plan,
// writes them to the database in one transaction-shaped batch.
// Body shape:
//   {
//     community_id: UUID,
//     source_document_id: UUID | null,        // optional link to library_documents PDF
//     study_firm: 'Reserve Advisors LLC',
//     metadata: { ...parser output... },
//     components: [ { ...parser output, optionally edited... } ],
//     funding_plan: [ ...parser output... ],
//     deactivate_existing: true,              // mark prior active study as replaced
//   }
router.post('/import/commit', express.json({ limit: '8mb' }), async (req, res) => {
  const body = req.body || {};
  if (!body.community_id) return res.status(400).json({ error: 'community_id_required' });
  if (!body.metadata)     return res.status(400).json({ error: 'metadata_required' });
  if (!Array.isArray(body.components) || !body.components.length) {
    return res.status(400).json({ error: 'components_required' });
  }

  try {
    // 1) Deactivate any existing active study and link new → old via replaced_by_id
    let priorStudyId = null;
    if (body.deactivate_existing !== false) {
      const { data: prior } = await supabase
        .from('reserve_study_versions')
        .select('id')
        .eq('community_id', body.community_id)
        .eq('is_active', true)
        .maybeSingle();
      priorStudyId = prior?.id || null;
    }

    // 2) Insert the new study version row
    const meta = body.metadata;
    const studyRow = {
      community_id:                body.community_id,
      study_firm:                  body.study_firm || 'Reserve Advisors LLC',
      study_format:                meta.format || 'reserve_advisors_v7',
      reference_number:            meta.reference_number || null,
      inspection_date:             meta.inspection_date || null,
      fiscal_year:                 meta.fiscal_year || null,
      fiscal_year_begin:           meta.fiscal_year_begin || null,
      first_year_recommendation:   meta.first_year_recommendation || null,
      length_years:                meta.length_years || null,
      units_count:                 meta.units_count || null,
      beginning_balance_cents:     meta.beginning_balance_cents || null,
      beginning_balance_date:      meta.beginning_balance_date || null,
      near_term_inflation:         meta.near_term_inflation || null,
      remaining_inflation:         meta.remaining_inflation || null,
      last_year_near_term:         meta.last_year_near_term || null,
      interest_rate:               meta.interest_rate || null,
      contributions_per_year:      meta.contributions_per_year || null,
      source_document_id:          body.source_document_id || null,
      is_active:                   true,
      imported_by:                 body.imported_by || null,
    };
    const { data: newStudy, error: studyErr } = await supabase
      .from('reserve_study_versions')
      .insert(studyRow)
      .select('*')
      .single();
    if (studyErr) throw studyErr;

    // 3) Mark prior study replaced (after new one is committed)
    if (priorStudyId) {
      await supabase
        .from('reserve_study_versions')
        .update({ is_active: false, replaced_at: new Date().toISOString(), replaced_by_id: newStudy.id })
        .eq('id', priorStudyId);
    }

    // 4) Bulk insert components — map parser shape to reserve_components schema.
    // display_order increments by 10 so manual additions can be inserted between
    // imported study items without renumbering. Imported items always sort first.
    const compRows = body.components.map((c, idx) => ({
      community_id:                    body.community_id,
      reserve_study_version_id:        newStudy.id,
      source_document_id:              body.source_document_id || null,
      component_name:                  (c.component_name || '').trim(),
      category:                        c.category || c.suggested_category || 'other',
      description:                     c.description || null,
      line_item_number:                c.line_item || null,
      installed_or_built_year:         c.installed_or_built_year || null,
      useful_life_years:               c.useful_life_years || null,
      remaining_useful_life_years:     c.remaining_useful_life_years || null,
      current_cost_estimate_cents:     c.current_cost_estimate_cents || null,
      future_cost_estimate_cents:      c.future_cost_estimate_cents || null,
      inflation_factor:                c.inflation_factor || null,
      next_scheduled_replacement_year: c.next_scheduled_replacement_year || null,
      condition:                       c.condition || null,
      status:                          c.status || 'active',
      lat:                             c.lat || null,
      lng:                             c.lng || null,
      source_section:                  c.source_section || null,
      notes:                           c.notes || null,
      display_order:                   10 + (idx * 10),
      quantity_total:                  c.total_quantity || c.quantity_total || null,
      quantity_per_phase:              c.per_phase_quantity || c.quantity_per_phase || null,
      quantity_units:                  c.units || c.quantity_units || null,
      partial_quantity_pct:            c.partial_quantity_pct || null,
      unit_cost_cents:                 c.unit_cost_dollars != null ? Math.round(c.unit_cost_dollars * 100) : null,
    }));

    // Chunk insert to avoid PostgREST payload limits
    const inserted = [];
    for (let i = 0; i < compRows.length; i += 50) {
      const chunk = compRows.slice(i, i + 50);
      const { data, error } = await supabase
        .from('reserve_components')
        .insert(chunk)
        .select('id, component_name, category');
      if (error) throw error;
      inserted.push(...(data || []));
    }

    // 5) Insert funding plan rows (if provided)
    let fundingInserted = 0;
    if (Array.isArray(body.funding_plan) && body.funding_plan.length) {
      const fpRows = body.funding_plan.map(y => ({
        community_id:                   body.community_id,
        reserve_study_version_id:       newStudy.id,
        fiscal_year:                    y.year,
        beginning_balance_cents:        y.beginning_balance_cents || null,
        recommended_contribution_cents: y.recommended_contribution_cents || null,
        additional_contribution_cents:  y.additional_contribution_cents || null,
        additional_assessment_cents:    y.additional_assessment_cents || null,
        total_contribution_cents:       y.total_contribution_cents || null,
        interest_rate:                  y.interest_rate || null,
        interest_earned_cents:          y.interest_earned_cents || null,
        anticipated_expenditures_cents: y.anticipated_expenditures_cents || null,
        ending_balance_cents:           y.ending_balance_cents || null,
      }));
      const { data: fpData, error: fpErr } = await supabase
        .from('reserve_funding_plan')
        .insert(fpRows)
        .select('id');
      if (fpErr) throw fpErr;
      fundingInserted = fpData?.length || 0;
    }

    res.json({
      ok: true,
      study: newStudy,
      replaced_prior_study_id: priorStudyId,
      components_inserted: inserted.length,
      funding_plan_years_inserted: fundingInserted,
    });
  } catch (err) {
    console.error('[reserve-studies] import commit failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
