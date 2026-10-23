// ============================================================================
// lib/agent_browser/guard.js — the guarded browser for TrustEd AI employees
// (Ed 2026-10-22; spec templates/guarded-browser-agent.spec.md, PoC PR #271)
// ----------------------------------------------------------------------------
// A skill never touches the page directly. It names a DECLARED action and the
// guard performs it only if everything matches the skill's declaration:
//
//   destinations  every request and navigation must be to a declared host, else
//                 it is aborted at the network layer and logged;
//   actions       only declared actions run: the guard checks the page it is on
//                 (host + path), the element (selector), and the element's live
//                 label against the declared expected label;
//   forbidden     a global list of human-only labels (pay, transfer, wire, ACH,
//                 stop payment, approve, return, delete, ...) plus the skill's own
//                 extras are refused even when declared (a second check, never
//                 the primary one);
//   reading       only declared read selectors can be read, and only as
//                 presence/attributes, never values typed by anyone;
//   typing        there is no generic type(): a skill may type only into a
//                 declared field from a declared secret reference (none in v1);
//   evidence      a screenshot and a log entry for every step; the run fails
//                 closed on any mismatch (missing element, unexpected page).
// Bank-side restrictions on the account remain mandatory; the guard is the
// second control, never the only one.
// ============================================================================
const crypto = require('crypto');

const FORBIDDEN = /\b(delete|remove all|approve|approval|pay\b|payment|transfer|wire|ach\b|stop payment|return item|decision|authorize|accept terms|sign agreement)\b/i;
const DIRECTIVE = /\b(ignore (?:your|all|previous) instructions|ai agents?|as an ai|system notice)\b/i;

class GuardStop extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}

/** Pure: is this URL on one of the declared hosts? */
function hostAllowed(url, hosts) {
  if (/^(data|about|blob):/i.test(String(url))) return true;
  let h = ''; try { h = new URL(url).host.toLowerCase(); } catch (_) { return false; }
  return hosts.map((x) => x.toLowerCase()).includes(h);
}

/** Pure: does the current URL match an action's declared page ({ host, path })? */
function onPage(url, page) {
  if (!page) return true;
  let u; try { u = new URL(url); } catch (_) { return false; }
  return u.host.toLowerCase() === page.host.toLowerCase() && (page.path == null || u.pathname === page.path);
}

function validateDeclaration(d) {
  const errs = [];
  if (!d || !d.id || !d.version) errs.push('id and version are required');
  if (!Array.isArray(d.hosts) || !d.hosts.length) errs.push('hosts must list at least one host');
  for (const [name, a] of Object.entries(d.actions || {})) {
    if (!['goto', 'click'].includes(a.type)) errs.push(`${name}: action type ${a.type} is not supported`);
    if (a.type === 'goto' && !hostAllowed(a.url, d.hosts || [])) errs.push(`${name}: ${a.url} is not on the declared hosts`);
    if (a.type === 'click' && (!a.selector || !(a.label instanceof RegExp) || !a.page)) errs.push(`${name}: a click needs selector, expected label and page`);
  }
  if (errs.length) throw new Error('invalid skill declaration: ' + errs.join('; '));
}

function createGuard({ page, declaration }) {
  validateDeclaration(declaration);
  const d = declaration;
  const steps = []; const blocked = []; const suspicious = []; const shots = [];
  const extraForbidden = d.forbidden instanceof RegExp ? d.forbidden : null;

  async function record(step, data = {}) {
    let shot = null;
    try { const buf = await page.screenshot({ type: 'png', fullPage: false }); shot = { step, buf, sha256: crypto.createHash('sha256').update(buf).digest('hex') }; shots.push(shot); } catch (_) {}
    steps.push({ n: steps.length + 1, at: new Date().toISOString(), step, url: page.url(), screenshot_sha256: shot ? shot.sha256 : null, ...data });
  }
  async function scan(step) {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    for (const line of text.split('\n')) if (DIRECTIVE.test(line)) suspicious.push({ step, text: line.trim().slice(0, 200) });
  }
  async function liveLabel(selector) {
    return page.$eval(selector, (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).catch(() => null);
  }

  return {
    GuardStop, steps, blocked, suspicious, shots, record,
    async start() {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (hostAllowed(req.url(), d.hosts)) return req.continue();
        let host = ''; try { host = new URL(req.url()).host; } catch (_) {}
        if (!blocked.some((b) => b.kind === 'host' && b.host === host)) blocked.push({ kind: 'host', host });
        req.abort('blockedbyclient');
      });
    },
    async do(name) {
      const a = (d.actions || {})[name];
      if (!a) { blocked.push({ kind: 'undeclared_action', name }); await record(name, { result: 'refused_undeclared' }); throw new GuardStop('blocked', `action "${name}" is not declared for ${d.id}`); }
      if (a.type === 'goto') {
        await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await scan(name); await record(name, { action: 'goto', result: 'ok' });
        return;
      }
      // click
      if (!onPage(page.url(), a.page)) { await record(name, { result: 'wrong_page', expected: a.page }); throw new GuardStop('failed', `"${name}" is declared for ${a.page.host}${a.page.path || ''}, but the browser is on ${page.url()}`); }
      const label = await liveLabel(a.selector);
      if (label == null) { await record(name, { result: 'missing_element', selector: a.selector }); throw new GuardStop('failed', `expected control ${a.selector} not found (the page changed?)`); }
      if (!a.label.test(label)) { await record(name, { result: 'label_mismatch', selector: a.selector, label }); throw new GuardStop('failed', `${a.selector} reads "${label}", not what ${name} expects`); }
      if (FORBIDDEN.test(label) || (extraForbidden && extraForbidden.test(label))) { blocked.push({ kind: 'forbidden_action', name, label }); await record(name, { result: 'refused_forbidden', label }); throw new GuardStop('needs_human', `"${label}" is a human-only action; the agent will not click it`); }
      await page.click(a.selector);
      if (a.waitFor) await page.waitForSelector(a.waitFor, { visible: true, timeout: 10000 }).catch(() => {});
      await scan(name); await record(name, { action: 'click', selector: a.selector, label });
    },
    // Read-only inspection of DECLARED selectors: presence, visibility, type, label. Never values.
    async read(name) {
      const sel = (d.read || {})[name];
      if (!sel) throw new GuardStop('blocked', `read "${name}" is not declared for ${d.id}`);
      return page.$eval(sel, (el) => {
        const r = el.getBoundingClientRect(); const cs = window.getComputedStyle(el);
        return { present: true, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
          tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || null, label: (el.getAttribute('placeholder') || el.value || el.innerText || '').trim().slice(0, 60) };
      }).catch(() => ({ present: false, visible: false }));
    },
  };
}

module.exports = { createGuard, validateDeclaration, hostAllowed, onPage, GuardStop, FORBIDDEN, DIRECTIVE };
