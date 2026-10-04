// ============================================================================
// lib/media/proposal_ai.js  (Issue #10 Media Studio V1) — Amanda drafts the words
// ----------------------------------------------------------------------------
// Extract -> validate -> render. The deterministic template fixes the STRUCTURE
// (scenes, shot keys, segment classes, shot kinds, durations); the model only
// rewrites the creative text (logline, objective, tone, shot titles, intents,
// actions, dialogue). Instructional shots are never rewritten: instructional
// content comes from approved source material, never from a model. The result
// passes validateProposal (which refuses renderer names) or we fall back to the
// template and say why. Returns { proposal, raw_extracted, fallback_reason }.
// ============================================================================
const { route: aiRoute } = require('../ai/router');
const { templateProposal, validateProposal, allShots } = require('./studio');

const TEXT = ['title', 'intent', 'action', 'dialogue'];

async function draftProposal(project, anthropic) {
  const base = templateProposal(project);
  const editable = allShots(base).filter((s) => s.segment_class !== 'instructional');
  const sys = `You are Amanda, Bedrock's production lead, writing a short video proposal. Write in plain, warm, specific English. No em-dashes.
Never name a video model, AI vendor or rendering tool; describe only what the viewer sees and hears.
Never write instructional or safety-procedure content: those segments come from approved source material.
Dialogue is for Amanda and must identify her as Amanda with Bedrock when she first speaks. Keep each line short enough to say in the shot's seconds.
Return ONLY JSON.`;
  const user = `Project: ${project.title}
Kind: ${project.kind}
Audience: ${project.audience || 'the community'}
Brief: ${project.brief}
Target length: ${project.target_seconds} seconds

Rewrite the text for these shots (keep every shot_key; do not add or remove shots):
${JSON.stringify(editable.map((s) => ({ shot_key: s.shot_key, seconds: s.duration_seconds, speaks: !!s.dialogue, title: s.title, intent: s.intent, action: s.action, dialogue: s.dialogue })), null, 1)}

Return JSON: { "logline": "...", "objective": "...", "tone": "...", "shots": [ { "shot_key": "...", "title": "...", "intent": "...", "action": "...", "dialogue": "... or null" } ] }`;
  let raw = null;
  try {
    const resp = await anthropic.messages.create({ model: aiRoute('media.proposal'), max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user }] });
    raw = (resp.content || []).map((c) => c.text || '').join('');
    console.log('[media_studio] proposal draft returned:', raw.slice(0, 300));
    const a = raw.indexOf('{'); const z = raw.lastIndexOf('}');
    if (a < 0 || z <= a) return { proposal: base, raw_extracted: raw, fallback_reason: 'draft was not JSON; showing the template proposal' };
    const j = JSON.parse(raw.slice(a, z + 1));
    const p = JSON.parse(JSON.stringify(base));
    for (const f of ['logline', 'objective', 'tone']) if (typeof j[f] === 'string' && j[f].trim()) p.treatment[f] = j[f].trim().slice(0, 2000);
    const byKey = new Map((Array.isArray(j.shots) ? j.shots : []).map((s) => [s.shot_key, s]));
    for (const sc of p.storyboard.scenes) for (const s of sc.shots) {
      const d = byKey.get(s.shot_key); if (!d || s.segment_class === 'instructional') continue;
      for (const f of TEXT) if (f === 'dialogue' ? s.dialogue != null : true) { const v = d[f]; if (typeof v === 'string' && v.trim()) s[f] = v.trim().slice(0, 2000); }
    }
    p.script.beats = allShots(p).map((s) => ({ shot_key: s.shot_key, segment_class: s.segment_class, line: s.dialogue || null, direction: s.intent }));
    p.source = 'amanda_draft';
    const v = validateProposal(p);
    if (!v.ok) { console.warn('[media_studio] AI proposal failed validation:', v.errors.join('; ')); return { proposal: base, raw_extracted: raw, fallback_reason: `draft failed validation (${v.errors[0]}); showing the template proposal` }; }
    return { proposal: p, raw_extracted: raw, fallback_reason: null };
  } catch (e) {
    console.warn('[media_studio] AI proposal draft failed:', e.message);
    return { proposal: base, raw_extracted: raw, fallback_reason: 'drafting was unavailable; showing the template proposal' };
  }
}

module.exports = { draftProposal };
