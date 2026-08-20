// ============================================================================
// scripts/build_contacts_from_email.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Builds Tessa's address book out of Ed's real email history.
//
// Ed: "is there a way to load and build contacts from my email history so it
// pops up in tessas search i can verbally ask tessa to send it ... i would like
// my contact to include email name and phone and address from email if
// available."
//
// ea_contacts held ZERO rows. That is why "Tessa, send this to the board" had
// nowhere to go — she has a send path, a voice path and a draft path, and no
// addresses. This fills it from the one source that is already complete and
// already correct: who Ed actually corresponds with.
//
// WHO GETS IN, and the filter matters more than the extraction:
//   * Anyone Ed has SENT to is in. Sending is intent; one deliberate send beats
//     ten newsletters.
//   * Anyone who wrote to him at least twice is in.
//   * HOMEOWNERS ARE EXCLUDED. There are thousands, Tessa already searches the
//     contacts table for them, and dropping them here would bury the twenty
//     people Ed actually asks for by voice. A voice assistant that answers
//     "which of these sixty Garcias" is worse than no search at all.
//   * Automated senders are excluded on address, display name and domain.
//
// PHONE AND ADDRESS come from the signature block of the person's own outbound
// mail, read by the model in batches of eight. The model is told to copy only
// what is literally on the page. An invented phone number in Ed's address book
// is a number he will dial.
//
// SAFE ON RE-RUN. Rows a person entered (source='manual') are never overwritten
// by a mined value; the miner fills only empty fields and always refreshes the
// counts. Re-running picks up new correspondents.
//
//   node scripts/build_contacts_from_email.js --dry-run
//   node scripts/build_contacts_from_email.js --months 24
//   node scripts/build_contacts_from_email.js --mailbox archive1emails@bedrocktx.com
//   node scripts/build_contacts_from_email.js --no-ai     (skip signature parse)
// ============================================================================
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { getToken, isConfigured } = require('../lib/email/graph_send');
const { htmlToText } = require('../lib/email/graph_attachments');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MODEL = process.env.CONTACT_MINE_MODEL || 'claude-sonnet-4-5';

function arg(name, fallback = null) {
  const eq = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
const DRY = process.argv.includes('--dry-run');
const NO_AI = process.argv.includes('--no-ai');
const MAILBOX = arg('mailbox', 'egojara@bedrocktx.com');
const MONTHS = parseInt(arg('months', '24'), 10);
const OWNER = String(MAILBOX).toLowerCase();

// Machines, not people. Matched on address AND display name, because plenty of
// senders are "Chase Alerts" at a perfectly human-looking address.
const NOISE_ADDR = /(^|[.\-_])(no-?reply|do-?not-?reply|donotrespond|notification|notifications|alerts?|mailer-daemon|postmaster|bounce|bounces|auto-?reply|newsletter|calendar-notification|automated)([.\-_]|@)/i;
const NOISE_NAME = /\b(no.?reply|notification|alert|automated|do not reply|bot|daemon)\b/i;
const NOISE_DOMAIN = /(^|\.)(mailchimp|sendgrid|constantcontact|hubspot|salesforce|docusign|zoom\.us|calendly|linkedin|facebook|twitter|instagram|amazonaws|google|microsoft|office365|apple|paypal|intuit|adobe|dropbox|slack|zendesk|atlassian|github|indeed|ziprecruiter|glassdoor|godaddy|namecheap|squarespace|wix|shopify|stripe|twilio|anthropic|openai)\./i;

// People who have left Bedrock. A year of mail makes a departed staffer look
// like one of Ed's closest contacts — Laurie is 37 sent messages, high enough
// to rank above the bank — and an address book that suggests her is an address
// book that gets her emailed. Frequency cannot tell "works here" from "worked
// here", so it has to be stated.
//
// Hand-maintained because there is no staff roster table to ask. When one
// exists, read is_active from it and delete this list.
const DEPARTED = new Set([
  'laurie@bedrocktx.com',   // departed 2026-08-13
]);

function isNoise(addr, name) {
  const a = String(addr || '').toLowerCase();
  if (!a || !a.includes('@')) return true;
  if (a === OWNER) return true;
  if (DEPARTED.has(a)) return true;
  if (NOISE_ADDR.test(a)) return true;
  if (NOISE_DOMAIN.test(a.split('@')[1] || '')) return true;
  if (name && NOISE_NAME.test(name)) return true;
  return false;
}

/** Domain to a readable organization, for when the signature does not say. */
function orgFromDomain(addr) {
  const d = String(addr || '').split('@')[1] || '';
  if (!d) return null;
  if (/bedrocktx\.com$/i.test(d)) return 'Bedrock Association Management';
  const parts = d.replace(/\.(com|net|org|us|co|io|biz|info)$/i, '').split('.');
  const base = parts[parts.length - 1];
  if (!base) return null;
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function categoryFor(addr, org, title) {
  const hay = (addr + ' ' + (org || '') + ' ' + (title || '')).toLowerCase();
  if (/@bedrocktx\.com$/i.test(addr)) return 'staff';
  if (/^(president|vicepresident|vice-president|secretary|treasurer|director|board)@/i.test(addr)) return 'board';
  if (/\b(bank|banking|newfirst|chase|wells ?fargo|frost|credit union)\b/.test(hay)) return 'bank';
  if (/\b(law|legal|attorney|counsel|llp|winstead|pllc|esq)\b/.test(hay)) return 'attorney';
  if (/\b(insurance|underwrit|assurance)\b/.test(hay)) return 'insurance';
  if (/\b(title|escrow|closing)\b/.test(hay)) return 'title';
  if (/\b(cpa|accounting|bookkeep|audit)\b/.test(hay)) return 'accounting';
  return 'vendor';
}

/** Every homeowner address we know, so they stay out of the EA book. */
async function homeownerAddresses() {
  const set = new Set();
  const sources = [['contacts', 'primary_email'], ['contact_methods', 'value']];
  for (const pair of sources) {
    const table = pair[0], col = pair[1];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select('id, ' + col)
        .not(col, 'is', null).order('id', { ascending: true }).range(from, from + 999);
      // A broken query here looks exactly like "no homeowners", which would
      // quietly let thousands of them into the address book.
      if (error) throw new Error(table + '.' + col + ' read failed: ' + error.message);
      (data || []).forEach(function (r) {
        const v = String(r[col] || '').trim().toLowerCase();
        if (v.includes('@')) set.add(v);
      });
      if (!data || data.length < 1000) break;
    }
  }
  return set;
}

/** Walk the mailbox and tally everyone Ed corresponds with. */
async function harvest(mailbox, months) {
  const since = new Date(Date.now() - months * 30 * 864e5).toISOString();
  const token = await getToken();
  const sel = 'internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview';
  let url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(mailbox) + '/messages'
    + '?$select=' + sel + '&$top=50&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ' + since;

  const people = new Map();
  function touch(addr, name, when) {
    const a = String(addr || '').trim().toLowerCase();
    if (isNoise(a, name)) return null;
    if (!people.has(a)) {
      people.set(a, { email: a, names: {}, message_count: 0, sent_count: 0, last_seen_at: null, sample: null });
    }
    const p = people.get(a);
    const n = String(name || '').trim();
    // Ignore a display name that is just the address echoed back.
    if (n && n.toLowerCase() !== a && /[a-z]/i.test(n)) p.names[n] = (p.names[n] || 0) + 1;
    if (when && (!p.last_seen_at || when > p.last_seen_at)) p.last_seen_at = when;
    return p;
  }

  let scanned = 0, pages = 0;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('graph ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    pages++;
    for (const m of j.value || []) {
      scanned++;
      const f = (m.from && m.from.emailAddress) || {};
      const fromAddr = String(f.address || '').toLowerCase();
      const when = m.receivedDateTime || null;

      if (fromAddr === OWNER) {
        // Ed wrote this. Everyone on it is someone he deliberately contacts.
        const rcpts = (m.toRecipients || []).concat(m.ccRecipients || []);
        for (const r2 of rcpts) {
          const ea = r2.emailAddress || {};
          const p = touch(ea.address, ea.name, when);
          if (p) { p.sent_count++; p.message_count++; }
        }
      } else {
        const p = touch(fromAddr, f.name, when);
        if (p) {
          p.message_count++;
          // Keep the newest body they sent. The signature block lives there,
          // and only in mail they wrote themselves.
          if (!p.sample) {
            const body = (m.body && m.body.contentType === 'html')
              ? htmlToText(m.body.content)
              : ((m.body && m.body.content) || m.bodyPreview || '');
            if (body) p.sample = String(body).slice(0, 4000);
          }
        }
      }
    }
    url = j['@odata.nextLink'] || null;
    if (scanned > 40000) break; // hard backstop
  }
  return { people: people, scanned: scanned, pages: pages };
}

/** Read signature blocks. Batched, because one call per contact is wasteful. */
async function parseSignatures(list) {
  const out = new Map();
  if (NO_AI || !process.env.ANTHROPIC_API_KEY) return out;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const withSample = list.filter(function (p) { return !!p.sample; });
  const BATCH = 8;

  for (let i = 0; i < withSample.length; i += BATCH) {
    const chunk = withSample.slice(i, i + BATCH);
    const blocks = chunk.map(function (p, n) {
      // The signature is at the BOTTOM. Send the tail, not the top.
      const tail = p.sample.length > 1400 ? p.sample.slice(-1400) : p.sample;
      return '--- ' + (n + 1) + ' --- ' + p.email + '\n' + tail;
    }).join('\n\n');

    const prompt = 'Below are ' + chunk.length + ' email excerpts, each the END of a message written by the person at that address. Pull their contact details out of the signature block.\n\n'
      + 'Copy ONLY what is literally written. If a field is not there, use null. Never guess a phone number, never infer an address from a company name, never expand an abbreviation. These go into a real address book and get dialled and mailed.\n\n'
      + 'For each numbered excerpt return:\n'
      + '  email    the address on the --- line, unchanged\n'
      + "  name     the person's full name\n"
      + '  title    their job title\n'
      + '  org      their company\n'
      + '  phone    main or direct office number, formatted as written\n'
      + '  mobile   only if labelled mobile or cell\n'
      + '  address  full street address on one line, only if a street address is present. A city and state alone is not an address.\n\n'
      + blocks + '\n\n'
      + 'Return STRICT JSON, no code fences: {"contacts":[{"email":"...","name":null,"title":null,"org":null,"phone":null,"mobile":null,"address":null}]}';

    try {
      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: 1800, messages: [{ role: 'user', content: prompt }],
      });
      const raw = String((r.content && r.content[0] && r.content[0].text) || '')
        .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const j = JSON.parse(raw);
      for (const c of j.contacts || []) {
        if (c && c.email) out.set(String(c.email).toLowerCase(), c);
      }
      process.stdout.write('    signatures ' + Math.min(i + BATCH, withSample.length) + '/' + withSample.length + '\r');
    } catch (e) {
      console.warn('\n    ! signature batch failed (' + e.message.slice(0, 60) + ') — those contacts keep name and email only');
    }
  }
  if (withSample.length) process.stdout.write('\n');
  return out;
}

/** The name Outlook itself shows for this address. Authoritative. */
function displayName(p) {
  const entries = Object.entries(p.names).sort(function (a, b) { return b[1] - a[1]; });
  return entries.length ? entries[0][0] : null;
}

function normName(s) {
  let t = String(s || '').toLowerCase();
  // Exchange writes plenty of display names as "Hess,Melody". Flip those
  // BEFORE punctuation is stripped, or the surname ends up first and the
  // comparison below reads Melody Hess and Hess Melody as two people.
  const comma = t.match(/^\s*([^,]+?)\s*,\s*([^,]+?)\s*$/);
  if (comma && !/(jr|sr|ii|iii|cmca|ams|pcam|cpa|esq|phd|md)\.?$/.test(comma[2].trim())) {
    t = comma[2] + ' ' + comma[1];
  }
  return t
    .replace(/(jr|sr|ii|iii|mr|mrs|ms|dr|cmca|ams|pcam|cpa|esq)\.?/g, '')
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Does the signature belong to the person who SENT this message?
 *
 * On a forwarded or replied thread the bottom of the body is the OLDEST
 * message, so the signature down there is whoever started the thread. Martha
 * forwards a vendor proposal, the vendor's signature is at the foot of it, and
 * a parser that trusts position files the vendor's name and phone under
 * Martha's address. That is exactly what happened on the first run:
 * mbravo@bedrocktx.com came back as "Ramsey Gonzalez",
 * president@canyongateatcincoranch.com came back as "Martha Bravo".
 *
 * Outlook's display name is not guessed — it is what the mailbox is called. So
 * the display name wins, and the signature is only believed when it agrees
 * about WHO it is. When it disagrees, the phone and address in it belong to a
 * different person and are dropped with the name.
 */
function signatureMatchesSender(sigName, dispName) {
  const a = normName(sigName), b = normName(dispName);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const at = a.split(' ').filter(Boolean), bt = b.split(' ').filter(Boolean);
  if (!at.length || !bt.length) return false;
  // Same surname, and the first names agree or one is genuinely an initial of
  // the other. Matching on first LETTER alone is too loose: John Smith and Jane
  // Smith pass it, and married couples and siblings share both a surname and an
  // inbox often enough that it would happen.
  if (at[at.length - 1] !== bt[bt.length - 1]) return false;
  if (at[0] === bt[0]) return true;
  const oneIsInitial = at[0].length === 1 || bt[0].length === 1;
  return oneIsInitial && at[0][0] === bt[0][0];
}

function bestName(p, sig) {
  const disp = displayName(p);
  if (disp) return disp;
  if (sig && sig.name) return sig.name;
  return p.email.split('@')[0];
}

// Exported so the identity-matching rule can be tested without a 20 minute
// mailbox walk. main() only runs when this file is the entry point.
module.exports = { signatureMatchesSender, normName, categoryFor, orgFromDomain, isNoise };

if (require.main !== module) return;

(async function main() {
  if (!isConfigured()) { console.error('graph_not_configured'); process.exit(1); }
  console.log('Reading ' + MAILBOX + ', last ' + MONTHS + ' months' + (DRY ? '  [DRY RUN]' : ''));

  const homeowners = await homeownerAddresses();
  console.log('  ' + homeowners.size + ' homeowner addresses on file — these stay out of the EA book');

  const h = await harvest(MAILBOX, MONTHS);
  console.log('  ' + h.scanned + ' messages over ' + h.pages + ' pages, ' + h.people.size + ' distinct correspondents');

  const all = Array.from(h.people.values());
  const droppedHomeowners = all.filter(function (p) { return homeowners.has(p.email); }).length;
  const candidates = all.filter(function (p) {
    if (homeowners.has(p.email)) return false;
    return p.sent_count > 0 || p.message_count >= 2;
  }).sort(function (a, b) {
    return (b.sent_count - a.sent_count) || (b.message_count - a.message_count);
  });

  console.log('  ' + candidates.length + ' qualify (' + droppedHomeowners + ' were homeowners, '
    + (all.length - candidates.length - droppedHomeowners) + ' were one-off inbound)');

  const sigs = await parseSignatures(candidates);

  let added = 0, updated = 0, skipped = 0, withPhone = 0, withAddress = 0;
  let sigRejected = 0;
  for (const p of candidates) {
    let sig = sigs.get(p.email) || {};
    // Believe the signature only if it is about the person who sent the mail.
    // A phone number under the wrong name is worse than a blank field: it is
    // the one Ed would actually dial.
    if (sig.name && !signatureMatchesSender(sig.name, displayName(p))) { sig = {}; sigRejected++; }
    const org = sig.org || orgFromDomain(p.email);
    const row = {
      name: bestName(p, sig),
      email: p.email,
      organization: org || null,
      title: sig.title || null,
      phone: sig.phone || null,
      mobile: sig.mobile || null,
      address: sig.address || null,
      category: categoryFor(p.email, org, sig.title),
      source: 'email',
      message_count: p.message_count,
      sent_count: p.sent_count,
      last_seen_at: p.last_seen_at,
      created_by: MAILBOX,
    };
    if (row.phone || row.mobile) withPhone++;
    if (row.address) withAddress++;

    if (DRY) { added++; continue; }

    const ex = await supabase.from('ea_contacts').select('*').ilike('email', p.email).limit(1);
    if (ex.error) { console.warn('  ! lookup ' + p.email + ': ' + ex.error.message); skipped++; continue; }

    if (ex.data && ex.data.length) {
      const cur = ex.data[0];
      // Never clobber something a person entered. Fill blanks, refresh counts.
      const patch = { message_count: row.message_count, sent_count: row.sent_count, last_seen_at: row.last_seen_at };
      for (const k of ['name', 'organization', 'title', 'phone', 'mobile', 'address', 'category']) {
        if (!cur[k] && row[k]) patch[k] = row[k];
      }
      const up = await supabase.from('ea_contacts').update(patch).eq('id', cur.id);
      if (up.error) { console.warn('  ! update ' + p.email + ': ' + up.error.message); skipped++; continue; }
      updated++;
    } else {
      const ins = await supabase.from('ea_contacts').insert(row);
      if (ins.error) { console.warn('  ! insert ' + p.email + ': ' + ins.error.message); skipped++; continue; }
      added++;
    }
  }

  console.log('\n' + (DRY ? 'would add ' : 'added ') + added + ', updated ' + updated + ', skipped ' + skipped);
  console.log('  ' + withPhone + ' have a phone, ' + withAddress + ' have a street address');
  console.log('  ' + sigRejected + ' signature(s) discarded — belonged to someone else on a forwarded thread');
  console.log('\nTop 15 by how often Ed writes to them:');
  candidates.slice(0, 15).forEach(function (p) {
    const s = sigs.get(p.email) || {};
    const nm = bestName(p, s);
    console.log('  ' + String(p.sent_count).padStart(4) + ' sent  '
      + nm.slice(0, 26).padEnd(28) + p.email.padEnd(38) + (s.phone || ''));
  });
})().catch(function (e) { console.error('contact build failed:', e.message); process.exit(1); });
