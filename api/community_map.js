// ============================================================================
// Community Map API
// ----------------------------------------------------------------------------
// Powers the per-community map surface (project_community_map.md, designed
// 2026-05-28). One map per community with filterable layers: occupancy,
// AR/collections, DRV/violations, ACC/ARC. Click a property pin → side
// panel with owner + status detail.
//
// SECURITY POSTURE
// ----------------
// Staff-gated for now (existing global STAFF_GATE middleware in server.js).
// When board-portal auth ships (Phase 4), the same endpoints will accept
// board sessions with these additional protections:
//
//   - Community scoping: board session token carries a community_id; any
//     request for a different community_id returns 403.
//   - Response projection: board responses use BOARD_PROPERTY_FIELDS which
//     strips Bedrock workpaper fields (internal interaction notes, draft
//     letters, email-triage classifications, etc.) before returning.
//   - Confidentiality ack required: every request checks
//     v_active_community_map_acks; if no active ack exists for this
//     user+community, returns 428 Precondition Required so the frontend
//     can surface the ack flow.
//   - Watermarking: response includes a watermark string the frontend
//     overlays on the map canvas (low-opacity viewer name + timestamp).
//
// All accesses (staff and board) write to community_map_access_log so the
// audit trail exists uniformly. See migration 121.
//
// Endpoints
// ---------
//   GET    /:communityId/layers
//   GET    /property/:propertyId
//   POST   /acknowledge
//   GET    /acknowledge/status?community_id=
//
// Mounted at /api/community-map in server.js.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { getActingUser, actorDisplayName } = require('./_acting_user');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const router = express.Router();

// Layer keys recognized by GET /:communityId/layers. Unknown keys are
// silently dropped (forgiving rather than 400 — the frontend may be ahead
// of the backend on a deploy).
const VALID_LAYERS = new Set(['occupancy', 'ar', 'drv', 'acc']);

// Acknowledgment policy. Bumping ACK_VERSION forces every user to re-ack
// before the next access (frontend reads /acknowledge/status, sees expired,
// surfaces the modal). Keep the text changes minor between versions or
// communicate the bump to staff first.
const ACK_VERSION = 1;
const ACK_TEXT = [
  'I acknowledge the data on this map — including ownership, residency, account-receivable status, and enforcement history — is confidential association business under my fiduciary duty as a board member (or Bedrock staff acting on the association\'s behalf).',
  'I understand executive-session matters under TX Property Code §209.0051(e) include owner delinquency and enforcement information shown here.',
  'I will not share this view, screenshots, or any data shown with anyone outside the association\'s board or its authorized management agents. Every property-click is logged with my identity and timestamp.',
].join('\n\n');
const ACK_TEXT_HASH = crypto.createHash('sha256').update(`${ACK_VERSION}|${ACK_TEXT}`).digest('hex');

// Quarterly re-ack default. The endpoint sets expires_at = acked_at + 90d.
const ACK_TTL_DAYS = 90;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function bucketAr(row) {
  // Maps the AR snapshot row onto a five-state bucket the map UI colors by.
  // Order of precedence matters — a property "in collections" might also
  // have a 60-day bucket, but the more-severe state wins for the pin color.
  if (!row || row.current_balance == null) return 'unknown';
  if (row.ar_in_collections) return 'in_collections';
  if (row.ar_at_legal) return 'at_legal';
  if ((row.current_balance || 0) <= 0) return 'current';
  if ((row.ar_bucket_over_120 || 0) > 0) return 'over_120';
  if ((row.ar_bucket_91_120 || 0) > 0) return 'bucket_91_120';
  if ((row.ar_bucket_61_90 || 0) > 0) return 'bucket_61_90';
  if ((row.ar_bucket_31_60 || 0) > 0) return 'bucket_31_60';
  if ((row.ar_bucket_0_30 || 0) > 0) return 'bucket_0_30';
  // Has a balance but no aging detail — treat as past_due bucket
  if ((row.current_balance || 0) > 0) return 'past_due';
  return 'current';
}

function statusDrv(row) {
  // Coarse DRV state for the map color. Matches worst_open_stage from the view.
  if (!row || (row.open_violations || 0) === 0) return 'none';
  const stage = row.worst_open_stage;
  if (stage === 'fine_assessed') return 'in_fine';
  if (stage === 'certified_209') return 'certified_209';
  if (stage === 'courtesy_2' || stage === 'courtesy_1') return 'open';
  return 'open';
}

function statusOccupancy(row) {
  if (!row) return 'unknown';
  if (row.residency_type === 'owner_occupied') return 'owner_occupied';
  if (row.residency_type === 'renter') return 'renter';
  if (row.residency_type === 'family_member') return 'family_member';
  if (row.residency_type === 'vacant') return 'vacant';
  return 'unknown';
}

// Captures (and writes asynchronously) one row to community_map_access_log.
// Failure is non-fatal — we log the warn but don't 500 the user-facing request.
async function logAccess({ req, actor, communityId, propertyId, action, layers }) {
  try {
    const row = {
      community_id: communityId || null,
      property_id: propertyId || null,
      acted_by_user_id: actor ? actor.id : null,
      actor_display_name: actor ? actorDisplayName(actor) : null,
      // Staff is the only auth path today; when board auth ships, the caller
      // passes 'board_member' explicitly. Defensive default avoids future
      // mis-tagging if a new auth path forgets to set this.
      actor_role: 'staff',
      action,
      layers_requested: Array.isArray(layers) && layers.length > 0 ? layers : null,
      request_ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
                  || (req.socket && req.socket.remoteAddress)
                  || null,
      user_agent: (req.headers['user-agent'] || '').toString().slice(0, 500),
    };
    const { error } = await supabase.from('community_map_access_log').insert(row);
    if (error) console.warn('[community-map] access log insert failed:', error.message);
  } catch (e) {
    console.warn('[community-map] access log threw:', e.message);
  }
}

// Quick lookup — does this user have an unexpired ack for this community
// (or a portfolio-wide ack with community_id NULL)?
async function userHasActiveAck(userId, communityId) {
  if (!userId) return true; // legacy paths without JWT — gate by staff middleware only
  try {
    const { data, error } = await supabase
      .from('v_active_community_map_acks')
      .select('user_id, community_id, ack_version')
      .eq('user_id', userId)
      .or(`community_id.eq.${communityId},community_id.is.null`);
    if (error) {
      console.warn('[community-map] ack check failed:', error.message);
      return true; // soft-fail open for now; tighten in board-auth phase
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn('[community-map] ack check threw:', e.message);
    return true;
  }
}

// ----------------------------------------------------------------------------
// GET /:communityId/layers
// ----------------------------------------------------------------------------
// Returns one row per property in the community with the layer flags the
// frontend uses to color pins. Always returns ALL flags — filtering is
// purely visual on the frontend. Cheaper than re-querying as the user
// toggles chips, and the response is bounded (largest community is
// ~1200 properties × ~25 numeric fields = trivial payload).
//
// Query params:
//   include: comma-list of layer keys (occupancy,ar,drv,acc). Optional —
//            currently advisory only (every layer is returned regardless)
//            but logged to the access record so audits can reconstruct
//            what the user was actually looking at.
//   include_ungeocoded: '1' includes properties without lat/lng (for
//            debugging / coverage reports). Default excludes them since
//            they can't be drawn on a map.
// ----------------------------------------------------------------------------
router.get('/:communityId/layers', async (req, res) => {
  try {
    const communityId = req.params.communityId;
    if (!communityId) return res.status(400).json({ error: 'community_id_required' });

    const actor = await getActingUser(req);

    // Validate community exists + is in our management company.
    const { data: community, error: cErr } = await supabase
      .from('communities')
      .select('id, name, slug')
      .eq('id', communityId)
      .eq('management_company_id', BEDROCK_MGMT_CO_ID)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    // Parse + validate the include layers list (for audit logging).
    const includeParam = (req.query.include || '').toString();
    const requestedLayers = includeParam
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => VALID_LAYERS.has(s));
    const includeUngeocoded = req.query.include_ungeocoded === '1';

    // One query — every property in the community joined to its summary row.
    // v_property_summary already aggregates AR + violations + ARC + interactions.
    // Hard cap at 5000 for safety even though no community is close to that.
    let q = supabase
      .from('v_property_summary')
      .select(`
        property_id, community_id, community_name,
        street_address, unit, city, state, zip, lot_number, property_type,
        owner_contact_id, owner_name,
        residency_type, lease_end_date, owner_occupied,
        open_violations, worst_open_stage,
        lifetime_violations, violations_last_12mo, last_violation_at,
        arc_decisions_count, arc_approved_count, arc_denied_count, last_arc_decided_at,
        interactions_count, last_interaction_at,
        inspections_count, last_inspected_at,
        current_balance, ar_bucket_0_30, ar_bucket_31_60, ar_bucket_61_90, ar_bucket_91_120, ar_bucket_over_120,
        ar_at_legal, ar_in_collections, ar_payment_plan_active, ar_enforcement_stage,
        ar_snapshot_date, ar_days_since_snapshot
      `)
      .eq('community_id', communityId)
      .limit(5000);
    const { data: summaryRows, error: sErr } = await q;
    if (sErr) throw sErr;

    // We also need lat/lng (not on v_property_summary). Fetch with one
    // additional bounded query and merge by property_id.
    const { data: coordRows, error: pErr } = await supabase
      .from('properties')
      .select('id, latitude, longitude')
      .eq('community_id', communityId)
      .limit(5000);
    if (pErr) throw pErr;
    const coordsById = new Map((coordRows || []).map((r) => [r.id, { lat: r.latitude, lng: r.longitude }]));

    // Newest AR snapshot date across the community — the UI surfaces this
    // ('AR data as of 2026-04-30') so no one mistakes a stale snapshot for
    // live ledger state. Per single-source-of-truth discipline in
    // 077_owner_ar_snapshots.sql.
    let arSnapshotDate = null;
    let arDaysOld = null;
    for (const r of summaryRows || []) {
      if (r.ar_snapshot_date && (!arSnapshotDate || r.ar_snapshot_date > arSnapshotDate)) {
        arSnapshotDate = r.ar_snapshot_date;
        arDaysOld = r.ar_days_since_snapshot;
      }
    }

    const properties = [];
    let propertiesWithoutGeo = 0;
    for (const r of summaryRows || []) {
      const coords = coordsById.get(r.property_id) || {};
      const hasGeo = coords.lat != null && coords.lng != null;
      if (!hasGeo) propertiesWithoutGeo++;
      if (!hasGeo && !includeUngeocoded) continue;

      properties.push({
        property_id: r.property_id,
        street_address: r.street_address,
        unit: r.unit,
        lot_number: r.lot_number,
        latitude: coords.lat,
        longitude: coords.lng,

        owner_name: r.owner_name,

        // Layer flags — always returned, frontend visualizes selectively
        occupancy: statusOccupancy(r),
        residency_type: r.residency_type,
        lease_end_date: r.lease_end_date,

        ar_bucket: bucketAr(r),
        ar_balance: r.current_balance != null ? Number(r.current_balance) : null,
        ar_at_legal: !!r.ar_at_legal,
        ar_in_collections: !!r.ar_in_collections,
        ar_payment_plan_active: !!r.ar_payment_plan_active,
        ar_enforcement_stage: r.ar_enforcement_stage || null,

        drv_status: statusDrv(r),
        drv_open_count: r.open_violations || 0,
        drv_worst_stage: r.worst_open_stage || null,
        drv_last_at: r.last_violation_at || null,

        acc_decisions_count: r.arc_decisions_count || 0,
        acc_last_decided_at: r.last_arc_decided_at || null,
      });
    }

    // Fire-and-forget audit row. Don't await — keep the user-facing latency low.
    logAccess({
      req, actor, communityId,
      action: 'view_map_layers',
      layers: requestedLayers.length > 0 ? requestedLayers : Array.from(VALID_LAYERS),
    });

    // Watermark for the frontend overlay — viewer + when. Doesn't leak
    // sensitive info on its own; ruins screenshot value if leaked.
    const watermark = `${actor ? actorDisplayName(actor) : 'Bedrock staff'} · ${new Date().toISOString()}`;

    res.json({
      community: {
        id: community.id,
        name: community.name,
        slug: community.slug,
      },
      as_of: new Date().toISOString(),
      ar_snapshot_date: arSnapshotDate,
      ar_days_since_snapshot: arDaysOld,
      counts: {
        total: properties.length,
        ungeocoded: propertiesWithoutGeo,
      },
      properties,
      watermark,
    });
  } catch (err) {
    console.error('[community-map] layers failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /property/:propertyId
// ----------------------------------------------------------------------------
// Side-panel detail when a pin is clicked. Returns the full v_property_summary
// row for the property PLUS owner contact details + recent interactions.
// Staff response includes the full picture; board response (when that
// surface ships) strips workpaper-classified fields (internal notes,
// triage classifications, drafts not yet sent).
// ----------------------------------------------------------------------------
router.get('/property/:propertyId', async (req, res) => {
  try {
    const propertyId = req.params.propertyId;
    if (!propertyId) return res.status(400).json({ error: 'property_id_required' });

    const actor = await getActingUser(req);

    // The v_property_summary row already has owner contact info from
    // v_current_property_owners. Single read.
    const { data: summary, error: sErr } = await supabase
      .from('v_property_summary')
      .select('*')
      .eq('property_id', propertyId)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!summary) return res.status(404).json({ error: 'property_not_found' });

    // Recent interactions — last 10, newest first. interactions table is
    // mixed-ownership (the interaction record itself is association if
    // sent to a homeowner; the AI classification is workpaper). For the
    // staff view we expose everything; the board projection will strip
    // workpaper fields.
    let interactions = [];
    try {
      const { data: ix } = await supabase
        .from('interactions')
        .select('id, kind, direction, subject, body_excerpt, occurred_at, created_at')
        .eq('property_id', propertyId)
        .order('occurred_at', { ascending: false, nullsFirst: false })
        .limit(10);
      interactions = ix || [];
    } catch (e) {
      console.warn('[community-map] interactions fetch failed:', e.message);
    }

    // Latest AR snapshot detail (for the panel — the layer-data endpoint
    // already returned aggregates, but the panel wants the full bucket
    // breakdown + enforcement notes).
    let arDetail = null;
    try {
      const { data: ar } = await supabase
        .from('v_latest_ar_per_property')
        .select('*')
        .eq('property_id', propertyId)
        .maybeSingle();
      arDetail = ar || null;
    } catch (e) {
      console.warn('[community-map] ar detail fetch failed:', e.message);
    }

    // Recent open violations — surface what's open and where it is in the
    // escalation flow. Closed/cured/voided suppressed.
    let openViolations = [];
    try {
      const { data: vs } = await supabase
        .from('violations')
        .select('id, violation_type, current_stage, opened_at, last_action_at, summary')
        .eq('property_id', propertyId)
        .not('current_stage', 'in', '(cured,closed,voided)')
        .order('opened_at', { ascending: false })
        .limit(20);
      openViolations = vs || [];
    } catch (e) {
      console.warn('[community-map] violations fetch failed:', e.message);
    }

    logAccess({
      req, actor,
      communityId: summary.community_id,
      propertyId,
      action: 'view_property',
    });

    res.json({
      property: summary,
      ar: arDetail,
      open_violations: openViolations,
      interactions,
      watermark: `${actor ? actorDisplayName(actor) : 'Bedrock staff'} · ${new Date().toISOString()}`,
    });
  } catch (err) {
    console.error('[community-map] property detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// GET /acknowledge/status?community_id=
// ----------------------------------------------------------------------------
// Returns whether the current user has an active ack for this community
// (or portfolio-wide). Frontend calls this before rendering the map to
// decide whether to surface the ack modal.
// ----------------------------------------------------------------------------
router.get('/acknowledge/status', async (req, res) => {
  try {
    const actor = await getActingUser(req);
    const communityId = (req.query.community_id || '').toString();
    if (!actor) {
      // No JWT identity yet — return as if ack'd so the map still renders
      // under STAFF_GATE-only sessions. Tighten when board auth ships.
      return res.json({
        has_active_ack: true,
        ack_version: ACK_VERSION,
        legacy_session: true,
      });
    }
    const active = await userHasActiveAck(actor.id, communityId || null);
    res.json({
      has_active_ack: !!active,
      ack_version: ACK_VERSION,
      ack_text: ACK_TEXT,
      ack_ttl_days: ACK_TTL_DAYS,
    });
  } catch (err) {
    console.error('[community-map] ack status failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ----------------------------------------------------------------------------
// POST /acknowledge
// ----------------------------------------------------------------------------
// Records a confidentiality acknowledgment for the current user.
// Body: { community_id?: string }   // omit for portfolio-wide ack
//
// The endpoint hashes the server-known ack text + version so we can later
// prove which exact language the user saw. Frontend doesn't supply the
// text — that prevents tampering ("they ack'd a different paraphrase").
// ----------------------------------------------------------------------------
router.post('/acknowledge', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const actor = await getActingUser(req);
    if (!actor) return res.status(401).json({ error: 'authentication_required' });

    const communityId = (req.body && req.body.community_id) ? String(req.body.community_id) : null;

    if (communityId) {
      // Verify the requested community is in our management company. Prevents
      // a board member from acking for a different community (when board
      // auth ships, the session token will enforce this server-side, but
      // belt + suspenders).
      const { data: c } = await supabase
        .from('communities')
        .select('id')
        .eq('id', communityId)
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .maybeSingle();
      if (!c) return res.status(404).json({ error: 'community_not_found' });
    }

    const expiresAt = new Date(Date.now() + ACK_TTL_DAYS * 86400 * 1000).toISOString();
    const { data, error } = await supabase
      .from('community_map_acknowledgments')
      .insert({
        user_id: actor.id,
        community_id: communityId,
        ack_version: ACK_VERSION,
        ack_text_hash: ACK_TEXT_HASH,
        expires_at: expiresAt,
        request_ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
                    || (req.socket && req.socket.remoteAddress)
                    || null,
        user_agent: (req.headers['user-agent'] || '').toString().slice(0, 500),
      })
      .select()
      .single();
    if (error) throw error;

    res.json({
      ack: data,
      expires_at: expiresAt,
      ack_version: ACK_VERSION,
    });
  } catch (err) {
    console.error('[community-map] acknowledge failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
