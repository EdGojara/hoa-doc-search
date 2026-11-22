#!/usr/bin/env node
// ============================================================================
// scripts/check_identity_drift.js  (Ed 2026-11-22)
// Read-only report: does production use each AI teammate's Character Canon
// identity? Headshots, photo folders, active HeyGen avatars, video and spoken
// voices, and (with --websites) the named portraits on both Bedrock websites.
// Exit code 1 when any error is found.
//   node scripts/check_identity_drift.js [--websites] [--json]
// ============================================================================
require('dotenv').config({ quiet: true });
const path = require('path');
const registry = require('../lib/characters/registry');
const { checkIdentityDrift } = require('../lib/characters/identity_drift');
const roster = require('../lib/team/roster');

(async () => {
  const args = process.argv.slice(2);
  const db = registry.db();
  const pv = await db.from('persona_voices').select('face, voice_id');
  if (pv.error) throw new Error(`persona_voices: ${pv.error.message}`);
  const pt = await db.from('persona_tts_voices').select('face, voice_id');
  if (pt.error) throw new Error(`persona_tts_voices: ${pt.error.message}`);
  let heygenVoiceIds = null;
  if (process.env.HEYGEN_API_KEY) {
    const r = await fetch('https://api.heygen.com/v2/voices', { headers: { 'x-api-key': process.env.HEYGEN_API_KEY } });
    const j = await r.json().catch(() => null);
    const list = (j && j.data && j.data.voices) || [];
    if (list.length) heygenVoiceIds = new Set(list.map((v) => v.voice_id));
  }
  const res = await checkIdentityDrift({
    registry, personaImages: require('../lib/team/persona_images.json'), repoRoot: path.join(__dirname, '..'),
    faceOf: (p) => { const m = roster.get(p); return m && m.face ? m.face : null; },
    voiceOverrides: Object.fromEntries((pv.data || []).map((x) => [x.face, x.voice_id])),
    ttsOverrides: Object.fromEntries((pt.data || []).map((x) => [x.face, x.voice_id])),
    heygenVoiceIds, checkWebsites: args.includes('--websites'),
  });
  if (args.includes('--json')) console.log(JSON.stringify(res, null, 1));
  else {
    for (const f of res.findings) console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.character.padEnd(16)} ${f.area.padEnd(8)} ${f.message}`);
    console.log(`\n${res.characters} characters checked; ${res.findings.filter((f) => f.severity === 'error').length} errors, ${res.findings.filter((f) => f.severity === 'warn').length} warnings.`);
  }
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(2); });
