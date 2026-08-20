// ============================================================================
// scripts/seed_canyon_gate_ups.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Puts the Canyon Gate / United Protective Services security-proposal thread
// into trustEd so Tessa can act on it, instead of it living only in Ed's inbox.
//
// Ed: "we need everything to be captured in trusted platform."
//
// Three things, all idempotent:
//
// 1. Tessa's address book (ea_contacts) was EMPTY — zero rows. That is the real
//    reason she cannot "email the board on my behalf": she has nobody to
//    address. Loads the five Canyon Gate board role aliases plus the UPS reps.
//
//    The board aliases go in ea_contacts, NOT community_contacts.
//    community_contacts is the homeowner-facing portal directory; publishing
//    president@ there hands every homeowner the board president's address.
//    They also do NOT go in board_members, because that table needs a real
//    person's name and we do not know who holds these seats — a placeholder
//    there would flow into the roster, the board portal and the nominations
//    seat derivation as if it were a director on file.
//
// 2. United Protective Services as a vendor, so a signed contract has somewhere
//    to land later.
//
// 3. Fixes a mangled address in Canyon Gate's homeowner directory:
//    "info@bedrocktpropertymanager@canyongateatcincoranch.comx.com" is
//    info@bedrocktx.com with the property-manager address spliced into the
//    middle of the domain. Homeowner-facing. Swept all 12 addresses in
//    community_contacts; this was the only broken one.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CG = 'canyongateatcincoranch.com';
const BOARD = [
  ['Canyon Gate Board President',      'President',      `president@${CG}`],
  ['Canyon Gate Board Vice President', 'Vice President', `vicepresident@${CG}`],
  ['Canyon Gate Board Secretary',      'Secretary',      `secretary@${CG}`],
  ['Canyon Gate Board Treasurer',      'Treasurer',      `treasurer@${CG}`],
  ['Canyon Gate Board Director',       'Director',       `director@${CG}`],
];

const UPS = [
  ['Haley Bellanger', 'Sales & Marketing Manager', 'haley.bellanger@united-protective.com', '832-986-3989'],
  ['Grant Gerber',    'United Protective Services', 'grant.gerber@united-protective.com',   null],
];

async function upsertContact(row) {
  // Unique index is on lower(email), so match on email and update in place.
  const { data: ex, error: se } = await supabase.from('ea_contacts')
    .select('id').ilike('email', row.email).limit(1);
  if (se) throw new Error(`ea_contacts lookup failed: ${se.message}`);
  if (ex && ex.length) {
    const { error } = await supabase.from('ea_contacts').update(row).eq('id', ex[0].id);
    if (error) throw new Error(`ea_contacts update failed: ${error.message}`);
    return 'updated';
  }
  const { error } = await supabase.from('ea_contacts').insert(row);
  if (error) throw new Error(`ea_contacts insert failed: ${error.message}`);
  return 'added';
}

(async () => {
  for (const [name, role, email] of BOARD) {
    const r = await upsertContact({
      name, email, role, category: 'board',
      organization: 'Canyon Gate at Cinco Ranch HOA',
      // Says out loud what this row is, so nobody later reads it as a person.
      notes: 'Board role alias on the association domain. The individual director '
           + 'holding this seat is not on file. Addresses the seat, not a named person.',
      created_by: 'egojara@bedrocktx.com',
    });
    console.log(`  ${r.padEnd(8)} ${role.padEnd(15)} ${email}`);
  }

  for (const [name, role, email, phone] of UPS) {
    const r = await upsertContact({
      name, email, role, phone, category: 'vendor',
      organization: 'United Protective Services',
      notes: 'Security proposal for Canyon Gate at Cinco Ranch, sent 2026-07-22. '
           + '24/7 coverage. Asked to meet with the full board.',
      created_by: 'egojara@bedrocktx.com',
    });
    console.log(`  ${r.padEnd(8)} ${String(role).slice(0, 15).padEnd(15)} ${email}`);
  }

  // Vendor record so a contract and its invoices have somewhere to land.
  const { data: v, error: ve } = await supabase.from('vendors')
    .select('id, name').ilike('name', 'United Protective%').limit(1);
  if (ve) console.warn('  ! vendor lookup failed:', ve.message);
  else if (v && v.length) console.log(`  exists   vendor  ${v[0].name}`);
  else {
    const { error } = await supabase.from('vendors').insert({
      management_company_id: '00000000-0000-0000-0000-000000000001',
      name: 'United Protective Services',
      contact_name: 'Haley Bellanger',
      contact_email: 'haley.bellanger@united-protective.com',
      phone: '713-782-2639',
      is_active: true,
    });
    if (error) console.warn('  ! vendor insert failed:', error.message);
    else console.log('  added    vendor  United Protective Services');
  }

  // The homeowner-facing broken address.
  const BAD = 'info@bedrocktpropertymanager@canyongateatcincoranch.comx.com';
  const { data: bad, error: be } = await supabase.from('community_contacts')
    .select('id, name, email').eq('email', BAD);
  if (be) console.warn('  ! directory lookup failed:', be.message);
  else if (!bad || !bad.length) console.log('  ok       directory address already correct');
  else {
    for (const row of bad) {
      const { error } = await supabase.from('community_contacts')
        .update({ email: 'info@bedrocktx.com' }).eq('id', row.id);
      console.log(error ? `  ! directory fix failed: ${error.message}`
                        : `  fixed    directory "${row.name}" -> info@bedrocktx.com`);
    }
  }
})().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
