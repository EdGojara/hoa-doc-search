// ============================================================================
// lib/legal/research.js — Amanda's evidence research for a legal invoice
// (Ed 2026-10-11)
// ----------------------------------------------------------------------------
// For every owner-attributed line on a reviewed attorney invoice, Amanda
// searches what Bedrock already holds BEFORE anyone contacts an outsider:
//
//   trustEd   ownership tenures, collections / bankruptcy record, violations
//             and certified letters, the owner ledger (prior legal fees, a
//             charge already carrying this invoice number)
//   email     the live mailboxes (lib/email/graph_search), and the attorney's
//             status-report attachments read as text (pdf-parse / mammoth)
//   OneDrive  the owner's drive (searchDrive); notice letters are opened and
//             read, not just listed
//   documents the community's governing documents (hybrid retrieval)
//   retained  originals already kept in trustEd (lib/legal/evidence_store):
//             notice letters and attorney status reports, read from the stored
//             original, matched on the house number (never the street alone)
//
// Every finding records its source. VERIFIED = Amanda read the record or the
// document text itself. REFERENCE = located (a file name, an email subject)
// but not read. ASSUMPTION = inferred (e.g. a certified-letter fee implies a
// letter).
//
// Every owner line ends in one of three outcomes (Ed 2026-10-11):
//   ready             the treatment is complete; the owner approves it (any
//                     limitation, e.g. no independent mailing proof, is stated)
//   needs_information specific evidence is missing from every accessible record
//   needs_decision    a genuine legal / accounting / policy judgment
// The work type (collections vs DRV) is established from evidence on its own,
// whatever the recoverability outcome; it is never defaulted.
//
// No posting, no email, no external contact. External requests are drafted
// only when every internal source was searched and the evidence is missing,
// and they are held for the owner's approval.
// ============================================================================

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_RE = new RegExp(`(?:${MONTHS}) \\d{1,2}, \\d{4}|\\d{1,2}/\\d{1,2}/\\d{2,4}`);
const CERT_RE = /certified mail(?: no\.?| number)?[:\s#]*((?:\d[\s-]?){20,22})/i;
const NOTICE_NAME_RE = /209|final demand|notice of violation|violation hearing|certified|delinquen|demand letter|past due/i;
const STATUS_REPORT_RE = /status report|collection status|enforcement matters/i;
const MATTER_RE = /\b\d{4,6}[.\-]\d{4,6}\b/;
const YEAR_RANGE = /^(?:19|20)\d{2}[.\-](?:19|20)\d{2}$/;   // "2019-2021" is a span of years, not a matter
const ATTORNEY_FEE_CATEGORIES = ['attorney_fee', 'attorney_fee_other'];

const must = (r, what) => { if (r && r.error) throw Object.assign(new Error(`${what}: ${r.error.message}`), { cause: r.error }); return (r && r.data) || []; };
const clip = (s, n = 280) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const streetOf = (addr) => String(addr || '').replace(/\b(drive|dr|court|ct|lane|ln|way|wy|trail|trl|circle|cir|street|st|road|rd)\.?$/i, '').trim();
function surnameOf(names) {
  const first = (names || []).find(Boolean);
  if (!first) return null;
  const parts = String(first).replace(/[,&]/g, ' ').split(/\s+/).filter((p) => p.length > 2 && !/^(jr|sr|ii|iii|the|and|trust|llc|inc)\.?$/i.test(p));
  return parts.length ? parts[parts.length - 1] : null;
}

// The address the attorney's report gives for this matter (its heading, e.g.
// "NEGRON, HEIDI – 6505 Kings Summit Dr."), compared with the property's. Same
// street, different house number = an address discrepancy to show the owner.
const ADDR_RE = /(\d{3,6})\s+((?:[A-Z][a-z]+\s){1,3})(?:Dr|Drive|Ct|Court|Way|Ln|Lane|Trl|Trail|Cir|Circle|St|Street|Rd|Road|Blvd|Pl|Place|Loop|Pass|Bend|Cv|Cove)\b\.?/;
function addressCheck(f, passage, propertyAddress, source) {
  const m = ADDR_RE.exec(String(passage || '').slice(0, 260));
  const p = ADDR_RE.exec(String(propertyAddress || ''));
  if (!m || !p) return;
  const street = (x) => x.trim().toLowerCase();
  if (street(m[2]) === street(p[2]) && m[1] !== p[1]) {
    f.signals.address_discrepancy = { report: m[0].trim(), property: String(propertyAddress).trim(), source };
  }
}

// The bankruptcy status from the most recent dated source wins (an undated
// source never overrides a dated one).
function setBankruptcy(f, b) {
  const cur = f.signals.bankruptcy;
  if (!cur || (b.as_of && (!cur.as_of || String(b.as_of) >= String(cur.as_of))) || (!b.as_of && !cur.as_of)) f.signals.bankruptcy = b;
}

// Window of text around the first mention of any needle (address or surname).
function windowAround(text, needles, span = 4000) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  for (const n of needles.filter(Boolean)) {
    const needle = String(n).toLowerCase();
    // Prefer the matter's DETAIL section (a matter number followed by dated
    // entries), then any mention followed by a matter number, over a mention in
    // a payments list or a one-line summary table.
    let i = -1, numbered = -1, first = -1;
    for (let k = lower.indexOf(needle); k >= 0; k = lower.indexOf(needle, k + 1)) {
      if (first < 0) first = k;
      const after = t.slice(k, k + needle.length + 260);
      const hasNum = MATTER_RE.test(after.slice(0, needle.length + 90));
      if (hasNum && numbered < 0) numbered = k;
      if (hasNum && /Last Action|Note Date|\d{1,2}\/\s?\d{1,2}\s?\/\d{2}\s/.test(after)) { i = k; break; }
    }
    if (i < 0) i = numbered >= 0 ? numbered : first;
    if (i < 0) continue;
    // Start at this owner's own heading ("SURNAME, FIRST –") when it sits just
    // before the mention, so the previous owner's last lines are never included.
    const before = t.slice(Math.max(0, i - 120), i);
    let start = i, hm; const heading = /[A-Z][A-Z'\-]{2,}, [A-Z][A-Za-z.]+/g;
    while ((hm = heading.exec(before))) start = Math.max(0, i - 120) + hm.index;
    let w = t.slice(start, i + span);
    // Stop at the next owner's section (status reports head each matter with
    // "SURNAME, FIRST – address"), so one owner's bankruptcy is never read as
    // another's.
    // Also stop at a section/category break or at a DIFFERENT matter number
    // (formats like "Surname, First (address) ... 13705-20061" are mixed case).
    const from = (i - start) + needle.length + 15;
    const cuts = [];
    const next = /\s[A-Z][A-Z'\-]{2,}, [A-Z][A-Za-z.]+/g; next.lastIndex = from;
    const m1 = next.exec(w); if (m1) cuts.push(m1.index);
    const cat = /Category Count|Summary of Matters|Details of Matters/g; cat.lastIndex = from;
    const m2 = cat.exec(w); if (m2) cuts.push(m2.index);
    const own = MATTER_RE.exec(w.slice(0, from + 60));
    const nums = new RegExp(MATTER_RE.source, 'g'); nums.lastIndex = from;
    for (let m3 = nums.exec(w); m3; m3 = nums.exec(w)) { if (YEAR_RANGE.test(m3[0])) continue; if (!own || m3[0] !== own[0]) { cuts.push(m3.index); break; } }
    if (cuts.length) w = w.slice(0, Math.min(...cuts));
    return w;
  }
  return null;
}

// What an attorney status-report passage says about one owner.
function readStatusPassage(passage, title) {
  if (!passage) return null;
  const p = passage;
  const out = {};
  if (/bankrupt/i.test(p)) {
    out.bankruptcy = /dismiss/i.test(p) ? 'dismissed' : /discharg/i.test(p) ? 'discharged' : 'active';
    const m = new RegExp(`(dismissed|discharged)[^.]{0,40}?((?:${MONTHS}) \\d{1,2}, \\d{4})`, 'i').exec(p);
    if (m) out.bankruptcy_date = m[2];
  }
  // A collection file mentions demands, liens and payment plans; a deed-
  // restriction file is tagged as such near its heading (RMWBH "(DRV)", D&F
  // "Deed Restriction Matters"). A stray "violation" in a collection file is
  // not enough.
  const coll = /demand letter|assessment lien|notice of assessment|payment plan|past due|delinquen|statute of limitations/i.test(p);
  const drvTag = /deed restriction|\bDRV\b|violation hearing|covenant violation/i.test(p.slice(0, 400));
  // A report whose own title names its docket ("Deed Restriction Status Report", "Collection
  // Status Report") decides the work type: a deed-restriction demand letter is still DRV work.
  const t = String(title || '');
  const titleDrv = /deed restriction|\bDRV\b/i.test(t), titleColl = /collection/i.test(t);
  if (titleDrv && !titleColl) out.work_type = 'drv';
  else if (titleColl && !titleDrv) out.work_type = 'collection';
  else if (drvTag || (/deed restriction|\bDRV\b/i.test(p) && !coll)) out.work_type = 'drv';
  else if (coll || /collection/i.test(p)) out.work_type = 'collection';
  const cert = /certified mail on ((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/i.exec(p);
  if (cert) out.prior_certified_notice = cert[1];
  const init = /mailed initial demand letter on ((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/i.exec(p);
  if (init) out.initial_demand = init[1];
  // Bedrock's referral: the firm records the date management asked it to start.
  const refd = /received (?:a |the )?request to (?:send|prepare)[^.]{0,60}? on ((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/i.exec(p);
  if (refd) out.referral_requested = refd[1];
  const payoff = /payoff statement[^.]{0,80}?good through ([A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)[^$]{0,160}\$([\d,]+\.\d{2})/i.exec(p);
  if (payoff) out.payoff = { good_through: payoff[1], amount: payoff[2] };
  return out;
}

// What a notice letter's own text establishes.
function readNoticeText(text, { address, surname }) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  const street = streetOf(address).toLowerCase();
  const mentionsProperty = (street && lower.includes(street.split(' ').slice(0, 2).join(' '))) || (surname && lower.includes(surname.toLowerCase()));
  if (!mentionsProperty) return null;
  const cert = CERT_RE.exec(t);
  const date = DATE_RE.exec(t);
  // A delinquency letter with the 45-day window is a §209.0064 notice even when
  // it mentions "restrictive covenants" (Sterling's letters do); a violation
  // notice names the violation / hearing and carries no delinquency demand.
  const collection = /past due|delinquen/i.test(t) && /\b45\b|forty-five|forty - five/i.test(t);
  const kind = collection ? 'collection_209_0064'
    : /209\.006|violation hearing|notice of violation|cure|covenant violation|violation of the/i.test(t) ? 'drv_209_006' : 'other';
  // A letter can carry the label "Certified Mail #" with the number left blank:
  // that proves the content, not the mailing.
  const certLabel = /certified mail\s*(?:no\.?|number|#)/i.test(t);
  return {
    kind,
    certified_number: cert ? cert[1].replace(/\s+/g, ' ').trim() : null,
    certified_line_blank: certLabel && !cert,
    date: date ? date[0] : null,
    fee_warning: /attorney'?s?\s*fees|attorneys'\s*fees/i.test(t),
    hearing_right: /hearing/i.test(t),
    payment_plan_right: /payment plan/i.test(t),
  };
}

// ---- default sources (all injectable for tests) -----------------------------
function defaultSources(supabase) {
  const gs = () => require('../email/graph_search');
  const ga = () => require('../email/graph_attachments');
  const send = () => require('../email/graph_send');
  const textOf = async (name, buf) => {
    if (/\.pdf$/i.test(name)) return (await require('pdf-parse')(buf)).text || '';
    if (/\.docx$/i.test(name)) return (await require('mammoth').extractRawText({ buffer: buf })).value || '';
    return '';
  };
  return {
    graphConfigured: () => { try { return send().isConfigured(); } catch (_) { return false; } },
    mailboxes: () => String(process.env.LEGAL_RESEARCH_MAILBOXES || send().ED_MAILBOX).split(',').map((s) => s.trim()).filter(Boolean),
    driveOwner: () => process.env.LEGAL_RESEARCH_DRIVE_OWNER || send().ED_MAILBOX,
    searchMail: (mailbox, q) => gs().searchMailbox(mailbox, q, { top: 15 }),
    attachmentTexts: async (mailbox, graphId) => {
      const files = await ga().fetchAllAttachmentBuffers(mailbox, graphId);
      const out = [];
      for (const f of (files || []).slice(0, 4)) {
        const name = f.name || f.filename || '';
        if (!/\.(pdf|docx)$/i.test(name) || !f.buffer) continue;
        try { out.push({ name, text: await textOf(name, f.buffer) }); } catch (_) { /* unreadable file: skipped, noted by absence */ }
      }
      return out;
    },
    searchDrive: (owner, q) => gs().searchDrive(owner, q, { top: 15 }),
    driveText: async (owner, item) => textOf(item.name, await gs().downloadDriveItem(owner, item.id)),
    // Originals already retained in trustEd for this association, with their
    // text read from the stored file (not the clipped copy in the fields).
    retainedEvidence: async (communityId) => {
      const ES = require('./evidence_store');
      const docs = await ES.findEvidence(supabase, { communityId });
      return docs.filter((d) => /\.pdf$/i.test(d.file_path || '')).map((d) => ({
        id: d.id, title: d.title, kinds: (d.fields && d.fields.evidence_kinds) || [], doc_date: (d.fields && d.fields.doc_date) || d.effective_date || null,
        text: async () => {
          const f = await supabase.storage.from('documents').download(d.file_path);
          if (f.error) throw new Error(f.error.message);
          return (await require('pdf-parse')(Buffer.from(await f.data.arrayBuffer()))).text || '';
        },
      }));
    },
    governingDocs: async (communityName) => require('../hybrid_retrieval').getRelevantChunksWithSources(
      'attorney fees costs of collection enforcement owner liable reasonable attorney fees', communityName),
  };
}

// ---- trustEd records (verified) --------------------------------------------
async function trustedFacts(supabase, { propertyId, invoiceNumber }) {
  const [tenures, coll, viol, letters, ledger] = await Promise.all([
    supabase.from('ownership_tenures').select('id, kind, start_date, end_date').eq('property_id', propertyId),
    supabase.from('ar_account_collections').select('collection_status, status_since, bankruptcy_petition_date, bankruptcy_chapter, bankruptcy_discharge_date, bankruptcy_dismissed_date').eq('property_id', propertyId),
    supabase.from('violations').select('id, current_stage, current_stage_started_at, certified_notice_date').eq('property_id', propertyId),
    supabase.from('sent_letter_archive').select('letter_type, postmark_date').eq('property_id', propertyId),
    supabase.from('homeowner_transactions').select('transaction_date, txn_type, charge_category, amount_cents, description').eq('property_id', propertyId),
  ]);
  return {
    tenures: must(tenures, 'ownership tenures'),
    collections: must(coll, 'collections record'),
    violations: must(viol, 'violations'),
    letters: must(letters, 'letters'),
    ledger: must(ledger, 'owner ledger'),
    invoiceNumber,
  };
}

// ---- one owner-attributed allocation ----------------------------------------
async function researchAllocation(supabase, ctx, { item, alloc }, src, cache) {
  const prop = ctx.props.get(alloc.property_id) || {};
  const address = [prop.street_address, prop.unit].filter(Boolean).join(' #');
  const owners = (ctx.owners.get(alloc.property_id) || []);
  const surname = surnameOf(owners);
  const f = { allocation_id: alloc.id || null, item_id: item.id || null, matter_ref: item.matter_ref || null, property_id: alloc.property_id, address,
    amount_cents: Number(alloc.amount_cents), verified: [], references: [], assumptions: [], missing: [], sources_searched: [], unavailable: [], signals: {},
    // What the evidence proves, kept apart: a notice's CONTENT, that it was
    // MAILED (certified number, tracking, a mailing record), that it was
    // DELIVERED (return receipt / delivered tracking), and INDIRECT support
    // (an attorney's statement, a vendor's bill for certified letters, a fee).
    evidence: { content: [], mailing: [], delivery: [], indirect: [] }, judgment: [] };
  const E = (kind, source, fact, ref) => f.evidence[kind].push({ source, fact: clip(fact, 300), ref: ref || null });
  const V = (source, fact, ref) => f.verified.push({ source, fact: clip(fact, 400), ref: ref || null });
  const Rf = (source, fact, ref) => f.references.push({ source, fact: clip(fact, 300), ref: ref || null });
  const A = (fact) => f.assumptions.push(clip(fact, 300));

  // 1. trustEd records
  const t = await trustedFacts(supabase, { propertyId: alloc.property_id, invoiceNumber: ctx.invoiceNumber });
  f.sources_searched.push('trustEd: ownership tenures, collections/bankruptcy, violations, letters, owner ledger');
  const current = t.tenures.find((x) => x.kind === 'owner' && !x.end_date);
  if (current) V('trustEd ownership_tenures', `current owner tenure ${current.id}${current.start_date ? ` since ${current.start_date}` : ''}`, current.id);
  f.signals.owner_current = !!(current && alloc.tenure_id && current.id === alloc.tenure_id);
  if (!f.signals.owner_current) f.missing.push('the owner reviewed is not confirmed as the current owner');
  for (const c of t.collections) {
    if (c.bankruptcy_petition_date || c.collection_status === 'bankruptcy') {
      const status = c.bankruptcy_dismissed_date ? 'dismissed' : c.bankruptcy_discharge_date ? 'discharged' : 'active';
      setBankruptcy(f, { status, source: 'trustEd ar_account_collections', petition: c.bankruptcy_petition_date || null, chapter: c.bankruptcy_chapter || null,
        as_of: c.bankruptcy_dismissed_date || c.bankruptcy_discharge_date || c.bankruptcy_petition_date || null });
      V('trustEd ar_account_collections', `bankruptcy ${status}${c.bankruptcy_petition_date ? `, filed ${c.bankruptcy_petition_date}` : ''}`);
    }
  }
  const certViol = t.violations.filter((v) => v.certified_notice_date || v.current_stage === 'certified_209');
  for (const v of certViol) V('trustEd violations', `violation at ${v.current_stage}${v.certified_notice_date ? `, certified notice ${v.certified_notice_date}` : ''}`, v.id);
  for (const v of certViol.filter((x) => x.certified_notice_date)) {
    E('mailing', 'trustEd violations', `certified violation notice recorded as sent ${v.certified_notice_date}`, v.id);
    f.signals.drv_notice_mailed = true;
  }
  const prior = t.ledger.filter((h) => ATTORNEY_FEE_CATEGORIES.includes(h.charge_category) || /legal fee/i.test(h.description || ''));
  if (prior.length) V('trustEd owner ledger', `${prior.length} prior legal-fee line(s) on this account`);
  if (ctx.invoiceNumber && t.ledger.some((h) => h.txn_type === 'charge' && String(h.description || '').includes(String(ctx.invoiceNumber)))) {
    f.signals.already_billed = true;
    V('trustEd owner ledger', `a charge already references invoice ${ctx.invoiceNumber}`);
  }
  if (t.ledger.some((h) => h.charge_category === 'certified_letter')) {
    A('a certified-letter fee on the ledger suggests a certified letter was sent (fee alone is not proof of a §209 notice)');
    E('indirect', 'trustEd owner ledger', 'a certified-letter fee was charged to the account');
  }

  // 2. email + attorney status reports
  if (src.graphConfigured()) {
    const queries = [address, item.matter_ref, surname].filter((q) => q && String(q).length > 3);
    const seen = new Set();
    for (const mailbox of src.mailboxes()) {
      f.sources_searched.push(`email: ${mailbox} (${queries.join(' | ')})`);
      for (const q of queries) {
        let res;
        try { res = await src.searchMail(mailbox, q); } catch (e) { f.sources_searched.push(`email search failed (${mailbox}): ${clip(e.message, 80)}`); if (!f.unavailable.includes('email')) f.unavailable.push('email'); continue; }
        for (const m of (res.messages || [])) {
          if (seen.has(m.id)) continue; seen.add(m.id);
          Rf(`email ${mailbox}`, `${m.subject} (${String(m.received_at || '').slice(0, 10)}, ${m.from ? m.from.email : '?'})`, m.web_link);
          if (m.has_attachments && STATUS_REPORT_RE.test(m.subject || '')) {
            const key = `${mailbox}:${m.id}`;
            if (!cache.reports.has(key)) {
              try { cache.reports.set(key, await src.attachmentTexts(mailbox, m.id)); } catch (_) { cache.reports.set(key, []); }
            }
            for (const doc of cache.reports.get(key)) {
              const mref = item.matter_ref ? String(item.matter_ref) : null;
              const passage = windowAround(doc.text, [mref, mref && mref.replace(/[.\-]/, (c) => (c === '.' ? '-' : '.')), streetOf(address), address, surname && surname.toUpperCase()]);
              const read = readStatusPassage(passage, doc.name);
              if (!read || !Object.keys(read).length) continue;
              // Work type belongs to a matter: a passage about a DIFFERENT matter for
              // the same owner (e.g. a deed-restriction file beside the collection
              // file) never sets it. Bankruptcy is about the owner and always counts.
              const own = MATTER_RE.exec(passage);
              const digits = (x) => String(x || '').replace(/\D/g, '');
              if (own && mref && digits(own[0]) !== digits(mref)) { delete read.work_type; delete read.initial_demand; delete read.prior_certified_notice; delete read.payoff; }
              if (!Object.keys(read).length) continue;
              f.signals.status_report = Object.assign({ source: `${doc.name} (email ${String(m.received_at || '').slice(0, 10)})`, ref: m.web_link }, f.signals.status_report || {}, read);
              addressCheck(f, passage, address, doc.name);
              V(`attorney status report: ${doc.name}`, `${read.work_type ? `work type ${read.work_type}; ` : ''}${read.bankruptcy ? `bankruptcy ${read.bankruptcy}; ` : ''}${read.initial_demand ? `initial demand ${read.initial_demand}; ` : ''}${read.prior_certified_notice ? `prior certified notice ${read.prior_certified_notice}; ` : ''}${read.payoff ? `payoff good through ${read.payoff.good_through} $${read.payoff.amount}` : ''}`, m.web_link);
              if (read.prior_certified_notice) {
                E('indirect', `attorney status report: ${doc.name}`, `attorney states a letter was mailed via certified mail on ${read.prior_certified_notice}`, m.web_link);
                f.signals.notice_indirect = true;
              }
              if (read.bankruptcy) setBankruptcy(f, { status: read.bankruptcy, source: doc.name, as_of: String(m.received_at || '').slice(0, 10) || null });
              if (read.work_type && !f.signals.work_type) { f.signals.work_type = read.work_type; f.signals.work_type_source = doc.name; }
              if (read.referral_requested || read.initial_demand) f.signals.referral = Object.assign({ source: doc.name, ref: m.web_link }, f.signals.referral || {}, { requested: read.referral_requested || (f.signals.referral || {}).requested || null, demand: read.initial_demand || (f.signals.referral || {}).demand || null });
              if (read.payoff) f.signals.payoff = Object.assign({ source: doc.name }, read.payoff);
            }
          }
        }
      }
    }
  } else { f.sources_searched.push('email: not searched (Graph not configured on this server)'); f.unavailable.push('email'); }

  // 2b. originals already retained in trustEd (evidence_store): the attorney's
  // status reports and the notice letters, read from the stored file. A
  // passage counts only when it names this property's HOUSE NUMBER + street
  // (a neighbour on the same street is never this owner's evidence).
  if (src.retainedEvidence && ctx.communityId) {
    if (!cache.retained) {
      try { cache.retained = await src.retainedEvidence(ctx.communityId); } catch (e) { cache.retained = []; f.sources_searched.push(`trustEd retained evidence: failed (${clip(e.message, 80)})`); }
    }
    // Oldest first: a later status report supersedes an earlier one (a
    // bankruptcy dismissed in August overrides "active" in July).
    const docs = (cache.retained || []).slice().sort((x, y) => String(x.doc_date || '').localeCompare(String(y.doc_date || '')));
    f.sources_searched.push(`trustEd retained evidence: ${docs.length} original(s)`);
    const street = streetOf(address);
    for (const doc of docs) {
      const isReport = doc.kinds.some((k) => /status_report|deed_restriction_report/.test(k));
      const isNotice = doc.kinds.some((k) => /notice/.test(k));
      if (!isReport && !isNotice) continue;
      if (!cache.texts) cache.texts = new Map();
      if (!cache.texts.has(doc.id)) { try { cache.texts.set(doc.id, await doc.text()); } catch (_) { cache.texts.set(doc.id, ''); } }
      const text = cache.texts.get(doc.id);
      if (!street || !text.toLowerCase().includes(street.toLowerCase())) continue;
      const passage = windowAround(text, [street], isNotice ? 3500 : 4000);
      if (!passage) continue;
      const tag = `trustEd retained: ${doc.title}`;
      if (isReport) {
        const read = readStatusPassage(passage, doc.title);
        const own = MATTER_RE.exec(passage);
        const digits = (x) => String(x || '').replace(/\D/g, '');
        if (read && own && item.matter_ref && digits(own[0]) !== digits(item.matter_ref)) { delete read.work_type; delete read.initial_demand; delete read.referral_requested; delete read.prior_certified_notice; delete read.payoff; }
        if (!read || !Object.keys(read).length) continue;
        if (own && !f.matter_found) f.matter_found = own[0];
        f.signals.status_report = Object.assign({ source: doc.title, ref: doc.id }, f.signals.status_report || {}, read);
        addressCheck(f, passage, address, doc.title);
        V(tag, `${own ? `matter ${own[0]}; ` : ''}${read.work_type ? `work type ${read.work_type}; ` : ''}${read.bankruptcy ? `bankruptcy ${read.bankruptcy}; ` : ''}${read.referral_requested ? `Bedrock referral requested ${read.referral_requested}; ` : ''}${read.initial_demand ? `initial demand ${read.initial_demand}; ` : ''}${read.payoff ? `payoff good through ${read.payoff.good_through} $${read.payoff.amount}` : ''}`, doc.id);
        if (read.prior_certified_notice) { E('indirect', tag, `attorney states a letter was mailed via certified mail on ${read.prior_certified_notice}`, doc.id); f.signals.notice_indirect = true; }
        if (read.referral_requested || read.initial_demand) f.signals.referral = Object.assign({ source: doc.title, ref: doc.id }, f.signals.referral || {}, { requested: read.referral_requested || (f.signals.referral || {}).requested || null, demand: read.initial_demand || (f.signals.referral || {}).demand || null });
        if (read.bankruptcy) setBankruptcy(f, { status: read.bankruptcy, source: doc.title, as_of: doc.doc_date || null });
        if (read.payoff) f.signals.payoff = Object.assign({ source: doc.title }, read.payoff);
        if (read.work_type && !f.signals.work_type) { f.signals.work_type = read.work_type; f.signals.work_type_source = doc.title; }
      } else {
        const read = readNoticeText(passage, { address, surname: null });
        if (!read) continue;
        const which = read.kind === 'drv_209_006' ? 'drv' : read.kind === 'collection_209_0064' ? 'collection' : null;
        V(tag, `${which === 'drv' ? '§209.006 violation notice' : which === 'collection' ? '§209.0064 delinquency notice' : 'notice'}${read.date ? ` dated ${read.date}` : ''}${read.certified_number ? `, certified ${read.certified_number}` : read.certified_line_blank ? ', certified-mail line blank' : ''}${read.fee_warning ? ', attorney-fee warning' : ''}`, doc.id);
        if (which && read.fee_warning) {
          E('content', tag, `${which === 'drv' ? '§209.006 violation notice' : '§209.0064 delinquency notice'} content${read.date ? ` dated ${read.date}` : ''}`, doc.id);
          f.signals[`${which}_notice_content`] = true;
          if (read.certified_number) { E('mailing', tag, `certified article number ${read.certified_number} printed on the notice`, doc.id); f.signals[`${which}_notice_mailed`] = true; }
          else if (read.certified_line_blank) f.signals[`${which}_cert_blank`] = true;
        }
      }
    }
  }

  // 3. OneDrive notices (opened and read)
  if (src.graphConfigured()) {
    const owner = src.driveOwner();
    const queries = [address, surname && `${surname} ${streetOf(address).split(' ').slice(1, 3).join(' ')}`].filter((q) => q && q.length > 3);
    f.sources_searched.push(`OneDrive: ${owner} (${queries.join(' | ')})`);
    const seenItems = new Set();
    for (const q of queries) {
      let res;
      try { res = await src.searchDrive(owner, q); } catch (e) {
        // Graph answers 403, or 404 "itemNotFound" for the drive itself, when the
        // app has no Files.Read.All: the drive was not searched, not empty.
        const denied = e.status === 403 || e.status === 404 || /item not found|access denied|forbidden/i.test(e.message || '');
        f.sources_searched.push(`OneDrive ${denied ? 'not accessible (the app has no OneDrive permission)' : `search failed: ${clip(e.message, 80)}`}`);
        f.unavailable.push('OneDrive');
        break;
      }
      const candidates = (res.items || []).filter((i) => NOTICE_NAME_RE.test(i.name) && !seenItems.has(i.id)).slice(0, 4);
      for (const item of candidates) {
        seenItems.add(item.id);
        let text = '';
        try { text = await src.driveText(owner, item); } catch (_) { Rf('OneDrive', `${item.name} (located, not readable)`, item.web_url); continue; }
        const read = readNoticeText(text, { address, surname });
        if (!read) { Rf('OneDrive', `${item.name} (does not name this property/owner)`, item.web_url); continue; }
        V(`OneDrive: ${item.name}`, `${read.kind === 'drv_209_006' ? '§209.006 violation notice' : read.kind === 'collection_209_0064' ? '§209.0064 delinquency notice' : 'notice'}${read.date ? ` dated ${read.date}` : ''}${read.certified_number ? `, certified ${read.certified_number}` : ''}${read.fee_warning ? ', attorney-fee warning' : ''}${read.hearing_right ? ', hearing right' : ''}${read.payment_plan_right ? ', payment-plan right' : ''}`, item.web_url);
        const which = read.kind === 'drv_209_006' ? 'drv' : read.kind === 'collection_209_0064' ? 'collection' : null;
        if (which && read.fee_warning) {
          E('content', `OneDrive: ${item.name}`, `${which === 'drv' ? '§209.006 violation notice' : '§209.0064 delinquency notice'} content${read.date ? ` dated ${read.date}` : ''}`, item.web_url);
          f.signals[`${which}_notice_content`] = true;
          if (read.certified_number) {
            E('mailing', `OneDrive: ${item.name}`, `certified article number ${read.certified_number} printed on the notice`, item.web_url);
            f.signals[`${which}_notice_mailed`] = true;
          } else if (read.certified_line_blank) {
            f.signals[`${which}_cert_blank`] = true;
          }
        }
      }
    }
  } else { f.sources_searched.push('OneDrive: not searched (Graph not configured on this server)'); f.unavailable.push('OneDrive'); }

  f.vendor = ctx.vendorName || null;
  return recommend(f, alloc);
}

// ---- recommendation (pure) ---------------------------------------------------
// The treatment Amanda proposes for one owner line, and its outcome:
//   ready             the notice's content is on file (and the work type known):
//                     proposed homeowner recoverable. If mailing is not
//                     independently proven, that is stated as a LIMITATION the
//                     owner accepts at approval; it is never claimed as proof.
//   needs_information a specific record is missing from every accessible source
//   needs_decision    a genuine judgment: bankruptcy, a payoff allocation, a
//                     possible duplicate, a different owner, or accepting
//                     Bedrock's referral record where the notice copy is absent
// Bedrock's referral procedure (management sends counsel an enforcement package
// before the attorney proceeds; confirmed by management) is operational
// evidence, recorded as indirect support, never as mailing proof.
const OUTCOME_LABEL = { ready: 'READY FOR APPROVAL', needs_information: 'NEEDS INFORMATION', needs_decision: 'NEEDS DECISION' };
// Counsel's documented collection-intake procedures. When counsel accepted the referral and
// opened the case, the procedure is SUPPORTING evidence that the notice was verified at intake.
// It is never recorded as proof that anyone here inspected the original mailing.
const REFERRAL_PROCEDURES = [
  { vendor: /daughtry/i, firm: 'Daughtry & Farine', text: 'verifies the §209.0064 pre-referral notice before it opens a collection case', source: 'documented by Ed Gojara, 2026-10-12' },
];
function referralProcedure(vendor) { return REFERRAL_PROCEDURES.find((r) => r.vendor.test(String(vendor || ''))) || null; }
function recommend(f, alloc) {
  f.evidence = f.evidence || { content: [], mailing: [], delivery: [], indirect: [] };
  f.judgment = f.judgment || [];
  f.limitations = f.limitations || [];
  f.missing = f.missing || [];
  const s = f.signals;
  // Work type from evidence only: an attorney status report, the notice found,
  // or the category the line text itself printed. Never a default.
  let workType = s.work_type || null;
  let workTypeSource = s.work_type ? (s.work_type_source || 'attorney status report') : null;
  const drvNotice = s.drv_notice_content || s.drv_notice_mailed, collNotice = s.collection_notice_content || s.collection_notice_mailed;
  if (!workType && drvNotice && !collNotice) { workType = 'drv'; workTypeSource = 'the §209.006 notice on file'; }
  if (!workType && collNotice && !drvNotice) { workType = 'collection'; workTypeSource = 'the §209.0064 notice on file'; }
  if (!workType && alloc.charge_category) { workType = alloc.charge_category === 'attorney_fee_other' ? 'drv' : 'collection'; workTypeSource = 'the invoice line text'; }
  const category = workType === 'drv' ? 'attorney_fee_other' : workType === 'collection' ? 'attorney_fee' : null;
  const content = !!(workType && s[`${workType}_notice_content`]);
  const mailed = !!(workType && s[`${workType}_notice_mailed`]);
  const noticeName = workType === 'drv' ? '§209.006 violation notice' : '§209.0064 pre-referral delinquency notice';
  const ref = s.referral && (s.referral.requested || s.referral.demand) ? s.referral : null;
  if (ref) {
    f.evidence.indirect.push({ source: ref.source, fact: clip(`Bedrock referral to counsel${ref.requested ? ` requested ${ref.requested}` : ''}${ref.demand ? `; counsel's initial demand ${ref.demand}` : ''} (standard procedure: management sends the enforcement package before counsel proceeds)`, 300), ref: ref.ref || null });
  }
  // Counsel's documented procedure covers collection referrals only, never deed-restriction work.
  const proc = ref && ref.demand && workType === 'collection' ? referralProcedure(f.vendor) : null;
  if (proc) f.evidence.indirect.push({ source: `${proc.firm} intake procedure (${proc.source})`, fact: clip(`${proc.firm} ${proc.text}; it accepted this referral and opened the case (initial demand ${ref.demand}).`, 300), ref: ref.ref || null });
  const R = (outcome, recommendation, classification, reason) => ({ outcome, recommendation, classification, reason });
  let rec;
  if (s.bankruptcy && s.bankruptcy.status === 'active') rec = R('needs_decision', 'hold', 'needs_review', `active bankruptcy (${s.bankruptcy.source}): no owner charge without counsel`);
  else if (!s.owner_current) rec = R('needs_decision', 'review', 'needs_review', 'the owner charged is not the current owner on file');
  else if (s.already_billed) rec = R('needs_decision', 'review', 'needs_review', 'a charge on the owner ledger already references this invoice');
  else if (s.bankruptcy) rec = R('needs_decision', 'review', 'needs_review', `bankruptcy ${s.bankruptcy.status} (${s.bankruptcy.source}): whether these fees are recoverable after the case`);
  else if (s.payoff) rec = R('needs_decision', 'review', 'needs_review', `a payoff (good through ${s.payoff.good_through}, $${s.payoff.amount}) may already cover these fees: allocation and duplicate check`);
  else if (!workType) {
    f.missing.push('the work type (collections or deed restriction): not in the invoice text, the status reports, or a notice on file');
    rec = R('needs_information', 'review', 'needs_review', 'work type not established from any record');
  } else if (content && !mailed && workType === 'drv') {
    // Deed restriction (Ed 2026-10-12): §209.008 fees need the §209.006 notice SENT BY
    // CERTIFIED MAIL. The letter's text alone, a "certified" label in a manager's log or
    // counsel acting on the referral is not proof of mailing.
    f.missing.push(`the certified-mail receipt or tracking number for the ${noticeName}${s.drv_cert_blank ? ' (the certified-mail line on the letter is blank)' : ''}`);
    rec = R('needs_information', 'review', 'needs_review', `${noticeName} on file; certified mailing not verified`);
  } else if (content) {
    if (!mailed) f.limitations.push(proc
      ? `The original certified-mail proof of the ${noticeName} was not inspected here${s[`${workType}_cert_blank`] ? ' (the certified-mail line on the letter is blank)' : ''}; the notice content is on file and ${proc.firm}, which ${proc.text}, opened the case (initial demand ${ref.demand}).`
      : `Independent proof of mailing of the ${noticeName} is not verified${s[`${workType}_cert_blank`] ? ' (the certified-mail line on the letter is blank)' : ''}; the notice content is on file${ref ? " and counsel proceeded on Bedrock's referral" : ''}.`);
    rec = R('ready', 'recoverable', 'homeowner_recoverable', `${noticeName} on file${mailed ? ' with certified mailing' : ''}`);
  } else if (ref) {
    f.missing.push(`a copy of the ${noticeName}`);
    f.judgment.push(`accept Bedrock's referral record in place of the missing ${noticeName} copy`);
    rec = R('needs_decision', 'review', 'needs_review', `${noticeName} copy not on file; counsel proceeded on Bedrock's referral${ref.requested ? ` (${ref.requested})` : ''}, a process that requires the notice`);
  } else if (mailed) {
    f.missing.push(`a copy of the ${noticeName} itself (a mailing is recorded, its content is not on file)`);
    rec = R('needs_information', 'review', 'needs_review', `${noticeName} mailing recorded; content not on file`);
  } else {
    f.missing.push(`the ${noticeName}`);
    if (f.evidence.indirect.length) f.judgment.push('only indirect evidence of a notice exists');
    rec = R('needs_information', 'review', 'needs_review', f.evidence.indirect.length ? `only indirect evidence of the ${noticeName}` : `${noticeName} not found in any accessible record`);
  }
  if (s.address_discrepancy) {
    const ad = s.address_discrepancy;
    const note = `address check: the attorney's report (${ad.source}) lists ${ad.report}; the property on file is ${ad.property}`;
    f.judgment.push(`confirm the matter belongs to this property (${ad.report} vs ${ad.property})`);
    if (rec.outcome === 'ready') rec = R('needs_decision', 'review', 'needs_review', note);
    else rec.reason = `${rec.reason}; ${note}`;
  }
  if ((f.unavailable || []).length && rec.outcome !== 'ready') f.missing.push(`internal search incomplete: ${f.unavailable.join(', ')} not accessible to the system (a person checks there before anyone asks outside)`);
  if (s.bankruptcy && s.bankruptcy.status !== 'active') f.judgment.push(`bankruptcy ${s.bankruptcy.status}: whether the fees are recoverable after the case`);
  if (s.bankruptcy && s.bankruptcy.status === 'active') f.judgment.push('active bankruptcy: no owner charge without counsel');
  // A category correction is Amanda's recommendation, not evidence: kept apart so
  // the evidence (and its idempotency key) is the same before and after it is applied.
  f.corrections = s.work_type && alloc.charge_category && category && category !== alloc.charge_category ? [`work type is ${workType}: charge category ${category}, not ${alloc.charge_category}`] : [];
  return Object.assign(f, rec, { outcome_label: OUTCOME_LABEL[rec.outcome], work_type: workType, work_type_source: workTypeSource,
    charge_category: rec.classification === 'homeowner_recoverable' ? category : null,
    inaccessible: (f.unavailable || []).slice(),
    evidence_grade: f.verified.length ? 'verified' : f.references.length ? 'reference_only' : 'none' });
}

// ---- an outside request, drafted only when genuinely needed and held ---------
function draftExternalRequest(f, { vendorName, invoiceNumber }) {
  if (!f.missing.length || f.recommendation === 'hold') return null;
  // Every internal source must actually have been searched. While one was
  // unavailable (e.g. OneDrive without permission) the evidence may be ours
  // already: the gap is an internal activity, not an outside request.
  if ((f.unavailable || []).length) return null;
  const searched = f.sources_searched.filter((x) => !/failed|not searched|not accessible/.test(x));
  if (searched.length < 3) return null;
  return {
    to: vendorName || 'the attorney',
    status: 'held_for_approval',
    subject: `Request: notice documentation, ${f.address}${f.matter_ref ? ` (matter ${f.matter_ref})` : ''}`,
    body: `Please send a copy of ${f.missing.join(' and ')} for ${f.address}${f.matter_ref ? `, matter ${f.matter_ref}` : ''}, referenced on invoice ${invoiceNumber}. We searched our own records first (${searched.join('; ')}) and could not locate it.`,
  };
}

// ---- the invoice -----------------------------------------------------------
async function researchInvoice(supabase, d, { sources } = {}) {
  const src = Object.assign(defaultSources(supabase), sources || {});
  const ctx = {
    invoiceNumber: d.invoiceNumber || (d.invoice && d.invoice.invoice_number) || null,
    communityId: (d.invoice && d.invoice.community_id) || null,
    props: new Map((d.ctx && d.ctx.properties || []).map((p) => [p.id, p])),
    owners: new Map(),
  };
  for (const o of (d.ctx && d.ctx.owners) || []) { if (!ctx.owners.has(o.property_id)) ctx.owners.set(o.property_id, []); ctx.owners.get(o.property_id).push(o.name); }
  const cache = { reports: new Map() };
  const findings = [];
  for (const item of (d.saved && d.saved.items) || []) {
    for (const alloc of item.allocations || []) {
      if (!alloc.property_id || !['homeowner_recoverable', 'needs_review'].includes(alloc.classification)) continue;
      const f = await researchAllocation(supabase, Object.assign(ctx, { vendorName: d.invoice && d.invoice.vendor }), { item, alloc }, src, cache);
      f.external_request = draftExternalRequest(f, { vendorName: d.invoice && d.invoice.vendor, invoiceNumber: ctx.invoiceNumber });
      findings.push(f);
    }
  }
  let governing = null;
  if (findings.length && d.community && d.community.name) {
    try {
      const g = await src.governingDocs(d.community.name);
      governing = { sources: (g.sources || []).slice(0, 5).map((x) => x.filename), excerpt: clip(g.context, 600) };
    } catch (e) { governing = { error: clip(e.message, 120) }; }
  }
  return { findings, governing };
}

module.exports = { researchInvoice, researchAllocation, recommend, OUTCOME_LABEL, REFERRAL_PROCEDURES, referralProcedure, readStatusPassage, readNoticeText, windowAround, surnameOf, draftExternalRequest };
