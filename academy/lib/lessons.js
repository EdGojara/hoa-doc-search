// academy/lib/lessons.js
// ----------------------------------------------------------------------------
// agent_lessons model + lifecycle (sandbox; the DB table is a proposal).
//
//   draft -> reviewed -> approved -> active      (and any state -> retired)
//   an active lesson that is edited becomes a NEW version (draft); the old
//   version stays active until the new one is activated, then is superseded.
//
// Hard rules (enforced here, tested in tests/test_academy.js):
//   * A lesson NEVER changes Amanda's behavior because an evaluator produced it.
//     Evaluator/model-sourced lessons start as draft and need a HUMAN reviewer
//     and a HUMAN approver.
//   * approved requires approved_by (a human) and approved_at.
//   * active requires approval AND at least one linked regression case, so the
//     lesson is permanently tested.
//   * No skipping states.
//   * Only status === 'active' lessons are ever compiled into guidance.
// ----------------------------------------------------------------------------
const STATUSES = ['draft', 'reviewed', 'approved', 'active', 'superseded', 'retired'];
const NEXT = { draft: ['reviewed', 'retired'], reviewed: ['approved', 'draft', 'retired'], approved: ['active', 'retired'], active: ['superseded', 'retired'], superseded: [], retired: [] };
const SOURCES = ['human_correction', 'incident', 'evaluator', 'case_review'];
const MACHINE_ACTORS = /^(evaluator|judge|model|system|auto|claude|gpt|amanda)\b/i;
const isHuman = (who) => !!who && !MACHINE_ACTORS.test(String(who).trim());

function validateLesson(l) {
  const e = [];
  const req = (c, m) => { if (!c) e.push(m); };
  req(/^LSN-[A-Z]+-\d{3}$/.test(l.lesson_id || ''), 'lesson_id like LSN-XXX-000');
  req(Number.isInteger(l.version) && l.version >= 1, 'version >= 1');
  req(l.agent === 'amanda', 'agent amanda');
  req(['expertise', 'judgment', 'relationship', 'execution'].includes(l.domain), 'domain must be one dimension');
  for (const f of ['trigger', 'principle', 'bad_pattern', 'preferred_pattern']) req(typeof l[f] === 'string' && l[f].length > 10, `${f} required`);
  req(Array.isArray(l.examples) && l.examples.length, 'examples required');
  req(SOURCES.includes(l.source), `source one of ${SOURCES}`);
  req(STATUSES.includes(l.status), `status one of ${STATUSES}`);
  req(['low', 'medium', 'high'].includes(l.confidence), 'confidence low|medium|high');
  if (['approved', 'active', 'superseded'].includes(l.status)) {
    req(isHuman(l.approved_by), 'approved lessons need a human approved_by');
    req(!!l.approved_at, 'approved lessons need approved_at');
    req(isHuman(l.reviewed_by), 'approved lessons need a human reviewed_by');
  }
  if (l.status === 'active') req(Array.isArray(l.regression_case_ids) && l.regression_case_ids.length, 'active lessons need at least one regression case');
  if (l.source === 'evaluator' && l.status !== 'draft') req(isHuman(l.reviewed_by), 'evaluator lessons need human review before leaving draft');
  return e;
}

// Apply a transition; returns a NEW lesson object (with history) or throws.
function transition(lesson, to, { by, at = new Date().toISOString(), note = '', regression_case_ids } = {}) {
  if (!NEXT[lesson.status] || !NEXT[lesson.status].includes(to)) throw new Error(`illegal transition ${lesson.status} -> ${to}`);
  if (to !== 'retired' && to !== 'draft' && !isHuman(by)) throw new Error(`transition to ${to} requires a human actor (got "${by}")`);
  const next = { ...lesson, status: to, history: [...(lesson.history || []), { from: lesson.status, to, by, at, note }] };
  if (to === 'reviewed') { next.reviewed_by = by; next.reviewed_at = at; }
  if (to === 'approved') { next.approved_by = by; next.approved_at = at; }
  if (regression_case_ids) next.regression_case_ids = regression_case_ids;
  const errs = validateLesson(next);
  if (errs.length) throw new Error(`transition to ${to} blocked: ${errs.join('; ')}`);
  return next;
}

// Editing an active lesson creates a new draft version; the old stays active.
function newVersion(lesson, changes, { by }) {
  return { ...lesson, ...changes, version: lesson.version + 1, status: 'draft', reviewed_by: null, reviewed_at: null, approved_by: null, approved_at: null, supersedes_version: lesson.version, history: [{ from: null, to: 'draft', by, at: new Date().toISOString(), note: `new version of v${lesson.version}` }] };
}

// The ONLY path from lessons to behavior: active lessons, latest version per id.
function compileActive(lessons, agent = 'amanda') {
  const byId = {};
  for (const l of lessons.filter((x) => x.agent === agent && x.status === 'active' && validateLesson(x).length === 0)) {
    if (!byId[l.lesson_id] || byId[l.lesson_id].version < l.version) byId[l.lesson_id] = l;
  }
  return Object.values(byId).map((l) => `- ${l.principle} (instead of: ${l.bad_pattern}; do: ${l.preferred_pattern})`).join('\n');
}

module.exports = { STATUSES, NEXT, SOURCES, isHuman, validateLesson, transition, newVersion, compileActive };
