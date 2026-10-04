// ============================================================================
// api/onboarding.js  (Issue #15 Milestone 2) — Trusted Onboarding Engine API
// ----------------------------------------------------------------------------
// Thin HTTP layer over lib/onboarding/service.js (the single guarded path).
// Mounted at /api/onboarding.
//
//   POST /onboard                      Ed: community + system + cutoff + exported files -> batch (as Ed),
//                                      originals kept, the operator runs the engine (admin)
//   POST /batches/:id/files            add requested reports, operator resumes (admin)
//   POST /batches/:id/operate          resume the operator (admin)
//   GET  /status                       schema readiness (481/482 applied?)
//   GET  /communities                  alphabetical list for the batch form
//   GET  /batches[?community_id=]      engine batches
//   GET  /batches/:id                  batch, artifacts, events, current controls,
//                                      waivers, permitted actions, required human action
//   GET  /batches/:id/snapshot[?completion_id=]  proposed opening position (latest or a given result)
//   GET  /batches/:id/bridge[?completion_id=]    activity bridge classification (latest or a given result)
//   GET  /batches/:id/bridge/freshness  has Trusted activity changed since the bridge? (read-only)
//   GET  /batches/:id/preflight        the current conversion preflight report (+ markdown, staleness; read-only)
//   POST /batches                      create (admin)
//   POST /batches/:id/artifacts        upload one source file (admin; intake only)
//   POST /batches/:id/run              run the CURRENT stage, 0-4 only (admin)
//   POST /batches/:id/waivers          waive one open control (OWNER)
//   POST /batches/:id/advance          advance one stage (OWNER)
//   POST /batches/:id/approve          approve an exact preflight report (OWNER)
//   POST /batches/:id/execute          execute the approved preflight: { completion_id, preflight_sha256 } (OWNER)
//   GET  /batches/:id/execution        execution records (committed / failed attempts; read-only)
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

  router.get('/batches/:id/snapshot', async (req, res) => {
    try { if (!(await admin(req, res))) return; const v = await service.getSnapshot(req.params.id, req.query.completion_id || null); if (!v) return res.status(404).json({ error: 'no_snapshot' }); res.json(v); }
    catch (e) { fail(res, e, 'snapshot'); }
  });

  router.get('/batches/:id/bridge', async (req, res) => {
    try { if (!(await admin(req, res))) return; const v = await service.getBridge(req.params.id, req.query.completion_id || null); if (!v) return res.status(404).json({ error: 'no_bridge' }); res.json(v); }
    catch (e) { fail(res, e, 'bridge'); }
  });
  router.get('/batches/:id/bridge/freshness', async (req, res) => {
    try { if (!(await admin(req, res))) return; const v = await service.bridgeFreshness(req.params.id); if (!v) return res.status(404).json({ error: 'no_bridge' }); res.json(v); }
    catch (e) { fail(res, e, 'bridge freshness'); }
  });
  router.get('/batches/:id/preflight', async (req, res) => {
    try { if (!(await admin(req, res))) return; const v = await service.getPreflight(req.params.id); if (!v) return res.status(404).json({ error: 'no_preflight' }); res.json(v); }
    catch (e) { fail(res, e, 'preflight'); }
  });

  router.post('/batches', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const a = await admin(req, res); if (!a) return;
      const b = req.body || {};
      for (const k of ['community_id', 'batch_code', 'as_of_date', 'source_system']) if (!b[k]) return res.status(400).json({ error: `${k}_required` });
      res.json({ id: await service.createBatch(a, { community_id: b.community_id, batch_code: b.batch_code, as_of_date: b.as_of_date, source_system: b.source_system }) });
    } catch (e) { fail(res, e, 'create'); }
  });

  // ---- Operator: Ed picks the community / system / cutoff and drops the exports;
  // Trusted creates the batch (as Ed), keeps the originals, and runs the engine.
  const uploadMany = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 40 } });
  const batchCodeFor = async (communityId, cutoff) => {
    const c = (await listCommunities()).find((x) => x.id === communityId);
    const initials = c ? c.name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '') : 'X';
    return `CONV-${initials || 'X'}-${String(cutoff).replace(/-/g, '')}`;
  };
  async function storeOriginals(actor, batchId, files) {
    const out = [];
    for (const f of files || []) out.push(await service.registerArtifact(actor, batchId, { buffer: f.buffer, filename: f.originalname, artifact_type: /\.pdf$/i.test(f.originalname) ? 'original_pdf' : 'original' }));
    return out;
  }
  // What to obtain from the legacy system for this cutoff, and which chosen files
  // are which report. Neither stores or records anything.
  router.get('/source-package', async (req, res) => {
    try { if (!(await admin(req, res))) return; res.json(await service.sourcePackage(req.query.system || 'vantaca', req.query.cutoff || null)); }
    catch (e) { fail(res, e, 'source package'); }
  });
  router.post('/recognize', uploadMany.array('files', 40), async (req, res) => {
    try {
      if (!(await admin(req, res))) return;
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'files_required' });
      res.json({ files: await service.recognize((req.body && req.body.source_system) || 'vantaca', (req.body && req.body.as_of_date) || null, req.files) });
    } catch (e) { fail(res, e, 'recognize'); }
  });
  router.post('/onboard', uploadMany.array('files', 40), async (req, res) => {
    try {
      const a = await admin(req, res); if (!a) return;
      const b = req.body || {};
      for (const k of ['community_id', 'as_of_date', 'source_system']) if (!b[k]) return res.status(400).json({ error: `${k}_required` });
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'files_required' });
      const id = await service.createBatch(a, { community_id: b.community_id, batch_code: b.batch_code || await batchCodeFor(b.community_id, b.as_of_date), as_of_date: b.as_of_date, source_system: b.source_system });
      await storeOriginals(a, id, req.files);
      res.json({ id, operator: await service.operate(id) });
    } catch (e) { fail(res, e, 'onboard'); }
  });
  router.post('/batches/:id/files', uploadMany.array('files', 40), async (req, res) => {
    try {
      const a = await admin(req, res); if (!a) return;
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'files_required' });
      await storeOriginals(a, req.params.id, req.files);
      res.json({ operator: await service.operate(req.params.id) });
    } catch (e) { fail(res, e, 'files'); }
  });
  router.post('/batches/:id/decisions', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const a = await owner(req, res); if (!a) return;
      const b = req.body || {};
      const recorded = await service.decide(a, req.params.id, { completion_id: b.completion_id, decisions: b.decisions });
      res.json({ decisions: recorded, operator: await service.operate(req.params.id) });
    } catch (e) { fail(res, e, 'decisions'); }
  });
  router.post('/batches/:id/operate', async (req, res) => {
    try { if (!(await admin(req, res))) return; res.json({ operator: await service.operate(req.params.id) }); }
    catch (e) { fail(res, e, 'operate'); }
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
    try { const a = await admin(req, res); if (!a) return; const b = req.body || {}; res.json(await service.runStage(a, req.params.id, { roles: b.roles, authoritative: b.authoritative, ap_account: b.ap_account, fund_by_account: b.fund_by_account })); }
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

  router.post('/batches/:id/execute', express.json({ limit: '64kb' }), async (req, res) => {
    try { const o = await owner(req, res); if (!o) return; const b = req.body || {}; res.json({ execution: await service.execute(o, req.params.id, { completion_id: b.completion_id, preflight_sha256: b.preflight_sha256 }) }); }
    catch (e) { fail(res, e, 'execute'); }
  });

  router.get('/batches/:id/execution', async (req, res) => {
    try { if (!(await admin(req, res))) return; res.json({ executions: await service.getExecution(req.params.id) }); }
    catch (e) { fail(res, e, 'execution'); }
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
