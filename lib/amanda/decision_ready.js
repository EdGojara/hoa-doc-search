// ============================================================================
// lib/amanda/decision_ready.js  (Ed 2026-10-16: "Amanda – Decision-Ready Manager Behavior")
// ----------------------------------------------------------------------------
// Amanda is the community manager, not an assistant waiting for the Board to
// manage her. She does every piece of management work that does not need Board
// judgment, legal authorization or spending approval, and returns to the Board
// only with the smallest decision that is actually theirs.
//
// Ed's three rules, enforced here:
//   1. Do the work first; ask the Board only for the Board's decision.
//   2. Use available system data before responding: retrieve -> analyze ->
//      decide -> respond. Never tell a Board member she "will check" the
//      balances, the budget, prior Board actions or fund availability when those
//      records are in trustEd. Say the numbers.
//   3. Never promise to do work after the response if it can be completed from
//      information available at response time.
//
// Three parts:
//   DECISION_READY_RULE    the system-prompt rule for Board-facing drafts
//   boardDecisionFacts()   the records she needs, retrieved BEFORE drafting:
//                          operating and reserve balances by fund, current-year
//                          budget vs actual, open payables, how current the books
//                          are (reconciliation and close status), recent Board
//                          actions, and the history of any vendor the message names
//   checkDecisionReady()   a deterministic check on the draft (CLAUDE.md: a prose
//                          rule the model ignores must become a check): passive
//                          "let me know" endings, promised system-accessible
//                          diligence, vague financial claims without figures, and
//                          options with no recommendation. One corrective retry.
// ============================================================================

const DECISION_READY_RULE = `DECISION-READY MANAGER (Ed's standing rule for every Board matter):
You are the community manager, not an assistant waiting for the Board to manage you. Do the work first. Ask the Board only for the decision that belongs to the Board.

RETRIEVE, ANALYZE, DECIDE, THEN RESPOND. The BOARD DECISION FACTS below were retrieved from trustEd before you started writing: balances by fund, the current budget against actual, open payables, how current the books are, recent Board actions, and the history of any vendor named. Use them. Never write that you will check, verify, review, calculate or look up the operating or reserve balances, the budget, fund availability, prior Board decisions, vendor history or invoices: those numbers are in front of you, so state them ("Canyon Gate has $X in operating cash and $Y in reserves; the budget line has $Z remaining; I recommend funding this from ..."). If a figure is missing, stale, unreconciled or marked unavailable below, name that specific limitation and escalate only that item. Never characterize finances vaguely ("given delinquency and cash position") without the actual figures.

NEVER PROMISE WORK YOU CAN FINISH NOW. If the work can be completed from what you have at this moment (compare the proposals, decide which one is current, total the multi-year cost, check the budget and cash, identify the funding source, list the missing terms), do it in this reply. Only work that genuinely needs someone else (a vendor's updated pricing, warranty terms, a certificate of insurance, counsel, the Board's vote) may be described as underway, and say exactly what you are requesting and from whom.

CURRENT VERSUS OBSOLETE. Decide from chronology and scope which proposal or document is current. Treat expired quotes, older versions, superseded scopes and duplicates as such without asking the Board to choose; an expired quote is not presently approvable, so say you are requesting refreshed pricing.

MANAGEMENT WORK YOU DO YOURSELF: compare proposals and normalize them to total cost (not the quoted price alone), identify missing terms and inconsistencies, check warranties and vendor compliance, check budget and cash, identify the likely funding source, prepare the approval package or agenda and ratification materials, and request routine vendor clarification that does not bind the Association.

ONLY THE BOARD (or an authorized human) DECIDES: a genuinely subjective choice with no defensible management recommendation, spending above management's delegated authority, entering or terminating a material contract, adopting policy, a legal judgment reserved to counsel or the Board, or a special assessment or other owner charge. Never manufacture a Board decision where one is not needed.

RECOMMEND. When the evidence supports a recommendation, make it plainly ("I recommend iTech's current proposal, subject to these confirmations"). Present alternatives only when they genuinely matter, and still say which one you recommend and why.

NEVER END WITH: "let me know how you would like to proceed", "tell me which proposal you want me to compare", "I can prepare a comparison if you would like", "would you like me to contact the vendor?", or any offer to do work you can already do.

STRUCTURE for a substantive Board matter, in this order, each short, as plain-text paragraphs that start with the label:
Situation: one or two sentences.
Recommendation: plainly stated.
Why: the essential analysis, with the actual figures.
Open items: only the material unresolved issues.
Action underway: what you are doing now that needs someone else.
Board decision needed: only if one is currently required; otherwise leave this out.
For a routine update or a simple question, answer directly without the structure. Optimize for less Board work, not for showing how much analysis you did.`;

const PASSIVE_CLOSERS = [
  /let me know how you(?:'d| would) like (?:me )?to proceed/i,
  /let me know (?:if|whether) you(?:'d| would) like (?:me )?to/i,
  /let me know which (?:proposal|option|quote|vendor|direction)/i,
  /tell me which (?:proposal|option|quote|one)/i,
  /would you like me to (?:contact|reach out|call|email|prepare|compare|pull|check|review|look|put together|draft|get)/i,
  /i can (?:prepare|put together|pull together|run|do) (?:a |an |the )?(?:comparison|analysis|summary|side-by-side)[^.?!]*if you(?:'d| would) like/i,
  /if you(?:'d| would) like,? i can (?:prepare|compare|contact|reach out|pull|check|review|look)/i,
  /happy to (?:prepare|compare|pull|put together|reach out|contact)[^.?!]*if you/i,
  /how would you like (?:me )?to proceed/i,
  /please advise how (?:you(?:'d| would) like )?to proceed/i,
];

const DATA_WORDS = '(?:current |latest |available |our |the )*(?:operating(?: and reserve)? (?:cash|accounts?|funds?|balances?)|reserve(?: and operating)?(?: fund| account| balance)?s?|(?:cash|bank) balances?|balances?|budget|budgeted amounts?|funds?(?: are)? available|fund(?:ing)? availability|funding source|financials?|prior board (?:decisions?|actions?|votes?|approvals?)|board (?:decisions?|actions?|minutes|history)|vendor history|invoices?|payment history|contract terms?)';
const DEFERRED_DILIGENCE = new RegExp(`\\b(?:i(?:'m| am| will|'ll)|we(?:'re| are| will|'ll)|let me)\\s+(?:be\\s+)?(?:now\\s+)?(?:check(?:ing)?|verify(?:ing)?|validat(?:e|ing)|review(?:ing)?|look(?:ing)?\\s+(?:up|at|into)|calculat(?:e|ing)|confirm(?:ing)?|pull(?:ing)?|run(?:ning)?)\\s+(?:on\\s+|whether\\s+)?${DATA_WORDS}`, 'i');
const OFFER_DILIGENCE = new RegExp(`\\bi can (?:check|verify|review|look (?:up|at|into)|pull|confirm)\\s+${DATA_WORDS}`, 'i');
const VAGUE_FINANCIAL = /\b(?:given|considering|in light of|based on)\s+(?:the |our )?(?:current |overall )?(?:delinquency|cash position|financial (?:position|condition|situation)|reserve (?:position|levels?|balance)|budget (?:position|constraints?)|funding (?:position|situation))/i;
const MONEY = /\$\s?\d/;

function sentences(text) {
  return String(text || '').replace(/\r\n/g, '\n').split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Deterministic check of a Board-facing draft. Returns { ok, issues:[{code, text}] }.
 *   passive_closer       ends by handing management work back to the Board
 *   deferred_diligence   promises to check / review records that are in trustEd
 *   vague_financial      characterizes finances without stating a figure
 *   no_recommendation    lists two or more options but recommends none
 */
function checkDecisionReady(text) {
  const issues = [];
  const ss = sentences(text);
  for (const s of ss) {
    if (PASSIVE_CLOSERS.some((re) => re.test(s))) issues.push({ code: 'passive_closer', text: s });
    if (DEFERRED_DILIGENCE.test(s) || OFFER_DILIGENCE.test(s)) issues.push({ code: 'deferred_diligence', text: s });
    if (VAGUE_FINANCIAL.test(s) && !MONEY.test(s)) issues.push({ code: 'vague_financial', text: s });
  }
  const optionLines = String(text || '').split('\n').filter((l) => /^\s*(?:\d+[.)]|option [a-c1-3]\b|[-*]\s+option)/i.test(l)).length;
  if (optionLines >= 2 && !/\brecommend/i.test(String(text || ''))) issues.push({ code: 'no_recommendation', text: `${optionLines} options listed without a recommendation` });
  return { ok: issues.length === 0, issues };
}

function retryNote(issues) {
  const lines = [];
  const has = (c) => issues.some((i) => i.code === c);
  if (has('deferred_diligence')) lines.push('- You promised to check or review records that are already in the BOARD DECISION FACTS. Remove the promise and state the actual figures and your conclusion now. If a figure is marked unavailable or stale there, name that limitation instead.');
  if (has('passive_closer')) lines.push('- You ended by handing management work back to the Board. Remove that ending; do the work, recommend, and ask only for a decision that belongs to the Board.');
  if (has('vague_financial')) lines.push('- You described the finances vaguely. Replace the characterization with the actual dollar figures from the BOARD DECISION FACTS.');
  if (has('no_recommendation')) lines.push('- You listed options without a recommendation. State which one you recommend and why.');
  return `REVISE YOUR DRAFT (Ed's decision-ready rule):\n${lines.join('\n')}\nOffending text: ${issues.map((i) => `"${i.text.slice(0, 160)}"`).join(' | ')}`;
}

// ---------------------------------------------------------------- the records
const money = (c) => { const n = Number(c || 0) / 100; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const todayCentral = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
async function pageAll(build, max = 20000) {
  const out = [];
  for (let f = 0; f < max; f += 1000) {
    const { data, error } = await build().range(f, f + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const counted = (je) => je && (je.status === 'posted' || (je.status === 'voided' && !!je.void_reversal_je_id));

/**
 * The records Amanda needs to decide a Board matter, retrieved before she drafts.
 * Read-only. Every part degrades to an explicit "unavailable" line, never silence,
 * so she can name the specific limitation instead of guessing.
 */
async function boardDecisionFacts(supabase, communityId, messageText = '', { today = todayCentral() } = {}) {
  if (!communityId) return '';
  const parts = [`AS OF ${today}.`];
  const year = today.slice(0, 4);

  // Accounts and funds (one read, reused below).
  let accounts = []; let funds = {};
  try {
    const [{ data: a, error: ae }, { data: f, error: fe }] = await Promise.all([
      supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, fund_id').eq('community_id', communityId),
      supabase.from('account_funds').select('id, fund_code, fund_name').eq('community_id', communityId),
    ]);
    if (ae) throw ae; if (fe) throw fe;
    accounts = a || []; funds = Object.fromEntries((f || []).map((x) => [x.id, x.fund_name || x.fund_code]));
  } catch (e) { parts.push(`ACCOUNTS: unavailable (${e.message}).`); }
  const acctById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  // 1. Cash and investments by fund (asset accounts 1000-1299: bank, money market, investments).
  try {
    const { data, error } = await supabase.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', communityId);
    if (error) throw error;
    const byNum = Object.fromEntries((data || []).map((r) => [String(r.account_number), Number(r.total_debits_cents || 0) - Number(r.total_credits_cents || 0)]));
    const cashAccts = accounts.filter((a) => a.account_type === 'asset' && /^1[0-2]\d\d$/.test(String(a.account_number)) && byNum[a.account_number]);
    const byFund = {};
    for (const a of cashAccts) { const k = funds[a.fund_id] || 'Unassigned fund'; (byFund[k] = byFund[k] || []).push(a); }
    const lines = Object.entries(byFund).map(([fund, list]) => `${fund}: ${money(list.reduce((t, a) => t + byNum[a.account_number], 0))} (${list.map((a) => `${a.account_number} ${a.account_name} ${money(byNum[a.account_number])}`).join('; ')})`);
    parts.push(`CASH AND INVESTMENTS BY FUND (GL balances today): ${lines.join(' | ') || 'none recorded'}.`);
  } catch (e) { parts.push(`CASH AND INVESTMENTS: unavailable (${e.message}).`); }

  // 2. How current the books are: latest reconciled month per bank account, open months.
  try {
    const [{ data: ba, error: be }, { data: recs, error: re }, { data: per, error: pe }] = await Promise.all([
      supabase.from('bank_accounts').select('id, account_nickname, account_last4, gl_account_number').eq('community_id', communityId),
      supabase.from('bank_reconciliations').select('bank_account_id, period_end, status').eq('community_id', communityId).limit(1000),
      supabase.from('accounting_periods').select('period_start, period_end, status').eq('community_id', communityId).lte('period_end', today).order('period_end', { ascending: false }).limit(24),
    ]);
    if (be) throw be; if (re) throw re; if (pe) throw pe;
    const recLines = (ba || []).map((b) => {
      const done = (recs || []).filter((r) => r.bank_account_id === b.id && r.status === 'reconciled').map((r) => r.period_end).sort().pop();
      return `${b.account_nickname || b.gl_account_number}${b.account_last4 ? ` ${b.account_last4}` : ''}: ${done ? `reconciled through ${done}` : 'no completed reconciliation'}`;
    });
    const lastClosed = (per || []).find((p) => ['closed', 'locked'].includes(p.status));
    parts.push(`BOOKS STATUS: ${recLines.join('; ') || 'no bank accounts'}. Last closed month: ${lastClosed ? lastClosed.period_end : 'none closed yet'}. Balances after the last reconciled month are not yet verified against the bank.`);
  } catch (e) { parts.push(`BOOKS STATUS: unavailable (${e.message}).`); }

  // 3. Current-year budget against actual (approved budget preferred, else the latest).
  try {
    const { data: buds, error: bde } = await supabase.from('community_budgets').select('id, fiscal_year, status').eq('community_id', communityId).eq('fiscal_year', Number(year));
    if (bde) throw bde;
    const bud = (buds || []).find((b) => /approved|adopted|final/i.test(b.status || '')) || (buds || [])[0];
    if (!bud) parts.push(`BUDGET ${year}: no budget on file.`);
    else {
      const items = await pageAll(() => supabase.from('budget_line_items').select('account_id, annual_amount_cents').eq('budget_id', bud.id).order('id'));
      const lines = await pageAll(() => supabase.from('journal_entry_lines').select('account_id, debit_cents, credit_cents, journal_entries!inner(posting_date, status, void_reversal_je_id, community_id)')
        .eq('journal_entries.community_id', communityId).gte('journal_entries.posting_date', `${year}-01-01`).lte('journal_entries.posting_date', today).order('id'));
      const actual = {};
      for (const l of lines) { if (!counted(l.journal_entries)) continue; actual[l.account_id] = (actual[l.account_id] || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0); }
      const rows = items.map((i) => { const a = acctById[i.account_id] || {}; const exp = a.account_type === 'expense'; const act = exp ? (actual[i.account_id] || 0) : -(actual[i.account_id] || 0); return { a, budget: Number(i.annual_amount_cents || 0), act, exp }; }).filter((r) => r.a.account_number);
      const ex = rows.filter((r) => r.exp); const rev = rows.filter((r) => !r.exp && r.a.account_type === 'revenue');
      const sum = (rs, k) => rs.reduce((t, r) => t + r[k], 0);
      const elapsed = Math.round((Date.parse(today) - Date.parse(`${year}-01-01`)) / (Date.parse(`${year}-12-31`) - Date.parse(`${year}-01-01`)) * 100);
      const top = ex.sort((x, y) => y.budget - x.budget).slice(0, 25).map((r) => `${r.a.account_number} ${r.a.account_name}: budget ${money(r.budget)}, actual ${money(r.act)}, remaining ${money(r.budget - r.act)}`);
      parts.push(`BUDGET ${year} (${bud.status || 'status unknown'}; ${elapsed}% of the year elapsed): revenue budget ${money(sum(rev, 'budget'))}, actual ${money(sum(rev, 'act'))}; expense budget ${money(sum(ex, 'budget'))}, actual ${money(sum(ex, 'act'))}, remaining ${money(sum(ex, 'budget') - sum(ex, 'act'))}. Largest expense lines: ${top.join('; ')}.`);
    }
  } catch (e) { parts.push(`BUDGET ${year}: unavailable (${e.message}).`); }

  // 4. Open payables (committed but unpaid).
  try {
    const { data, error } = await supabase.from('ap_invoices').select('total_cents, amount_paid_cents, status').eq('community_id', communityId).in('status', ['awaiting_approval', 'approved', 'partially_paid', 'on_hold', 'needs_review']).limit(2000);
    if (error) throw error;
    const open = (data || []).map((i) => Number(i.total_cents || 0) - Number(i.amount_paid_cents || 0)).filter((c) => c > 0);
    parts.push(`OPEN PAYABLES: ${open.length} unpaid bill(s) totaling ${money(open.reduce((t, c) => t + c, 0))}.`);
  } catch (e) { parts.push(`OPEN PAYABLES: unavailable (${e.message}).`); }

  // 5. Recent Board actions.
  try {
    const { data, error } = await supabase.from('board_motions').select('title, status, closed_at, opened_at, outcome_note').eq('community_id', communityId).order('created_at', { ascending: false }).limit(10);
    if (error) throw error;
    parts.push(`RECENT BOARD MOTIONS: ${(data || []).map((m) => `"${m.title}" ${m.status}${m.closed_at ? ` ${String(m.closed_at).slice(0, 10)}` : ''}${m.outcome_note ? ` (${String(m.outcome_note).slice(0, 80)})` : ''}`).join('; ') || 'none recorded in trustEd'}.`);
  } catch (e) { parts.push(`RECENT BOARD MOTIONS: unavailable (${e.message}).`); }

  // 6. Vendors the message names: 12-month spend, last bill, contract.
  try {
    const text = String(messageText || '').toLowerCase();
    if (text) {
      const { data: inv, error } = await supabase.from('ap_invoices').select('vendor_id, total_cents, invoice_date, status, vendors(name)').eq('community_id', communityId).gte('invoice_date', `${Number(year) - 1}${today.slice(4)}`).limit(5000);
      if (error) throw error;
      const byV = {};
      for (const i of inv || []) { const n = i.vendors && i.vendors.name; if (!n || i.status === 'voided') continue; const v = (byV[n] = byV[n] || { total: 0, n: 0, last: '', vendor_id: i.vendor_id }); v.total += Number(i.total_cents || 0); v.n += 1; if ((i.invoice_date || '') > v.last) v.last = i.invoice_date; }
      // Distinctive words only: legal suffixes, generic trade words and place names never identify a vendor
      // ("United Protective Services of South Texas" must not match "Texas Access Works").
      const significant = (name) => String(name).toLowerCase().replace(/[,.&]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !/^(llc|inc|corp|corporation|company|services?|group|management|solutions?|the|and|of|texas|south|north|east|west|houston|katy|central|national|american|united)$/.test(w));
      const named = Object.entries(byV).filter(([n]) => significant(n).some((w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, '')}\\b`).test(text)));
      const { data: cons } = await supabase.from('vendor_contracts').select('vendor_id, vendor_name_raw, end_date, annualized_amount, status').eq('community_id', communityId).eq('status', 'active').limit(200);
      // A contract belongs to the vendor by id; without an id, only when the first distinctive word matches.
      const contractFor = (n, v) => (cons || []).find((k) => k.vendor_id && k.vendor_id === v.vendor_id)
        || (cons || []).find((k) => !k.vendor_id && k.vendor_name_raw && significant(k.vendor_name_raw)[0] && significant(k.vendor_name_raw)[0] === significant(n)[0]);
      if (named.length) parts.push(`VENDORS NAMED IN THIS MESSAGE: ${named.map(([n, v]) => { const c = contractFor(n, v); return `${n}: ${v.n} bill(s), ${money(v.total)} in the last 12 months, last ${v.last}${c ? `; active contract${c.annualized_amount ? ` ${money(Math.round(Number(c.annualized_amount) * 100))}/yr` : ''}${c.end_date ? ` ending ${c.end_date}` : ''}` : '; no active contract on file'}`; }).join(' | ')}.`);
    }
  } catch (e) { parts.push(`VENDORS NAMED: unavailable (${e.message}).`); }

  return parts.join('\n');
}

module.exports = { DECISION_READY_RULE, checkDecisionReady, retryNote, boardDecisionFacts, PASSIVE_CLOSERS };
