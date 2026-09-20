// ============================================================================
// lib/presentations/resolve.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The ONE place a presentation definition becomes a fully-resolved deck, shared
// by the browser (`GET /api/presentations/story`) and the PowerPoint export
// (`POST /api/presentations/generate`). Extracted verbatim from the old inline
// /story handler so the two outputs can never resolve differently.
//
// resolveStory(audience, { language, variables, supabase }) ->
//   { audience, language, screens: [ ...resolved ] }
//
// Resolution steps, in order:
//   1. getStory(audience)          — the audience's ordered screen definitions.
//   2. applyVars(screen, variables)— interpolate {{tokens}} identically for both
//                                    renderers (Ed 2026-09-20 decision A).
//   3. validateScreen(screen)      — throw loudly on an unknown type / missing
//                                    required field, never silently drop a slide.
//   4. resolve video topics        — claire_explainers -> permanent video_url,
//                                    preferring the requested language, EN fallback.
//   5. resolve the team screen     — roster members + the video-segment sequence.
// ============================================================================
const story = require('./story');
const contract = require('./screen_contract');

let rosterMod = null;
try { rosterMod = require('../team/roster'); } catch (_) { /* optional */ }

// A per_audience video (the personalized welcome) resolves ONLY to this
// audience's own clip under topic 'welcome:<audience>', never a bare fallback.
function topicFor(s, audience) { return s.per_audience ? `${s.video_topic}:${audience}` : s.video_topic; }

async function resolveStory(audience, opts = {}) {
  const aud = String(audience || 'general');
  const language = String(opts.language) === 'es' ? 'es' : 'en';
  const variables = opts.variables || {};
  const supabase = opts.supabase;

  // 1 + 2 + 3: definitions -> variable-applied -> validated.
  const screens = story.getStory(aud).map((s, i) => {
    const withVars = contract.applyVars(s, variables);
    contract.validateScreen(withVars, i);
    return withVars;
  });

  // 4: resolve every referenced video topic once.
  const topics = [...new Set([
    ...screens.filter((s) => s.video_topic).map((s) => topicFor(s, aud)),
    ...screens.flatMap((s) => (s.video_segments || []).map((seg) => seg.topic)),
  ])];
  const urls = {};
  if (topics.length && supabase) {
    const { data, error } = await supabase.from('claire_explainers')
      .select('topic, language, title, video_url, duration_seconds')
      .in('topic', topics)
      .eq('status', 'ready')
      .is('community_id', null)
      .not('video_url', 'is', null);
    if (error) throw error;
    for (const row of data || []) {
      const cur = urls[row.topic];
      if (!cur || (cur.language !== language && row.language === language)) urls[row.topic] = row;
    }
  }

  // 5: the team screen draws members from the roster (single source of truth).
  let teamMembers = null;
  if (screens.some((s) => s.type === 'team') && rosterMod && rosterMod.people) {
    try {
      teamMembers = rosterMod.people()
        .filter((m) => !m.not_a_person)
        .map((m) => ({
          persona: m.persona,
          name: m.name,
          role: m.demo_title || m.signature_title || m.title || '',
          img: `/assets/presentations/team/${m.persona}.jpg`,
        }));
    } catch (_) { /* leave null; renderers handle empty */ }
  }

  const resolved = screens.map((s) => {
    if (s.type === 'team') {
      const segments = (s.video_segments || []).map((seg) => {
        const v = urls[seg.topic] || null;
        const m = rosterMod && rosterMod.get ? rosterMod.get(seg.persona) : null;
        return {
          topic: seg.topic,
          persona: seg.persona,
          name: m ? m.name : seg.persona,
          role: m ? (m.signature_title || m.title || '') : '',
          video_url: v ? v.video_url : null,
          poster: `/assets/presentations/team/${seg.persona}.jpg`,
          ready: !!v,
        };
      }).filter((seg) => seg.ready);
      return { ...s, members: teamMembers || [], video_segments: segments };
    }
    if (!s.video_topic) return s;
    const v = urls[topicFor(s, aud)] || null;
    return {
      ...s,
      video_url: v ? v.video_url : null,
      video_title: v ? v.title : null,
      video_ready: !!v,
      video_duration_seconds: v ? v.duration_seconds : null,
    };
  });

  return { audience: aud, language, screens: resolved, audiences: story.AUDIENCES };
}

module.exports = { resolveStory, topicFor };
