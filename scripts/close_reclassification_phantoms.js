// scripts/close_reclassification_phantoms.js
// ---------------------------------------------------------------------------
// Close "reclassification phantoms": an open violation whose category no longer
// matches its originating observation's (alias-canonical) category, because the
// observation was RECLASSIFIED after the fact and the old violation was left
// open. Ed 2026-09-18: "if a letter went out it was a reclassification the
// system kept open — close those; the old one should not be in the system."
//
// Verified before shipping (scripts scratchpad): all 84 Eaglewood phantoms had
// a courtesy_1 letter ALREADY MAILED under the old category, none had a live
// draft. The mailed notice cited the OLD category's covenant text, so we do NOT
// re-point + keep open (escalating on a mismatched notice is the §209 risk) —
// we VOID the leftover. If the reclassified issue is still live, the next drive
// picks it up clean under the correct category.
//
// SAFETY: only touches courtesy_1 / courtesy_2 (never certified_209 /
// fine_assessed). Skips any violation carrying a LIVE draft (nothing queued
// dies). VOID (reversible, audit trail), never hard-delete.
//
// DRY-RUN by default. --commit to void. --community <id> to scope.
// ---------------------------------------------------------------------------
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const COMMIT = process.argv.includes('--commit');
const ONLY_ID = process.argv.includes('--community') ? process.argv[process.argv.indexOf('--community') + 1] : null;
const TERMINAL = ['cured', 'closed', 'voided'];
const PROTECTED_STAGE = ['certified_209', 'fine_assessed'];
const LIVE_DRAFT = ['draft', 'awaiting_approval', 'approved', 'printed'];

async function canonFn() {
  const { data, error } = await supabase.from('enforcement_category_aliases').select('alias_category_id, canonical_category_id').eq('status', 'confirmed');
  if (error) throw new Error('aliases: ' + error.message);
  const m = {}; (data || []).forEach((a) => { m[a.alias_category_id] = a.canonical_category_id; });
  return (c) => m[c] || c;
}
const pageAll = async (t, sel, f, cid) => {
  let out = [], fr = 0;
  for (;;) { let q = supabase.from(t).select(sel).eq('community_id', cid).order('id', { ascending: true }).range(fr, fr + 999); if (f) q = f(q);
    const { data, error } = await q; if (error) throw new Error(t + ': ' + error.message); out = out.concat(data); if (data.length < 1000) break; fr += 1000; }
  return out;
};

async function plan(c, canon) {
  const vios = await pageAll('violations', 'id, property_id, primary_category_id, current_stage, resolved_at, opened_from_observation_id', null, c.id);
  const openV = vios.filter((v) => !TERMINAL.includes(v.current_stage) && !v.resolved_at);
  const obsIds = [...new Set(openV.map((v) => v.opened_from_observation_id).filter(Boolean))];
  const obs = {};
  for (let i = 0; i < obsIds.length; i += 200) { const { data, error } = await supabase.from('property_observations').select('id, category_id').in('id', obsIds.slice(i, i + 200)); if (error) throw new Error('obs: ' + error.message); (data || []).forEach((o) => { obs[o.id] = o; }); }
  const openIds = openV.map((v) => v.id);
  const liveDraft = new Set();
  for (let i = 0; i < openIds.length; i += 200) { const { data, error } = await supabase.from('interactions').select('violation_id, status').in('violation_id', openIds.slice(i, i + 200)).ilike('type', 'letter%').in('status', LIVE_DRAFT); if (error) throw new Error('interactions: ' + error.message); (data || []).forEach((l) => liveDraft.add(l.violation_id)); }

  const hits = [];
  for (const v of openV) {
    if (PROTECTED_STAGE.includes(v.current_stage)) continue;
    if (liveDraft.has(v.id)) continue;
    const o = v.opened_from_observation_id && obs[v.opened_from_observation_id];
    if (!o || !o.category_id) continue;
    if (canon(o.category_id) === canon(v.primary_category_id)) continue; // matches — fine
    hits.push(v.id);
  }
  return hits;
}

(async () => {
  const canon = await canonFn();
  let comms;
  if (ONLY_ID) { const { data, error } = await supabase.from('communities').select('id, name').eq('id', ONLY_ID); if (error) throw error; comms = data; }
  else { const { data, error } = await supabase.from('communities').select('id, name').order('name'); if (error) throw error; comms = data; }

  console.log(`\nCLOSE RECLASSIFICATION PHANTOMS  ${COMMIT ? '*** COMMIT ***' : '(DRY-RUN)'}   ${new Date().toISOString().slice(0, 16)}`);
  let total = 0; const all = [];
  for (const c of comms) {
    const hits = await plan(c, canon);
    if (hits.length) { console.log(`  ${(c.name || c.id).slice(0, 32).padEnd(32)} : ${hits.length}`); total += hits.length; all.push(...hits); }
  }
  console.log(`  TOTAL to close: ${total}`);
  if (!COMMIT) { console.log('\n  DRY-RUN. --commit to void.\n'); return; }

  console.log(`\n  Voiding ${all.length}...`);
  let done = 0;
  for (const id of all) {
    const { error } = await supabase.from('violations').update({
      current_stage: 'voided', resolved_at: new Date().toISOString(), resolved_via: 'voided',
      resolved_notes: 'reclassification phantom — observation recategorized after courtesy notice mailed; old category left open (cleanup 2026-09-18)',
    }).eq('id', id);
    if (error) { console.error('  FAILED', id, error.message); continue; }
    done++; if (done % 25 === 0) console.log(`    ...${done}/${all.length}`);
  }
  console.log(`\n  DONE. Voided ${done}/${all.length}.\n`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
