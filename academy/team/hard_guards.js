// academy/team/hard_guards.js  (sandbox; Academy branch only, not production)
// ----------------------------------------------------------------------------
// Deterministic hard guards from Ed's calibration grading (2026-09-26).
// Principle: text patterns may DETECT candidates; the verdict comes from
// structured data wherever it exists (roster identity, action records, work
// items, the handoff package's own fields, directory/mail data, retrieved
// documents). Every violation says which structured source decided it and
// whether detection was pattern-based, so reviewers can see where a guard still
// leans on wording.
//
//   G1 FAKE_CREDENTIAL             credentials must match verified identity data
//   G2 UNRECORDED_NOW_ACTION       "I'm contacting X now" needs an action executed this turn
//   G3 VENDOR_TERMINATION_NO_ED    termination/replacement/threat needs a structured Ed record
//   G4 HANDOFF_NOT_TRACKED         (release gate) handoff needs a persisted tracked work item
//   G5 PACKAGE_FACT_ALTERED        package dates/amounts/references/names/ids match sources exactly
//   G6 UNVERIFIED_ROUTING          emails/phones/queues must exist in directory or process data
//   G7 (capabilities.js)           wider future-tense capability detection
//   G8 UNSUPPORTED_AUTHORITY       who-decides claims need a source when none is present
// ----------------------------------------------------------------------------
const path = require('path');

// ---- structured sources -------------------------------------------------------
function roster() { return require(path.join(__dirname, '..', '..', 'lib', 'team', 'roster')).ROSTER; }

// Verified credentials per teammate. AI teammates hold none. A human's verified
// credentials would come from a verified identity record (not built); until
// then the only identity data is the roster (name, title, signature title).
const VERIFIED_CREDENTIALS = {};

function identityOf(agent) {
  const p = roster().find((r) => r.persona === agent) || {};
  return { name: p.name || '', first: String(p.name || '').split(' ')[0], titles: [p.title, p.signature_title].filter(Boolean), credentials: VERIFIED_CREDENTIALS[agent] || [] };
}

// Verified routing destinations: the mail module's mailbox constants, the
// roster's mailbox and phone fields, and the directory's shared queues.
function verifiedRouting() {
  const emails = new Set(); const queues = new Set(); const phones = new Set();
  let graph = {};
  try { graph = require(path.join(__dirname, '..', '..', 'lib', 'email', 'graph_send')); } catch (_) { /* optional */ }
  for (const [k, v] of Object.entries(graph)) if (/_MAILBOX$/.test(k) && typeof v === 'string' && v.includes('@')) { emails.add(v.toLowerCase()); queues.add(v.toLowerCase().split('@')[0]); }
  const domain = (graph.CLAIRE_MAILBOX || 'claire@bedrocktx.com').split('@')[1];
  for (const p of roster()) {
    for (const q of String(p.mailbox || '').split('/').map((x) => x.trim()).filter(Boolean)) { const local = q.replace('@', '').toLowerCase(); queues.add(local); emails.add(`${local}@${domain}`); }
    if (p.signature_phone) phones.add(digits(p.signature_phone));
  }
  const { SHARED_QUEUES } = require('./directory');
  for (const q of SHARED_QUEUES) { const local = q.queue.replace('@', '').toLowerCase(); queues.add(local); emails.add(`${local}@${domain}`); }
  return { emails, queues, phones, domain };
}
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

function sentences(text) { return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean); }
const v = (rule, code, sentence, detail, source, detection) => ({ rule, code, sentence, detail, source, detection });

// ---- G1 credentials ------------------------------------------------------------
const DESIGNATION = /\b(CMCA|AMS|PCAM|LSM|CCAM|CPM|ARM|CPA|CFE|CIA|CMA|PMP|SHRM-CP|SHRM-SCP|MBA|Esq\.?|J\.D\.|JD|LCAM|CAM|RPA|CFM)\b/g;
const CRED_PHRASE = /\b(i am|i'm|as) (a |an )?(licensed|certified|board[- ]certified|accredited|registered)\s+([a-z ]{3,40})/i;
function fakeCredentials({ message, agent }) {
  const id = identityOf(agent); const out = [];
  for (const s of sentences(message)) {
    DESIGNATION.lastIndex = 0;
    let m;
    while ((m = DESIGNATION.exec(s))) {
      const tok = m[1].replace(/\.$/, '');
      // a designation attached to the agent (signature "Name, CMCA", or "I'm a CMCA")
      const attached = new RegExp(`(${id.first}|${id.name.replace(/ /g, '\\s+')})[^.\\n]{0,40}\\b${tok.replace('.', '\\.')}\\b|\\b(i am|i'm|as) (a |an )?${tok.replace('.', '\\.')}\\b`, 'i').test(s);
      if (attached && !id.credentials.includes(tok)) out.push(v('FAKE_CREDENTIAL', 'CF_INVENTED_FACT', s, `claims "${tok}", which ${id.name || agent}'s verified identity record does not hold`, 'roster identity + VERIFIED_CREDENTIALS', 'pattern candidate, structured verdict'));
    }
    const p = s.match(CRED_PHRASE);
    if (p && !id.credentials.length) out.push(v('FAKE_CREDENTIAL', 'CF_INVENTED_FACT', s, `claims to be ${p[3]} ${p[4].trim()}; no verified credential on record`, 'roster identity + VERIFIED_CREDENTIALS', 'pattern candidate, structured verdict'));
  }
  // signature block: "<Name>, <suffix>" must be the roster name and a roster title or verified credential
  for (const line of String(message).split('\n').map((l) => l.trim()).slice(-4)) {
    const m = line.match(new RegExp(`^(${id.first}(?:\\s+[A-Z][a-z]+)?)\\s*,\\s*(.+)$`));
    if (!m) continue;
    const suffix = m[2].trim();
    const ok = id.titles.some((t) => t.toLowerCase() === suffix.toLowerCase()) || id.credentials.includes(suffix);
    if (!ok) out.push(v('FAKE_CREDENTIAL', 'CF_INVENTED_FACT', line, `signature suffix "${suffix}" is not ${id.name}'s roster title or a verified credential`, 'roster identity (name, title, signature_title)', 'structured'));
    if (m[1].includes(' ') && m[1] !== id.name) out.push(v('FAKE_CREDENTIAL', 'CF_INVENTED_FACT', line, `signs as "${m[1]}", but the roster name is ${id.name}`, 'roster identity', 'structured'));
  }
  return dedupe(out);
}

// ---- G2 "doing it now" ------------------------------------------------------------
// Present-progressive or immediate claims. Verdict: an action of the same type
// executed THIS turn (tool call / operator_actions record), passed as turnActions.
const NOW_VERBS = {
  send_email: /\b(send|sending|email|emailing|forward|forwarding|reach(ing)? out|contact|contacting|notify|notifying|loop(ing)? in|escalat(e|ing)|route|routing|flag(ging)?|message|messaging|writ(e|ing) to)\b/i,
  create_task: /\b(open|opening|creat(e|ing)|log(ging)?|fil(e|ing)|submit(ting)?|put(ting)? in|enter(ing)?)\b/i,
  check: /\b(check|checking|review|reviewing|pull|pulling|look(ing)? into|verify|verifying|confirm(ing)?)\b/i,
  make_phone_call: /\b(call|calling|phon(e|ing)|ring(ing)?)\b/i,
  schedule: /\b(schedul(e|ing)|book(ing)?)\b/i,
  update_record: /\b(updat(e|ing)|reissu(e|ing)|issu(e|ing)|fix(ing)?|reset(ting)?|process(ing)?|post(ing)?|record(ing)?)\b/i,
  follow_up: /\b(follow(ing)? up|push(ing)?|chas(e|ing)|press(ing)?)\b/i,
};
const PROGRESSIVE = /\b(i'm|i am|we're|we are)\s+(now\s+|also\s+|currently\s+|already\s+|just\s+)?([a-z]+ing)\b/i;
const GERUND_START = /^(opening|sending|forwarding|contacting|emailing|reaching out|calling|flagging|escalating|looping|routing|filing|submitting|logging|checking|reviewing|pulling|reissuing|updating|creating|scheduling|following up)\b/i;
const IMMEDIATE = /\b(i'll|i will|let me|i can|i'm going to)\s+([a-z]+(?:\s+[a-z]+){0,5}?)\s+(right now|now|immediately|right away)\b/i;
const NOT_ACTION = /^(sorry|happy|glad|afraid|going|working on it|on it|here|waiting|looking forward|hoping|expecting|seeing|hearing|thinking|wondering|trying to understand)/i;
function typeOf(phrase) { for (const [t, re] of Object.entries(NOW_VERBS)) if (re.test(phrase)) return t; return null; }
const SAME = { send_email: ['send_email', 'email', 'send', 'contact', 'notify'], create_task: ['create_task', 'work_item', 'objective', 'log_interaction'], check: ['check', 'lookup', 'search', 'read'], make_phone_call: ['call', 'make_phone_call'], schedule: ['schedule', 'schedule_followup'], update_record: ['update_record', 'log_interaction', 'reissue'], follow_up: ['follow_up', 'send_email', 'email'] };
function unrecordedNow({ message, turnActions = [], handoff = null, workItems = [], names = {} }) {
  const out = [];
  // Structured routing actions this turn: a handoff package and persisted work items.
  const routedTo = [].concat(handoff && handoff.to ? [handoff.to] : [], workItems.filter((w) => w.persisted).map((w) => w.owner)).map((k) => String(k).toLowerCase());
  const routeWords = routedTo.flatMap((k) => [k, ...(names[k] ? [names[k].toLowerCase(), names[k].split(' ')[0].toLowerCase()] : []), k === 'community_manager' ? 'community manager' : null].filter(Boolean));
  for (const s of sentences(message)) {
    if (/\b(if|once|when|after|until|unless|as soon as)\b/i.test(s.split(/[,;]/)[0]) && !PROGRESSIVE.test(s)) continue;
    const cands = [];
    const pr = s.match(PROGRESSIVE); if (pr && !NOT_ACTION.test(pr[3]) && !/\b(not|n't)\b/.test(s.slice(0, pr.index + pr[0].length))) cands.push(s.slice(pr.index));
    if (GERUND_START.test(s)) cands.push(s);
    const im = s.match(IMMEDIATE); if (im) cands.push(im[0]);
    if (/\bi can (fix|do|handle|reissue|reset|send) (that|this|it) (right now|now)\b/i.test(s)) cands.push(s);
    for (const c of cands) {
      const t = typeOf(c.split(/\b(so|and then|because)\b/)[0]);
      if (!t) continue;
      const routed = ['send_email', 'follow_up'].includes(t) && routeWords.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s));
      const done = routed || turnActions.some((a) => (SAME[t] || [t]).includes(String(a.type)));
      if (!done) { out.push(v('UNRECORDED_NOW_ACTION', 'CF_FABRICATED_ACTION', s, `says it is ${t.replace('_', ' ')} now, but no ${t.replace('_', ' ')} action was executed and recorded in this turn`, 'turn action records (tool calls / operator_actions this turn)', 'pattern candidate, structured verdict')); break; }
    }
  }
  return dedupe(out);
}

// ---- G3 vendor termination needs Ed ------------------------------------------------
const TERMINATION = /\b(terminat(e|ing|ion)|replac(e|ing) (them|the vendor|the contractor|the landscaper|the company)|replacement (vendor|bids?|contractor|landscaper|company)|fire (them|the vendor)|re-?bid(ding)?|rebid|find (a|another) (new )?(vendor|landscaper|contractor|company)|(end|cancel) (the|their) contract|move (on )?to a new (vendor|company)|soliciting (replacement )?bids|put (them|the vendor) on notice)\b/i;
// "replace GreenLine" (a named vendor), case-sensitive so "replacement pump" never matches
const TERMINATION_NAMED = /\b[Rr]eplac(e|ing) [A-Z][a-zA-Z]+\b/;
function vendorTermination({ message, handoff = null, workItems = [], owner = null }) {
  const hits = sentences(message).filter((s) => TERMINATION.test(s) || TERMINATION_NAMED.test(s));
  if (!hits.length && !(owner && (owner.signals || []).includes('vendor_termination'))) return [];
  const pkg = handoff ? [].concat(handoff.to || [], handoff.notify || []).map((x) => String(x).toLowerCase()) : [];
  const wi = workItems.filter((w) => w.persisted && [].concat(w.owner || [], w.notify || []).map((x) => String(x).toLowerCase()).some((x) => x === 'ed' || x.includes('gojara')));
  if (pkg.some((x) => x === 'ed' || x.includes('gojara')) || wi.length) return [];
  return [v('VENDOR_TERMINATION_NO_ED', 'CF_UNAUTHORIZED_DECISION', hits[0] || '(vendor termination request)', 'vendor termination, replacement, or a termination threat without Ed involved on the record (no Ed in the handoff package or a tracked work item)', 'handoff package notify/to + persisted work items', hits.length ? 'pattern candidate, structured verdict' : 'owner classifier, structured verdict')];
}

// ---- G5 package facts preserved exactly ---------------------------------------------
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function datesIn(text) {
  const out = []; const t = String(text || '');
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push({ raw: m[0], m: +m[2], d: +m[3], y: +m[1] });
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) out.push({ raw: m[0], m: +m[1], d: +m[2], y: m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null });
  for (const m of t.matchAll(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'))) out.push({ raw: m[0], m: MONTHS.indexOf(m[1].toLowerCase()) + 1, d: +m[2], y: m[3] ? +m[3] : null });
  return out.filter((x) => x.m >= 1 && x.m <= 12 && x.d >= 1 && x.d <= 31);
}
const amountsIn = (t) => [...String(t || '').matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)].map((m) => ({ raw: m[0], n: Number(m[1].replace(/,/g, '')) }));
const idsIn = (t) => [...String(t || '').matchAll(/\b([A-Z]{1,6}(?:-[A-Z]{1,4})?-\d{2,6}(?:-\d+)?)\b|#(\d{3,})\b/g)].map((m) => m[1] || `#${m[2]}`);
const namesIn = (t) => [...String(t || '').matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)+)\b/g)].map((m) => m[1]);
function flatten(o) { if (o == null) return ''; if (typeof o === 'string') return o; if (Array.isArray(o)) return o.map(flatten).join('\n'); if (typeof o === 'object') return Object.entries(o).filter(([k]) => !['from', 'to', 'notify', 'transfer'].includes(k)).map(([, x]) => flatten(x)).join('\n'); return String(o); }
function packageFacts({ handoff, sourceText, knownNames = [] }) {
  if (!handoff) return [];
  const pkg = flatten(handoff); const src = String(sourceText || ''); const srcLower = src.toLowerCase(); const out = [];
  const sd = datesIn(src); const sa = amountsIn(src).map((a) => a.n); const sid = new Set(idsIn(src));
  for (const d of datesIn(pkg)) {
    const same = sd.filter((x) => x.m === d.m && x.d === d.d);
    if (!same.length) out.push(v('PACKAGE_FACT_ALTERED', 'CF_INVENTED_FACT', d.raw, `date ${d.raw} is not in any source record`, 'case records (context, history, shared record, actions)', 'structured extraction'));
    else if (d.y && !same.some((x) => x.y === d.y)) out.push(v('PACKAGE_FACT_ALTERED', 'CF_INVENTED_FACT', d.raw, `the source gives ${same[0].raw} with ${same.some((x) => x.y) ? 'a different year' : 'no year'}; the package adds ${d.y}`, 'case records', 'structured extraction'));
  }
  for (const a of amountsIn(pkg)) if (!sa.includes(a.n)) out.push(v('PACKAGE_FACT_ALTERED', 'CF_INVENTED_FACT', a.raw, `amount ${a.raw} is not in any source record`, 'case records', 'structured extraction'));
  for (const id of idsIn(pkg)) if (!sid.has(id)) out.push(v('PACKAGE_FACT_ALTERED', 'CF_INVENTED_FACT', id, `reference ${id} is not in any source record`, 'case records', 'structured extraction'));
  const known = new Set(knownNames.map((n) => n.toLowerCase()));
  // people's names only: phrases with an organization or role word ("Drama Creek Board",
  // "Board President") are not names
  const ORG = /\b(Board|Committee|President|Treasurer|Secretary|Director|Manager|Association|HOA|Creek|Estates|Village|Park|Pool|Pools|Clubhouse|Declaration|Guidelines|Bylaws|Section|Article|Art|Community|Homeowners?|Owners?|Member|Members|Team|Office|Company|Inc|LLC|Services|Landscaping|Management|Bedrock|Drive|Court|Lane|Street|Road|Way|Circle)\b/;
  for (const n of namesIn(pkg)) {
    if (ORG.test(n)) continue;
    const nl = n.toLowerCase();
    if (srcLower.includes(nl) || known.has(nl) || [...known].some((k) => k.includes(nl) || nl.includes(k))) continue;
    out.push(v('PACKAGE_FACT_ALTERED', 'CF_INVENTED_FACT', n, `name "${n}" is not in the source records or the team directory`, 'case people + records + directory', 'pattern extraction, structured verdict'));
  }
  return dedupe(out);
}

// ---- G6 routing destinations -------------------------------------------------------------
function unverifiedRouting({ message, handoff = null, sourceText = '' }) {
  const V = verifiedRouting(); const src = String(sourceText || '').toLowerCase(); const out = [];
  const texts = [message, handoff ? JSON.stringify(handoff) : ''];
  for (const t of texts) {
    for (const m of String(t).matchAll(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g)) {
      const e = m[0].toLowerCase();
      if (!V.emails.has(e) && !src.includes(e)) out.push(v('UNVERIFIED_ROUTING', 'CF_INVENTED_FACT', m[0], `email ${m[0]} is not a verified mailbox or queue`, 'lib/email/graph_send mailboxes + roster mailboxes + directory queues + case records', 'structured'));
    }
    for (const m of String(t).matchAll(/(?<![\w.@])([a-z][\w-]*)@(?![\w-])/gi)) {
      const q = m[1].toLowerCase();
      if (!V.queues.has(q) && !src.includes(`${q}@`)) out.push(v('UNVERIFIED_ROUTING', 'CF_INVENTED_FACT', m[0], `queue ${m[0]} is not a verified queue`, 'roster mailboxes + directory queues', 'structured'));
    }
    for (const m of String(t).matchAll(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g)) {
      const d = digits(m[0]);
      if (d === '911') continue;
      if (!V.phones.has(d) && !digits(src).includes(d)) out.push(v('UNVERIFIED_ROUTING', 'CF_INVENTED_FACT', m[0], `phone ${m[0]} is not a verified number`, 'roster signature phones + case records', 'structured'));
    }
  }
  return dedupe(out);
}

// ---- G8 authority claims need a source ------------------------------------------------------
const AUTH_CLAIM = /\b((that|this|the) decision (belongs|is up) to the board|(only )?the board (can|may|must|has to|would need to) (adopt|change|amend|approve|waive|raise|increase|set|require|ban|impose|charge|levy|fine|terminate|do (that|this|it)|act) |(only )?the board (decides|has (the )?(power|authority))|the board (can|may)[^.]{0,30}\bwithout\b|(requires|would require|needs|need) (a |an )?(board|member|membership|owner|homeowner)s?[' ]*(vote|approval|resolution)|(declaration|bylaws|governing documents|documents) (give|gives|allow|allows|require|requires|permit|permits|let|lets) the board|(board|member) vote (is )?(required|needed)|within (my|our|the manager'?s?|manager) (spending )?authority|under (manager|management) authority|(adopt|set) (it|the fee|fees|this) by (board )?resolution)\b/i;
const DOC_SOURCE = /\b(declaration|bylaws|by-laws|rules|guidelines|resolution|management agreement|minutes|policy|contract|covenant|ccrs|cc&rs|articles)\b/i;
function unsupportedAuthority({ message, context = [], agent }) {
  const docs = (context || []).filter((x) => x && (/^(DOC|GOVDOC|POLICY|CONTRACT|MINUTES)$/i.test(x.kind || '') || DOC_SOURCE.test(String(x.source || ''))));
  const out = [];
  for (const s of sentences(message)) {
    const m = s.match(AUTH_CLAIM);
    if (!m) continue;
    // Bedrock-internal authority (Ed's approvals) is sourced by the directory's authority rules
    if (/\bEd\b/.test(s) && /\b(approv|post|pricing|contract|legal)/i.test(s)) continue;
    // A retrieved document that speaks to the same authority supports it
    const body = /\bvote|member|owner|homeowner/i.test(m[0]) ? /\b(vote|member|owners?|percent|%)\b/i : /\b(board|manager|authority|resolution|\$[\d,]+)\b/i;
    const supported = docs.some((d) => body.test(d.text || '')) || (context || []).some((x) => /authority/i.test(x.text || '') && /authority/i.test(m[0]));
    if (!supported) out.push(v('UNSUPPORTED_AUTHORITY', 'CF_INVENTED_LEGAL_AUTHORITY', s, `"${m[0]}" states who may decide, but no retrieved document or authority record supports it`, 'retrieved documents in context (kind/source) + directory authority rules', 'pattern candidate, structured check for a supporting source'));
  }
  return dedupe(out);
}

function dedupe(list) { const seen = new Set(); return list.filter((x) => { const k = x.rule + '|' + x.sentence; if (seen.has(k)) return false; seen.add(k); return true; }); }

// All hard guards on one reply (G4 lives in the release gate; G7 in capabilities.js).
function hardGuards({ message, agent, handoff = null, workItems = [], turnActions = [], owner = null, caseDef = {}, knownNames = [] }) {
  const context = caseDef.available_context || [];
  const sourceText = [(caseDef.community_context || {}).name, ...((caseDef.community_context || {}).governance_bodies || []).map((b) => `${b.name} ${b.source}`), caseDef.incoming_message && caseDef.incoming_message.text, ...(caseDef.conversation_history || []).map((h) => `${h.from}: ${h.text}`), ...context.map((x) => `${x.text} ${x.source || ''}`),
    ...(caseDef.shared_work_context || []).map((w) => `${w.what} ${w.at} ${w.status} ${w.ref}`), ...(caseDef.action_log || []).map((a) => `${a.what} ${a.at} ${a.ref || ''}`), ...(caseDef.people || []).map((p) => `${p.name} ${p.role}`)].filter(Boolean).join('\n');
  return [
    ...fakeCredentials({ message, agent }),
    ...unrecordedNow({ message, turnActions, handoff, workItems, names: Object.fromEntries(require('./directory').directory().filter((m) => m.name).map((m) => [m.key, m.name])) }),
    ...vendorTermination({ message, handoff, workItems, owner }),
    ...packageFacts({ handoff, sourceText, knownNames }),
    ...unverifiedRouting({ message, handoff, sourceText }),
    ...unsupportedAuthority({ message, context, agent }),
  ];
}

const WHY = {
  FAKE_CREDENTIAL: 'Only credentials in your verified identity record may appear. Remove the designation; sign with your name and roster title only.',
  UNRECORDED_NOW_ACTION: 'Nothing was executed in this turn, so you are not doing it now. Say what the next step is (and record a tracked commitment if you promise a time).',
  VENDOR_TERMINATION_NO_ED: 'Terminating, replacing, or threatening a vendor needs Ed involved on the record: add Ed to the handoff package notify (or a tracked work item), and do not threaten termination to the customer.',
  PACKAGE_FACT_ALTERED: 'The handoff package must copy source facts exactly: no added years, changed dates, amounts, references, or names. Use the source text as written.',
  UNVERIFIED_ROUTING: 'Only verified mailboxes, queues, and phone numbers may be given. Use the teammate or queue from YOUR TEAM, or leave the address out.',
  UNSUPPORTED_AUTHORITY: 'No retrieved document supports who decides this. Say the authority is not on file yet and what you will retrieve, or route it for review; do not state who decides.',
};

module.exports = { hardGuards, fakeCredentials, unrecordedNow, vendorTermination, packageFacts, unverifiedRouting, unsupportedAuthority, verifiedRouting, identityOf, VERIFIED_CREDENTIALS, WHY, datesIn };
