// ============================================================================
// lib/legal/review_suggest.js — Legal Invoice Review suggestions (PURE)
// (Issue #9 step 2: draft-only)
// ----------------------------------------------------------------------------
// Turns an attorney invoice's lines into suggested review items (matters) and
// allocations, with the evidence behind every owner match. Deterministic and
// explainable: every suggestion lists what it saw. Nothing here writes.
// Tested in tests/test_legal_review_suggest.js.
//
// Rules (Issue #9, ChatGPT review):
//   - Match to PROPERTY + OWNER TENURE, never a name alone. A name only
//     corroborates an address or account match; name-only is low confidence
//     and needs review.
//   - Disagreement (address and account point at different properties, or the
//     name printed matches a former owner rather than the current one) is a
//     review condition, never an auto-match.
//   - Tenure is resolved against WHEN THE WORK WAS DONE, not the invoice date:
//     a date printed on the line wins; an invoice service period is a RANGE
//     that must sit wholly inside one owner period (a range across a sale is
//     unresolved, never collapsed to its end date). With
//     no defensible service date, an ownership change near the invoice date
//     makes the tenure "unresolved" (review), never silently "current".
//   - A former-owner period is surfaced as "former" and never suggested as a
//     charge to the current owner.
//   - Bankruptcy (on file, or named in the line text) is a hard review stop.
//   - Charge category: assessment/collection work → 'attorney_fee' (assessment-
//     related, §209.0063 priority); deed-restriction/violation work →
//     'attorney_fee_other'. Unclear → no category, review.
//   - Suggestions only: the reviewer decides; the posting slice is separate.
// ============================================================================
(function (root) {
  'use strict';

  var er = (typeof module !== 'undefined' && module.exports) ? require('../entity_resolution') : root.EntityResolution;

  var SUFFIX = '(?:Dr|Drive|St|Street|Ct|Court|Ln|Lane|Way|Rd|Road|Blvd|Boulevard|Cir|Circle|Pl|Place|Trl|Trail|Pkwy|Parkway|Ave|Avenue|Loop|Cv|Cove|Bnd|Bend|Pass|Run|Path|Xing|Crossing|Holw|Hollow|Ter|Terrace|Sq|Square|Pt|Point|Rdg|Ridge|Grv|Grove|Hts|Heights)';
  var ADDRESS_RE = new RegExp('\\b(\\d{3,6})\\s+((?:[A-Za-z][A-Za-z\'.-]*\\s+){0,4}' + SUFFIX + ')\\b\\.?', 'gi');
  var DAY = 86400000;

  // Keyword families. Order of evaluation matters: bankruptcy first (hard stop),
  // then association/corporate, then collection vs deed-restriction work.
  var BANKRUPTCY_RE = /\b(bankrupt\w*|chapter\s*(?:7|11|13)|trustee|discharge(?:d)?|automatic stay|proof of claim|dismissal\/discharge)\b/i;
  var COLLECTION_RE = /\b(collect\w*|delinquen\w*|assessment\w*|lien\w*|demand|foreclos\w*|judgment|abstract of judgment|lis pendens|account (?:history|balance|ledger)|ledger|debt|payment plan|original petition|citation|answer date|small claims)\b/i;
  var DEED_RESTRICTION_RE = /\b(deed restriction\w*|violation\w*|dccrs?|ccrs?|covenant\w*|10[\s-]?day|force(?:d)? (?:removal|mow)|self[\s-]?help|architectural|acc\b|arc\b|notice of alleged violation|tree)\b/i;
  var ASSOCIATION_RE = /\b(general matters?|board|management (?:company|agreement)|realmanage|agreement|governing documents?|bylaws|annual meeting|election|insurance|contract|opinion|status report|termination notice|meeting|budget|amendment|dumping|public street|county)\b/i;

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // ---- evidence extraction from one line of text -----------------------------
  function extractEvidence(text) {
    var t = norm(text);
    var addresses = [];
    var m;
    ADDRESS_RE.lastIndex = 0;
    while ((m = ADDRESS_RE.exec(t))) {
      var raw = (m[1] + ' ' + m[2]).replace(/\.$/, '');
      var n = er.normalizeAddress(raw);
      if (n.canonical && !addresses.some(function (a) { return a.normalized === n.canonical; })) addresses.push({ raw: raw, normalized: n.canonical });
    }
    var numbers = [];
    (t.match(/\b[A-Za-z]{0,4}\d{6,12}\b/g) || []).forEach(function (x) { if (numbers.indexOf(x) < 0) numbers.push(x); });
    // "Surname, Given [& ...] - <address>" (Daughtry & Farine style).
    var name = null;
    var nm = t.match(/^([^-—]{3,80}?,[^-—]{1,60}?)\s*[-—]\s*\d{3,6}\s/);
    if (nm) name = nm[1].trim();
    return { text: t, addresses: addresses, numbers: numbers, name: name };
  }

  function classifyText(text) {
    var t = norm(text);
    var out = { bankruptcy: BANKRUPTCY_RE.test(t), category: null, association: false, reasons: [] };
    if (out.bankruptcy) out.reasons.push('mentions bankruptcy');
    var coll = COLLECTION_RE.test(t), drv = DEED_RESTRICTION_RE.test(t), assoc = ASSOCIATION_RE.test(t);
    if (coll && !drv) { out.category = 'attorney_fee'; out.reasons.push('collection / assessment work'); }
    else if (drv && !coll) { out.category = 'attorney_fee_other'; out.reasons.push('deed-restriction / violation work'); }
    else if (coll && drv) { out.reasons.push('mentions both collection and violation work'); }
    if (assoc && !coll && !drv) { out.association = true; out.reasons.push('association / corporate work'); }
    return out;
  }

  // ---- context index ------------------------------------------------------------
  // ctx: { properties:[{id, street_address, unit, normalized_address, trusted_account_number, vantaca_account_id}],
  //        tenures:[{id, property_id, kind, start_date, end_date, origin}],
  //        owners:[{property_id, tenure_id, name}],
  //        bankruptcyPropertyIds:[...], legalStates:{property_id: state} }
  function buildIndex(ctx) {
    var byAddr = {}, byAcct = {}, props = {}, tenures = {}, owners = {};
    (ctx.properties || []).forEach(function (p) {
      props[p.id] = p;
      var key = p.normalized_address || er.normalizeAddress(p.street_address).canonical;
      if (key) (byAddr[key] = byAddr[key] || []).push(p.id);
      [p.trusted_account_number, p.vantaca_account_id].forEach(function (a) { if (a) (byAcct[String(a).toUpperCase()] = byAcct[String(a).toUpperCase()] || []).push(p.id); });
    });
    (ctx.tenures || []).forEach(function (t) { if (t.kind === 'owner') (tenures[t.property_id] = tenures[t.property_id] || []).push(t); });
    (ctx.owners || []).forEach(function (o) { (owners[o.property_id] = owners[o.property_id] || []).push(o); });
    return { byAddr: byAddr, byAcct: byAcct, props: props, tenures: tenures, owners: owners,
      bankrupt: new Set(ctx.bankruptcyPropertyIds || []), legal: ctx.legalStates || {} };
  }

  function dateMs(d) { return d ? Date.parse(String(d).slice(0, 10) + 'T12:00:00Z') : null; }

  // A backfilled tenure's start_date is when trustEd's records begin (often the
  // roster import date), not a sale. Unless a recorded prior period ends on or
  // before it, its real start is unknown: treat it as open-started and never as
  // an ownership change. Only a 'transfer' start (or a tenure with no origin
  // given) or a recorded end date is a change.
  function effectiveStart(t, list) {
    if (!t.start_date) return null;
    if (!t.origin || t.origin === 'transfer') return t.start_date;
    var s = dateMs(t.start_date);
    var predecessor = list.some(function (o) { return o !== t && o.end_date && dateMs(o.end_date) <= s; });
    return predecessor ? t.start_date : null;
  }

  // ---- service basis: WHEN was the work done? ---------------------------------------
  // 1) A date printed on the line/matter wins (source 'line_text'). One distinct
  //    date is a point; several are a range (earliest to latest). Only dates in
  //    a plausible window (two years before the invoice to a week after) count.
  // 2) Otherwise the invoice's service period, kept as a RANGE (a point only
  //    when start = end). Never collapsed to its end date.
  // 3) A period with only one bound says when billing ended, not when the work
  //    was done: treated as no service date (the conservative rule applies).
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  var DATE_RE = /\b(?:(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})|(\d{4})-(\d{2})-(\d{2})|(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}))\b/gi;
  function iso(y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return dt.toISOString().slice(0, 10);
  }
  function lineDates(text, invoiceDate) {
    var out = [], raws = [], m, inv = dateMs(invoiceDate);
    DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(String(text || '')))) {
      var d = m[1] ? iso(m[3], m[1], m[2]) : m[4] ? iso(m[4], m[5], m[6]) : iso(m[9], MONTHS[m[7].toLowerCase()], m[8]);
      if (!d) continue;
      if (inv && (dateMs(d) < inv - 730 * DAY || dateMs(d) > inv + 7 * DAY)) continue;
      if (out.indexOf(d) < 0) { out.push(d); raws.push(m[0]); }
    }
    var order = out.map(function (d, i) { return i; }).sort(function (a, b) { return out[a] < out[b] ? -1 : 1; });
    return { dates: order.map(function (i) { return out[i]; }), raws: order.map(function (i) { return raws[i]; }) };
  }
  function serviceBasis(invoice, text) {
    var ld = lineDates(text, invoice && invoice.invoice_date);
    if (ld.dates.length === 1) return { date: ld.dates[0], start: null, end: null, source: 'line_text', raw: ld.raws[0] };
    if (ld.dates.length > 1) return { date: null, start: ld.dates[0], end: ld.dates[ld.dates.length - 1], source: 'line_text', raw: ld.raws.join(', ') };
    var s = invoice && invoice.service_period_start, e = invoice && invoice.service_period_end;
    if (s && e) {
      if (s === e) return { date: s, start: null, end: null, source: 'invoice_service_period' };
      if (e < s) return { date: null, start: null, end: null, source: 'none', note: 'the invoice service period ends before it starts; treated as no service date' };
      return { date: null, start: s, end: e, source: 'invoice_service_period' };
    }
    if (s || e) return { date: null, start: null, end: null, source: 'none', note: 'the invoice shows only one end of its service period (' + (s || e) + '), not when the work was done; treated as no service date' };
    return { date: null, start: null, end: null, source: 'none' };
  }
  function describeBasis(b) {
    if (!b || b.source === 'none') return (b && b.note) || 'no service date on the line or the invoice';
    var src = b.source === 'line_text' ? 'printed on the line' + (b.raw ? ' (“' + b.raw + '”)' : '') : b.source === 'staff' ? 'entered by staff' : 'the invoice service period';
    return (b.date ? 'service date ' + b.date : 'service period ' + b.start + ' to ' + b.end) + ', from ' + src;
  }

  // Which owner tenure covers the work? `svc` is the service basis:
  //   a point  { date }            (or a bare 'YYYY-MM-DD' string)
  //   a range  { start, end }      the WHOLE range must sit inside one owner
  //                                period; a range that crosses a sale, or
  //                                that no single period covers, is unresolved
  //                                (never collapsed to its end date)
  //   null                         no service date: an ownership change within
  //                                180 days of the invoice date is unresolved
  function resolveTenure(ix, propertyId, svc, invoiceDate) {
    var list = (ix.tenures[propertyId] || []).slice();
    if (!list.length) return { tenure_id: null, match: 'unresolved', reason: 'no ownership history on file for this property' };
    var current = list.filter(function (t) { return !t.end_date; })[0] || null;
    if (typeof svc === 'string') svc = { date: svc };
    if (svc && (svc.date || (svc.start && svc.end))) {
      var from = dateMs(svc.date || svc.start), to = dateMs(svc.date || svc.end);
      var what = svc.date ? 'the service date (' + svc.date + ')' : 'the whole service period (' + svc.start + ' to ' + svc.end + ')';
      var hit = list.filter(function (t) { var st = effectiveStart(t, list); return (!st || dateMs(st) <= from) && (!t.end_date || dateMs(t.end_date) >= to); });
      if (hit.length > 1) return { tenure_id: null, match: 'unresolved', reason: 'more than one ownership period covers ' + what };
      if (!hit.length) {
        var touches = list.filter(function (t) { var st = effectiveStart(t, list); return (!st || dateMs(st) <= to) && (!t.end_date || dateMs(t.end_date) >= from); });
        return { tenure_id: null, match: 'unresolved', reason: touches.length > 1 ? 'the service period (' + svc.start + ' to ' + svc.end + ') crosses an ownership change; decide which owner each part belongs to'
          : 'no ownership period on file covers ' + what };
      }
      if (hit[0].end_date) return { tenure_id: hit[0].id, match: 'former', reason: what + ' falls in a former owner’s period (ended ' + hit[0].end_date + '); never charged to the current owner' };
      return { tenure_id: hit[0].id, match: 'current', reason: what + ' falls in the current owner’s period' };
    }
    if (!current) return { tenure_id: null, match: 'unresolved', reason: 'no current owner on file' };
    var inv = dateMs(invoiceDate) || Date.now();
    var recentChange = list.some(function (t) {
      var st = effectiveStart(t, list);
      return (st && inv - dateMs(st) <= 180 * DAY && inv - dateMs(st) >= -30 * DAY)
        || (t.end_date && inv - dateMs(t.end_date) <= 180 * DAY && inv - dateMs(t.end_date) >= -30 * DAY);
    });
    if (recentChange) return { tenure_id: null, match: 'unresolved', reason: 'no service date on the invoice, and ownership changed within 180 days of the invoice date' };
    return { tenure_id: current.id, match: 'current', reason: 'no service date on the invoice; no ownership change within 180 days, so the current owner' };
  }

  function namesOn(ix, propertyId, tenureId) {
    return (ix.owners[propertyId] || []).filter(function (o) { return !tenureId || o.tenure_id === tenureId; }).map(function (o) { return o.name; }).filter(Boolean);
  }
  // Names on file are messy (suffix in the middle, two owners joined with a
  // slash, one contact holding both spouses), so compare tokens, not strings.
  //   'match'    a printed surname AND its given name (or its initial) are on file
  //   'partial'  a printed surname is on file; the given name isn't confirmed
  //   'mismatch' no printed surname is on file at all
  var NOISE = { jr: 1, sr: 1, ii: 1, iii: 1, iv: 1, mr: 1, mrs: 1, ms: 1, dr: 1, et: 1, al: 1, and: 1, the: 1, estate: 1, of: 1, trust: 1 };
  function tokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(function (w) { return w && !NOISE[w]; });
  }
  // "Last, First [M.][, Jr.] & Last2, First2" or "Last, First & First2" (shared surname).
  function printedPeople(printed) {
    var firstSurname = null;
    return String(printed).split(/\s*&\s*/).map(function (p) {
      var bits = p.split(',');
      var surname = bits.length > 1 ? tokens(bits[0]) : [];
      var given = tokens(bits.length > 1 ? bits.slice(1).join(' ') : bits[0]);
      if (!surname.length) surname = firstSurname || [];
      else if (!firstSurname) firstSurname = surname;
      return { surname: surname, given: given };
    }).filter(function (x) { return x.surname.length; });
  }
  function nameVerdict(printed, names) {
    if (!printed || !names.length) return null;
    if (names.some(function (n) { return er.namesAreEquivalent(printed, n); })) return 'match';
    var onFile = [];
    names.forEach(function (n) { onFile = onFile.concat(tokens(n)); });
    var has = function (w) { return onFile.indexOf(w) >= 0; };
    var verdict = 'mismatch';
    printedPeople(printed).forEach(function (p) {
      if (!p.surname.some(has)) return;
      var g = p.given[0];
      if (g && (has(g) || has(g[0]))) verdict = 'match';   // full given name, or the initial on file ("M. Naylor")
      else if (verdict !== 'match') verdict = 'partial';
    });
    return verdict;
  }

  // ---- match one line's evidence to a property ----------------------------------
  function matchProperty(ix, ev) {
    var addrHits = [], acctHits = [];
    ev.addresses.forEach(function (a) { (ix.byAddr[a.normalized] || []).forEach(function (id) { if (addrHits.indexOf(id) < 0) addrHits.push(id); }); });
    ev.numbers.forEach(function (n) { (ix.byAcct[String(n).toUpperCase()] || []).forEach(function (id) { if (acctHits.indexOf(id) < 0) acctHits.push(id); }); });
    var evidence = [];
    ev.addresses.forEach(function (a) { evidence.push({ kind: 'address', value: a.raw, matched: (ix.byAddr[a.normalized] || []).length }); });
    ev.numbers.forEach(function (n) { if (ix.byAcct[String(n).toUpperCase()]) evidence.push({ kind: 'account', value: n, matched: ix.byAcct[String(n).toUpperCase()].length }); });
    if (ev.name) evidence.push({ kind: 'name', value: ev.name });

    if (addrHits.length > 1) return { property_id: null, conflict: 'the address matches more than one property', evidence: evidence };
    if (acctHits.length > 1) return { property_id: null, conflict: 'the account number matches more than one property', evidence: evidence };
    if (addrHits.length && acctHits.length && addrHits[0] !== acctHits[0]) return { property_id: null, conflict: 'the address and the account number point at different properties', evidence: evidence };
    var pid = addrHits[0] || acctHits[0] || null;
    return { property_id: pid, via: { address: !!addrHits.length, account: !!acctHits.length }, evidence: evidence };
  }

  // ---- decide one allocation suggestion for a property match --------------------
  // basis: a service basis from serviceBasis() (or a bare date string).
  function assess(ix, match, ev, cls, basis, invoiceDate) {
    var reasons = [];
    var a = { property_id: match.property_id || null, tenure_id: null, tenure_match: 'not_applicable', confidence: 'none',
      bankruptcy_stop: !!cls.bankruptcy, charge_category: cls.category, classification: 'needs_review', evidence: match.evidence.slice() };
    if (match.conflict) { reasons.push(match.conflict); a.evidence.push({ kind: 'conflict', value: match.conflict }); }
    if (a.property_id) {
      var b = typeof basis === 'string' ? { date: basis, source: 'staff' } : basis;
      var t = resolveTenure(ix, a.property_id, b && b.source !== 'none' ? b : null, invoiceDate);
      a.tenure_id = t.tenure_id; a.tenure_match = t.match;
      a.evidence.push({ kind: 'service_basis', value: describeBasis(b) });
      a.evidence.push({ kind: 'tenure', value: t.reason });
      var currentNames = namesOn(ix, a.property_id, t.match === 'current' ? t.tenure_id : null);
      var anyNames = namesOn(ix, a.property_id, null);
      var verdict = ev.name ? nameVerdict(ev.name, t.match === 'current' ? currentNames : anyNames) : null;
      var nameOk = verdict === 'match' ? true : verdict === 'mismatch' ? false : null;
      if (verdict) a.evidence.push({ kind: 'name_check', value: verdict === 'match' ? 'the printed name matches the owner on file'
        : verdict === 'partial' ? 'the printed surname matches the owner on file; the given name could not be confirmed'
        : 'the printed name does not match the owner on file for this period' });
      if (ix.bankrupt.has(a.property_id)) { a.bankruptcy_stop = true; a.evidence.push({ kind: 'bankruptcy', value: 'bankruptcy on file for this property' }); }
      if (ix.legal[a.property_id]) a.evidence.push({ kind: 'legal_status', value: ix.legal[a.property_id].replace(/_/g, ' ') });

      var corroborated = (match.via.address && match.via.account) || ((match.via.address || match.via.account) && nameOk === true);
      a.confidence = corroborated ? 'high' : nameOk === false ? 'low' : 'medium';
      if (nameOk === false) reasons.push('the printed name does not match the owner on file');
      if (t.match !== 'current') reasons.push(t.reason);
      if (a.bankruptcy_stop) reasons.push('bankruptcy: hard stop for legal review');
      if (!a.charge_category) reasons.push('the work type (collection vs deed restriction) is not clear from the text');
      if (!reasons.length && a.confidence !== 'low') a.classification = 'homeowner_recoverable';
    } else if (cls.association) {
      a.classification = 'association_legal_expense'; a.confidence = 'medium'; a.charge_category = null;
      a.evidence.push({ kind: 'work_type', value: 'association / corporate work, no property named' });
      if (a.bankruptcy_stop) { a.classification = 'needs_review'; reasons.push('bankruptcy: hard stop for legal review'); }
    } else {
      reasons.push(match.conflict ? match.conflict : 'no property or account named on this line; check the invoice PDF for the matter');
    }
    if (a.classification !== 'homeowner_recoverable') a.charge_category = a.classification === 'association_legal_expense' ? null : a.charge_category;
    if (a.classification === 'needs_review' && a.property_id == null) a.charge_category = null;
    a.review_reasons = reasons;
    return a;
  }

  // ---- whole invoice ---------------------------------------------------------------
  // invoice: { total_cents, invoice_date, service_period_start, service_period_end }
  // lines:   [{ id, description, amount_cents }]
  function suggestReview(invoice, lines, ctx) {
    var ix = buildIndex(ctx || {});
    var groups = []; var byProp = {};
    (lines || []).forEach(function (l) {
      if (!Number(l.amount_cents)) return;
      var ev = extractEvidence(l.description);
      var cls = classifyText(l.description);
      var match = matchProperty(ix, ev);
      var key = match.property_id && !match.conflict ? 'p:' + match.property_id : 'l:' + l.id;
      if (!byProp[key]) {
        byProp[key] = { source_line_ids: [], texts: [], amount_cents: 0, ev: ev, cls: cls, match: match };
        groups.push(byProp[key]);
      } else {
        // Merge classification signals across the lines of one matter.
        var g = byProp[key];
        g.cls = { bankruptcy: g.cls.bankruptcy || cls.bankruptcy, category: g.cls.category || cls.category, association: g.cls.association && cls.association, reasons: g.cls.reasons.concat(cls.reasons) };
        if (!g.ev.name && ev.name) g.ev = ev;
      }
      byProp[key].source_line_ids.push(l.id);
      byProp[key].texts.push(norm(l.description));
      byProp[key].amount_cents += Number(l.amount_cents);
    });
    var items = groups.map(function (g, i) {
      var text = g.texts.join(' | ');
      var basis = serviceBasis(invoice, text);
      var alloc = assess(ix, g.match, g.ev, g.cls, basis, invoice.invoice_date);
      alloc.amount_cents = g.amount_cents;
      alloc.suggested = true;
      return {
        sort_order: i, source_line_ids: g.source_line_ids, source_text: text.slice(0, 2000),
        matter_ref: null, amount_cents: g.amount_cents, service_date: basis.date, service_period_start: basis.start,
        service_period_end: basis.end, service_date_source: basis.source, service_basis: describeBasis(basis),
        allocations: [alloc],
      };
    });
    return { items: items, reconciliation: reconcile(invoice.total_cents, items) };
  }

  // ---- reconciliation (to the cent) ------------------------------------------------
  function reconcile(totalCents, items) {
    var allocated = 0, itemsOk = true, blocking = [];
    (items || []).forEach(function (it, i) {
      var s = (it.allocations || []).reduce(function (a, x) { return a + Number(x.amount_cents || 0); }, 0);
      allocated += s;
      if (s !== Number(it.amount_cents)) { itemsOk = false; blocking.push('item ' + (i + 1) + ' allocations total ' + s + ' of ' + it.amount_cents + ' cents'); }
      (it.allocations || []).forEach(function (a) {
        if (a.classification === 'needs_review') blocking.push('item ' + (i + 1) + ' has an allocation that needs review');
        if (a.bankruptcy_stop) blocking.push('item ' + (i + 1) + ' has a bankruptcy stop');
        if (a.classification === 'homeowner_recoverable' && a.tenure_match !== 'current') blocking.push('item ' + (i + 1) + ' is charged outside the current owner’s period');
        if (a.classification === 'homeowner_recoverable' && !a.charge_category) blocking.push('item ' + (i + 1) + ' has no charge category');
      });
    });
    var total = Number(totalCents || 0);
    if (allocated !== total) blocking.unshift('allocations total ' + allocated + ' of ' + total + ' cents');
    return { invoice_total_cents: total, allocated_cents: allocated, difference_cents: total - allocated, items_balanced: itemsOk,
      reconciled: allocated === total && itemsOk, ready_for_approval: blocking.length === 0, blocking: blocking };
  }

  var api = { extractEvidence: extractEvidence, classifyText: classifyText, buildIndex: buildIndex, resolveTenure: resolveTenure, nameVerdict: nameVerdict, serviceBasis: serviceBasis, describeBasis: describeBasis,
    matchProperty: matchProperty, assess: assess, suggestReview: suggestReview, reconcile: reconcile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TXLegalSuggest = api;
})(typeof window !== 'undefined' ? window : this);
