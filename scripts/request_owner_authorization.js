#!/usr/bin/env node
// ============================================================================
// Request the owner's authorization for an exact set of pending conversion items
// (migration 554). Builds the list from the database (proposed, current
// fingerprint) for the ids given, records the REQUEST and emails it to the owner
// from Tessa's mailbox. It authorizes nothing: only the owner's own reply does,
// and Tessa's inbox reader then verifies it and the AI team executes it.
//
//   node scripts/request_owner_authorization.js --package           # dry run: the 17 reviewed items
//   node scripts/request_owner_authorization.js --package --send    # record the request + email it
// ============================================================================
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const REC = require('../lib/onboarding/approval_recommendations');
const OA = require('../lib/onboarding/owner_authorization');
const graphSend = require('../lib/email/graph_send');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; };

(async () => {
  const send = process.argv.includes('--send');
  if (!process.argv.includes('--package')) throw new Error('say --package (the reviewed items in lib/onboarding/approval_recommendations.js)');
  const items = [];
  for (const [code, p] of Object.entries(REC.PACKAGE)) {
    const [batch] = await must(sb.from('conversion_batches').select('id, batch_code').eq('batch_code', code), 'batch');
    if (!batch) throw new Error(`no batch ${code}`);
    const adj = await must(sb.from('conversion_adjustments').select('id, status, fingerprint, kind, lines').eq('batch_id', batch.id).order('id'), 'adjustments');
    const pol = await must(sb.from('conversion_policies').select('id, status, fingerprint, policy_kind').eq('batch_id', batch.id).order('id'), 'policies');
    for (const [pre, reason] of Object.entries(p.objects)) {
      const hits = [...adj.map((a) => ({ ...a, object_type: 'adjustment' })), ...pol.map((x) => ({ ...x, object_type: 'policy', kind: x.policy_kind }))].filter((o) => o.id.startsWith(pre));
      if (hits.length !== 1) throw new Error(`${code} ${pre}: ${hits.length} matches`);
      const o = hits[0];
      if (o.status !== 'proposed') throw new Error(`${code} ${o.id} is ${o.status}, not proposed`);
      items.push({ object_type: o.object_type, object_id: o.id, fingerprint: o.fingerprint, batch_id: batch.id, batch_code: code, kind: o.kind,
        amount_cents: Array.isArray(o.lines) ? o.lines.reduce((t, l) => t + Math.max(0, Number(l.amount_cents) || 0), 0) : null, treatment: reason });
    }
  }
  console.log(`${items.length} items:`); for (const i of items) console.log(`  ${i.batch_code} ${i.object_type} ${i.object_id} ${i.fingerprint.slice(0, 12)}… ${i.treatment}`);
  if (!send) { console.log('\nDry run: nothing recorded or sent. Re-run with --send.'); return; }
  const rpc = async (name, args) => { const { data, error } = await sb.rpc(name, args); if (error) throw new Error(`${name}: ${error.message}`); return data; };
  const r = await OA.requestAuthorization({ rpc, send: graphSend.sendAs, items, ownerEmail: graphSend.ED_MAILBOX, fromMailbox: graphSend.TESSA_MAILBOX,
    summary: `${items.length} reviewed conversion approvals (Still Creek and Waterview 7/31/2026), as listed in the owner approval package` });
  console.log(`\nRequest ${r.id} recorded and emailed: "${r.subject}" (items sha ${r.items_sha256.slice(0, 12)}…). Nothing is authorized until the owner replies "approved".`);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
