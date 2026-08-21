// ============================================================================
// scripts/configure_mud_convenience_fee.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Turns on the $1 MUD convenience fee that the platform has been able to apply
// since 2026-07-23 and never has, because it was never configured for a single
// vendor.
//
// Ed: "make sure emma adds the $1 to the invoice, this is the ACH fee and is
// listed in the email."
//
// WHAT WAS ACTUALLY HAPPENING. lib/ap/convenience_fee.js exists, both AP intake
// paths call it, and every MUD vendor had is_mud = false and
// convenience_fee_cents = 0. So the fee never applied, and staff filled the gap
// by hand:
//
//   2026-08-10  Alisha Merchant  "Please add a $1 to this invoice"  x5
//   2026-08-21  Martha Bravo     "Please add $1 to this invoice"
//
// Six emails, two people, none of them acted on, all still sitting unread in
// emma@. A capability nobody switched on looks exactly like a capability that
// does not exist, and the staff workaround is the tell.
//
// This only sets the vendor flags. It deliberately does NOT touch existing
// invoices: 8 of the 15 MUD bills on file are already posted to the GL, and
// adding a dollar to a posted invoice puts the invoice and the books out of
// agreement. That back-fix is a separate decision for Ed and Kat.
//
// IDEMPOTENT.
//
//   node scripts/configure_mud_convenience_fee.js --dry-run
//   node scripts/configure_mud_convenience_fee.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');

const FEE_CENTS = 100;  // $1 per invoice, the districts' ACH fee

// Matched by name rather than hand-listed ids, so a MUD added later is caught
// by a re-run instead of being silently missed.
const MUD_NAME = /\b(m\.?u\.?d\.?|municipal utility district)\b/i;

(async () => {
  const { data: vendors, error } = await supabase.from('vendors')
    .select('id, name, is_mud, convenience_fee_cents, is_active')
    .order('name');
  if (error) throw new Error('vendor read failed: ' + error.message);

  const muds = (vendors || []).filter((v) => MUD_NAME.test(v.name || ''));
  console.log(muds.length + ' MUD vendor(s)' + (DRY ? '  [DRY RUN]' : ''));

  let changed = 0, already = 0;
  for (const v of muds) {
    const needs = v.is_mud !== true || Number(v.convenience_fee_cents) !== FEE_CENTS;
    if (!needs) { already++; console.log('  ok       ' + v.name); continue; }
    if (DRY) { changed++; console.log('  would set ' + v.name); continue; }
    const { error: uErr } = await supabase.from('vendors')
      .update({ is_mud: true, convenience_fee_cents: FEE_CENTS }).eq('id', v.id);
    if (uErr) { console.warn('  ! ' + v.name + ': ' + uErr.message); continue; }
    changed++;
    console.log('  set      ' + String(v.name).padEnd(36) + '$' + (FEE_CENTS / 100).toFixed(2) + ' per invoice');
  }

  console.log('\n' + changed + ' configured, ' + already + ' already correct');

  // Duplicate vendor records mean a bill can land on the copy that has no fee,
  // which is the same failure wearing a different hat.
  const seen = new Map();
  for (const v of vendors || []) {
    const key = String(v.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) continue;
    (seen.get(key) || seen.set(key, []).get(key)).push(v);
  }
  const dupes = [...seen.values()].filter((g) => g.length > 1);
  if (dupes.length) {
    console.log('\nDUPLICATE vendor records (a bill can land on the copy without the fee):');
    for (const g of dupes) {
      console.log('  ' + g[0].name + '  x' + g.length);
      g.forEach((v) => console.log('      ' + v.id + '  is_mud=' + v.is_mud
        + '  fee=' + (v.convenience_fee_cents || 0)));
    }
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
