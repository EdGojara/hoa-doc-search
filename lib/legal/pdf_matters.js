// ============================================================================
// lib/legal/pdf_matters.js — attorney-invoice PDF matters: normalize, validate,
// map back to the AP lines (PURE)  (Issue #9 step 2b)
// ----------------------------------------------------------------------------
// The model reads the stored attorney PDF (lib/legal/pdf_extract.js). This
// module never trusts that output until it proves itself against the
// canonical AP invoice:
//   1) normalize  dollars → cents, dates → ISO, drop what isn't well-formed
//   2) validate   every matter's entries add up to the matter total; matter
//                 totals add up to the PDF total AND to the AP invoice total
//   3) map        every non-zero AP line is tied to exactly one matter, and the
//                 AP lines tied to a matter add up to that matter's total
// Only an extraction that passes all three is 'valid' and may feed
// suggestions. Anything else is 'needs_review' with the reasons listed, and the
// review falls back to the AP line text alone.
//
// Dates (ChatGPT review): an ENTRY date is the date the attorney recorded the
// work (the service date). Dates merely mentioned in a narrative (judgment,
// filing, hearing, a prior letter) and dates outside the time/expense entries
// (outstanding-invoice lists, "services rendered through") are kept as
// referenced dates and are NEVER used as service dates.
// ============================================================================
(function (root) {
  'use strict';

  var WORK_TYPES = ['collection', 'deed_restriction', 'bankruptcy', 'general', 'unknown'];
  var DAY = 86400000;

  function cents(n) {
    if (n == null || n === '') return null;
    var v = typeof n === 'number' ? n : Number(String(n).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
    return Number.isFinite(v) ? Math.round(v * 100) : null;
  }
  function isoDate(s) {
    if (!s) return null;
    var m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 ? d.toISOString().slice(0, 10) : null;
  }
  var str = function (s, max) { if (s == null) return null; var t = String(s).replace(/\s+/g, ' ').trim(); return t ? t.slice(0, max || 500) : null; };
  var ms = function (d) { return Date.parse(d + 'T12:00:00Z'); };

  // ---- 1) normalize --------------------------------------------------------------
  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var matters = (Array.isArray(raw.matters) ? raw.matters : []).map(function (m, i) {
      m = m || {};
      var entries = (Array.isArray(m.entries) ? m.entries : []).map(function (e) {
        e = e || {};
        return {
          date: isoDate(e.date), kind: e.kind === 'expense' ? 'expense' : 'fee',
          description: str(e.description, 600), amount_cents: cents(e.amount), no_charge: e.no_charge === true,
        };
      }).filter(function (e) { return e.description || e.amount_cents != null; });
      var wt = String(m.work_type || '').toLowerCase();
      return {
        index: i,
        matter_ref: str(m.matter_ref, 80),
        section_heading: str(m.section_heading, 120),
        title: str(m.title, 300),
        parties: (Array.isArray(m.parties) ? m.parties : []).map(function (p) { return str(p, 120); }).filter(Boolean).slice(0, 10),
        property_address: str(m.property_address, 200),
        owner_account_number: str(m.owner_account_number, 40),
        work_type: WORK_TYPES.indexOf(wt) >= 0 ? wt : 'unknown',
        fees_cents: cents(m.fees),
        expenses_cents: cents(m.expenses),
        total_cents: cents(m.total),
        entries: entries,
        referenced_dates: (Array.isArray(m.referenced_dates) ? m.referenced_dates : []).map(function (r) {
          return { date: isoDate(r && r.date), context: str(r && r.context, 200) };
        }).filter(function (r) { return r.date; }).slice(0, 20),
      };
    });
    return {
      invoice_number: str(raw.invoice_number, 60),
      invoice_date: isoDate(raw.invoice_date),
      total_cents: cents(raw.total),
      matters: matters,
      other_dates: (Array.isArray(raw.other_dates) ? raw.other_dates : []).map(function (r) {
        return { date: isoDate(r && r.date), context: str(r && r.context, 200) };
      }).filter(function (r) { return r.date; }).slice(0, 30),
    };
  }

  // A matter's billed entries (no-charge entries carry no amount).
  function billed(m) { return m.entries.filter(function (e) { return !e.no_charge && e.amount_cents != null; }); }
  function entrySum(m) { return billed(m).reduce(function (s, e) { return s + e.amount_cents; }, 0); }
  function matterTotal(m) {
    if (m.total_cents != null) return m.total_cents;
    if (m.fees_cents != null || m.expenses_cents != null) return (m.fees_cents || 0) + (m.expenses_cents || 0);
    return entrySum(m);
  }

  // Service basis for a matter from its ENTRY dates only (fees and expenses).
  // Entry dates outside a plausible window (two years before the invoice to a
  // week after) are ignored and reported.
  function matterServiceBasis(m, invoiceDate) {
    var inv = invoiceDate ? ms(invoiceDate) : null;
    var dates = [];
    billed(m).forEach(function (e) {
      if (!e.date) return;
      if (inv && (ms(e.date) < inv - 730 * DAY || ms(e.date) > inv + 7 * DAY)) return;
      if (dates.indexOf(e.date) < 0) dates.push(e.date);
    });
    dates.sort();
    if (!dates.length) return { date: null, start: null, end: null, source: 'none', note: 'the invoice PDF shows no dated time or expense entries for this matter' };
    if (dates.length === 1) return { date: dates[0], start: null, end: null, source: 'pdf_entry' };
    return { date: null, start: dates[0], end: dates[dates.length - 1], source: 'pdf_entry' };
  }

  // ---- 2) validate ---------------------------------------------------------------
  function validate(norm, apInvoice) {
    var problems = [];
    if (!norm.matters.length) problems.push('no matters were read from the PDF');
    norm.matters.forEach(function (m, i) {
      var tag = 'matter ' + (i + 1) + (m.title ? ' (' + m.title.slice(0, 60) + ')' : '');
      var tot = matterTotal(m);
      if (tot == null) problems.push(tag + ': no total');
      if (m.entries.length && billed(m).length && entrySum(m) !== tot) problems.push(tag + ': entries add to ' + entrySum(m) + ' cents but the matter total is ' + tot);
      if (m.fees_cents != null && m.expenses_cents != null && m.total_cents != null && m.fees_cents + m.expenses_cents !== m.total_cents) problems.push(tag + ': fees + expenses do not equal its total');
    });
    var sum = norm.matters.reduce(function (s, m) { return s + (matterTotal(m) || 0); }, 0);
    if (norm.total_cents != null && sum !== norm.total_cents) problems.push('matters add to ' + sum + ' cents but the PDF total is ' + norm.total_cents);
    var ap = apInvoice ? Number(apInvoice.total_cents) : null;
    if (ap != null && sum !== ap) problems.push('matters add to ' + sum + ' cents but the payable total is ' + ap);
    if (apInvoice && norm.invoice_number && apInvoice.vendor_invoice_number && norm.invoice_number.replace(/\W/g, '').toLowerCase() !== String(apInvoice.vendor_invoice_number).replace(/\W/g, '').toLowerCase()) {
      problems.push('the PDF invoice number (' + norm.invoice_number + ') is not the payable’s (' + apInvoice.vendor_invoice_number + ')');
    }
    return problems;
  }

  // ---- 3) map AP lines to matters -----------------------------------------------
  function tokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2 && !/^(the|and|for|fees|fee|expenses|expense|of|to|re|with|regarding|same)$/.test(w); });
  }
  function overlap(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    var hit = ta.filter(function (w) { return tb.indexOf(w) >= 0; }).length;
    return hit / Math.min(ta.length, tb.length);
  }
  function matterText(m) { return [m.title, m.parties.join(' '), m.property_address, m.section_heading].filter(Boolean).join(' '); }

  // Returns { line_map: { ap_line_id: matter_index }, problems: [...] }.
  // Rules, in order, each only when the answer is unique:
  //   a) one matter on the invoice → every line is that matter
  //   b) the line's text names the matter (title/party/address overlap) and its
  //      amount is that matter's fees, expenses, total, or one of its entries
  //   c) the line's amount + description match exactly one unused entry
  //   d) the line's amount equals exactly one matter's fees/expenses/total
  // Then each matter's mapped lines must add to the matter total.
  function mapLines(norm, apLines) {
    var lines = (apLines || []).filter(function (l) { return Number(l.amount_cents) !== 0; });
    var map = {}, problems = [];
    var ms_ = norm.matters;
    if (!ms_.length) return { line_map: {}, problems: ['no matters to map to'] };
    if (ms_.length === 1) {
      lines.forEach(function (l) { map[l.id] = 0; });
    } else {
      var usedEntry = {};
      lines.forEach(function (l) {
        var amt = Number(l.amount_cents);
        var amountsOf = function (m) { return [m.fees_cents, m.expenses_cents, matterTotal(m)].concat(billed(m).map(function (e) { return e.amount_cents; })); };
        var named = ms_.filter(function (m) { return overlap(l.description, matterText(m)) >= 0.5 && amountsOf(m).indexOf(amt) >= 0; });
        if (named.length === 1) { map[l.id] = named[0].index; return; }
        var entryHits = [];
        ms_.forEach(function (m) {
          billed(m).forEach(function (e, j) {
            var k = m.index + ':' + j;
            if (!usedEntry[k] && e.amount_cents === amt && overlap(l.description, e.description) >= 0.6) entryHits.push({ m: m.index, k: k });
          });
        });
        var entryMatters = entryHits.map(function (h) { return h.m; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
        if (entryMatters.length === 1) { map[l.id] = entryMatters[0]; usedEntry[entryHits[0].k] = true; return; }
        var byAmount = ms_.filter(function (m) { return [m.fees_cents, m.expenses_cents, matterTotal(m)].indexOf(amt) >= 0; });
        if (byAmount.length === 1) { map[l.id] = byAmount[0].index; return; }
      });
    }
    var unmapped = lines.filter(function (l) { return !(l.id in map); });
    if (unmapped.length) problems.push((unmapped.length === 1 ? 'line ' : 'lines ') + unmapped.map(function (l) { return l.line_number; }).join(', ') + ' could not be tied to one matter on the PDF');
    ms_.forEach(function (m, i) {
      var mapped = lines.filter(function (l) { return map[l.id] === m.index; }).reduce(function (s, l) { return s + Number(l.amount_cents); }, 0);
      var tot = matterTotal(m);
      if (tot != null && mapped !== tot) problems.push('matter ' + (i + 1) + (m.title ? ' (' + m.title.slice(0, 60) + ')' : '') + ': payable lines add to ' + mapped + ' cents, the PDF says ' + tot);
    });
    return { line_map: map, problems: problems };
  }

  // Whole pipeline over a model result. status: 'valid' | 'needs_review'.
  function assessExtraction(raw, apInvoice, apLines) {
    var norm = normalize(raw);
    var problems = validate(norm, apInvoice);
    var mapped = mapLines(norm, apLines);
    problems = problems.concat(mapped.problems);
    norm.matters.forEach(function (m) { m.service_basis = matterServiceBasis(m, norm.invoice_date || (apInvoice && apInvoice.invoice_date)); });
    return { status: problems.length ? 'needs_review' : 'valid', matters: norm.matters, header: { invoice_number: norm.invoice_number, invoice_date: norm.invoice_date, total_cents: norm.total_cents, other_dates: norm.other_dates },
      line_map: mapped.line_map, problems: problems };
  }

  var api = { normalize: normalize, validate: validate, mapLines: mapLines, matterServiceBasis: matterServiceBasis, matterTotal: matterTotal, assessExtraction: assessExtraction, WORK_TYPES: WORK_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXLegalMatters = api;
})(typeof window !== 'undefined' ? window : this);
