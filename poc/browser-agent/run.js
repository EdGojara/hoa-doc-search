#!/usr/bin/env node
// poc/browser-agent/run.js — proof of concept: an AI employee runs a portal workflow unattended,
// with no person watching the browser, and reports back with evidence.
//
// The skill (fixed, reviewable steps; the shape of Kat's eventual NewFirst work):
//   sign in -> stop for a human at MFA -> read the report list -> download the latest report ->
//   reconcile it against our register -> upload our file -> capture the confirmation ->
//   verify the upload appears in the portal's own history -> report.
// Then the guard self-test: the page's destructive button and an off-allowlist link are both
// refused, and the instruction planted in the page is flagged, never followed.
//
//   node poc/browser-agent/run.js            (MFA off: the full workflow)
//   node poc/browser-agent/run.js --mfa      (MFA on: the run stops and escalates)
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { createPortal } = require('./mock_portal');
const { createGuard } = require('./guard');
const FIX = require('./fixtures.json');

const MFA = process.argv.includes('--mfa');
const PORT = 4599; const BASE = `http://127.0.0.1:${PORT}`;

async function skill(g, page, out) {
  await g.goto(`${BASE}/login`, 'open_sign_in');
  await g.type('#user', FIX.user, { step: 'enter_user' });
  await g.type('#pass', FIX.pass, { secret: true, step: 'enter_password' });
  await g.click('#signin', 'sign_in');
  if (new URL(page.url()).pathname === '/mfa') { await g.record('mfa_challenge', { result: 'needs_human' }); throw new g.Stop('needs_human', 'the portal asked for an MFA code; a person must complete it (the agent never bypasses MFA)'); }

  await g.click('#nav-reports', 'open_reports');
  const reports = await page.$$eval('#reports tr', (rows) => rows.slice(1).map((r) => { const c = r.querySelectorAll('td'); return { date: c[0].innerText, name: c[1].innerText, href: c[2].querySelector('a').getAttribute('href') }; }));
  const latest = reports.sort((a, b) => b.date.localeCompare(a.date))[0];
  // Download through the signed-in session (same cookies), then keep it with its hash.
  const csv = await page.evaluate(async (href) => (await fetch(href, { credentials: 'same-origin' })).text(), latest.href);
  out.download = { name: latest.name, sha256: g.keepFile(path.basename(latest.href), Buffer.from(csv), 'download_report', 'downloaded') };
  await g.record('download_report', { result: 'ok', file: latest.href, sha256: out.download.sha256 });

  // Reconcile: what the portal shows vs our register (deterministic code, no model).
  const portal = csv.trim().split('\n').slice(1).map((l) => { const [item, , amount] = l.split(','); return { item, amount }; });
  const reg = new Map(FIX.register.map((r) => [r.item, r.amount]));
  out.reconciliation = {
    matched: portal.filter((p) => reg.get(p.item) === p.amount).map((p) => p.item),
    in_portal_not_in_register: portal.filter((p) => !reg.has(p.item)).map((p) => `${p.item} $${p.amount}`),
    amount_differs: portal.filter((p) => reg.has(p.item) && reg.get(p.item) !== p.amount).map((p) => `${p.item}: portal $${p.amount}, register $${reg.get(p.item)}`),
    in_register_not_in_portal: FIX.register.filter((r) => !portal.some((p) => p.item === r.item)).map((r) => `${r.item} $${r.amount}`),
  };

  // Upload our file and capture the portal's confirmation.
  const file = 'item,amount\n' + FIX.register.map((r) => `${r.item},${r.amount}`).join('\n') + '\n';
  const upPath = path.join(out.runDir, 'files', 'upload.csv'); out.upload = { sha256: g.keepFile('upload.csv', Buffer.from(file), 'upload_file', 'uploaded'), records: FIX.register.length };
  await g.goto(`${BASE}/upload`, 'open_upload');
  const input = await page.$('#file'); await input.uploadFile(upPath);
  await g.record('choose_file', { action: 'upload', file: 'upload.csv', sha256: out.upload.sha256 });
  await g.click('#submit-upload', 'submit_upload');
  const conf = await page.$eval('#conf', (el) => el.innerText).catch(() => null);
  if (!conf) { await g.record('upload_result', { result: 'not_accepted' }); throw new g.Stop('failed', 'the portal did not confirm the upload'); }
  out.upload.confirmation = conf;
  // Accepted means the portal's OWN record shows it, not just a success page.
  await g.goto(`${BASE}/uploads`, 'verify_in_history');
  const hist = await page.$$eval('#history tr', (rows) => rows.map((r) => ({ conf: r.querySelector('.conf').innerText, records: Number(r.querySelector('.records').innerText) })));
  const seen = hist.find((h) => h.conf === conf);
  out.upload.verified = !!seen && seen.records === out.upload.records;
  await g.record('verify_in_history', { result: out.upload.verified ? 'verified' : 'mismatch', confirmation: conf });
  await g.goto(`${BASE}/home`, 'return_home');
}

async function guardSelfTest(g) {
  const results = [];
  for (const [name, fn] of [['destructive button', () => g.click('#delete-all', 'try_delete_all')], ['off-allowlist link', () => g.goto('https://example.com/help', 'try_external_link')]]) {
    try { await fn(); results.push({ test: name, outcome: 'NOT BLOCKED' }); }
    catch (e) { results.push({ test: name, outcome: e.status === 'needs_human' || e.status === 'blocked' ? `refused: ${e.reason}` : `error: ${e.message}` }); }
  }
  return results;
}

(async () => {
  const runDir = path.join(__dirname, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + (MFA ? '-mfa' : ''));
  const portal = createPortal({ mfa: MFA }); const srv = portal.app.listen(PORT, '127.0.0.1');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const g = createGuard({ page, allowHosts: [`127.0.0.1:${PORT}`], runDir, skill: 'document_exchange.v1' });
  await g.start();
  const out = { runDir, skill: 'document_exchange.v1', started_at: new Date().toISOString(), status: 'running' };
  try { await skill(g, page, out); out.status = 'completed'; }
  catch (e) { out.status = e.status || 'failed'; out.stopped_because = e.reason || e.message; }
  if (out.status === 'completed') out.guard_self_test = await guardSelfTest(g);
  out.portal_state_after = { documents_deleted: portal.state().deleted, uploads: portal.state().uploads.length };
  out.blocked = g.blocked; out.suspicious_page_text = g.suspicious; out.evidence = g.evidence; out.finished_at = new Date().toISOString();
  await browser.close(); srv.close();

  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(out, null, 2));
  const r = out.reconciliation;
  const md = [`# ${out.skill}: ${out.status}`, '',
    out.stopped_because ? `**Stopped:** ${out.stopped_because}` : '',
    out.download ? `- Downloaded **${out.download.name}** (sha256 ${out.download.sha256.slice(0, 12)}…)` : '',
    r ? `- Reconciliation: ${r.matched.length} matched; in portal not in register: ${r.in_portal_not_in_register.join(', ') || 'none'}; amount differs: ${r.amount_differs.join(', ') || 'none'}; in register not yet in portal: ${r.in_register_not_in_portal.join(', ') || 'none'}` : '',
    out.upload && out.upload.confirmation ? `- Uploaded ${out.upload.records} records, confirmation **${out.upload.confirmation}**, ${out.upload.verified ? 'verified in the portal\'s own history' : 'NOT verified in history'}` : '',
    ...(out.guard_self_test || []).map((t) => `- Guard: ${t.test}: ${t.outcome}`),
    out.suspicious_page_text.length ? `- Ignored ${out.suspicious_page_text.length} instruction(s) planted in the page: "${out.suspicious_page_text[0].text}"` : '',
    `- Portal after the run: documents deleted = ${out.portal_state_after.documents_deleted}`,
    `- Evidence: ${fs.readdirSync(path.join(runDir, 'shots')).length} screenshots, steps.jsonl, ${out.evidence.length} files with SHA-256`,
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(runDir, 'report.md'), md + '\n');
  console.log(md); console.log('\nrun folder:', runDir);
  process.exit(out.status === 'completed' || (MFA && out.status === 'needs_human') ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
