// ============================================================================
// lib/portal/community_calendar.js  (extracted 2026-11-27 from api/portal.js GET /community-calendar)
// ----------------------------------------------------------------------------
// One community's calendar as the homeowner portal shows it: events and meetings
// (cancelled ones dropped) plus amenity bookings as "Reserved" (never who booked).
// Shared by the portal's Calendar tile and Claire (lib/lookups community_calendar),
// so both always say the same thing.
// ============================================================================
const MEETING_TYPES = ['annual_meeting', 'board_meeting', 'special_meeting', 'meeting'];

async function communityCalendarItems(supabase, communityId, { fromMs = Date.now() - 30 * 864e5, toMs = Date.now() + 365 * 864e5 } = {}) {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const items = [];
  const { data: evs, error: evErr } = await supabase
    .from('events')
    .select('id, name, event_type, description, location, scheduled_start_at, scheduled_end_at, status')
    .eq('community_id', communityId)
    .gte('scheduled_start_at', from)
    .lte('scheduled_start_at', to)
    .order('scheduled_start_at', { ascending: true })
    .limit(200);
  if (evErr) throw new Error('events read failed: ' + evErr.message);
  for (const e of evs || []) {
    if (String(e.status || '').toLowerCase() === 'cancelled') continue;
    const isMeeting = MEETING_TYPES.includes(e.event_type);
    items.push({ id: e.id, kind: isMeeting ? 'meeting' : 'event', meeting_type: isMeeting ? e.event_type : null, title: e.name, description: e.description || null,
      location: e.location || null, starts_at: e.scheduled_start_at, ends_at: e.scheduled_end_at || null, link: isMeeting ? '/portal/meetings' : null });
  }
  const { data: rentals, error: rErr } = await supabase
    .from('amenity_rentals')
    .select('id, event_date, arrival_time, departure_time, status, amenities:amenity_id(name)')
    .eq('community_id', communityId)
    .in('status', ['pending_payment', 'confirmed', 'completed'])
    .gte('event_date', from.slice(0, 10))
    .lte('event_date', to.slice(0, 10))
    .order('event_date', { ascending: true })
    .limit(300);
  if (rErr) throw new Error('rentals read failed: ' + rErr.message);
  for (const r of rentals || []) {
    items.push({ id: r.id, kind: 'amenity_booking', title: 'Reserved', description: null, location: (r.amenities && r.amenities.name) || 'Amenity',
      starts_at: r.event_date + 'T' + String(r.arrival_time || '00:00:00'), ends_at: r.event_date + 'T' + String(r.departure_time || '23:59:00'), link: null });
  }
  items.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  return items;
}

module.exports = { communityCalendarItems, MEETING_TYPES };
