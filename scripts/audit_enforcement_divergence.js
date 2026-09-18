// scripts/audit_enforcement_divergence.js
// ---------------------------------------------------------------------------
// Standing guard against the enforcement state-machine drifting out of sync.
// Enforcement is written by several paths (inspection confirm, inspection
// auto-open, Vantaca import, batch letter runs, alias/dedup reconciliation), and
// when they disagree the records diverge SILENTLY — the failure only shows up as
// a wrong number a human happens to notice (Ed 2026-09-17: Eaglewood had 493
// observations stuck 'pending' while their letters had already been mailed, and
// the confirm preview wanted to re-draft ~205 duplicates). This turns "notice it
// by eye months later" into a check anyone can run any time.
//
// Read-only. Reports, per community, the divergences that matter:
//   DUP_RISK      pending observation whose own case's first notice was ALREADY
//                 MAILED — confirming would duplicate. (The Eaglewood bug.)
//   OPEN_NO_LETTER open courtesy_1 violation whose first notice never went out.
//   STALE_PENDING  observation pending > STALE_DAYS (nobody reviewed it).
//   ORPHAN_DRAFT   a draft/awaiting letter on a voided/cured violation.
//
// Run:  node -r dotenv/config scripts/audit_enforcement_divergence.js
//       node -r dotenv/config scripts/audit_enforcement_divergence.js --community <id>
// Exit code 1 if any DUP_RISK exists anywhere (the dangerous one), else 0.
// ---------------------------------------------------------------------------
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const STALE_DAYS = 30;

const pageAll = async (t, sel, f, cid) => {
  let o = [], fr = 0;
  for (;;) {
    let q = supabase.from(t).select(sel).eq('community_id', cid).order('id', { ascending: true }).range(fr, fr + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(t + ': ' + error.message);
    o = o.concat(data);
    if (data.length < 1000) break;
    fr += 1000;
  }
  return o;
};

async function auditCommunity(c) {
  const pend = await pageAll('property_observations', 'id, created_at', (q) => q.eq('reviewer_status', 'pending'), c.id);
  const vios = await pageAll('violations', 'id, current_stage, resolved_at, opened_from_observation_id', null, c.id);
  const pendIds = new Set(pend.map((o) => o.id));

  // own-case violations for pending observations
  const own = vios.filter((v) => v.opened_from_observation_id && pendIds.has(v.opened_from_observation_id));
  const ownIds = own.map((v) => v.id);
  const mailed = new Set();
  for (let i = 0; i < ownIds.length; i += 200) {
    const { data: lts } = await supabase.from('interactions').select('violation_id, status, mailed_at').in('violation_id', ownIds.slice(i, i + 200)).eq('type', 'letter_courtesy_1');
    (lts || []).forEach((l) => { if (l.status === 'sent' || l.mailed_at) mailed.add(l.violation_id); });
  }
  const dupRisk = own.filter((v) => mailed.has(v.id) || (v.current_stage && !['courtesy_1', 'cured', 'voided', 'closed'].includes(v.current_stage))).length;
  const openNoLetter = own.filter((v) => v.current_stage === 'courtesy_1' && !mailed.has(v.id)).length;

  const cutoff = Date.now() - STALE_DAYS * 864e5;
  const stalePending = pend.filter((o) => o.created_at && new Date(o.created_at).getTime() < cutoff).length;

  // orphan drafts: a draft/awaiting letter on a terminal (voided/cured/closed) violation
  const terminalIds = vios.filter((v) => ['voided', 'cured', 'closed'].includes(v.current_stage) || v.resolved_at).map((v) => v.id);
  let orphanDrafts = 0;
  for (let i = 0; i < terminalIds.length; i += 200) {
    const { data: d } = await supabase.from('interactions').select('id, status').in('violation_id', terminalIds.slice(i, i + 200)).ilike('type', 'letter%').in('status', ['draft', 'awaiting_approval', 'approved', 'printed']);
    orphanDrafts += (d || []).length;
  }

  return { pending: pend.length, dupRisk, openNoLetter, stalePending, orphanDrafts };
}

(async () => {
  const onlyId = process.argv.includes('--community') ? process.argv[process.argv.indexOf('--community') + 1] : null;
  let comms;
  if (onlyId) { const { data } = await supabase.from('communities').select('id, name').eq('id', onlyId); comms = data; }
  else { const { data } = await supabase.from('communities').select('id, name').order('name'); comms = data; }

  console.log('ENFORCEMENT DIVERGENCE AUDIT  (' + new Date().toISOString().slice(0, 10) + ')');
  console.log('community                         | pending | DUP_RISK | open_no_letter | stale>' + STALE_DAYS + 'd | orphan_drafts');
  let totalDup = 0, flaggedCommunities = 0;
  for (const c of comms) {
    const r = await auditCommunity(c);
    if (!r.pending && !r.dupRisk && !r.openNoLetter && !r.orphanDrafts) continue;
    flaggedCommunities++;
    totalDup += r.dupRisk;
    const nm = (c.name || c.id).slice(0, 32).padEnd(32);
    console.log(`  ${nm} | ${String(r.pending).padStart(7)} | ${String(r.dupRisk).padStart(8)} | ${String(r.openNoLetter).padStart(14)} | ${String(r.stalePending).padStart(9)} | ${String(r.orphanDrafts).padStart(13)}`);
  }
  if (!flaggedCommunities) console.log('  (clean — no divergence in any community)');
  console.log('\ntotal DUP_RISK (would duplicate a mailed notice on confirm):', totalDup);
  if (totalDup > 0) { console.error('\nFAIL: duplicate-notice risk present. Reconcile before any bulk confirm.'); process.exit(1); }
})().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
