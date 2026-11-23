#!/usr/bin/env node
// ============================================================================
// scripts/build_annual_statements.js  (Ed 2026-11-20; preview + announcement 2026-11-22)
// ----------------------------------------------------------------------------
// ANNUAL ASSESSMENT STATEMENT BATCH: print-ready PDFs + a manifest, per
// association. Builds files only; it never mails, emails, posts a charge or
// writes to the database. Distribution waits for Ed.
//
//   node scripts/build_annual_statements.js --community "Waterview Estates" \
//        --year 2027 --due 2027-01-01 --rate-cents 64000 --out <dir> \
//        [--announce <announcement.json>] [--notice-text "..."] [--office-remit]
//   node scripts/build_annual_statements.js ... --preview       (review copy)
//        [--activity-from 2026-10-01]   balance forward, then each payment, credit and charge since
//        [--disclosure "..."]           informational note under the activity (never a charge)
//        [--counsel-add <file>]         accounts counsel is handling but not recorded: "account,state,firm" per line
//        [--counsel-notices <firms.json>]  separate notices (no balance, no coupon) for held accounts
//        [--defer <file>]               leave these out pending review: "account,reason" per line
//   node scripts/build_annual_statements.js --community "Waterview Estates" \
//        --sample 20 --out <dir>          (bank scanline read-test proofs)
//
// A FINAL billing batch REFUSES to build unless:
//   * the association's budget for --year is APPROVED in TrustEd
//     (community_budgets.status = 'approved'), and --rate-cents is given (the
//     approved per-lot annual assessment; never inferred from a prior year);
//   * --due YYYY-MM-DD is given;
//   * the statement notice (delinquency wording from the association's
//     collection policy) is given: --notice-text, or notice_text in --announce;
//   * the association has a VERIFIED lockbox (lib/payments/lockbox.js) or the
//     operator passes --office-remit to send checks c/o Bedrock's office;
//   * with --announce: the announcement validates with NO placeholders, every
//     listed portal feature is live, and the association's payment fees are
//     configured (communities.portal_module_config.payment_fees).
// --preview skips ONLY the approved-budget refusal and allows announcement
// placeholders and the proposed (pending) fee schedule; every page is
// watermarked PREVIEW - NOT FOR MAILING and the output is never cleared for
// mailing. Every other gate still applies.
// Every statement is validated (mailing address, account number, encodable
// amount, scanline present when the lockbox is verified); failures go to the
// exceptions list and are left out of the print file, never printed blank.
// A sample run prints current balances only, watermarked NOT FOR MAILING.
// COUNSEL HOLD (Ed 2026-11-22): an account with an active enforcement state
// (property_enforcement_states: bankruptcy, with counsel, in collections,
// lien, judgment, payment plan) is never put in the print file. A statement
// demanding a pre-petition balance from a debtor in bankruptcy can violate the
// 11 U.S.C. 362 stay, and an owner represented by collections counsel is
// contacted through counsel. Held accounts go to <stem>_counsel_hold.csv for
// Ed and counsel to decide. Accounts carrying legal fees with NO state on file
// are listed as warnings (possible counsel accounts not yet recorded).
//
// Print: the PDF embeds the OCR-A face installed on the machine that runs it
// (Windows "OCR A Extended"); the run stops if no OCR-A face loads, because a
// scanline in a fallback font will not read at the bank.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const PREVIEW_LABEL = 'PREVIEW - NOT FOR MAILING';

// The OCR-A TrueType file to embed (never committed: licensed per machine).
// OCR_A_FONT_PATH overrides; else the Windows OCR A Extended face.
function ocrFontDataUri() {
  const cands = [process.env.OCR_A_FONT_PATH, 'C:/Windows/Fonts/OCRAEXT.TTF', '/usr/share/fonts/truetype/ocr-a/OCRA.ttf'].filter(Boolean);
  const f = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!f) throw new Error('no OCR-A font file found; set OCR_A_FONT_PATH to an OCR-A .ttf');
  return 'data:font/ttf;base64,' + fs.readFileSync(f).toString('base64');
}

function args(argv = process.argv.slice(2)) {
  const a = argv; const o = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (['office-remit', 'dry-run', 'preview'].includes(k)) o[k] = true; else { o[k] = a[i + 1]; i++; }
  }
  return o;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// "account,rest" per line (# comments and blanks ignored) -> Map.
function parseAccountList(text) {
  const out = new Map();
  for (const l of String(text || '').split(/\r?\n/)) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const i = l.indexOf(','); const acct = (i < 0 ? l : l.slice(0, i)).trim().replace(/"/g, '');
    if (acct) out.set(acct, i < 0 ? 'deferred' : l.slice(i + 1).trim().replace(/^"|"$/g, '') || 'deferred');
  }
  return out;
}
// Split printable statements into this batch and the deferred ones. An account on
// the list that matches nothing is reported (a typo must not mail someone).
function applyDefer(good, defer) {
  const mail = []; const deferred = []; const hit = new Set();
  for (const d of good) {
    const a = String(d.account_number || '');
    if (defer.has(a)) { hit.add(a); deferred.push({ d, reason: defer.get(a) }); } else mail.push(d);
  }
  return { mail, deferred, unmatched: [...defer.keys()].filter((a) => !hit.has(a)) };
}
// Who of the held accounts gets a counsel notice: never a bankruptcy, never
// without the firm's contact information, never an incomplete address.
function counselNotices(held, firms, defer = new Map()) {
  const send = []; const none = [];
  for (const h of held) {
    const firm = h.firm && (firms || {})[h.firm];
    const why = defer.has(String(h.d.account_number)) ? defer.get(String(h.d.account_number))
      : h.state === 'in_bankruptcy' ? 'bankruptcy: through bankruptcy counsel only'
      : !firm ? 'no verified contact information for the firm'
        : (h.d._why || []).some((w) => /mailing address|owner name|account number/.test(w)) ? h.d._why.join('; ') : null;
    if (why) none.push({ ...h, why }); else send.push({ ...h, firm });
  }
  return { send, none };
}

// The billing gates, pure (tested in tests/test_annual_statement_run.js).
// -> { blockers: [], warnings: [], billing, announcement, noticeText }
function billingGates({ opts, community, budget, lockbox, announcementRaw = null }) {
  const { resolveAnnouncement } = require('../lib/statements/assessment_statement');
  const preview = !!opts.preview;
  const blockers = []; const warnings = [];
  const year = Number(opts.year);
  if (!year) blockers.push('--year is required for a billing batch');
  if (!budget || budget.status !== 'approved') {
    const why = `${year} budget is ${budget ? budget.status : 'not in TrustEd'}; the annual assessment is not approved`;
    if (preview) warnings.push(`PREVIEW: ${why}`); else blockers.push(why);
  }
  const rate = Math.round(Number(opts['rate-cents']));
  if (!(rate > 0)) blockers.push('--rate-cents (the approved per-lot annual assessment) was not given');
  if (opts['activity-from'] && !/^\d{4}-\d{2}-\d{2}$/.test(String(opts['activity-from']))) blockers.push('--activity-from must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(opts.due || ''))) blockers.push('--due YYYY-MM-DD (the assessment due date) was not given');
  if (!lockbox && !opts['office-remit']) blockers.push('no verified lockbox for this association; pass --office-remit to have checks mailed c/o Bedrock office');

  let announcement = null;
  if (announcementRaw) {
    const r = resolveAnnouncement(announcementRaw, { community, year, preview });
    if (!r.ok) blockers.push(...r.errors.map((e) => `announcement: ${e}`));
    warnings.push(...r.warnings.map((w) => `announcement: ${w}`));
    announcement = r.ann;
  }
  const noticeText = (opts['notice-text'] && String(opts['notice-text']).trim()) || (announcement && announcement.notice_text) || null;
  if (!noticeText) blockers.push('the statement notice (delinquency wording per the collection policy) was not given: --notice-text or notice_text in --announce');
  return { blockers, warnings, billing: { year, assessment_cents: rate, due_date: opts.due, activity_from: opts['activity-from'] || null, disclosure: opts.disclosure || null }, announcement, noticeText };
}

function validate(d, { lockbox, sample }) {
  const why = [];
  if (!d.account_number) why.push('no account number');
  if (!d.addressee || !String(d.addressee.street || '').trim() || !String(d.addressee.cityline || '').trim()) why.push('no complete mailing address');
  if (!d.addressee || !String(d.addressee.name || '').trim() || /^Property Owner$/i.test(d.addressee.name)) why.push('no owner name');
  if (d.balance_cents > 999999) why.push('amount over $9,999.99 does not fit the coupon field');
  if (lockbox && !d.scanline) why.push('scanline could not be encoded (account/amount)');
  if (!sample && d.prior_balance_cents < 0) { /* credit carried: allowed, pay amount floors at 0 */ }
  return why;
}

// Active enforcement state -> why the statement is held (null = mail normally).
const COUNSEL_HOLD = {
  in_bankruptcy: 'Bankruptcy on file: automatic stay; any statement goes through bankruptcy counsel',
  at_legal: 'With collections counsel: contact goes through the attorney',
  in_collections: 'In collections: contact goes through the collector or counsel',
  lien_filed: 'Assessment lien filed: confirm with counsel before billing',
  judgment: 'Judgment entered: confirm with counsel before billing',
  on_payment_plan: 'On a payment plan: confirm the statement matches the plan terms',
};
function counselHoldReason(st) {
  if (!st || !st.state) return null;
  const r = COUNSEL_HOLD[st.state];
  if (!r) return null;
  const who = st.attorney_firm || st.attorney_name;
  return who ? `${r} (${who})` : r;
}
// Split built statements into mailable and held. states: active
// property_enforcement_states rows; legalFees: Map property_id -> cents of
// legal/attorney charges billed. Pure; tested in test_annual_statement_run.js.
function applyCounselHolds(good, states, legalFees = new Map()) {
  const byProp = new Map((states || []).map((x) => [x.property_id, x]));
  const mail = []; const held = []; const unflagged = [];
  for (const d of good) {
    const st = byProp.get(d.property_id);
    const reason = counselHoldReason(st);
    if (reason) { held.push({ d, state: st.state, reason, firm: st.attorney_firm || null }); continue; }
    mail.push(d);
    const fee = legalFees.get(d.property_id) || 0;
    if (fee > 0 && !st) unflagged.push({ d, legal_fees_cents: fee });
  }
  return { mail, held, unflagged };
}

const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const dollars = (c) => (Math.round(c || 0) / 100).toFixed(2);

async function main() {
  const { createClient } = require('@supabase/supabase-js');
  const { fetchAllQuery } = require('../lib/db/fetch_all');
  const { buildStatementData, renderStatementsHTML, renderCounselNoticesHTML } = require('../lib/statements/assessment_statement');
  const { lockboxFor } = require('../lib/payments/lockbox');
  const o = args();
  if (!o.community) throw new Error('--community "<name>" is required');
  const sample = o.sample ? Math.max(1, Number(o.sample)) : 0;
  const preview = !!o.preview && !sample;
  const out = path.resolve(o.out || '.');
  fs.mkdirSync(out, { recursive: true });
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data: comm, error: ce } = await s.from('communities').select('id, name, hoa_legal_name, portal_module_config').eq('name', o.community).maybeSingle();
  if (ce) throw ce;
  if (!comm) throw new Error(`community not found: ${o.community}`);
  const lockbox = lockboxFor(comm.name);
  const slug = comm.name.replace(/\W+/g, '_');

  let billing = null; let gates = { blockers: [], warnings: [], announcement: null, noticeText: null };
  if (!sample) {
    let announcementRaw = null;
    if (o.announce) {
      try { announcementRaw = JSON.parse(fs.readFileSync(path.resolve(o.announce), 'utf8')); } catch (e) { throw new Error(`--announce ${o.announce}: ${e.message}`); }
    }
    const year = Number(o.year);
    let budget = null;
    if (year) {
      const { data, error: be } = await s.from('community_budgets').select('id, status, approved_at').eq('community_id', comm.id).eq('fiscal_year', year).maybeSingle();
      if (be) throw be;
      budget = data;
    }
    gates = billingGates({ opts: o, community: comm, budget, lockbox, announcementRaw });
    billing = gates.billing;
  }
  if (gates.blockers.length) {
    const summary = { community: comm.name, mode: preview ? 'preview' : 'billing', status: 'BLOCKED', blockers: gates.blockers, warnings: gates.warnings };
    fs.writeFileSync(path.join(out, `${slug}_${preview ? 'PREVIEW_' : ''}BLOCKED.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(2);
  }

  const owners = await fetchAllQuery(() => s.from('v_current_property_owners')
    .select('property_id, street_address').eq('community_id', comm.id), { orderBy: 'property_id' });
  owners.sort((a, b) => String(a.street_address || '').localeCompare(String(b.street_address || ''), 'en', { numeric: true }));
  const pick = sample ? owners.slice(0, sample) : owners;

  const built = await pool(pick, 8, async (row) => {
    try {
      const d = await buildStatementData(s, row.property_id, { billing: sample ? null : billing, noticeText: gates.noticeText });
      return { d, row, why: validate(d, { lockbox, sample }) };
    } catch (e) { return { d: null, row, why: [e.message] }; }
  });
  // Every built statement (valid or not) goes through the counsel hold first:
  // a held account stays held even if it also has a validation problem, so
  // fixing that problem can never put it into a print file.
  const withD = built.filter((b) => b.d).map((b) => { b.d.property_id = b.d.property_id || b.row.property_id; b.d._why = b.why; return b.d; });

  // Counsel hold: active enforcement states + legal fees billed (for the
  // "possibly with counsel but not recorded" warning list).
  const states = await fetchAllQuery(() => s.from('property_enforcement_states')
    .select('id, property_id, state, attorney_firm, attorney_name, bankruptcy_case_number').eq('community_id', comm.id).is('ended_at', null), { orderBy: 'id' });
  if (!sample && o['counsel-add']) {
    const add = parseAccountList(fs.readFileSync(path.resolve(o['counsel-add']), 'utf8'));
    for (const [acct, rest] of add) {
      const d = withD.find((x) => String(x.account_number) === acct);
      const cut = rest.indexOf(',');   // a firm name may itself contain a comma ("..., P.C.")
      const state = (cut < 0 ? rest : rest.slice(0, cut)).trim(); const firm = cut < 0 ? null : rest.slice(cut + 1).trim();
      if (!d) throw new Error(`--counsel-add: account ${acct} is not in this association`);
      if (!COUNSEL_HOLD[state]) throw new Error(`--counsel-add: ${acct}: "${state}" is not a counsel state`);
      if (!states.some((x) => x.property_id === d.property_id)) states.push({ property_id: d.property_id, state, attorney_firm: firm || null });
    }
  }
  const legalRows = await fetchAllQuery(() => s.from('homeowner_transactions')
    .select('id, property_id, amount_cents, description').eq('community_id', comm.id)
    .or('description.ilike.%attorney%,description.ilike.%legal fee%'), { orderBy: 'id' });
  const legalFees = new Map();
  for (const r of legalRows) if (r.property_id && r.amount_cents > 0) legalFees.set(r.property_id, (legalFees.get(r.property_id) || 0) + r.amount_cents);
  const ch = sample ? { mail: withD, held: [], unflagged: [] } : applyCounselHolds(withD, states, legalFees);
  for (const h of ch.held) if (h.d._why && h.d._why.length) h.reason += `; also: ${h.d._why.join('; ')}`;
  const heldIds = new Set(ch.held.map((h) => h.d.property_id));
  const defer = !sample && o.defer ? parseAccountList(fs.readFileSync(path.resolve(o.defer), 'utf8')) : new Map();
  const df = applyDefer(ch.mail.filter((d) => !d._why.length), defer);
  const good = df.mail;
  const known = new Set(withD.map((d) => String(d.account_number)));
  const unknown = df.unmatched.filter((a) => !known.has(a));
  if (unknown.length) throw new Error(`--defer lists accounts not in this association: ${unknown.join(', ')}`);
  const cn = !sample && o['counsel-notices'] ? counselNotices(ch.held, JSON.parse(fs.readFileSync(path.resolve(o['counsel-notices']), 'utf8')), defer) : null;
  ch.unflagged = ch.unflagged.filter((u) => !u.d._why.length);
  const bad = built.filter((b) => !b.d || (b.why.length && !heldIds.has(b.d.property_id)));
  if (preview && gates.announcement && gates.announcement.preview_note) for (const d of good) d.sample_note = gates.announcement.preview_note;

  const label = sample ? 'SAMPLE - BANK SCANLINE TEST - NOT FOR MAILING' : preview ? PREVIEW_LABEL : null;
  const stem = `${slug}_${sample ? 'SAMPLE' : billing.year + '_annual' + (preview ? '_PREVIEW' : '')}`;
  const html = renderStatementsHTML(good, { sampleLabel: label, title: stem, ocrFontDataUri: lockbox ? ocrFontDataUri() : null, announcement: gates.announcement });
  fs.writeFileSync(path.join(out, `${stem}.html`), html);

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let ocrLoaded = false;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 0 });
    await page.evaluate(() => document.fonts.ready);
    ocrLoaded = await page.evaluate(() => document.fonts.check('12pt "StatementOCR"') && [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'StatementOCR' && f.status === 'loaded'));
    if (lockbox && good.length && !ocrLoaded) throw new Error('no OCR-A font is installed on this machine; the scanline would not read at the bank. Install OCR-A and rerun.');
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    fs.writeFileSync(path.join(out, `${stem}.pdf`), pdf);
    if (cn && cn.send.length) {
      const ch2 = renderCounselNoticesHTML(cn.send, { sampleLabel: label || 'DRAFT - COUNSEL APPROVAL REQUIRED', title: `${stem} counsel notices`, year: billing.year, assessment_cents: billing.assessment_cents, due_date: billing.due_date });
      const p2 = await browser.newPage();
      await p2.setContent(ch2, { waitUntil: 'load', timeout: 0 });
      fs.writeFileSync(path.join(out, `${stem}_counsel_notices.pdf`), await p2.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
    }
  } finally { await browser.close(); }

  // Manifest: one row per printed statement (total_due is prior + assessment
  // before the credit floor; pay_this_amount is what the coupon asks for).
  const head = ['account_number', 'owner', 'property', 'mail_street', 'mail_cityline', 'mailing_address_source', 'prior_balance', 'assessment', 'total_due', 'pay_this_amount', 'due_date', 'scanline'];
  const lines = [head.join(',')].concat(good.map((d) => [d.account_number, d.addressee.name, d.property_address, d.addressee.street, d.addressee.cityline, d.addressee_source || '',
    dollars(d.prior_balance_cents), billing ? dollars(billing.assessment_cents) : '', billing ? dollars(d.prior_balance_cents + billing.assessment_cents) : '', dollars(d.balance_cents), d.due_date, d.scanline || ''].map(csv).join(',')));
  fs.writeFileSync(path.join(out, `${stem}_manifest.csv`), lines.join('\n'));
  const exc = bad.map((b) => ({ account: b.d && b.d.account_number, owner: b.d && b.d.addressee && b.d.addressee.name, property: (b.d && b.d.property_address) || (b.row && b.row.street_address),
    prior_balance: b.d ? dollars(b.d.prior_balance_cents) : '', pay_this_amount: b.d ? dollars(b.d.balance_cents) : '', reasons: b.why }));
  fs.writeFileSync(path.join(out, `${stem}_counsel_hold.csv`), [['account_number', 'owner', 'property', 'prior_balance', 'held_because'].join(',')]
    .concat(ch.held.map((h) => [h.d.account_number, h.d.addressee && h.d.addressee.name, h.d.property_address, dollars(h.d.prior_balance_cents), h.reason].map(csv).join(',')))
    .concat(ch.unflagged.length ? ['', '"NOT HELD - legal fees billed but no enforcement state on file; confirm with counsel:"'] : [])
    .concat(ch.unflagged.map((u) => [u.d.account_number, u.d.addressee && u.d.addressee.name, u.d.property_address, dollars(u.d.prior_balance_cents), `legal fees billed ${dollars(u.legal_fees_cents)}; no state recorded`].map(csv).join(','))).join('\n'));
  fs.writeFileSync(path.join(out, `${stem}_exceptions.csv`), [['account_number', 'owner', 'property', 'prior_balance', 'pay_this_amount', 'reasons'].join(',')]
    .concat(exc.map((e) => [e.account, e.owner, e.property, e.prior_balance, e.pay_this_amount, e.reasons.join('; ')].map(csv).join(','))).join('\n'));
  if (defer.size) fs.writeFileSync(path.join(out, `${stem}_deferred.csv`), [['account_number', 'owner', 'property', 'prior_balance', 'reason'].join(',')]
    .concat(df.deferred.map((x) => [x.d.account_number, x.d.addressee && x.d.addressee.name, x.d.property_address, dollars(x.d.prior_balance_cents), x.reason].map(csv).join(','))).join('\n'));
  if (cn) fs.writeFileSync(path.join(out, `${stem}_counsel_notices.csv`), [['account_number', 'owner', 'property', 'mail_to', 'state', 'notice'].join(',')]
    .concat([...cn.send.map((x) => [x, 'prepared, counsel approval required']), ...cn.none.map((x) => [x, `none: ${x.why}`])]
      .map(([x, n]) => [x.d.account_number, x.d.addressee && x.d.addressee.name, x.d.property_address, x.d.addressee && `${x.d.addressee.street}, ${x.d.addressee.cityline}`, x.state, n].map(csv).join(','))).join('\n'));
  const summary = {
    community: comm.name, mode: sample ? 'sample' : preview ? 'preview' : 'billing', year: billing ? billing.year : null,
    assessment_per_lot: billing ? dollars(billing.assessment_cents) : null, due_date: billing ? billing.due_date : null,
    statements: good.length, exceptions: exc.length, owners_on_file: owners.length,
    counsel_hold: ch.held.length, counsel_unflagged_warnings: ch.unflagged.length,
    deferred: df.deferred.length, counsel_notices_prepared: cn ? cn.send.length : 0,
    reconciles: good.length + df.deferred.length + ch.held.length + exc.length === owners.length,
    pages: good.length * (gates.announcement ? 2 : 1), announcement_page: !!gates.announcement,
    total_prior_balance: dollars(good.reduce((t, d) => t + d.prior_balance_cents, 0)),
    total_pay_this_amount: dollars(good.reduce((t, d) => t + d.balance_cents, 0)),
    remit: good[0] ? good[0].remit.block : null,
    lockbox: lockbox ? { bank: lockbox.bank, association_code: lockbox.association_code, scanline_verified: !!lockbox.scanline_verified } : null,
    ocr_a_font_embedded: ocrLoaded,
    warnings: gates.warnings,
    cleared_for_mailing: false,
    hold_reason: (preview ? 'PREVIEW for review only; final run still requires the approved budget. ' : '') + 'built only; Ed authorizes distribution' + (lockbox && !lockbox.scanline_verified ? '; bank has not yet read-tested this association scanline' : ''),
    exceptions_detail: exc,
  };
  fs.writeFileSync(path.join(out, `${stem}_summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, exceptions_detail: exc.slice(0, 10) }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error('STOPPED:', e.message); process.exit(1); });

module.exports = { billingGates, validate, args, PREVIEW_LABEL, applyCounselHolds, counselHoldReason, COUNSEL_HOLD, parseAccountList, applyDefer, counselNotices };
