// ============================================================================
// lib/media/studio.js  (Issue #10 Media Studio V1) — projects, Amanda's proposal,
// storyboard, dry-run routing preview, review states. NO generation.
// ----------------------------------------------------------------------------
// The canonical project stores WHAT we want (intent + production requirements),
// never WHO renders it. A shot has no vendor, model or job field, and its text may
// not name a renderer (validateShot refuses both). The renderer is chosen by the
// router at plan time; an optional pin lives only in project.advanced and is just
// a filter on the router (it can never bypass a hard rule such as the unverified
// face-reference rule). Provider / model / version is recorded only in take
// provenance (render_log), which V1 never writes: render() refuses.
//
// Review: brief -> proposed -> in_review -> approved | changes_requested.
// Approval is by proposal_sha256 (canonical hash of treatment + script +
// storyboard), so any edit after approval drops the project back to `proposed`.
// ============================================================================
const crypto = require('crypto');
const { canonicalJson, sha256, validateShotSpec, freezeShotSpec, SEGMENTS } = require('./shotspec');
const { plan, MODES } = require('./router');
const { CATALOG } = require('./providers');

// "What do you want to make?" — the four starting points (plain language, no renderer talk)
const KINDS = Object.freeze({
  training:     { label: 'Training video', blurb: 'Teach a skill or a procedure (a vendor seminar, staff onboarding).', default_seconds: 180 },
  announcement: { label: 'Announcement',   blurb: 'Tell a community something: a change, an event, a reminder.',        default_seconds: 60 },
  explainer:    { label: 'Explainer',      blurb: 'Make one idea simple: how something works and why it matters.',     default_seconds: 90 },
  brand:        { label: 'Brand spot',     blurb: 'A short, polished piece about who we are.',                         default_seconds: 30 },
});
// The production modes a project may choose (acceptance_test is an internal evidence mode, not a project mode)
const PROJECT_MODES = Object.freeze({
  draft:          'Draft: cheapest reviewable preview',
  standard_final: 'Standard final: 1080p delivery',
  hero_final:     'Hero final: best available quality',
});
const STATUSES = ['brief', 'proposed', 'in_review', 'changes_requested', 'approved'];
const QUALITIES = ['draft', 'standard', 'hero'];
const SHOT_KINDS = ['generate', 'talking_head', 'source_material'];

// Renderer vocabulary: names that may never appear in canonical project text.
// Built from the catalog (adapter ids, families) plus known vendors, so a new
// adapter is covered automatically.
const VENDOR_WORDS = (() => {
  const w = new Set(['sora', 'openai', 'heygen', 'elevenlabs', 'byteplus', 'fal', 'replicate', 'runware', 'runway', 'vertex', 'luma', 'pika', 'synthesia']);
  for (const a of CATALOG) {
    w.add(a.id.split('_')[0]); if (a.family) w.add(String(a.family).toLowerCase());
  }
  w.add('google'); w.add('gemini'); w.add('veo'); w.add('kling'); w.add('omni'); w.add('hailuo'); w.add('minimax'); w.add('seedance'); w.add('aleph');
  return [...w].filter((x) => x && x.length >= 3);
})();
const VENDOR_RE = new RegExp(`\\b(${VENDOR_WORDS.join('|')})\\b`, 'i');
const PROVIDER_FIELD = /(^|_)(provider|vendor|renderer|model|engine|job|request|avatar|voice)(_?id|_name)?$/i;

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const clean = (s, max = 2000) => (s == null ? null : String(s).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) || null);
const newId = () => crypto.randomBytes(6).toString('hex');

// ── validation: intent only ─────────────────────────────────────────────────
function vendorFindings(obj, path = 'shot') {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === 'string') { const m = v.match(VENDOR_RE); if (m) out.push(`${p}: names a renderer ("${m[1]}"); shots describe intent, the router picks the renderer`); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (PROVIDER_FIELD.test(k)) out.push(`${p}.${k}: renderer fields are not allowed on a shot`); walk(x, `${p}.${k}`); }
  };
  walk(obj, path);
  return out;
}

function validateShot(s) {
  const e = vendorFindings(s);
  if (!/^[a-z0-9_]{2,40}$/.test(String(s.shot_key || ''))) e.push('shot_key required (a-z0-9_)');
  if (!SEGMENTS.includes(s.segment_class)) e.push(`segment_class is one of ${SEGMENTS.join(' / ')}`);
  if (!SHOT_KINDS.includes(s.kind)) e.push(`kind is one of ${SHOT_KINDS.join(' / ')}`);
  if (!(Number(s.duration_seconds) > 0 && Number(s.duration_seconds) <= 600)) e.push('duration_seconds must be 1-600');
  if (!clean(s.intent)) e.push('intent required (what this shot must accomplish)');
  if (s.segment_class === 'instructional' && s.kind !== 'source_material') e.push('instructional shots use approved source material; they are never generated');
  if (s.requirements && s.requirements.min_quality && !QUALITIES.includes(s.requirements.min_quality)) e.push('requirements.min_quality is draft / standard / hero');
  return { ok: e.length === 0, errors: e };
}

function validateProposal(p) {
  const e = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['proposal required'] };
  e.push(...vendorFindings(p.treatment || {}, 'treatment'), ...vendorFindings(p.script || {}, 'script'));
  if (!clean(p.treatment && p.treatment.logline)) e.push('treatment.logline required');
  const scenes = (p.storyboard && p.storyboard.scenes) || [];
  if (!scenes.length) e.push('storyboard needs at least one scene');
  const keys = new Set();
  for (const sc of scenes) {
    if (!(sc.shots || []).length) e.push(`scene ${sc.scene_key}: no shots`);
    for (const s of sc.shots || []) {
      if (keys.has(s.shot_key)) e.push(`duplicate shot_key ${s.shot_key}`); keys.add(s.shot_key);
      for (const x of validateShot(s).errors) e.push(`${s.shot_key || '?'}: ${x}`);
    }
  }
  return { ok: e.length === 0, errors: e };
}

const proposalSha = (p) => (p ? sha256(canonicalJson({ treatment: p.treatment, script: p.script, storyboard: p.storyboard })) : null);
const allShots = (p) => ((p && p.storyboard && p.storyboard.scenes) || []).flatMap((sc) => (sc.shots || []).map((s) => ({ ...s, scene_key: sc.scene_key })));

// ── project ─────────────────────────────────────────────────────────────────
function createProject(input = {}, actor = null) {
  const kind = KINDS[input.kind] ? input.kind : null;
  if (!kind) throw err('BAD_INPUT', `kind is one of ${Object.keys(KINDS).join(' / ')}`);
  const title = clean(input.title, 140); const brief = clean(input.brief, 4000);
  if (!title) throw err('BAD_INPUT', 'title required');
  if (!brief) throw err('BAD_INPUT', 'brief required (what should the viewer know or do afterwards?)');
  const mode = PROJECT_MODES[input.production_mode] ? input.production_mode : 'draft';
  const target = Math.round(Number(input.target_seconds) || KINDS[kind].default_seconds);
  if (!(target >= 10 && target <= 1800)) throw err('BAD_INPUT', 'target length must be 10 seconds to 30 minutes');
  const project = { id: newId(), title, kind, brief, audience: clean(input.audience, 300), target_seconds: target, production_mode: mode,
    host: 'amanda_albright', status: 'brief', proposal: null, approved_sha256: null,
    advanced: { renderer_pins: {} }, history: [], created_at: new Date().toISOString(), updated_at: null };
  for (const x of vendorFindings({ title, brief, audience: project.audience }, 'project')) throw err('BAD_INPUT', x);
  log(project, 'created', actor);
  return project;
}

function log(project, event, actor, detail = null) {
  project.history.push({ at: new Date().toISOString(), event, actor: actor || null, ...(detail ? { detail } : {}) });
  project.updated_at = new Date().toISOString();
}

// ── Amanda's proposal (deterministic template; an AI draft goes through the same validator) ──
function shotT(key, o) {
  return { shot_key: key, title: o.title, segment_class: o.segment, kind: o.kind || 'generate', intent: o.intent, framing: o.framing || null, camera_move: o.move || null,
    action: o.action || null, location: o.location || null, cast: o.cast || [], dialogue: o.dialogue || null,
    audio: { dialogue: !!o.dialogue, ambient: o.ambient !== false, music: !!o.music }, duration_seconds: o.seconds,
    requirements: { identity: (o.cast || []).length > 0, min_quality: o.min_quality || null, first_last_frame: false },
    review: 'proposed', notes: null };
}

function templateProposal(project) {
  const T = project.target_seconds; const host = project.host; const subj = project.title;
  const aud = project.audience || 'the community';
  const scene = (scene_key, title, purpose, shots) => ({ scene_key, title, purpose, shots });
  let scenes;
  if (project.kind === 'training') {
    const instr = Math.max(30, T - 52);
    scenes = [
      scene('s1_open', 'Why this matters', 'Earn attention in the first seconds with the real-world stakes.', [
        shotT('s1_hook', { title: 'The stakes', segment: 'engagement', intent: `Show, without words, the real moment this training prepares people for (${subj}).`, framing: 'wide establishing', move: 'slow push-in', action: 'A calm, real setting where the skill will be needed; nothing staged or alarming.', seconds: 6, music: true }),
        shotT('s1_host', { title: 'Amanda welcomes the class', segment: 'brand', kind: 'talking_head', intent: 'Amanda introduces the session and what the viewer will be able to do by the end.', framing: 'medium close-up', cast: [host], dialogue: `Hi, I'm Amanda with Bedrock. Welcome to ${subj}. In the next few minutes we'll walk through it step by step.`, seconds: 10 }),
      ]),
      scene('s2_instruction', 'The procedure', 'The approved instructional content, presented exactly as provided. Never generated.', [
        shotT('s2_module', { title: 'Instructional module (approved source)', segment: 'instructional', kind: 'source_material', intent: 'Present the approved procedure from the source material (slides, certified footage or the instructor recording) word for word.', seconds: instr, ambient: false }),
      ]),
      scene('s3_recap', 'Recap', 'Lock in the three things to remember.', [
        shotT('s3_recap', { title: 'Three things to remember', segment: 'engagement', intent: 'A visual recap of the three key takeaways as on-screen text over a calm setting.', framing: 'medium', move: 'gentle lateral slide', seconds: 8, music: true }),
      ]),
      scene('s4_close', 'Close', 'Where to go next and who to ask.', [
        shotT('s4_host', { title: 'Amanda closes', segment: 'brand', kind: 'talking_head', intent: 'Amanda thanks the viewer and says where questions go.', framing: 'medium close-up', cast: [host], dialogue: 'Thanks for watching. If anything was unclear, reach out to our team and we will help.', seconds: 8 }),
        shotT('s4_card', { title: 'End card', segment: 'brand', intent: 'Bedrock end card with the next step.', framing: 'graphic', seconds: 4, ambient: false, music: true }),
      ]),
    ];
  } else if (project.kind === 'announcement') {
    scenes = [
      scene('s1_open', 'Open', 'Set the place: this is about your community.', [
        shotT('s1_establish', { title: 'Community establishing', segment: 'engagement', intent: 'Establish the neighborhood the announcement is for.', framing: 'wide', move: 'slow aerial-style drift', location: 'tree-lined community street, morning light', seconds: 5, music: true }),
      ]),
      scene('s2_message', 'The message', 'Amanda delivers the announcement plainly.', [
        shotT('s2_host', { title: 'Amanda delivers the news', segment: 'brand', kind: 'talking_head', intent: `Amanda explains the announcement (${subj}): what is changing, when, and what ${aud} needs to do.`, framing: 'medium close-up', cast: [host], dialogue: `Hi neighbors, Amanda with Bedrock. Here is what you need to know about ${subj}.`, seconds: Math.max(15, T - 20) }),
        shotT('s2_broll', { title: 'Supporting visual', segment: 'engagement', intent: 'A supporting visual of the thing being announced.', framing: 'medium', move: 'static', seconds: 6 }),
      ]),
      scene('s3_close', 'Close', 'What to do next.', [
        shotT('s3_card', { title: 'Next step card', segment: 'brand', intent: 'On-screen card with the date and the one action to take.', framing: 'graphic', seconds: 6, ambient: false, music: true }),
      ]),
    ];
  } else if (project.kind === 'explainer') {
    scenes = [
      scene('s1_hook', 'The question', 'Open on the question the viewer actually has.', [
        shotT('s1_hook', { title: 'The everyday question', segment: 'engagement', intent: `Open on a relatable moment that raises the question behind ${subj}.`, framing: 'medium', move: 'slow push-in', seconds: 6, music: true }),
      ]),
      scene('s2_explain', 'How it works', 'Amanda makes it simple, with a visual for each step.', [
        shotT('s2_host', { title: 'Amanda explains', segment: 'brand', kind: 'talking_head', intent: 'Amanda explains the idea in plain words, one step at a time.', framing: 'medium close-up', cast: [host], dialogue: `Hi, I'm Amanda with Bedrock. Let me make ${subj} simple.`, seconds: Math.max(20, Math.round((T - 18) / 2)) }),
        shotT('s2_steps', { title: 'Step visuals', segment: 'engagement', intent: 'Simple visuals that show each step as Amanda names it.', framing: 'medium', move: 'gentle lateral slide', seconds: Math.max(8, Math.round((T - 18) / 2)) }),
      ]),
      scene('s3_close', 'Close', 'Why it matters, and the next step.', [
        shotT('s3_card', { title: 'End card', segment: 'brand', intent: 'End card with where to learn more.', framing: 'graphic', seconds: 6, ambient: false, music: true }),
      ]),
    ];
  } else {
    scenes = [
      scene('s1_atmosphere', 'Atmosphere', 'Feel before facts.', [
        shotT('s1_mood', { title: 'Community at golden hour', segment: 'engagement', intent: 'A warm, unhurried community moment that sets the tone.', framing: 'wide', move: 'slow dolly', location: 'community green, golden hour', seconds: 6, music: true }),
      ]),
      scene('s2_presence', 'Amanda', 'Our people show up.', [
        shotT('s2_arrival', { title: 'Amanda arrives', segment: 'brand', intent: 'Amanda arrives at the clubhouse, relaxed and ready to help.', framing: 'medium-wide', move: 'gentle pan following her', cast: [host], action: 'Amanda walks to the clubhouse entrance and greets someone off-camera with a small wave.', seconds: 8, min_quality: 'hero' }),
        shotT('s2_close', { title: 'Amanda close-up', segment: 'brand', intent: 'A quiet, confident close-up: the face of the service.', framing: 'close-medium', move: 'slow push-in', cast: [host], seconds: 6, min_quality: 'hero' }),
      ]),
      scene('s3_tag', 'Tagline', 'Land the line.', [
        shotT('s3_card', { title: 'Tagline card', segment: 'brand', intent: 'Bedrock tagline over the brand mark.', framing: 'graphic', seconds: Math.max(4, T - 20), ambient: false, music: true }),
      ]),
    ];
  }
  const shots = scenes.flatMap((s) => s.shots);
  return {
    source: 'template', drafted_at: new Date().toISOString(),
    treatment: {
      logline: `${KINDS[project.kind].label} for ${aud}: ${subj}.`,
      objective: project.brief, audience: aud,
      tone: project.kind === 'training' ? 'Calm, clear, respectful of the viewer\'s time.' : project.kind === 'brand' ? 'Warm, confident, unhurried.' : 'Friendly, plain-spoken, specific.',
      structure: scenes.map((s) => `${s.title}: ${s.purpose}`),
      host_note: 'Amanda is the host. Any shot showing her face needs a renderer whose face-reference support we have verified ourselves.',
    },
    script: { beats: shots.map((s) => ({ shot_key: s.shot_key, segment_class: s.segment_class, line: s.dialogue || null, direction: s.intent })) },
    storyboard: { scenes },
  };
}

function setProposal(project, proposal, actor) {
  const v = validateProposal(proposal);
  if (!v.ok) throw err('INVALID_PROPOSAL', `proposal rejected: ${v.errors.slice(0, 6).join('; ')}`, { errors: v.errors });
  project.proposal = proposal; project.status = 'proposed'; project.approved_sha256 = null;
  log(project, 'proposal_set', actor, { source: proposal.source, proposal_sha256: proposalSha(proposal) });
  return project;
}

// ── edits (allowed fields only; any edit re-opens review) ───────────────────
const SHOT_FIELDS = ['title', 'intent', 'framing', 'camera_move', 'action', 'location', 'dialogue', 'duration_seconds', 'segment_class', 'kind', 'notes', 'cast', 'requirements'];
function touch(project, actor, event, detail) {
  if (project.status === 'approved' || project.status === 'in_review') { project.status = 'proposed'; project.approved_sha256 = null; detail = { ...(detail || {}), review_reopened: true }; }
  log(project, event, actor, detail);
}
function findShot(project, key) {
  for (const sc of (project.proposal && project.proposal.storyboard.scenes) || []) { const i = sc.shots.findIndex((s) => s.shot_key === key); if (i >= 0) return { scene: sc, i }; }
  throw err('NOT_FOUND', `no shot ${key}`);
}
function updateShot(project, key, patch, actor) {
  if (!project.proposal) throw err('BAD_STATE', 'no proposal yet');
  const { scene, i } = findShot(project, key);
  const next = { ...scene.shots[i] };
  for (const f of SHOT_FIELDS) if (patch[f] !== undefined) next[f] = f === 'duration_seconds' ? Number(patch[f]) : f === 'cast' ? (Array.isArray(patch.cast) ? patch.cast.map(String) : []) : f === 'requirements' ? { ...next.requirements, ...(patch.requirements || {}) } : clean(patch[f], 2000);
  next.audio = { ...next.audio, dialogue: !!next.dialogue };
  next.requirements = { ...next.requirements, identity: (next.cast || []).length > 0 };
  next.review = 'proposed';
  const v = validateShot(next);
  if (!v.ok) throw err('INVALID_SHOT', v.errors.join('; '), { errors: v.errors });
  scene.shots[i] = next;
  const beat = project.proposal.script.beats.find((b) => b.shot_key === key);
  if (beat) Object.assign(beat, { line: next.dialogue || null, direction: next.intent, segment_class: next.segment_class });
  touch(project, actor, 'shot_edited', { shot_key: key, fields: Object.keys(patch).filter((f) => SHOT_FIELDS.includes(f)) });
  return next;
}
function updateTreatment(project, patch, actor) {
  if (!project.proposal) throw err('BAD_STATE', 'no proposal yet');
  const t = { ...project.proposal.treatment };
  for (const f of ['logline', 'objective', 'audience', 'tone']) if (patch[f] !== undefined) t[f] = clean(patch[f], 2000);
  const f = vendorFindings(t, 'treatment'); if (f.length) throw err('INVALID_PROPOSAL', f.join('; '));
  if (!t.logline) throw err('INVALID_PROPOSAL', 'treatment.logline required');
  project.proposal.treatment = t; touch(project, actor, 'treatment_edited');
  return t;
}
function setShotReview(project, key, state, note, actor) {
  if (!['approved', 'needs_changes', 'proposed'].includes(state)) throw err('BAD_INPUT', 'shot review is approved / needs_changes / proposed');
  const { scene, i } = findShot(project, key);
  scene.shots[i] = { ...scene.shots[i], review: state, notes: note != null ? clean(note, 1000) : scene.shots[i].notes };
  if (state === 'needs_changes') touch(project, actor, 'shot_flagged', { shot_key: key }); else log(project, 'shot_review', actor, { shot_key: key, state });
  return scene.shots[i];
}

// ── project review (approval by hash) ───────────────────────────────────────
function review(project, action, { proposal_sha256 = null, note = null } = {}, actor = null) {
  const sha = proposalSha(project.proposal);
  const T = { submit: [['proposed', 'changes_requested'], 'in_review'], request_changes: [['in_review'], 'changes_requested'], approve: [['in_review'], 'approved'], reopen: [['approved', 'changes_requested'], 'proposed'] }[action];
  if (!T) throw err('BAD_INPUT', 'action is submit / request_changes / approve / reopen');
  if (!project.proposal) throw err('BAD_STATE', 'no proposal to review');
  if (!T[0].includes(project.status)) throw err('BAD_STATE', `cannot ${action} from ${project.status}`);
  if (action === 'approve') {
    if (proposal_sha256 !== sha) throw err('STALE', 'the proposal changed since you opened it; reload and review again', { current_sha256: sha });
    const flagged = allShots(project.proposal).filter((s) => s.review === 'needs_changes').map((s) => s.shot_key);
    if (flagged.length) throw err('BAD_STATE', `shots still flagged for changes: ${flagged.join(', ')}`);
    project.approved_sha256 = sha;
  } else if (action !== 'submit') project.approved_sha256 = null;
  project.status = T[1];
  log(project, `review_${action}`, actor, { proposal_sha256: sha, ...(note ? { note: clean(note, 1000) } : {}) });
  return project;
}

// ── advanced: renderer pin (a router filter, never canonical shot data) ──────
function setRendererPin(project, key, rendererId, actor) {
  findShot(project, key);
  if (rendererId == null || rendererId === '') delete project.advanced.renderer_pins[key];
  else { if (!CATALOG.some((a) => a.id === rendererId)) throw err('BAD_INPUT', 'unknown renderer'); project.advanced.renderer_pins[key] = String(rendererId); }
  log(project, 'renderer_pin', actor, { shot_key: key, pin: project.advanced.renderer_pins[key] || null });
  return project.advanced.renderer_pins;
}

// ── dry-run routing + cost preview ──────────────────────────────────────────
function shotMode(shot, projectMode) {
  if (shot.segment_class === 'instructional' || shot.kind === 'source_material') return 'instructional_non_generative';
  if (shot.kind === 'talking_head') return 'talking_head';
  const floor = shot.requirements && shot.requirements.min_quality;
  if (floor === 'hero' && projectMode !== 'draft') return 'hero_final';
  return projectMode;
}

function toShotSpec(shot, canon) {
  const cast = []; const references = [];
  for (const slug of shot.cast || []) {
    const c = canon[slug];
    if (!c || !c.ok) return { blocked: (c && c.reason) || `${slug}: cast not resolved` };
    cast.push({ character_slug: slug, components: c.pins });
    references.push({ sha256: c.face_sha256, use: 'identity' });
  }
  const spec = { shot_key: shot.shot_key, segment_class: shot.segment_class, duration_seconds: Number(shot.duration_seconds), aspect: '16:9',
    audio: { dialogue: shot.dialogue ? true : null, ambient: !!(shot.audio && shot.audio.ambient), music: !!(shot.audio && shot.audio.music) },
    camera: { framing: shot.framing || null, move: shot.camera_move || null }, action: shot.action || shot.intent, look: { location: shot.location || null },
    first_last_frame: !!(shot.requirements && shot.requirements.first_last_frame), cast, references };
  const v = validateShotSpec(spec);
  return v.ok ? { spec } : { blocked: v.errors.join('; ') };
}

const labelOf = (id) => (CATALOG.find((a) => a.id === id) || {}).label || id;

// opts: { canon: {slug: castCanon result}, adapters, accounts, health, policy, spend }
function previewPlan(project, opts = {}) {
  if (!project.proposal) throw err('BAD_STATE', 'no proposal yet');
  const adapters = opts.adapters || CATALOG; const canon = opts.canon || {};
  const shots = []; let total = 0; let planned = 0; const blocked = [];
  for (const s of allShots(project.proposal)) {
    const mode = shotMode(s, project.production_mode);
    const pin = project.advanced.renderer_pins[s.shot_key] || null;
    const warnings = [];
    for (const slug of s.cast || []) if (s.dialogue && canon[slug] && canon[slug].ok && !canon[slug].voice_approved) warnings.push(`${slug}'s voice is not approved yet; a speaking shot cannot be final until it is`);
    const row = { shot_key: s.shot_key, scene_key: s.scene_key, title: s.title, segment_class: s.segment_class, mode, pinned: pin, warnings };
    if (MODES[mode] && MODES[mode].non_generative) { shots.push({ ...row, status: 'non_generative', estimate_usd: 0, explanation: 'Uses the approved source material as provided. Never generated.' }); continue; }
    const built = toShotSpec(s, canon);
    if (built.blocked) { shots.push({ ...row, status: 'blocked', estimate_usd: null, explanation: built.blocked }); blocked.push(s.shot_key); continue; }
    const pool = pin ? adapters.filter((a) => a.id === pin) : adapters;
    const p = plan(freezeShotSpec(built.spec).spec, { mode, adapters: pool, accounts: opts.accounts || {}, health: opts.health || {}, policy: opts.policy || {}, spend: opts.spend || {} });
    const rejected = p.rejected.map((r) => ({ renderer: labelOf(r.adapter), reasons: r.reasons }));
    if (p.status !== 'planned') {
      const faceGate = p.rejected.some((r) => r.reasons.some((x) => /face-reference support unverified/.test(x)));
      shots.push({ ...row, status: 'no_eligible_renderer', estimate_usd: null, shotspec_sha256: p.shotspec_sha256, rejected,
        explanation: mode === 'talking_head' && (s.cast || []).length ? 'A talking-head shot needs a consented, verified avatar of this cast on a talking-head renderer. None is on file yet, so this shot is not plannable.' : faceGate ? 'No renderer has passed our own face-reference check for this cast yet. The acceptance test is what clears it.' : pin ? 'The pinned renderer cannot meet this shot\'s requirements; clear the pin to let the router choose.' : 'No renderer can meet this shot\'s requirements.' });
      blocked.push(s.shot_key); continue;
    }
    const c = p.primary.cost.accepted_take_cost; total += c; planned += 1;
    shots.push({ ...row, status: 'planned', estimate_usd: c, shotspec_sha256: p.shotspec_sha256,
      route: { renderer: labelOf(p.primary.adapter), resolution: p.primary.resolution, quality: p.primary.quality, face_reference: p.primary.face_reference ? p.primary.face_reference.state : null },
      fallbacks: p.fallbacks.map((f) => ({ renderer: labelOf(f.adapter), estimate_usd: f.cost.accepted_take_cost })), rejected });
  }
  return { project_id: project.id, production_mode: project.production_mode, proposal_sha256: proposalSha(project.proposal), generated_at: new Date().toISOString(),
    estimate_note: 'Estimate only. Renderers are chosen when a shot is planned or rendered, from published prices and our verified capabilities; nothing is generated here.',
    totals: { shots: shots.length, planned, non_generative: shots.filter((x) => x.status === 'non_generative').length, blocked: blocked.length, estimated_usd: Math.round(total * 100) / 100 },
    shots, live_generation: false };
}

function render() { throw err('RENDER_NOT_ENABLED', 'Live generation is disabled in this build.'); }

module.exports = { KINDS, PROJECT_MODES, STATUSES, SHOT_KINDS, VENDOR_WORDS, createProject, templateProposal, setProposal, validateShot, validateProposal,
  proposalSha, allShots, updateShot, updateTreatment, setShotReview, review, setRendererPin, previewPlan, shotMode, toShotSpec, render, vendorFindings };
