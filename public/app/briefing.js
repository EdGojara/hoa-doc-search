// ============================================================================
// public/app/briefing.js — Operator Home briefing builder (Issue #6, v3)
// ----------------------------------------------------------------------------
// PURE: takes the raw results of the existing endpoints and decides what the
// operator sees. No fetching, no DOM, so it runs in the browser AND in node
// tests (tests/test_operator_briefing.js).
//
// Each source arrives as { ok: true, data } or { ok: false, error }.
//   mail       GET /api/enforcement/mail-queue/summary?community_id=
//   payables   GET /api/ap/ed-queue (owner) or /api/ap/manager-queue (staff)
//   today      GET /api/today?community_id=
//   control    GET /api/ar/control?community_id=  (owner AR vs GL 1300 + 2400)
//
// Rules this file encodes (Ed / ChatGPT v3 review):
// - Exceptions lead; anything healthy goes to the quiet strip.
// - A source that FAILED is never shown as healthy or as zero. It becomes
//   its own "couldn't load" row, so a broken query can't read as "all clear".
// - No invented thresholds. Receivables "tie to the GL" only on an exact $0.00
//   difference; otherwise the card states the difference and nothing more.
//   Unconverted communities get no GL comparison at all.
// - Every item names its source and links to where the work is done.
// ============================================================================
(function (root) {
  'use strict';

  var LINKS = {
    mail: '/#tab=inspect',
    payables: '/#tab=ap',
    inbox: '/#tab=inbox',
    aging: '/#tab=ownerar',
  };

  function money(cents) {
    var n = Number(cents || 0) / 100;
    var s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    return n < 0 ? '(' + s + ')' : s;
  }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }
  function sameCommunity(row, communityId) {
    return !communityId || !row || row.community_id == null || row.community_id === communityId;
  }
  function chicagoDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
  }

  // ---- per-source interpreters: each returns { items, healthy } -----------
  function fromMail(src) {
    var s = (src.data && src.data.summary) || {};
    var out = { items: [], healthy: [] };
    var locked = Number(s.locked_first_class || 0) + Number(s.locked_certified || 0);
    var pending = Number((src.data && src.data.total_pending) || 0);
    if (locked > 0) {
      var newest = (s.locked_batches || [])[0];
      out.items.push({
        key: 'mail_locked', rank: 20,
        title: 'Confirm ' + locked + ' printed ' + plural(locked, 'letter') + (locked === 1 ? ' was' : ' were') + ' mailed',
        detail: (newest && chicagoDate(newest.printed_at) ? 'Printed ' + chicagoDate(newest.printed_at) + '. ' : '') +
          'Run the post-print check, then confirm mailed.',
        source: 'Mail Queue', href: LINKS.mail, action: 'Open Mail Queue',
      });
    }
    if (pending > 0) {
      var fc = Number(s.first_class_mail || 0), cm = Number(s.certified_mail || 0);
      var parts = [];
      if (fc) parts.push(fc + ' first class');
      if (cm) parts.push(cm + ' certified');
      out.items.push({
        key: 'mail_pending', rank: 30,
        title: 'Print ' + pending + ' approved ' + plural(pending, 'letter'),
        detail: (parts.length ? parts.join(' · ') + '. ' : '') + 'Approved and ready to lock and print.',
        source: 'Mail Queue', href: LINKS.mail, action: 'Open print queue',
      });
    }
    if (!locked && !pending) out.healthy.push({ key: 'mail', label: 'Mail Queue', value: 'Clear', detail: 'Nothing to print or confirm' });
    return out;
  }

  function fromPayables(src, ctx) {
    var d = src.data || {};
    var out = { items: [], healthy: [] };
    var inv = (d.invoices || []).filter(function (i) { return sameCommunity(i, ctx.communityId); });
    var total = inv.reduce(function (a, i) { return a + Number(i.total_cents || 0); }, 0);
    if (!inv.length) {
      out.healthy.push({ key: 'payables', label: 'Payables', value: 'Clear', detail: ctx.isOwner ? 'Nothing waiting on your release' : 'Nothing waiting on a manager' });
      return out;
    }
    var vendors = inv.map(function (i) { return i.vendor; }).filter(Boolean);
    var uniq = vendors.filter(function (v, i) { return vendors.indexOf(v) === i; });
    var who = uniq.slice(0, 2).join(', ') + (uniq.length > 2 ? ' and ' + (uniq.length - 2) + ' more' : '');
    var short = (d.cash || []).find(function (c) { return sameCommunity(c, ctx.communityId) && c.covered === false; });
    if (ctx.isOwner && short) {
      out.items.push({
        key: 'payables_cash', rank: 5, tone: 'warn',
        title: 'Operating cash does not cover ' + short.count + ' ' + plural(short.count, 'bill') + ' · ' + money(short.pending_cents),
        detail: 'Cash on hand ' + money(short.operating_cash_cents) + (short.community ? ' at ' + short.community : '') + '. Decide what to release first.',
        source: 'Payables', href: LINKS.payables, action: 'Review',
      });
      return out;
    }
    out.items.push({
      key: 'payables', rank: 40,
      title: (ctx.isOwner ? 'Release ' : 'Review ') + inv.length + ' ' + plural(inv.length, 'bill') + ' · ' + money(total),
      detail: (who ? who + '. ' : '') + (ctx.isOwner ? 'Manager-approved and waiting on your release.' : 'Waiting on a manager review.'),
      source: 'Payables', href: LINKS.payables, action: 'Review',
    });
    return out;
  }

  function fromInbox(src) {
    var d = (src.data && src.data.inbox) || {};
    var out = { items: [], healthy: [] };
    var n = Number(d.count || 0);
    if (!n) {
      out.healthy.push({ key: 'inbox', label: 'Homeowner inbox', value: 'Clear', detail: 'No threads waiting · last 7 days' });
      return out;
    }
    var late = (d.items || []).filter(function (t) { return t.sla === 'red' || t.sla === 'overdue'; }).length;
    out.items.push({
      key: 'inbox', rank: late ? 10 : 50, tone: late ? 'warn' : null,
      title: 'Answer ' + n + (d.capped ? '+' : '') + ' homeowner ' + plural(n, 'thread'),
      detail: late ? late + ' past the response target. Oldest first.' : 'Waiting on a staff reply.',
      source: 'Homeowner inbox', href: LINKS.inbox, action: 'Open inbox',
    });
    return out;
  }

  // ---- receivables card (GET /api/ar/control → lib/ar/ar_control.js) -------
  function receivables(control) {
    if (!control || !control.ok || !control.data) return { ok: false, error: (control && control.error) || 'not loaded' };
    var d = control.data;
    var card = {
      ok: true,
      total_cents: Number(d.subledger_cents || 0),
      total: money(d.subledger_cents),
      owing: Number(d.owners_owing || 0),
      in_credit: Number(d.owners_in_credit || 0),
      gl: null,
    };
    if (!d.accounts) {
      card.gl = { state: 'none', text: 'No owner ledger imported for this community yet' };
    } else if (!d.conversion || !d.conversion.ready) {
      // Unconverted community: the GL and the owner ledger are different books,
      // so a difference is expected and is not a finding. Don't show one.
      card.gl = { state: 'none', text: 'GL comparison starts when this community’s ledger conversion is posted' };
    } else if (d.ties) {
      card.gl = { state: 'match', text: 'Ties to GL 1300 + 2400 · difference $0.00' };
    } else {
      card.gl = { state: 'diff', text: 'GL 1300 + 2400 is ' + money(d.gl_1300_2400_net_cents) + ' · difference ' + money(d.diff_cents) };
    }
    return card;
  }

  function headline(n) {
    if (n === 0) return 'Nothing needs you right now.';
    var words = ['One thing needs', 'Two things need', 'Three things need', 'Four things need', 'Five things need'];
    return (words[n - 1] || n + ' things need') + ' you.';
  }
  function greeting(now, firstName) {
    var h = Number(new Date(now || Date.now()).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
    var part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    return part + (firstName ? ', ' + firstName + '.' : '.');
  }

  // ---- main ----------------------------------------------------------------
  function buildBriefing(src, ctx) {
    ctx = ctx || {};
    src = src || {};
    var items = [], healthy = [], problems = [];
    var plan = [
      ['mail', 'Mail Queue', fromMail],
      ['payables', 'Payables', fromPayables],
      ['today', 'Homeowner inbox', fromInbox],
    ];
    plan.forEach(function (p) {
      var s = src[p[0]];
      if (!s || !s.ok) {
        problems.push({ key: p[0], label: p[1], message: 'Couldn’t load ' + p[1] + '. Open it directly or refresh.', error: (s && s.error) || 'not loaded', href: LINKS[p[0] === 'today' ? 'inbox' : p[0]] });
        return;
      }
      // /api/today reports its own failed sections; a failed inbox read is a problem, not a zero.
      if (p[0] === 'today' && s.data && s.data.section_errors && s.data.section_errors.inbox) {
        problems.push({ key: 'inbox', label: p[1], message: 'Couldn’t load the homeowner inbox. Open it directly or refresh.', error: s.data.section_errors.inbox, href: LINKS.inbox });
        return;
      }
      var r = p[2](s, ctx);
      items = items.concat(r.items);
      healthy = healthy.concat(r.healthy);
    });
    items.sort(function (a, b) { return a.rank - b.rank; });
    return {
      greeting: greeting(ctx.now, ctx.firstName),
      headline: headline(items.length + problems.length),
      // Say exactly what was checked; never a blanket "everything is handled".
      subline: items.length + problems.length === 0
        ? 'Mail Queue, Payables and the homeowner inbox are clear.'
        : 'From Mail Queue, Payables and the homeowner inbox.',
      items: items,
      healthy: healthy,
      problems: problems,
      receivables: receivables(src.control),
    };
  }

  var api = { buildBriefing: buildBriefing, money: money, LINKS: LINKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXBriefing = api;
})(typeof window !== 'undefined' ? window : this);
