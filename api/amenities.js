// ============================================================================
// Amenities API — public + admin
// ----------------------------------------------------------------------------
// Mounted at /api/amenities.
//
// Public surface (used by /clubhouse/:slug form + future amenity map):
//   GET  /community/:slug                  community + rentable amenities + module status
//   GET  /:id                              one amenity + active fee schedule + agreement text
//   GET  /:id/availability?from=&to=       busy slots in date range (calendar render)
//   POST /:id/rentals                      create a draft rental (returns id + ref number)
//
// Staff surface (gated by staff cookie since path is NOT in allowlist):
//   GET  /admin/queue                      v_amenity_rental_queue listing
//   GET  /admin/rentals/:id                full rental detail incl payments
//   POST /admin/rentals/:id/staff-intake   record paper rental (staff form)
//   POST /admin/rentals/:id/inspect        record post-event inspection
//   POST /admin/rentals/:id/cancel         cancel + optional refund trigger
//
// Anti-enumeration: public endpoints never reveal which emails/properties exist;
// drafts are scoped to a single submitter email at creation time.
// ============================================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const SERVICE_TYPE = 'amenity_rental';

const router = express.Router();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function amenityRefPrefix(community, amenityType) {
  const cPrefix = community.builder_arc_reference_prefix
                || (community.slug || community.name || 'AM').split(/[\s_-]+/)
                     .map((w) => w[0]).join('').toUpperCase().slice(0, 4)
                || 'AM';
  const aShort = {
    clubhouse: 'CLB', pool: 'POOL', park: 'PARK', playground: 'PLY',
    sport_court: 'CRT', fitness: 'FIT', dog_park: 'DOG', other: 'AMN',
  }[amenityType] || 'AMN';
  return `${cPrefix}-${aShort}`;
}

async function nextAmenityReference(community, amenityType) {
  const year = new Date().getFullYear();
  const prefix = amenityRefPrefix(community, amenityType);

  const { data: row } = await supabase
    .from('application_reference_counters')
    .select('counter')
    .eq('community_id', community.id)
    .eq('service_type', SERVICE_TYPE)
    .eq('year', year)
    .maybeSingle();

  const next = (row?.counter || 0) + 1;

  await supabase
    .from('application_reference_counters')
    .upsert({
      community_id: community.id,
      service_type: SERVICE_TYPE,
      year,
      counter: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'community_id,service_type,year' });

  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

async function fetchCommunityBySlug(slug) {
  const { data, error } = await supabase
    .from('communities')
    .select(`
      id, name, slug, builder_arc_reference_prefix,
      hoa_legal_name, hoa_address,
      portal_active, portal_module_config,
      amenity_bookings_active, stripe_connected_account_id, stripe_onboarding_status
    `)
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchAmenityById(id) {
  const { data, error } = await supabase
    .from('amenities')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchActiveFees(amenityId) {
  const { data, error } = await supabase
    .from('amenity_fee_schedule')
    .select('*')
    .eq('amenity_id', amenityId)
    .is('effective_to', null)
    .order('display_order');
  if (error) throw error;
  return data || [];
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Hash the rental agreement text so we can record exactly which version was acknowledged.
function hashText(s) {
  if (!s) return null;
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

// Normalize a street address for fuzzy matching (drops punctuation, lowercases,
// collapses whitespace). Good enough for "502 Meadow Knoll Drive" ↔ "502 Meadow
// Knoll Dr." matches; not authoritative for legal documents.
function normalizeAddress(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(drive|street|road|avenue|boulevard|lane|court|circle|place|trail|way|terrace|parkway|highway)\b/g, (m) => m.slice(0, 2))
    .trim();
}

// Run the auto-eligibility check at intake. Returns { flag, data }.
//   flag: 'clean' | 'past_due_at_intake' | 'no_property_match' | 'unverified'
//   data: snapshot of what we found (for audit trail)
async function checkEligibility({ communityId, renterAddress, renterEmail }) {
  if (!renterAddress) {
    return { flag: 'unverified', data: { reason: 'no_address_provided' } };
  }
  try {
    const norm = normalizeAddress(renterAddress);
    if (!norm) return { flag: 'unverified', data: { reason: 'address_unparseable' } };

    // Try exact street_address match first, then fuzzy
    const { data: props } = await supabase
      .from('properties')
      .select('id, street_address, community_id')
      .eq('community_id', communityId);

    let matched = null;
    if (props && props.length) {
      matched = props.find((p) => normalizeAddress(p.street_address) === norm);
      if (!matched) {
        matched = props.find((p) => {
          const pn = normalizeAddress(p.street_address);
          return pn.includes(norm.split(' ')[0]) && pn.includes(norm.split(' ').slice(-1)[0]);
        });
      }
    }

    if (!matched) {
      return { flag: 'no_property_match', data: { renter_address: renterAddress, normalized: norm } };
    }

    // Look up the most recent owner_ar_snapshot for that property
    const { data: snap } = await supabase
      .from('owner_ar_snapshots')
      .select('balance_total, enforcement_stage, at_legal, in_collections, snapshot_date')
      .eq('property_id', matched.id)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!snap) {
      return {
        flag: 'unverified',
        data: { property_id: matched.id, reason: 'no_ar_snapshot_on_file' },
      };
    }

    const balanceCents = snap.balance_total != null ? Math.round(Number(snap.balance_total) * 100) : null;
    const pastDueStages = ['certified_209', 'at_legal', 'with_attorney', 'in_collections', 'judgment', 'lien_filed'];
    const isPastDue = (balanceCents && balanceCents > 0)
                      && (snap.at_legal || snap.in_collections
                          || pastDueStages.includes(String(snap.enforcement_stage || '').toLowerCase()));

    return {
      flag: isPastDue ? 'past_due_at_intake' : 'clean',
      data: {
        property_id: matched.id,
        property_address: matched.street_address,
        balance_cents: balanceCents,
        enforcement_stage: snap.enforcement_stage,
        at_legal: snap.at_legal,
        in_collections: snap.in_collections,
        snapshot_date: snap.snapshot_date,
      },
    };
  } catch (err) {
    console.warn('[amenities] eligibility check threw:', err.message);
    return { flag: 'unverified', data: { reason: 'check_failed', error: err.message } };
  }
}

// ============================================================================
// PUBLIC: GET /api/amenities/community/:slug
// Returns community summary + list of rentable amenities.
// Used by the /clubhouse/:slug form to validate the community is set up.
// ============================================================================
router.get('/community/:slug', async (req, res) => {
  try {
    const community = await fetchCommunityBySlug(req.params.slug);
    if (!community) return res.status(404).json({ error: 'community_not_found' });

    if (!community.amenity_bookings_active) {
      return res.status(403).json({
        error: 'amenity_bookings_not_active',
        community: { name: community.name, slug: community.slug },
        hint: 'This community is not currently accepting online amenity reservations.',
      });
    }

    const { data: amenities, error: aErr } = await supabase
      .from('amenities')
      .select(`
        id, amenity_type, name, description, street_address, capacity,
        photo_storage_path, rental_max_attendees,
        rental_min_lead_time_days, rental_max_lead_time_days,
        rental_end_time_weekday, rental_end_time_weekend,
        rental_cancellation_window_hours,
        rental_agreement_version,
        rental_eligibility, rental_requires_assessments_current,
        is_rentable, status, display_order
      `)
      .eq('community_id', community.id)
      .eq('is_rentable', true)
      .in('status', ['active', 'seasonal_closed'])
      .order('display_order');
    if (aErr) throw aErr;

    res.json({
      community: {
        id: community.id,
        slug: community.slug,
        name: community.name,
        hoa_legal_name: community.hoa_legal_name || community.name,
        bookings_active: community.amenity_bookings_active,
        stripe_ready: !!community.stripe_connected_account_id,
      },
      amenities: amenities || [],
    });
  } catch (err) {
    console.error('[amenities] community lookup failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// PUBLIC: GET /api/amenities/:id
// One amenity with active fee schedule + agreement text. Form fetches this
// when the user picks an amenity (or when there's only one rentable amenity,
// auto-loaded).
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const amenity = await fetchAmenityById(req.params.id);
    if (!amenity) return res.status(404).json({ error: 'not_found' });

    const fees = await fetchActiveFees(amenity.id);

    res.json({
      amenity,
      fees,
      agreement_text_hash: hashText(amenity.rental_agreement_text),
    });
  } catch (err) {
    console.error('[amenities] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// PUBLIC: GET /api/amenities/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns busy slots so the calendar can grey out conflicts.
// Default range: today through max lead time (or 6 months out).
// ============================================================================
router.get('/:id/availability', async (req, res) => {
  try {
    const amenity = await fetchAmenityById(req.params.id);
    if (!amenity) return res.status(404).json({ error: 'not_found' });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = req.query.from ? new Date(req.query.from) : today;
    const maxLead = amenity.rental_max_lead_time_days || 180;
    const defaultTo = new Date(today.getTime() + maxLead * 86400000);
    const to = req.query.to ? new Date(req.query.to) : defaultTo;

    const { data: busy, error } = await supabase
      .from('v_amenity_busy_slots')
      .select('event_date, arrival_time, departure_time, reference_number, status')
      .eq('amenity_id', amenity.id)
      .gte('event_date', from.toISOString().slice(0, 10))
      .lte('event_date', to.toISOString().slice(0, 10))
      .order('event_date')
      .order('arrival_time');
    if (error) throw error;

    res.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      min_lead_time_days: amenity.rental_min_lead_time_days,
      max_lead_time_days: amenity.rental_max_lead_time_days,
      busy_slots: (busy || []).map((b) => ({
        date: b.event_date,
        from: b.arrival_time,
        to: b.departure_time,
        // Don't surface reference numbers / renter identities to the public
      })),
    });
  } catch (err) {
    console.error('[amenities] availability failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// PUBLIC: POST /api/amenities/:id/rentals
// Create a draft rental. Returns rental_id + reference_number.
// Body: {
//   renter_name, renter_email, renter_phone_cell, renter_phone_home?, renter_phone_work?,
//   renter_address?,
//   event_date, arrival_time, departure_time, event_description, attendee_count,
//   optional_addons: { av_equipment: bool, ... },
//   agreement_acknowledged: bool,           // online inline checkbox
//   agreement_text_hash: string,            // confirms they saw THIS version
//   intake_method: 'online_portal' | 'staff_in_person' | ...
//   property_id?: UUID,                     // when logged-in homeowner
// }
//
// Validates against:
//   - amenity exists + is rentable + active
//   - lead time (min/max)
//   - capacity (attendee_count <= rental_max_attendees)
//   - slot conflict with existing pending_payment/confirmed/completed rentals
//   - agreement acknowledged when online_portal
// ============================================================================
router.post('/:id/rentals', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const amenity = await fetchAmenityById(req.params.id);
    if (!amenity) return res.status(404).json({ error: 'amenity_not_found' });
    if (!amenity.is_rentable || amenity.status !== 'active') {
      return res.status(403).json({ error: 'amenity_not_rentable' });
    }

    const body = req.body || {};
    const intakeMethod = body.intake_method || 'online_portal';
    const isStaffIntake = intakeMethod !== 'online_portal';

    // Required fields
    const requiredFields = ['renter_name', 'renter_email', 'event_date', 'arrival_time', 'departure_time'];
    for (const f of requiredFields) {
      if (!body[f] || !String(body[f]).trim()) {
        return res.status(400).json({ error: `${f}_required` });
      }
    }

    // Online intake requires acknowledged agreement; staff intake records paper signature on file
    if (!isStaffIntake) {
      if (!body.agreement_acknowledged) {
        return res.status(400).json({ error: 'agreement_must_be_acknowledged' });
      }
      // Optionally check version hash matches current text — soft warn if not
      const currentHash = hashText(amenity.rental_agreement_text);
      if (body.agreement_text_hash && currentHash && body.agreement_text_hash !== currentHash) {
        // Don't block; the version they saw may have rendered fine, but log it
        console.warn(`[amenities] agreement hash mismatch on rental ${amenity.id}: client=${body.agreement_text_hash} current=${currentHash}`);
      }
    }

    // Lead time
    const eventDate = new Date(body.event_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const leadDays = Math.floor((eventDate - today) / 86400000);
    if (amenity.rental_min_lead_time_days && leadDays < amenity.rental_min_lead_time_days) {
      return res.status(400).json({
        error: 'lead_time_too_short',
        min_days: amenity.rental_min_lead_time_days,
      });
    }
    if (amenity.rental_max_lead_time_days && leadDays > amenity.rental_max_lead_time_days) {
      return res.status(400).json({
        error: 'lead_time_too_far',
        max_days: amenity.rental_max_lead_time_days,
      });
    }

    // Capacity
    if (amenity.rental_max_attendees && body.attendee_count
        && Number(body.attendee_count) > amenity.rental_max_attendees) {
      return res.status(400).json({
        error: 'over_capacity',
        max_attendees: amenity.rental_max_attendees,
      });
    }

    // Slot conflict check
    const { data: conflicts } = await supabase
      .from('amenity_rentals')
      .select('id, reference_number, arrival_time, departure_time')
      .eq('amenity_id', amenity.id)
      .eq('event_date', body.event_date)
      .in('status', ['pending_payment', 'confirmed', 'completed']);

    const requestedFrom = body.arrival_time;
    const requestedTo = body.departure_time;
    const overlap = (conflicts || []).find((c) =>
      // overlap if requested start < existing end AND requested end > existing start
      requestedFrom < c.departure_time && requestedTo > c.arrival_time
    );
    if (overlap) {
      return res.status(409).json({
        error: 'slot_conflict',
        hint: 'Another reservation overlaps this time window. Please pick a different slot.',
      });
    }

    // Fetch community for ref number
    const { data: community } = await supabase
      .from('communities')
      .select('id, slug, name, builder_arc_reference_prefix')
      .eq('id', amenity.community_id)
      .single();

    const referenceNumber = await nextAmenityReference(community, amenity.amenity_type);

    // Run auto-eligibility check (best-effort, never blocks)
    const eligibility = await checkEligibility({
      communityId: amenity.community_id,
      renterAddress: body.renter_address,
      renterEmail: body.renter_email,
    });

    // Insert draft rental
    const insertRow = {
      amenity_id: amenity.id,
      community_id: amenity.community_id,
      reference_number: referenceNumber,
      renter_name: body.renter_name,
      renter_email: String(body.renter_email).toLowerCase().trim(),
      renter_phone_cell: body.renter_phone_cell || null,
      renter_phone_home: body.renter_phone_home || null,
      renter_phone_work: body.renter_phone_work || null,
      renter_address: body.renter_address || null,
      property_id: body.property_id || eligibility.data?.property_id || null,
      event_date: body.event_date,
      arrival_time: body.arrival_time,
      departure_time: body.departure_time,
      event_description: body.event_description || null,
      attendee_count: body.attendee_count || null,
      optional_addons: body.optional_addons || {},
      intake_method: intakeMethod,
      intake_recorded_by: body.intake_recorded_by || null,
      agreement_version: amenity.rental_agreement_version,
      agreement_text_hash: hashText(amenity.rental_agreement_text),
      agreement_acknowledged_at: body.agreement_acknowledged ? new Date().toISOString() : null,
      agreement_signature_method: isStaffIntake ? 'paper_signature_on_file' : 'inline_checkbox',
      agreement_signature_ip: req.ip || null,
      agreement_signature_user_agent: req.headers['user-agent'] || null,
      attested_current_at_submission: !!body.attested_current,
      attested_at: body.attested_current ? new Date().toISOString() : null,
      eligibility_check_flag: eligibility.flag,
      eligibility_check_data: eligibility.data,
      status: isStaffIntake ? 'confirmed' : 'draft',
      confirmed_at: isStaffIntake ? new Date().toISOString() : null,
    };

    const { data: rental, error: insErr } = await supabase
      .from('amenity_rentals')
      .insert(insertRow)
      .select('*')
      .single();
    if (insErr) throw insErr;

    res.json({
      ok: true,
      rental_id: rental.id,
      reference_number: rental.reference_number,
      status: rental.status,
    });
  } catch (err) {
    console.error('[amenities] create rental failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// PUBLIC: GET /api/amenities/rentals/:id (lookup by id for confirmation page)
// Returns thin status payload; no PII beyond what the renter already entered.
// ============================================================================
router.get('/rentals/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('amenity_rentals')
      .select(`
        id, reference_number, status, event_date, arrival_time, departure_time,
        renter_name, renter_email, event_description, attendee_count,
        amenity:amenities(name, amenity_type, street_address),
        community:communities(name, slug)
      `)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json(data);
  } catch (err) {
    console.error('[amenities] rental lookup failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// ADMIN (staff-gated by virtue of path not being in allowlist):
//   GET /api/amenities/admin/queue
//   POST /api/amenities/admin/rentals/:id/staff-intake
//   POST /api/amenities/admin/rentals/:id/cancel
// ============================================================================
router.get('/admin/queue', async (req, res) => {
  try {
    let q = supabase
      .from('v_amenity_rental_queue')
      .select('*', { count: 'exact' })
      .order('event_date', { ascending: false });

    if (req.query.community_id) q = q.eq('community_id', req.query.community_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.amenity_type) q = q.eq('amenity_type', req.query.amenity_type);
    if (req.query.q) {
      const like = `%${String(req.query.q).replace(/[%_]/g, '')}%`;
      q = q.or(`reference_number.ilike.${like},renter_name.ilike.${like},renter_email.ilike.${like}`);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    q = q.range(offset, offset + limit - 1);

    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ items: data || [], total: count || 0, limit, offset });
  } catch (err) {
    console.error('[amenities] admin queue failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /admin/rentals/:id/complete-inspection
// Body: {
//   inspected_by: string,
//   passed: bool,
//   notes?: string,
//   inspection_checklist?: [{item, passed, note}],
//   withholding_cents?: number (default 0; can't exceed refundable total),
//   withholding_reason?: string,
//   issue_refund: bool (default true if passed; required to actually trigger refund)
// }
// Records inspection + triggers Stripe partial refund for the refundable
// portion (minus withholding). Updates payments rows + sets
// amenity_rentals.deposit_returned_at + status='completed'. Logs to interactions
// and emails the renter when refund issues successfully.
// ============================================================================
router.post('/admin/rentals/:id/complete-inspection', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const stripeLib = require('../lib/payments/stripe');
    const { sendEmail } = require('../lib/notifications/email');

    const {
      inspected_by, passed, notes, inspection_checklist,
      withholding_cents = 0, withholding_reason,
      issue_refund = true,
    } = req.body || {};

    if (!inspected_by) return res.status(400).json({ error: 'inspected_by_required' });
    if (typeof passed !== 'boolean') return res.status(400).json({ error: 'passed_must_be_boolean' });

    // Load the rental
    const { data: rental, error: rErr } = await supabase
      .from('amenity_rentals')
      .select(`
        *,
        amenity:amenities(name, amenity_type),
        community:communities(name, slug, hoa_legal_name, stripe_connected_account_id)
      `)
      .eq('id', req.params.id)
      .single();
    if (rErr) throw rErr;
    if (!rental) return res.status(404).json({ error: 'rental_not_found' });
    if (rental.inspection_completed_at) {
      return res.status(409).json({ error: 'inspection_already_completed' });
    }

    // Load refundable payments tied to this rental
    const { data: refundablePayments, error: pErr } = await supabase
      .from('payments')
      .select('*')
      .eq('product_type', 'amenity_rental')
      .eq('product_id', rental.id)
      .eq('refundable', true)
      .eq('status', 'succeeded');
    if (pErr) throw pErr;

    const totalRefundable = (refundablePayments || []).reduce((s, p) => s + p.amount_cents, 0);
    const withhold = Math.max(0, Math.min(Number(withholding_cents) || 0, totalRefundable));
    const refundAmount = totalRefundable - withhold;

    // Record inspection
    await supabase
      .from('amenity_rentals')
      .update({
        inspection_completed_at: new Date().toISOString(),
        inspection_completed_by: inspected_by,
        inspection_passed: passed,
        inspection_notes: notes || null,
        inspection_checklist: inspection_checklist || null,
        deposit_withholding_cents: withhold,
        deposit_withholding_reason: withholding_reason || null,
        status: passed && withhold === 0 ? 'completed' : (passed ? 'completed' : 'completed'),
      })
      .eq('id', rental.id);

    // Issue refund(s) if requested + there's something to refund
    const refundResults = [];
    if (issue_refund && refundAmount > 0 && (refundablePayments || []).length) {
      // Refund proportionally across refundable payments (deposit first, then AV)
      // Simpler: refund each refundable payment in full unless withhold is set,
      // in which case refund (payment.amount - withhold-share).
      // For v0 we attribute withholding to the security_deposit line if present.
      let remainingWithhold = withhold;
      for (const p of refundablePayments) {
        const isDepositLine = p.fee_type === 'security_deposit';
        const withholdThis = isDepositLine && remainingWithhold > 0
          ? Math.min(remainingWithhold, p.amount_cents)
          : 0;
        remainingWithhold -= withholdThis;
        const refundThis = p.amount_cents - withholdThis;
        if (refundThis <= 0) continue;

        const result = await stripeLib.refund({
          paymentIntentId: p.processor_payment_id,
          amountCents: refundThis,
          connectedAccountId: p.connected_account_id || undefined,
          reason: 'requested_by_customer',
        });

        if (result.ok) {
          await supabase
            .from('payments')
            .update({
              status: refundThis >= p.amount_cents ? 'refunded' : 'partially_refunded',
              refunded_amount_cents: (p.refunded_amount_cents || 0) + refundThis,
              refunded_at: new Date().toISOString(),
              refund_reason: 'post_inspection_deposit_return',
            })
            .eq('id', p.id);
        }
        refundResults.push({ payment_id: p.id, fee_type: p.fee_type, refund_amount_cents: refundThis, ok: result.ok, error: result.error });
      }

      // Mark deposit returned
      await supabase
        .from('amenity_rentals')
        .update({ deposit_returned_at: new Date().toISOString() })
        .eq('id', rental.id);

      // Send refund email (best-effort)
      try {
        const totalRefundIssued = refundResults.filter((r) => r.ok).reduce((s, r) => s + r.refund_amount_cents, 0);
        if (totalRefundIssued > 0) {
          await sendEmail({
            to: rental.renter_email,
            subject: `Deposit refund issued — ${rental.reference_number}`,
            html: `
              <p>Dear ${rental.renter_name},</p>
              <p>Following the post-event inspection at ${rental.community.name}, your refundable deposit has been issued.</p>
              <p><strong>Refunded:</strong> $${(totalRefundIssued / 100).toFixed(2)}</p>
              ${withhold > 0 ? `<p><strong>Withheld:</strong> $${(withhold / 100).toFixed(2)} — ${escapeHtml(withholding_reason || '')}</p>` : ''}
              <p>Funds typically appear in your account within 5–10 business days.</p>
              <p>Thank you for using the ${rental.amenity.name}.</p>
              <p style="color:#555; font-size:11px; margin-top:24px;">
                Sent on behalf of ${rental.community.hoa_legal_name || rental.community.name} by Bedrock Association Management.
              </p>`,
            tags: [
              { name: 'module', value: 'amenity_rental' },
              { name: 'event', value: 'deposit_refund' },
            ],
          });
        }
      } catch (_) { /* non-fatal */ }
    }

    res.json({
      ok: true,
      inspection: {
        passed,
        notes,
        completed_at: new Date().toISOString(),
        completed_by: inspected_by,
      },
      refund: {
        total_refundable_cents: totalRefundable,
        withheld_cents: withhold,
        refunded_cents: refundResults.filter((r) => r.ok).reduce((s, r) => s + r.refund_amount_cents, 0),
        results: refundResults,
      },
    });
  } catch (err) {
    console.error('[amenities] complete-inspection failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ============================================================================
// POST /admin/rentals/:id/resolve-eligibility
// Body: { decision: 'confirm' | 'cancel', resolved_by, notes? }
// Used when a rental was flagged past-due-at-intake. Staff investigates
// and either confirms (rental proceeds) or cancels (with full refund).
// ============================================================================
router.post('/admin/rentals/:id/resolve-eligibility', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { decision, resolved_by, notes } = req.body || {};
    if (!resolved_by) return res.status(400).json({ error: 'resolved_by_required' });
    if (!['confirm', 'cancel'].includes(decision)) {
      return res.status(400).json({ error: 'decision_must_be_confirm_or_cancel' });
    }

    const update = {
      eligibility_reviewed_by: resolved_by,
      eligibility_reviewed_at: new Date().toISOString(),
      eligibility_check_flag: decision === 'confirm'
        ? 'staff_overridden_to_confirmed'
        : 'staff_overridden_to_cancelled',
    };
    if (decision === 'cancel') {
      update.status = 'cancelled';
      update.cancelled_at = new Date().toISOString();
      update.cancelled_by = resolved_by;
      update.cancellation_reason = notes || 'Eligibility resolved to cancel';
    }

    await supabase.from('amenity_rentals').update(update).eq('id', req.params.id);

    res.json({ ok: true, decision });
  } catch (err) {
    console.error('[amenities] resolve-eligibility failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/admin/rentals/:id/cancel', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { cancelled_by, reason } = req.body || {};
    if (!cancelled_by) return res.status(400).json({ error: 'cancelled_by_required' });

    const { data, error } = await supabase
      .from('amenity_rentals')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by,
        cancellation_reason: reason || null,
      })
      .eq('id', req.params.id)
      .select('id, status, reference_number')
      .single();
    if (error) throw error;
    res.json({ ok: true, rental: data });
  } catch (err) {
    console.error('[amenities] cancel failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
