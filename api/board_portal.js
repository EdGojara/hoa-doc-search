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

// Board portal AUTHORIZATION (Ed 2026-07-27). Was v0 unauthenticated — any
// request returned any community's data. Now every endpoint proves identity and
// derives an allowed-community scope server-side; the community id in the URL is
// checked against that scope, never trusted. Staff (JWT) see the portfolio; a
// board member sees only the communities they sit on.
const { requireBoardViewer, canSeeCommunity, scopeCommunityIds } = require('../lib/portal/board_access');

// ----------------------------------------------------------------------------
// GET /api/board-portal/communities
// ----------------------------------------------------------------------------
router.get('/communities', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    let q = supabase
      .from('communities')
      .select('id, name, is_demo')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .order('name', { ascending: true });
    // Board members only enumerate their own community(ies); staff see all.
    const ids = scopeCommunityIds(viewer);
    const viewerOut = { kind: viewer.kind, name: viewer.name, email: viewer.email, acting_as: viewer.acting_as || null };
    if (ids !== 'all') { if (!ids.length) return res.json({ communities: [], viewer: viewerOut }); q = q.in('id', ids); }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ communities: data || [], viewer: viewerOut });
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
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });

    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, legal_name, slug')
      .eq('id', communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Aggregate over v_property_summary — single trip, no N+1
    const { data: rows, error: rErr } = await supabase
      .from('v_property_summary')
      .select('property_id, open_violations, worst_open_stage, owner_occupied, residency_type, arc_decisions_count, arc_approved_count, arc_denied_count, interactions_count')
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
    const totalArcApproved = safeRows.reduce((s, r) => s + (r.arc_approved_count || 0), 0);
    const totalArcDenied = safeRows.reduce((s, r) => s + (r.arc_denied_count || 0), 0);

    // Phase 2 — board dashboard data (curated > comprehensive principle).
    // All of these are best-effort: if a sub-source fails, we still return
    // the rest. Boards see what's available, not a 500.
    let arAging = null;
    try {
      // NOTE: This surface intentionally reads owner_ar_snapshots, NOT the
      // unified resolveCurrentAR. The board's AR rollup needs at_legal /
      // in_collections / payment_plan_active enforcement signals, which
      // only exist on snapshots today. When the enforcement_state table
      // gets built, this will migrate to the unified pipeline.
      //
      // BUG FIX (Ed 2026-06-08 cleanup audit): property_id was missing
      // from the SELECT, which made the dedupe key fall back to
      // `snapshot_date + '|' + balance_total`. Properties with the same
      // balance on the same snapshot date were silently collapsed,
      // undercounting AR aging numbers shown to boards. Added property_id
      // to the SELECT and the dedupe key.
      // AR aging rollup. CANONICAL source = v_homeowner_current_balance — the
      // SAME ledger the AR detail list and the accounting screens read. The old
      // code read owner_ar_snapshots FIRST and only fell back to the ledger when
      // there were ZERO snapshot rows. But a Vantaca-migrated community can have
      // a few legacy collections rows in owner_ar_snapshots (Waterview had 3, at
      // $31,567.56), so the board's Financial Health card showed "$32K · 3 past-
      // due · 1 at legal" while the real AR was $251,838 across 290 accounts.
      // Prefer the ledger; use owner_ar_snapshots ONLY when the ledger is empty.
      // At-legal / collections flags come from the enforcement SSOT
      // (property_enforcement_states), not the stale snapshot. (Ed 2026-08-10.)
      const { fetchAllQuery } = require('../lib/db/fetch_all');
      const bals = await fetchAllQuery(() => supabase.from('v_homeowner_current_balance')
        .select('property_id, balance_cents').eq('community_id', communityId), { orderBy: 'property_id' });
      const ledger = bals.filter((b) => b.property_id);   // roster only (drop null-property rows)
      if (ledger.length) {
        const owing = ledger.filter((b) => Number(b.balance_cents) > 0);
        const { data: esRows } = await supabase.from('property_enforcement_states')
          .select('property_id, state').eq('community_id', communityId).is('ended_at', null).limit(5000);
        const es = esRows || [];
        arAging = {
          owners_current: ledger.filter((b) => Number(b.balance_cents) <= 0).length,
          owners_past_due: owing.length,
          owners_at_legal: es.filter((c) => ['at_legal', 'lien_filed', 'judgment', 'foreclosure'].includes(c.state)).length,
          owners_in_collections: es.filter((c) => c.state === 'in_collections').length,
          owners_with_payment_plan: es.filter((c) => c.state === 'on_payment_plan').length,
          total_outstanding_cents: owing.reduce((s, b) => s + Number(b.balance_cents || 0), 0), // already cents
        };
      } else {
        // No transaction ledger for this community — legacy owner_ar_snapshots.
        const { data: arRows } = await supabase.from('owner_ar_snapshots')
          .select('property_id, balance_total, at_legal, in_collections, payment_plan_active, snapshot_date')
          .eq('community_id', communityId).order('snapshot_date', { ascending: false }).limit(5000);
        const seen = new Set(); const latest = [];
        for (const r of (arRows || [])) { if (!r.property_id || seen.has(r.property_id)) continue; seen.add(r.property_id); latest.push(r); }
        const owing = latest.filter((r) => (r.balance_total || 0) > 0);
        arAging = {
          owners_current: latest.filter((r) => (r.balance_total || 0) <= 0).length,
          owners_past_due: owing.length,
          owners_at_legal: latest.filter((r) => r.at_legal === true).length,
          owners_in_collections: latest.filter((r) => r.in_collections === true).length,
          owners_with_payment_plan: latest.filter((r) => r.payment_plan_active === true).length,
          total_outstanding_cents: Math.round(latest.reduce((s, r) => s + (Number(r.balance_total) > 0 ? Number(r.balance_total) : 0), 0) * 100),
        };
      }
    } catch (e) {
      console.warn('[board_portal] AR aging skipped:', e.message);
    }

    // Reserve health — from the community-level reserve summary view
    let reserveHealth = null;
    try {
      const { data: rh } = await supabase
        .from('v_reserve_community_summary')
        .select('active_components, total_current_cost_cents, total_future_cost_cents, critical_2yr_count, soon_5yr_count, spent_last_12mo_cents')
        .eq('community_id', communityId)
        .maybeSingle();
      if (rh) reserveHealth = rh;
    } catch (e) {
      console.warn('[board_portal] reserve health skipped:', e.message);
    }

    // DRV breakdown by stage — counts of currently-open violations per stage
    let drvByStage = null;
    let drvAtAttorney = 0; // separate axis — a case at attorney is ALSO at a stage
    try {
      const { data: drv } = await supabase
        .from('interactions')
        .select('current_stage')
        .eq('community_id', communityId)
        .eq('service_type', 'enforcement')
        .neq('status', 'resolved')
        .neq('status', 'voided');
      const buckets = { courtesy_1: 0, courtesy_2: 0, certified_209: 0, fine_assessed: 0 };
      (drv || []).forEach(r => {
        if (r.current_stage in buckets) buckets[r.current_stage]++;
      });
      drvByStage = buckets;
      // Deed-restriction cases referred to the association's attorney — the
      // enforcement-side "at attorney", distinct from collections-at-legal above.
      // Sourced from violations.sent_to_attorney_at (the SSOT). Kept OUT of the
      // stage buckets: a case at attorney is also at a stage, so folding it in
      // would double-count the drvTotal the board tile sums.
      try {
        const { count } = await supabase.from('violations')
          .select('id', { count: 'exact', head: true })
          .eq('community_id', communityId)
          .not('sent_to_attorney_at', 'is', null)
          .is('resolved_at', null)
          .not('current_stage', 'in', '(cured,closed,voided)');
        drvAtAttorney = count || 0;
      } catch (e2) { console.warn('[board_portal] DRV at-attorney count skipped:', e2.message); }
    } catch (e) {
      console.warn('[board_portal] DRV breakdown skipped:', e.message);
    }

    // ARC pipeline — open resident applications + open builder applications
    let arcPipeline = null;
    try {
      const [{ data: residentApps }, { data: builderApps }] = await Promise.all([
        supabase
          .from('arc_applications')
          .select('id, created_at, status')
          .eq('community_id', communityId)
          .in('status', ['submitted', 'under_review', 'pending_info']),
        supabase
          .from('builder_applications')
          .select('id, created_at, status')
          .eq('community_id', communityId)
          .in('status', ['submitted', 'under_review', 'pending_info']),
      ]);
      const open = [...(residentApps || []), ...(builderApps || [])];
      const oldestAgeDays = open.length
        ? Math.floor((Date.now() - Math.min(...open.map(a => new Date(a.created_at).getTime()))) / 86400000)
        : null;
      arcPipeline = {
        open_resident: (residentApps || []).length,
        open_builder: (builderApps || []).length,
        open_total: open.length,
        oldest_age_days: oldestAgeDays,
      };
    } catch (e) {
      console.warn('[board_portal] ARC pipeline skipped:', e.message);
    }

    // Recent board meetings — last 3 minutes documents
    let recentMeetings = null;
    try {
      const { data: docs } = await supabase
        .from('library_documents')
        .select('id, title, effective_date, category')
        .eq('community_id', communityId)
        .in('category', ['regular_meeting_minutes', 'annual_board_meeting_minutes'])
        .order('effective_date', { ascending: false, nullsFirst: false })
        .limit(3);
      recentMeetings = (docs || []).map(d => ({
        id: d.id, title: d.title, date: d.effective_date, category: d.category,
      }));
    } catch (e) {
      console.warn('[board_portal] recent meetings skipped:', e.message);
    }

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
        arc_approved_total: totalArcApproved,
        arc_denied_total: totalArcDenied,
      },
      // Phase 2 dashboard cards
      ar_aging: arAging,
      reserve_health: reserveHealth,
      drv_by_stage: drvByStage,
      drv_at_attorney: drvAtAttorney,
      arc_pipeline: arcPipeline,
      recent_meetings: recentMeetings,
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
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });
    const openOnly = req.query.open_only === '1';
    const balanceOnly = req.query.balance_only === '1'; // AR view: only accounts that owe
    const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || '500', 10)));
    const orderBy = req.query.order_by || 'open_violations_desc';

    // Canonical current balance lives in v_homeowner_current_balance (cents) —
    // the SAME source the summary rollup uses. v_property_summary.current_balance
    // is NULL for native-ledger (Vantaca-migrated) communities like Waterview, so
    // the board AR view read $0 while $265k was actually owed. Source the balance
    // from the canonical view and overlay it (cents -> dollars, matching the
    // display), so every community's AR is correct and consistent. (Ed 2026-08-10
    // SSOT: one balance source, not a per-view copy that drifts.)
    const { fetchAllQuery } = require('../lib/db/fetch_all');
    const balRows = await fetchAllQuery(() => supabase
      .from('v_homeowner_current_balance')
      .select('property_id, balance_cents')
      .eq('community_id', communityId), { orderBy: 'property_id' });
    // Drop rows with no property_id (unmatched transactions can surface a null
    // key in the balance view — a null in a later .in() throws a uuid error).
    const balValid = balRows.filter((b) => b.property_id);
    const balByProp = new Map(balValid.map((b) => [b.property_id, Number(b.balance_cents) || 0]));
    const balanceDollars = (r) => {
      const cents = balByProp.has(r.property_id)
        ? balByProp.get(r.property_id)
        : (r.current_balance != null ? Math.round(Number(r.current_balance) * 100) : 0);
      return cents / 100;
    };

    const COLS = `
      property_id, street_address, unit, owner_name, residency_type,
      owner_occupied, open_violations, worst_open_stage,
      lifetime_violations, violations_last_12mo, last_violation_at,
      arc_decisions_count, arc_approved_count, arc_denied_count,
      last_arc_decided_at, interactions_count, last_interaction_at,
      substrate_doc_count, inspections_count, last_inspected_at,
      current_balance`;

    let rows;
    if (balanceOnly) {
      // Drive the AR view off the canonical owing set so nothing is missed at
      // scale (never off v_property_summary's stale balance).
      const owingIds = balValid.filter((b) => (Number(b.balance_cents) || 0) > 0).map((b) => b.property_id);
      rows = [];
      for (let i = 0; i < owingIds.length; i += 300) {
        const { data, error } = await supabase.from('v_property_summary').select(COLS)
          .eq('community_id', communityId).in('property_id', owingIds.slice(i, i + 300));
        if (error) throw error;
        rows.push(...(data || []));
      }
      rows = rows.map((r) => ({ ...r, current_balance: balanceDollars(r) }))
        .filter((r) => Number(r.current_balance) > 0);
      rows.sort((a, b) => Number(b.current_balance) - Number(a.current_balance));
    } else {
      let q = supabase.from('v_property_summary').select(COLS).eq('community_id', communityId).limit(2000);
      if (openOnly) q = q.gt('open_violations', 0);
      switch (orderBy) {
        case 'address': q = q.order('street_address', { ascending: true }); break;
        case 'last_violation_desc': q = q.order('last_violation_at', { ascending: false, nullsFirst: false }); break;
        case 'balance_desc': break; // sorted after the overlay below
        case 'open_violations_desc':
        default:
          q = q.order('open_violations', { ascending: false }).order('last_violation_at', { ascending: false, nullsFirst: false });
          break;
      }
      const { data, error } = await q;
      if (error) throw error;
      // Overlay the canonical balance on every view so the number shown is
      // correct everywhere it appears (Properties search, etc.), not just AR.
      rows = (data || []).map((r) => ({ ...r, current_balance: balanceDollars(r) }));
      if (orderBy === 'balance_desc') rows.sort((a, b) => Number(b.current_balance) - Number(a.current_balance));
    }

    res.json({ properties: rows.slice(0, limit) });
  } catch (err) {
    console.error('[board_portal] community properties failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /community/:id/ar-categorized — owing accounts grouped by escalation stage:
//   1) At legal      — with collections counsel (enforcement SSOT)
//   2) Certified §209 — certified demand sent, with a 30-day clock: eligible for
//                       legal once >30 days have passed, "not yet" under 30
//   3) Remaining      — past-due, not yet escalated
// Each category totals its balances. Balance is the canonical ledger; stage comes
// from property_enforcement_states (legal) + ar_account_collections (certified).
// (Ed 2026-08-10.)
// ----------------------------------------------------------------------------
router.get('/community/:id/ar-categorized', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });
    const { fetchAllQuery } = require('../lib/db/fetch_all');

    // Owing accounts from the canonical ledger.
    const bals = await fetchAllQuery(() => supabase.from('v_homeowner_current_balance')
      .select('property_id, balance_cents').eq('community_id', communityId), { orderBy: 'property_id' });
    const owing = new Map();
    for (const b of bals) { if (b.property_id && Number(b.balance_cents) > 0) owing.set(b.property_id, Number(b.balance_cents)); }
    const ids = [...owing.keys()];

    // Address + owner for those properties.
    const meta = new Map();
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await supabase.from('v_property_summary')
        .select('property_id, street_address, unit, owner_name, open_violations, worst_open_stage')
        .eq('community_id', communityId).in('property_id', ids.slice(i, i + 300));
      for (const r of (data || [])) meta.set(r.property_id, r);
    }

    // Enforcement state (legal) + collections status (certified) per property.
    const { data: esRows } = await supabase.from('property_enforcement_states')
      .select('property_id, state, effective_at, attorney_firm').eq('community_id', communityId).is('ended_at', null).limit(5000);
    const esByProp = new Map((esRows || []).map((e) => [e.property_id, e]));
    let collByProp = new Map();
    try {
      const { data: coll } = await supabase.from('ar_account_collections')
        .select('property_id, collection_status, status_since').eq('community_id', communityId).neq('collection_status', 'none').limit(5000);
      collByProp = new Map((coll || []).map((c) => [c.property_id, c]));
    } catch (_) { /* table may be empty */ }

    const LEGAL_STATES = new Set(['at_legal', 'lien_filed', 'judgment']);
    const today = new Date();
    const daysSince = (d) => { if (!d) return null; const t = new Date(d + (String(d).length === 10 ? 'T00:00:00Z' : '')); return isNaN(t) ? null : Math.floor((today - t) / 86400000); };

    const atLegal = [], certified = [], remaining = [];
    for (const pid of ids) {
      const m = meta.get(pid) || {};
      const es = esByProp.get(pid); const c = collByProp.get(pid);
      const base = { property_id: pid, street_address: m.street_address || null, unit: m.unit || null, owner_name: m.owner_name || null, balance_cents: owing.get(pid), open_violations: m.open_violations || 0, worst_open_stage: m.worst_open_stage || null };
      const legal = (es && LEGAL_STATES.has(es.state)) || (c && c.collection_status === 'with_attorney');
      const isCertified = c && c.collection_status === 'certified_demand';
      if (legal) {
        atLegal.push({ ...base, legal_state: (es && es.state) || 'with_attorney', attorney_firm: (es && es.attorney_firm) || null });
      } else if (isCertified) {
        const days = daysSince(c.status_since);
        certified.push({ ...base, certified_date: c.status_since || null, days_since_certified: days, eligible_for_legal: days != null && days > 30 });
      } else {
        remaining.push(base);
      }
    }
    const sortBal = (a, b) => b.balance_cents - a.balance_cents;
    atLegal.sort(sortBal); certified.sort(sortBal); remaining.sort(sortBal);
    const total = (arr) => arr.reduce((s, x) => s + x.balance_cents, 0);

    res.json({
      categories: [
        { key: 'at_legal', label: 'At legal', count: atLegal.length, total_cents: total(atLegal), accounts: atLegal },
        { key: 'certified', label: 'Certified §209 sent', count: certified.length, total_cents: total(certified),
          eligible_count: certified.filter((x) => x.eligible_for_legal).length, accounts: certified },
        { key: 'remaining', label: 'Remaining past-due', count: remaining.length, total_cents: total(remaining), accounts: remaining },
      ],
      grand_total_cents: total(atLegal) + total(certified) + total(remaining),
      total_owing_accounts: ids.length,
    });
  } catch (err) {
    console.error('[board_portal] ar-categorized failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/property/:id
// Single property detail: summary + recent ARC + recent interactions + linked docs
// ----------------------------------------------------------------------------
router.get('/property/:id', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const propertyId = req.params.id;

    // Authorize by the property's OWN community — a board member of one community
    // must not read a property in another. Look it up before returning anything.
    const { data: prop, error: pErr } = await supabase
      .from('properties').select('community_id').eq('id', propertyId).maybeSingle();
    if (pErr) throw pErr;
    if (!prop) return res.status(404).json({ error: 'property_not_found' });
    if (!canSeeCommunity(viewer, prop.community_id)) return res.status(403).json({ error: 'forbidden_community' });

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
      .is('resolved_at', null)   // resolved_at IS NULL = the true open flag (cured rows keep their stage)
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

// ----------------------------------------------------------------------------
// GET /api/board-portal/board-members?q=   (STAFF ONLY)
//   Look up board members by name so a manager can preview a member's board
//   view from their own seat. Never available to a board member.
// ----------------------------------------------------------------------------
router.get('/board-members', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    if (viewer.kind !== 'staff') return res.status(403).json({ error: 'staff_only' });
    const q = String(req.query.q || '').trim();
    let query = supabase.from('board_members')
      .select('name, email, community_name, position, community_id')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).eq('is_active', true)
      .not('email', 'is', null).order('name', { ascending: true }).limit(25);
    if (q) query = query.ilike('name', `%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ members: data || [] });
  } catch (err) { console.error('[board_portal] board-members failed:', err.message); res.status(500).json({ error: err.message }); }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/community/:id/year?year=YYYY
//   The annual project roadmap: live/active projects (with dates + health) PLUS
//   expected projects for the year from the reserve study (components scheduled
//   for replacement). One visual snapshot of the whole year for the board.
// ----------------------------------------------------------------------------
router.get('/community/:id/year', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    const { data: community } = await supabase.from('communities').select('id, name').eq('id', communityId).maybeSingle();

    // Live/active projects (anything not cancelled).
    const { data: projects, error: pErr } = await supabase.from('vendor_projects')
      .select('*').eq('community_id', communityId).neq('stage', 'cancelled')
      .order('target_date', { ascending: true }).limit(500);
    if (pErr) throw pErr;
    const ids = (projects || []).map((p) => p.id);
    const byProj = {};
    if (ids.length) {
      const { data: ms } = await supabase.from('project_milestones').select('*').in('project_id', ids).order('sort_order', { ascending: true });
      for (const m of (ms || [])) (byProj[m.project_id] = byProj[m.project_id] || []).push(m);
    }
    const { boardProjectView } = require('../lib/projects/board_view');
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const active = [];
    for (const p of (projects || [])) active.push(await boardProjectView(supabase, p, byProj[p.id] || [], todayISO));

    // Expected projects for the year — from the reserve study (components due for
    // replacement this year). Year-level (no exact date), with projected cost.
    let planned = [];
    try {
      const { data: rc } = await supabase.from('reserve_components')
        .select('component_name, future_cost_estimate_cents, current_cost_estimate_cents, next_scheduled_replacement_year')
        .eq('community_id', communityId).eq('next_scheduled_replacement_year', year)
        .order('component_name', { ascending: true }).limit(300);
      planned = (rc || []).map((r) => ({ name: r.component_name, cost_cents: (r.future_cost_estimate_cents != null ? r.future_cost_estimate_cents : r.current_cost_estimate_cents), year }));
    } catch (_) { /* no reserve study — just show active */ }

    const sumCents = (arr, key) => arr.reduce((s, x) => s + (Number(x[key]) || 0), 0);
    res.json({
      community: community ? { id: community.id, name: community.name } : { id: communityId, name: '' },
      year,
      active,
      planned,
      summary: {
        active: active.length,
        planned: planned.length,
        planned_cost_cents: sumCents(planned, 'cost_cents'),
        active_budget_cents: sumCents(active, 'budget_cents'),
      },
    });
  } catch (err) { console.error('[board_portal] year failed:', err.message); res.status(500).json({ error: err.message }); }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/community/:id/projects
//   Board accountability view of the community's annual/capital projects:
//   budget vs live actual spend, schedule health, milestones, next action.
//   Read-only. (Ed 2026-07-27 — a board upset about project accountability.)
// ----------------------------------------------------------------------------
router.get('/community/:id/projects', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });
    const { data: community, error: cErr } = await supabase
      .from('communities').select('id, name')
      .eq('id', communityId).eq('management_company_id', BEDROCK_MGMT_CO_ID).maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    const { data: projects, error: pErr } = await supabase
      .from('vendor_projects').select('*')
      .eq('community_id', communityId)
      .order('created_at', { ascending: false }).limit(500);
    if (pErr) throw pErr;

    // Milestones for all these projects in one trip.
    const ids = (projects || []).map((p) => p.id);
    let byProject = {};
    if (ids.length) {
      const { data: ms } = await supabase.from('project_milestones')
        .select('*').in('project_id', ids).order('sort_order', { ascending: true }).limit(2000);
      for (const m of (ms || [])) (byProject[m.project_id] = byProject[m.project_id] || []).push(m);
    }

    const { boardProjectView } = require('../lib/projects/board_view');
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const rows = [];
    for (const p of (projects || [])) rows.push(await boardProjectView(supabase, p, byProject[p.id] || [], todayISO));

    // Worst-health first, so what needs attention is at the top.
    const order = { behind: 0, stalled: 1, at_risk: 2, on_track: 3, no_target: 4, complete: 5 };
    rows.sort((a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9));

    const active = rows.filter((r) => r.health !== 'complete');
    res.json({
      community: { id: community.id, name: community.name },
      as_of: todayISO,
      summary: {
        total: rows.length,
        active: active.length,
        needs_attention: rows.filter((r) => ['behind', 'stalled', 'at_risk'].includes(r.health)).length,
        over_budget: rows.filter((r) => r.over_budget).length,
      },
      projects: rows,
    });
  } catch (err) {
    console.error('[board_portal] projects failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/community/:id/arc
//   Read-only ARC decisions for the board — "see what was approved," oversight
//   without touching management's processing. From arc_historical_decisions.
// ----------------------------------------------------------------------------
router.get('/community/:id/arc', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });

    // Decided — imported ARC history. Each source is best-effort so a missing
    // or oddly-shaped table can't 500 the whole board view.
    let decided = [];
    try {
      const { data, error } = await supabase.from('arc_historical_decisions')
        .select('property_address, homeowner_name, project_type, project_description, decision_type, decided_at, conditions')
        .eq('community_id', communityId).order('decided_at', { ascending: false, nullsFirst: false }).limit(300);
      if (error) throw error;
      decided = (data || []).map((r) => ({ address: r.property_address, who: r.homeowner_name, project: r.project_type || r.project_description, decision: r.decision_type, date: r.decided_at, conditions: r.conditions }));
    } catch (e) { console.warn('[board_portal] arc decided skipped:', e.message); }

    // Pending — resident ACC in review + builder applications not yet decided.
    let pending = [];
    try {
      const { data: acc, error } = await supabase.from('acc_decisions')
        .select('homeowner_address, homeowner_name, project_summary, created_at')
        .eq('community_id', communityId).eq('status', 'pending_review').limit(200);
      if (error) throw error;
      for (const r of (acc || [])) pending.push({ address: r.homeowner_address, who: r.homeowner_name, project: r.project_summary, date: r.created_at, kind: 'resident' });
    } catch (e) { console.warn('[board_portal] arc pending acc skipped:', e.message); }
    try {
      const { data: bld, error } = await supabase.from('builder_applications')
        .select('street_address, submitter_name, plan_name, plan_number, submitted_at, created_at')
        .eq('community_id', communityId).eq('status', 'received').limit(200);
      if (error) throw error;
      for (const r of (bld || [])) pending.push({ address: r.street_address, who: r.submitter_name, project: r.plan_name || (r.plan_number ? `Plan ${r.plan_number}` : 'New construction'), date: r.submitted_at || r.created_at, kind: 'builder' });
    } catch (e) { console.warn('[board_portal] arc pending builder skipped:', e.message); }
    pending.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

    const approved = decided.filter((d) => /approv/i.test(d.decision || '')).length;
    const denied = decided.filter((d) => /deni/i.test(d.decision || '')).length;
    res.json({ pending, decided, summary: { pending: pending.length, decided: decided.length, approved, denied } });
  } catch (err) {
    console.error('[board_portal] arc failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/community/:id/violations
//   Board violations view: what was issued last month, who's at legal, and the
//   open cases grouped by stage (certified §209 / fined / courtesy). Summary +
//   openable groupings, not a flat 368-row list.
// ----------------------------------------------------------------------------
router.get('/community/:id/violations', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });

    const byId = {};
    // Open-violation properties, grouped by worst stage.
    const groups = { certified_209: [], fine_assessed: [], courtesy: [] };
    try {
      const { data: props, error } = await supabase.from('v_property_summary')
        .select('property_id, street_address, owner_name, open_violations, worst_open_stage')
        .eq('community_id', communityId).gt('open_violations', 0)
        .order('open_violations', { ascending: false }).limit(2000);
      if (error) throw error;
      for (const p of (props || [])) {
        byId[p.property_id] = p;
        const it = { property_id: p.property_id, address: p.street_address, owner: p.owner_name, open: p.open_violations, stage: p.worst_open_stage };
        if (p.worst_open_stage === 'certified_209') groups.certified_209.push(it);
        else if (p.worst_open_stage === 'fine_assessed') groups.fine_assessed.push(it);
        else groups.courtesy.push(it);
      }
    } catch (e) { console.warn('[board_portal] violations props skipped:', e.message); }

    // At legal — active attorney referrals.
    let atLegal = [];
    try {
      const { data: pes, error } = await supabase.from('property_enforcement_states')
        .select('property_id, effective_at, attorney_firm, attorney_name')
        .eq('community_id', communityId).eq('state', 'at_legal').is('ended_at', null).limit(300);
      if (error) throw error;
      const missing = (pes || []).map((r) => r.property_id).filter((id) => id && !byId[id]);
      if (missing.length) {
        const { data: extra } = await supabase.from('v_property_summary').select('property_id, street_address, owner_name').in('property_id', missing);
        (extra || []).forEach((p) => { byId[p.property_id] = byId[p.property_id] || p; });
      }
      atLegal = (pes || []).map((r) => ({ property_id: r.property_id, address: (byId[r.property_id] || {}).street_address, owner: (byId[r.property_id] || {}).owner_name, since: r.effective_at, attorney: r.attorney_firm || r.attorney_name }));
    } catch (e) { console.warn('[board_portal] violations at-legal skipped:', e.message); }

    // Issued in the last month — stage changes (letters/notices) in 30 days.
    let recent = [];
    try {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: vs, error } = await supabase.from('violations')
        .select('property_id, current_stage, current_stage_started_at, opened_at, enforcement_categories:primary_category_id(label)')
        .eq('community_id', communityId).gte('current_stage_started_at', cutoff)
        .order('current_stage_started_at', { ascending: false }).limit(400);
      if (error) throw error;
      const missing = (vs || []).map((r) => r.property_id).filter((id) => id && !byId[id]);
      if (missing.length) {
        const { data: extra } = await supabase.from('v_property_summary').select('property_id, street_address').in('property_id', missing);
        (extra || []).forEach((p) => { byId[p.property_id] = byId[p.property_id] || p; });
      }
      recent = (vs || []).map((r) => ({ property_id: r.property_id, address: (byId[r.property_id] || {}).street_address, category: (r.enforcement_categories || {}).label, stage: r.current_stage, date: r.current_stage_started_at || r.opened_at }));
    } catch (e) { console.warn('[board_portal] violations recent skipped:', e.message); }

    res.json({
      summary: {
        open_properties: groups.certified_209.length + groups.fine_assessed.length + groups.courtesy.length,
        certified: groups.certified_209.length, fined: groups.fine_assessed.length, courtesy: groups.courtesy.length,
        at_legal: atLegal.length, issued_last_month: recent.length,
      },
      groups: { at_legal: atLegal, certified_209: groups.certified_209, fine_assessed: groups.fine_assessed, courtesy: groups.courtesy },
      recent,
    });
  } catch (err) {
    console.error('[board_portal] violations failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/board-portal/community/:id/meetings
//   Read-only board view of minutes + agendas on file. Each source best-effort.
// ----------------------------------------------------------------------------
router.get('/community/:id/meetings', async (req, res) => {
  try {
    const viewer = await requireBoardViewer(req, res);
    if (!viewer) return;
    const communityId = req.params.id;
    if (!canSeeCommunity(viewer, communityId)) return res.status(403).json({ error: 'forbidden_community' });

    let minutes = [];
    // Minutes drafted/finalized in-platform.
    try {
      const { data, error } = await supabase.from('meeting_minutes')
        .select('id, meeting_date, meeting_type, title, status, rendered_document_id')
        .eq('community_id', communityId).eq('status', 'final')
        .order('meeting_date', { ascending: false, nullsFirst: false }).limit(100);
      if (error) throw error;
      for (const r of (data || [])) minutes.push({ date: r.meeting_date, type: (r.meeting_type || 'regular').replace(/_/g, ' '), title: r.title || 'Meeting minutes', doc_id: r.rendered_document_id, source: 'minutes' });
    } catch (e) { console.warn('[board_portal] meetings/minutes skipped:', e.message); }
    // Imported minutes docs.
    try {
      const { data, error } = await supabase.from('library_documents')
        .select('id, title, effective_date, category')
        .eq('community_id', communityId).in('category', ['regular_meeting_minutes', 'annual_board_meeting_minutes', 'special_meeting_minutes', 'board_meeting_minutes'])
        .order('effective_date', { ascending: false, nullsFirst: false }).limit(100);
      if (error) throw error;
      for (const r of (data || [])) minutes.push({ date: r.effective_date, type: String(r.category || '').replace(/_/g, ' ').replace(/minutes$/, '').trim() || 'meeting', title: r.title || 'Meeting minutes', doc_id: r.id, source: 'document' });
    } catch (e) { console.warn('[board_portal] meetings/library skipped:', e.message); }
    minutes.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

    let agendas = [];
    try {
      const { data, error } = await supabase.from('meeting_agendas')
        .select('id, meeting_date, title, status')
        .eq('community_id', communityId).order('meeting_date', { ascending: false, nullsFirst: false }).limit(50);
      if (error) throw error;
      agendas = (data || []).map((r) => ({ date: r.meeting_date, title: r.title || 'Agenda', status: r.status }));
    } catch (e) { console.warn('[board_portal] meetings/agendas skipped:', e.message); }

    res.json({ minutes, agendas });
  } catch (err) {
    console.error('[board_portal] meetings failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
