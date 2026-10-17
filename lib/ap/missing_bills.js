// ============================================================================
// lib/ap/missing_bills.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// Emma notices a recurring bill that didn't come, the day it is late, instead
// of Kat discovering it at month-end close.
//
// THE SCAR. Canyon Gate's September close (2026-10-15) was blocked partly by
// bills nobody knew were missing until the books were being closed:
//
//   Star Protection (weekly)   no bill for 9/6-9/12 or 9/20-9/26
//   Gexa Energy (monthly, per account)  2939255 sent its mid-September bill;
//                              2939256, 2939257, 2939258 and 2939259, billed
//                              alongside it every month, did not
//
// The close's DATA-05 control asks a coarser question ("did each monthly vendor
// bill at all this month?") and only at close. A weekly vendor that skips one
// week, or one account of five, sails through it.
//
// What this does, per community, from the bills already on file (ap_invoices,
// anything not voided: a bill received is not missing, posted or not):
//
//   1. Splits the bills into SERIES: one per utility/service account number
//      (6+ digits; Gexa, Cinco MUD 8, Comcast), otherwise one per vendor, kept
//      apart for bills that carry a service period (the contract bill) and
//      bills that don't (Earthcare's one-off repairs never muddle its monthly).
//   2. Learns each series' cadence from the gaps between its bills: weekly,
//      biweekly, monthly or quarterly. A series that doesn't settle into one of
//      those is not treated as recurring (S&L Solutions, Bedrock fee bills).
//      vendor_contracts confirms a two-bill vendor and ends the expectation when
//      the contract has expired or ended. Attorneys bill as work happens, never
//      on a cadence, and are skipped.
//   3. Reports (a) a hole inside the series (a week with no bill between two
//      weeks that have one) and (b) the next bill, once it is overdue by the
//      tolerance. An account billed once, on the same day as a sibling account
//      of the same vendor that does recur, inherits the sibling's cadence; that
//      is the Gexa case.
//   4. Opens ONE Emma task per missing bill on Mission Control (upsertAgentTask,
//      stable source_ref, so a re-run updates, never duplicates) and closes its
//      own earlier task once that bill arrives.
//
// It never posts, accrues or emails anything. Off unless SCHEDULER_ENABLED
// names 'ap_missing_bills'.
// ============================================================================

const DAY = 86400000;
const toDay = (d) => Math.floor(Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') / DAY);
const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dollars = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CADENCES = [
  { name: 'weekly', lo: 6, hi: 8 },
  { name: 'biweekly', lo: 13, hi: 16 },
  { name: 'monthly', lo: 26, hi: 35 },
  { name: 'quarterly', lo: 84, hi: 98 },
];
const CONTRACT_DAYS = { monthly: 30.4, quarterly: 91.3 };

function acctKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 6 ? d : null;
}

function cadenceOf(m) { return CADENCES.find((c) => m >= c.lo && m <= c.hi) || null; }

// Same-day (or within 2 days) bills are one billing event: Star's main bill and
// its patrol add-on, or a vendor that sends a bill and a correction together.
function anchorsOf(bills) {
  const sorted = [...bills].sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)));
  const out = [];
  for (const b of sorted) {
    const day = toDay(b.invoice_date);
    const last = out[out.length - 1];
    if (last && day - last.day <= 2) { last.bills.push(b); last.cents += Number(b.total_cents || 0); if (!last.period && b.service_period_start) last.period = [b.service_period_start, b.service_period_end]; continue; }
    out.push({ day, date: String(b.invoice_date).slice(0, 10), bills: [b], cents: Number(b.total_cents || 0), period: b.service_period_start ? [b.service_period_start, b.service_period_end] : null });
  }
  return out;
}

// The j-th service period after `period`: periods follow each other (Star
// 8/30-9/5 -> 9/6-9/12), so step by the period's own length. Without an end
// date, step by the cadence.
function nextPeriod(period, j, m) {
  if (!period || !period[0]) return null;
  // A calendar-month period (10/1-10/31) steps by calendar months, not 31 days.
  const [y, mo, d] = String(period[0]).slice(0, 10).split('-').map(Number);
  const monthEnd = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);   // mm 1-based
  if (d === 1 && period[1] && String(period[1]).slice(0, 10) === monthEnd(y, mo)) {
    const t = new Date(Date.UTC(y, mo - 1 + j, 1));
    return [t.toISOString().slice(0, 10), monthEnd(t.getUTCFullYear(), t.getUTCMonth() + 1)];
  }
  const s0 = toDay(period[0]);
  const len = period[1] ? toDay(period[1]) - s0 + 1 : Math.round(m);
  const s = s0 + j * len;
  return [fromDay(s), period[1] ? fromDay(s + len - 1) : null];
}

/**
 * Pure: which recurring bills are missing as of `today`?
 * @param {{ bills: Array<{id, vendor_id, vendor_name, account_number, invoice_date, service_period_start, service_period_end, total_cents}>,
 *           contracts?: Array<{vendor_id, status, end_date, periodic_frequency}>,
 *           legalVendorIds?: string[], today: string|Date, lookbackDays?: number }} a
 * @returns {Array<{ series_key, kind:'gap'|'overdue', vendor_id, vendor_name, account_number,
 *                   cadence, expected_date, period:[string,string|null]|null, typical_cents,
 *                   days_late, basis, source_ref_part }>}
 */
function findMissingBills({ bills, contracts = [], legalVendorIds = [], today, lookbackDays = 120 } = {}) {
  const todayDay = toDay(today instanceof Date ? today.toISOString() : today);
  const legal = new Set(legalVendorIds || []);
  const series = new Map();
  for (const b of bills || []) {
    if (!b || !b.invoice_date || !b.vendor_id || legal.has(b.vendor_id)) continue;
    const acct = acctKey(b.account_number);
    const key = acct ? `acct:${acct}` : `vendor:${b.vendor_id}:${b.service_period_start ? 'period' : 'plain'}`;
    if (!series.has(key)) series.set(key, { key, acct, bills: [] });
    series.get(key).bills.push(b);
  }

  // Contract view per vendor: frequency confirms a cadence; an ended contract ends the expectation.
  const contractFor = new Map();
  for (const c of contracts || []) {
    if (!c || !c.vendor_id) continue;
    const prev = contractFor.get(c.vendor_id);
    if (!prev || String(c.status) === 'active') contractFor.set(c.vendor_id, c);
  }
  const contractEndDay = (vendorId) => {
    const c = contractFor.get(vendorId);
    if (!c) return null;
    if (c.end_date) return toDay(c.end_date);
    if (['expired', 'terminated', 'cancelled'].includes(String(c.status))) return -Infinity;
    return null;
  };

  // Pass 1: learn each series' cadence.
  const learned = [];
  for (const s of series.values()) {
    const anchors = anchorsOf(s.bills);
    const latest = anchors[anchors.length - 1].bills.slice(-1)[0];
    const info = { ...s, anchors, vendor_id: latest.vendor_id, vendor_name: latest.vendor_name || null, account_number: latest.account_number || null, m: null, cadence: null, basis: null };
    if (anchors.length >= 2) {
      const gaps = anchors.slice(1).map((a, i) => a.day - anchors[i].day);
      const m = median(gaps);
      let cad = cadenceOf(m);
      const contract = contractFor.get(info.vendor_id);
      if (!cad && contract && CONTRACT_DAYS[contract.periodic_frequency]) cad = CADENCES.find((c) => c.name === contract.periodic_frequency);
      const regular = gaps.every((g) => g >= 0.5 * m)
        && gaps.filter((g) => { const k = Math.max(1, Math.round(g / m)); return Math.abs(g - k * m) <= 0.3 * m; }).length >= Math.ceil(gaps.length * 0.8);
      // Two bills prove a cadence only for an account-billed service (a utility)
      // or a vendor whose contract names the same frequency.
      const twoOk = anchors.length >= 3 || s.acct || (contract && cad && contract.periodic_frequency === cad.name);
      if (cad && regular && twoOk) {
        info.m = m; info.cadence = cad.name;
        info.basis = `${anchors.length} bills on file, ${cad.name} (every ~${Math.round(m)} days)${contract && contract.periodic_frequency === cad.name ? '; contract says ' + cad.name : ''}`;
      }
    }
    learned.push(info);
  }

  // Pass 2: an account billed once, alongside a recurring sibling account of the
  // same vendor, inherits the sibling's cadence (Gexa 2939256-2939259).
  for (const s of learned) {
    if (s.m || s.anchors.length !== 1 || !s.acct) continue;
    const day = s.anchors[0].day;
    const sib = learned.find((o) => o !== s && o.m && o.anchors.length >= 2 && o.acct && o.vendor_id === s.vendor_id && o.anchors.some((a) => Math.abs(a.day - day) <= 3));
    if (sib) {
      s.m = sib.m; s.cadence = sib.cadence;
      s.basis = `billed together with account ${sib.account_number || sib.acct} on ${s.anchors[0].date}, which bills ${sib.cadence}`;
    }
  }

  const out = [];
  for (const s of learned) {
    if (!s.m) continue;
    const endDay = contractEndDay(s.vendor_id);
    const typical = Math.round(median(s.anchors.map((a) => a.cents)));
    const tol = Math.max(4, Math.round(0.33 * s.m));
    const push = (kind, expDay, period) => {
      if (endDay != null && expDay > endDay) return;
      out.push({
        series_key: s.key, kind, vendor_id: s.vendor_id, vendor_name: s.vendor_name, account_number: s.account_number,
        cadence: s.cadence, expected_date: fromDay(Math.round(expDay)), period, typical_cents: typical,
        days_late: Math.max(0, todayDay - Math.round(expDay)), basis: s.basis,
        source_ref_part: `${s.key}:${period && period[0] ? period[0] : fromDay(Math.round(expDay))}`,
      });
    };
    // (a) holes inside the series
    for (let i = 1; i < s.anchors.length; i++) {
      const prev = s.anchors[i - 1], cur = s.anchors[i];
      const k = Math.round((cur.day - prev.day) / s.m);
      for (let j = 1; j < k; j++) {
        const exp = prev.day + j * s.m;
        if (exp < todayDay - lookbackDays) continue;
        push('gap', exp, nextPeriod(prev.period, j, s.m));
      }
    }
    // (b) the next bill, once overdue past tolerance (and not so long ago that
    // the series has plainly ended: three cycles without a bill is a vendor
    // that stopped, which is a different question).
    const last = s.anchors[s.anchors.length - 1];
    const next = last.day + s.m;
    if (todayDay > next + tol && todayDay <= next + 3 * s.m) push('overdue', next, nextPeriod(last.period, 1, s.m));
  }
  return out.sort((a, b) => a.expected_date.localeCompare(b.expected_date) || String(a.vendor_name).localeCompare(String(b.vendor_name)));
}

// Plain-language task text for one missing bill.
function describe(m, communityName) {
  const what = `${m.vendor_name || 'Vendor'}${m.account_number ? ` account ${m.account_number}` : ''}`;
  const when = m.period && m.period[0] ? `${m.period[0]}${m.period[1] ? ` to ${m.period[1]}` : ''}` : `due about ${m.expected_date}`;
  return {
    title: `${communityName ? communityName + ': ' : ''}missing ${m.cadence} bill, ${what} (${when})`.slice(0, 300),
    summary: (m.kind === 'gap'
      ? `No ${what} bill for ${when}, although the bills before and after it are on file. `
      : `The next ${what} bill (${when}) was expected about ${m.expected_date} and is ${m.days_late} days late. `)
      + `Basis: ${m.basis}. Typical bill ${dollars(m.typical_cents)}.`,
    next_step: 'Get the bill from the vendor (portal, inbox, or ask) and load it, or record that no bill is due (service ended or billed on another invoice). If it cannot be had before close, Kat accrues it to its month.',
  };
}

/**
 * Daily tick. Per operational community: find missing recurring bills, open or
 * update one Emma task per bill, and close Emma's earlier tasks for bills that
 * have since arrived. Never posts, accrues or emails.
 */
async function tick({ supabase, today = new Date(), logger = console, upsertTask = null } = {}) {
  const upsert = upsertTask || require('../../api/mission_control').upsertAgentTask;
  const { fetchAllQuery } = require('../db/fetch_all');
  const todayIso = (today instanceof Date ? today : new Date(today)).toISOString().slice(0, 10);
  const since = fromDay(toDay(todayIso) - 400);
  const comms = (await require('../community/lifecycle').operationalCommunities(supabase)).filter((c) => !c.is_demo);
  const result = { communities: comms.length, missing: 0, created: 0, updated: 0, resolved: 0, failed: 0 };

  for (const c of comms) {
    try {
      const rows = await fetchAllQuery(() => supabase.from('ap_invoices')
        .select('id, vendor_id, account_number, invoice_date, service_period_start, service_period_end, total_cents, status, vendors(name, is_legal_counsel)')
        .eq('community_id', c.id).neq('status', 'voided').gte('invoice_date', since));
      const bills = rows.map((r) => ({ ...r, vendor_name: r.vendors && r.vendors.name }));
      const legalVendorIds = [...new Set(rows.filter((r) => r.vendors && r.vendors.is_legal_counsel).map((r) => r.vendor_id))];
      const { data: contracts, error: ce } = await supabase.from('vendor_contracts')
        .select('vendor_id, status, end_date, periodic_frequency').eq('community_id', c.id).not('vendor_id', 'is', null).limit(500);
      if (ce) throw new Error(`vendor contracts: ${ce.message}`);

      const missing = findMissingBills({ bills, contracts: contracts || [], legalVendorIds, today: todayIso });
      result.missing += missing.length;
      const prefix = `ap-missing-bill:${c.id}:`;
      // Every task this check ever opened here, any status: a task Emma closed or
      // dismissed ("service ended", "no bill due") must not be re-opened tomorrow.
      const { data: mine, error: oe } = await supabase.from('work_items').select('id, source_ref, status, notes')
        .like('source_ref', `${prefix}%`).eq('source_type', 'agent').order('created_at', { ascending: false }).limit(1000);
      if (oe) throw new Error(`existing tasks: ${oe.message}`);
      const OPEN = ['new', 'in_progress', 'waiting'];
      const closed = new Set((mine || []).filter((w) => !OPEN.includes(w.status)).map((w) => w.source_ref));
      const openRefs = new Set((mine || []).filter((w) => OPEN.includes(w.status)).map((w) => w.source_ref));
      const live = new Set();
      for (const m of missing) {
        const source_ref = prefix + m.source_ref_part;
        live.add(source_ref);
        if (closed.has(source_ref) && !openRefs.has(source_ref)) { result.already_closed = (result.already_closed || 0) + 1; continue; }
        const d = describe(m, c.name);
        const r = await upsert({
          source_ref, title: d.title, summary: d.summary, next_step: d.next_step,
          assigned_to: 'Emma', requested_by: 'Emma (missing recurring bill check)', item_type: 'task',
          urgency: m.days_late > 30 ? 'high' : 'normal', module_key: 'accounting_close', horizon: 'now',
          community_id: c.id, community_name: c.name, notes: `Expected about ${m.expected_date}; ${m.days_late} days late as of ${todayIso}.`,
        });
        if (!r) result.failed += 1; else if (r.created) result.created += 1; else result.updated += 1;
      }

      // Close this check's own tasks whose bill has since arrived, but only while
      // nobody has picked them up (status 'new'): a task Emma is working stays
      // hers to close. The note is APPENDED; whatever she wrote is kept.
      for (const w of (mine || []).filter((x) => x.status === 'new')) {
        if (live.has(w.source_ref)) continue;
        const note = `Closed by the missing-bill check on ${todayIso}: the bill is now on file (or no longer expected).`;
        const { error: ue } = await supabase.from('work_items').update({ status: 'done', completed_at: new Date().toISOString(), notes: [w.notes, note].filter(Boolean).join(' | ') }).eq('id', w.id).eq('status', 'new');
        if (ue) { logger.warn('[ap_missing_bills] could not close a resolved task', JSON.stringify({ id: w.id, error: ue.message })); continue; }
        const { error: ee } = await supabase.from('work_item_events').insert({ work_item_id: w.id, event: 'status_changed', actor: 'Emma (missing recurring bill check)', detail: { to: 'done', reason: 'bill on file' } });
        if (ee) logger.warn('[ap_missing_bills] close event not recorded', JSON.stringify({ id: w.id, error: ee.message }));
        result.resolved += 1;
      }
    } catch (e) {
      result.failed += 1;
      logger.error(`[ap_missing_bills] ${c.name || c.id}: ${e.message}`);
    }
  }
  if (result.failed) throw Object.assign(new Error(`ap_missing_bills: ${result.failed} item(s) failed`), { summary: result });
  return result;
}

module.exports = { findMissingBills, describe, tick, acctKey };
