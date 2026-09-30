// ============================================================================
// lib/characters/approval.js  Trusted Character System: honest approval (PURE)
// ----------------------------------------------------------------------------
// "Approved" must mean canonical. A component version that still carries an
// unresolved question cannot be approved, and a package that contains one
// cannot be approved as a whole. Three ways a version can be unresolved:
//   declared  spec.open_questions: [{ field, question }]  (the explicit form;
//             new versions state what is still open here)
//   status    an explicit not-yet-canonical state (voice.status
//             'under_evaluation')
//   text      prose in the spec that says it is unresolved ("awaits ...
//             confirmation", "pending", "to be decided", "not yet canonical",
//             TBD / TODO / placeholder). Stored specs are immutable, so older
//             versions that wrote this as prose must still be caught; a
//             confirmed version is a NEW version without the open prose.
//
// A non-speaking visual workflow needs only the visual components. Approving
// those (per component) while voice stays under evaluation is allowed; a
// release cannot become current until every component in it is approved, so
// visual approval does not promote a release. Derived production assets pin
// the approved component versions they came from.
//
// Nothing here may name a specific character (tests/test_character_registry.js).
// ============================================================================

const VISUAL_COMPONENTS = ['face', 'body', 'wardrobe', 'guardrails'];

const UNRESOLVED_TEXT = [
  /\bawait(?:s|ing)?\b[^.]{0,80}\bconfirm/i,
  /\bpending\b/i,
  /\bto be (?:decided|confirmed|determined)\b/i,
  /\bnot yet canonical\b/i,
  /\bunconfirmed\b/i,
  /\b(?:TBD|TODO)\b/,
  /\bplaceholder\b/i,
];

function excerpt(text, re) {
  const m = re.exec(text);
  if (!m) return text.slice(0, 120);
  const start = text.lastIndexOf('.', m.index) + 1;
  const endDot = text.indexOf('.', m.index + m[0].length);
  return text.slice(start, endDot < 0 ? undefined : endDot + 1).trim().slice(0, 200);
}

// Every unresolved question on one component version's spec.
function openQuestions(component, spec) {
  const out = [];
  if (!spec || typeof spec !== 'object') return [{ field: '(spec)', reason: 'no spec recorded', kind: 'status' }];
  (Array.isArray(spec.open_questions) ? spec.open_questions : []).forEach((q) => {
    if (q && q.question) out.push({ field: String(q.field || '(general)'), reason: String(q.question), kind: 'declared' });
  });
  if (component === 'voice' && spec.status !== 'canonical') {
    out.push({ field: 'status', reason: `voice is ${String(spec.status || 'not set').replace(/_/g, ' ')}, not canonical`, kind: 'status' });
  }
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const re = UNRESOLVED_TEXT.find((r) => r.test(v));
      if (re) out.push({ field: path, reason: `the spec says this is unresolved: "${excerpt(v, re)}"`, kind: 'text' });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
  };
  Object.entries(spec).forEach(([k, v]) => { if (k !== 'open_questions' && !(component === 'voice' && k === 'status')) walk(v, k); });
  return out;
}

const APPROVED = ['approved', 'restored'];

// One version: can it be approved (or is it already)?
function versionReview(version) {
  const questions = openQuestions(version.component, version.spec);
  const status = version.status || 'proposed';
  return {
    version_id: version.id, component: version.component, version_no: version.version_no, status,
    open_questions: questions,
    approved: APPROVED.includes(status),
    approvable: status === 'proposed' && questions.length === 0,
    blocked_reason: status === 'rejected' ? 'rejected' : status === 'retired' ? 'retired' : questions.length && status === 'proposed' ? 'unresolved' : null,
  };
}

// The review of one release: per component, what would become canonical and
// what still needs a decision. detail = registry.getCharacterDetail() shape.
function reviewRelease(detail, releaseId) {
  const release = (detail.releases || []).find((r) => r.id === releaseId);
  if (!release) return null;
  const byId = new Map((detail.versions || []).map((v) => [v.id, v]));
  const assetBy = new Map((detail.assets || []).map((a) => [a.sha256, a]));
  const components = Object.entries(release.components || {}).map(([component, vid]) => {
    const v = byId.get(vid);
    if (!v) return { component, version_id: vid, status: 'missing', open_questions: [{ field: '(version)', reason: 'the version is missing', kind: 'status' }], approved: false, approvable: false };
    const r = versionReview(v);
    return Object.assign(r, {
      spec: v.spec, spec_sha256: v.spec_sha256,
      assets: (v.assets || []).map((a) => {
        const x = assetBy.get(a.sha256) || {};
        return { sha256: a.sha256, role: a.role, media_type: x.media_type || null, width: x.width || null, height: x.height || null, origin: x.origin || null };
      }),
    });
  });
  const ok = (c) => c.approved || c.approvable;
  const blocking = components.filter((c) => !ok(c)).map((c) => ({ component: c.component, version_no: c.version_no, status: c.status, reasons: c.open_questions.map((q) => q.reason).concat(c.blocked_reason && c.blocked_reason !== 'unresolved' ? [c.blocked_reason] : []) }));
  const visual = components.filter((c) => VISUAL_COMPONENTS.includes(c.component));
  const visualMissing = VISUAL_COMPONENTS.filter((k) => !visual.some((c) => c.component === k));
  return {
    release_id: release.id, release_no: release.release_no, status: release.status, is_current: !!release.is_current,
    components,
    package_approvable: blocking.length === 0,
    blocking,
    visual: {
      components: VISUAL_COMPONENTS,
      missing: visualMissing,
      ready: visualMissing.length === 0 && visual.every((c) => c.approved),
      approvable: visualMissing.length === 0 && visual.every(ok),
      blocking: blocking.filter((b) => VISUAL_COMPONENTS.includes(b.component)),
    },
  };
}

// Would approve-package approve anything unresolved? It approves every still-
// proposed version in the current AND the legacy releases, so check them all.
function packageBlockers(detail, currentReleaseId, legacyReleaseIds) {
  const ids = [...(legacyReleaseIds || []), currentReleaseId];
  const seen = new Set(); const out = [];
  for (const rid of ids) {
    const rev = reviewRelease(detail, rid);
    if (!rev) { out.push({ release_id: rid, reasons: ['release not found for this character'] }); continue; }
    for (const c of rev.components) {
      if (seen.has(c.version_id)) continue;
      seen.add(c.version_id);
      if (c.status === 'proposed' && c.open_questions.length) out.push({ release_no: rev.release_no, component: c.component, version_no: c.version_no, reasons: c.open_questions.map((q) => q.reason) });
      if (c.status === 'missing') out.push({ release_no: rev.release_no, component: c.component, reasons: ['the version is missing'] });
    }
  }
  return out;
}

module.exports = { VISUAL_COMPONENTS, UNRESOLVED_TEXT, openQuestions, versionReview, reviewRelease, packageBlockers };
