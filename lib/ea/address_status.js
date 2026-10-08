// ============================================================================
// lib/ea/address_status.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// Which email addresses actually work. Tessa used to resolve a name to whatever
// address the book held, with no memory of what happened when she used it.
//
// Nicole Hill: the book had "Nicole Hill" <nicoleholtzhiII@aol.com> (a typo) and
// "Nicole Holtzhill" <nicoleholtzhill@aol.com>. The invite to the typo bounced,
// Tessa resent to the right address, Nicole replied from it, and the next
// day's confirmation went to the typo again and bounced again.
//
// The rules (migration 499 holds the evidence):
//   - A HARD bounce marks an address bounced. Nothing but a human restore
//     un-bounces it; a bounced address is never used again on its own.
//   - A person writing to us from an address verifies it.
//   - A later verified address supersedes a bounced one when the evidence ties
//     them to the same person: we wrote to the new address on the thread that
//     bounced, they replied on it after the bounce, and the new address is
//     either a near-typo of the old one or carries the contact's name. Several
//     such addresses = ambiguous = ask Ed, never a guess.
//   - Among several good addresses, the one with the most recent two-way
//     correspondence comes first.
//
// Pure functions are exported for tests; the store wraps the database so the
// regression test can run the whole flow in memory.
// ============================================================================

const lc = (s) => String(s || '').trim().toLowerCase();
const EMAIL_IN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Senders and subjects that are delivery reports, not people.
const DAEMON_RX = /^(?:mailer-daemon|postmaster|mail-?daemon|microsoftexchange[0-9a-f]*|bounce[s]?)@/i;
const DAEMON_NAME_RX = /mail delivery (?:subsystem|system)|mail delivery|postmaster|microsoft outlook/i;
const NDR_SUBJECT_RX = /^\s*(?:undeliverable|undelivered mail(?: returned to sender)?|delivery status notification \(failure\)|mail delivery failed|returned mail|failure notice|delivery failure|message not delivered|delivery has failed)\b/i;
// Permanent failures. "552 ... mailbox not found" is how Yahoo/AOL report a
// nonexistent mailbox (Nicole's NDR), so the reason text decides, not the code.
const HARD_RX = /mailbox (?:not found|unavailable|does not exist|doesn'?t exist)|(?:user|recipient|address) (?:unknown|not found|rejected)|no such (?:user|recipient|mailbox|address)|does ?n[o']t exist|invalid (?:recipient|address|mailbox)|couldn'?t be found|wasn'?t found|account (?:has been )?(?:disabled|deactivated|closed)|unrouteable|\b5\.1\.(?:0|1|2|3|6|10)\b|\b550\b/i;
// Temporary trouble is not a bounce. A full mailbox or a retry notice leaves
// the address alone.
const SOFT_RX = /mailbox (?:is )?full|over ?quota|quota exceeded|insufficient storage|temporar|try again|will retry|retrying|delayed|deferred|\b4\.\d\.\d+\b/i;
const NDR_PREFIX_RX = /^\s*(?:undeliverable|undelivered mail(?: returned to sender)?|delivery status notification \(failure\)|mail delivery failed|returned mail|failure notice|delivery failure|message not delivered|re|fw|fwd)\s*:\s*/i;

/** Subject with Re:/Fw:/Undeliverable: prefixes removed, lowercased. Pure. */
function normSubject(s) {
  let t = String(s || '');
  for (let i = 0; i < 6 && NDR_PREFIX_RX.test(t); i++) t = t.replace(NDR_PREFIX_RX, '');
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isAutomated(addr) {
  return /no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster|notifications?@|bounce|@.*(mailchimp|constantcontact|sendgrid|salesforce|hubspot)/i.test(String(addr || ''));
}

/**
 * Is this message a non-delivery report, and for which addresses? Pure.
 * msg: graph_search shape { from:{email,name}, to:[...], subject, preview, received_at, id }.
 * Returns null, or { failed:[emails], hard, reason, original_subject }.
 */
function parseNdr(msg, ownAddresses = []) {
  if (!msg) return null;
  const from = msg.from || {};
  const subject = String(msg.subject || '');
  const text = String(msg.preview || msg.body || '');
  const fromDaemon = DAEMON_RX.test(lc(from.email)) || DAEMON_NAME_RX.test(String(from.name || ''));
  if (!fromDaemon && !NDR_SUBJECT_RX.test(subject)) return null;
  const own = new Set(ownAddresses.map(lc));
  const failed = new Set();
  const patterns = [
    /failed to deliver to '([^']+)'/gi,
    /your message to\s+<?([^\s<>]+@[^\s<>]+?)>?\s+couldn'?t be delivered/gi,
    /([^\s<>'"]+@[^\s<>'"]+?)\s+wasn'?t found at/gi,
    /wasn'?t delivered to\s+<?([^\s<>]+@[^\s<>]+?)>?(?=[\s,;]|$)/gi,
    /delivery to the following recipients? failed[^:]*:\s*<?([^\s<>]+@[^\s<>]+)/gi,
    /(?:recipient|address)(?: address)?:\s*<?([^\s<>]+@[^\s<>]+)>?/gi,
    /<([^\s<>]+@[^\s<>]+)>:\s/g,
  ];
  for (const rx of patterns) {
    let m; rx.lastIndex = 0;
    while ((m = rx.exec(text))) { const e = lc(m[1]).replace(/[.,;:]+$/, ''); if (e.includes('@')) failed.add(e); }
  }
  // Some relays (AppRiver) address the report TO the failed recipient.
  if (!failed.size && fromDaemon) {
    for (const r of msg.to || []) { const e = lc(r.email); if (e && !own.has(e)) failed.add(e); }
  }
  for (const e of [...failed]) if (own.has(e) || isAutomated(e)) failed.delete(e);
  if (!failed.size) return null;
  const hay = `${subject}\n${text}`;
  const hard = HARD_RX.test(hay) || (!SOFT_RX.test(hay) && NDR_SUBJECT_RX.test(subject));
  // The SMTP reply is the most useful line: "552 1 Requested mail action aborted, mailbox not found".
  const reasonLine = (text.match(/\b[45]\d\d\b[ -][^\n]*/) || text.match(/[^\n]*(?:not found|unknown|rejected|does not exist|couldn'?t be found)[^\n]*/i) || [])[0];
  return {
    failed: [...failed],
    hard,
    reason: reasonLine ? reasonLine.replace(/\s+/g, ' ').trim().slice(0, 240) : null,
    original_subject: subject.replace(NDR_PREFIX_RX, '').trim(),
  };
}

/**
 * Evidence about ONE address found in a set of messages. Pure.
 * Returns event rows ready for ea_email_events.
 */
function eventsFromMessages(email, messages = [], ownAddresses = []) {
  const target = lc(email);
  const own = new Set(ownAddresses.map(lc));
  const out = [];
  for (const m of messages) {
    if (!m || !m.id) continue;
    const ndr = parseNdr(m, ownAddresses);
    if (ndr) {
      if (ndr.hard && ndr.failed.includes(target)) {
        out.push({ email: target, kind: 'bounce', message_ref: m.id, occurred_at: m.received_at, detail: { subject: ndr.original_subject, reason: ndr.reason } });
      }
      continue;
    }
    const from = lc(m.from && m.from.email);
    if (from === target && !own.has(from) && !isAutomated(from)) {
      out.push({ email: target, kind: 'inbound', message_ref: m.id, occurred_at: m.received_at, detail: { subject: m.subject || null, name: (m.from && m.from.name) || null } });
    }
  }
  return out;
}

/** Address status from its events. Pure. */
function statusFromEvents(email, events = []) {
  const e = lc(email);
  const mine = events.filter((x) => lc(x.email) === e);
  const latest = (kind) => mine.filter((x) => x.kind === kind).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))[0] || null;
  const bounce = latest('bounce'), restore = latest('restore'), inbound = latest('inbound');
  const bounced = !!bounce && !(restore && String(restore.occurred_at) >= String(bounce.occurred_at));
  const sup = bounced ? mine.filter((x) => x.kind === 'supersede').sort((a, b) => String(b.created_at || b.occurred_at).localeCompare(String(a.created_at || a.occurred_at)))[0] : null;
  return {
    email: e,
    bounced,
    last_bounce_at: bounce ? bounce.occurred_at : null,
    first_bounce_at: mine.filter((x) => x.kind === 'bounce').map((x) => x.occurred_at).sort()[0] || null,
    bounce_reason: bounce && bounce.detail ? bounce.detail.reason || null : null,
    bounce_subjects: [...new Set(mine.filter((x) => x.kind === 'bounce').map((x) => x.detail && x.detail.subject).filter(Boolean))],
    bounce_count: mine.filter((x) => x.kind === 'bounce').length,
    verified: !!inbound,
    last_inbound_at: inbound ? inbound.occurred_at : null,
    restored_at: restore ? restore.occurred_at : null,
    restored_by: restore ? restore.actor : null,
    superseded_by: sup ? lc(sup.related_email) : null,
  };
}

function statusMap(emails, events) {
  const map = {};
  for (const e of emails.map(lc).filter(Boolean)) map[e] = statusFromEvents(e, events);
  return map;
}

function levenshtein(a, b) {
  a = String(a); b = String(b);
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** A near-typo of the same mailbox: same domain, local part a few keystrokes off. Pure. */
function nearTypo(a, b) {
  const [la, da] = lc(a).split('@'); const [lb, db] = lc(b).split('@');
  if (!la || !lb || da !== db) return false;
  const d = levenshtein(la, lb);
  return d > 0 && d <= Math.max(2, Math.floor(Math.min(la.length, lb.length) * 0.2));
}

const words = (s) => lc(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
function nameCarries(displayName, contactName) {
  const want = words(contactName); if (!want.length) return false;
  const have = new Set(words(displayName));
  return want.every((w) => have.has(w));
}

/**
 * Who replaced a bounced address? Pure.
 *   bounced      the bounced address
 *   status       statusFromEvents(bounced) (bounce subjects + time)
 *   messages     mail on the bounced thread(s) (graph_search shape)
 *   contactNames names the book holds for the bounced address
 * Returns { email, evidence } | { ambiguous: [...] } | null.
 */
function findReplacement({ bounced, status, messages = [], ownAddresses = [], contactNames = [] }) {
  const bad = lc(bounced);
  const own = new Set(ownAddresses.map(lc));
  const subjects = new Set((status.bounce_subjects || []).map(normSubject).filter(Boolean));
  if (!subjects.size || !status.last_bounce_at) return null;
  // The reply must come after the FIRST bounce on the thread.
  const after = String(status.first_bounce_at || status.last_bounce_at);
  const wroteTo = new Map();   // address -> our outbound on the thread
  const replied = new Map();   // address -> their inbound on the thread, after the bounce
  for (const m of messages) {
    if (!m || !subjects.has(normSubject(m.subject)) || parseNdr(m, ownAddresses)) continue;
    const from = lc(m.from && m.from.email);
    if (own.has(from)) {
      for (const r of [...(m.to || []), ...(m.cc || [])]) {
        const e = lc(r.email); if (e && e !== bad && !own.has(e)) wroteTo.set(e, m);
      }
    } else if (from && from !== bad && !isAutomated(from)) {
      const prev = replied.get(from);
      if (!prev || String(m.received_at) > String(prev.received_at)) replied.set(from, m);
    }
  }
  const twoWay = [...replied.entries()]
    .filter(([e, m]) => wroteTo.has(e) && String(m.received_at || '') > after)
    .filter(([e, m]) => nearTypo(bad, e) || contactNames.some((n) => nameCarries(m.from && m.from.name, n)));
  if (!twoWay.length) return null;
  if (twoWay.length > 1) return { ambiguous: twoWay.map(([e]) => e) };
  const [email, m] = twoWay[0];
  return {
    email,
    message_ref: m.id,
    occurred_at: m.received_at,
    evidence: {
      bounced: bad, replacement: email, subject: m.subject || null,
      inbound_ref: m.id, inbound_at: m.received_at,
      outbound_ref: wroteTo.get(email).id, bounce_reason: status.bounce_reason || null,
      link: nearTypo(bad, email) ? 'near_typo' : 'name',
    },
  };
}

/**
 * Apply address status to resolver candidates. Pure.
 * Bounced -> replaced by its verified successor, else dropped. Then dedupe and
 * rank: recent two-way correspondence first, original order otherwise.
 */
function applyStatus(candidates = [], statuses = {}) {
  const kept = []; const dropped = []; const seen = new Set();
  candidates.forEach((c, i) => {
    let email = lc(c.email); if (!email) return;
    let st = statuses[email];
    let replaced_from = null;
    if (st && st.bounced) {
      const next = st.superseded_by && statuses[st.superseded_by];
      if (st.superseded_by && !(next && next.bounced)) { replaced_from = email; email = st.superseded_by; st = statuses[email] || null; }
      else { dropped.push({ ...c, email, bounced_at: st.last_bounce_at, bounce_reason: st.bounce_reason }); return; }
    }
    if (seen.has(email)) return;
    seen.add(email);
    kept.push({ c: { ...c, email, ...(replaced_from ? { replaced_from } : {}) }, i, inbound: (st && st.last_inbound_at) || '' });
  });
  kept.sort((a, b) => String(b.inbound).localeCompare(String(a.inbound)) || a.i - b.i);
  return { kept: kept.map((x) => x.c), dropped };
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------
function supabaseStore(sb) {
  return {
    async events(emails) {
      const list = [...new Set(emails.map(lc).filter(Boolean))];
      if (!list.length) return [];
      const { data, error } = await sb.from('ea_email_events')
        .select('email, kind, message_ref, occurred_at, related_email, actor, detail, created_at')
        .in('email', list).order('occurred_at', { ascending: true }).limit(1000);
      if (error) throw error;
      return data || [];
    },
    async addEvents(rows) {
      const clean = rows.filter((r) => r && r.email && r.message_ref && r.occurred_at);
      if (!clean.length) return 0;
      const { error } = await sb.from('ea_email_events')
        .upsert(clean.map((r) => ({ actor: 'system', detail: {}, ...r, email: lc(r.email) })), { onConflict: 'email,kind,message_ref', ignoreDuplicates: true });
      if (error) throw error;
      return clean.length;
    },
    async supersede({ bad, good, message_ref, occurred_at, evidence, actor = 'tessa' }) {
      const { data, error } = await sb.rpc('ea_supersede_email', {
        p_bad: bad, p_good: good, p_message_ref: message_ref, p_occurred_at: occurred_at, p_evidence: evidence || {}, p_actor: actor,
      });
      if (error) throw error;
      return data;
    },
    async contactNames(email) {
      const { data, error } = await sb.from('ea_contacts').select('name').ilike('email', String(email).replace(/([%_\\])/g, '\\$1')).limit(5);
      if (error) throw error;
      return (data || []).map((r) => r.name).filter(Boolean);
    },
    async restore(email, actor) {
      if (!actor || actor === 'system') throw new Error('a restore must name the person restoring the address');
      const now = new Date().toISOString();
      return this.addEvents([{ email, kind: 'restore', message_ref: 'restore:' + now, occurred_at: now, actor, detail: {} }]);
    },
  };
}

// Same semantics as the database (ea_supersede_email included), in memory.
function memoryStore({ contacts = [] } = {}) {
  const evs = [];
  const history = [];
  const store = {
    contacts, history, evs,
    async events(emails) { const s = new Set(emails.map(lc)); return evs.filter((e) => s.has(e.email)); },
    async addEvents(rows) {
      let n = 0;
      for (const r of rows) {
        const e = { actor: 'system', detail: {}, ...r, email: lc(r.email), created_at: new Date().toISOString() };
        if (evs.some((x) => x.email === e.email && x.kind === e.kind && x.message_ref === e.message_ref)) continue;
        evs.push(e); n++;
      }
      return n;
    },
    async supersede({ bad, good, message_ref, occurred_at, evidence, actor = 'tessa' }) {
      bad = lc(bad); good = lc(good);
      if (!statusFromEvents(bad, evs).bounced) throw new Error(`${bad} has no unrestored bounce on file`);
      if (statusFromEvents(good, evs).bounced) throw new Error(`the replacement ${good} has bounced too`);
      await store.addEvents([{ email: bad, kind: 'supersede', message_ref, occurred_at, related_email: good, actor, detail: evidence || {} }]);
      let holder = contacts.find((c) => lc(c.email) === good) || null;
      for (const c of contacts.filter((x) => lc(x.email) === bad)) {
        if (!holder) { history.push({ contact_id: c.id, old_email: c.email, new_email: good }); c.email = good; holder = c; }
        else { history.push({ contact_id: c.id, old_email: c.email, new_email: good, merged_into_contact_id: holder.id }); c.email = null; c.superseded_by_contact_id = holder.id; }
      }
      return { bad, good };
    },
    async contactNames(email) { return contacts.filter((c) => lc(c.email) === lc(email)).map((c) => c.name); },
    async restore(email, actor) {
      if (!actor || actor === 'system') throw new Error('a restore must name the person restoring the address');
      const now = new Date().toISOString();
      return store.addEvents([{ email, kind: 'restore', message_ref: 'restore:' + now, occurred_at: now, actor }]);
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Live check (Graph): learn what the mailboxes already know about an address
// before Tessa uses it. Email ingest is manual-only, so the database cannot be
// trusted to have seen the bounce yet; the mailbox always has.
// ---------------------------------------------------------------------------
async function learnFromMailboxes(emails, { store, searchMailbox, mailboxes = [], ownAddresses = [] }) {
  const own = [...new Set([...mailboxes, ...ownAddresses].map(lc).filter(Boolean))];
  const list = [...new Set(emails.map(lc).filter(Boolean))];
  if (!store || !list.length) return {};
  const search = async (term) => {
    const out = [];
    if (!searchMailbox) return out;
    for (const mb of mailboxes) {
      if (!mb) continue;
      try { const r = await searchMailbox(mb, term, { top: 25 }); out.push(...((r && r.messages) || [])); }
      catch (e) { console.warn('[tessa] address check: mailbox search failed for', mb, e.message); }
    }
    return out;
  };
  for (const email of list) {
    const found = await search(email);
    const evs = eventsFromMessages(email, found, own);
    if (evs.length) await store.addEvents(evs);
  }
  let statuses = statusMap(list, await store.events(list));
  for (const email of list) {
    const st = statuses[email];
    if (!st.bounced || st.superseded_by) continue;
    const thread = [];
    for (const s of st.bounce_subjects.slice(0, 3)) thread.push(...await search(s));
    const contactNames = await store.contactNames(email).catch(() => []);
    const rep = findReplacement({ bounced: email, status: st, messages: thread, ownAddresses: own, contactNames });
    if (rep && rep.email) {
      // The replacement wrote to us: that is verification in its own right.
      await store.addEvents([{ email: rep.email, kind: 'inbound', message_ref: rep.message_ref, occurred_at: rep.occurred_at, detail: { subject: rep.evidence.subject } }]);
      try { await store.supersede({ bad: email, good: rep.email, message_ref: rep.message_ref, occurred_at: rep.occurred_at, evidence: rep.evidence }); }
      catch (e) { console.warn('[tessa] address check: supersede refused:', e.message); }
    } else if (rep && rep.ambiguous) {
      console.warn('[tessa] address check:', email, 'bounced; several possible replacements, asking Ed:', rep.ambiguous.join(', '));
    }
  }
  const all = new Set(list);
  for (const st of Object.values(statuses)) if (st.superseded_by) all.add(st.superseded_by);
  statuses = statusMap([...all], await store.events([...all]));
  // A freshly recorded supersede target needs its own status too.
  for (const st of Object.values({ ...statuses })) if (st.superseded_by && !statuses[st.superseded_by]) {
    Object.assign(statuses, statusMap([st.superseded_by], await store.events([st.superseded_by])));
  }
  return statuses;
}

const SHORT_REASON_RX = /mailbox not found|mailbox unavailable|user unknown|recipient not found|address not found|does ?n[o']t exist|couldn'?t be found|wasn'?t found|address rejected|recipient rejected|account (?:has been )?(?:disabled|closed)/i;
const shortReason = (r) => { const m = String(r || '').match(SHORT_REASON_RX); return m ? m[0].toLowerCase() : null; };

const fmtDay = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return String(iso || '').slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
};

/**
 * The resolver step: check every resolved person's address and swap or drop the
 * bounced ones. Fails soft (warns, returns the input) when the store is down.
 * resolved: resolveOne output { people, question, ... }.
 */
async function checkResolved(resolved, ctx) {
  if (!resolved || !ctx || !ctx.addressStore || !(resolved.people || []).length) return resolved;
  let statuses;
  try {
    statuses = await learnFromMailboxes(resolved.people.map((p) => p.email), {
      store: ctx.addressStore, searchMailbox: ctx.searchMailbox, mailboxes: ctx.mailboxes || [], ownAddresses: ctx.ownAddresses || [],
    });
  } catch (e) {
    console.warn('[tessa] address check skipped:', e.message);
    return resolved;
  }
  const { kept, dropped } = applyStatus(resolved.people, statuses);
  const notes = kept.filter((p) => p.replaced_from).map((p) => `${p.replaced_from} bounced; using ${p.email}, which ${p.name || 'they'} replied from.`);
  if (!dropped.length && !notes.length) return resolved;
  const out = { ...resolved, people: kept.map(({ replaced_from, ...p }) => ({ ...p, ...(replaced_from ? { replaced_from } : {}) })) };
  // Never save a bounced address back into the book.
  if (out.save_contact) {
    const sc = lc(out.save_contact.email);
    const swap = kept.find((p) => p.replaced_from === sc);
    if (swap) out.save_contact = { ...out.save_contact, email: swap.email };
    else if (dropped.some((d) => d.email === sc)) delete out.save_contact;
  }
  if (notes.length) out.address_notes = notes;
  if (dropped.length) {
    out.bounced = dropped.map((d) => ({ name: d.name, email: d.email, bounced_at: d.bounced_at, reason: d.bounce_reason }));
    if (!kept.length) {
      const d = dropped[0];
      const why = shortReason(d.bounce_reason);
      out.question = `${d.email} bounced on ${fmtDay(d.bounced_at)}${why ? ' (' + why + ')' : ''}, and I don't have a working address for ${d.name || resolved.hint} yet. What's the right one?`;
      out.reason = 'bounced';
    }
  }
  return out;
}

// Which of these recipients are bounced right now? DB evidence, plus a live
// mailbox look when searchMailbox is given (ingest is manual, so the mailbox may
// know first). Returns [{ email, bounced_at, reason, superseded_by }].
async function bouncedAmong(emails, { store, searchMailbox = null, mailboxes = [], ownAddresses = [] }) {
  const list = [...new Set((emails || []).map(lc).filter(Boolean))];
  if (!store || !list.length) return [];
  let statuses;
  if (searchMailbox && list.length <= 10) statuses = await learnFromMailboxes(list, { store, searchMailbox, mailboxes, ownAddresses });
  else statuses = statusMap(list, await store.events(list));
  return list.filter((e) => statuses[e] && statuses[e].bounced)
    .map((e) => ({ email: e, bounced_at: statuses[e].last_bounce_at, reason: statuses[e].bounce_reason, superseded_by: statuses[e].superseded_by }));
}

function bouncedMessage(list) {
  return list.map((b) => `${b.email} bounced on ${fmtDay(b.bounced_at)}${shortReason(b.reason) ? ' (' + shortReason(b.reason) + ')' : ''}`
    + (b.superseded_by ? `; use ${b.superseded_by}, which they replied from` : '; there is no working address on file yet')).join('. ')
    + '. Nothing was sent. If the old address really is right again, restore it in the address book first.';
}

module.exports = {
  bouncedAmong, bouncedMessage,
  parseNdr, eventsFromMessages, statusFromEvents, statusMap, findReplacement, applyStatus,
  normSubject, nearTypo, levenshtein, supabaseStore, memoryStore, learnFromMailboxes, checkResolved,
};
