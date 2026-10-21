#!/usr/bin/env node
// Deploy verification — confirms production (GET /version) is running main.
//
// Two modes, both run from .github/workflows/deploy-verify.yml:
//   wait  — after a push to main: poll /version until it is running that SHA
//           (or a later commit that contains it). Not there within
//           DEPLOY_TIMEOUT_MIN → open/update the "Production is behind main"
//           issue and fail the run.
//   check — scheduled backstop: compare /version to the head of main. Behind
//           for longer than DRIFT_GRACE_MIN → open/update the issue and fail.
//           Caught up → close the issue.
//
// The issue is the alert: GitHub emails/pushes it to the repo owner. One open
// issue at a time; a new undeployed main head adds one comment, never a new
// issue per run. Read-only toward production: it never triggers a deploy.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA (wait mode), PROD_URL,
//      DEPLOY_TIMEOUT_MIN (default 20), DRIFT_GRACE_MIN (default 30),
//      POLL_SECONDS (default 30), DRY_RUN=1 (log issue writes, don't make them).

const MODE = process.argv[2] || 'check';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const PROD_URL = (process.env.PROD_URL || 'https://my.bedrocktxai.com').replace(/\/$/, '');
const TIMEOUT_MIN = Number(process.env.DEPLOY_TIMEOUT_MIN || 20);
const GRACE_MIN = Number(process.env.DRIFT_GRACE_MIN || 30);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 30);
const DRY_RUN = process.env.DRY_RUN === '1';
const LABEL = 'deploy-drift';
const TITLE = 'Production is behind main';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (sha) => (sha || '').slice(0, 7);

async function gh(path, opts = {}) {
  if (DRY_RUN && opts.method && opts.method !== 'GET') {
    console.log(`[dry-run] ${opts.method} ${path}
${opts.body || ''}`);
    return { number: 0 };
  }
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok && !(opts.allow || []).includes(res.status)) {
    throw new Error(`GitHub ${opts.method || 'GET'} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function prodVersion() {
  try {
    const res = await fetch(`${PROD_URL}/version?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

// True when production is running `target` or a later commit that contains it.
async function prodContains(prodSha, target) {
  if (!prodSha || prodSha === 'unknown') return false;
  if (prodSha === target) return true;
  const cmp = await gh(`/repos/${REPO}/compare/${target}...${prodSha}`, { allow: [404] });
  return !!cmp && (cmp.status === 'ahead' || cmp.status === 'identical');
}

async function undeployedCommits(prodSha, mainSha) {
  if (!prodSha || prodSha === 'unknown') return [];
  const cmp = await gh(`/repos/${REPO}/compare/${prodSha}...${mainSha}`, { allow: [404] });
  return ((cmp && cmp.commits) || []).map((c) => `- \`${short(c.sha)}\` ${c.commit.message.split('\n')[0]}`);
}

async function openIssue() {
  const list = await gh(`/repos/${REPO}/issues?state=open&labels=${LABEL}&per_page=10`);
  return (list || []).find((i) => !i.pull_request) || null;
}

async function raiseDrift({ prod, mainSha, reason }) {
  const marker = `<!-- deploy-drift:${mainSha} -->`;
  const commits = await undeployedCommits(prod.commit, mainSha);
  const body = [
    marker,
    `**${reason}**`,
    '',
    `- main: \`${short(mainSha)}\``,
    `- production (${PROD_URL}/version): ${prod.error ? `unreachable (${prod.error})` : `\`${prod.commit_short || short(prod.commit)}\`, booted ${prod.booted_at}`}`,
    '',
    commits.length ? `Not yet in production:\n${commits.join('\n')}` : '',
    '',
    'To deploy: Render dashboard → the trustEd web service → **Manual Deploy** → **Deploy latest commit**.',
    'If merges keep missing: check https://www.githubstatus.com (Webhooks) and the service\'s **Settings → Build & Deploy** (Auto-Deploy, Branch, Build Filters).',
    'If this commit was held back on purpose, close this issue; it reopens only when a newer main commit is also undeployed.',
  ].join('\n');

  await gh(`/repos/${REPO}/labels`, {
    method: 'POST', allow: [422],
    body: JSON.stringify({ name: LABEL, color: 'd93f0b', description: 'Production /version is behind main' }),
  });

  const existing = await openIssue();
  if (!existing) {
    // A closed issue for this exact SHA means it was dismissed on purpose.
    const closed = await gh(`/repos/${REPO}/issues?state=closed&labels=${LABEL}&per_page=20`);
    if ((closed || []).some((i) => (i.body || '').includes(marker))) {
      console.log(`drift for ${short(mainSha)} was already raised and closed — not reopening`);
      return;
    }
    const issue = await gh(`/repos/${REPO}/issues`, {
      method: 'POST', body: JSON.stringify({ title: TITLE, body, labels: [LABEL] }),
    });
    console.log(`opened issue #${issue.number}`);
    return;
  }
  const comments = await gh(`/repos/${REPO}/issues/${existing.number}/comments?per_page=100`);
  const seen = (existing.body || '').includes(marker) || (comments || []).some((c) => (c.body || '').includes(marker));
  if (seen) { console.log(`issue #${existing.number} already covers ${short(mainSha)}`); return; }
  await gh(`/repos/${REPO}/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  console.log(`commented on issue #${existing.number}`);
}

async function resolveDrift(prod) {
  const existing = await openIssue();
  if (!existing) return;
  await gh(`/repos/${REPO}/issues/${existing.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: `Production caught up: running \`${prod.commit_short || short(prod.commit)}\` (booted ${prod.booted_at}), which includes the head of main. Closing.` }),
  });
  await gh(`/repos/${REPO}/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  console.log(`closed issue #${existing.number}`);
}

async function mainHead() {
  const c = await gh(`/repos/${REPO}/commits/main`);
  return { sha: c.sha, at: new Date(c.commit.committer.date) };
}

async function waitMode() {
  const target = process.env.GITHUB_SHA;
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let prod = {};
  console.log(`waiting up to ${TIMEOUT_MIN} min for ${PROD_URL} to run ${short(target)}`);
  while (Date.now() < deadline) {
    prod = await prodVersion();
    if (!prod.error && await prodContains(prod.commit, target)) {
      console.log(`deployed: production is ${prod.commit_short} (booted ${prod.booted_at})`);
      const head = await mainHead();
      if (await prodContains(prod.commit, head.sha)) await resolveDrift(prod);
      return 0;
    }
    console.log(`  production: ${prod.error || `${prod.commit_short}, booted ${prod.booted_at}`}`);
    await sleep(POLL_SECONDS * 1000);
  }
  // A newer push to main supersedes this one; its own run raises the alarm.
  const head = await mainHead();
  if (!head.sha.startsWith(target)) {
    console.log(`not deployed, but main moved on to ${short(head.sha)} — leaving it to that run`);
    return 1;
  }
  await raiseDrift({ prod, mainSha: target, reason: `Merge ${short(target)} was not deployed within ${TIMEOUT_MIN} minutes.` });
  return 1;
}

async function checkMode() {
  const head = await mainHead();
  const prod = await prodVersion();
  if (!prod.error && await prodContains(prod.commit, head.sha)) {
    console.log(`in sync: production ${prod.commit_short} includes main ${short(head.sha)}`);
    await resolveDrift(prod);
    return 0;
  }
  const ageMin = (Date.now() - head.at.getTime()) / 60_000;
  if (ageMin < GRACE_MIN) {
    console.log(`behind, but main ${short(head.sha)} is only ${ageMin.toFixed(0)} min old — within grace`);
    return 0;
  }
  await raiseDrift({ prod, mainSha: head.sha, reason: `Production has been behind main for ${ageMin.toFixed(0)} minutes.` });
  return 1;
}

(MODE === 'wait' ? waitMode() : checkMode())
  .then((code) => process.exit(code))
  .catch((e) => { console.error(e); process.exit(2); });
