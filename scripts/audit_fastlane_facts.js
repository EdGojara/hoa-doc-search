// ============================================================================
// scripts/audit_fastlane_facts.js  (Ed 2026-09-10)
// ----------------------------------------------------------------------------
// Living gap report for Claire's fast-lane facts. For every Bedrock community,
// checks whether each operational fact the fast-lane answers (trash day, hours,
// amenity hours, contact, assessment, meeting dates) is present in the context
// block Claire actually sees (buildCommunityContextBlock) — and crucially marks
// facts N/A when they don't apply (a community with no pool has no pool hours;
// a community with no on-site office has no on-site hours). So the "still
// missing" column is a REAL chase list, not noise.
//
// Re-run after any backfill:  node scripts/audit_fastlane_facts.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { buildCommunityContextBlock } = require('../api/communities');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Detectors run against the built context block (what Claire sees).
const DET = {
  trash:      (b) => /TRASH & RECYCLING|\btrash\b|recycl/i.test(b),
  hours:      (b) => /(office|onsite|business)\s*hours?[^\n]*(\d|am|pm)/i.test(b),
  amenityHrs: (b) => /(pool|clubhouse|gate|gym|tennis|splash)[^\n]*(\d\s?(am|pm)|\bhours?\b|open|close)/i.test(b),
  phone:      (b) => /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(b),
  email:      (b) => /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(b),
  assessment: (b) => /assessment[^\n]*(\$?\s?\d{2,}|annual|monthly|quarterly|semi)/i.test(b),
  meeting:    (b) => /(annual|board)[^\n]*meeting|meeting[^\n]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|\d{1,2}\/\d)/i.test(b),
};
const COLS = Object.keys(DET);

// Applicability: which facts even apply to this community?
// - amenityHrs applies only if there's a pool or a listed amenity.
// - hours applies only if the community has an on-site office (onsite === yes)
//   OR management office hours are set; otherwise there's no "office" to give
//   hours for and the fast-lane correctly points to the management contact.
// Everything else (trash, phone, email, assessment, meeting) applies to every HOA.
function applicability(profile) {
  const hasPool = profile.has_pool === true;
  const amenities = Array.isArray(profile.amenities) ? profile.amenities : [];
  const onsite = String(profile.onsite || '').toLowerCase() === 'yes';
  const hasMgmtHours = !!(profile.office_hours || profile.onsite_hours);
  return {
    trash: true,
    hours: onsite || hasMgmtHours,
    amenityHrs: hasPool || amenities.length > 0,
    phone: true,
    email: true,
    assessment: true,
    meeting: true,
  };
}

(async () => {
  const { data: comms, error } = await supabase
    .from('communities')
    .select('id, name, profile')
    .order('name');
  if (error) throw error;

  const rows = [];
  const gaps = [];      // { community, fact }
  const totals = Object.fromEntries(COLS.map((c) => [c, { pop: 0, applicable: 0 }]));
  let n = 0;

  for (const c of comms) {
    let block = '';
    try { block = (await buildCommunityContextBlock(c.id)) || ''; } catch (_) { /* skip */ }
    if (!block) continue; // non-Bedrock / unresolved
    n++;
    const app = applicability(c.profile || {});
    const cells = {};
    for (const k of COLS) {
      if (!app[k]) { cells[k] = 'n/a'; continue; }
      totals[k].applicable++;
      const present = DET[k](block);
      if (present) { cells[k] = 'yes'; totals[k].pop++; }
      else { cells[k] = 'GAP'; gaps.push({ community: c.name, fact: k }); }
    }
    rows.push({ name: c.name, cells });
  }

  const fmt = (s) => (s === 'yes' ? 'yes' : s === 'GAP' ? 'GAP' : '·').padEnd(10);
  const header = 'COMMUNITY'.padEnd(24) + COLS.map((c) => c.slice(0, 9).padEnd(10)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) console.log(r.name.slice(0, 23).padEnd(24) + COLS.map((k) => fmt(r.cells[k])).join(''));
  console.log('-'.repeat(header.length));
  console.log(('POPULATED / applicable').padEnd(24) + COLS.map((c) => `${totals[c].pop}/${totals[c].applicable}`.padEnd(10)).join(''));
  console.log(`\n(${n} communities · "·" = not applicable · GAP = applicable but missing)`);

  // The real chase list, grouped by community.
  console.log('\n=== STILL MISSING (applicable gaps to backfill) ===');
  const byComm = {};
  for (const g of gaps) (byComm[g.community] = byComm[g.community] || []).push(g.fact);
  const names = Object.keys(byComm).sort();
  if (!names.length) console.log('  none — every applicable fact is populated.');
  for (const nm of names) console.log(`  ${nm}: ${byComm[nm].join(', ')}`);
})().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
