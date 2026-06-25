// Diagnoses the "cured prior over-escalates new violation" bug against live data.
// (A) Confirms the fix resolves the Villegas/Linden Spruce 6/18 case.
// (B) Measures blast radius: open courtesy_2+ violations whose same-category
//     priors in the 12mo window are ALL terminal (cured/closed/voided) — i.e.
//     they were escalated only because cured priors were counted. READ-ONLY.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TERMINAL = ['cured', 'closed', 'voided'];
const OPEN_ESCALATED = ['courtesy_2', 'certified_209', 'fine_assessed'];
const log = (...a) => console.log(...a);

function monthsBefore(iso, months) {
  const d = new Date(iso); d.setMonth(d.getMonth() - months); return d.toISOString();
}

(async () => {
  // ---- (A) Villegas / Linden Spruce ----
  log('=== (A) Villegas case ===');
  const { data: prop } = await supabase.from('properties')
    .select('id, street_address').ilike('street_address', '%Linden Spruce%').limit(1).maybeSingle();
  if (prop) {
    const { data: vios } = await supabase.from('violations')
      .select('id, opened_at, primary_category_id, current_stage, quality_status')
      .eq('property_id', prop.id).order('opened_at', { ascending: true });
    log('Property:', prop.street_address);
    (vios || []).forEach((v) => log(`  ${String(v.opened_at).slice(0,10)}  cat=${(v.primary_category_id||'').slice(0,8)}  stage=${v.current_stage}  q=${v.quality_status}`));
    const open618 = (vios || []).find((v) => v.current_stage === 'courtesy_2');
    if (open618) {
      const priorsAll = (vios || []).filter((v) => v.id !== open618.id && v.primary_category_id === open618.primary_category_id
        && v.opened_at >= monthsBefore(open618.opened_at, 12) && v.opened_at <= open618.opened_at && v.quality_status !== 'superseded');
      const priorsActive = priorsAll.filter((v) => !TERMINAL.includes(v.current_stage));
      log(`  6/18 violation: priors(OLD incl. cured)=${priorsAll.length} -> courtesy_2 ; priors(NEW excl. terminal)=${priorsActive.length} -> ${priorsActive.length === 0 ? 'courtesy_1 ✓' : 'still escalated'}`);
    }
  } else { log('  (Linden Spruce property not found)'); }

  // ---- (B) Blast radius across all communities ----
  log('\n=== (B) Blast radius: open escalated violations whose priors are all terminal ===');
  // Page through all open escalated violations.
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('violations')
      .select('id, property_id, primary_category_id, opened_at, current_stage, community_id, quality_status')
      .in('current_stage', OPEN_ESCALATED).neq('quality_status', 'superseded')
      .order('opened_at', { ascending: false }).range(from, from + 999);
    if (error) { log('query error', error.message); break; }
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  log('Open escalated (courtesy_2/certified_209/fine_assessed) violations:', all.length);

  let overEscalated = 0; const examples = [];
  for (const v of all) {
    if (!v.property_id || !v.primary_category_id) continue;
    const { data: priors } = await supabase.from('violations')
      .select('id, current_stage, quality_status, opened_at')
      .eq('property_id', v.property_id).eq('primary_category_id', v.primary_category_id)
      .neq('id', v.id).neq('quality_status', 'superseded')
      .gte('opened_at', monthsBefore(v.opened_at, 12)).lte('opened_at', v.opened_at);
    const active = (priors || []).filter((p) => !TERMINAL.includes(p.current_stage));
    const terminal = (priors || []).filter((p) => TERMINAL.includes(p.current_stage));
    // Over-escalated signature: at courtesy_2 with ZERO active priors (would be courtesy_1),
    // and at least one terminal prior was the (wrong) reason it escalated.
    if (v.current_stage === 'courtesy_2' && active.length === 0 && terminal.length > 0) {
      overEscalated++;
      if (examples.length < 15) examples.push({ id: v.id.slice(0,8), comm: (v.community_id||'').slice(0,8), opened: String(v.opened_at).slice(0,10), terminal_priors: terminal.length });
    }
  }
  log(`\nLikely over-escalated (courtesy_2 that should be courtesy_1): ${overEscalated}`);
  examples.forEach((e) => log(`  vio ${e.id}  comm ${e.comm}  opened ${e.opened}  terminal_priors=${e.terminal_priors}`));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
