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
    var s = state.summaries && state.summaries[inv.id];
    if (!s) return inv.review && inv.review.revision ? pill('info', 'Draft saved') : pill('mute', state.summaries ? 'Not checked' : 'Checking…');
    if (s.error) return pill('bad', 'Couldn’t check');
    if (s.stale) return pill('warn', 'Draft out of date');
    var n = s.summary.exceptions.count;
    if (n) return pill('warn', n + (n === 1 ? ' exception' : ' exceptions'));
    if (!s.summary.reconciled) return pill('bad', 'Doesn’t balance');
    return s.source === 'draft' ? pill('ok', 'Accepted (draft)') : pill('ok', 'Ready to accept');
  }
  function renderList() {
    var l = state.list;
    if (!l) return;
    if (!l.ok) { $('lg-list').innerHTML = '<div class="tx-err" style="margin:14px">' + icon('alert', { size: 16 }) + '<span>Couldn’t load attorney invoices: ' + esc(l.error) + '. Nothing is assumed reviewed.</span></div>'; return; }
    var d = l.data;
    $('lg-banner').innerHTML = d.schema_ready ? '' : '<div class="lg-banner">' + icon('info', { size: 16 }) + '<span>Suggestions are live, but drafts can’t be saved until migration 473 is applied (Documents → Migration status).</span></div>';
    if (!d.invoices.length) { $('lg-list').innerHTML = '<div class="tx-muted" style="padding:18px">No attorney invoices on file.</div>'; return; }
    var sm = state.summaries || {};
    var need = d.invoices.filter(function (i) { var s = sm[i.id]; return !i.read_only && s && s.summary && s.summary.exceptions.count; }).length;
    var ready = d.invoices.filter(function (i) { var s = sm[i.id]; return !i.read_only && s && s.summary && s.summary.can_accept && s.source !== 'draft' && !s.stale; }).length;
    $('lg-count').textContent = d.invoices.length + ' invoices' + (state.summaries ? ' · ' + need + ' with exceptions · ' + ready + ' ready to accept' : '') + (d.truncated ? ' · showing the newest ' + d.invoices.length : '');
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
    loadSummaries();
    $('lg-stamp').textContent = 'Checked ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  }

  // The proposed outcome of every invoice (for the list badges). Loads after the
  // list so the list is never held up; a failure just leaves the badges plain.
  async function loadSummaries() {
    var r = await TX.get('/api/legal-review/summaries');
    state.summaries = r.ok && r.data ? r.data.summaries : {};
    renderList();
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
    state.items.forEach(function (it) { it._staffDate = it.service_date_source === 'staff'; it._wasException = TXLegalSuggest.triageItem(it).status === 'exception'; });
    state.open = {}; state.showAll = false;
    state.fromDraft = !!d.draft;
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
      '<div class="tx-card lg-recon" id="lg-recon"></div>' +
      '<div class="tx-card lg-pdfread" id="lg-pdfread"></div>' +
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
      state.items = clone(d.suggestion.items); state.fromDraft = false; markDirty(); renderItems();
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
  // The proposed outcome, in money, and the one thing to do next.
  function renderRecon() {
    var d = state.detail, ed = editable();
    var s = TXLegalSuggest.summarize(d.invoice.total_cents, state.items);
    var stale = state.fromDraft && d.draft && d.draft.freshness && d.draft.freshness.stale;
    if (stale) s.can_accept = false;
    var n = s.exceptions.count;
    var stat = function (label, cents, sub, tone) { return '<div class="lg-sum-stat' + (tone ? ' lg-sum-' + tone : '') + '"><span class="tx-lbl">' + esc(label) + '</span><span class="lg-sum-v">' + money(cents) + '</span><span class="tx-muted">' + esc(sub) + '</span></div>'; };
    var cta = '';
    if (stale && ed) cta = '<button type="button" class="tx-btn tx-btn--pri" id="lg-refresh-draft">Start over from the current evidence</button>';
    else if (n) cta = '<button type="button" class="tx-btn tx-btn--pri" id="lg-go-exc">Review exceptions (' + n + ')</button>';
    else if (ed && s.can_accept) cta = '<button type="button" class="tx-btn tx-btn--pri" id="lg-accept"' + (state.saving ? ' disabled' : '') + '>' + (state.saving ? 'Saving…' : (d.draft && !state.dirty ? 'Accepted' : 'Accept proposed treatment')) + '</button>';
    $('lg-recon').innerHTML =
      (stale ? '<div class="lg-tri lg-tri-exc" style="margin-bottom:10px">' + icon('alert', { size: 15 }) + '<div><strong>This saved draft is out of date</strong><ul>' + d.draft.freshness.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>It can’t be accepted as it stands. Start over from the current evidence (your saved revision stays in the history).</div></div>' : '') +
      '<div class="lg-sum-top"><div><span class="tx-lbl">Proposed treatment</span><div class="lg-sum-head">' +
        (stale ? 'Out of date: re-review against the current evidence.' : n ? esc(n + (n === 1 ? ' matter needs' : ' matters need') + ' a decision. Everything else is handled.') : s.reconciled ? 'Nothing needs a decision.' : 'The split doesn’t balance to the invoice yet.') +
      '</div></div>' + cta + '</div>' +
      '<div class="lg-sum-grid">' +
        stat('Homeowners owe', s.recoverable.cents, s.recoverable.count + (s.recoverable.count === 1 ? ' matter' : ' matters')) +
        stat('Association pays', s.association.cents, s.association.count + (s.association.count === 1 ? ' matter' : ' matters')) +
        stat('Exceptions', s.exceptions.cents, n + (n === 1 ? ' matter' : ' matters'), n ? 'warn' : null) +
        stat('Invoice total', s.total_cents, s.reconciled ? 'balanced to the cent' : 'off by ' + money(s.difference_cents), s.reconciled ? null : 'bad') +
      '</div>' +
      '<div class="tx-muted" style="font-size:12px">Accepting saves this treatment as a draft. Nothing posts to the books or charges an owner yet; that is a later, separately approved step.</div>';
    var go = $('lg-go-exc');
    if (go) go.addEventListener('click', function () { var t = $('lg-exc'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    var rf = $('lg-refresh-draft');
    if (rf) rf.addEventListener('click', function () { state.items = clone(d.suggestion.items); state.items.forEach(function (it) { it._wasException = TXLegalSuggest.triageItem(it).status === 'exception'; }); state.fromDraft = false; markDirty(); renderItems(); });
    var acc = $('lg-accept');
    if (acc) acc.addEventListener('click', function () { if (!(d.draft && !state.dirty)) save(); });
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
    var tri = TXLegalSuggest.triageItem(it);
    var banner = tri.status === 'exception'
      ? '<div class="lg-tri lg-tri-exc">' + icon('alert', { size: 15 }) + '<div><strong>Needs a decision</strong><ul>' + tri.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' +
        (ed && tri.confirmable ? '<button type="button" class="tx-btn tx-btn--sec" data-act="confirm">Confirm as proposed</button><span class="tx-muted" style="font-size:12px;margin-left:8px">Records that you checked it.</span>' : '') +
        (tri.hard.length ? '<div class="tx-muted" style="font-size:12px">Change the decision below to resolve this.</div>' : '') + '</div></div>'
      : it._wasException ? '<div class="lg-tri lg-tri-ok">' + icon('check', { size: 15 }) + '<span>Resolved. Save to keep it.</span></div>' : '';
    return '<section class="tx-card lg-item" data-i="' + i + '">' + banner +
      '<div class="lg-item-head"><div><span class="tx-lbl">Item ' + (i + 1) + ' · ' + esc(lineLabel(it.source_line_ids)) + '</span>' +
        '<div class="lg-item-amt">' + money(it.amount_cents) + (sum !== it.amount_cents ? ' <span class="lg-off">split totals ' + money(sum) + '</span>' : '') + '</div></div>' +
        '<div class="lg-item-meta">' +
          '<label><span class="tx-lbl">Specific service date</span><input type="date" class="lg-in" data-f="service_date" value="' + esc(it.service_date || '') + '"' + (ed ? '' : ' disabled') + ' title="Optional. Leave blank to use the date on the line or the invoice service period."></label>' +
          '<label><span class="tx-lbl">Matter / reference</span><input class="lg-in" data-f="matter_ref" value="' + esc(it.matter_ref || '') + '" placeholder="Optional"' + (ed ? '' : ' disabled') + '></label>' +
        '</div></div>' +
      readLine(it) +
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
  // Provenance of a saved item: the exact PDF read it relied on (as saved).
  function readLine(it) {
    var d = state.detail;
    if (!it.extraction_id) return '';
    var reads = (d.draft && d.draft.reads) || [];
    var r = reads.filter(function (x) { return x.id === it.extraction_id; })[0];
    var latest = d.extraction && d.extraction.id === it.extraction_id;
    var when = r ? fmtTime(r.created_at) : (latest && d.extraction ? fmtTime(d.extraction.created_at) : '');
    return '<div class="lg-when">' + icon('receipt', { size: 13 }) + '<span>Based on the PDF read' + (when ? ' of ' + esc(when) : '') + ' (read ' + esc(String(it.extraction_id).slice(0, 8)) + ')' +
      (r && !r.is_latest && d.extraction ? '. A newer read exists; this saved item still points at the read it used.' : '') + '</span></div>';
  }
  function acceptedRow(it, i) {
    var a = it.allocations[0] || {};
    var what = a.classification === 'homeowner_recoverable' ? (a.property_label || 'Homeowner') + (a.charge_category === 'attorney_fee' ? ' · collection fee' : a.charge_category === 'attorney_fee_other' ? ' · other attorney fee' : '')
      : a.classification === 'association_legal_expense' ? 'Association legal expense' : 'Decided';
    var who = a.owner_names && a.owner_names.length ? a.owner_names.join('; ') : '';
    return '<div class="lg-acc" data-i="' + i + '"><span class="lg-acc-ok">' + icon('check', { size: 14 }) + '</span>' +
      '<div class="lg-acc-main"><div class="lg-acc-what">' + esc(what) + (it.allocations.length > 1 ? ' <span class="tx-muted">+ ' + (it.allocations.length - 1) + ' split</span>' : '') + '</div>' +
      '<div class="tx-muted lg-acc-sub">' + esc([it.matter_ref ? 'File ' + it.matter_ref : null, who, it.service_basis ? it.service_basis.replace(/, from .*/, '') : null].filter(Boolean).join(' · ')) + '</div></div>' +
      '<span class="lg-amt">' + money(it.amount_cents) + '</span><button type="button" class="lg-link" data-act="open" data-i="' + i + '">Details</button></div>';
  }
  function renderItems() {
    var exc = [], acc = [];
    state.items.forEach(function (it, i) { (it._wasException || TXLegalSuggest.triageItem(it).status === 'exception' ? exc : acc).push(i); });
    var html = '';
    if (exc.length) html += '<div class="lg-sec" id="lg-exc"><h3>Needs a decision <span class="tx-muted">(' + exc.length + ')</span></h3></div>' + exc.map(function (i) { return itemHtml(state.items[i], i); }).join('');
    if (acc.length) {
      html += '<div class="lg-sec"><h3>Handled by Trusted <span class="tx-muted">(' + acc.length + ')</span></h3>' +
        '<button type="button" class="lg-link" id="lg-showall">' + (state.showAll ? 'Collapse to the summary' : 'Show every matter in full') + '</button></div>';
      html += state.showAll ? acc.map(function (i) { return itemHtml(state.items[i], i); }).join('')
        : '<div class="tx-card lg-acc-list">' + acc.map(function (i) { return state.open[i] ? '</div>' + itemHtml(state.items[i], i) + '<div class="tx-card lg-acc-list">' : acceptedRow(state.items[i], i); }).join('') + '</div>';
    }
    $('lg-items').innerHTML = html.replace(/<div class="tx-card lg-acc-list"><\/div>/g, '');
    var sa = $('lg-showall');
    if (sa) sa.addEventListener('click', function () { state.showAll = !state.showAll; renderItems(); });
    $('lg-items').querySelectorAll('[data-act="open"]').forEach(function (b) { b.addEventListener('click', function () { state.open[b.getAttribute('data-i')] = true; renderItems(); }); });
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
      var conf = sec.querySelector('[data-act="confirm"]');
      if (conf) conf.addEventListener('click', function () {
        it.allocations.forEach(function (a) {
          if (!(a.evidence || []).some(function (e) { return e.kind === 'staff_confirmed'; })) a.evidence = (a.evidence || []).concat([{ kind: 'staff_confirmed', value: 'confirmed by you (not saved yet)' }]);
        });
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
            // A confirmation covers what the person saw; changing it withdraws it.
            if (f !== 'note') a.evidence = (a.evidence || []).filter(function (e) { return e.kind !== 'staff_confirmed'; });
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
        allocations: it.allocations.map(function (a) { return { amount_cents: a.amount_cents, classification: a.classification, property_id: a.property_id || null, charge_category: a.charge_category || null, note: a.note || null,
          confirmed: (a.evidence || []).some(function (e) { return e.kind === 'staff_confirmed'; }) }; }) };
    }) };
    var r = await TX.post('/api/legal-review/invoices/' + encodeURIComponent(state.detail.invoice.id) + '/draft', body);
    state.saving = false;
    if (r.ok) { setDetail(r.data, 'Saved as revision ' + r.data.revision + '. Evidence and owner periods were rechecked on the server.'); loadList(); return; }
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
