#!/usr/bin/env node
// ============================================================================
// scripts/character_canon_decisions.js  (Ed 2026-11-26)  Trusted Character System
// ----------------------------------------------------------------------------
// Records the owner's ALREADY-MADE identity decisions in the Character Canon:
// approve the versions he approved, mark superseded ones legacy, promote the
// current release, and settle which HeyGen looks are production, approved
// variants, or legacy. It uses only the registry's own write functions
// (lib/characters/registry.js); nothing here is a second registry.
//
//   node scripts/character_canon_decisions.js --plan <file.json> [--apply]
//
// Default is a DRY RUN. Every change is append-only (events, retirements, new
// mappings), so the full history stays in the registry.
//
// HONEST PROVENANCE: the plan's "actor" names who recorded the decision and on
// what authority (for example "canon_reconcile: Ed Gojara chat instruction
// 2026-11-26, recorded by Claude Code"). It must never be an email address:
// a chat instruction is not an authenticated in-app approval, and the record
// has to say which it was. The script refuses an actor that looks like one.
//
// Plan files hold provider IDs, so they live OUTSIDE this public repo.
// Plan: { "actor", "decision_ref", "characters": [ {
//   "slug",
//   "approve":  [ { "component", "version_no", "reason"? } ],   proposed -> approved
//   "legacy":   [ { "component", "version_no", "reason" } ],     approved -> retired, proposed -> rejected
//   "release":  { "components": { "face": 4, ... }, "notes", "promote": true },
//   "retire_mappings": [ { "external_id", "channel"?, "reason" } ],          full IDs only
//   "add_mappings": [ { "provider", "kind", "external_id", "channel", "license_class",
//                        "notes", "sources": [ { "component", "version_no" } ], "verify_heygen_look"? } ]
// } ] }
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const registry = require('../lib/characters/registry');
const { openQuestions } = require('../lib/characters/approval');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const PLAN = arg('--plan');

async function heygenLook(id) {
  const r = await fetch(`https://api.heygen.com/v3/avatars/looks/${encodeURIComponent(id)}`,
    { headers: { 'x-api-key': process.env.HEYGEN_API_KEY, accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`HeyGen look ${id} -> ${r.status}`);
  return j.data || j;
}

function versionOf(d, component, n) {
  const v = d.versions.find((x) => x.component === component && x.version_no === n);
  if (!v) throw new Error(`no ${component}.v${n}`);
  return v;
}

async function planCharacter(c, actor, ref) {
  const ch = await registry.findCharacter(c.slug);
  if (!ch) throw new Error(`${c.slug}: not in the registry`);
  const d = await registry.getCharacterDetail(ch.character_id);
  const steps = [];
  const reason = (r) => [r, ref].filter(Boolean).join(' | ');

  for (const a of c.approve || []) {
    const v = versionOf(d, a.component, a.version_no);
    if (['approved', 'restored'].includes(v.status)) { steps.push({ skip: `${a.component}.v${a.version_no} already ${v.status}` }); continue; }
    if (v.status !== 'proposed') throw new Error(`${c.slug} ${a.component}.v${a.version_no} is ${v.status}; cannot approve`);
    const q = openQuestions(v.component, v.spec);
    if (q.length) throw new Error(`${c.slug} ${a.component}.v${a.version_no} has unresolved questions (${q.map((x) => x.reason).join('; ')}); it needs a new version, not an approval`);
    steps.push({ label: `approve ${a.component}.v${a.version_no}`, run: () => registry.setComponentStatus({ versionId: v.id, event: 'approved', actor, reason: reason(a.reason || 'Owner decision already made; recorded in the registry') }) });
  }
  for (const l of c.legacy || []) {
    const v = versionOf(d, l.component, l.version_no);
    if (['retired', 'rejected'].includes(v.status)) { steps.push({ skip: `${l.component}.v${l.version_no} already ${v.status}` }); continue; }
    const event = ['approved', 'restored'].includes(v.status) ? 'retired' : 'rejected';
    steps.push({ label: `legacy ${l.component}.v${l.version_no} (${v.status} -> ${event})`, run: () => registry.setComponentStatus({ versionId: v.id, event, actor, reason: reason(`LEGACY: ${l.reason}`) }) });
  }
  if (c.release) {
    const want = Object.fromEntries(Object.entries(c.release.components).map(([k, n]) => [k, versionOf(d, k, n).id]));
    const sig = (o) => JSON.stringify(Object.entries(o).sort());
    const existing = d.releases.find((r) => sig(r.components) === sig(want));
    if (existing && existing.is_current) steps.push({ skip: `release ${existing.release_no} already current` });
    else {
      steps.push({ label: `release ${Object.entries(c.release.components).map(([k, n]) => `${k}=v${n}`).join(' ')}${existing ? ` (reuse release ${existing.release_no})` : ' (new)'}${c.release.promote ? ' -> promote' : ''}`,
        run: async () => {
          let id = existing && existing.id;
          if (!id) id = await registry.createRelease({ characterId: ch.character_id, components: want, notes: reason(c.release.notes), actor, parentReleaseId: null });
          if (c.release.promote) await registry.promoteRelease({ releaseId: id, actor, reason: reason(c.release.notes) });
        } });
    }
  }
  for (const r of c.retire_mappings || []) {
    const hits = d.mappings.filter((m) => m.status === 'active' && m.external_id === r.external_id && (r.channel === undefined || (m.channel || null) === r.channel));
    if (!hits.length) { steps.push({ skip: `no active mapping ${r.external_id.slice(0, 8)}` }); continue; }
    for (const m of hits) steps.push({ label: `retire ${m.provider}:${m.kind} ${m.external_id.slice(0, 8)}${m.channel ? '/' + m.channel : ''}`, run: () => registry.retireProviderMapping({ mappingId: m.id, actor, reason: reason(`LEGACY: ${r.reason}`) }) });
  }
  for (const m of c.add_mappings || []) {
    if (!/^[0-9a-f]{32}$/.test(m.external_id) && m.provider === 'heygen') throw new Error(`${c.slug}: give the full HeyGen id, not ${m.external_id}`);
    const dup = d.mappings.find((x) => x.status === 'active' && x.provider === m.provider && x.kind === m.kind && x.external_id === m.external_id && (x.channel || null) === (m.channel || null));
    if (dup) { steps.push({ skip: `mapping ${m.external_id.slice(0, 8)}/${m.channel} exists` }); continue; }
    if (m.verify_heygen_look) {
      const look = await heygenLook(m.external_id);
      if (look.id !== m.external_id) throw new Error(`${c.slug}: HeyGen returned ${look.id} for ${m.external_id}`);
    }
    const sources = (m.sources || []).map((s) => {
      const v = versionOf(d, s.component, s.version_no);
      const canon = (v.assets || []).find((a) => a.role === 'canonical');
      return { component_version_id: v.id, asset_sha256: s.with_asset === false ? null : (canon ? canon.sha256 : null), role: 'source' };
    });
    steps.push({ label: `add ${m.provider}:${m.kind} ${m.external_id.slice(0, 8)}/${m.channel}`, run: () => registry.createProviderMapping({ characterId: ch.character_id, provider: m.provider, kind: m.kind, externalId: m.external_id, licenseClass: m.license_class || 'owned', channel: m.channel, notes: m.notes, actor, sources }) });
  }
  return { c, steps };
}

(async () => {
  if (!PLAN) throw new Error('--plan <file.json> is required');
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  const actor = String(plan.actor || '').trim();
  if (!actor) throw new Error('plan.actor is required');
  if (/@/.test(actor)) throw new Error('plan.actor must describe the channel, not impersonate an account (no email addresses)');
  const plans = [];
  for (const c of plan.characters) plans.push(await planCharacter(c, actor, plan.decision_ref));
  for (const p of plans) {
    console.log(`\n=== ${p.c.slug} ===`);
    for (const s of p.steps) console.log(s.skip ? `  skip   ${s.skip}` : `  ${APPLY ? 'apply ' : 'would '} ${s.label}`);
  }
  if (!APPLY) { console.log('\nDRY RUN: nothing was written. Re-run with --apply.'); return; }
  for (const p of plans) for (const s of p.steps) if (s.run) { await s.run(); console.log(`  done   ${p.c.slug}: ${s.label}`); }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
