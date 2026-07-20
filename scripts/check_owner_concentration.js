// ============================================================================
// scripts/check_owner_concentration.js  (Ed 2026-07-20)
// ----------------------------------------------------------------------------
// Black-hole detector. A "Current Resident" export + dedupe-by-name once
// collapsed 62 distinct Lakes of Pine Forest owners onto ONE contact (Folake
// Adenuga), who then received 9 violation letters meant for real owners. The
// symptom is always the same shape: a single INDIVIDUAL contact ends up owning
// an implausible number of properties. Builders and institutional investors
// (LLC / Homes / Properties / Trust / Rent / Borrower …) legitimately own many;
// a person named "Jane Smith" owning 40 homes is a data collapse.
//
// This flags any NON-corporate contact owning >= THRESHOLD properties. Wired
// into `npm test` so the bug class can never silently return — if it fires,
// investigate before shipping. Run standalone: `node scripts/check_owner_concentration.js`.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const THRESHOLD = 8; // a private individual owning 8+ homes in the portfolio is suspicious
const CORPORATE = /\b(LLC|L\.L\.C|INC|CORP|CO\.|COMPANY|HOMES?|PROPERT(Y|IES)|TRUST|RENT|RENTALS?|MANAGEMENT|BORROWER|GROUP|HOLDINGS?|CAPITAL|INVESTMENTS?|INVESTOR|PARTNERS?|REALTY|BUILDERS?|DEVELOPMENT|ASSOCIATES?|ENTERPRISES?|VENTURES?|FUND|REIT|LP|LTD|BANK|HOA|ASSOCIATION)\b/i;

async function fetchAllOwnerships() {
  const rows = [];
  let from = 0;
  // ordered + paginated (Supabase 1000-row cap) — see CLAUDE.md truncation scar
  while (true) {
    const { data, error } = await supabase
      .from('property_ownerships')
      .select('contact_id, contact:contact_id(full_name)')
      .is('end_date', null)
      .order('contact_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function run() {
  const owns = await fetchAllOwnerships();
  const count = {}, name = {};
  for (const o of owns) {
    if (!o.contact_id) continue;
    count[o.contact_id] = (count[o.contact_id] || 0) + 1;
    name[o.contact_id] = (o.contact && o.contact.full_name) || o.contact_id;
  }
  const suspects = Object.entries(count)
    .filter(([id, c]) => c >= THRESHOLD && !CORPORATE.test(name[id] || ''))
    .sort((a, b) => b[1] - a[1]);

  console.log(`\n\x1b[1mOwner-concentration check\x1b[0m  (${owns.length} active ownerships, threshold ${THRESHOLD} for individuals)`);
  if (!suspects.length) {
    console.log('  \x1b[32m✓ No individual owner is over-assigned — no black-hole contact.\x1b[0m');
    return;
  }
  console.log(`  \x1b[31m✗ ${suspects.length} individual contact(s) own an implausible number of properties — likely a data collapse:\x1b[0m`);
  suspects.forEach(([id, c]) => console.log(`     ${String(c).padStart(4)} × ${name[id]}   (contact ${id})`));
  console.log('\n  If any of these is a real person, confirm; otherwise it is an owner-import collapse — restore from the roster.');
  process.exit(1);
}

run().catch((e) => { console.error('[owner-concentration] check failed:', e.message); process.exit(1); });
