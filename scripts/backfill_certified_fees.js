// Backfill certified-letter fees to Aug 1. PREVIEW by default; --commit to post.
// Preview is self-contained (doesn't need migration 394). Commit uses the sweep
// (requires migration 394 applied — the certified_violation charge type).
//   node scripts/backfill_certified_fees.js            # preview
//   node scripts/backfill_certified_fees.js --commit   # actually post
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const COMMIT = process.argv.includes('--commit');
const START = '2026-08-01';
const IDS = {
  'a0000000-0000-4000-8000-000000000001': 'Waterview Estates',
  'a0000000-0000-4000-8000-000000000003': 'Canyon Gate at Cinco Ranch',
  'a0000000-0000-4000-8000-000000000005': 'Quail Ridge',
  'a0000000-0000-4000-8000-000000000006': 'Still Creek Ranch',
};

(async () => {
  const ids = Object.keys(IDS);
  // fee per community
  const { data: comms, error: ce } = await s.from('communities').select('id, letter_fee_certified_209_cents').in('id', ids);
  if (ce) { console.error('communities:', ce.message); process.exit(1); }
  const feeOf = new Map((comms || []).map((c) => [c.id, c.letter_fee_certified_209_cents || 0]));

  // certified pieces mailed since Aug 1
  let pieces = []; let from = 0;
  for (;;) {
    const { data, error } = await s.from('letter_mail_pieces')
      .select('id, interaction_id, community_id, property_id, stage_at_send, mailed_at, created_at')
      .in('community_id', ids).in('stage_at_send', ['certified_209', 'fine_assessed'])
      .order('id', { ascending: true }).range(from, from + 999);
    if (error) { console.error('pieces:', error.message); process.exit(1); }
    pieces = pieces.concat(data || []);
    if (!data || data.length < 1000) break; from += 1000;
  }
  const inWindow = pieces.filter((p) => String(p.mailed_at || p.created_at || '').slice(0, 10) >= START && p.property_id);

  // owner lookups
  const propIds = [...new Set(inWindow.map((p) => p.property_id))];
  const ownerOf = new Map();
  for (let i = 0; i < propIds.length; i += 200) {
    const { data: os } = await s.from('v_current_property_owners').select('property_id, owner_name, street_address').in('property_id', propIds.slice(i, i + 200));
    (os || []).forEach((o) => ownerOf.set(o.property_id, o));
  }
  // already charged?
  const chargedRefs = new Set();
  const refs = inWindow.map((p) => 'interaction:' + (p.interaction_id || p.id));
  for (let i = 0; i < refs.length; i += 200) {
    const { data: ch } = await s.from('ar_charges').select('source_reference').eq('source_module', 'certified_letter_fee').in('source_reference', refs.slice(i, i + 200));
    (ch || []).forEach((c) => chargedRefs.add(c.source_reference));
  }

  console.log(`\nCertified-letter fee backfill — ${COMMIT ? 'COMMIT' : 'PREVIEW'} (mailed on/after ${START})\n${'='.repeat(78)}`);
  let total = 0, toPost = 0, already = 0, noFee = 0;
  for (const p of inWindow) {
    const ref = 'interaction:' + (p.interaction_id || p.id);
    const fee = feeOf.get(p.community_id) || 0;
    const o = ownerOf.get(p.property_id) || {};
    const mailed = String(p.mailed_at || p.created_at || '').slice(0, 10);
    let state;
    if (chargedRefs.has(ref)) { state = 'already charged'; already++; }
    else if (fee <= 0) { state = 'NO FEE SET'; noFee++; }
    else { state = COMMIT ? 'POSTING' : 'would post'; toPost++; total += fee; }
    console.log(`  ${IDS[p.community_id].slice(0, 20).padEnd(20)} | ${String(o.street_address || '?').slice(0, 26).padEnd(26)} | ${String(o.owner_name || '?').slice(0, 22).padEnd(22)} | ${mailed} | $${(fee / 100).toFixed(2)} | ${state}`);
  }
  console.log('-'.repeat(78));
  console.log(`  ${inWindow.length} certified letters | ${toPost} to post ($${(total / 100).toFixed(2)}) | ${already} already charged | ${noFee} no fee set`);

  if (COMMIT && toPost > 0) {
    console.log('\nPosting via sweep (Dr 1300 A/R / Cr 2300 Accrued Liability)…');
    const { sweepCertifiedViolationFees } = require('../lib/enforcement/certified_fee');
    const sum = await sweepCertifiedViolationFees(s, { dryRun: false });
    console.log('Result:', JSON.stringify({ posted: sum.posting, total: '$' + (sum.total_cents / 100).toFixed(2), already: sum.already, skipped: sum.skipped }, null, 0));
  } else if (!COMMIT) {
    console.log('\nPreview only — no charges posted. Re-run with --commit (after migration 394 is applied) to post.');
  }
})();
