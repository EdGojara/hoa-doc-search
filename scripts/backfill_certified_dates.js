// ============================================================================
// scripts/backfill_certified_dates.js   (Ed 2026-07-21)
// ----------------------------------------------------------------------------
// The certified §209 letter dates ARE in the platform's source data — they came
// over in the Vantaca "Violation" export ("Certified Letter Notice - MM/DD/YYYY"
// in each case's status history). But the one-off "grouped" import that loaded
// the carryover certified cases used the IMPORT date, not the real certified
// date, so violations.opened_at is a batch date and the 180-day clock can't run.
//
// This reads the Vantaca export, pulls each case's actual certified-letter date,
// matches it to the trustEd certified violation by Vantaca ACCOUNT NUMBER (the
// reliable key) + category, and writes violations.certified_notice_date (added
// by migration 323).
//
//   DRY RUN (default):  node scripts/backfill_certified_dates.js "<file.xls>" <community_id>
//   WRITE:              node scripts/backfill_certified_dates.js "<file.xls>" <community_id> --commit
//
// Idempotent: only fills rows whose certified_notice_date is NULL (never
// overwrites a date already entered/confirmed). Re-runnable.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const FILE = process.argv[2];
const COMMUNITY = process.argv[3];
const COMMIT = process.argv.includes('--commit');
if (!FILE || !COMMUNITY) {
  console.error('usage: node scripts/backfill_certified_dates.js "<file.xls>" <community_id> [--commit]');
  process.exit(1);
}

const toISO = (d) => {
  const m = String(d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [, mo, da, yr] = m;
  yr = yr.length === 2 ? '20' + yr : yr;
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
};
const catWord = (s) => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean)[0] || '';

// Parse the Vantaca "Violation" export. Structure: a property block starts with
// a main row (account col2 + address col5) and a category label in col9; its
// status events follow as sub-rows in col9 ("Certified Letter Notice - <date>",
// "Pending Hearing - <date>", …). A property can hold MORE THAN ONE violation —
// each additional one is a fresh category-label line in col9 (no new account/
// address) followed by its own status events. So a case is keyed on
// (account, CATEGORY), not account alone. A status event is a line with a
// "- MM/DD/YYYY" in it; anything else in col9 is a category label = a new case.
function parseCases(path) {
  const wb = XLSX.readFile(path);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
  const STATUS_EVENT = /\s-\s*\d{1,2}\/\d{1,2}\/\d{2,4}/; // "... - MM/DD/YYYY ..."
  const cases = [];
  let curAccount = null, curAddr = null, cur = null;
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const acct = String(row[2] == null ? '' : row[2]).trim();
    const addr = String(row[5] == null ? '' : row[5]).trim();
    if (/^\d{6,}$/.test(acct) && addr) { curAccount = acct; curAddr = addr; } // new property block
    const c9 = String(row[9] == null ? '' : row[9]).trim();
    if (!c9) continue;
    if (STATUS_EVENT.test(c9)) {
      // a status event — capture the certified date onto the current case
      const m = c9.match(/certified[^0-9]*?(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (m && cur) { const iso = toISO(m[1]); if (iso && (!cur.certDate || iso > cur.certDate)) cur.certDate = iso; }
    } else if (curAccount) {
      // a category label — start a new case for (this property, this category)
      cur = { account: curAccount, address: curAddr, category: c9, certDate: null };
      cases.push(cur);
    }
  }
  return cases.filter((c) => c.certDate);
}

async function run() {
  const cases = parseCases(FILE);
  console.log(`Parsed ${cases.length} cases with a certified date from ${FILE}`);
  // index parsed dates by account (latest per account) + keep a per-account list for category matching
  const byAccount = {};
  for (const c of cases) { (byAccount[c.account] = byAccount[c.account] || []).push(c); }

  // trustEd certified cases for this community + their property's vantaca_account_id
  const { data: vios, error } = await supabase
    .from('violations')
    .select('id, certified_notice_date, enforcement_categories(label), property:property_id(street_address, vantaca_account_id)')
    .eq('community_id', COMMUNITY).eq('current_stage', 'certified_209').limit(2000);
  if (error) { console.error('violations query failed:', error.message); process.exit(1); }
  console.log(`trustEd certified cases: ${vios.length}`);

  let matched = 0, already = 0, noAcct = 0, noMatch = 0;
  const updates = [];
  for (const v of vios) {
    if (v.certified_notice_date) { already++; continue; }
    const acct = v.property && v.property.vantaca_account_id;
    if (!acct) { noAcct++; continue; }
    const list = byAccount[String(acct).trim()];
    if (!list || !list.length) { noMatch++; continue; }
    // if multiple parsed cases at this account, prefer one whose category first-word matches
    let pick = list[0];
    if (list.length > 1) {
      const vw = catWord(v.enforcement_categories && v.enforcement_categories.label);
      pick = list.find((c) => catWord(c.category) === vw) || list[0];
    }
    updates.push({ id: v.id, addr: v.property.street_address, date: pick.certDate });
    matched++;
  }

  console.log(`\nmatched ${matched} | already dated ${already} | no vantaca_account_id ${noAcct} | no file match ${noMatch}`);
  const dist = {}; updates.forEach((u) => { dist[u.date] = (dist[u.date] || 0) + 1; });
  console.log('dates to write (distribution):', JSON.stringify(dist, Object.keys(dist).sort(), 1));
  // flag ones already past 180 days (recertify candidates) as of today
  const today = new Date();
  const expired = updates.filter((u) => (today - new Date(u.date + 'T12:00:00Z')) / 86400000 > 180).length;
  console.log(`of these, ${expired} are already >180 days old (recertify / refer candidates)`);
  console.log('sample across dates:');
  const seen = new Set(); updates.forEach((u) => { if (!seen.has(u.date)) { seen.add(u.date); console.log(`  ${u.addr.padEnd(28)} ${u.date}`); } });

  if (!COMMIT) { console.log(`\nDRY RUN — re-run with --commit to write ${updates.length} certified dates.`); return; }

  let ok = 0;
  for (const u of updates) {
    const { error: uErr } = await supabase.from('violations').update({ certified_notice_date: u.date }).eq('id', u.id);
    if (uErr) { console.error('  update failed', u.addr, uErr.message); } else { ok++; }
  }
  console.log(`\n✓ wrote ${ok}/${updates.length} certified dates.`);
}

run().catch((e) => { console.error(e.message); process.exit(1); });
