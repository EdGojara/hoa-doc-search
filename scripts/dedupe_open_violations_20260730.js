// ============================================================================
// scripts/dedupe_open_violations_20260730.js  (Ed 2026-07-30)
// ----------------------------------------------------------------------------
// One-time cleanup. The multi-finding photo AI opened DUPLICATE violations:
// two OPEN violations of the SAME category on one property (e.g. "Lawn height"
// x2), because findOrContinueViolation is look-then-insert with no lock and the
// burst of same-category observations slipped through before either committed.
//
// This collapses each (property, same primary_category_id) OPEN group to ONE:
// keep the furthest-advanced (tie -> earliest opened), void the rest. Different
// categories are LEFT SEPARATE (Ed: "I want them separate but no duplicates").
// Never touches a violation that already had a letter sent.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const OPEN = ['courtesy_1', 'courtesy_2', 'certified_209', 'fine_assessed'];
const RANK = { courtesy_1: 1, courtesy_2: 2, certified_209: 3, fine_assessed: 4 };
const APPLY = process.argv.includes('--apply');

(async () => {
  // Paginate — there are ~2900 open violations and PostgREST silently caps a
  // single read at 1000 (the truncation scar). Page through ALL of them, ordered,
  // or the dedup only sees a third of the portfolio.
  const v = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await s.from('violations')
      .select('id, property_id, primary_category_id, current_stage, opened_at, prop:property_id(street_address), cat:primary_category_id(label)')
      .in('current_stage', OPEN).order('id', { ascending: true }).range(from, from + 999);
    if (error) { console.error('lookup failed:', error.message); process.exit(1); }
    v.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log(`Scanned ${v.length} open violations.`);

  const groups = {};
  for (const r of v) { const k = r.property_id + '|' + r.primary_category_id; (groups[k] = groups[k] || []).push(r); }
  const dupes = Object.values(groups).filter((a) => a.length > 1);

  // Ed 2026-07-30: nothing in this batch has actually been mailed (the drafts
  // carry sent_at but no physical letter went out), so we void ALL same-category
  // duplicates, keeping one each. No mail-skip.
  const toVoid = [];
  for (const grp of dupes) {
    const ranked = grp.slice().sort((a, b) => (RANK[b.current_stage] || 0) - (RANK[a.current_stage] || 0) || String(a.opened_at).localeCompare(String(b.opened_at)));
    const keep = ranked[0];
    for (const r of ranked.slice(1)) {
      toVoid.push({ row: r, keepId: keep.id, label: keep.cat?.label, addr: keep.prop?.street_address, keepStage: keep.current_stage });
    }
  }

  console.log(`${dupes.length} duplicate groups; voiding ${toVoid.length} extra rows (keeping one each).`);
  for (const t of toVoid) console.log(`  ${t.addr} · ${t.label} · void ${t.row.id.slice(0, 8)} (${t.row.current_stage}) -> keep ${t.keepId.slice(0, 8)} (${t.keepStage})`);

  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to void.'); return; }

  let done = 0;
  for (const t of toVoid) {
    const { error: upErr } = await s.from('violations').update({
      current_stage: 'voided', resolved_at: new Date().toISOString(), resolved_via: 'voided',
      resolved_notes: `Duplicate of ${t.keepId} — same category auto-opened twice from one inspection (multi-finding photo AI). Voided in 2026-07-30 dedup cleanup.`,
      updated_at: new Date().toISOString(),
    }).eq('id', t.row.id).in('current_stage', OPEN); // guard: only if still open
    if (upErr) { console.error('  void failed', t.row.id, upErr.message); continue; }
    done++;
  }
  console.log(`Voided ${done} duplicate violations.`);
})();
