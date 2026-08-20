// ============================================================================
// scripts/repair_ea_contacts.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Cleans the two defects left in an already-built address book, without paying
// for another full mailbox walk and signature parse.
//
// 1. NAMES THAT ARE JUST THE ADDRESS. Outlook sometimes returns the address as
//    the display name, quotes included:
//    "'propertymanager@canyongatecincoranch.com'". That is what voice search
//    would have to match against when Ed says "send this to the property
//    manager".
//
// 2. MARKETING SENDERS. offers@e-offers.dominos.com made it in because the
//    noise filter had no rule for offers/deals or for marketing subdomains.
//    Twenty real people are the point of this book; junk buries them.
//
// Uses the same helpers the miner uses, so the rules cannot drift between the
// build and the repair.
//
// Only touches rows the miner created (source='email'). Anything a person
// entered is left alone.
//
//   node scripts/repair_ea_contacts.js --dry-run
//   node scripts/repair_ea_contacts.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { looksLikeAddress, prettyLocalPart, stripAddressFromName, isNoise, isRoleAccount } = require('./build_contacts_from_email');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');

// Keep whatever real words the display name carried before falling back to the
// local part: "Vantaca Billing (billing@vantaca.com)" is Vantaca Billing, and
// renaming it from the address would have made it "System".
function betterName(r) {
  return stripAddressFromName(r.name) || prettyLocalPart(r.email);
}

(async () => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('ea_contacts')
      .select('id, name, email, organization, source, sent_count, message_count')
      .eq('source', 'email').order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error('read failed: ' + error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log(rows.length + ' mined contacts' + (DRY ? '  [DRY RUN]' : ''));

  // Same two rules the miner now applies: marketing/automated senders, and
  // shared role accounts Ed has never written to (a notification stream, not
  // a person).
  // A shared role account goes only when it adds nothing. Checking the domain
  // first mattered: rmwbh.com already has four named attorneys behind
  // info@, and vantaca.com has twenty-seven people behind info@, so those are
  // pure duplication. But siibrands.com and electionbuddy.com have NO other
  // contact, and deleting the generic address there loses the organisation
  // entirely. Keeping a thin contact beats losing a real vendor.
  const namedDomains = new Set(rows.filter((r) => !isRoleAccount(r.email))
    .map((r) => r.email.split('@')[1].toLowerCase()));

  function isJunk(r) {
    if (isNoise(r.email, r.name)) return true;          // marketing and automated
    if (!isRoleAccount(r.email)) return false;
    if (r.sent_count > 0) return false;                 // Ed wrote to it, it stays
    const domain = r.email.split('@')[1].toLowerCase();
    if (namedDomains.has(domain)) return true;          // a real person already covers it
    // No other contact there. Keep it only if the relationship is ongoing
    // rather than one blast: Porsche and Wayfair wrote once, a vendor recurs.
    return r.message_count < 3;
  }
  const junk = rows.filter(isJunk);
  const badName = rows.filter((r) => !isNoise(r.email, r.name) && looksLikeAddress(r.name));

  console.log('\n' + junk.length + ' marketing/automated to remove:');
  junk.forEach((r) => console.log('  ' + String(r.name).slice(0, 30).padEnd(32) + r.email));

  console.log('\n' + badName.length + ' whose name is just the address:');
  badName.forEach((r) => console.log('  ' + JSON.stringify(r.name).slice(0, 44).padEnd(46)
    + '->  ' + betterName(r)));

  if (DRY) return;

  let removed = 0, renamed = 0;
  for (const r of junk) {
    const { error } = await supabase.from('ea_contacts').delete().eq('id', r.id);
    if (error) console.warn('  ! delete ' + r.email + ': ' + error.message); else removed++;
  }
  for (const r of badName) {
    const { error } = await supabase.from('ea_contacts')
      .update({ name: betterName(r) }).eq('id', r.id);
    if (error) console.warn('  ! rename ' + r.email + ': ' + error.message); else renamed++;
  }
  console.log('\nremoved ' + removed + ', renamed ' + renamed);

  const { count } = await supabase.from('ea_contacts').select('id', { count: 'exact', head: true });
  console.log(count + ' contacts remain');
})().catch((e) => { console.error('repair failed:', e.message); process.exit(1); });
