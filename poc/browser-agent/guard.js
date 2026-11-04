// poc/browser-agent/guard.js — the safety and evidence layer every agent browser run goes
// through. A skill never touches the page directly; it asks the guard, and the guard enforces:
//   1. HOST ALLOWLIST at the network layer: any request to another host is aborted and logged
//      (a link, a redirect, an injected script, a tracker). The page cannot take the agent elsewhere.
//   2. FORBIDDEN ACTIONS: a click or submit whose visible label matches a forbidden pattern
//      (delete, approve, pay, transfer, wire, ACH, stop payment, return...) is refused, logged and
//      escalated, whatever the skill asked for.
//   3. NO INSTRUCTIONS FROM PAGES: page text is data. Directive text aimed at an agent is
//      detected, recorded as suspicious and never acted on (the skill's steps are fixed code).
//   4. SECRETS never reach the log, a screenshot caption or a model: typed values marked secret
//      are masked in the audit trail.
//   5. EVIDENCE: every step is appended to steps.jsonl with time, URL and result, with a
//      screenshot; every downloaded or uploaded file is stored with its SHA-256.
//   6. HUMAN-ONLY GATES (MFA, a decision): the run stops with status needs_human and says why.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORBIDDEN = /\b(delete|remove all|approve|approval|pay\b|payment|transfer|wire|ach\b|stop payment|return item|decision|authorize|sign (?:the )?agreement|accept terms)\b/i;
const DIRECTIVE = /\b(ignore (?:your|all|previous) instructions|ai agents?|as an ai|system notice)\b/i;

function createGuard({ page, allowHosts, runDir, skill }) {
  fs.mkdirSync(path.join(runDir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'files'), { recursive: true });
  const log = path.join(runDir, 'steps.jsonl');
  const allowed = new Set(allowHosts.map((h) => h.toLowerCase()));
  let n = 0; const blocked = []; const suspicious = []; const evidence = [];

  const record = async (step, data = {}) => {
    n += 1; const shot = `shots/${String(n).padStart(2, '0')}-${step.replace(/[^a-z0-9]+/gi, '-')}.png`;
    try { await page.screenshot({ path: path.join(runDir, shot), fullPage: true }); } catch (_) {}
    fs.appendFileSync(log, JSON.stringify({ n, at: new Date().toISOString(), skill, step, url: page.url(), shot, ...data }) + '\n');
  };
  class Stop extends Error { constructor(status, reason) { super(reason); this.status = status; this.reason = reason; } }

  return {
    Stop, blocked, suspicious, evidence, record,
    async start() {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        let host = ''; try { host = new URL(req.url()).host.toLowerCase(); } catch (_) {}
        if (req.url().startsWith('data:') || allowed.has(host)) return req.continue();
        blocked.push({ kind: 'host', url: req.url() });
        fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), skill, step: 'blocked_request', url: req.url() }) + '\n');
        req.abort('blockedbyclient');
      });
    },
    async goto(url, step) {
      const host = new URL(url).host.toLowerCase();
      if (!allowed.has(host)) { blocked.push({ kind: 'navigation', url }); await record(step, { result: 'blocked_host', target: url }); throw new Stop('blocked', `navigation to ${host} is not on the allowlist`); }
      await page.goto(url, { waitUntil: 'domcontentloaded' }); await this.scan(step); await record(step, { result: 'ok' });
    },
    async type(selector, value, { secret = false, step }) {
      await page.type(selector, value); await record(step, { action: 'type', selector, value: secret ? '••••••' : value });
    },
    // Click only through here. The label is read from the live page, not trusted from the skill.
    async click(selector, step, { navigates = true } = {}) {
      const label = await page.$eval(selector, (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).catch(() => null);
      if (label == null) { await record(step, { result: 'missing_element', selector }); throw new Stop('failed', `expected control ${selector} not found (page changed?)`); }
      if (FORBIDDEN.test(label)) { blocked.push({ kind: 'action', selector, label }); await record(step, { result: 'blocked_action', selector, label }); throw new Stop('needs_human', `"${label}" is a human-only action; the agent will not click it`); }
      if (navigates) await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), page.click(selector)]);
      else await page.click(selector);
      await this.scan(step); await record(step, { action: 'click', selector, label });
    },
    // Page text is data. Anything addressed to an agent is flagged and never followed.
    async scan(step) {
      const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      for (const line of text.split('\n')) if (DIRECTIVE.test(line)) { suspicious.push({ step, url: page.url(), text: line.trim().slice(0, 200) }); }
    },
    keepFile(name, buffer, step, kind) {
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      fs.writeFileSync(path.join(runDir, 'files', name), buffer); evidence.push({ kind, name, bytes: buffer.length, sha256, step });
      return sha256;
    },
  };
}

module.exports = { createGuard, FORBIDDEN, DIRECTIVE };
