// api/agent_browser.js — owner-only: start a declared AI-employee browser skill on the server
// and read its recorded runs and evidence (Ed 2026-10-23). The skill runs in Chrome on Render,
// not in anyone's browser; the guard (lib/agent_browser/guard.js) enforces its declaration.
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { runSkill, SKILLS, JOB, BUCKET } = require('../lib/agent_browser/runner');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// GET as well as POST so the owner can start the read-only check from a link. Both are owner-only.
async function start(req, res) {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const skill = String(req.params.skill || '');
    if (!SKILLS[skill]) return res.status(404).json({ error: 'unknown_skill', skills: Object.keys(SKILLS) });
    const out = await runSkill(skill, { supabase, actor: 'kat', trigger: `owner:${u.email}` });
    res.status(out.status === 'completed' ? 200 : 409).json(out);
  } catch (err) { console.error('[agent_browser] run failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
}
router.post('/run/:skill', start);
router.get('/run/:skill', start);

router.get('/runs', async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const { data, error } = await supabase.from('cron_runs').select('started_at, finished_at, ok, summary, error, triggered_by')
      .eq('job_name', JOB).order('started_at', { ascending: false }).limit(20);
    if (error) throw error;
    res.json({ runs: data || [] });
  } catch (err) { console.error('[agent_browser] runs failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// A short-lived link to one evidence screenshot of a recorded run.
router.get('/evidence', async (req, res) => {
  try {
    const u = await requireOwner(req, res); if (!u) return;
    const path = String(req.query.path || '');
    if (!/^agent-browser\/[0-9a-f-]{36}\/[\w.-]+\.png$/.test(path)) return res.status(400).json({ error: 'invalid_path' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
    if (error) throw error;
    res.redirect(data.signedUrl);
  } catch (err) { console.error('[agent_browser] evidence failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
