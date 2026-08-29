// ============================================================================
// lib/team/learned_guidance.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The encode-Ed loop, applied at draft time. Ed grades shadow drafts; his
// corrections are distilled into approved PRINCIPLES per persona (stored in
// persona_learned_guidance). This loads that approved block and hands it to the
// drafter, which appends it to the persona's system prompt — so every future
// draft already follows what Ed taught. Grading changes behavior, not just one
// email.
//
// Fail-soft: if the table isn't there yet (pre-migration 398) or the read
// errors, return '' so drafting is never blocked by a missing loop.
// ============================================================================

async function loadApprovedGuidance(supabase, persona) {
  if (!supabase || !persona) return '';
  try {
    const { data, error } = await supabase.from('persona_learned_guidance')
      .select('guidance, status').eq('persona', persona).eq('status', 'approved').limit(1);
    if (error || !data || !data.length) return '';
    return String(data[0].guidance || '').trim();
  } catch (_) {
    return '';
  }
}

// The block appended to a persona's system prompt. Framed as Ed's standing
// corrections so the model treats it as high-priority, voice-defining guidance.
function guidanceBlock(text) {
  const g = String(text || '').trim();
  if (!g) return '';
  return `LEARNED FROM ED'S REVIEW — these are corrections Ed has made to drafts in this lane. They override generic instincts. Follow them exactly, they are how Ed wants this handled:\n${g}`;
}

module.exports = { loadApprovedGuidance, guidanceBlock };
