#!/usr/bin/env node
// ============================================================================
// scripts/media_phase0.js  (Issue #10 Media Studio, Phase 0) — provider acceptance harness
// ----------------------------------------------------------------------------
//   node scripts/media_phase0.js            freeze the 3 Amanda shots, quote the matrix (no spend)
//   node scripts/media_phase0.js --probe    + read-only provider probes (list/account endpoints only)
//   node scripts/media_phase0.js --run --confirm <matrix_sha256>
//                                           runs the bounded matrix ONLY when the confirm equals the
//                                           quoted matrix hash AND every cell's provider was reachable
//                                           (submit adapters are added per provider after a real probe)
// Reads the character registry through the read-only client. Never writes canon. Never prints
// credential values. Amanda is cast by her APPROVED visual canon (exact spec_sha256 pins); her
// voice is not approved, so every shot is non-speaking (ambient audio only).
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { readOnlyClient } = require('../lib/onboarding/write_gate');
const { visualCanon } = require('../lib/characters/approval');
const { freezeShotSpec, canonicalJson, sha256 } = require('../lib/media/shotspec');
const { ADAPTERS, DOC_DATE, probeAll, quote } = require('../lib/media/providers');

const TAKES_PER_CELL = 2;          // identity variance needs more than one take
const CONTINGENCY = 0.20;          // retries / minimums; the run stops at the cap
const CELLS = [ ['veo_3_1', '1080p'], ['omni_flash_1_1', '720p'], ['seedance_2_5', '1080p'], ['kling_3', '1080p'] ];
const TAKE_FIELDS = ['provider', 'model', 'model_version', 'request_id', 'shotspec_sha256', 'reference_sha256s', 'compiled_prompt', 'seed', 'quoted_cost', 'actual_cost',
  'latency_ms', 'output_sha256', 'resolution', 'duration_s', 'refusal_or_error', 'provenance_marker'];
const SCORES = ['identity_fidelity', 'age_face_body_drift', 'hands_body_integrity', 'wardrobe_prop_location_continuity', 'camera_obedience', 'motion_realism', 'cinematic_quality', 'audio_quality', 'latency', 'cost', 'refusal_reliability'];

async function amandaCanon(ro) {
  const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
  const ch = (await q(ro.from('characters').select('character_id, character_slug').eq('character_slug', 'amanda_albright')))[0];
  if (!ch) throw new Error('amanda_albright not in the registry');
  const versions = await q(ro.from('component_versions').select('id, component, version_no, spec_sha256, parent_version_id').eq('character_id', ch.character_id).order('version_no'));
  const events = await q(ro.from('character_events').select('subject_id, event').eq('character_id', ch.character_id).order('id'));
  const assets = await q(ro.from('component_assets').select('component_version_id, sha256, role').in('component_version_id', versions.map((v) => v.id)));
  const status = new Map(); for (const e of events) status.set(e.subject_id, e.event);
  const withStatus = versions.map((v) => ({ ...v, status: { approved: 'approved', rejected: 'rejected', retired: 'retired' }[status.get(v.id)] || 'proposed' }));
  const pins = {};
  for (const comp of ['face', 'body', 'wardrobe', 'guardrails']) {
    const ok = withStatus.filter((v) => v.component === comp && v.status === 'approved').sort((a, b) => b.version_no - a.version_no)[0];
    if (!ok) throw new Error(`Amanda ${comp}: no approved version (visual canon incomplete)`);
    pins[comp] = { version: ok.version_no, spec_sha256: ok.spec_sha256 };
  }
  const faceV = withStatus.find((v) => v.component === 'face' && v.version_no === pins.face.version);
  const canonical = assets.find((a) => a.component_version_id === faceV.id && a.role === 'canonical');
  if (!canonical) throw new Error('Amanda approved face has no canonical image');
  const ref993 = (await q(ro.from('character_reference_assets').select('sha256, label, category').eq('character_id', ch.character_id).eq('category', 'concept_scene'))).find((r) => /993/.test(r.label));
  const voiceApproved = withStatus.some((v) => v.component === 'voice' && v.status === 'approved');
  return { pins, face_sha256: canonical.sha256, ref993, voiceApproved, visual_canon: typeof visualCanon === 'function' ? 'approved' : 'approved' };
}

function shots(c) {
  const cast = [{ character_slug: 'amanda_albright', role: 'lead', components: c.pins, speaking: false }];
  const face = { sha256: c.face_sha256, use: 'identity', source: 'approved face canonical image' };
  const common = { segment_class: 'brand', duration_seconds: 8, aspect: '16:9', audio: { dialogue: null, ambient: true, music: null }, cast };
  return [
    { ...common, shot_key: 'p0_office_close_medium', title: 'Office: controlled close-medium',
      look: { wardrobe_context: 'business_casual', location: 'warm, sunlit Bedrock office; desk with a printed board packet' },
      camera: { operator: 'seated across the desk at eye level', lens_mm: 50, framing: 'close-medium (chest up)', move: 'slow push-in', support: 'tripod slider' },
      action: 'Amanda turns two pages of the board packet, pauses, then looks up toward camera with a small, warm smile. Hands clearly visible on the pages.',
      tests: ['identity', 'face detail', 'hands', 'subtle movement'], references: [face] },
    { ...common, shot_key: 'p0_walking_lifestyle', title: 'Walking: lifestyle full body',
      look: { wardrobe_context: 'casual_life', location: 'tree-lined community sidewalk, golden hour' },
      camera: { operator: 'walking backward ahead of her at chest height', lens_mm: 35, framing: 'full body to medium-wide', move: 'gimbal tracking backward, steady', support: 'gimbal' },
      action: 'Amanda walks toward camera at an easy pace, glances at the homes on her left, then back ahead. Natural arm swing; full figure in frame for most of the shot.',
      tests: ['full-body consistency', 'camera movement', 'motion continuity'], references: [face] },
    { ...common, shot_key: 'p0_993_arrival', title: '993 arrival: prop + environment',
      look: { wardrobe_context: 'business_casual', location: 'community clubhouse entrance, mid-morning', prop: 'air-cooled Porsche 993 as shown in the reference' },
      camera: { operator: 'standing on the curb across the drive', lens_mm: 35, framing: 'medium-wide', move: 'static, then a gentle pan following her', support: 'tripod' },
      action: 'The 993 rolls to a stop at the clubhouse; Amanda steps out, closes the door, and walks toward the entrance.',
      tests: ['reference load (identity + prop)', 'prop continuity', 'environment'],
      references: [face, ...(c.ref993 ? [{ sha256: c.ref993.sha256, use: 'prop_environment', source: `concept scene: ${c.ref993.label} (never identity)` }] : [])] },
  ];
}

(async () => {
  const argv = process.argv.slice(2);
  const ro = readOnlyClient(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY));
  const canon = await amandaCanon(ro);
  const frozen = shots(canon).map(freezeShotSpec);
  const cells = [];
  for (const f of frozen) for (const [adapter, resolution] of CELLS) {
    const qt = quote(adapter, { resolution, duration_seconds: f.spec.duration_seconds });
    cells.push({ shot_key: f.spec.shot_key, shotspec_sha256: f.shotspec_sha256, adapter, model: ADAPTERS[adapter].model, resolution, takes: TAKES_PER_CELL, unit_cost: qt.cost, cost: Math.round(qt.cost * TAKES_PER_CELL * 100) / 100, price_basis: qt.basis, source: qt.source });
  }
  const subtotal = Math.round(cells.reduce((t, c) => t + c.cost, 0) * 100) / 100;
  const cap = Math.round(subtotal * (1 + CONTINGENCY) * 100) / 100;
  const matrix = { phase: 'media_phase0', as_of: DOC_DATE, shots: frozen.map((f) => ({ shot_key: f.spec.shot_key, shotspec_sha256: f.shotspec_sha256 })), cells: cells.map(({ shot_key, adapter, model, resolution, takes, unit_cost }) => ({ shot_key, adapter, model, resolution, takes, unit_cost })), subtotal, cap };
  const matrix_sha256 = sha256(canonicalJson(matrix));
  const probe = argv.includes('--probe') ? await probeAll(process.env, fetch) : null;
  const out = { amanda: { pins: canon.pins, face_sha256: canon.face_sha256, ref993_sha256: canon.ref993 ? canon.ref993.sha256 : null, voice_approved: canon.voiceApproved }, shots: frozen, cells, subtotal, cap, matrix_sha256, take_fields: TAKE_FIELDS, scores: SCORES, probe };
  if (argv.includes('--json')) fs.writeFileSync(argv[argv.indexOf('--json') + 1], JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ amanda: out.amanda, shots: frozen.map((f) => [f.spec.shot_key, f.shotspec_sha256]), cells: cells.map((c) => [c.shot_key, c.adapter, c.resolution, c.takes, c.cost]), subtotal, cap, matrix_sha256, probe }, null, 1));
  if (argv.includes('--run')) {
    const confirm = argv[argv.indexOf('--confirm') + 1];
    if (confirm !== matrix_sha256) { console.error(`REFUSED: --confirm must equal the quoted matrix hash ${matrix_sha256} (the owner's single Confirm)`); process.exit(2); }
    const pr = probe || await probeAll(process.env, fetch);
    const blocked = [...new Set(cells.map((c) => c.adapter))].filter((a) => !(pr[a] && pr[a].reachable === true));
    if (blocked.length) { console.error(`REFUSED: providers not reachable with our credentials: ${blocked.join(', ')}. No spend.`); process.exit(3); }
    console.error('REFUSED: submit adapters are added per provider after a successful real probe; none are enabled yet. No spend.'); process.exit(4);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
