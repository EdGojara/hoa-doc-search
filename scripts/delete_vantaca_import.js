// ============================================================================
// scripts/delete_vantaca_import.js
// ----------------------------------------------------------------------------
// Ed 2026-06-18: clean-slate a community's Vantaca-imported violations so the
// full report can be re-imported fresh with the fixed parser (correct latest-
// event stage + date). ONLY touches source='vantaca_import' rows — inspection-
// /manual-/homeowner-created violations are never deleted.
//
// Safety: of the imported rows, the only blocking dependents are
// violation_continuations (ON DELETE RESTRICT). Those are deleted first for the
// targeted violations. Everything else FK-resolves automatically (letters
// CASCADE, interactions/receipts SET NULL). Corrections/fines on imported rows
// are checked and ABORT the run if present (those carry real downstream state).
//
// DRY RUN by default. --apply to delete. --community=<slug> to scope (REQUIRED
// for --apply — refuses to wipe all communities at once).
//
//   node scripts/delete_vantaca_import.js --community=waterview            # dry run
//   node scripts/delete_vantaca_import.js --apply --community=waterview     # delete
// ============================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const APPLY = process.argv.includes('--apply');
const commArg = (process.argv.find((a) => a.startsWith('--community=')) || '').split('=')[1] || null;

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

(async () => {
  if (APPLY && !commArg) {
    console.error('Refusing to --apply without --community=<slug>. Scope it.');
    process.exit(1);
  }
  let communityId = null, communityName = 'ALL';
  if (commArg) {
    const { data: c } = await supabase.from('communities').select('id, name').eq('slug', commArg).maybeSingle();
    if (!c) { console.error('community not found:', commArg); process.exit(1); }
    communityId = c.id; communityName = c.name;
  }
  console.log('Scope:', communityName);

  // Collect imported violation ids in scope.
  let ids = [], from = 0;
  while (true) {
    let q = supabase.from('violations').select('id').eq('source', 'vantaca_import').range(from, from + 999);
    if (communityId) q = q.eq('community_id', communityId);
    const { data, error } = await q;
    if (error) { console.error(error.message); process.exit(1); }
    ids.push(...data.map((r) => r.id));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log('Imported violations in scope:', ids.length);
  if (ids.length === 0) { console.log('Nothing to delete.'); return; }

  // Count dependents.
  const countIn = async (table) => {
    let c = 0;
    for (const part of chunk(ids, 200)) {
      const { count } = await supabase.from(table).select('violation_id', { count: 'exact', head: true }).in('violation_id', part);
      c += count || 0;
    }
    return c;
  };
  const continuations = await countIn('violation_continuations');
  const corrections = await countIn('violation_corrections');
  const fines = await countIn('fine_posting_queue');
  const letters = await countIn('violation_letters');
  console.log(`Dependents — continuations: ${continuations} (will delete first), corrections: ${corrections}, fines: ${fines}, letters: ${letters}`);

  if (corrections > 0 || fines > 0) {
    console.error('\nABORT: imported violations have corrections or queued fines — real downstream state. Resolve those before a clean wipe.');
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — would delete', continuations, 'continuation rows then', ids.length, 'violations. Re-run with --apply.');
    return;
  }

  // 1) Clear RESTRICT blockers (continuations) for the targeted violations.
  let contDeleted = 0;
  for (const part of chunk(ids, 200)) {
    const { error, count } = await supabase.from('violation_continuations').delete({ count: 'exact' }).in('violation_id', part);
    if (error) { console.error('continuation delete failed:', error.message); process.exit(1); }
    contDeleted += count || 0;
  }
  // 2) Delete the violations.
  let vDeleted = 0;
  for (const part of chunk(ids, 200)) {
    const { error, count } = await supabase.from('violations').delete({ count: 'exact' }).in('id', part);
    if (error) { console.error('violation delete failed:', error.message); process.exit(1); }
    vDeleted += count || 0;
  }
  console.log(`\nAPPLIED — deleted ${contDeleted} continuations + ${vDeleted} imported violations for ${communityName}. Re-import the full report to repopulate.`);
})();
