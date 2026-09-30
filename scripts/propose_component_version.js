#!/usr/bin/env node
// ============================================================================
// scripts/propose_component_version.js  (Issue #10: character canon)
// ----------------------------------------------------------------------------
// Propose ONE new component version for a character from a JSON file, e.g. a
// confirmed face version that resolves an earlier version's open questions
// using the same canonical image. The new version is only PROPOSED; approving
// it is the owner's decision on /admin/characters. The parent version is never
// changed (the registry is append-only).
//
//   node scripts/propose_component_version.js <proposal.json>          dry run
//   node scripts/propose_component_version.js <proposal.json> --apply  write
//
// Proposal file: { character_slug, component, parent_version_no,
//   change_reason, spec, assets: [{ sha256, role, notes }] }
// Checks before any write: the spec validates; it has no open questions; the
// parent exists for the same character and component; every asset is
// already in the content-addressed store; nothing identical exists already.
// Nothing here names a specific character.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { validateSpec } = require('../lib/characters/spec');
const { openQuestions } = require('../lib/characters/approval');
const { specSha256 } = require('../lib/characters/hash');

const ACTOR = 'canon_proposal_script';

function diff(before, after) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  return keys.filter((k) => JSON.stringify((before || {})[k]) !== JSON.stringify((after || {})[k]))
    .map((k) => ({ field: k, before: (before || {})[k], after: (after || {})[k] }));
}

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) { console.error('usage: propose_component_version.js <proposal.json> [--apply]'); process.exit(2); }
  const p = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const v = validateSpec(p.component, p.spec);
  if (!v.ok) throw new Error('spec does not validate: ' + v.errors.join('; '));
  const open = openQuestions(p.component, p.spec);
  if (open.length) throw new Error('the proposal still has open questions: ' + open.map((q) => q.field + ': ' + q.reason).join('; '));
  if (!p.change_reason || !String(p.change_reason).trim()) throw new Error('change_reason is required');

  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(what + ': ' + error.message); return data; };
  const ch = await must(sb.from('characters').select('character_id, character_slug, display_name').eq('character_slug', p.character_slug).maybeSingle(), 'character');
  if (!ch) throw new Error('unknown character ' + p.character_slug);
  const versions = await must(sb.from('component_versions').select('id, version_no, spec, spec_sha256').eq('character_id', ch.character_id).eq('component', p.component).order('version_no'), 'versions');
  const parent = versions.find((x) => x.version_no === p.parent_version_no);
  if (!parent) throw new Error(`parent ${p.component} v${p.parent_version_no} not found`);
  const sha = specSha256(p.spec);
  const same = versions.find((x) => x.spec_sha256 === sha);
  if (same) throw new Error(`an identical ${p.component} spec already exists as v${same.version_no}; nothing to propose`);
  const shas = (p.assets || []).map((a) => a.sha256);
  const stored = shas.length ? await must(sb.from('character_assets').select('sha256, media_type, width, height').in('sha256', shas), 'assets') : [];
  const missing = shas.filter((s) => !stored.some((x) => x.sha256 === s));
  if (missing.length) throw new Error('assets not in the content-addressed store: ' + missing.join(', '));
  const parentAssets = await must(sb.from('component_assets').select('sha256, role').eq('component_version_id', parent.id), 'parent assets');

  const nextNo = Math.max(...versions.map((x) => x.version_no)) + 1;
  console.log(`${ch.display_name}: propose ${p.component} v${nextNo} (parent v${parent.version_no}, spec ${sha.slice(0, 12)})`);
  console.log('changes from the parent:');
  for (const d of diff(parent.spec, p.spec)) console.log(`  ${d.field}:\n    before: ${JSON.stringify(d.before)}\n    after:  ${JSON.stringify(d.after)}`);
  console.log('assets:', (p.assets || []).map((a) => `${a.role}:${a.sha256.slice(0, 12)}${parentAssets.some((x) => x.sha256 === a.sha256 && x.role === a.role) ? ' (same as parent)' : ''}`).join(', '));
  console.log('open questions: none');
  if (!apply) { console.log('\nDRY RUN: nothing written. Re-run with --apply to record this as a PROPOSED version.'); return; }

  const { data: id, error } = await sb.rpc('character_create_component_version', {
    p_character: ch.character_id, p_component: p.component, p_spec: p.spec, p_schema_version: 1,
    p_parent_version: parent.id, p_change_reason: String(p.change_reason).slice(0, 1000), p_actor: ACTOR,
    p_assets: (p.assets || []).map((a) => ({ sha256: a.sha256, role: a.role, notes: a.notes || null })),
  });
  if (error) throw new Error('registry refused the proposal: ' + error.message);
  const row = await must(sb.from('component_versions').select('id, version_no, spec_sha256').eq('id', id).single(), 'new version');
  if (row.spec_sha256 !== sha) throw new Error('stored spec hash differs from the local one; investigate before approving');
  console.log(`\nRecorded ${p.component} v${row.version_no} (${row.id}) as PROPOSED. Approve it on /admin/characters.`);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
