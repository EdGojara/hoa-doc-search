// =============================================================================
// Board Portal API — endpoints that feed the property-tile board surface
// =============================================================================
// Mounted at /api/board-portal in server.js.
//
// Today's scope (v0): provides the data layer for project_board_portal.md.
// Staff-gated; board-specific auth (board member logs in, sees only own
// community) ships in a later phase. Three endpoints back the v0 UI:
//
//   GET /api/board-portal/communities
//        List of communities the operator can view. Today: all communities
//        in the management company. Future: filtered by board membership.
//
//   GET /api/board-portal/community/:id/summary
//        Aggregate stats — total properties, open violations, at-legal
//        count, ARC pending. Powers the community-level dashboard tiles.
//
//   GET /api/board-portal/community/:id/properties
//        Per-property summary rows (one per home), sourced from
//        v_property_summary. Supports optional filtering (open_only,
//        order_by) for the lens-driven views the property tile UI offers.
//
//   GET /api/board-portal/property/:id
//        Full detail for one property — summary row plus the underlying
//        ARC decisions, interactions, and knowledge documents.
// =============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// ----------------------------------------------------------------------------
// GET /api/board-portal/communities
// ----------------------------------------------------------------------------
router.get('/communities', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('communities')
      .select('id, name')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ communities: data || [] });
  } catch (err) {
    console.error('[board_portal] communities failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/community/:id/summary
// ----------------------------------------------------------------------------
router.get('/community/:id/summary', async (req, res) => {
  try {
    const communityId = req.params.id;

    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, legal_name')
      .eq('id', communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Aggregate over v_property_summary — single trip, no N+1
    const { data: rows, error: rErr } = await supabase
      .from('v_property_summary')
      .select('property_id, open_violations, worst_open_stage, owner_occupied, residency_type, arc_decisions_count, interactions_count')
      .eq('community_id', communityId);
    if (rErr) throw rErr;

    const safeRows = rows || [];
    const total = safeRows.length;
    const occupiedKnown = safeRows.filter((r) => r.residency_type != null && r.residency_type !== 'unknown').length;
    const ownerOccupied = safeRows.filter((r) => r.owner_occupied).length;
    const renters = safeRows.filter((r) => r.residency_type === 'renter').length;
    const vacant = safeRows.filter((r) => r.residency_type === 'vacant').length;

    const propertiesWithOpenViolations = safeRows.filter((r) => r.open_violations > 0).length;
    const certifiedOrFine = safeRows.filter((r) => ['certified_209', 'fine_assessed'].includes(r.worst_open_stage)).length;
    const totalArc = safeRows.reduce((s, r) => s + (r.arc_decisions_count || 0), 0);

    res.json({
      community,
      counts: {
        total_properties: total,
        properties_with_open_violations: propertiesWithOpenViolations,
        properties_at_certified_or_fine: certifiedOrFine,
        owner_occupied: ownerOccupied,
        renters,
        vacant,
        residency_known: occupiedKnown,
        residency_unknown: total - occupiedKnown,
        arc_decisions_total: totalArc,
      },
    });
  } catch (err) {
    console.error('[board_portal] community summary failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/community/:id/properties
// Query params:
//   open_only=1     restrict to properties with open violations
//   order_by=...    'open_violations_desc' | 'address' | 'last_violation_desc'
//   limit=...       cap rows (default 500)
// ----------------------------------------------------------------------------
router.get('/community/:id/properties', async (req, res) => {
  try {
    const communityId = req.params.id;
    const openOnly = req.query.open_only === '1';
    const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || '500', 10)));
    const orderBy = req.query.order_by || 'open_violations_desc';

    let q = supabase
      .from('v_property_summary')
      .select(`
        property_id, street_address, unit, owner_name, residency_type,
        owner_occupied, open_violations, worst_open_stage,
        lifetime_violations, violations_last_12mo, last_violation_at,
        arc_decisions_count, arc_approved_count, arc_denied_count,
        last_arc_decided_at, interactions_count, last_interaction_at,
        substrate_doc_count, inspections_count, last_inspected_at
      `)
      .eq('community_id', communityId)
      .limit(limit);

    if (openOnly) q = q.gt('open_violations', 0);

    // Order
    switch (orderBy) {
      case 'address':
        q = q.order('street_address', { ascending: true });
        break;
      case 'last_violation_desc':
        q = q.order('last_violation_at', { ascending: false, nullsFirst: false });
        break;
      case 'open_violations_desc':
      default:
        q = q.order('open_violations', { ascending: false })
             .order('last_violation_at', { ascending: false, nullsFirst: false });
        break;
    }

    const { data, error } = await q;
    if (error) throw error;
    res.json({ properties: data || [] });
  } catch (err) {
    console.error('[board_portal] community properties failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/property/:id
// Single property detail: summary + recent ARC + recent interactions + linked docs
// ----------------------------------------------------------------------------
router.get('/property/:id', async (req, res) => {
  try {
    const propertyId = req.params.id;

    const { data: summary, error: sErr } = await supabase
      .from('v_property_summary')
      .select('*')
      .eq('property_id', propertyId)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!summary) return res.status(404).json({ error: 'property_not_found' });

    // Recent ARC decisions (board-relevant: the precedents board members care
    // about when seeing what a property has done)
    const { data: arc } = await supabase
      .from('arc_historical_decisions')
      .select('id, project_type, project_description, decision_type, decided_at, decided_by, conditions, summary')
      .eq('property_id', propertyId)
      .order('decided_at', { ascending: false, nullsFirst: false })
      .limit(20);

    // Recent interactions — memory-layer activity
    const { data: interactions } = await supabase
      .from('interactions')
      .select('id, type, direction, subject, summary, created_at')
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })
      .limit(20);

    // Open violations detail
    const { data: openViolations } = await supabase
      .from('violations')
      .select('id, current_stage, current_stage_started_at, cure_period_ends_at, opened_at, primary_category_id, enforcement_categories:primary_category_id(label)')
      .eq('property_id', propertyId)
      .not('current_stage', 'in', '(cured,closed,voided)')
      .order('opened_at', { ascending: false });

    // Substrate docs linked to this property
    const { data: docs } = await supabase
      .from('knowledge_documents')
      .select('id, title, source_type, effective_date, ingested_at')
      .eq('property_id', propertyId)
      .eq('status', 'active')
      .order('effective_date', { ascending: false, nullsFirst: false })
      .limit(50);

    // Ownership history — boards expect 'this was the Smiths 2018-2024,
    // sold to the Joneses 2024-present' context, not just current owner.
    // Last 5 owners surface by default per the release-gate spec
    // (project_portal_release_gates.md). Most recent first.
    const { data: ownershipHistory } = await supabase
      .from('property_ownerships')
      .select(`
        id, start_date, end_date, vesting, is_primary, source,
        contact:contact_id ( id, full_name, primary_email )
      `)
      .eq('property_id', propertyId)
      .order('start_date', { ascending: false, nullsFirst: false })
      .limit(5);

    // Residency history — same pattern, mainly to show rental flips
    const { data: residencyHistory } = await supabase
      .from('property_residencies')
      .select(`
        id, start_date, end_date, residency_type, lease_end_date,
        contact:contact_id ( id, full_name )
      `)
      .eq('property_id', propertyId)
      .order('start_date', { ascending: false, nullsFirst: false })
      .limit(5);

    res.json({
      summary,
      arc_decisions: arc || [],
      interactions: interactions || [],
      open_violations: openViolations || [],
      substrate_docs: docs || [],
      ownership_history: ownershipHistory || [],
      residency_history: residencyHistory || [],
    });
  } catch (err) {
    console.error('[board_portal] property detail failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
