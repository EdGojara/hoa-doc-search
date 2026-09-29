// ============================================================================
// public/app/legal.js — Legal Invoice Review screen (Issue #9 step 2)
// ----------------------------------------------------------------------------
// /app/financial/legal. Lists attorney invoices; for one invoice shows the
// lines, the suggested (or saved) split into matters and allocations with the
// evidence behind every owner match, a to-the-cent reconciliation, and a
// revisioned "Save draft". DRAFT ONLY: nothing here posts to the books or
// charges an owner. Evidence, tenure and the bankruptcy stop shown are the
// server's; after an edit they are marked "refreshes on save", because the
// server recomputes them and never trusts the browser's copy.
// Reconciliation uses the same module as the server (/app/legal-suggest.js).
// ============================================================================
(async function () {
  'use strict';
  var esc = TX.esc, icon = TX.icon, $ = function (id) { return document.getElementById(id); };
  var user = await TX.boot({ active: 'financial' });
  if (!user) return;

  var CLASS = [['needs_review', 'Needs review'], ['homeowner_recoverable', 'Homeowner owes'], ['association_legal_expense', 'Association legal expense']];
  var CATS = [['', 'Pick one'], ['attorney_fee', 'Collection / assessment attorney fee'], ['attorney_fee_other', 'Other attorney fee (deed restriction)']];
  var TENURE = { current: ['ok', 'Current owner'], former: ['bad', 'Former owner'], unresolved: ['warn', 'Owner period unclear'], not_applicable: ['mute', 'No owner'] };
  var CONF = { high: ['ok', 'High confidence'], medium: ['info', 'Medium confidence'], low: ['warn', 'Low confidence'], none: ['mute', 'Staff choice'] };
  var money = function (c) { var n = Number(c || 0) / 100; return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var pill = function (tone, text) { return '<span class="tx-pill tx-pill--' + tone + '">' + esc(text) + '</span>'; };
  var fmtDate = function (d) { if (!d) return ''; var x = new Date(String(d).slice(0, 10) + 'T12:00:00Z'); return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  var fmtTime = function (t) { return t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  var state = { list: null, detail: null, items: null, dirty: false, saving: false, errors: [], notice: null };
  var qs = new URLSearchParams(location.search);
  var currentId = qs.get('id');

  $('lg-refresh').innerHTML = icon('refresh', { size: 14 }) + '<span>Refresh</span>';
  $('lg-refresh').addEventListener('click', function () { loadList(); if (currentId) openInvoice(currentId, true); });
  window.addEventListener('beforeunload', function (e) { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---- list ----------------------------------------------------------------------
  function statusPill(inv) {
    if (inv.read_only) return pill('mute', 'View only');
    if (inv.review && inv.review.revision) return pill('info', 'Draft saved');
    return pill('warn', 'Not reviewed');
  }
  function renderList() {
    var l = state.list;
    if (!l) return;
    if (!l.ok) { $('lg-list').innerHTML = '<div class="tx-err" style="margin:14px">' + icon('alert', { size: 16 }) + '<span>Couldn’t load attorney invoices: ' + esc(l.error) + '. Nothing is assumed reviewed.</span></div>'; return; }
    var d = l.data;
    $('lg-banner').innerHTML = d.schema_ready ? '' : '<div class="lg-banner">' + icon('info', { size: 16 }) + '<span>Suggestions are live, but drafts can’t be saved until migration 473 is applied (Documents → Migration status).</span></div>';
    if (!d.invoices.length) { $('lg-list').innerHTML = '<div class="tx-muted" style="padding:18px">No attorney invoices on file.</div>'; return; }
    var open = d.invoices.filter(function (i) { return !i.read_only && !(i.review && i.review.revision); }).length;
    $('lg-count').textContent = d.invoices.length + ' invoices · ' + open + ' not reviewed' + (d.truncated ? ' · showing the newest ' + d.invoices.length : '');
    $('lg-list').innerHTML = d.invoices.map(function (i) {
      return '<a class="lg-row' + (i.id === currentId ? ' is-on' : '') + '" href="?id=' + encodeURIComponent(i.id) + '" data-id="' + esc(i.id) + '">' +
        '<div class="lg-row-top"><span class="lg-vendor">' + esc(i.vendor) + '</span><span class="lg-amt">' + money(i.total_cents) + '</span></div>' +
        '<div class="lg-row-sub"><span>' + esc(i.community ? i.community.name : '') + ' · #' + esc(i.invoice_number) + ' · ' + esc(fmtDate(i.invoice_date)) + '</span>' + statusPill(i) + '</div></a>';
    }).join('');
    $('lg-list').querySelectorAll('a.lg-row').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); openInvoice(a.getAttribute('data-id')); });
    });
  }
  async function loadList() {
    state.list = await TX.get('/api/legal-review/invoices');
    renderList();
    $('lg-stamp').textContent = 'Checked ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  }

  // ---- detail --------------------------------------------------------------------
  async function openInvoice(id, force) {
    if (state.dirty && !force && id !== currentId && !confirm('You have unsaved changes on this invoice. Leave without saving?')) return;
    currentId = id;
    history.replaceState(null, '', '?id=' + encodeURIComponent(id));
    renderList();
    $('lg-detail').innerHTML = '<div class="tx-card" style="padding:22px"><div class="tx-skel" style="height:18px;width:50%"></div><div class="tx-skel" style="height:12px;width:80%;margin-top:12px"></div></div>';
    var r = await TX.get('/api/legal-review/invoices/' + encodeURIComponent(id));
    if (id !== currentId) return;
    if (!r.ok) { $('lg-detail').innerHTML = '<div class="tx-err">' + icon('alert', { size: 16 }) + '<span>Couldn’t load this invoice: ' + esc(r.error) + '.</span></div>'; return; }
    setDetail(r.data, null);
  }
  function setDetail(d, notice) {
    state.detail = d;
    state.items = clone((d.draft || d.suggestion).items);
    state.items.forEach(function (it) { it._staffDate = it.service_date_source === 'staff'; });
    state.dirty = false; state.errors = []; state.notice = notice;
    renderDetail();
  }
  function editable() { var d = state.detail; return d && !d.read_only && d.schema_ready; }
  function markDirty() { state.dirty = true; renderRecon(); renderFooter(); }

  function lineLabel(ids) {
    var byId = {}; state.detail.lines.forEach(function (l) { byId[l.id] = l.line_number; });
    return ids.map(function (id) { return byId[id]; }).filter(function (n) { return n != null; }).sort(function (a, b) { return a - b; }).map(function (n) { return 'L' + n; }).join(', ');
  }
  function lineText(ids) {
    var byId = {}; state.detail.lines.forEach(function (l) { byId[l.id] = l; });
    return ids.map(function (id) { return byId[id]; }).filter(Boolean);
  }

  function renderDetail() {
    var d = state.detail, inv = d.invoice, ed = editable();
    var svc = inv.service_period_start || inv.service_period_end ? fmtDate(inv.service_period_start) + (inv.service_period_end && inv.service_period_end !== inv.service_period_start ? ' – ' + fmtDate(inv.service_period_end) : '') : 'not on the invoice';
    var src = d.draft ? 'Saved draft, revision ' + d.revision + (d.review && d.review.updated_by ? ' by ' + d.review.updated_by : '') + (d.review ? ', ' + fmtTime(d.review.updated_at) : '') : 'Suggestions (not saved yet)';
    var html =
      '<div class="tx-card lg-head">' +
        '<div class="lg-head-top"><div><span class="tx-lbl">' + esc(d.community ? d.community.name : '') + '</span>' +
        '<h2>' + esc(inv.vendor) + ' · #' + esc(inv.invoice_number) + '</h2>' +
        '<div class="lg-facts"><span>Invoice ' + esc(fmtDate(inv.invoice_date)) + '</span><span>Service ' + esc(svc) + '</span><span>' + (inv.accrued ? 'Accrued to the GL' : 'Not accrued') + '</span><span>Payable ' + esc(String(inv.ap_status || '').replace(/_/g, ' ')) + '</span></div></div>' +
        '<div class="lg-total"><span class="tx-lbl">Invoice total</span><span class="lg-total-v">' + money(inv.total_cents) + '</span>' +
        (inv.has_file ? '<button type="button" class="tx-btn tx-btn--sec" id="lg-pdf">Open invoice PDF</button>' : '<span class="tx-muted" style="font-size:12px">No PDF on file</span>') + '</div></div>' +
        (d.read_only ? '<div class="lg-banner">' + icon('info', { size: 16 }) + '<span>' + esc(d.read_only) + '</span></div>' : '') +
        '<div class="lg-draftline">' + icon('info', { size: 14 }) + '<span>Showing: ' + esc(src) + '. Draft only: saving never posts to the books or charges an owner.</span>' +
        (d.draft && ed ? '<button type="button" class="lg-link" id="lg-reset">Start over from suggestions</button>' : '') + '</div>' +
      '</div>' +
      '<div class="tx-card lg-pdfread" id="lg-pdfread"></div>' +
      '<div class="tx-card lg-recon" id="lg-recon"></div>' +
      '<div id="lg-items"></div>' +
      '<div class="lg-foot" id="lg-foot"></div>' +
      (d.events && d.events.length ? '<details class="lg-hist"><summary>History (' + d.events.length + ')</summary>' + d.events.map(function (e) {
        var s = e.summary || {};
        return '<div class="lg-hist-row"><span>' + esc(fmtTime(e.created_at)) + '</span><span>Revision ' + e.revision + ' saved by ' + esc(e.actor || 'staff') + '</span><span class="tx-muted">' + (s.items != null ? s.items + ' items, ' + money(s.allocated_cents) + ' of ' + money(s.invoice_total_cents) + (s.ready_for_approval ? ', ready' : ', ' + s.blocking + ' open') : '') + '</span></div>';
      }).join('') + '</details>' : '');
    $('lg-detail').innerHTML = html;
    if ($('lg-pdf')) $('lg-pdf').addEventListener('click', openPdf);
    if ($('lg-reset')) $('lg-reset').addEventListener('click', function () {
      if (!confirm('Replace the working copy with fresh suggestions? Nothing is saved until you press Save draft.')) return;
      state.items = clone(d.suggestion.items); markDirty(); renderItems();
    });
    renderPdfRead(); renderItems(); renderRecon(); renderFooter();
  }

  // ---- the attorney's PDF (step 2b) ------------------------------------------------
  var WT = { collection: 'Collection', deed_restriction: 'Deed restriction', bankruptcy: 'Bankruptcy', general: 'General / association', unknown: 'Work type unclear' };
  function renderPdfRead() {
    var d = state.detail, x = d.extraction, inv = d.invoice;
    var canRead = !d.read_only && inv.has_file;
    var btn = function (label, force) { return canRead ? '<button type="button" class="tx-btn tx-btn--sec" id="lg-read" data-force="' + (force ? 1 : 0) + '"' + (state.reading ? ' disabled' : '') + '>' + (state.reading ? 'Reading the PDF… (about 30 seconds)' : label) + '</button>' : ''; };
    var html;
    if (!x) {
      html = '<div class="lg-pdf-top"><div><span class="tx-lbl">Attorney’s PDF</span><div class="lg-pdf-msg lg-warnmsg">' + icon('alert', { size: 14 }) +
        '<span>Not read yet. Suggestions below use the bill’s line text only, which often has no owner, address or matter.</span></div></div>' + btn('Read invoice PDF', false) + '</div>';
    } else {
      var tone = x.used ? 'ok' : x.status === 'failed' ? 'bad' : 'warn';
      var label = x.used ? 'Read and reconciled: in use' : x.status === 'failed' ? 'Read failed' : x.status === 'valid' ? 'Read, not in use' : 'Read, didn’t reconcile';
      html = '<div class="lg-pdf-top"><div><span class="tx-lbl">Attorney’s PDF</span><div class="lg-pdf-msg">' + pill(tone, label) +
        '<span class="tx-muted">Read ' + esc(fmtTime(x.created_at)) + (x.created_by ? ' by ' + esc(x.created_by) : '') + '</span></div>' +
        (x.note ? '<div class="lg-pdf-note">' + esc(x.note) + '</div>' : '<div class="lg-pdf-note">Matters, owners, addresses and the dates of the attorney’s time entries come from the PDF, and every payable line is tied to one matter to the cent.</div>') +
        '</div>' + btn('Read again', true) + '</div>' +
        (x.problems && x.problems.length ? '<ul class="lg-reasons">' + x.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
        (x.error ? '<div class="tx-err" style="margin-top:8px">' + icon('alert', { size: 15 }) + '<span>' + esc(x.error) + '</span></div>' : '') +
        (x.matters && x.matters.length ? '<details class="lg-matters"><summary>' + x.matters.length + (x.matters.length === 1 ? ' matter' : ' matters') + ' on the PDF</summary>' + x.matters.map(function (m) {
          return '<div class="lg-matter"><div class="lg-matter-top"><strong>' + esc(m.title || 'Untitled matter') + '</strong><span class="lg-amt">' + money(m.total_cents) + '</span></div>' +
            '<div class="tx-muted">' + [m.matter_ref ? 'File ' + m.matter_ref : null, m.section_heading, WT[m.work_type] || m.work_type, m.entries + (m.entries === 1 ? ' entry' : ' entries')].filter(Boolean).map(esc).join(' · ') + '</div>' +
            (m.service_basis ? '<div>When: ' + esc(m.service_basis) + '</div>' : '') +
            (m.referenced_dates && m.referenced_dates.length ? '<div class="tx-muted">Dates mentioned in the narrative, not used as service dates: ' + m.referenced_dates.map(function (r) { return esc(r.date + (r.context ? ' (' + r.context + ')' : '')); }).join('; ') + '</div>' : '') +
          '</div>';
        }).join('') + '</details>' : '');
    }
    $('lg-pdfread').innerHTML = html;
    var b = $('lg-read');
    if (b) b.addEventListener('click', function () { readPdf(b.getAttribute('data-force') === '1'); });
  }
  async function readPdf(force) {
    if (state.reading) return;
    if (state.dirty && !confirm('Reading the PDF refreshes the suggestions and discards your unsaved changes on this invoice. Continue?')) return;
    state.reading = true; renderPdfRead();
    var r = await TX.post('/api/legal-review/invoices/' + encodeURIComponent(state.detail.invoice.id) + '/read-pdf', { force: !!force });
    state.reading = false;
    if (r.ok) {
      var x = r.data.extraction;
      var msg = r.data.read && r.data.read.reused ? 'This PDF was already read; showing that read.' : x && x.used ? 'Read the PDF: ' + x.matters.length + (x.matters.length === 1 ? ' matter' : ' matters') + ', reconciled to the payable. Suggestions now use it.' : 'Read the PDF, but it didn’t reconcile to the payable, so suggestions still use the line text. See the reasons above.';
      setDetail(r.data, msg); loadList(); return;
    }
    renderPdfRead();
    alert(r.status === 401 || r.status === 403 ? 'Your session has expired. Sign in again.' : 'Couldn’t read the PDF: ' + (r.body && r.body.detail ? r.body.detail : r.error));
  }

  async function openPdf() {
    var w = window.open('', '_blank');
    var r = await TX.get('/api/ap-intake/' + encodeURIComponent(state.detail.invoice.id) + '/invoice-file?json=1');
    if (r.ok && r.data && r.data.url) { if (w) w.location = r.data.url; else location.href = r.data.url; }
    else { if (w) w.close(); alert('Couldn’t open the invoice PDF: ' + (r.error || 'not found')); }
  }

  // ---- reconciliation --------------------------------------------------------------
  function renderRecon() {
    var d = state.detail;
    var rec = TXLegalSuggest.reconcile(d.invoice.total_cents, state.items);
    var tone = rec.reconciled ? 'ok' : 'bad';
    var ready = rec.ready_for_approval;
    $('lg-recon').innerHTML =
      '<div class="lg-recon-row">' +
        '<div><span class="tx-lbl">Allocated</span><div class="lg-recon-v">' + money(rec.allocated_cents) + ' <span class="tx-muted">of ' + money(rec.invoice_total_cents) + '</span></div></div>' +
        '<div><span class="tx-lbl">Difference</span><div class="lg-recon-v">' + money(rec.difference_cents) + '</div></div>' +
        '<div class="lg-recon-pills">' + pill(tone, rec.reconciled ? 'Balanced to the cent' : 'Not balanced') +
          pill(ready ? 'ok' : 'warn', ready ? 'Nothing blocks approval' : rec.blocking.length + ' open ' + (rec.blocking.length === 1 ? 'item' : 'items')) + '</div>' +
      '</div>' +
      (rec.blocking.length ? '<details class="lg-block"><summary>What still needs a decision</summary><ul>' + rec.blocking.map(function (b) { return '<li>' + esc(b.replace(/(-?\d+) of (-?\d+) cents/, function (_, a, t) { return money(a) + ' of ' + money(t); })) + '</li>'; }).join('') + '</ul></details>' : '') +
      '<div class="tx-muted" style="font-size:12px;margin-top:6px">Approval and posting come in a later step. This screen only prepares the draft.</div>';
  }

  // ---- items ---------------------------------------------------------------------
  function allocHtml(it, i, a, j) {
    var ed = editable();
    var stale = a._edited;
    var t = TENURE[a.tenure_match] || TENURE.not_applicable;
    var c = CONF[a.confidence] || CONF.none;
    var badges = a.property_id || a.bankruptcy_stop ? (
      (a.property_id ? pill(c[0], c[1]) + pill(t[0], t[1]) : '') +
      (a.bankruptcy_stop ? pill('bad', 'Bankruptcy: hard stop') : '') +
      (stale ? pill('mute', 'Evidence refreshes on save') : '')) : (stale ? pill('mute', 'Evidence refreshes on save') : '');
    var who = a.property_id ? '<div class="lg-prop"><strong>' + esc(a.property_label || 'Property selected') + '</strong>' +
      (a.owner_names && a.owner_names.length && !stale ? '<span class="tx-muted"> · owner on file: ' + esc(a.owner_names.join('; ')) + '</span>' : '') + '</div>'
      : '<div class="lg-prop tx-muted">No property</div>';
    var ev = (a.evidence || []).length && !stale ? '<details class="lg-ev"><summary>Why (' + a.evidence.length + ')</summary><ul>' + a.evidence.map(function (e) {
      return '<li><span class="lg-ev-k">' + esc(String(e.kind).replace(/_/g, ' ')) + '</span> ' + esc(e.value) + (e.raw ? ' <span class="tx-muted">(“' + esc(e.raw) + '”)</span>' : '') + '</li>';
    }).join('') + '</ul></details>' : '';
    var reasons = (a.review_reasons || []).length && !stale ? '<ul class="lg-reasons">' + a.review_reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '';
    var dis = ed ? '' : ' disabled';
    return '<div class="lg-alloc" data-i="' + i + '" data-j="' + j + '">' +
      '<div class="lg-alloc-grid">' +
        '<label><span class="tx-lbl">Amount</span><input class="lg-in lg-amt-in" data-f="amount" inputmode="decimal" value="' + esc((a.amount_cents / 100).toFixed(2)) + '"' + dis + '></label>' +
        '<label><span class="tx-lbl">Decision</span><select class="lg-in" data-f="classification"' + dis + '>' + CLASS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === a.classification ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
        '<label><span class="tx-lbl">Charge category</span><select class="lg-in" data-f="charge_category"' + (ed && a.classification === 'homeowner_recoverable' ? '' : ' disabled') + '>' + CATS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === (a.charge_category || '') ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
        '<div class="lg-prop-box"><span class="tx-lbl">Property</span>' + who +
          (ed ? '<div class="lg-prop-actions"><button type="button" class="lg-link" data-act="find">' + (a.property_id ? 'Change' : 'Find property') + '</button>' + (a.property_id ? '<button type="button" class="lg-link" data-act="clear">Clear</button>' : '') + '</div>' +
            '<div class="lg-find" hidden><input class="lg-in" data-f="search" placeholder="Street number or name"><div class="lg-results"></div></div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="lg-badges">' + badges + (ed && it.allocations.length > 1 ? '<button type="button" class="lg-link" data-act="remove">Remove this split</button>' : '') + '</div>' +
      reasons + ev +
      '<label class="lg-note"><span class="tx-lbl">Note</span><input class="lg-in" data-f="note" value="' + esc(a.note || '') + '" placeholder="Optional"' + dis + '></label>' +
    '</div>';
  }
  function itemHtml(it, i) {
    var ed = editable();
    var sum = it.allocations.reduce(function (s, a) { return s + Number(a.amount_cents || 0); }, 0);
    var lines = lineText(it.source_line_ids);
    return '<section class="tx-card lg-item" data-i="' + i + '">' +
      '<div class="lg-item-head"><div><span class="tx-lbl">Item ' + (i + 1) + ' · ' + esc(lineLabel(it.source_line_ids)) + '</span>' +
        '<div class="lg-item-amt">' + money(it.amount_cents) + (sum !== it.amount_cents ? ' <span class="lg-off">split totals ' + money(sum) + '</span>' : '') + '</div></div>' +
        '<div class="lg-item-meta">' +
          '<label><span class="tx-lbl">Specific service date</span><input type="date" class="lg-in" data-f="service_date" value="' + esc(it.service_date || '') + '"' + (ed ? '' : ' disabled') + ' title="Optional. Leave blank to use the date on the line or the invoice service period."></label>' +
          '<label><span class="tx-lbl">Matter / reference</span><input class="lg-in" data-f="matter_ref" value="' + esc(it.matter_ref || '') + '" placeholder="Optional"' + (ed ? '' : ' disabled') + '></label>' +
        '</div></div>' +
      '<div class="lg-when">' + icon('info', { size: 13 }) + '<span>When: ' + esc(it._dateEdited ? (it.service_date ? 'service date ' + it.service_date + ', entered by staff (owner period rechecked on save)' : 'from the line text or invoice service period (rechecked on save)') : (it.service_basis || 'no service date on the line or the invoice')) + '</span></div>' +
      '<div class="lg-lines">' + lines.map(function (l) {
        return '<div class="lg-line"><span class="lg-ln">L' + l.line_number + '</span><span class="lg-lt">' + esc(l.description || '') + '</span><span class="lg-la">' + money(l.amount_cents) + '</span>' +
          (l.account ? '<span class="lg-lacct tx-muted">' + esc(l.account) + '</span>' : '') +
          (ed && lines.length > 1 ? '<button type="button" class="lg-link" data-act="separate" data-line="' + esc(l.id) + '">Make its own item</button>' : '') + '</div>';
      }).join('') + '</div>' +
      it.allocations.map(function (a, j) { return allocHtml(it, i, a, j); }).join('') +
      (ed ? '<div class="lg-item-actions"><button type="button" class="tx-btn tx-btn--sec" data-act="split">Split amount</button>' +
        (i < state.items.length - 1 ? '<button type="button" class="lg-link" data-act="merge">Combine with the next item</button>' : '') + '</div>' : '') +
    '</section>';
  }
  function renderItems() {
    $('lg-items').innerHTML = state.items.map(itemHtml).join('');
    wireItems();
  }

  function wireItems() {
    var host = $('lg-items');
    host.querySelectorAll('.lg-item').forEach(function (sec) {
      var i = Number(sec.getAttribute('data-i')), it = state.items[i];
      sec.querySelectorAll('.lg-item-meta [data-f]').forEach(function (inp) {
        inp.addEventListener('change', function () {
          var f = inp.getAttribute('data-f');
          it[f] = inp.value || null;
          if (f === 'service_date') { it._dateEdited = true; it._staffDate = !!it.service_date; it.service_period_start = null; it.service_period_end = null; it.allocations.forEach(function (a) { if (a.property_id) a._edited = true; }); }
          markDirty(); if (f === 'service_date') renderItems();
        });
      });
      sec.querySelectorAll('[data-act="separate"]').forEach(function (b) {
        b.addEventListener('click', function () {
          var lid = b.getAttribute('data-line');
          var line = state.detail.lines.filter(function (l) { return l.id === lid; })[0];
          it.source_line_ids = it.source_line_ids.filter(function (x) { return x !== lid; });
          it.amount_cents -= line.amount_cents;
          rebalance(it);
          it._dateEdited = true; if (!it._staffDate) it.service_date = null;   // re-derived on the server
          it.allocations.forEach(function (a) { if (a.property_id) a._edited = true; });
          state.items.splice(i + 1, 0, { source_line_ids: [lid], matter_ref: null, service_date: it._staffDate ? it.service_date : null, _staffDate: !!it._staffDate, _dateEdited: true, amount_cents: line.amount_cents,
            allocations: [{ amount_cents: line.amount_cents, classification: 'needs_review', property_id: null, charge_category: null, note: null, evidence: [], review_reasons: ['split off by staff; decide this line'], _edited: true }] });
          markDirty(); renderItems();
        });
      });
      var merge = sec.querySelector('[data-act="merge"]');
      if (merge) merge.addEventListener('click', function () {
        var next = state.items[i + 1];
        it.source_line_ids = it.source_line_ids.concat(next.source_line_ids);
        it.amount_cents += next.amount_cents;
        it.allocations = it.allocations.concat(next.allocations);
        it._dateEdited = true; if (!it._staffDate) it.service_date = null;   // re-derived on the server from the combined lines
        it.allocations.forEach(function (a) { if (a.property_id) a._edited = true; });
        state.items.splice(i + 1, 1);
        markDirty(); renderItems();
      });
      var split = sec.querySelector('[data-act="split"]');
      if (split) split.addEventListener('click', function () {
        var sum = it.allocations.reduce(function (s, a) { return s + Number(a.amount_cents || 0); }, 0);
        var rest = it.amount_cents - sum;
        if (!rest) {
          var last = it.allocations[it.allocations.length - 1];
          rest = Math.trunc(last.amount_cents / 2);
          if (!rest) return;
          last.amount_cents -= rest;
        }
        it.allocations.push({ amount_cents: rest, classification: 'needs_review', property_id: null, charge_category: null, note: null, evidence: [], _edited: true });
        markDirty(); renderItems();
      });
      sec.querySelectorAll('.lg-alloc').forEach(function (row) {
        var j = Number(row.getAttribute('data-j')), a = it.allocations[j];
        row.querySelectorAll('select[data-f], input[data-f="note"], input[data-f="amount"]').forEach(function (inp) {
          inp.addEventListener('change', function () {
            var f = inp.getAttribute('data-f');
            if (f === 'amount') {
              var v = String(inp.value).replace(/[$,\s]/g, '');
              var cents = /^-?\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : NaN;
              if (!Number.isFinite(cents) || cents === 0) { inp.classList.add('is-bad'); return; }
              inp.classList.remove('is-bad'); a.amount_cents = cents;
            } else if (f === 'classification') {
              a.classification = inp.value;
              if (inp.value !== 'homeowner_recoverable') a.charge_category = null;
              a._edited = true;
            } else if (f === 'charge_category') { a.charge_category = inp.value || null; }
            else if (f === 'note') { a.note = inp.value || null; }
            markDirty(); if (f !== 'note' && f !== 'amount') renderItems(); else renderItemTotals();
          });
        });
        var rm = row.querySelector('[data-act="remove"]');
        if (rm) rm.addEventListener('click', function () {
          var gone = it.allocations.splice(j, 1)[0];
          it.allocations[0].amount_cents += gone.amount_cents;
          markDirty(); renderItems();
        });
        var clear = row.querySelector('[data-act="clear"]');
        if (clear) clear.addEventListener('click', function () {
          a.property_id = null; a.property_label = null; a.owner_names = []; a._edited = true;
          if (a.classification === 'homeowner_recoverable') { a.classification = 'needs_review'; a.charge_category = null; }
          markDirty(); renderItems();
        });
        var find = row.querySelector('[data-act="find"]');
        if (find) find.addEventListener('click', function () {
          var box = row.querySelector('.lg-find'); box.hidden = !box.hidden;
          if (!box.hidden) box.querySelector('input').focus();
        });
        var search = row.querySelector('input[data-f="search"]');
        if (search) {
          var timer = null, seq = 0;
          search.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(async function () {
              var mine = ++seq, q = search.value.trim(), out = row.querySelector('.lg-results');
              if (q.length < 2) { out.innerHTML = ''; return; }
              var r = await TX.get('/api/legal-review/invoices/' + encodeURIComponent(state.detail.invoice.id) + '/properties?q=' + encodeURIComponent(q));
              if (mine !== seq) return;
              if (!r.ok) { out.innerHTML = '<div class="tx-err">' + esc(r.error) + '</div>'; return; }
              var ps = r.data.properties || [];
              out.innerHTML = ps.length ? ps.map(function (p) { return '<button type="button" class="lg-result" data-id="' + esc(p.id) + '" data-label="' + esc(p.label) + '">' + esc(p.label) + (p.account ? ' <span class="tx-muted">' + esc(p.account) + '</span>' : '') + '</button>'; }).join('') : '<div class="tx-muted" style="font-size:12.5px">No property in this community matches.</div>';
              out.querySelectorAll('.lg-result').forEach(function (b) {
                b.addEventListener('click', function () {
                  a.property_id = b.getAttribute('data-id'); a.property_label = b.getAttribute('data-label'); a.owner_names = []; a._edited = true;
                  markDirty(); renderItems();
                });
              });
            }, 250);
          });
        }
      });
    });
  }
  function rebalance(it) {
    var sum = it.allocations.reduce(function (s, a) { return s + Number(a.amount_cents || 0); }, 0);
    var diff = it.amount_cents - sum;
    if (diff) it.allocations[0].amount_cents += diff;
    it.allocations = it.allocations.filter(function (a, k) { return k === 0 || a.amount_cents !== 0; });
  }
  function renderItemTotals() {
    document.querySelectorAll('.lg-item').forEach(function (sec) {
      var it = state.items[Number(sec.getAttribute('data-i'))];
      var sum = it.allocations.reduce(function (s, a) { return s + Number(a.amount_cents || 0); }, 0);
      sec.querySelector('.lg-item-amt').innerHTML = money(it.amount_cents) + (sum !== it.amount_cents ? ' <span class="lg-off">split totals ' + money(sum) + '</span>' : '');
    });
  }

  // ---- save ----------------------------------------------------------------------
  function renderFooter() {
    var d = state.detail, ed = editable();
    var msg = '';
    if (state.notice) msg = '<div class="lg-ok">' + icon('check', { size: 15 }) + '<span>' + esc(state.notice) + '</span></div>';
    if (state.errors.length) msg = '<div class="tx-err" style="align-items:flex-start">' + icon('alert', { size: 16 }) + '<div><div>The draft wasn’t saved:</div><ul style="margin:6px 0 0 18px;padding:0">' + state.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div></div>';
    var why = !d.schema_ready ? 'Saving turns on once migration 473 is applied.' : d.read_only ? d.read_only : '';
    $('lg-foot').innerHTML = msg +
      '<div class="lg-foot-row">' + (why ? '<span class="tx-muted" style="font-size:13px">' + esc(why) + '</span>' : '<span class="tx-muted" style="font-size:13px">' + (state.dirty ? 'Unsaved changes' : 'No unsaved changes') + '</span>') +
      '<div style="display:flex;gap:10px;margin-left:auto">' +
        (ed && state.dirty ? '<button type="button" class="tx-btn tx-btn--sec" id="lg-discard">Discard changes</button>' : '') +
        '<button type="button" class="tx-btn tx-btn--pri" id="lg-save"' + (ed && (state.dirty || !d.draft) && !state.saving ? '' : ' disabled') + '>' + (state.saving ? 'Saving…' : 'Save draft') + '</button>' +
      '</div></div>';
    if ($('lg-discard')) $('lg-discard').addEventListener('click', function () { setDetail(state.detail, null); });
    if ($('lg-save')) $('lg-save').addEventListener('click', save);
  }
  async function save() {
    if (!editable() || state.saving) return;
    state.saving = true; state.errors = []; state.notice = null; renderFooter();
    var body = { base_revision: state.detail.revision, items: state.items.map(function (it) {
      return { source_line_ids: it.source_line_ids, matter_ref: it.matter_ref || null, service_date: it.service_date || null,
        allocations: it.allocations.map(function (a) { return { amount_cents: a.amount_cents, classification: a.classification, property_id: a.property_id || null, charge_category: a.charge_category || null, note: a.note || null }; }) };
    }) };
    var r = await TX.post('/api/legal-review/invoices/' + encodeURIComponent(state.detail.invoice.id) + '/draft', body);
    state.saving = false;
    if (r.ok) { setDetail(r.data, 'Draft saved as revision ' + r.data.revision + '. Evidence and owner periods were rechecked on the server.'); loadList(); return; }
    if (r.status === 409 && r.body && r.body.error === 'stale') state.errors = ['Someone else saved this draft (revision ' + r.body.revision + ') after you opened it. Copy anything you need, then press Refresh to load theirs.'];
    else if (r.status === 401 || r.status === 403) state.errors = ['Your session has expired. Sign in again, then save.'];
    else if (r.body && r.body.errors) state.errors = r.body.errors;
    else state.errors = [r.body && r.body.detail ? r.body.detail : String(r.error || 'Unknown error')];
    renderFooter();
  }

  await loadList();
  if (currentId) openInvoice(currentId, true);
  else $('lg-detail').innerHTML = '<div class="tx-card lg-empty">' + icon('receipt', { size: 22, color: 'var(--tx-gold-ink)' }) + '<div><div style="font-weight:600;color:var(--navy)">Pick an attorney invoice</div><div class="tx-muted" style="font-size:13px">Each one is split into matters: what the association pays, what a homeowner owes, and what still needs a decision, with the reasons shown.</div></div></div>';
})();
