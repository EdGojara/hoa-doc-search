// ============================================================================
// lib/banking/positive_pay_notice.js — a bank's Positive Pay exception notice is
// accounting work for Kat, never an email to answer (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// Scar: NewFirst's "Positive Pay Items Ready For Review" (10/14/2026) was treated
// as an ordinary email. Ed asked Kat to look into an unfamiliar recipient on it;
// the reply drafter instead wrote the bank that "Ed will review and release" the
// items, and the vendor follow-up matcher had linked the 10/13 reminder to an
// unrelated paid invoice. Positive Pay is the accounting manager's job; Ed is the
// exception authority.
//
// What this module does, for ANY bank's notice (no bank or community branch):
//   * detect: the subject says Positive Pay and the body lists presented items as
//     "<account ending> <date> <check number> <amount>" rows;
//   * match each item against the issued-check register on the community's bank
//     account with that ending: same check number, same amount, still issued (not
//     voided, stopped or already cleared), the payment and its invoices approved
//     and released; anything else is a discrepancy, never "probably fine";
//   * review the recipients: an address outside our own domains and the sending
//     bank's, or one not on the bank's earlier notices, is an unexpected third
//     party receiving account data, so it is escalated, never assumed legitimate;
//   * deadline: the earliest of the cutoff the notice states and the bank's
//     configured exception cutoff, in Central time.
// The decision itself (pay / return) is made in the bank's portal by an
// authorized person: there is no bank API, and nothing here authenticates to a
// bank or acts on one. Routine matches are prepared for that person; unmatched
// items and unexpected recipients go to Ed. Read-only.
// ============================================================================

const OWN_DOMAINS = (process.env.OWN_EMAIL_DOMAINS || 'bedrocktx.com,bedrocktxai.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const textOf = (email) => String((email && (email.body_full || email.body_preview)) || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const domainOf = (addr) => String(addr || '').toLowerCase().split('@')[1] || '';
const addrOf = (r) => String((r && (r.address || r.email || (r.emailAddress && r.emailAddress.address))) || r || '').trim().toLowerCase();

// Pure: the presented items, the stated cutoff, and whether the bank is reminding.
// Only the bank's OWN notice is read: a quoted earlier message inside a reply ("From: ...")
// is cut off so its rows are not counted twice.
function parseNotice(email) {
  let t = textOf(email);
  const quoted = t.search(/\bFrom:\s/); const own = quoted > 0 ? t.slice(0, quoted) : t;
  const rowsIn = (s) => {
    const out = []; const re = /\b(?:DDA|ACCT|SAV|CHK)?-?X+(\d{4})\s+([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,10})\s+\$\s?([\d,]+\.\d{2})/g; let m;
    while ((m = re.exec(s))) {
      const mo = MONTHS[m[2].toLowerCase()]; if (!mo) continue;
      out.push({ account_last4: m[1], presented_date: `${m[4]}-${String(mo).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`, check_number: String(Number(m[5])), amount_cents: Math.round(Number(m[6].replace(/,/g, '')) * 100) });
    }
    return out;
  };
  let items = rowsIn(own);
  const repliedTo = !items.length && quoted > 0;   // a bank person replying above the system notice
  if (repliedTo) items = rowsIn(t);
  const cut = own.match(/\bby\s+(\d{1,2}):(\d{2})\s*([AP])\.?M\b/i) || t.match(/\bby\s+(\d{1,2}):(\d{2})\s*([AP])\.?M\b/i);
  const stated_cutoff = cut ? `${String((Number(cut[1]) % 12) + (cut[3].toUpperCase() === 'P' ? 12 : 0)).padStart(2, '0')}:${cut[2]}` : null;
  return { items, stated_cutoff, reminder: /\breminder\b|\bstill (?:have|outstanding)\b/i.test(`${email.subject || ''} ${own}`), replied_by_person: repliedTo };
}

function isPositivePayNotice(email) {
  if (!email || email.direction === 'outbound') return false;
  if (!/positive\s*pay/i.test(`${email.subject || ''}`)) return false;
  if (OWN_DOMAINS.includes(domainOf(email.sender_email))) return false;
  return parseNotice(email).items.length > 0;
}

// Pure: who received account data. With the bank's expected list (banks.positive_pay_settings,
// mig 525) anyone else is unexpected; without it, anyone outside our domains and the bank's.
// New = not on any earlier notice from this bank.
function reviewRecipients(recipients, senderEmail, priorRecipientSets = [], expected = null) {
  const bank = domainOf(senderEmail);
  const all = [...new Set((recipients || []).map(addrOf).filter(Boolean))];
  const prior = new Set(priorRecipientSets.flat().map(addrOf));
  const exp = Array.isArray(expected) && expected.length ? new Set(expected.map(addrOf)) : null;
  const unexpected = exp ? all.filter((a) => !exp.has(a)) : all.filter((a) => !OWN_DOMAINS.includes(domainOf(a)) && domainOf(a) !== bank);
  const added = priorRecipientSets.length ? all.filter((a) => !prior.has(a)) : [];
  return { recipients: all, bank_domain: bank, unexpected, newly_added: added, checked_against: exp ? "the bank's expected recipients" : "our domains and the bank's" };
}

// Central-time deadline for the notice day: earliest of the stated and configured cutoffs.
function deadlineFor(receivedAt, statedHHMM, configuredHHMM) {
  const cand = [statedHHMM, configuredHHMM].filter((x) => /^\d{2}:\d{2}$/.test(String(x || ''))).sort();
  if (!cand.length || !receivedAt) return null;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(receivedAt));
  // Central offset for that calendar day (CDT -05:00 / CST -06:00)
  const probe = new Date(`${day}T12:00:00Z`);
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName').value; // "GMT-5"
  const off = Number((tz.match(/GMT([+-]\d+)/) || [0, -6])[1]);
  const iso = `${day}T${cand[0]}:00${off < 0 ? '-' : '+'}${String(Math.abs(off)).padStart(2, '0')}:00`;
  return { at: new Date(iso).toISOString(), central: `${cand[0]} Central on ${day}`, source: cand[0] === configuredHHMM && configuredHHMM !== statedHHMM ? 'bank configuration' : 'the notice' };
}

// Match one presented item against the books. facts = { accounts, register, payments, invoices, approvals } for the item.
function judgeItem(item, f) {
  const out = { ...item, verdict: 'discrepancy', reasons: [], community_id: null, community_name: null, bank_account_id: null, bank_account: null, payee: null, issue_date: null, je_reference: null, invoices: [] };
  if (!f.accounts.length) { out.reasons.push(`no active bank account ending ${item.account_last4} is on file`); return out; }
  if (f.accounts.length > 1) { out.reasons.push(`${f.accounts.length} bank accounts end in ${item.account_last4}; the account cannot be identified from the notice alone`); return out; }
  const a = f.accounts[0];
  Object.assign(out, { community_id: a.community_id, community_name: a.community_name || null, bank_account_id: a.id, bank_id: a.bank_id || null, bank_account: a.account_nickname || null });
  if (!f.register.length) { out.reasons.push(`check ${item.check_number} is not in the issued-check register for ${a.account_nickname || 'this account'}`); out.verdict = 'unmatched'; return out; }
  if (f.register.length > 1) { out.reasons.push(`check number ${item.check_number} appears ${f.register.length} times in the register`); return out; }
  const c = f.register[0];
  Object.assign(out, { payee: c.payee_name, issue_date: c.issue_date, register_amount_cents: Number(c.amount_cents), je_reference: f.je_reference || null });
  if (Number(c.amount_cents) !== item.amount_cents) out.reasons.push(`presented for ${money(item.amount_cents)} but issued for ${money(c.amount_cents)}`);
  if (c.status && c.status !== 'issued') out.reasons.push(`the register shows the check ${c.status}`);
  if (c.voided_at) out.reasons.push(`the check was voided ${String(c.voided_at).slice(0, 10)}`);
  if (c.stop_payment_at) out.reasons.push(`a stop payment was placed ${String(c.stop_payment_at).slice(0, 10)}`);
  if (c.cleared_date) out.reasons.push(`the check already cleared on ${c.cleared_date} (a second presentment)`);
  if (item.presented_date && c.issue_date && item.presented_date < String(c.issue_date).slice(0, 10)) out.reasons.push(`presented ${item.presented_date}, before its issue date ${c.issue_date}`);
  const p = f.payment;
  if (!p) out.reasons.push('no recorded payment is linked to the check');
  else if (p.status !== 'completed' || p.voided_at) out.reasons.push(`its payment is ${p.voided_at ? 'voided' : p.status}`);
  out.invoices = (f.invoices || []).map((i) => {
    const acts = (f.approvals || []).filter((x) => x.invoice_id === i.id);
    const approved = acts.find((x) => x.action === 'approved'); const released = acts.find((x) => x.action === 'released_for_payment');
    return { invoice_number: i.vendor_invoice_number || null, invoice_date: i.invoice_date, total_cents: Number(i.total_cents), approved_by: approved ? approved.user_name : null, released_by: released ? released.user_name : null };
  });
  if (p && !out.invoices.length) out.reasons.push('the payment pays no invoice on file');
  for (const i of out.invoices) {
    if (!i.approved_by) out.reasons.push(`invoice ${i.invoice_number || '(no number)'} has no recorded approval`);
    if (!i.released_by) out.reasons.push(`invoice ${i.invoice_number || '(no number)'} was not released for payment`);
  }
  const notes = out.invoices.filter((i) => !i.invoice_number).map(() => 'an invoice paid by this check has no invoice number');
  out.notes = [...new Set(notes)];
  if (!out.reasons.length) out.verdict = 'matched';
  return out;
}
const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function loadItemFacts(supabase, item) {
  const must = async (q, w) => { const { data, error } = await q; if (error) throw new Error(`${w}: ${error.message}`); return data || []; };
  const accts = (await must(supabase.from('bank_accounts').select('id, community_id, bank_id, account_nickname, account_last4, is_active, communities(name)').eq('account_last4', item.account_last4), 'bank accounts'))
    .filter((a) => a.is_active !== false).map((a) => ({ ...a, community_name: a.communities && a.communities.name }));
  if (accts.length !== 1) return { accounts: accts, register: [] };
  const register = await must(supabase.from('check_register').select('id, check_number, issue_date, payee_name, amount_cents, status, voided_at, stop_payment_at, cleared_date, ap_payment_id, posting_journal_entry_id').eq('bank_account_id', accts[0].id).eq('check_number', item.check_number), 'check register');
  if (register.length !== 1) return { accounts: accts, register };
  const c = register[0];
  const payment = c.ap_payment_id ? (await must(supabase.from('ap_payments').select('id, status, voided_at, amount_cents').eq('id', c.ap_payment_id), 'payment'))[0] || null : null;
  const apps = payment ? await must(supabase.from('ap_payment_applications').select('invoice_id').eq('payment_id', payment.id), 'applications') : [];
  const invoices = apps.length ? await must(supabase.from('ap_invoices').select('id, vendor_invoice_number, invoice_date, total_cents').in('id', apps.map((x) => x.invoice_id)), 'invoices') : [];
  const approvals = invoices.length ? await must(supabase.from('ap_invoice_approvals').select('invoice_id, action, user_name, created_at').in('invoice_id', invoices.map((i) => i.id)), 'approvals') : [];
  const je = c.posting_journal_entry_id ? (await must(supabase.from('journal_entries').select('reference').eq('id', c.posting_journal_entry_id), 'entry'))[0] : null;
  return { accounts: accts, register, payment, invoices, approvals, je_reference: je && je.reference };
}

/**
 * Kat's review of one notice: items matched against the books, recipients, deadline, and what
 * happens next. Read-only.
 * @returns {{items, recipients, deadline, routine, escalate:[string], next:string, summary:string}}
 */
async function reviewNotice(supabase, email, { settings = undefined } = {}) {
  const n = parseNotice(email);
  const items = [];
  for (const it of n.items) items.push(judgeItem(it, await loadItemFacts(supabase, it)));
  // the bank's own settings (cutoff, expected recipients), from the accounts the items are on
  if (settings === undefined) {
    settings = null;
    const bankIds = [...new Set(items.map((i) => i.bank_id).filter(Boolean))];
    if (bankIds.length === 1) {
      const { data, error } = await supabase.from('banks').select('name, positive_pay_settings').eq('id', bankIds[0]).limit(1);
      if (!error && data && data[0]) settings = { bank: data[0].name, ...(data[0].positive_pay_settings || {}) };   // column absent before mig 525: no settings
    }
  }
  const configuredCutoff = (settings && settings.exception_cutoff) || null;
  let prior = [];
  try {
    const { data, error } = await supabase.from('email_messages').select('recipients, received_at').ilike('sender_email', `%@${domainOf(email.sender_email)}`).ilike('subject', '%positive pay%').lt('received_at', email.received_at || new Date().toISOString()).order('received_at', { ascending: false }).limit(20);
    if (!error) prior = (data || []).map((m) => m.recipients || []);
  } catch (_) { /* no history: newly_added stays empty */ }
  const recipients = reviewRecipients(email.recipients, email.sender_email, prior, settings && settings.expected_recipients);
  const deadline = deadlineFor(email.received_at || new Date().toISOString(), n.stated_cutoff, configuredCutoff);
  const escalate = [];
  for (const i of items.filter((x) => x.verdict !== 'matched')) escalate.push(`${i.account_last4} check ${i.check_number} ${money(i.amount_cents)}: ${i.reasons.join('; ')}`);
  const strangers = [...new Set([...recipients.unexpected, ...recipients.newly_added.filter((a) => !OWN_DOMAINS.includes(domainOf(a)) && domainOf(a) !== recipients.bank_domain)])];
  if (settings && settings.notice_sender_domain && domainOf(email.sender_email) !== String(settings.notice_sender_domain).toLowerCase()) escalate.push(`the notice came from ${email.sender_email}, not the bank's notice domain ${settings.notice_sender_domain}`);
  if (strangers.length) escalate.push(`unexpected recipient${strangers.length > 1 ? 's' : ''} of our account data: ${strangers.join(', ')}${recipients.newly_added.some((a) => strangers.includes(a)) ? ' (not on the bank\'s earlier notices)' : ''}. Confirm with the bank by a known phone number before relying on this notice.`);
  const matched = items.filter((i) => i.verdict === 'matched');
  const next = escalate.length
    ? `Escalated to Ed: ${escalate.length} exception${escalate.length > 1 ? 's' : ''}. ${matched.length ? `${matched.length} matched item${matched.length > 1 ? 's are' : ' is'} ready to be decided Pay in the bank portal by an authorized user.` : ''}`
    : `All ${items.length} item${items.length === 1 ? '' : 's'} match the issued-check register: decide Pay in the bank portal${deadline ? ` before ${deadline.central}` : ''}. No reply to the bank is needed.`;
  const line = (i) => `${i.account_last4} #${i.check_number} ${money(i.amount_cents)}: ${i.verdict === 'matched' ? `MATCH (${i.community_name}, ${i.payee}, issued ${i.issue_date}${i.je_reference ? `, ${i.je_reference}` : ''})` : `${i.verdict.toUpperCase()} (${i.reasons.join('; ')})`}`;
  return { bank: (settings && settings.bank) || null, notice: { stated_cutoff: n.stated_cutoff, reminder: n.reminder, replied_by_person: n.replied_by_person }, items, recipients, deadline, routine: !escalate.length, escalate, next,
    summary: `Positive Pay${n.reminder ? ' reminder' : ''}: ${items.map(line).join(' | ')}.${escalate.length ? ` Exceptions: ${escalate.join(' | ')}` : ''} ${next}`.trim(),
    reviewed_at: new Date().toISOString(), reviewed_by: 'Kat Reed (AI accounting manager)' };
}

module.exports = { isPositivePayNotice, parseNotice, reviewRecipients, deadlineFor, judgeItem, reviewNotice, OWN_DOMAINS };
