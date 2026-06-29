// ============================================================================
// scripts/import_vantaca_excel.js
// ----------------------------------------------------------------------------
// Server-side equivalent of the UI import for a Vantaca grouped Excel/CSV
// export — used when the report is large enough that the one-shot HTTP apply
// times out. Same pipeline: parse → match property + category → staleness
// closure → insert (source=vantaca_import, full weight). Replaces the
// community's prior import first (clean re-import).
//
//   node scripts/import_vantaca_excel.js --community=waterview --file="C:/.../Violation.xls"
//   add --dry to preview counts without writing.
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { parseVantacaViolations } = require('../lib/enforcement/vantaca_violation_import');
const { markStaleCourtesyClosed } = require('../lib/enforcement/vantaca_reconcile');
const { defaultWeightForSource } = require('../lib/enforcement/source_weights');
const { aiMapCategories } = require('../lib/enforcement/ai_category_mapper');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const DRY = process.argv.includes('--dry');
const slug = arg('community');
const file = arg('file');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

(async () => {
  if (!slug || !file) { console.error('need --community=<slug> and --file=<path>'); process.exit(1); }
  const { data: comm } = await supabase.from('communities').select('id, name').eq('slug', slug).maybeSingle();
  if (!comm) { console.error('community not found:', slug); process.exit(1); }
  console.log('Community:', comm.name);

  // 1) Parse
  const parsed = parseVantacaViolations(fs.readFileSync(file), file.split(/[\\/]/).pop());
  if (parsed.errors && parsed.errors.length) console.log('parser notes:', parsed.errors.join(' '));
  console.log('parsed rows:', parsed.rows.length, '· detected:', parsed.mapping && parsed.mapping._source);

  // 2) Property + category lookups (paginated)
  const fetchAll = async (table, cols, eqCol, eqVal) => {
    const out = []; let from = 0;
    while (true) {
      let q = supabase.from(table).select(cols).range(from, from + 999);
      if (eqCol) q = q.eq(eqCol, eqVal);
      const { data, error } = await q;
      if (error) { console.error(`${table}:`, error.message); break; }
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    return out;
  };
  const props = await fetchAll('properties', 'id, street_address, vantaca_account_id', 'community_id', comm.id);
  const byAcct = new Map(), byStreet = new Map();
  props.forEach((p) => { if (p.vantaca_account_id) byAcct.set(String(p.vantaca_account_id), p); if (p.street_address) byStreet.set(p.street_address.toLowerCase().trim(), p); });
  const cats = await fetchAll('enforcement_categories', 'id, slug, label');
  const catByLabel = new Map(), catBySlug = new Map();
  cats.forEach((c) => { catByLabel.set(c.label.toLowerCase(), c); catBySlug.set(c.slug.toLowerCase(), c); });
  const resolveCategory = (raw) => {
    if (!raw) return null;
    const s = String(raw).toLowerCase().trim();
    if (catByLabel.has(s)) return catByLabel.get(s);
    for (const [label, c] of catByLabel) if (label.includes(s) || s.includes(label)) return c;
    for (const [sl, c] of catBySlug) if (sl.replace(/_/g, ' ').includes(s) || s.includes(sl.replace(/_/g, ' '))) return c;
    return null;
  };

  // 3) Match. Substring match first; rows that find a property but no category
  //    go to an AI label->slug pass (same mapper the UI import uses) before we
  //    give up on them — Vantaca labels are more specific than our canonical
  //    set, so a third can fall through substring match alone.
  let noProp = 0;
  const matched = [];
  const unmatchedCat = [];
  for (const r of parsed.rows) {
    let prop = r.vantaca_account_id ? byAcct.get(String(r.vantaca_account_id)) : null;
    if (!prop && r.street_address) prop = byStreet.get(r.street_address.toLowerCase().trim());
    if (!prop) { noProp++; continue; }
    const cat = resolveCategory(r.category_label);
    if (!cat) { unmatchedCat.push({ ...r, property_id: prop.id }); continue; }
    matched.push({ ...r, property_id: prop.id, category_id: cat.id });
  }
  let aiResolved = 0;
  if (unmatchedCat.length) {
    const labels = unmatchedCat.map((r) => r.category_label);
    const aiMap = await aiMapCategories(labels, cats);
    for (const r of unmatchedCat) {
      const slug = r.category_label && aiMap[r.category_label];
      const cat = slug ? catBySlug.get(String(slug).toLowerCase()) : null;
      if (!cat) continue;
      matched.push({ ...r, category_id: cat.id });
      aiResolved++;
    }
  }
  const noCat = unmatchedCat.length - aiResolved;
  console.log(`matched: ${matched.length} (substring + ${aiResolved} AI-mapped) · no property: ${noProp} · no category: ${noCat}`);

  // 4) Staleness closure
  const { rows: finalRows, stale_closed, cutoff } = markStaleCourtesyClosed(matched);
  console.log(`staleness: closed ${stale_closed} stale courtesy (cutoff ${cutoff})`);

  // 5) Build insert payloads (reconcile vs empty after replace = all insert)
  const TERMINAL = ['cured', 'voided'];
  const payloads = finalRows.filter((r) => r.stage).map((r) => {
    const terminal = TERMINAL.includes(r.stage);
    return {
      property_id: r.property_id, community_id: comm.id, primary_category_id: r.category_id,
      board_priority_at_open: 'standard',
      current_stage: r.stage, current_stage_started_at: r.opened_at, opened_at: r.opened_at,
      resolved_at: terminal ? (r.resolved_at || r.opened_at) : (r.resolved_at || null),
      resolved_via: terminal ? (r.resolved_via || (r.stage === 'voided' ? 'voided' : 'cured')) : (r.resolved_via || null),
      resolved_notes: r.notes || null,
      source: 'vantaca_import', confidence_weight: defaultWeightForSource('vantaca_import'),
      quality_status: 'unreviewed', review_notes: 'Imported from Vantaca grouped report (script).',
    };
  });
  const skippedNullStage = finalRows.filter((r) => !r.stage).length;
  const openCount = payloads.filter((p) => !TERMINAL.includes(p.current_stage)).length;
  console.log(`to insert: ${payloads.length} (${openCount} open, ${payloads.length - openCount} terminal) · skipped null-stage: ${skippedNullStage}`);

  if (DRY) { console.log('DRY RUN — no writes.'); return; }

  // 6) Replace prior import, then insert
  const oldIds = (await fetchAll('violations', 'id', 'community_id', comm.id)).filter(() => true);
  // narrow to vantaca_import
  const { data: oldImp } = await supabase.from('violations').select('id').eq('community_id', comm.id).eq('source', 'vantaca_import').range(0, 9999);
  const delIds = (oldImp || []).map((r) => r.id);
  if (delIds.length) {
    for (const part of chunk(delIds, 200)) await supabase.from('violation_continuations').delete().in('violation_id', part);
    for (const part of chunk(delIds, 200)) await supabase.from('violations').delete().in('id', part);
    console.log('replaced (deleted) prior imported:', delIds.length);
  }

  let inserted = 0;
  for (const part of chunk(payloads, 100)) {
    const { data, error } = await supabase.from('violations').insert(part).select('id');
    if (error) {
      console.warn('batch failed, row-by-row:', error.message);
      for (const row of part) { const { error: e } = await supabase.from('violations').insert(row); if (!e) inserted++; else console.warn('  row err:', e.message); }
    } else inserted += (data && data.length) || part.length;
  }
  console.log(`\nINSERTED ${inserted} violations for ${comm.name}.`);
})();
