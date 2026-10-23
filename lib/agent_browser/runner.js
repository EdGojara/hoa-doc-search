// ============================================================================
// lib/agent_browser/runner.js — runs one declared skill in Chrome on the server
// and keeps the evidence (Ed 2026-10-23).
// ----------------------------------------------------------------------------
// Same Chrome trustEd already ships for PDFs (puppeteer, .puppeteerrc.cjs). One
// run at a time per skill. Every run is recorded in cron_runs (job agent_browser)
// with its steps, findings and the SHA-256 of each screenshot; the screenshots
// are stored in the private documents bucket under agent-browser/<run id>/.
// The browser always closes, success or failure.
// ============================================================================
const crypto = require('crypto');

const SKILLS = {
  'newfirst.login_navigation': () => require('./skills/newfirst_login_navigation'),
};
const JOB = 'agent_browser';
const BUCKET = 'documents';
const RUN_TIMEOUT_MS = 90000;
const running = new Map();

function runSkill(skillId, opts = {}) {
  if (!SKILLS[skillId]) return Promise.resolve({ ok: false, status: 'unknown_skill', skill: skillId });
  if (running.has(skillId)) return running.get(skillId);
  const p = runOnce(skillId, opts).finally(() => running.delete(skillId));
  running.set(skillId, p);
  return p;
}

async function runOnce(skillId, { supabase, actor = 'kat', trigger = 'manual', launch = null } = {}) {
  const skill = SKILLS[skillId]();
  const { createGuard, GuardStop } = require('./guard');
  const runId = crypto.randomUUID();
  const started = new Date();
  const out = { run_id: runId, skill: `${skill.declaration.id}.v${skill.declaration.version}`, actor, trigger, started_at: started.toISOString(), status: 'running' };
  let browser = null; let g = null;
  try {
    browser = await (launch || (() => require('puppeteer').launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })))();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    g = createGuard({ page, declaration: skill.declaration });
    await g.start();
    out.result = await Promise.race([
      skill.run(g),
      new Promise((_, rej) => setTimeout(() => rej(new GuardStop('failed', `run exceeded ${RUN_TIMEOUT_MS / 1000}s`)), RUN_TIMEOUT_MS)),
    ]);
    out.status = 'completed';
  } catch (e) {
    out.status = e instanceof GuardStop ? e.status : 'failed';
    out.stopped_because = e.reason || e.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  out.finished_at = new Date().toISOString();
  out.steps = g ? g.steps : [];
  out.blocked = g ? g.blocked : [];
  out.suspicious_page_text = g ? g.suspicious : [];
  out.evidence = [];
  if (supabase && g) {
    for (const [i, s] of g.shots.entries()) {
      const path = `agent-browser/${runId}/${String(i + 1).padStart(2, '0')}-${s.step}.png`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, s.buf, { contentType: 'image/png', upsert: false });
      out.evidence.push({ path, sha256: s.sha256, stored: !error, error: error ? error.message : undefined });
    }
    const { error } = await supabase.from('cron_runs').insert({ job_name: JOB, started_at: out.started_at, finished_at: out.finished_at,
      ok: out.status === 'completed', summary: out, error: out.status === 'completed' ? null : String(out.stopped_because || '').slice(0, 500), triggered_by: trigger });
    if (error) console.warn('[agent_browser] run not recorded:', error.message);
  }
  console.log('[agent_browser]', JSON.stringify({ run_id: runId, skill: out.skill, status: out.status, blocked_hosts: out.blocked.filter((b) => b.kind === 'host').length }));
  return out;
}

module.exports = { runSkill, SKILLS, JOB, BUCKET };
