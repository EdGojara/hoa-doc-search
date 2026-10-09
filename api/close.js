// ============================================================================
// api/close.js  (Ed 2026-10-09: month-end close, PR A)  mounted at /api/close
// ----------------------------------------------------------------------------
//   GET  /:cid/periods                         months with close status + closed-through
//   GET  /:cid/periods/:pid                    close record, latest run, results, history
//   POST /:cid/periods/:pid/run                run the checklist (staff)
//   POST /:cid/periods/:pid/override           {run_id, control_code, reason}  OWNER only
//   POST /:cid/periods/:pid/accept-warnings    {run_id, control_codes[], note} admin/owner
//   POST /:cid/periods/:pid/close              {run_id}                         admin/owner
//   POST /:cid/periods/:pid/reopen             {reason}                         admin/owner
//   GET  /:cid/requirements                    required period sources (configuration)
//   POST /:cid/requirements                    {source_key, label, required, config, reason} admin/owner
//   POST /:cid/periods/:pid/evidence           {requirement_id, document_ref, note} staff
// The actor is always the signed-in user, never a value from the request body.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireStaff, requireAdmin, requireOwner, OWNER_EMAIL } = require('./_require_admin');
const C = require('../lib/close/service');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const actorOf = (u) => ({
  name: u.email || u.full_name || (u.user && u.user.email),
  user_id: (u.user && u.user.id) || null,
  role: String(u.email || '').toLowerCase() === OWNER_EMAIL ? 'owner' : (u.role === 'admin' ? 'admin' : 'staff'),
});
const ids = (req, res) => {
  const { cid, pid } = req.params;
  if (!UUID.test(cid || '') || (pid !== undefined && !UUID.test(pid || ''))) { res.status(400).json({ error: 'bad_id' }); return false; }
  return true;
};
const fail = (res, what, err) => {
  if (err && err.refusal) return res.status(409).json({ error: err.message, code: err.code });
  if (err && err.code === 'PGRST202') return res.status(503).json({ error: 'Month-end close is not installed yet (migration 502).' });
  console.error(`[close] ${what} failed:`, err && err.message);
  return res.status(500).json({ error: safeErrorMessage(err) });
};

router.get('/:cid/periods', async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireStaff(req, res); if (!u) return;
    res.json(await C.listPeriods(supabase, req.params.cid));
  } catch (err) { fail(res, 'periods', err); }
});

router.get('/:cid/periods/:pid', async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireStaff(req, res); if (!u) return;
    res.json({ ...(await C.status(supabase, req.params.cid, req.params.pid)), viewer: actorOf(u).role });
  } catch (err) { fail(res, 'status', err); }
});

router.post('/:cid/periods/:pid/run', express.json(), async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireStaff(req, res); if (!u) return;
    res.json(await C.runChecklist(supabase, req.params.cid, req.params.pid, actorOf(u)));
  } catch (err) { fail(res, 'run', err); }
});

router.post('/:cid/periods/:pid/override', express.json(), async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireOwner(req, res); if (!u) return;
    const b = req.body || {};
    if (!UUID.test(b.run_id || '') || !b.control_code) return res.status(400).json({ error: 'run_id_and_control_code_required' });
    if (String(b.reason || '').trim().length < 10) return res.status(400).json({ error: 'A BLOCK override needs a written reason (10+ characters).' });
    res.json(await C.overrideBlock(supabase, req.params.cid, req.params.pid, b, { ...actorOf(u), role: 'owner' }));
  } catch (err) { fail(res, 'override', err); }
});

router.post('/:cid/periods/:pid/accept-warnings', express.json(), async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    if (!UUID.test(b.run_id || '') || !Array.isArray(b.control_codes) || !b.control_codes.length) return res.status(400).json({ error: 'run_id_and_control_codes_required' });
    res.json(await C.acceptWarnings(supabase, req.params.cid, req.params.pid, b, actorOf(u)));
  } catch (err) { fail(res, 'accept-warnings', err); }
});

router.post('/:cid/periods/:pid/close', express.json(), async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    if (!UUID.test(b.run_id || '')) return res.status(400).json({ error: 'run_id_required' });
    res.json(await C.closePeriod(supabase, req.params.cid, req.params.pid, b, actorOf(u)));
  } catch (err) { fail(res, 'close', err); }
});

router.post('/:cid/periods/:pid/reopen', express.json(), async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    if (String(b.reason || '').trim().length < 10) return res.status(400).json({ error: 'A reopen needs a written reason (10+ characters).' });
    res.json(await C.reopenPeriod(supabase, req.params.cid, req.params.pid, b, actorOf(u)));
  } catch (err) { fail(res, 'reopen', err); }
});

router.get('/:cid/requirements', async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireStaff(req, res); if (!u) return;
    const { data, error } = await supabase.from('close_source_requirements').select('*').eq('community_id', req.params.cid).order('source_key').order('label');
    if (error) throw error;
    res.json({ requirements: data || [] });
  } catch (err) { fail(res, 'requirements', err); }
});

router.post('/:cid/requirements', express.json(), async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    const keys = ['homeowner_feed', 'bank_statements', 'recognition', 'ap_feed', 'other'];
    if (!keys.includes(b.source_key)) return res.status(400).json({ error: 'source_key_invalid' });
    if (String(b.reason || '').trim().length < 10) return res.status(400).json({ error: 'Say why (10+ characters); this changes what the close requires.' });
    if (b.source_key === 'homeowner_feed' && b.config && b.config.mode && !['import', 'native'].includes(b.config.mode)) return res.status(400).json({ error: 'mode_invalid' });
    const row = { community_id: req.params.cid, source_key: b.source_key, label: String(b.label || b.source_key).trim().slice(0, 120),
      required: b.required !== false, config: b.config && typeof b.config === 'object' ? b.config : {}, set_by: actorOf(u).name, set_reason: String(b.reason).trim() };
    const { data, error } = await supabase.from('close_source_requirements').upsert(row, { onConflict: 'community_id,source_key,label' }).select('*').single();
    if (error) throw error;
    res.json({ requirement: data });
  } catch (err) { fail(res, 'requirements-set', err); }
});

router.post('/:cid/periods/:pid/evidence', express.json(), async (req, res) => {
  try { if (!ids(req, res)) return; const u = await requireStaff(req, res); if (!u) return;
    const b = req.body || {};
    if (!UUID.test(b.requirement_id || '') || !String(b.document_ref || '').trim()) return res.status(400).json({ error: 'requirement_id_and_document_ref_required' });
    res.json({ evidence_id: await C.addEvidence(supabase, req.params.cid, req.params.pid, b, actorOf(u)) });
  } catch (err) { fail(res, 'evidence', err); }
});

module.exports = { router };
