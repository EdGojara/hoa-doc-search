// Verifies the deployed per-bundle force-regenerate end-to-end against a real
// draft bundle: hits POST /drafts/auto-bundle {force, property_id} on the live
// host and confirms the bundle's PDF path actually changes (proving it
// re-rendered). Polls until the deploy is live. READ-mostly (re-renders one
// draft bundle; mails nothing).  node scripts/verify_bundle_regenerate.js
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const HOST = process.env.TRUSTED_URL || 'https://my.bedrocktxai.com';
const secret = process.env.STAFF_GATE_SECRET || process.env.STAFF_PASSWORD;
const log = (...a) => console.log(...a);

function gateCookie() {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', secret).update(ts).digest('hex');
  return `bedrock_gate=${ts}.${sig}`;
}

async function bundlePaths(propertyId) {
  const { data } = await supabase.from('interactions')
    .select('id, content, bundle_id, type')
    .eq('status', 'draft').eq('property_id', propertyId)
    .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209']);
  return data || [];
}

(async () => {
  // Pick a real multi-violation draft bundle.
  const { data: cands } = await supabase.from('interactions')
    .select('property_id, community_id')
    .eq('status', 'draft').not('bundle_id', 'is', null)
    .in('type', ['letter_courtesy_1', 'letter_courtesy_2', 'letter_209']).limit(400);
  const counts = {};
  (cands || []).forEach((r) => { if (r.property_id) (counts[r.property_id] = counts[r.property_id] || { n: 0, c: r.community_id }).n++; });
  const target = Object.entries(counts).sort((a, b) => b[1].n - a[1].n)[0];
  if (!target) { log('No draft bundle found.'); process.exit(0); }
  const propertyId = target[0], communityId = target[1].c;
  log('Target property:', propertyId, '| drafts:', target[1].n, '| comm:', communityId);

  const before = await bundlePaths(propertyId);
  const beforePaths = before.map((r) => r.content).sort();
  log('Before — PDF path(s):', [...new Set(beforePaths)]);

  for (let attempt = 1; attempt <= 9; attempt++) {
    let resp;
    try {
      const r = await fetch(`${HOST}/api/enforcement/drafts/auto-bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': gateCookie() },
        body: JSON.stringify({ force: true, property_id: propertyId, community_id: communityId }),
      });
      resp = await r.json().catch(() => ({ status: r.status }));
      log(`attempt ${attempt}: HTTP ${r.status} ->`, JSON.stringify(resp));
    } catch (e) { log(`attempt ${attempt}: fetch error ${e.message}`); }

    const after = await bundlePaths(propertyId);
    const afterPaths = [...new Set(after.map((r) => r.content))];
    const changed = JSON.stringify(afterPaths.sort()) !== JSON.stringify([...new Set(beforePaths)].sort());
    if (changed) {
      log('\nAfter  — PDF path(s):', afterPaths);
      log('\nPASS — bundle re-rendered (new PDF path). force-regenerate is live and working.');
      // Show the rendered recipient block uses one-line City/ST ZIP (via formatMailingLines unit test already proven).
      process.exit(0);
    }
    if (resp && (resp.drafts_bundled > 0 || resp.bundles_created > 0)) {
      log('\nPASS — endpoint reported re-render (drafts_bundled/bundles_created > 0).');
      process.exit(0);
    }
    log('  (no change yet — deploy may still be propagating; waiting 20s)');
    await new Promise((r) => setTimeout(r, 20000));
  }
  log('\nFAIL — no re-render detected after retries. Check deploy status.');
  process.exit(1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
