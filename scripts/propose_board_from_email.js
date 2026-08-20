// ============================================================================
// scripts/propose_board_from_email.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Works out who sits on each community's board by reading Ed's email, and
// proposes it for confirmation before anything is written.
//
// Ed: "is there a way to have tessa be able to email the whole board for each
// community in its list, pulling it from my emails and populating the board in
// trusted."
//
// Five of eight communities have NO board on file: August Meadows, Canyon Gate,
// Eaglewood, Quail Ridge and Still Creek Ranch. Tessa cannot email a board that
// does not exist, so this is the blocker, not the sending.
//
// WHY IT PROPOSES INSTEAD OF WRITING. A wrong name in board_members is not a
// cosmetic error. That table feeds the board portal's access, the nominations
// seat derivation, and who receives board correspondence. Writing a homeowner
// into it because they were loud on a thread would hand them board mail. So
// this prints evidence and writes nothing until --apply.
//
// THE SIGNALS, strongest first:
//
//   1. OWNS PROPERTY IN THAT COMMUNITY. A director must be an owner, so this is
//      close to a requirement rather than a hint. Resolved through
//      property_ownerships, the same path the platform uses everywhere else.
//   2. A ROLE ALIAS ON THE COMMUNITY'S OWN DOMAIN, like
//      president@canyongateatcincoranch.com. That is the seat, addressed
//      directly, and it says which seat.
//   3. HOW OFTEN THEY APPEAR ON THAT COMMUNITY'S BOARD THREADS. Volume alone
//      proves nothing (a manager appears on all of them), so it only ranks
//      people who already cleared 1 or 2.
//
// Bedrock staff are excluded throughout. Martha is on every board thread for
// every community and is not on anybody's board.
//
//   node scripts/propose_board_from_email.js
//   node scripts/propose_board_from_email.js --community "Canyon Gate"
//   node scripts/propose_board_from_email.js --apply
// ============================================================================
require('dotenv').config();
const { getToken, isConfigured } = require('../lib/email/graph_send');
const { htmlToText } = require('../lib/email/graph_attachments');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function arg(name, fallback = null) {
  const eq = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
const APPLY = process.argv.includes('--apply');
const ONLY = arg('community', null);
const MONTHS = parseInt(arg('months', '24'), 10);
const MAILBOX = arg('mailbox', 'egojara@bedrocktx.com');
const OWNER = MAILBOX.toLowerCase();

// The seat, when the address IS the seat.
const ROLE_BY_LOCALPART = {
  president: 'President',
  vicepresident: 'Vice President',
  'vice-president': 'Vice President',
  vp: 'Vice President',
  secretary: 'Secretary',
  treasurer: 'Treasurer',
  director: 'Director',
  boardmember: 'Director',
  board: 'Director',
};

// Words that make a thread board business rather than a homeowner complaint.
const BOARD_WORDS = /\b(board|director|agenda|minutes|motion|quorum|executive session|annual meeting|budget approval|vote|voting|resolution|bod\b)\b/i;

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Name forms a community might be written or domained as. */
function communityKeys(c) {
  const name = String(c.name || '');
  const tokens = name.toLowerCase().split(/\s+/).filter((t) => !['at', 'the', 'of'].includes(t));
  return {
    id: c.id,
    name,
    // "canyongateatcincoranch" and "canyongatecincoranch" both appear as domains.
    compacts: [compact(name), tokens.join(''), compact(c.slug)].filter(Boolean),
    // Full name in prose, plus a two-word short form people actually type.
    phrases: [name.toLowerCase(), tokens.slice(0, 2).join(' ')].filter((p) => p.length > 5),
  };
}

/** Every owner email in the portfolio, mapped to the community they own in. */
async function ownerIndex() {
  const byEmail = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('property_ownerships')
      .select('contact_id, properties:property_id(community_id), contacts:contact_id(full_name, primary_email)')
      .order('contact_id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error('property_ownerships read failed: ' + error.message);
    for (const r of data || []) {
      const email = r.contacts && r.contacts.primary_email;
      const cid = r.properties && r.properties.community_id;
      if (!email || !cid) continue;
      byEmail.set(String(email).toLowerCase(), { community_id: cid, name: r.contacts.full_name, contact_id: r.contact_id });
    }
    if (!data || data.length < 1000) break;
  }
  return byEmail;
}

/** Which community is this message about? Domain first, then the name in prose. */
function communityOf(keys, participants, text) {
  for (const p of participants) {
    const domain = compact(String(p.address || '').split('@')[1] || '');
    if (!domain) continue;
    for (const k of keys) {
      if (k.compacts.some((c) => c.length > 6 && domain.includes(c))) return { key: k, how: 'domain' };
    }
  }
  const hay = String(text || '').toLowerCase();
  const hits = keys.filter((k) => k.phrases.some((p) => hay.includes(p)));
  // Two communities named in one message is a portfolio email, not board mail.
  if (hits.length === 1) return { key: hits[0], how: 'named' };
  return null;
}

async function harvest(keys, owners) {
  const since = new Date(Date.now() - MONTHS * 30 * 864e5).toISOString();
  const token = await getToken();
  const sel = 'subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview';
  let url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(MAILBOX) + '/messages'
    + '?$select=' + sel + '&$top=50&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ' + since;

  // community_id -> email -> evidence
  const found = new Map();
  let scanned = 0, boardThreads = 0;

  while (url) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('graph ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    for (const m of j.value || []) {
      scanned++;
      const body = (m.body && m.body.contentType === 'html')
        ? htmlToText(m.body.content) : ((m.body && m.body.content) || m.bodyPreview || '');
      const text = (m.subject || '') + '\n' + String(body).slice(0, 6000);
      if (!BOARD_WORDS.test(text)) continue;

      const f = (m.from && m.from.emailAddress) || {};
      const people = [f].concat(
        (m.toRecipients || []).map((x) => x.emailAddress || {}),
        (m.ccRecipients || []).map((x) => x.emailAddress || {}));

      const hit = communityOf(keys, people, text);
      if (!hit) continue;
      boardThreads++;

      if (!found.has(hit.key.id)) found.set(hit.key.id, new Map());
      const bucket = found.get(hit.key.id);

      for (const p of people) {
        const email = String(p.address || '').toLowerCase();
        if (!email || !email.includes('@')) continue;
        if (email === OWNER) continue;
        // Bedrock staff run the meetings; they are not on the board.
        if (/@bedrocktx\.com$/i.test(email)) continue;
        if (/^(no-?reply|do-?not-?reply|postmaster|mailer-daemon)/i.test(email)) continue;

        if (!bucket.has(email)) {
          bucket.set(email, { email, names: {}, threads: 0, last: null });
        }
        const rec = bucket.get(email);
        rec.threads++;
        const nm = String(p.name || '').trim();
        if (nm && !nm.toLowerCase().includes('@')) rec.names[nm] = (rec.names[nm] || 0) + 1;
        if (m.receivedDateTime && (!rec.last || m.receivedDateTime > rec.last)) rec.last = m.receivedDateTime;
      }
    }
    url = j['@odata.nextLink'] || null;
  }
  return { found, scanned, boardThreads };
}

function seatFor(email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z-]/g, '');
  return ROLE_BY_LOCALPART[local] || null;
}

function bestName(rec) {
  const e = Object.entries(rec.names).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : null;
}

(async () => {
  if (!isConfigured()) { console.error('graph_not_configured'); process.exit(1); }

  const { data: comms, error: ce } = await supabase.from('communities')
    .select('id, name, slug, is_demo').neq('is_demo', true).order('name');
  if (ce) throw new Error('communities read failed: ' + ce.message);

  const keys = comms.filter((c) => !ONLY || c.name.toLowerCase().includes(ONLY.toLowerCase())).map(communityKeys);
  if (!keys.length) { console.error('no community matched ' + ONLY); process.exit(1); }

  const { data: existing, error: be } = await supabase.from('board_members')
    .select('id, community_id, name, position, email, is_active');
  if (be) throw new Error('board_members read failed: ' + be.message);
  const onFile = new Map();
  for (const b of existing || []) {
    if (b.email) onFile.set(String(b.email).toLowerCase(), b);
  }

  console.log('Reading ' + MAILBOX + ', last ' + MONTHS + ' months, for board mail across '
    + keys.length + ' communit' + (keys.length === 1 ? 'y' : 'ies'));

  const owners = await ownerIndex();
  console.log('  ' + owners.size + ' owner addresses indexed');

  const { found, scanned, boardThreads } = await harvest(keys, owners);
  console.log('  ' + scanned + ' messages scanned, ' + boardThreads + ' matched a community and read as board business\n');

  const proposals = [];
  for (const k of keys) {
    const bucket = found.get(k.id) || new Map();
    const rows = [...bucket.values()].map((rec) => {
      const own = owners.get(rec.email);
      const ownsHere = !!(own && own.community_id === k.id);
      const seat = seatFor(rec.email);
      const onCommunityDomain = k.compacts.some((c) => c.length > 6
        && compact(String(rec.email).split('@')[1] || '').includes(c));
      return {
        email: rec.email,
        name: (own && own.name) || bestName(rec) || rec.email.split('@')[0],
        seat,
        threads: rec.threads,
        last: rec.last,
        ownsHere,
        roleAlias: !!(seat && onCommunityDomain),
        already: onFile.has(rec.email),
      };
    })
      // The bar: an owner in this community, or the seat's own address.
      .filter((r) => r.ownsHere || r.roleAlias)
      .sort((a, b) => b.threads - a.threads);

    console.log('=== ' + k.name + ' ===');
    if (!rows.length) { console.log('  nothing confident enough to propose\n'); continue; }
    for (const r of rows) {
      const why = [
        r.ownsHere ? 'owns here' : null,
        r.roleAlias ? 'seat address (' + r.seat + ')' : null,
        r.threads + ' board thread' + (r.threads === 1 ? '' : 's'),
        r.last ? 'last ' + String(r.last).slice(0, 10) : null,
      ].filter(Boolean).join(' · ');
      console.log('  ' + (r.already ? '[on file] ' : '[    new] ')
        + String(r.name).slice(0, 26).padEnd(28) + r.email.padEnd(40) + why);
      if (!r.already) proposals.push({ community: k, row: r });
    }
    console.log();
  }

  console.log(proposals.length + ' new board member(s) proposed.');
  if (!proposals.length) return;

  if (!APPLY) {
    console.log('\nNothing written. Review the list, then re-run with --apply.');
    console.log('board_members drives board portal access, nominations seat counts and');
    console.log('board correspondence, so a wrong row here sends real mail to the wrong person.');
    return;
  }

  let added = 0;
  for (const p of proposals) {
    const { error } = await supabase.from('board_members').insert({
      management_company_id: '00000000-0000-0000-0000-000000000001',
      community_id: p.community.id,
      community_name: p.community.name,
      name: p.row.name,
      position: p.row.seat || 'Director',
      email: p.row.email,
      is_active: true,
      // Deliberately no term_end. deriveSeatsOpen() reads it to work out which
      // seats expire, and a guessed date there would put a seat up for election
      // that is not actually open.
      notes: 'Proposed from email correspondence 2026-08-20: '
        + (p.row.ownsHere ? 'owns a property in this community; ' : '')
        + (p.row.roleAlias ? 'writes from the seat address; ' : '')
        + p.row.threads + ' board threads. Term dates not known.',
    });
    if (error) { console.warn('  ! ' + p.row.email + ': ' + error.message); continue; }
    added++;
  }
  console.log('wrote ' + added + ' board member(s). Term dates are blank on purpose.');
})().catch((e) => { console.error('board proposal failed:', e.message); process.exit(1); });
