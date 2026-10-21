#!/usr/bin/env node
// Deploy verification — confirms production (GET /version) is running main.
//
// Two modes, both run from .github/workflows/deploy-verify.yml:
//   wait  — after a push to main: poll /version until it is running that SHA
//           (or a later commit that contains it). Not there within
//           DEPLOY_TIMEOUT_MIN → open/update the "Production is behind main"
//           issue and fail the run (one failed run per merge that missed).
//   check — scheduled backstop: compare /version to the head of main. Behind
//           for longer than DRIFT_GRACE_MIN → open/update the issue. Caught up
//           → close it. Fails the run only when it raised something NEW, so a
//           drift that's already reported (or deliberately held) doesn't email
//           every 30 minutes.
//
// Alert hygiene:
//   - one open issue at a time; a newer undeployed main head adds ONE comment
//   - two runs racing to open it: the newer duplicate is closed as a duplicate
//   - closing the issue while that commit is still undeployed means "held on
//     purpose": it isn't reopened for any commit it mentions, only for a newer one
//   - /version blips and GitHub 5xx are retried before anything is concluded
// Read-only toward production: it never triggers a deploy.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA (wait mode), PROD_URL,
//      DEPLOY_TIMEOUT_MIN (default 20), DRIFT_GRACE_MIN (default 30),
//      POLL_SECONDS (default 30), DRY_RUN=1 (log issue writes, don't make them).
// Tests: tests/test_verify_deploy.js drives run() with a fake clock, /version
// and GitHub.

const LABEL = 'deploy-drift';
const TITLE = 'Production is behind main';
const short = (sha) => (sha || '').slice(0, 7);
const markerFor = (sha) => `<!-- deploy-drift:${sha} -->`;
const MARKER_RE = /<!-- deploy-drift:([0-9a-f]{7,40}) -->/g;
const RESOLVED = '<!-- deploy-drift:resolved -->';

function config(env) {
  return {
    repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    sha: env.GITHUB_SHA,
    prodUrl: (env.PROD_URL || 'https://my.bedrocktxai.com').replace(/\/$/, ''),
    timeoutMin: Number(env.DEPLOY_TIMEOUT_MIN || 20),
    graceMin: Number(env.DRIFT_GRACE_MIN || 30),
    pollSeconds: Number(env.POLL_SECONDS || 30),
    dryRun: env.DRY_RUN === '1',
  };
}

/**
 * @param {'wait'|'check'} mode
 * @param {object} deps  { env, fetch, now, sleep, log } — defaults are the real ones
 * @returns {Promise<{code:number, outcome:string}>}
 */
async function run(mode, deps = {}) {
  const env = deps.env || process.env;
  const doFetch = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || console.log;
  const cfg = config(env);

  async function gh(path, opts = {}) {
    if (cfg.dryRun && opts.method && opts.method !== 'GET') {
      log(`[dry-run] ${opts.method} ${path}\n${opts.body || ''}`);
      return { number: 0 };
    }
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await doFetch(`https://api.github.com${path}`, {
          ...opts,
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          },
        });
      } catch (e) {
        if (attempt < 3) { await sleep(attempt * 5000); continue; }
        throw e;
      }
      if (res.status >= 500 && attempt < 3) { await sleep(attempt * 5000); continue; }
      if (!res.ok && !(opts.allow || []).includes(res.status)) {
        throw new Error(`GitHub ${opts.method || 'GET'} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return res.status === 204 ? null : res.json().catch(() => null);
    }
  }

  async function prodVersion() {
    try {
      const res = await doFetch(`${cfg.prodUrl}/version?t=${now()}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      return { error: e.message };
    }
  }

  // One blip (restart, edge hiccup) shouldn't read as "down".
  async function prodVersionSettled() {
    let v = await prodVersion();
    for (let i = 0; v.error && i < 2; i++) { await sleep(20000); v = await prodVersion(); }
    return v;
  }

  // True when production is running `target` or a later commit that contains it.
  async function prodContains(prodSha, target) {
    if (!prodSha || prodSha === 'unknown') return false;
    if (prodSha === target || prodSha.startsWith(target) || target.startsWith(prodSha)) return true;
    const cmp = await gh(`/repos/${cfg.repo}/compare/${target}...${prodSha}`, { allow: [404] });
    return !!cmp && (cmp.status === 'ahead' || cmp.status === 'identical');
  }

  async function undeployedCommits(prodSha, mainSha) {
    if (!prodSha || prodSha === 'unknown') return [];
    const cmp = await gh(`/repos/${cfg.repo}/compare/${prodSha}...${mainSha}`, { allow: [404] });
    return ((cmp && cmp.commits) || []).map((c) => `- \`${short(c.sha)}\` ${c.commit.message.split('\n')[0]}`);
  }

  async function openIssues() {
    const list = await gh(`/repos/${cfg.repo}/issues?state=open&labels=${LABEL}&per_page=20&sort=created&direction=asc`);
    return (list || []).filter((i) => !i.pull_request).sort((a, b) => a.number - b.number);
  }

  async function issueText(issue) {
    const comments = issue.comments ? await gh(`/repos/${cfg.repo}/issues/${issue.number}/comments?per_page=100`) : [];
    return [issue.body || '', ...(comments || []).map((c) => c.body || '')].join('\n');
  }

  // Every SHA a deliberately-closed issue mentions is "held". Issues closed as
  // a duplicate, or closed by this script on recovery, don't count (so a later
  // rollback below those commits alerts again).
  async function heldShas() {
    const closed = await gh(`/repos/${cfg.repo}/issues?state=closed&labels=${LABEL}&per_page=20&sort=updated&direction=desc`);
    const held = new Set();
    for (const i of (closed || []).filter((x) => !x.pull_request && x.state_reason !== 'duplicate')) {
      const text = await issueText(i);
      if (text.includes(RESOLVED)) continue;
      for (const m of text.matchAll(MARKER_RE)) held.add(m[1]);
    }
    return held;
  }

  async function raiseDrift({ prod, mainSha, reason }) {
    const marker = markerFor(mainSha);
    const commits = await undeployedCommits(prod.commit, mainSha);
    const body = [
      marker,
      `**${reason}**`,
      '',
      `- main: \`${short(mainSha)}\``,
      `- production (${cfg.prodUrl}/version): ${prod.error ? `unreachable (${prod.error})` : `\`${prod.commit_short || short(prod.commit)}\`, booted ${prod.booted_at}`}`,
      '',
      commits.length ? `Not yet in production:\n${commits.join('\n')}` : '',
      '',
      'To deploy: Render dashboard → the trustEd web service → **Manual Deploy** → **Deploy latest commit**.',
      'If merges keep missing: check https://www.githubstatus.com (Webhooks) and the service\'s **Settings → Build & Deploy** (Auto-Deploy, Branch, Build Filters).',
      'If this commit was held back on purpose, close this issue; it won\'t reopen for it, only for a newer undeployed commit.',
    ].join('\n');

    const open = await openIssues();
    if (open.length) {
      const issue = open[0];
      if ((await issueText(issue)).includes(marker)) { log(`issue #${issue.number} already covers ${short(mainSha)}`); return 'already'; }
      await gh(`/repos/${cfg.repo}/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      log(`commented on issue #${issue.number}`);
      return 'commented';
    }
    const held = await heldShas();
    if ([...held].some((h) => h.startsWith(mainSha) || mainSha.startsWith(h))) {
      log(`${short(mainSha)} is in a closed drift issue (held on purpose) — not reopening`);
      return 'held';
    }
    await gh(`/repos/${cfg.repo}/labels`, {
      method: 'POST', allow: [422],
      body: JSON.stringify({ name: LABEL, color: 'd93f0b', description: 'Production /version is behind main' }),
    });
    const created = await gh(`/repos/${cfg.repo}/issues`, {
      method: 'POST', body: JSON.stringify({ title: TITLE, body, labels: [LABEL] }),
    });
    log(`opened issue #${created.number}`);
    // Two runs can both see "no open issue" and both open one. Keep the oldest.
    const after = cfg.dryRun ? [] : await openIssues();
    for (const dup of after.slice(1)) {
      await gh(`/repos/${cfg.repo}/issues/${dup.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Duplicate of #${after[0].number}.` }) });
      await gh(`/repos/${cfg.repo}/issues/${dup.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'duplicate' }) });
      log(`closed duplicate issue #${dup.number}`);
    }
    return after.length > 1 && after[0].number !== created.number ? 'duplicate' : 'opened';
  }

  async function resolveDrift(prod) {
    const open = await openIssues();
    for (const issue of open) {
      await gh(`/repos/${cfg.repo}/issues/${issue.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: `${RESOLVED}
Production caught up: running \`${prod.commit_short || short(prod.commit)}\` (booted ${prod.booted_at}), which includes the head of main. Closing.` }),
      });
      await gh(`/repos/${cfg.repo}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
      log(`closed issue #${issue.number}`);
    }
    return open.length ? 'resolved' : 'in-sync';
  }

  async function mainHead() {
    const c = await gh(`/repos/${cfg.repo}/commits/main`);
    return { sha: c.sha, at: new Date(c.commit.committer.date).getTime() };
  }

  if (mode === 'wait') {
    const target = cfg.sha;
    const deadline = now() + cfg.timeoutMin * 60000;
    let prod = {};
    log(`waiting up to ${cfg.timeoutMin} min for ${cfg.prodUrl} to run ${short(target)}`);
    while (now() < deadline) {
      prod = await prodVersion();
      if (!prod.error && await prodContains(prod.commit, target)) {
        log(`deployed: production is ${prod.commit_short} (booted ${prod.booted_at})`);
        const head = await mainHead();
        if (await prodContains(prod.commit, head.sha)) await resolveDrift(prod);
        return { code: 0, outcome: 'deployed' };
      }
      log(`  production: ${prod.error || `${prod.commit_short}, booted ${prod.booted_at}`}`);
      await sleep(cfg.pollSeconds * 1000);
    }
    // A newer push to main supersedes this one; its own run raises the alarm.
    const head = await mainHead();
    if (!head.sha.startsWith(target)) {
      log(`not deployed, but main moved on to ${short(head.sha)} — leaving it to that run`);
      return { code: 0, outcome: 'superseded' };
    }
    const outcome = await raiseDrift({ prod, mainSha: head.sha, reason: `Merge ${short(target)} was not deployed within ${cfg.timeoutMin} minutes.` });
    return { code: outcome === 'held' ? 0 : 1, outcome };
  }

  const head = await mainHead();
  const prod = await prodVersionSettled();
  if (!prod.error && await prodContains(prod.commit, head.sha)) {
    log(`in sync: production ${prod.commit_short} includes main ${short(head.sha)}`);
    return { code: 0, outcome: await resolveDrift(prod) };
  }
  const ageMin = (now() - head.at) / 60000;
  if (ageMin < cfg.graceMin) {
    log(`behind, but main ${short(head.sha)} is only ${ageMin.toFixed(0)} min old — within grace`);
    return { code: 0, outcome: 'grace' };
  }
  const outcome = await raiseDrift({ prod, mainSha: head.sha, reason: `Production has been behind main for ${ageMin.toFixed(0)} minutes.` });
  return { code: outcome === 'opened' || outcome === 'commented' ? 1 : 0, outcome };
}

module.exports = { run, LABEL, TITLE, markerFor };

if (require.main === module) {
  run(process.argv[2] === 'wait' ? 'wait' : 'check')
    .then(({ code }) => process.exit(code))
    .catch((e) => { console.error(e); process.exit(2); });
}
