#!/usr/bin/env node
/**
 * cleanup_drama_creek_samples.js — Phase 2a repair + Sample cleanup.
 *
 * 1. Corrected, column-agnostic dependency sweep of the 80 legacy Sample
 *    properties (uses countRefs — a query error is never read as 0).
 * 2. Repoints the 13 portal_user_properties grants (missed by the first remap
 *    because the probe selected a non-existent `id` column) onto each persona's
 *    canonical DC property, using the approved Phase 2a mapping.
 * 3. Deletes exactly the 80 Sample properties — atomically, so any unexpected
 *    FK reference aborts the whole delete rather than partial-deleting.
 *
 * vendor_experiences (37) are intentionally left to SET NULL on delete — they
 * are community-level directory content, not persona history (proven from the
 * seed script's round-robin attribution).
 *
 *   node scripts/cleanup_drama_creek_samples.js --dry-run
 *   node scripts/cleanup_drama_creek_samples.js --execute
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { countRefs } = require('../lib/db/dependency_count');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DC = 'dc100000-0000-4000-a000-000000000000';
const DCID = /^DC-\d+-\d+$/;
const EXECUTE = process.argv.includes('--execute');

// Approved Phase 2a mapping: old Sample street -> canonical DC identity.
const MAP = {
  '301 Calm Waters Way': 'DC-40-007', '210 Peaceful Pond Drive': 'DC-40-024', '201 Harmony Lane': 'DC-40-041',
  '102 Serenity Court': 'DC-41-015', '109 Tranquility Trail': 'DC-41-058', '331 Calm Waters Way': 'DC-42-011',
  '202 Peaceful Pond Drive': 'DC-42-038', '231 Harmony Lane': 'DC-43-020', '205 Harmony Lane': 'DC-43-052',
  '131 Tranquility Trail': 'DC-44-014', '110 Serenity Court': 'DC-44-047', '101 Tranquility Trail': 'DC-45-009',
  '305 Calm Waters Way': 'DC-45-050',
};

// Full property-linked surface (from the migration trace). [table, column, class]
const SWEEP = [
  // RESTRICT / NO-ACTION (would BLOCK a delete)
  ['property_ownerships', 'property_id', 'R'], ['property_residencies', 'property_id', 'R'], ['violations', 'property_id', 'R'],
  ['property_observations', 'property_id', 'R'], ['fine_posting_queue', 'property_id', 'R'], ['owner_ar_snapshots', 'property_id', 'R'],
  ['interactions', 'property_id', 'R'], ['homeowner_threads', 'property_id', 'R'], ['property_enforcement_states', 'property_id', 'R'],
  ['property_enforcement_state_audit', 'property_id', 'R'], ['journal_entry_lines', 'property_id', 'R'], ['ar_charges', 'property_id', 'R'],
  ['ar_payments', 'property_id', 'R'], ['account_attachments', 'property_id', 'R'], ['assessment_autopay', 'property_id', 'R'],
  ['appraisal_records', 'property_id', 'R'],
  // SET NULL
  ['inspection_photos', 'polygon_match_property_id', 'N'], ['inspection_photos', 'reviewer_confirmed_property_id', 'N'],
  ['arc_historical_decisions', 'property_id', 'N'], ['knowledge_documents', 'property_id', 'N'], ['homeowner_notes', 'property_id', 'N'],
  ['community_map_access_log', 'property_id', 'N'], ['letter_mail_pieces', 'property_id', 'N'], ['homeowner_transactions', 'property_id', 'N'],
  ['portal_manager_view_log', 'viewed_property_id', 'N'], ['vendor_experiences', 'property_id', 'N'], ['email_messages', 'resolved_property_id', 'N'],
  ['pool_access', 'property_id', 'N'], ['payment_plans', 'property_id', 'N'], ['board_map_reports', 'property_id', 'N'],
  ['amenity_rentals', 'property_id', 'N'], ['claire_visits', 'property_id', 'N'],
  // CASCADE
  ['portal_user_properties', 'property_id', 'C'], ['ownership_change_proposals', 'property_id', 'C'], ['ar_account_collections', 'property_id', 'C'],
  ['homeowner_ledger_entries', 'property_id', 'C'], ['home_sales', 'property_id', 'C'], ['assessment_prorations', 'property_id', 'C'], ['welcome_packets', 'property_id', 'C'],
  // BARE UUID (no FK)
  ['sent_letter_archive', 'property_id', 'B'], ['evidence_archive', 'property_id', 'B'], ['email_attachments', 'resolved_property_id', 'B'],
  ['objectives', 'resident_property_id', 'B'], ['newsletter_submissions', 'property_id', 'B'],
];
// Known-and-accepted: delivery_receipts is unreadable to service_role (permission
// denied) AND has no data source (letter_mail_pieces community total = 0), so it
// cannot reference any Sample property. The atomic delete is the final guard.
const ACCEPTED_UNREADABLE = new Set(['delivery_receipts']);

async function main() {
  const { data: props, error } = await sb.from('properties').select('id, street_address').eq('community_id', DC).limit(2000);
  if (error) throw new Error('load properties: ' + error.message);
  const byAddr = new Map(props.map((p) => [p.street_address, p.id]));
  const sample = props.filter((p) => !DCID.test(p.street_address));
  const sampleIds = sample.map((p) => p.id);
  const addrOf = new Map(props.map((p) => [p.id, p.street_address]));
  console.log(`\nDrama Creek Sample cleanup  ·  ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}  ·  ${sampleIds.length} Sample properties\n`);

  // ---- 1) CORRECTED DEPENDENCY SWEEP ----
  console.log('CORRECTED DEPENDENCY SWEEP (column-agnostic; query error != 0):');
  const nonzero = { R: [], N: [], C: [], B: [] };
  const absent = [];
  let blocked = 0;
  for (const [t, c, cls] of SWEEP) {
    let n;
    try { n = await countRefs(sb, t, c, sampleIds); }
    catch (e) {
      // Adjudicate the anomaly — never silently treat it as zero.
      if (ACCEPTED_UNREADABLE.has(t)) { console.log(`  · ${t}.${c}: unreadable (accepted — no data source, atomic delete guards)`); continue; }
      const probe = await sb.from(t).select('*').limit(1);
      const msg = (probe.error && (probe.error.message || probe.error.code)) || '';
      if (probe.error && /does not exist|schema cache|find the table|PGRST205/i.test(msg)) {
        absent.push(`${t}.${c}`);  // table/relation genuinely absent -> no rows can reference via it
        continue;
      }
      throw new Error(`SWEEP HALTED — ${t}.${c} unresolved: ${e.message} / probe: ${msg || 'ok'}`);
    }
    if (n > 0) { nonzero[cls].push(`${t}.${c}=${n}`); if (cls === 'R') blocked += n; }
  }
  if (absent.length) console.log('  (absent tables/relations, 0 refs possible):', absent.join(', '));
  console.log('  RESTRICT/blockers:', nonzero.R.join(', ') || 'none');
  console.log('  SET NULL:        ', nonzero.N.join(', ') || 'none');
  console.log('  CASCADE:         ', nonzero.C.join(', ') || 'none');
  console.log('  BARE-UUID:       ', nonzero.B.join(', ') || 'none');
  if (blocked > 0) { console.error(`\nBLOCKED: ${blocked} RESTRICT-class rows still reference Sample properties. Fix before deletion.`); process.exit(1); }

  // ---- 2) PORTAL FIX ----
  const { data: pup, error: pErr } = await sb.from('portal_user_properties').select('portal_user_id, property_id').in('property_id', sampleIds);
  if (pErr) throw new Error('read portal_user_properties: ' + pErr.message);
  console.log(`\nPORTAL FIX: ${(pup || []).length} portal grants still on Sample properties`);
  const plan = (pup || []).map((r) => {
    const oldAddr = addrOf.get(r.property_id); const newAddr = MAP[oldAddr]; const tid = byAddr.get(newAddr);
    if (!newAddr || !tid) throw new Error(`no mapping for portal grant on ${oldAddr}`);
    return { pu: r.portal_user_id, sid: r.property_id, oldAddr, newAddr, tid };
  });
  plan.forEach((x) => console.log(`  pu ${x.pu.slice(0, 8)}  ${x.oldAddr} -> ${x.newAddr}`));

  if (!EXECUTE) {
    console.log(`\nDRY RUN — would repoint ${plan.length} portal grants and delete ${sampleIds.length} Sample properties. No writes.`);
    return;
  }

  // repoint each grant by its composite key (portal_user_id + old property_id)
  for (const x of plan) {
    const { error: uErr } = await sb.from('portal_user_properties').update({ property_id: x.tid }).eq('portal_user_id', x.pu).eq('property_id', x.sid);
    if (uErr) throw new Error(`repoint portal grant ${x.pu}: ${uErr.message}`);
  }
  const leftover = await countRefs(sb, 'portal_user_properties', 'property_id', sampleIds);
  if (leftover > 0) throw new Error(`portal fix incomplete: ${leftover} grants still on Sample properties`);
  console.log(`  ✓ ${plan.length} grants repointed; 0 remain on Sample properties`);

  // ---- 3) DELETE the 80 Sample properties (atomic) ----
  const { error: dErr } = await sb.from('properties').delete().in('id', sampleIds);
  if (dErr) throw new Error(`DELETE aborted (atomic — nothing deleted): ${dErr.message}`);
  const { count: remaining } = await sb.from('properties').select('*', { count: 'exact', head: true }).eq('community_id', DC);
  console.log(`\nDELETE: removed ${sampleIds.length} Sample properties. Drama Creek now has ${remaining} properties.`);
  console.log('EXECUTE complete. vendor_experiences left to SET NULL (community-level directory).');
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
