// ============================================================================
// tests/test_verify_deploy.js
// ----------------------------------------------------------------------------
// Drives scripts/verify_deploy.js run() against a simulated world: a virtual
// clock, a fake production /version (deploys land at a chosen minute) and an
// in-memory GitHub (commits, compare, issues, comments, labels). Locks:
//   - a normal 3–15 min deploy never alerts, whichever minute the 30-min
//     schedule happens to tick on
//   - repeat runs + the backstop never open a second issue or re-comment
//   - two runs racing to open the issue end with exactly one open
//   - an issue closed on purpose (held merge) is not reopened for that commit,
//     but a NEWER undeployed merge still alerts
//   - recovery closes the issue
//   - a /version blip or a GitHub 5xx is retried, not reported
// Nothing real is called. Run: node tests/test_verify_deploy.js
// ============================================================================

const { run, LABEL } = require('../scripts/verify_deploy');

let passed = 0, failed = 0;
const ok = (cond, msg, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}${extra ? `  — ${JSON.stringify(extra)}` : ''}`); }
};

const MIN = 60000;
const T0 = Date.parse('2026-10-21T14:00:00Z');
const sha = (n) => (n.toString(16).padStart(2, '0') + 'c0ffee').repeat(5).slice(0, 40);

// --------------------------------------------------------------------------
// The world: linear main history, a deploy schedule, and GitHub issues.
// --------------------------------------------------------------------------
function world() {
  const w = {
    commits: [{ sha: sha(1), at: T0 - 120 * MIN, msg: 'base' }],
    deploys: [{ at: -Infinity, sha: sha(1) }], // production runs the latest deploy with at <= clock
    versionDown: [],                           // [from, to) windows where /version errors
    gh5xx: 0,                                  // next N GitHub calls fail with 502
    issues: [],
    calls: { versionErrors: 0, gh5xx: 0 },
  };
  w.merge = (n, at) => { w.commits.push({ sha: sha(n), at, msg: `Merge pull request #${n}` }); return sha(n); };
  w.deploy = (s, at) => { w.deploys.push({ at, sha: s }); w.deploys.sort((a, b) => a.at - b.at); };
  w.idx = (s) => w.commits.findIndex((c) => c.sha.startsWith(s));
  w.prodAt = (t) => [...w.deploys].reverse().find((d) => d.at <= t).sha;
  w.headAt = (t) => [...w.commits].filter((c) => c.at <= t).pop();
  w.open = () => w.issues.filter((i) => i.state === 'open');
  return w;
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// A fetch bound to one run's clock.
function fakeFetch(w, clock) {
  return async (url, opts = {}) => {
    await new Promise((r) => setImmediate(r)); // let concurrent runs interleave
    const t = clock.t;
    const method = opts.method || 'GET';
    if (url.startsWith('https://prod.test/version')) {
      if (w.versionDown.some(([a, b]) => t >= a && t < b)) { w.calls.versionErrors++; return json(503, { error: 'down' }); }
      const s = w.prodAt(t);
      return json(200, { commit: s, commit_short: s.slice(0, 7), booted_at: new Date(t).toISOString() });
    }
    const p = url.replace('https://api.github.com/repos/o/r', '');
    if (w.gh5xx > 0) { w.gh5xx--; w.calls.gh5xx++; return json(502, { message: 'bad gateway' }); }
    let m;
    if (p === '/commits/main') {
      const h = w.headAt(t);
      return json(200, { sha: h.sha, commit: { committer: { date: new Date(h.at).toISOString() } } });
    }
    if ((m = p.match(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
      const a = w.idx(m[1]), b = w.idx(m[2]);
      if (a < 0 || b < 0) return json(404, {});
      return json(200, { status: a === b ? 'identical' : b > a ? 'ahead' : 'behind', commits: b > a ? w.commits.slice(a + 1, b + 1).map((c) => ({ sha: c.sha, commit: { message: c.msg } })) : [] });
    }
    if (p === '/labels' && method === 'POST') return json(201, {});
    if (p.startsWith('/issues?')) {
      const q = new URLSearchParams(p.split('?')[1]);
      const list = w.issues.filter((i) => i.state === q.get('state') && i.labels.includes(q.get('labels')));
      return json(200, list.map((i) => ({ number: i.number, state: i.state, state_reason: i.state_reason, body: i.body, comments: i.comments.length })));
    }
    if (p === '/issues' && method === 'POST') {
      const b = JSON.parse(opts.body);
      const issue = { number: w.issues.length + 1, state: 'open', state_reason: null, title: b.title, body: b.body, labels: b.labels, comments: [], openedAt: t };
      w.issues.push(issue);
      return json(201, { number: issue.number });
    }
    if ((m = p.match(/^\/issues\/(\d+)\/comments/))) {
      const issue = w.issues[Number(m[1]) - 1];
      if (method === 'POST') { issue.comments.push(JSON.parse(opts.body).body); return json(201, {}); }
      return json(200, issue.comments.map((body) => ({ body })));
    }
    if ((m = p.match(/^\/issues\/(\d+)$/)) && method === 'PATCH') {
      Object.assign(w.issues[Number(m[1]) - 1], JSON.parse(opts.body));
      return json(200, {});
    }
    throw new Error(`fake GitHub: unhandled ${method} ${p}`);
  };
}

// Run one job starting at time `at`; sleeps advance its own clock.
async function job(w, mode, at, extraEnv = {}) {
  const clock = { t: at };
  const logs = [];
  const res = await run(mode, {
    env: { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'x', PROD_URL: 'https://prod.test', ...extraEnv },
    fetch: fakeFetch(w, clock),
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    log: (s) => logs.push(s),
  });
  return { ...res, endedAt: clock.t, logs };
}
const ticks = (from, to, phase) => { const out = []; for (let t = from + phase * MIN; t <= to; t += 30 * MIN) out.push(t); return out; };

(async () => {
  // ------------------------------------------------------------------------
  console.log('\nnormal deploys (3–15 min) never alert');
  {
    let alerts = 0, failedRuns = 0, runs = 0, worst = null;
    for (let d = 3; d <= 15; d++) {
      for (let phase = 0; phase < 30; phase++) {
        const w = world();
        const s = w.merge(2, T0);
        w.deploy(s, T0 + d * MIN);
        const results = [await job(w, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: s })];
        for (const t of ticks(T0 - 30 * MIN, T0 + 120 * MIN, phase)) results.push(await job(w, 'check', t));
        runs += results.length;
        failedRuns += results.filter((r) => r.code !== 0).length;
        alerts += w.issues.length;
        if (w.issues.length && !worst) worst = { d, phase };
      }
    }
    ok(alerts === 0, `13 deploy durations × 30 schedule phases (${runs} runs): 0 issues opened`, worst);
    ok(failedRuns === 0, 'and 0 failed runs (no failed-run emails)');
  }
  {
    const w = world(); const s = w.merge(2, T0); w.deploy(s, T0 + 19 * MIN);
    const r = await job(w, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: s });
    ok(r.code === 0 && w.issues.length === 0, 'a slow 19-min deploy still passes the 20-min wait', r.outcome);
    const c = await job(w, 'check', T0 + 29 * MIN);
    ok(c.outcome === 'in-sync', 'backstop at minute 29 finds it in sync');
  }

  // ------------------------------------------------------------------------
  console.log('\na missed deploy: one issue, no duplicates, no re-comments');
  {
    const w = world(); const s = w.merge(2, T0);   // never deployed
    const r = await job(w, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: s });
    ok(r.code === 1 && r.outcome === 'opened' && w.issues.length === 1, `wait run times out at ~20 min → opens issue #1 and fails once (ended at +${Math.round((r.endedAt - T0) / MIN)} min)`, r.outcome);
    ok(/Not yet in production:\n- `[0-9a-f]{7}` Merge pull request #2/.test(w.issues[0].body), 'issue lists the undeployed commit and the Render click-path', w.issues[0].body.slice(0, 200));
    const codes = [];
    for (const t of ticks(T0 + 30 * MIN, T0 + 24 * 60 * MIN, 0)) codes.push((await job(w, 'check', t)).code);
    ok(w.issues.length === 1 && w.open().length === 1, `${codes.length} backstop runs over 24 h → still exactly 1 issue`);
    ok(w.issues[0].comments.length === 0, 'and no repeat comments');
    ok(codes.every((c) => c === 0), 'and none of those runs fails (already reported → no email every 30 min)');
    const again = await job(w, 'wait', T0 + 2 * MIN, { GITHUB_SHA: s });
    ok(again.outcome === 'already' && w.issues.length === 1, 're-running the push job adds nothing', again.outcome);

    const s3 = w.merge(3, T0 + 25 * 60 * MIN);
    const r3 = await job(w, 'wait', T0 + 25 * 60 * MIN + 0.5 * MIN, { GITHUB_SHA: s3 });
    ok(r3.outcome === 'commented' && w.issues.length === 1 && w.issues[0].comments.length === 1, 'a NEWER undeployed merge adds exactly one comment to the open issue', r3.outcome);
    for (const t of ticks(T0 + 26 * 60 * MIN, T0 + 30 * 60 * MIN, 0)) await job(w, 'check', t);
    ok(w.issues[0].comments.length === 1, 'and later backstop runs don\'t repeat it');
  }

  // ------------------------------------------------------------------------
  console.log('\nrace: two runs open the issue at the same moment');
  {
    const w = world(); const s = w.merge(2, T0);
    const [a, b] = await Promise.all([job(w, 'check', T0 + 31 * MIN), job(w, 'wait', T0 + 11 * MIN, { GITHUB_SHA: s, DEPLOY_TIMEOUT_MIN: '20' })]);
    ok(w.open().length === 1, `exactly one issue left open (created ${w.issues.length}; outcomes ${a.outcome}/${b.outcome})`);
    const dup = w.issues.find((i) => i.state_reason === 'duplicate');
    ok(w.issues.length === 1 || (dup && dup.number > w.open()[0].number), 'a racing duplicate (if any) is the newer one, closed as duplicate');
    const later = await job(w, 'check', T0 + 61 * MIN);
    ok(later.outcome === 'already' && w.open().length === 1, 'the next backstop sees the survivor, not the duplicate', later.outcome);
  }
  {
    // Force the race deterministically: both runs list open issues before either creates.
    const w = world(); const s = w.merge(2, T0);
    const r = await Promise.all([job(w, 'check', T0 + 31 * MIN), job(w, 'check', T0 + 31 * MIN)]);
    ok(w.issues.length === 2 && w.open().length === 1 && w.issues[1].state_reason === 'duplicate', `forced race: 2 created → #2 closed as duplicate, #1 open (${r.map((x) => x.outcome).join('/')})`, w.issues.map((i) => [i.number, i.state, i.state_reason]));
    const after = await job(w, 'check', T0 + 61 * MIN);
    ok(after.outcome === 'already', 'duplicate closure is not mistaken for a deliberate hold', after.outcome);
  }

  // ------------------------------------------------------------------------
  console.log('\nheld merge (issue closed on purpose, like #247)');
  {
    const w = world(); const held = w.merge(247, T0);
    await job(w, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: held });
    Object.assign(w.issues[0], { state: 'closed', state_reason: 'completed' }); // Ed closes it
    const codes = [];
    for (const t of ticks(T0 + 30 * MIN, T0 + 3 * 24 * 60 * MIN, 7)) codes.push(await job(w, 'check', t));
    ok(w.issues.length === 1 && w.open().length === 0, `${codes.length} backstop runs over 3 days → not reopened, no new issue`);
    ok(codes.every((r) => r.code === 0 && r.outcome === 'held'), 'every one exits 0 (no failed-run emails while held)');
    const rerun = await job(w, 'wait', T0 + 1 * MIN, { GITHUB_SHA: held });
    ok(rerun.code === 0 && rerun.outcome === 'held' && w.issues.length === 1, 're-running the held merge\'s push job stays quiet', rerun.outcome);

    // Ed closed it after it had a comment for a second held commit: both stay held.
    const w2 = world(); const x = w2.merge(2, T0);
    await job(w2, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: x });
    const y = w2.merge(3, T0 + 60 * MIN);
    await job(w2, 'wait', T0 + 60.5 * MIN, { GITHUB_SHA: y });
    Object.assign(w2.issues[0], { state: 'closed', state_reason: 'not_planned' });
    const r2 = await job(w2, 'check', T0 + 120 * MIN);
    ok(r2.outcome === 'held' && w2.issues.length === 1, 'a commit mentioned only in a comment of the closed issue is also held', r2.outcome);

    const newer = w.merge(250, T0 + 4 * 24 * 60 * MIN);
    const rn = await job(w, 'wait', T0 + 4 * 24 * 60 * MIN + 0.5 * MIN, { GITHUB_SHA: newer });
    ok(rn.code === 1 && rn.outcome === 'opened' && w.open().length === 1 && w.issues.length === 2, 'a NEWER undeployed merge on top of the held one still alerts (new issue #2)', rn.outcome);
  }

  // ------------------------------------------------------------------------
  console.log('\nrecovery closes the issue');
  {
    const w = world(); const s = w.merge(2, T0);
    await job(w, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: s });
    w.deploy(s, T0 + 45 * MIN); // Ed deploys by hand
    const r = await job(w, 'check', T0 + 60 * MIN);
    ok(r.outcome === 'resolved' && w.issues[0].state === 'closed' && w.issues[0].state_reason === 'completed', 'backstop sees production caught up → comments + closes', r.outcome);
    ok(/Production caught up/.test(w.issues[0].comments.slice(-1)[0] || ''), 'with a "caught up" comment');
    const again = await job(w, 'check', T0 + 90 * MIN);
    ok(again.outcome === 'in-sync' && w.issues.length === 1, 'next run: nothing to do');

    const s2 = w.merge(3, T0 + 120 * MIN); // later drift for a new commit
    const r2 = await job(w, 'wait', T0 + 120.5 * MIN, { GITHUB_SHA: s2 });
    ok(r2.outcome === 'opened' && w.open().length === 1, 'a later missed deploy opens a fresh issue (a recovered issue is not a "hold")', r2.outcome);

    const w3 = world(); const s3 = w3.merge(2, T0);
    await job(w3, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: s3 });
    const s4 = w3.merge(3, T0 + 60 * MIN); w3.deploy(s4, T0 + 65 * MIN);
    const r3 = await job(w3, 'wait', T0 + 60.5 * MIN, { GITHUB_SHA: s4 });
    ok(r3.outcome === 'deployed' && w3.issues[0].state === 'closed', 'a later merge that deploys (and contains the missed one) closes it from the push job', r3.outcome);
    const w5 = world(); const r5s = w5.merge(2, T0);
    await job(w5, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: r5s });
    w5.deploy(r5s, T0 + 40 * MIN);
    await job(w5, 'check', T0 + 60 * MIN);            // recovered → closed by the script
    w5.deploy(sha(1), T0 + 90 * MIN);                 // later rolled back below it
    const rb = await job(w5, 'check', T0 + 120 * MIN);
    ok(rb.outcome === 'opened' && w5.open().length === 1, 'a rollback below a previously recovered commit alerts again (recovery close is not a hold)', rb.outcome);
    const w4 = world(); const a = w4.merge(2, T0); const b = w4.merge(3, T0 + 5 * MIN); w4.deploy(b, T0 + 9 * MIN);
    const ra = await job(w4, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: a });
    ok(ra.outcome === 'deployed' && w4.issues.length === 0, 'a merge that ships inside a later deploy counts as deployed', ra.outcome);
  }

  // ------------------------------------------------------------------------
  console.log('\nblips and superseded runs');
  {
    const w = world(); const s = w.merge(2, T0); w.deploy(s, T0 + 5 * MIN);
    w.versionDown.push([T0 + 60 * MIN, T0 + 60.5 * MIN]);
    const r = await job(w, 'check', T0 + 60 * MIN);
    ok(r.outcome === 'in-sync' && w.issues.length === 0 && w.calls.versionErrors >= 1, `/version down for 30 s at the tick → retried, in sync, no issue (${w.calls.versionErrors} error seen)`, r.outcome);
    w.versionDown.push([T0 + 120 * MIN, T0 + 200 * MIN]);
    const down = await job(w, 'check', T0 + 120 * MIN);
    ok(down.outcome === 'opened' && /unreachable \(HTTP 503\)/.test(w.issues[0].body), 'a real outage (still down after retries) does alert, saying "unreachable"', down.outcome);

    const w2 = world(); const s2 = w2.merge(2, T0); w2.deploy(s2, T0 + 4 * MIN);
    w2.gh5xx = 2;
    const r2 = await job(w2, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: s2 });
    ok(r2.code === 0 && w2.calls.gh5xx === 2 && w2.issues.length === 0, 'two GitHub 502s are retried, run passes', r2.outcome);

    const w3 = world(); const a = w3.merge(2, T0); w3.merge(3, T0 + 10 * MIN);
    const r3 = await job(w3, 'wait', T0 + 0.5 * MIN, { GITHUB_SHA: a });
    ok(r3.code === 0 && r3.outcome === 'superseded' && w3.issues.length === 0, 'an older merge\'s run that times out after main moved on defers to the newer run (exit 0, no issue)', r3.outcome);
  }

  {
    // Supply chain (Ed 2026-10-21): every third-party action is pinned to an immutable
    // 40-character commit hash, never a moving tag like @v4; and the job token is minimal.
    const fs = require('fs'); const path = require('path');
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'deploy-verify.yml'), 'utf8');
    const uses = [...wf.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1]);
    ok(uses.length > 0 && uses.every((u) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u)), `all ${uses.length} actions pinned to commit hashes`, uses.join(', '));
    const perms = ((wf.match(/^permissions:\r?\n((?:[ \t]+\S.*\r?\n)+)/m) || [])[1] || '').trim().split(/\r?\n/).map((l) => l.trim());
    ok(perms.length === 2 && perms.includes('contents: read') && perms.includes('issues: write'), 'job token permissions are exactly contents: read + issues: write', perms.join(' | '));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
