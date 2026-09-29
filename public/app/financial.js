// ============================================================================
// public/app/financial.js — Financial home aggregation (Issue #6, Financial)
// ----------------------------------------------------------------------------
// PURE: raw results of existing endpoints in, what the page shows out. No
// fetching, no DOM; runs in the browser and in node (tests/test_financial_home.js).
//
// Sources (each { ok, data } | { ok:false, status?, error }):
//   edQueue       GET /api/ap/ed-queue            owner only; bills waiting on release
//   managerQueue  GET /api/ap/manager-queue       bills waiting on a manager
//   intake        GET /api/ap-intake/exceptions   admin only; bills Emma couldn't file
//   readiness     GET /api/readiness/communities  shared readiness (financial areas)
//
// Rules (Ed / ChatGPT, Issue #6):
// - No new accounting logic: tie / reconciled states come only from the
//   readiness rows (ar_control, stored recs, posted conversion).
// - A failed source is a "couldn't load" problem, never zero / clear.
// - A source the viewer's role can't see (403) is "not available to you",
//   also never counted as clear.
// - Cash coverage the server couldn't compute (operating_cash_cents null) is
//   "cash not checked", never "covered".
// ============================================================================
(function (root) {
  'use strict';

  var FIN_AREAS = [
    ['ledger', 'Ledger conversion'],
    ['ar', 'Receivables vs GL'],
    ['gl', 'General ledger'],
    ['budget', 'Budget'],
    ['bank', 'Bank rec'],
  ];
  var ACT = { error: 1, partial: 1, imported_not_reconciled: 1, in_progress: 1, not_imported: 1 };
  var LINKS = {
    release: '/ed.html',
    payables: '/#tab=ap',
    intake: '/admin/ap',
  };

  function money(cents) {
    var n = Number(cents || 0) / 100;
    var s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    return n < 0 ? '(' + s + ')' : s;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function sum(list) { return list.reduce(function (a, i) { return a + Number(i.total_cents || 0); }, 0); }

  function problemOrUnavailable(key, label, s, out) {
    if (s && !s.ok && (s.status === 403 || s.status === 401)) {
      out.unavailable.push({ key: key, label: label, message: label + ' isn’t available to your role, so it isn’t counted here.' });
      return true;
    }
    if (!s || !s.ok) {
      out.problems.push({ key: key, label: label, message: 'Couldn’t load ' + label + '. Open it directly or refresh.', error: (s && s.error) || 'not loaded' });
      return true;
    }
    return false;
  }

  function build(src, ctx) {
    src = src || {}; ctx = ctx || {};
    var out = { attention: [], unavailable: [], problems: [], matrix: [], quiet: [], counts: {} };

    // ---- approvals: owner release ------------------------------------------
    if (!problemOrUnavailable('release', 'the owner release queue', src.edQueue, out)) {
      var ed = src.edQueue.data || {};
      var inv = ed.invoices || [];
      var cash = ed.cash || [];
      cash.filter(function (c) { return c.covered === false; }).forEach(function (c) {
        out.attention.push({ key: 'cash_' + (c.community_id || c.community), rank: 5, tone: 'bad',
          title: 'Operating cash won’t cover ' + plural(c.count, 'bill') + ' · ' + money(c.pending_cents),
          detail: (c.community ? c.community + ': ' : '') + 'cash on hand ' + money(c.operating_cash_cents) + '. Decide what to release first.',
          source: 'Owner release queue', href: LINKS.release, action: 'Review' });
      });
      var unchecked = cash.filter(function (c) { return c.operating_cash_cents == null; });
      if (inv.length) {
        out.attention.push({ key: 'release', rank: 20, tone: null,
          title: 'Release ' + plural(inv.length, 'bill') + ' · ' + money(sum(inv)),
          detail: 'Manager-approved and waiting on your release' +
            (unchecked.length ? '. Cash not checked for ' + unchecked.map(function (c) { return c.community || 'one community'; }).join(', ') : '') + '.',
          source: 'Owner release queue', href: LINKS.release, action: 'Open release queue' });
      } else {
        out.quiet.push({ key: 'release', label: 'Owner release', value: 'Clear', detail: 'Nothing waiting on your release' });
      }
    }

    // ---- approvals: manager review -----------------------------------------
    if (!problemOrUnavailable('manager', 'the manager review queue', src.managerQueue, out)) {
      var mq = (src.managerQueue.data && src.managerQueue.data.invoices) || [];
      if (mq.length) {
        var comms = mq.map(function (i) { return i.community; }).filter(Boolean);
        var uniq = comms.filter(function (c, i) { return comms.indexOf(c) === i; });
        out.attention.push({ key: 'manager', rank: 30, tone: null,
          title: plural(mq.length, 'bill') + ' waiting on a manager review · ' + money(sum(mq)),
          detail: (uniq.length ? uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? ' and ' + (uniq.length - 3) + ' more' : '') + '. ' : '') + 'Approve before they can be released.',
          source: 'Manager review queue', href: LINKS.payables, action: 'Open Payables' });
      } else {
        out.quiet.push({ key: 'manager', label: 'Manager review', value: 'Clear', detail: 'No bills waiting on a manager' });
      }
    }

    // ---- intake exceptions --------------------------------------------------
    if (!problemOrUnavailable('intake', 'the bill intake exceptions', src.intake, out)) {
      var ex = (src.intake.data && src.intake.data.exceptions) || [];
      if (ex.length) {
        var oldest = ex.map(function (e) { return e.created_at; }).filter(Boolean).sort()[0];
        out.attention.push({ key: 'intake', rank: 25, tone: 'warn',
          title: plural(ex.length, 'bill') + ' Emma couldn’t file',
          detail: 'Each needs a vendor or community picked' + (oldest ? '; oldest from ' + String(oldest).slice(0, 10) : '') + '.',
          source: 'Bill intake', href: LINKS.intake, action: 'Open intake' });
      } else {
        out.quiet.push({ key: 'intake', label: 'Bill intake', value: 'Clear', detail: 'Every emailed bill was filed' });
      }
    }

    // ---- financial readiness matrix (reused readiness rows) -----------------
    if (!problemOrUnavailable('readiness', 'financial readiness', src.readiness, out)) {
      var list = (src.readiness.data && src.readiness.data.communities) || [];
      list.forEach(function (r) {
        var cells = FIN_AREAS.map(function (fa) {
          var a = (r.areas || []).find(function (x) { return x.key === fa[0]; }) || { status: 'error', summary: 'Missing from readiness.', missing: [] };
          return { key: fa[0], title: fa[1], status: a.status, summary: a.summary, missing: a.missing || [], next: a.next || null, href: a.href || null };
        });
        var acting = cells.filter(function (c) { return ACT[c.status]; });
        var allNa = cells.every(function (c) { return c.status === 'not_applicable'; });
        out.matrix.push({ community: r.community, cells: cells, needs_action: acting.length, not_applicable: allNa });
        // Errors (a failed control or read) and open conversion exceptions go on
        // the attention list; everything else stays in the matrix.
        cells.forEach(function (c) {
          var conv = c.key === 'ledger' && c.status === 'partial';
          if (c.status === 'error' || conv) {
            out.attention.push({ key: 'rd_' + r.community.id + '_' + c.key, rank: c.status === 'error' ? 10 : 15, tone: c.status === 'error' ? 'bad' : 'warn',
              title: r.community.name + ': ' + c.title.toLowerCase() + (c.status === 'error' ? ' needs attention' : ' has open exceptions'),
              detail: c.summary, source: 'Data readiness', href: c.href || ('/app/communities/' + encodeURIComponent(r.community.id)), action: 'Open' });
          }
        });
      });
      out.matrix.sort(function (a, b) {
        return (a.not_applicable - b.not_applicable) || (b.needs_action - a.needs_action) || String(a.community.name).localeCompare(String(b.community.name));
      });
      var managed = out.matrix.filter(function (m) { return !m.not_applicable; });
      out.counts.communities = managed.length;
      out.counts.not_ready = managed.filter(function (m) { return m.needs_action > 0; }).length;
      out.counts.bank_reconciled = managed.filter(function (m) { return m.cells[4].status === 'ready'; }).length;
      out.counts.bank_applicable = managed.filter(function (m) { return m.cells[4].status !== 'not_applicable'; }).length;
      // AR can only be compared once the ledger conversion is posted: "ready"
      // (ties) or "error" (differs). Unconverted = awaiting, never a miss.
      out.counts.ar_ties = managed.filter(function (m) { return m.cells[1].status === 'ready'; }).length;
      out.counts.ar_comparable = managed.filter(function (m) { return m.cells[1].status === 'ready' || m.cells[1].status === 'error'; }).length;
      out.counts.ar_awaiting = managed.filter(function (m) { return m.cells[1].status === 'imported_not_reconciled'; }).length;
    }

    out.attention.sort(function (a, b) { return a.rank - b.rank || String(a.title).localeCompare(String(b.title)); });
    var n = out.attention.length + out.problems.length;
    var words = ['Nothing needs', 'One thing needs', 'Two things need', 'Three things need', 'Four things need', 'Five things need'];
    out.headline = n === 0 ? 'Nothing needs financial attention right now.' : (words[n] || n + ' things need') + ' financial attention.';
    return out;
  }

  var api = { build: build, money: money, FIN_AREAS: FIN_AREAS, LINKS: LINKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXFinancial = api;
})(typeof window !== 'undefined' ? window : this);
