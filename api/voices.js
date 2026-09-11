// ============================================================================
// api/voices.js  (Ed 2026-09-11)  — OWNER-ONLY
// ----------------------------------------------------------------------------
// The AI-team VOICE picker. Ed switched the live avatar to Tessa in a client
// meeting and only then heard she was British ("Elenora - Professional"). Her
// voice was set through the TESSA_VOICE_ID env var, so changing it meant a
// Render edit + redeploy with no way to audition first. A wrong accent reached
// a client because voice choice lived in infrastructure, not in the product.
//
// This router lets Ed hear the candidate voices and set each teammate's voice
// by ear. A choice is saved to persona_voices (keyed by face) and pushed into
// the roster's in-memory override map immediately, so the very next avatar
// session or rendered video uses it. No redeploy.
//
//   GET  /api/voices/catalog        the auditionable HeyGen voices (cached)
//   GET  /api/voices/current        each teammate's current voice + source
//   POST /api/voices/:persona       set a teammate's voice { voice_id, voice_name }
//   DELETE /api/voices/:persona     clear the override (fall back to env)
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const roster = require('../lib/team/roster');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

// --- override cache load -----------------------------------------------------
// Read every saved override into the roster's in-memory map. Called once at
// mount time and again after each save so a single process is always current.
async function loadVoiceOverrides() {
  try {
    const { data, error } = await supabase.from('persona_voices').select('face, voice_id, voice_name');
    if (error) { console.warn('[voices] override load failed:', error.message); return; }
    const map = {};
    for (const r of data || []) map[r.face] = { voice_id: r.voice_id, voice_name: r.voice_name };
    roster.setVoiceOverrides(map);
    console.log(`[voices] loaded ${Object.keys(map).length} voice override(s)`);
  } catch (e) { console.warn('[voices] override load threw:', e.message); }
}

// --- catalog (cached ~1h) ----------------------------------------------------
// Source is HeyGen's v2 /voices, which carries the interactive-avatar support
// flag AND a preview clip on every voice. (The v3 endpoint is paged/capped and
// lacks the flag, so it can't answer "can the LIVE avatar speak this?".) The
// auditionable catalog is the interactive-capable English + Spanish voices —
// a voice the live avatar can't speak is not a real choice. We also keep the
// full id->voice map so a teammate's CURRENT voice can show its name + preview
// even if that voice isn't in the interactive shortlist.
let _catalog = null;      // [{voice_id,name,language,gender,preview}] interactive EN/ES
let _v2ById = new Map();  // every v2 voice by id, for current-voice lookups
let _catalogAt = 0;
const CATALOG_TTL_MS = 60 * 60 * 1000;
async function fetchV2Voices() {
  const https = require('https');
  const key = process.env.HEYGEN_API_KEY;
  const j = await new Promise((res, rej) => {
    https.get('https://api.heygen.com/v2/voices', { headers: { 'X-Api-Key': key } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  return (j.data && j.data.voices) || [];
}
async function getCatalog() {
  if (_catalog && (Date.now() - _catalogAt) < CATALOG_TTL_MS) return _catalog;
  const v2 = await fetchV2Voices();
  _v2ById = new Map(v2.map((v) => [v.voice_id, {
    voice_id: v.voice_id, name: v.name, language: v.language, gender: v.gender, preview: v.preview_audio || null,
  }]));
  _catalog = v2
    .filter((v) => v.support_interactive_avatar && /english|spanish|^en$|^es$/i.test(String(v.language || '')))
    .map((v) => _v2ById.get(v.voice_id));
  _catalogAt = Date.now();
  return _catalog;
}
async function voiceById(id) {
  if (!id) return null;
  if (!_v2ById.size) await getCatalog().catch(() => {});
  return _v2ById.get(id) || null;
}

// --- routes ------------------------------------------------------------------
router.get('/catalog', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  try {
    res.json({ voices: await getCatalog() });
  } catch (e) {
    console.error('[voices] catalog failed:', e.message);
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

router.get('/current', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  try {
    await getCatalog().catch(() => []); // warm _v2ById for current-voice lookups
    // Only teammates with a configured face are relevant to voice.
    const list = roster.people()
      .filter((m) => m.face && roster.avatarIdFor(m.persona))
      .map((m) => {
        const info = roster.voiceInfoFor(m.persona) || {};
        const cat = info.voice_id ? _v2ById.get(info.voice_id) : null;
        return {
          persona: m.persona, name: m.name, title: m.title, face: m.face, emoji: m.emoji || null,
          voice_id: info.voice_id || null,
          voice_name: info.voice_name || (cat && cat.name) || null,
          preview: cat ? cat.preview : null,
          source: info.source,
        };
      });
    res.json({ personas: list });
  } catch (e) {
    console.error('[voices] current failed:', e.message);
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

router.post('/:persona', async (req, res) => {
  const owner = await requireOwner(req, res);
  if (!owner) return;
  try {
    const m = roster.get(req.params.persona);
    if (!m || !m.face) return res.status(404).json({ error: 'unknown_persona' });
    const voice_id = String((req.body && req.body.voice_id) || '').trim();
    if (!voice_id) return res.status(400).json({ error: 'voice_id_required' });
    const voice_name = (req.body && req.body.voice_name ? String(req.body.voice_name) : '').trim() || null;

    const { error } = await supabase.from('persona_voices').upsert({
      face: m.face, voice_id, voice_name, updated_by: owner.email,
    }, { onConflict: 'face' });
    if (error) throw error;

    await loadVoiceOverrides(); // refresh in-memory map so it takes effect now
    res.json({ ok: true, persona: m.persona, face: m.face, voice_id, voice_name });
  } catch (e) {
    console.error('[voices] set failed:', e.message);
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

router.delete('/:persona', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  try {
    const m = roster.get(req.params.persona);
    if (!m || !m.face) return res.status(404).json({ error: 'unknown_persona' });
    const { error } = await supabase.from('persona_voices').delete().eq('face', m.face);
    if (error) throw error;
    await loadVoiceOverrides();
    res.json({ ok: true, persona: m.persona, face: m.face, source: 'env' });
  } catch (e) {
    console.error('[voices] clear failed:', e.message);
    res.status(500).json({ error: safeErrorMessage(e) });
  }
});

module.exports = { router, loadVoiceOverrides };
