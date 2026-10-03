// ============================================================================
// api/onboarding.js  (Issue #15 Milestone 2) — Trusted Onboarding Engine API
// ----------------------------------------------------------------------------
// Thin HTTP layer over lib/onboarding/service.js (the single guarded path).
// Mounted at /api/onboarding.
//
//   GET  /status                       schema readiness (481/482 applied?)
//   GET  /communities                  alphabetical list for the batch form
//   GET  /batches[?community_id=]      engine batches
//   GET  /batches/:id                  batch, artifacts, events, current controls,
//                                      waivers, permitted actions, required human action
//   POST /batches                      create (admin)
//   POST /batches/:id/artifacts        upload one source file (admin; intake only)
//   POST /batches/:id/run              run the CURRENT stage, 0-2 only (admin)
//   POST /batches/:id/waivers          waive one open control (OWNER)
//   POST /batches/:id/advance          advance one stage (OWNER)
//   POST /batches/:id/approve          approve an exact preflight report (OWNER)
//
// The actor is ALWAYS built here from the authenticated user; any actor /
// actor_kind / role in a request body is ignored. Admin = role admin; owner =
// admin + owner email (api/_require_admin.js). Database refusals come back as
// 409 with the database's own message, so the operator sees exactly why.
// ============================================================================
const express = require('express');
const multer = require('multer');
const { safeErrorMessage } = require('./_safe_error');
const { createOnboardingService, supabaseBackends } = require('../lib/onboarding/service');

function buildRouter({ service, auth, listCommunities }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  const actorFrom = (u, owner) => ({ kind: 'human', id: u.user && u.user.id, email: u.email, role: owner ? 'owner' : 'admin' });
  // Admin gate that also tells us whether the admin is the owner (for permitted actions in views).
  async function admin(req, res) {
    const u = await auth.requireAdmin(req, res); if (!u) return null;
    const isOwner = String(u.email || '').toLowerCase() === String(auth.OWNER_EMAIL || '').toLowerCase();
    return actorFrom(u, isOwner);
  }
  async function owner(req, res) { const u = await auth.requireOwner(req, res); if (!u) return null; return actorFrom(u, true); }
  const fail = (res, e, what) => {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error(`[onboarding] ${what} failed:`, e && e.message);
    return res.status(500).json({ error: safeErrorMessage(e) });
  };

  router.get('/status', async (req, res) => { try { if (!(await admin(req, res))) return; res.json(await service.schemaStatus()); } catch (e) { fail(res, e, 'status'); } });
  router.get('/communities', async (req, res) => { try { if (!(await admin(req, res))) return; res.json(await listCommunities()); } catch (e) { fail(res, e, 'communities'); } });
  router.get('/batches', async (req, res) => { try { if (!(await admin(req, res))) return; res.json(await service.listBatches(req.query.community_id || null)); } catch (e) { fail(res, e, 'list'); } });
  router.get('/batches/:id', async (req, res) => { try { const a = await admin(req, res); if (!a) return; res.json(await service.getBatch(req.params.id, a)); } catch (e) { fail(res, e, 'view'); } });

  router.post('/batches', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const a = await admin(req, res); if (!a) return;
      const b = req.body || {};
      for (const k of ['community_id', 'batch_code', 'as_of_date', 'source_system']) if (!b[k]) return res.status(400).json({ error: `${k}_required` });
      res.json({ id: await service.createBatch(a, { community_id: b.community_id, batch_code: b.batch_code, as_of_date: b.as_of_date, source_system: b.source_system }) });
    } catch (e) { fail(res, e, 'create'); }
  });

  router.post('/batches/:id/artifacts', upload.single('file'), async (req, res) => {
    try {
      const a = await admin(req, res); if (!a) return;
      if (!req.file) return res.status(400).json({ error: 'file_required' });
      const b = req.body || {};
      const id = await service.registerArtifact(a, req.params.id, { buffer: req.file.buffer, filename: req.file.originalname, artifact_type: b.artifact_type,
        derived_from_sha256: b.derived_from_sha256 || null, period_start: b.period_start || null, period_end: b.period_end || null, cutoff_date: b.cutoff_date || null, version_label: b.version_label || null });
      res.json({ id });
    } catch (e) { fail(res, e, 'artifact'); }
  });

  router.post('/batches/:id/run', express.json({ limit: '64kb' }), async (req, res) => {
    try { const a = await admin(req, res); if (!a) return; const b = req.body || {}; res.json(await service.runStage(a, req.params.id, { roles: b.roles, authoritative: b.authoritative })); }
    catch (e) { fail(res, e, 'run'); }
  });

  router.post('/batches/:id/waivers', express.json({ limit: '64kb' }), async (req, res) => {
    try { const o = await owner(req, res); if (!o) return; const b = req.body || {}; res.json({ id: await service.waive(o, req.params.id, { completion_id: b.completion_id, code: b.code, reason: b.reason }) }); }
    catch (e) { fail(res, e, 'waive'); }
  });

  router.post('/batches/:id/advance', express.json({ limit: '64kb' }), async (req, res) => {
    try { const o = await owner(req, res); if (!o) return; const b = req.body || {}; res.json({ id: await service.advance(o, req.params.id, { completion_id: b.completion_id, to: b.to }) }); }
    catch (e) { fail(res, e, 'advance'); }
  });

  router.post('/batches/:id/approve', express.json({ limit: '1mb' }), async (req, res) => {
    try { const o = await owner(req, res); if (!o) return; const b = req.body || {}; res.json({ id: await service.approve(o, req.params.id, { completion_id: b.completion_id, preflight: b.preflight }) }); }
    catch (e) { fail(res, e, 'approve'); }
  });

  return router;
}

// Production instance.
let router = null;
function productionRouter() {
  if (router) return router;
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const service = createOnboardingService(supabaseBackends(supabase));
  const listCommunities = async () => {
    const { data, error } = await supabase.from('communities').select('id, name').order('name').limit(500);
    if (error) throw error;
    return data || [];
  };
  router = buildRouter({ service, auth: require('./_require_admin'), listCommunities });
  return router;
}

module.exports = { buildRouter, get router() { return productionRouter(); } };
