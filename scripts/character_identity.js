#!/usr/bin/env node
// ============================================================================
// scripts/character_identity.js  (Ed 2026-11-26)  Trusted Character System
// ----------------------------------------------------------------------------
// What may a NEW production use for this teammate? Prints the current approved
// identity from the Character Canon (lib/characters/production.js): face and
// release, the one production HeyGen look, approved variant looks, the
// canonical ElevenLabs voice, and the personality version. Read-only.
//
//   node scripts/character_identity.js <persona>     one teammate (exit 1 if not ready to render)
//   node scripts/character_identity.js --all         the whole team
//
// Run it before any hand-directed HeyGen production (MCP or Studio). Use only
// the looks it prints; if it says a piece is missing, stop and ask Ed.
// ============================================================================
require('dotenv').config({ quiet: true });
const production = require('../lib/characters/production');
const registry = require('../lib/characters/registry');

const arg = process.argv[2];
(async () => {
  if (!arg) { console.error('usage: node scripts/character_identity.js <persona> | --all'); process.exit(2); }
  const s = await production.load(registry);
  const list = arg === '--all' ? Object.keys(s.byPersona).sort() : [arg];
  let notReady = 0;
  for (const p of list) {
    const id = s.byPersona[p];
    if (!id) { console.log(`${p}: not in the Character Canon`); notReady++; continue; }
    const ready = id.face && id.primary_look && id.voice;
    if (!ready) notReady++;
    console.log(`\n${id.display_name} (${p})  ${ready ? 'READY' : 'NOT READY TO RENDER'}`);
    console.log(`  release        ${id.release_no || '-'}`);
    console.log(`  face           ${id.face ? 'v' + id.face.version_no : '-'}`);
    console.log(`  personality    ${id.persona_version ? 'v' + id.persona_version : 'not approved'}`);
    console.log(`  production look ${id.primary_look || '-'}`);
    if (id.variant_looks.length) console.log(`  variant looks  ${id.variant_looks.join(', ')}`);
    console.log(`  voice          ${id.voice ? `v${id.voice.version_no} ElevenLabs ${id.voice.elevenlabs_voice_id}` : 'not approved'}`);
    for (const pr of id.problems) console.log(`  needs: ${pr}`);
  }
  process.exit(arg !== '--all' && notReady ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
