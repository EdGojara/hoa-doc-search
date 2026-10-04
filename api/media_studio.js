// ============================================================================
// api/media_studio.js  (Issue #10 Media Studio V1) — owner-only
// ----------------------------------------------------------------------------
// Project creation, Amanda's proposal, storyboard edits, review states and the
// dry-run routing / cost preview. NO generation: /render refuses with
// RENDER_NOT_ENABLED. Cast canon is read through the read-only client only.
// LOCK: a router-level requireOwner runs FIRST, so no route can ship ungated.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { readOnlyClient } = require('../lib/onboarding/write_gate');
const studio = require('../lib/media/studio');
const store = require('../lib/media/studio_store');
const { castCanon } = require('../lib/media/canon');
const { draftProposal } = require('../lib/media/proposal_ai');
const { CATALOG } = require('../lib/media/providers');

// buildRouter({ auth, canon, anthropic }) lets the local UI harness inject stubs; production uses the defaults.
function buildRouter({ auth = require('./_require_admin'), canon = null, anthropic = null } = {}) {
const router = express.Router();
router.use(express.json({ limit: '64kb' }));
router.use(async (req, res, next) => {
  const owner = await auth.requireOwner(req, res); // sends 403 if not the owner
  if (!owner) return;
  req.owner = owner;
  next();
});

const actorOf = (req) => req.owner.email;
const STATUS = { BAD_INPUT: 400, INVALID_PROPOSAL: 400, INVALID_SHOT: 400, NOT_FOUND: 404, BAD_STATE: 409, STALE: 409, RENDER_NOT_ENABLED: 403 };
function fail(res, e, where) {
  const code = STATUS[e.code];
  if (code) return res.status(code).json({ error: e.message, code: e.code, ...(e.errors ? { errors: e.errors } : {}), ...(e.current_sha256 ? { current_sha256: e.current_sha256 } : {}) });
  console.error(`[media_studio] ${where} failed:`, e.message);
  return res.status(500).json({ error: safeErrorMessage(e) });
}
const view = (p) => ({ ...p, proposal_sha256: studio.proposalSha(p.proposal) });

let _ro = null;
const ro = () => (_ro || (_ro = readOnlyClient(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY))));
const readCanon = canon || ((slug) => castCanon(ro(), slug));
async function canonFor(project) {
  const slugs = new Set([project.host, ...studio.allShots(project.proposal).flatMap((s) => s.cast || [])].filter(Boolean));
  const out = {};
  for (const slug of slugs) {
    try { out[slug] = await readCanon(slug); } catch (e) { console.warn('[media_studio] canon read failed', slug, e.message); out[slug] = { ok: false, slug, reason: `${slug}: canon could not be read` }; }
  }
  return out;
}

// What do you want to make? (kinds + modes; plain language)
router.get('/options', (req, res) => {
  res.json({ kinds: studio.KINDS, production_modes: studio.PROJECT_MODES, live_generation: false,
    // advanced controls only: the renderer list for an optional pin (labels come from adapter metadata)
    renderers: CATALOG.map((a) => ({ id: a.id, label: a.label })).sort((a, b) => a.label.localeCompare(b.label)) });
});

router.get('/projects', (req, res) => { try { res.json({ projects: store.list() }); } catch (e) { fail(res, e, 'list'); } });

router.post('/projects', (req, res) => {
  try { const p = studio.createProject(req.body || {}, actorOf(req)); store.save(p); res.json({ project: view(p) }); } catch (e) { fail(res, e, 'create'); }
});

router.get('/projects/:id', (req, res) => { try { res.json({ project: view(store.get(req.params.id)) }); } catch (e) { fail(res, e, 'get'); } });

router.patch('/projects/:id', (req, res) => {
  try {
    const p = store.get(req.params.id); const b = req.body || {};
    if (b.production_mode !== undefined) {
      if (!studio.PROJECT_MODES[b.production_mode]) return res.status(400).json({ error: 'unknown production mode' });
      p.production_mode = b.production_mode; p.history.push({ at: new Date().toISOString(), event: 'mode_set', actor: actorOf(req), detail: { production_mode: b.production_mode } }); p.updated_at = new Date().toISOString();
    }
    if (b.treatment) studio.updateTreatment(p, b.treatment, actorOf(req));
    store.save(p); res.json({ project: view(p) });
  } catch (e) { fail(res, e, 'patch'); }
});

// Amanda's proposal: { draft: 'amanda' | 'template' }
router.post('/projects/:id/propose', async (req, res) => {
  try {
    const p = store.get(req.params.id);
    if (p.status === 'approved') return res.status(409).json({ error: 'approved proposals are reopened before redrafting', code: 'BAD_STATE' });
    let out = { proposal: studio.templateProposal(p), raw_extracted: null, fallback_reason: null };
    if ((req.body || {}).draft !== 'template') out = await draftProposal(p, anthropic || require('../lib/ai/anthropic'));
    studio.setProposal(p, out.proposal, actorOf(req)); store.save(p);
    res.json({ project: view(p), raw_extracted: out.raw_extracted, fallback_reason: out.fallback_reason });
  } catch (e) { fail(res, e, 'propose'); }
});

router.patch('/projects/:id/shots/:key', (req, res) => {
  try { const p = store.get(req.params.id); studio.updateShot(p, req.params.key, req.body || {}, actorOf(req)); store.save(p); res.json({ project: view(p) }); } catch (e) { fail(res, e, 'shot edit'); }
});

router.post('/projects/:id/shots/:key/review', (req, res) => {
  try { const p = store.get(req.params.id); const b = req.body || {}; studio.setShotReview(p, req.params.key, b.state, b.note, actorOf(req)); store.save(p); res.json({ project: view(p) }); } catch (e) { fail(res, e, 'shot review'); }
});

// Advanced only: pin a renderer for one shot (a router filter; cannot bypass hard rules). Empty clears it.
router.put('/projects/:id/shots/:key/pin', (req, res) => {
  try { const p = store.get(req.params.id); studio.setRendererPin(p, req.params.key, (req.body || {}).renderer || null, actorOf(req)); store.save(p); res.json({ project: view(p) }); } catch (e) { fail(res, e, 'pin'); }
});

// { action: submit | request_changes | approve | reopen, proposal_sha256, note }
router.post('/projects/:id/review', (req, res) => {
  try { const p = store.get(req.params.id); const b = req.body || {}; studio.review(p, b.action, { proposal_sha256: b.proposal_sha256, note: b.note }, actorOf(req)); store.save(p); res.json({ project: view(p) }); } catch (e) { fail(res, e, 'review'); }
});

// Dry-run routing + cost preview. No network call to any renderer; nothing generated.
router.get('/projects/:id/plan', async (req, res) => {
  try { const p = store.get(req.params.id); res.json(studio.previewPlan(p, { canon: await canonFor(p) })); } catch (e) { fail(res, e, 'plan'); }
});

router.post('/projects/:id/render', (req, res) => { try { studio.render(); } catch (e) { fail(res, e, 'render'); } });

return router;
}

// built on first use, so the UI harness can load buildRouter without production credentials
let _router = null;
module.exports = { buildRouter, get router() { return _router || (_router = buildRouter()); } };
