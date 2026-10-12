// ============================================================================
// lib/ap/former_client.js  (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// A former client's bills never come up for routine payment. Eaglewood left on
// 9/30 with two attorney invoices still open; those are held as former-client
// items, not approved, paid, deleted or reversed.
//
// Former client = management_status 'terminated', or 'terminating' with a last
// day already past. A community still inside its notice period is managed as
// usual: its bills are real and get paid.
// ============================================================================

function todayCentral() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function isFormerClient(c, today = todayCentral()) {
  if (!c) return false;
  if (c.management_status === 'terminated' || c.management_status === 'archived') return true;
  return c.management_status === 'terminating' && !!c.management_end_date && String(c.management_end_date).slice(0, 10) < today;
}

function formerClientReason(c) {
  return `${c && c.name ? c.name : 'This community'} is a former client${c && c.management_end_date ? ` (last day ${c.management_end_date})` : ''}. Its bills are held, not approved or paid in the routine queue.`;
}

// Set of former-client community ids (one small read).
async function formerClientIds(supabase, today = todayCentral()) {
  const { data, error } = await supabase.from('communities').select('id, name, management_status, management_end_date')
    .in('management_status', ['terminating', 'terminated', 'archived']);
  if (error) throw error;
  return new Set((data || []).filter((c) => isFormerClient(c, today)).map((c) => c.id));
}

// The community row when it is a former client, else null.
async function formerClientFor(supabase, communityId, today = todayCentral()) {
  if (!communityId) return null;
  const { data, error } = await supabase.from('communities').select('id, name, management_status, management_end_date').eq('id', communityId).maybeSingle();
  if (error) throw error;
  return isFormerClient(data, today) ? data : null;
}

module.exports = { isFormerClient, formerClientReason, formerClientIds, formerClientFor };
