// ============================================================================
// lib/payments/payment_identity.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Who a payment on this lot belongs to, resolved SERVER-SIDE at checkout:
// the lot, its community, the CURRENT owner tenure, that tenure's owner
// contact, the lot's durable Trusted account number, and the tenure's balance.
//
// Never uses properties.vantaca_account_id: after a sale that column can still
// hold the seller's number. The tenure is the owner; the Trusted number is the
// lot's durable identity.
// ============================================================================

async function must(query, what) {
  const { data, error } = await query;
  if (error) throw new Error(`[payment_identity] ${what} failed: ${error.message}`);
  return data;
}

// -> { ok:true, identity } | { ok:false, status, error, hint }
async function resolvePaymentIdentity(supabase, propertyId) {
  if (!propertyId) return { ok: false, status: 400, error: 'property_required' };
  const property = await must(supabase.from('properties')
    .select('id, community_id, street_address, trusted_account_number').eq('id', propertyId).maybeSingle(), 'property');
  if (!property) return { ok: false, status: 404, error: 'property_not_found' };

  const community = await must(supabase.from('communities')
    .select('id, name, slug, hoa_legal_name, stripe_connected_account_id, gl_cutover_date')
    .eq('id', property.community_id).maybeSingle(), 'community');
  if (!community) return { ok: false, status: 404, error: 'community_not_found' };

  const tenures = await must(supabase.from('ownership_tenures')
    .select('id, community_id, property_id, start_date, vantaca_account_id')
    .eq('property_id', property.id).eq('kind', 'owner').is('end_date', null).limit(2), 'current tenure');
  if (!tenures.length) return { ok: false, status: 409, error: 'no_current_owner', hint: 'This lot has no current owner on record.' };
  if (tenures.length > 1) return { ok: false, status: 409, error: 'ambiguous_current_owner', hint: 'This lot has more than one current owner period; staff must resolve it before online payment.' };
  const tenure = tenures[0];

  if (!property.trusted_account_number) {
    return { ok: false, status: 409, error: 'no_trusted_account_number', hint: 'This lot has no Trusted account number yet.' };
  }

  const owners = await must(supabase.from('property_ownerships')
    .select('contact_id, is_primary, start_date').eq('tenure_id', tenure.id)
    .order('is_primary', { ascending: false }).order('start_date', { ascending: true }).limit(1), 'owner contact');
  const contactId = owners.length ? owners[0].contact_id : null;

  const balRows = await must(supabase.from('v_current_owner_balance')
    .select('balance_cents').eq('tenure_id', tenure.id), 'tenure balance');
  const balanceCents = balRows.reduce((s, r) => s + Number(r.balance_cents || 0), 0);

  return {
    ok: true,
    identity: {
      property: { id: property.id, street_address: property.street_address, trusted_account_number: property.trusted_account_number },
      community,
      tenure: { id: tenure.id, start_date: tenure.start_date },
      contact_id: contactId,
      balance_cents: balanceCents,
    },
  };
}

module.exports = { resolvePaymentIdentity };
