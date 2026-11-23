// ============================================================================
// lib/ar/iremit_receipts.js  (Ed 2026-11-23)
// ----------------------------------------------------------------------------
// NewFirst iRemit payments -> the EXISTING receipts planner (lib/ar/vantaca_receipts
// planReceipts: account match, duplicate holds, one bucket per item) -> entries for
// Kat's EXISTING journal-entry runs. No posting here, no second ledger: the owner
// approves each prepared entry in Kat's queue, as for the Waterview receipts of 11/17.
//
// A payment is prepared only when all of these are true; otherwise it is HELD with
// the reason, and nothing else waits on it:
//   * the file ties to its bank reports, row by row (extractor tieOut);
//   * the bank's association code is this community's;
//   * the bank's account number is a Vantaca account here, or a CONFIRMED crosswalk
//     entry maps it to one (most are pre-Vantaca C3 numbers);
//   * the name on the bank's report agrees with the lot's current owner;
//   * a lockbox check's image was reviewed (the payer on the check can differ from
//     the owner the bank coded it to, and only a person can read the image);
//   * no same-amount payment is on the account within DUP_WINDOW_DAYS from any
//     channel (Vantaca's Deposit Register can list the same payment), posted or waiting
//     in one of Kat's open runs, and no same-amount deposit is already on that cash
//     account (an unidentified deposit booked to suspense would be recorded twice).
// ============================================================================
const crypto = require('crypto');
const { planReceipts } = require('./vantaca_receipts');
const { ASSOCIATIONS } = require('../banking/extractors/newfirst_iremit');

const DUP_WINDOW_DAYS = 10;
const DEPOSIT_DAYS = 5;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const KIND = { echeck: 'eCheck', card: 'card', check: 'lockbox check' };

// Surnames and given names are written differently by every system; agreement is one
// shared word of 3+ letters. Too weak to match on, strong enough to stop a stranger.
const STOP = new Set(['AND', 'THE', 'LLC', 'INC', 'TRUST', 'JR', 'SR', 'III', 'LTD']);
const nameWords = (s) => new Set(String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
function namesAgree(a, b) { const B = nameWords(b); return [...nameWords(a)].some((w) => B.has(w)); }

// confirmed crosswalk rows for this association: bank account -> Vantaca account
function crosswalkIndex(rows, associationCode) {
  const out = new Map();
  for (const r of rows || []) {
    if (r.status !== 'confirmed' || String(r.association_code) !== associationCode) continue;
    const k = String(r.remittance_account);
    if (out.has(k) && out.get(k) !== String(r.vantaca_account_id)) out.set(k, null);   // two answers = no answer
    else if (!out.has(k)) out.set(k, String(r.vantaca_account_id));
  }
  return out;
}

/**
 * PURE. Tied files -> planner items for one community.
 * files = [{ sha256, filename, tie: { ok, problems, records } }]
 * owners = Map vantaca_account_id -> current owner name
 * reviewedChecks = Set of refs a person compared with the check image
 */
function toItems({ files, communityName, owners = new Map(), crosswalk = [], reviewedChecks = new Set() }) {
  const code = Object.keys(ASSOCIATIONS).find((k) => ASSOCIATIONS[k].community === communityName);
  if (!code) throw new Error(`${communityName} has no verified iRemit association code`);
  const xw = crosswalkIndex(crosswalk, code);
  const items = []; const excluded = []; const refused = []; const seen = new Set(); const seenFile = new Set();
  for (const f of files) {
    if (seenFile.has(f.sha256)) { refused.push({ file: f.filename, problems: ['the same file was given twice'] }); continue; }
    seenFile.add(f.sha256);
    if (!f.tie.ok) { refused.push({ file: f.filename, problems: f.tie.problems }); continue; }
    for (const r of f.tie.records) {
      if (r.association_code !== code) { excluded.push({ reason: ASSOCIATIONS[r.association_code] ? 'other_association' : 'unknown_association', association_code: r.association_code, amount_cents: r.amount_cents }); continue; }
      if (seen.has(r.ref)) { refused.push({ file: f.filename, problems: [`line ${r.line}: this payment is already in another file`] }); continue; }
      seen.add(r.ref);
      const direct = owners.has(r.account) ? r.account : null;
      const account = direct || xw.get(r.account) || null;
      let hold = null;
      if (r.account_irregular) hold = 'account_not_numeric_on_file';
      else if (!account) hold = xw.has(r.account) ? 'crosswalk_conflict' : 'account_not_in_crosswalk';
      else if (!namesAgree(r.bank_name, owners.get(account))) hold = 'bank_name_differs_from_owner';
      else if (r.kind === 'check' && !reviewedChecks.has(r.ref)) hold = 'check_image_review';
      items.push({
        source: 'iremit', category: 'payment', account, trxn_date: r.date, settle_date: r.date, signed_cents: r.amount_cents, amount_cents: r.amount_cents,
        method: r.kind, check_number: r.check_number, description: `NewFirst ${KIND[r.kind]}`, bank_last4: r.bank_last4 || null, report: 'newfirst_iremit',
        provenance: { artifact_sha256: f.sha256, file: f.filename, line: r.line, association_code: r.association_code, remittance_account: r.account, matched_by: direct ? 'vantaca_account' : account ? 'crosswalk' : null, batch: r.batch || null, seq: r.seq || null },
        corroborated_by: null, tuple: r.tuple, vantaca_ref: r.ref, dup_window_days: DUP_WINDOW_DAYS, ...(hold ? { hold } : {}),
      });
    }
  }
  return { items, excluded, refused, association_code: code };
}

// PURE. What Kat's open runs (prepared, approved, held, failed) would post:
// homeowner payments, and debits to accounts (the cash side of a deposit).
function pendingFromRuns(runs, ar) {
  const payments = []; const debits = [];
  for (const run of runs || []) {
    const pv = run.preview || {};
    for (const e of [...(pv.submitted || []), ...(pv.proposals || [])]) {
      const pay = (pid, lines, date, id) => {
        const c = (lines || []).filter((l) => l.account_number === ar).reduce((s, l) => s + (Number(l.credit_cents) || 0) - (Number(l.debit_cents) || 0), 0);
        if (pid && c > 0) payments.push({ id: `run:${run.id}:${id}`, vantaca_account_id: null, property_id: pid, date, amount_cents: c, source: 'kat_open_run' });
      };
      if (e.homeowner) pay(e.homeowner.property_id, e.lines, e.posting_date, e.id);
      for (const r of e.receipts || []) pay(r.property_id, r.lines, r.payment_date || e.posting_date, `${e.id}:${r.n}`);
      for (const l of e.lines || []) if (Number(l.debit_cents) > 0) debits.push({ account_number: l.account_number, amount_cents: Number(l.debit_cents), date: e.posting_date, ref: `run ${run.id} ${e.id}` });
    }
  }
  return { payments, debits };
}

// PURE. Planner items in one bucket each, then Kat's entries for the proposed ones.
// e-payments settle one bank line each; lockbox checks settle as one deposit per day.
function plan(normalized, facts, window) {
  const pending = pendingFromRuns(facts.openRuns, facts.gl.ar);
  const p = planReceipts({ items: normalized.items, excluded: [] }, { ...facts, existingPayments: [...facts.existingPayments, ...pending.payments] }, window);
  const cashDebits = [...(facts.cashDebits || []), ...pending.debits];
  const props = facts.gl;
  const und = facts.undeposited;
  if (!und) throw new Error('no undeposited funds account is configured for this community');
  const items = []; const groups = {};
  for (const it of p.items.filter((x) => x.status === 'proposed')) {
    if (it.match.owner !== 'current_owner') { it.status = 'held'; it.reason = 'not_the_current_owner'; continue; }
    const g = it.method === 'check' ? `check|${it.settle_date}` : `epay|${it.vantaca_ref}`;
    (groups[g] = groups[g] || []).push(it);
  }
  for (const list of Object.values(groups)) {
    const date = list[0].settle_date; const total = list.reduce((s, x) => s + x.amount_cents, 0);
    const cash = (list[0].bank_last4 && props.cash_by_last4[list[0].bank_last4]) || null;
    if (!cash) { for (const it of list) { it.status = 'held'; it.reason = 'bank_account_not_in_trusted'; } continue; }
    const already = cashDebits.find((d) => d.account_number === cash && d.amount_cents === total && Math.abs(Date.parse(d.date) - Date.parse(date)) <= DEPOSIT_DAYS * 864e5);
    if (already) { for (const it of list) { it.status = 'held'; it.reason = 'deposit_may_already_be_recorded'; it.duplicate_of = { date: already.date, ref: already.ref }; } continue; }
    for (const it of list) {
      const how = `${KIND[it.method]}${it.check_number ? ' #' + it.check_number : ''}`;
      items.push({ id: `iremit-${sha(it.vantaca_ref)}`, label: `Payment ${usd(it.amount_cents)} ${it.account} ${it.trxn_date}`, posting_date: it.trxn_date, description: `Payment - ${how}`,
        lines: [{ account_number: und, debit_cents: it.amount_cents, credit_cents: 0, memo: `${how} ${it.account} ${it.trxn_date}` }, { account_number: props.ar, debit_cents: 0, credit_cents: it.amount_cents, memo: `Payment ${it.account} ${it.trxn_date}` }],
        homeowner: { property_id: it.match.property_id, charge_category: 'payment' },
        evidence: { basis: `NewFirst iRemit payment for account ${it.account} on ${it.trxn_date}; the file equals its bank reports row by row.`, source: `${it.provenance.file} line ${it.provenance.line} sha256 ${it.provenance.artifact_sha256}${it.provenance.batch ? `; batch ${it.provenance.batch} seq ${it.provenance.seq}` : ''}` } });
    }
    items.push({ id: `iremit-dep-${sha(list.map((x) => x.vantaca_ref).sort().join('|'))}`, label: `Deposit ${usd(total)} ${date}`, posting_date: date, description: `NewFirst ${list[0].method === 'check' ? 'lockbox deposit' : 'electronic payment'} ${date}`,
      lines: [{ account_number: cash, debit_cents: total, credit_cents: 0, memo: `NewFirst iRemit ${date}` }, { account_number: und, debit_cents: 0, credit_cents: total, memo: `Deposit of ${list.length} payment(s) ${date}` }],
      evidence: { basis: `${list.length} iRemit payment(s) settled ${date}, ${usd(total)}; confirm to the bank line before approving.`, source: [...new Set(list.map((x) => x.provenance.file))].join(', ') } });
  }
  const bucket = (st) => p.items.filter((x) => x.status === st);
  const sum = (a) => a.reduce((s, x) => s + x.amount_cents, 0);
  const src = sum(normalized.items);
  const ties = ['proposed', 'held', 'already_imported', 'before_cutover', 'outside_window'].reduce((s, st) => s + sum(bucket(st)), 0) === src;
  return { items: p.items, kat_items: items, ties, source_cents: src, proposed_cents: sum(bucket('proposed')), held_cents: sum(bucket('held')) };
}

// Proposed deposits against the bank's own lines: every deposit must equal one
// credit of the same amount within the window, each bank line used once.
function matchBank(katItems, bankLines, { days = 3 } = {}) {
  const used = new Set(); const out = [];
  for (const d of katItems.filter((i) => i.id.startsWith('iremit-dep-'))) {
    const amt = d.lines[0].debit_cents;
    const c = (bankLines || []).filter((b) => !used.has(b.id) && b.amount_cents === amt && Math.abs(Date.parse(b.date) - Date.parse(d.posting_date)) <= days * 864e5);
    if (c.length === 1) { used.add(c[0].id); out.push({ id: d.id, amount_cents: amt, date: d.posting_date, status: 'matched', bank: c[0] }); }
    else out.push({ id: d.id, amount_cents: amt, date: d.posting_date, status: c.length ? 'several_bank_lines' : 'no_bank_line' });
  }
  return out;
}

module.exports = { toItems, plan, matchBank, namesAgree, crosswalkIndex, pendingFromRuns, DUP_WINDOW_DAYS };
