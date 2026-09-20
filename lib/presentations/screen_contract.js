// ============================================================================
// lib/presentations/screen_contract.js  (2026-09-20)
// ----------------------------------------------------------------------------
// The SINGLE canonical contract for a presentation screen. story.js is the one
// source of truth for presentation CONTENT; this module defines the shape that
// content must take, so BOTH renderers (browser: present.html, PowerPoint:
// pptx_render.js) consume the same semantic definition instead of maintaining
// separate decks. See project_presentation_dual_source_tech_debt.
//
//   presentation definition (story.js)
//        + presentation context/variables
//        -> resolveStory() -> resolved screens
//             |
//             +-- browser renderer  (present.html)
//             +-- PowerPoint renderer (pptx_render.js)
//
// This file provides three things:
//   1. TYPES        — the allowed screen types and their meaningful fields.
//   2. validateScreen — throws loudly on an unknown type or a missing required
//                       field, so a malformed deck fails at build time, never
//                       silently drops a slide (the whole class of bug we are
//                       closing).
//   3. contentSignature — a normalized capture of EVERY meaningful piece of
//                       content on a screen. The parity test asserts that each
//                       string in the signature actually appears in the rendered
//                       PowerPoint, so silent content loss (same title, same
//                       slide count, half the body missing) is caught.
//
// Rendering lives in the renderers. Content lives in the screen. This file is
// the contract between them.
// ============================================================================

// The nine screen types in use (proven by inventory of story.js, 2026-09-20).
// `required` lists fields that MUST be present and non-empty for the screen to
// be renderable; `content` lists every field the renderers may draw, used to
// build the content signature. team.members / video.video_url are filled by
// resolveStory (roster + claire_explainers), so they are not authored-required.
const TYPES = {
  cover:     { required: ['title'],       content: ['title', 'tagline', 'kicker', 'prepared_for'] },
  closing:   { required: ['title'],       content: ['title', 'kicker'] },
  statement: { required: ['headline'],    content: ['label', 'headline', 'body', 'columns', 'image', 'image_caption', 'cta', 'footnote'] },
  points:    { required: ['headline', 'points'], content: ['label', 'headline', 'body', 'points', 'footnote'] },
  columns:   { required: ['headline', 'columns'], content: ['label', 'headline', 'body', 'columns', 'footnote'] },
  compare:   { required: ['headline', 'left', 'right'], content: ['label', 'headline', 'body', 'left', 'right', 'footnote'] },
  roadmap:   { required: ['headline', 'milestones'], content: ['label', 'headline', 'milestones'] },
  team:      { required: ['headline'],    content: ['label', 'headline', 'body', 'members', 'video_segments'] },
  video:     { required: ['headline'],    content: ['label', 'headline', 'body', 'poster', 'video_topic', 'video_url'] },
};

function isNonEmpty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// Throw on anything that would silently drop or garble a slide. Called by
// resolveStory for every screen before it reaches a renderer.
function validateScreen(s, idx) {
  const where = `screen[${idx}]${s && s.id ? ` id=${s.id}` : ''}`;
  if (!s || typeof s !== 'object') throw new Error(`${where}: not an object`);
  if (!s.type || !TYPES[s.type]) throw new Error(`${where}: unknown screen type ${JSON.stringify(s && s.type)} (allowed: ${Object.keys(TYPES).join(', ')})`);
  for (const f of TYPES[s.type].required) {
    if (!isNonEmpty(s[f])) throw new Error(`${where}: type '${s.type}' requires non-empty '${f}'`);
  }
  return true;
}

// A normalized, comparable capture of every meaningful content string on a
// screen. Used by the parity test to prove the PowerPoint renderer consumed
// each field. Strings only (what a reader would see), flattened per type.
function contentSignature(s) {
  const sig = { type: s.type, strings: [] };
  const push = (v) => { if (typeof v === 'string' && v.trim()) sig.strings.push(v.trim()); };
  const fields = (TYPES[s.type] || { content: [] }).content;
  for (const f of fields) {
    const v = s[f];
    if (v == null) continue;
    switch (f) {
      case 'prepared_for':
        push(v.org); (v.attendees || []).forEach(push); push(v.date); break;
      case 'columns':
        (v || []).forEach((c) => { push(c.header); (c.items || []).forEach(push); }); break;
      case 'points':
        (v || []).forEach((p) => { push(p.n); push(p.head); push(p.body); }); break;
      case 'milestones':
        (v || []).forEach((m) => { push(m.when); push(m.head); push(m.body); }); break;
      case 'left': case 'right':
        push(v.label); push(v.head); push(v.sub); break;
      case 'cta':
        push(v.label); push(v.note); break;
      case 'members':
        (v || []).forEach((m) => { push(m.name); push(m.role); }); break;
      case 'video_segments':
        (v || []).forEach((seg) => { push(seg.name); push(seg.role); }); break;
      case 'image': case 'poster': case 'video_topic': case 'video_url':
        // Non-text media: recorded as presence markers, not reader strings.
        if (isNonEmpty(v)) (sig.media = sig.media || []).push(`${f}:${typeof v === 'string' ? v : 'yes'}`);
        break;
      case 'image_caption':
        // A caption is only shown WITH its image (both renderers gate it on
        // `image`), so it is meaningful content only when an image is present.
        if (isNonEmpty(s.image)) push(v);
        break;
      default:
        push(v);
    }
  }
  return sig;
}

// Replace {{key}} tokens in a string from a variables map. Unknown tokens are
// left intact (visible), never silently blanked, so a missing variable is
// obvious on screen rather than a mysterious gap.
function interpolate(str, vars) {
  if (typeof str !== 'string' || !vars) return str;
  return str.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

// Deep-interpolate every string field of a screen from vars. Returns a new
// screen; does not mutate the source definition.
function applyVars(screen, vars) {
  if (!vars || !Object.keys(vars).length) return screen;
  const walk = (v) => {
    if (typeof v === 'string') return interpolate(v, vars);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return walk(screen);
}

module.exports = { TYPES, validateScreen, contentSignature, interpolate, applyVars, isNonEmpty };
