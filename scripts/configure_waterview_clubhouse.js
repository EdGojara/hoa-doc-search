// ============================================================================
// scripts/configure_waterview_clubhouse.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Turns Waterview's clubhouse into something a homeowner can actually reserve.
//
// Ed: "lets do clubhouse reservations ... on portal and we need to connect it
// to our calendar for each community."
//
// The booking engine has been built for a while: public form, availability
// check, eligibility gate, deposits, inspection, cancellation. What was missing
// is the part only the association can supply. The clubhouse had
// is_rentable = false, no fee schedule at all, no agreement, no lead times and
// no end times, so the tile was live and the door was locked.
//
// EVERY VALUE BELOW IS QUOTED FROM WATERVIEW'S OWN 2025 RENTAL AGREEMENT, which
// was already filed in library_documents. Nothing here is invented, and nothing
// is a default I picked. If a term is not in that form it is not set here.
//
// The older "Clubhouse Rental Application & Agreement" on file quotes $75 and
// $300 and is payable to CastleCare Community Management, the PREDECESSOR
// manager. It is superseded and must not be used for a live booking.
//
// Fees are separate rows rather than one total because they behave differently:
// the deposit is refundable and the rental fee is not, and the cancellation rule
// turns on exactly that difference.
//
// IDEMPOTENT.
//
//   node scripts/configure_waterview_clubhouse.js --dry-run
//   node scripts/configure_waterview_clubhouse.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');

const ASSOCIATION = 'Waterview Estates Owners Association, Inc.';

// "$150.00 Rental Fee", "$400.00 Deposit", "$70 Cleaning fee",
// "$25.00 Management Processing Fee", "$50 AV Equipment Rental Deposit (Optional)"
const FEES = [
  { fee_type: 'rental', label: 'Clubhouse rental fee', amount_cents: 15000,
    refundable: false, required: true, payee: 'community_association',
    payee_display_name: ASSOCIATION, display_order: 10,
    notes: 'Forfeited on cancellation inside 48 hours. 2025 Clubhouse Rental Agreement Form.' },
  { fee_type: 'security_deposit', label: 'Refundable deposit', amount_cents: 40000,
    refundable: true, required: true, payee: 'community_association',
    payee_display_name: ASSOCIATION, display_order: 20,
    notes: 'Refunded on cancellation and after a clear post-event inspection.' },
  { fee_type: 'cleaning', label: 'Cleaning fee', amount_cents: 7000,
    refundable: false, required: true, payee: 'community_association',
    payee_display_name: ASSOCIATION, display_order: 30,
    notes: '2025 Clubhouse Rental Agreement Form.' },
  { fee_type: 'processing', label: 'Management processing fee', amount_cents: 2500,
    refundable: false, required: true, payee: 'management_company',
    payee_display_name: 'Bedrock Association Management, LLC', display_order: 40,
    notes: 'Also forfeited on cancellation inside 48 hours per the 2025 form.' },
  { fee_type: 'av_equipment_deposit', label: 'AV equipment deposit (optional)', amount_cents: 5000,
    refundable: true, required: false, payee: 'community_association',
    payee_display_name: ASSOCIATION, display_order: 50,
    notes: 'Only when the renter requests AV equipment.' },
];

const RULES = {
  is_rentable: true,
  rental_max_attendees: 50,                 // "not more than 50 people"
  rental_min_lead_time_days: 14,            // "no less than two weeks in advance"
  rental_max_lead_time_days: 90,            // "no more than three months in advance"
  rental_end_time_weekday: '22:00',         // "concluded by 10:00pm Sunday through Thursday"
  rental_end_time_weekend: '23:59',         // "12:00am on Friday and Saturday", never after midnight
  rental_cancellation_window_hours: 48,     // already set, restated so the record is complete
  rental_requires_assessments_current: true, // "must be current on their assessments"
  rental_agreement_version: '2025',
};

(async () => {
  const { data: amenity, error } = await supabase.from('amenities')
    .select('id, name, community_id, is_rentable').ilike('name', '%clubhouse%').maybeSingle();
  if (error) throw new Error('amenity lookup failed: ' + error.message);
  if (!amenity) throw new Error('no clubhouse amenity found');
  console.log(amenity.name + (DRY ? '  [DRY RUN]' : ''));

  // ---- rules -------------------------------------------------------------
  console.log('\nRULES from the 2025 agreement:');
  for (const [k, v] of Object.entries(RULES)) console.log('  ' + k.padEnd(38) + JSON.stringify(v));
  if (!DRY) {
    const { error: uErr } = await supabase.from('amenities').update(RULES).eq('id', amenity.id);
    if (uErr) throw new Error('amenity update failed: ' + uErr.message);
    console.log('  applied');
  }

  // The annual cap is deliberately NOT set. The form says "no more than four
  // times in one year" for Friday, Saturday, Sunday OR A HOLIDAY specifically,
  // and rental_annual_cap_per_member is a flat number with no day condition.
  // Writing 4 there would block a member's fifth WEEKDAY booking, which the
  // agreement permits. A wrong rule that refuses a homeowner is worse than an
  // unenforced one a person can catch, so this stays manual until the column
  // can express the condition.
  console.log('\n  rental_annual_cap_per_member: NOT SET on purpose, see the comment in this script');

  // ---- fees --------------------------------------------------------------
  console.log('\nFEES:');
  let added = 0, kept = 0;
  for (const f of FEES) {
    const { data: existing, error: exErr } = await supabase.from('amenity_fee_schedule')
      .select('id, amount_cents').eq('amenity_id', amenity.id)
      .eq('fee_type', f.fee_type).is('effective_to', null).maybeSingle();
    if (exErr) throw new Error('fee lookup failed: ' + exErr.message);

    if (existing && existing.amount_cents === f.amount_cents) {
      kept++; console.log('  ok       ' + f.label.padEnd(34) + '$' + (f.amount_cents / 100).toFixed(2));
      continue;
    }
    if (DRY) { added++; console.log('  would add ' + f.label.padEnd(33) + '$' + (f.amount_cents / 100).toFixed(2)); continue; }

    // A changed amount ends the old row rather than overwriting it, so a booking
    // taken last month can still be reconciled against the price it was quoted.
    if (existing) {
      await supabase.from('amenity_fee_schedule')
        .update({ effective_to: new Date().toISOString().slice(0, 10) }).eq('id', existing.id);
    }
    const { error: insErr } = await supabase.from('amenity_fee_schedule')
      .insert({ amenity_id: amenity.id, ...f });
    if (insErr) throw new Error('fee insert failed (' + f.label + '): ' + insErr.message);
    added++;
    console.log('  added    ' + f.label.padEnd(34) + '$' + (f.amount_cents / 100).toFixed(2)
      + (f.refundable ? '  refundable' : '') + (f.required ? '' : '  optional'));
  }

  const due = FEES.filter((f) => f.required).reduce((s, f) => s + f.amount_cents, 0);
  const refundable = FEES.filter((f) => f.required && f.refundable).reduce((s, f) => s + f.amount_cents, 0);
  console.log('\n  ' + added + ' added, ' + kept + ' already correct');
  console.log('  A renter pays $' + (due / 100).toFixed(2) + ' up front, of which $'
    + (refundable / 100).toFixed(2) + ' comes back after a clear inspection.');
  console.log('  Net cost to the homeowner: $' + ((due - refundable) / 100).toFixed(2));

  // ---- the door ----------------------------------------------------------
  const { data: comm } = await supabase.from('communities')
    .select('id, name, amenity_bookings_active').eq('id', amenity.community_id).maybeSingle();
  console.log('\nCOMMUNITY GATE:');
  console.log('  ' + comm.name + '  amenity_bookings_active = ' + comm.amenity_bookings_active);
  if (!comm.amenity_bookings_active) {
    console.log('  NOT FLIPPED. The agreement text still has to be loaded before a homeowner');
    console.log('  can accept it online, and payment has to be live. Flip it deliberately.');
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
