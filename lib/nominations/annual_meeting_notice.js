// ============================================================================
// annual_meeting_notice.js
// ----------------------------------------------------------------------------
// Bedrock-branded Annual Meeting Notice + Proxy/Absentee Ballot + Candidate
// Statements. Generates a multi-page document a board signs off on and a
// management company mails to every homeowner.
//
// One template, bespoke per community via knobs:
//   - voting_methods       which methods accepted (online / mail / email /
//                          drop-off / in-person) and the deadline for each
//   - floor_nominations    'allowed' | 'not_allowed' (drives the explicit
//                          notice on page 2)
//   - term_years           length of each director term (3 default)
//   - tx_209_disclosure    'callout' (Canyon Gate style) | 'embedded'
//                          (Waterview style); always present per statute
//   - agenda               array of meeting agenda items (defaults provided)
//   - candidates           on_slate nominations with optional photo + years-
//                          in-community
//   - registration_time    optional "Registration commences at..." line
//   - vote_override_rule   text describing what happens when multiple votes
//                          are received (defaults to the Bedrock standard)
//
// Inputs are pure data; the renderer is a transformation. Schema additions
// to back the UI for these knobs live in migration 044.
// ============================================================================

const fs = require('fs');
const path = require('path');
const BRAND = require('../brand');

const LOGOS_DIR = path.join(__dirname, '..', '..', 'public', 'logos');

const COMMUNITY_LOGOS = {
  'Lakes of Pine Forest':        'lakes_of_pine_forest_logo.png',
  'Canyon Gate at Cinco Ranch':  'canyon_gate_logo.png',
  'Canyon Gate':                 'canyon_gate_logo.png',
  'Waterview Estates':           'waterview_logo.jpg',
  'Waterview':                   'waterview_logo.jpg',
};
const _dataUriCache = {};
function logoDataUri(filename) {
  if (!filename) return '';
  if (_dataUriCache[filename] !== undefined) return _dataUriCache[filename];
  try {
    const buf = fs.readFileSync(path.join(LOGOS_DIR, filename));
    const mime = filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg' : 'image/png';
    _dataUriCache[filename] = `data:${mime};base64,` + buf.toString('base64');
  } catch (_) {
    _dataUriCache[filename] = '';
  }
  return _dataUriCache[filename];
}
function getCommunityLogo(community) {
  if (!community) return '';
  if (COMMUNITY_LOGOS[community]) return logoDataUri(COMMUNITY_LOGOS[community]);
  for (const [name, file] of Object.entries(COMMUNITY_LOGOS)) {
    if (community.toLowerCase().includes(name.toLowerCase())) return logoDataUri(file);
  }
  return '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '';
  const dt = new Date(String(d).length === 10 ? `${d}T12:00:00` : d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function fmtTime12h(t) {
  if (!t) return '';
  const s = String(t).trim();
  // Already formatted (e.g., "6:30 PM" / "6:00 p.m.") → return as-is.
  if (/[apAP]\.?\s*[mM]\.?/.test(s)) return s.replace(/\s+/g, ' ');
  // 24h HH:MM → 12h
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    let h = Number(m[1]);
    const mm = m[2];
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${mm} ${ampm}`;
  }
  return s;
}

function toRoman(n) {
  const map = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]];
  let r = '';
  for (const [sym, val] of map) { while (n >= val) { r += sym; n -= val; } }
  return r;
}

// Convert a small integer to its English word form ("two", "three", etc.).
// Used by the agenda + ballot intro lines so the rendered Notice reads
// "Election of two (2) Directors" rather than "Election of 2 (2) Directors"
// — matches Canyon Gate's 2026 packet convention (also matches every other
// formal HOA election notice).
function numberToWords(n) {
  const words = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten', 'eleven', 'twelve',
  ];
  if (n >= 0 && n < words.length) return words[n];
  return String(n);  // fallback for unusual seat counts
}

// Title-case the word form for use as a noun in agenda items ("One (1)"
// not "one (1)" at the start of the phrase).
function numberToWordsTitled(n) {
  const w = numberToWords(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// Default agenda — used when the cycle doesn't have a custom one. Pulls
// directly from the Canyon Gate 2026 template which is the Bedrock standard.
function defaultAgenda(seatsOpen, termYears) {
  const wordTitled = numberToWordsTitled(seatsOpen);
  const seatPhrase = `${wordTitled} (${seatsOpen}) Director${seatsOpen === 1 ? '' : 's'}`;
  const termPhrase = termYears ? ` (${termYears}-Year Term${seatsOpen === 1 ? '' : 's'})` : '';
  return [
    'Call to Order and Announcement of Quorum',
    'Introduction of Board Members & Management Company',
    `Approval of Minutes of Prior Annual Meeting`,
    "President's Report",
    'Financial Report',
    `Election of ${seatPhrase}${termPhrase}`,
    'Community Updates / Improvements',
    'Open Forum',
    'Adjournment',
  ];
}

// Vote-override-rule default — captures both the precedence (in-person wins)
// and the tie-breaker for multiple online/absentee submissions (most recent).
const DEFAULT_VOTE_OVERRIDE_RULE =
  'If you submit votes through more than one method, an in-person vote on the night of the meeting takes precedence over any prior vote. If you do not vote in person, the most recently received online or absentee ballot will be counted.';

// TX §209.00592 disclosure language. Required for any electronic or
// absentee ballot. We support two presentation styles:
//   'callout'  — boxed paragraph (Canyon Gate 2026 style)
//   'embedded' — paragraph mixed into the proxy text (Waterview 2024 style)
const TX_209_TEXT =
  'By casting your vote via absentee ballot or electronic ballot, you forgo the opportunity to consider and vote on any action from the floor on these proposals, if a meeting is held. This means that if there are amendments to these proposals, your vote will not be counted on the final vote of these measures. If you wish to retain the ability to vote on floor amendments or floor nominations, please attend the meeting in person.';

// renderAnnualMeetingNoticeHTML
// ----------------------------------------------------------------------------
// Inputs:
//   cycle             — nomination_cycles row (community_name, meeting_date,
//                       time, location, seats_open, etc.)
//   candidates        — array of on-slate nominations with optional photo
//                       data URI and years_in_community
//   voting_methods    — { online, mail, email, drop_off, in_person } each
//                       optionally {enabled, ...method-specific fields}
//   options:
//     agenda                 string[] or null (use default if absent)
//     floor_nominations      'allowed' | 'not_allowed' | null
//     term_years             int (default 3)
//     registration_time      string (optional preamble line)
//     vote_override_rule     string (default standard)
//     tx_209_disclosure      'callout' | 'embedded' (default 'callout')
//     quorum_only_label      string (default 'Quorum Only')
//     mgmt_address           string (default Bedrock address)
//     mgmt_phone             string (default Bedrock phone)
//     mgmt_website           string (default bedrocktx.com)
//     include_candidate_bios bool (default true) — when FALSE the
//                          candidate-statements pages are omitted so
//                          the mailed packet is shorter / cheaper to
//                          mail. Bios still appear on the online ballot
//                          + the community website (linked in the
//                          voting instructions section). When TRUE,
//                          full bios + photos print as a separate
//                          pages-4+ section (legacy behavior).
//     community_website_url  string (optional) — public-facing community
//                          site URL printed in the voting instructions
//                          when bios are omitted. Falls back to "the
//                          online ballot" only when absent.
// Sort candidates per the cycle's candidate_sort_mode (migration 132).
// Modes:
//   'alphabetical'     — last name A→Z (default; pre-132 behavior)
//   'incumbents_first' — is_incumbent=true first (alpha within bucket),
//                        then challengers (alpha within bucket)
//   'manual'           — sorted by ballot_order ASC (NULLs last, then
//                        alphabetical among nulls)
// Returns a new array — never mutates the input.
function sortCandidatesByMode(candidates, mode) {
  const lastName = (c) => (c.nominee_name || '').split(' ').slice(-1)[0].toLowerCase();
  const out = [...(candidates || [])];
  if (mode === 'incumbents_first') {
    out.sort((a, b) => {
      const ai = a.is_incumbent ? 0 : 1;
      const bi = b.is_incumbent ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return lastName(a).localeCompare(lastName(b));
    });
  } else if (mode === 'manual') {
    out.sort((a, b) => {
      const ao = (typeof a.ballot_order === 'number') ? a.ballot_order : Number.POSITIVE_INFINITY;
      const bo = (typeof b.ballot_order === 'number') ? b.ballot_order : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return lastName(a).localeCompare(lastName(b));
    });
  } else {
    // 'alphabetical' (default) — same as pre-132
    out.sort((a, b) => lastName(a).localeCompare(lastName(b)));
  }
  return out;
}

async function renderAnnualMeetingNoticeHTML({
  cycle,
  candidates = [],
  voting_methods = {},
  options = {},
}) {
  const communityName = cycle.community_name || 'the Association';
  // Resolve the formal entity name in order:
  //   1. Explicit cycle.association_legal_name (set via migration 146 +
  //      operator overrides). Source of truth when present.
  //   2. Known-communities lookup for the current Bedrock book. Lets new
  //      cycles auto-pick the right name without operator intervention.
  //   3. Last-resort default of "${community_name} Association, Inc." —
  //      Almost certainly WRONG for any specific community but better than
  //      blank text. Triggers when a community is added without seeding.
  const COMMUNITY_LEGAL_NAMES = {
    'Waterview Estates':            "Waterview Estates Owners' Association",
    'Waterview':                    "Waterview Estates Owners' Association",
    'Canyon Gate at Cinco Ranch':   'Canyon Gate at Cinco Ranch Association, Inc.',
    'Canyon Gate':                  'Canyon Gate at Cinco Ranch Association, Inc.',
    'Lakes of Pine Forest':         'Lakes of Pine Forest Community Improvement Association, Inc.',
    'Eaglewood':                    'Eaglewood Property Owners Association, Inc.',
    'Quail Ridge':                  'Quail Ridge Property Owners Association, Inc.',
    'Still Creek Ranch':            'Still Creek Ranch Homeowners Association, Inc.',
    'August Meadows':               'August Meadows Community Association, Inc.',
  };
  const associationLegalName =
    cycle.association_legal_name
    || COMMUNITY_LEGAL_NAMES[communityName]
    || `${communityName} Association, Inc.`;

  // ---- Sort candidates ONCE per cycle config (mig 132) --------------------
  // Both the ballot section (page 3) and the statements section (page 4)
  // use this single sorted array, so order is guaranteed consistent across
  // the notice. Pre-132, the ballot used input order and the statements
  // section sorted alphabetically inline — that was inconsistent and
  // would have caused the ballot to disagree with the statements page if
  // the caller ever passed an unsorted array.
  const sortMode = cycle.candidate_sort_mode || 'alphabetical';
  const orderedCandidates = sortCandidatesByMode(candidates, sortMode);
  const meetingDate = cycle.annual_meeting_date;
  const meetingTime = cycle.annual_meeting_time;
  const meetingLocation = cycle.annual_meeting_location;
  const seatsOpen = Number(cycle.seats_open || 1);

  const opts = {
    term_years:          options.term_years || 3,
    floor_nominations:   options.floor_nominations || cycle.floor_nominations_policy || null,
    registration_time:   options.registration_time || cycle.registration_time || null,
    vote_override_rule:  options.vote_override_rule || DEFAULT_VOTE_OVERRIDE_RULE,
    tx_209_disclosure:   options.tx_209_disclosure || 'callout',
    quorum_only_label:   options.quorum_only_label || 'Quorum Only',
    mgmt_address:        options.mgmt_address || BRAND.service.addressInline,
    mgmt_phone:          options.mgmt_phone   || BRAND.service.phone,
    mgmt_website:        options.mgmt_website || BRAND.service.website,
    voting_year:         options.voting_year || (meetingDate ? new Date(meetingDate).getFullYear() : new Date().getFullYear()),
    // 'detailed' = Canyon Gate 2026 style (separate notice + voting
    // instructions + ballot pages). Default after migration 145 — Ed
    // reviewed both and prefers the detailed look. 'compact' is still
    // supported for boards that want the single-page packet.
    layout_mode:         options.layout_mode || cycle.layout_mode || 'detailed',
    // Two-version split (added 2026-06): the mailing version drops the
    // candidate-statements section to shorten the packet (boards pay per
    // page mailed). The website version keeps bios for posting online.
    // Defaults to TRUE so existing call sites keep their legacy
    // behavior; the new "📬 Mailing version" button passes FALSE.
    include_candidate_bios: options.include_candidate_bios !== false,
    community_website_url: options.community_website_url || cycle.community_website_url || null,
  };

  const agendaItems = options.agenda && options.agenda.length
    ? options.agenda
    : defaultAgenda(seatsOpen, opts.term_years);

  const logo = getCommunityLogo(communityName);
  const upperName = communityName.toUpperCase();

  const pageFooter = `
    <div class="page-footer">
      ${escapeHtml(associationLegalName)} &nbsp;|&nbsp; c/o ${BRAND.service.legal}<br>
      ${escapeHtml(opts.mgmt_address)} &nbsp;|&nbsp; ${escapeHtml(opts.mgmt_phone)} &nbsp;|&nbsp; ${escapeHtml(opts.mgmt_website)}
    </div>`;

  // ---- Voting methods section -----------------------------------------------
  const methods = voting_methods || {};
  const methodSections = [];
  let methodNum = 0;

  if (methods.online && methods.online.enabled) {
    methodNum += 1;
    const close = methods.online.close_date;
    const closeTime = fmtTime12h(methods.online.close_time || '4:00 PM');
    methodSections.push(`
      <h3 class="method-heading"><span class="num">${methodNum}.</span> Vote Online</h3>
      <p>${escapeHtml(methods.online.instructions || 'Scan the QR code or visit the unique link printed on the personalized voting letter mailed to your household. You will be taken directly to your personal ballot, and the system will confirm that your vote was recorded.')}</p>
      ${close ? `<p class="deadline-line"><strong>Online voting closes: ${escapeHtml(fmtDate(close))}${closeTime ? ` at ${escapeHtml(closeTime)}` : ''}.</strong></p>` : ''}
    `);
  }

  const showMailGroup = (methods.mail && methods.mail.enabled) ||
                       (methods.email && methods.email.enabled) ||
                       (methods.drop_off && methods.drop_off.enabled);
  if (showMailGroup) {
    methodNum += 1;
    const channelLabels = [];
    if (methods.mail && methods.mail.enabled)    channelLabels.push('Mail');
    if (methods.email && methods.email.enabled)  channelLabels.push('Email');
    if (methods.drop_off && methods.drop_off.enabled) channelLabels.push('Drop-Off');
    const channelsLi = [];
    if (methods.mail && methods.mail.enabled) {
      const addr = methods.mail.return_address || `${BRAND.service.name}, ${opts.mgmt_address}`;
      channelsLi.push(`<li><strong>Mail:</strong> ${escapeHtml(addr)}</li>`);
    }
    if (methods.email && methods.email.enabled) {
      channelsLi.push(`<li><strong>Email:</strong> ${escapeHtml(methods.email.address || '${BRAND.service.email}')}</li>`);
    }
    if (methods.drop_off && methods.drop_off.enabled) {
      const loc = methods.drop_off.location_name || 'On-site office';
      const addr = methods.drop_off.location_address;
      channelsLi.push(`<li><strong>Drop-off:</strong> ${escapeHtml(loc)}${addr ? ', ' + escapeHtml(addr) : ''}</li>`);
    }
    // Deadline — first method in the group with a date wins
    const recvDate = (methods.mail && methods.mail.receive_by_date) ||
                     (methods.email && methods.email.receive_by_date) ||
                     (methods.drop_off && methods.drop_off.receive_by_date);
    const recvTime = fmtTime12h(
      (methods.mail && methods.mail.receive_by_time) ||
      (methods.email && methods.email.receive_by_time) ||
      (methods.drop_off && methods.drop_off.receive_by_time) ||
      '4:00 PM'
    );
    methodSections.push(`
      <h3 class="method-heading"><span class="num">${methodNum}.</span> Vote by ${channelLabels.join(', ')}</h3>
      <p>Complete the Proxy / Absentee Ballot below, sign it, and return it by one of the following methods:</p>
      <ul class="channel-list">${channelsLi.join('')}</ul>
      ${recvDate ? `<p class="deadline-line"><strong>${channelLabels.join(' / ')} ballots must be received by: ${escapeHtml(fmtDate(recvDate))}${recvTime ? ` at ${escapeHtml(recvTime)}` : ''}.</strong></p>` : ''}
    `);
  }

  if (methods.in_person && methods.in_person.enabled) {
    methodNum += 1;
    const regLine = opts.registration_time
      ? ` Registration commences at ${escapeHtml(fmtTime12h(opts.registration_time))}.`
      : '';
    methodSections.push(`
      <h3 class="method-heading"><span class="num">${methodNum}.</span> Vote in Person</h3>
      <p>Attend the Annual Meeting on <strong>${escapeHtml(fmtDate(meetingDate))}${meetingTime ? ` at ${escapeHtml(fmtTime12h(meetingTime))}` : ''}</strong>${meetingLocation ? ` at ${escapeHtml(meetingLocation)}` : ''}.${regLine} You may vote in person at the meeting even if you have already submitted a prior ballot — your in-person vote will override any prior vote.</p>
    `);
  }

  // Floor-nominations notice on the voting-instructions page
  let floorNoticeHtml = '';
  if (opts.floor_nominations === 'not_allowed') {
    floorNoticeHtml = `<div class="floor-notice floor-notice-strict"><strong>Please note:</strong> Nominations will <strong>not</strong> be accepted from the floor during the Annual Meeting. The candidates listed on the ballot are those who submitted nominations by the close date in the prior Call for Nominations.</div>`;
  } else if (opts.floor_nominations === 'allowed') {
    floorNoticeHtml = `<div class="floor-notice floor-notice-open">Nominations may also be made from the floor at the Annual Meeting. Submitting before the deadline ensures your name appears on the mailed ballot.</div>`;
  }

  const tx209Callout = opts.tx_209_disclosure === 'callout'
    ? `<div class="tx209-callout"><div class="hdr">Required disclosure under Texas Property Code §209.00592:</div>${escapeHtml(TX_209_TEXT)}</div>`
    : '';

  // "Where to find candidate bios" callout — printed on the voting
  // instructions page so homeowners know the mailed packet isn't the
  // only place to read about who's running. Two variants:
  //   - has website URL → "online ballot + association website at <url>"
  //   - no website URL  → "online ballot" only
  // Always printed when bios are OMITTED from the mailed PDF. Also
  // printed when bios ARE included so the online experience is still
  // surfaced (cheaper for the homeowner to read on screen than flip
  // pages, and surfaces the website for communities that have one).
  const websiteUrl = opts.community_website_url ? String(opts.community_website_url).trim() : '';
  const websiteHostname = websiteUrl
    ? websiteUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    : '';
  const biosLocationHtml = (() => {
    if (!opts.include_candidate_bios) {
      // Mailing version — bios NOT in the packet. Make this prominent.
      const where = websiteUrl
        ? `on the online ballot (via the personalized link on your voting letter) and on the association's website at <a href="${escapeHtml(websiteUrl)}" style="color:${BRAND.colors.navy};">${escapeHtml(websiteHostname)}</a>`
        : `on the online ballot (via the personalized link on your voting letter) and on the association's website`;
      return `<div class="bios-callout"><strong>Candidate biographies:</strong> Full candidate biographies are available ${where}.</div>`;
    }
    // Website version — bios are in the packet AND online. Soft note.
    if (websiteUrl) {
      return `<div class="bios-callout-soft">Full candidate biographies are also available on the online ballot and on the association's website at <a href="${escapeHtml(websiteUrl)}" style="color:${BRAND.colors.navy};">${escapeHtml(websiteHostname)}</a>.</div>`;
    }
    return `<div class="bios-callout-soft">Full candidate biographies are also available on the online ballot.</div>`;
  })();

  // ---- Proxy/Absentee Ballot section ---------------------------------------
  // Uses orderedCandidates (sorted at the top per cycle.candidate_sort_mode)
  // so the ballot order matches the candidate statements order exactly.
  const directedHtml = orderedCandidates.length > 0
    ? orderedCandidates.map((c) => `
        <div class="ballot-candidate">
          [ &nbsp; ] &nbsp; ${escapeHtml(c.nominee_name || '')}${c.is_incumbent ? ' <em>(incumbent)</em>' : ''}
        </div>
      `).join('')
    : '<p style="color:#94A3B8; font-style:italic;">(Candidate names will be inserted from the nominations on slate.)</p>';

  const writeInHtml = (options.write_in_allowed !== false)
    ? `<div class="ballot-candidate" style="margin-top:8px;">[ &nbsp; ] &nbsp; Write-in: <span class="fill-line"></span></div>`
    : '';

  // "two (2)" style across the board — matches Canyon Gate's packet
  // and the agenda line generated by defaultAgenda above.
  const seatsPhrase = `${numberToWords(seatsOpen)} (${seatsOpen})`;
  const directorWord = seatsOpen === 1 ? 'Director' : 'Directors';

  // Embedded TX 209 inside proxy intro (Waterview style) — present only when
  // the callout style is NOT used.
  const txEmbedded = opts.tx_209_disclosure === 'embedded'
    ? ` <em>${escapeHtml(TX_209_TEXT)}</em>`
    : '';

  // ---- Candidate Statements section ----------------------------------------
  // Uses orderedCandidates (sorted at the top per cycle.candidate_sort_mode)
  // — matches the ballot order on page 3. Inline alpha-sort here is no
  // longer needed; the cycle-level sort mode is the single source of truth.
  const candidateCards = orderedCandidates.map((c) => {
    // Resolution order: pre-resolved data URI > signed URL > raw path.
    const photo = c.photo_data_uri || c.photo_url || c.photo_storage_path || '';
    const photoBlock = photo
      ? `<div class="cand-photo"><img src="${photo}" alt="${escapeHtml(c.nominee_name)}"></div>`
      : `<div class="cand-photo cand-photo-empty"><span>No photo<br>submitted</span></div>`;
    const yearsLine = c.years_in_community
      ? `<div class="cand-years">In ${escapeHtml(communityName)} since ${escapeHtml(String(c.years_in_community))}</div>`
      : '';
    const bio = c.nominee_bio || '<em>No bio submitted.</em>';
    return `
      <div class="cand-row">
        ${photoBlock}
        <div class="cand-body">
          <div class="cand-name">${escapeHtml(c.nominee_name)}${c.is_incumbent ? ' <span class="incumbent">(incumbent)</span>' : ''}</div>
          ${yearsLine}
          <div class="cand-bio">${c.nominee_bio ? escapeHtml(bio) : '<em>No bio submitted.</em>'}</div>
        </div>
      </div>`;
  });

  // 2 candidates per page. Earlier attempt used a single .page wrapper with
  // internal page-breaks, which fought with the .page-after-always rule and
  // still spread bios across 4 pages on a 4-candidate slate. Cleaner shape:
  // each pair gets its OWN .page div, so the browser's standard page-break
  // logic handles everything and every candidate page renders the community
  // header at the top (matches Canyon Gate's layout).
  const candidatePairs = [];
  for (let i = 0; i < candidateCards.length; i += 2) {
    candidatePairs.push(candidateCards.slice(i, i + 2).join(''));
  }

  // ============================ HTML ========================================
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  /* Tighter margins + body font 11pt → 10.5pt to reduce mailed page count.
     Holds the line at 10pt minimum (EAC voluntary floor / CAI industry
     standard for HOA ballots). The actual ballot voting area on page 3
     keeps its 11pt+ sizing — accessibility matters most where the voter
     is making their selection. */
  @page { size: Letter; margin: 0.6in 0.7in 0.7in 0.7in; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: #1a1a1a;
    line-height: 1.45;
    font-size: 10.5pt;
    margin: 0;
  }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  /* Letterhead */
  .head { text-align: center; padding-bottom: 14px; border-bottom: 2px solid ${BRAND.colors.navy}; margin-bottom: 16px; }
  .head img { max-height: 96px; max-width: 220px; display: block; margin: 0 auto 6px; }
  .head .community { font-size: 17pt; font-weight: 700; color: ${BRAND.colors.navy}; letter-spacing: 0.5px; }
  .head .sub { font-size: 12pt; color: #475569; font-weight: 600; margin-top: 4px; }

  .sec-title {
    text-align: center;
    font-size: 14pt;
    font-weight: 700;
    color: ${BRAND.colors.navy};
    letter-spacing: 0.5px;
    padding-bottom: 8px;
    border-bottom: 1px solid ${BRAND.colors.navy};
    margin: 14px 0 14px;
  }

  p { margin: 0 0 11px; }

  .meeting-block {
    text-align: center;
    margin: 16px 0 18px;
  }
  .meeting-block .when {
    font-size: 14pt;
    font-weight: 700;
    color: ${BRAND.colors.navy};
  }
  .meeting-block .where {
    font-size: 11pt;
    color: #1f2937;
    margin-top: 4px;
  }

  h2.agenda-title {
    text-align: center;
    font-size: 16pt;
    color: ${BRAND.colors.navy};
    font-weight: 700;
    margin: 26px 0 12px;
    letter-spacing: 1px;
  }
  ol.agenda { list-style: none; padding: 0 0 0 28px; margin: 0; }
  ol.agenda li {
    display: grid;
    grid-template-columns: 50px 1fr;
    column-gap: 8px;
    padding: 4px 0;
    font-size: 11.5pt;
  }
  ol.agenda li .num { text-align: right; color: #475569; }
  ol.agenda li .title { color: #1a1a1a; }

  /* Voting instructions */
  h3.method-heading {
    color: ${BRAND.colors.navy};
    font-size: 11.5pt;
    margin: 12px 0 4px;
  }
  h3.method-heading .num { color: ${BRAND.colors.navy}; margin-right: 4px; }
  ul.channel-list { margin: 3px 0 6px 22px; padding: 0; font-size: 10pt; }
  ul.channel-list li { margin: 2px 0; }
  .deadline-line { color: ${BRAND.colors.navy}; margin: 4px 0 6px; }

  .important-notes {
    margin: 14px 0 10px;
    padding: 9px 13px;
    background: #f8fafc;
    border-left: 3px solid ${BRAND.colors.navy};
    border-radius: 0 6px 6px 0;
  }
  .important-notes h4 {
    margin: 0 0 4px;
    color: ${BRAND.colors.navy};
    font-size: 11pt;
  }
  .important-notes p { margin: 0 0 4px; font-size: 10pt; line-height: 1.4; }

  .floor-notice {
    margin: 10px 0;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 10pt;
    line-height: 1.4;
  }
  .floor-notice-strict {
    background: #fef2f2;
    border-left: 3px solid #b91c1c;
    color: #7f1d1d;
  }
  .floor-notice-strict strong { color: #b91c1c; }
  .floor-notice-open {
    background: #f0f9ff;
    border-left: 3px solid #0369a1;
    color: #0c4a6e;
  }

  .tx209-callout {
    margin: 10px 0;
    padding: 9px 12px;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font-size: 9.5pt;
    line-height: 1.4;
  }
  .tx209-callout .hdr { font-weight: 700; color: ${BRAND.colors.navy}; margin-bottom: 3px; font-size: 10pt; }

  /* "Where to find candidate bios" pointer — variants for mailing
     (prominent, bios omitted from packet) vs. website (soft note,
     bios in packet too). */
  .bios-callout {
    margin: 10px 0;
    padding: 9px 12px;
    background: #fefce8;
    border-left: 3px solid #ca8a04;
    border-radius: 0 6px 6px 0;
    font-size: 10pt;
    line-height: 1.4;
  }
  .bios-callout strong { color: #854d0e; }
  .bios-callout-soft {
    margin: 8px 0;
    padding: 6px 10px;
    color: #475569;
    font-size: 9.5pt;
    font-style: italic;
    line-height: 1.35;
  }

  /* Proxy / Absentee Ballot — tightened so the whole ballot fits one page */
  .ballot-intro {
    margin: 10px 0 6px;
    font-size: 10.5pt;
    line-height: 1.4;
  }
  .option-block {
    margin: 8px 0;
    padding: 4px 0;
  }
  .option-block .lbl {
    font-weight: 700;
    color: ${BRAND.colors.navy};
    font-size: 11pt;
    margin-bottom: 2px;
  }
  .option-block .lbl .opt-box { font-family: Consolas, monospace; margin-right: 4px; }
  .option-block .body { margin-left: 4px; font-size: 10pt; line-height: 1.4; }
  .ballot-candidates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 16px;
    row-gap: 4px;
    margin: 6px 0 0 4px;
  }
  .ballot-candidate { font-size: 11pt; padding: 1px 0; }
  .fill-line {
    display: inline-block;
    border-bottom: 1px solid #1a1a1a;
    min-width: 240px;
    height: 14px;
    margin-left: 4px;
    vertical-align: bottom;
  }

  .owner-info {
    margin: 14px 0 8px;
  }
  .owner-info h4 {
    margin: 0 0 6px;
    color: ${BRAND.colors.navy};
    font-size: 11.5pt;
    border-bottom: 1px solid ${BRAND.colors.navy};
    padding-bottom: 3px;
  }
  .owner-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 6px 0;
    font-size: 10.5pt;
  }
  .owner-row label { min-width: 180px; }
  .owner-row .line {
    flex: 1;
    border-bottom: 1px solid #1a1a1a;
    height: 14px;
  }

  .form-must-sign {
    margin-top: 10px;
    padding: 8px 12px;
    background: #fefce8;
    border-left: 3px solid #ca8a04;
    border-radius: 0 6px 6px 0;
    font-size: 10pt;
    line-height: 1.4;
  }
  .form-must-sign .hdr { font-weight: 700; color: #854d0e; }

  /* Candidate statements */
  .cand-intro {
    margin: 14px 0 18px;
    color: #475569;
    font-size: 10.5pt;
    font-style: italic;
  }
  /* 2 candidates per page: each .cand-pair holds up to 2 .cand-rows
     stacked vertically, with a page break after the pair (except last). */
  .cand-pair {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .cand-pair-break { page-break-after: always; }
  .cand-pair-break:last-child { page-break-after: auto; }

  /* Candidate card — sized to reliably fit 2 cards per page even with
     long bios. Photo + name area tighter; bio stays at 10pt to honor the
     compliance floor since this IS the candidate's voter-facing statement. */
  .cand-row {
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid #e2e8f0;
    page-break-inside: avoid;
  }
  .cand-row:last-child { border-bottom: 0; }
  .cand-photo img { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; }
  .cand-photo-empty {
    width: 80px; height: 80px; border-radius: 6px;
    background: #f1f5f9; color: #94A3B8;
    display: flex; align-items: center; justify-content: center;
    text-align: center; font-size: 9pt;
  }
  .cand-name { font-size: 12pt; font-weight: 700; color: ${BRAND.colors.navy}; }
  .cand-name .incumbent { color: #475569; font-weight: 500; font-style: italic; font-size: 9.5pt; }
  .cand-years { font-size: 9.5pt; color: #475569; font-style: italic; margin: 1px 0 5px; }
  .cand-bio { font-size: 10pt; line-height: 1.4; white-space: pre-line; }

  .page-footer {
    margin-top: 28px;
    padding-top: 8px;
    border-top: 1px solid #e2e8f0;
    text-align: center;
    font-size: 9pt;
    color: #475569;
    line-height: 1.5;
  }
</style></head><body>

${opts.layout_mode === 'compact' ? `
<!-- ============================================================ -->
<!-- COMPACT MODE — Notice + Proxy + Ballot all on ONE page.       -->
<!-- Matches Waterview Estates 2025 packet convention. The §209    -->
<!-- disclosure prints inline in the Assignment-of-Proxy paragraph -->
<!-- (no separate callout box). No standalone agenda — the agenda  -->
<!-- is read at the meeting, not mailed. Most postage-efficient.   -->
<!-- ============================================================ -->
<div class="page">
  <div class="head" style="padding-bottom:8px; margin-bottom:12px;">
    ${logo
      ? `<img src="${logo}" alt="${escapeHtml(communityName)}" style="max-height:60px;">`
      : `<div style="font-size:16pt; font-weight:700; color:${BRAND.colors.navy};">${escapeHtml(communityName)}</div>`}
    <div class="community" style="font-size:13pt;">${escapeHtml(communityName)} Owners' Association</div>
    <div class="sub" style="font-size:11.5pt;">${escapeHtml(opts.voting_year)} Annual Meeting Notice / Proxy / Absentee Ballot</div>
  </div>

  <p>The ${escapeHtml(opts.voting_year)} Annual Meeting of the Members of the ${escapeHtml(associationLegalName)} will be held on <strong>${escapeHtml(fmtDate(meetingDate))}${meetingTime ? `, at ${escapeHtml(fmtTime12h(meetingTime))}` : ''}</strong>${meetingLocation ? ` at the ${escapeHtml(meetingLocation)}` : ''}. The purpose of the meeting will be to elect ${seatsPhrase} ${directorWord}${opts.term_years ? ` to ${escapeHtml(String(opts.term_years))}-year term${seatsOpen === 1 ? '' : 's'}` : ''} and to discuss the affairs of the Association.${opts.registration_time ? ` Registration commences at ${escapeHtml(opts.registration_time)}.` : ''} Nominations will also be taken from the floor on the night of the meeting.</p>

  <p>A quorum must be present to transact the business of the Association. If you will not be able to attend, please fill in the proxy/absentee ballot below and return by the deadline using any of the methods listed in the Voting Instructions enclosed. You may also vote in person by attending the meeting.</p>

  <h3 style="font-size:12pt; font-weight:700; color:${BRAND.colors.navy}; margin:14px 0 6px;">ASSIGNMENT OF PROXY</h3>
  <p>I, the undersigned, a member of the ${escapeHtml(associationLegalName)}, do hereby appoint the Secretary, (unless otherwise named in this space) <span class="fill-line"></span> as my true and lawful proxy, to vote my directed ballot, if so indicated below, in my place and stead on my behalf, as though I myself were present, with power of substitution, at the Annual Meeting of the above named Association on ${escapeHtml(fmtDate(meetingDate))}${meetingTime ? `, at ${escapeHtml(fmtTime12h(meetingTime))}` : ''}, and/or any rescheduled meeting which may be required. By casting your vote via absentee ballot, you will <u>forego</u> the opportunity to consider and vote on any action from the floor on these proposals, if a meeting is held. This means that if there are amendments to these proposals, your votes will not be counted on the final vote on these measures. If you desire to retain the ability, please attend the meeting in person. You may submit an absentee ballot and later choose to attend any meeting in person, in which case any in-person vote will prevail. This proxy will continue in effect until a quorum of members, in person or by proxy, is achieved, or until revoked by the undersigned in writing and delivered to the Board of the Association c/o ${BRAND.service.name}, ${BRAND.service.addressInline}.</p>

  <p style="font-weight:700; margin-top:10px;">There ${seatsOpen === 1 ? 'is currently' : 'are currently'} ${seatsPhrase} open ${seatsOpen === 1 ? 'position' : 'positions'}. To cast a directed ballot, check the box for Option 3 below and then check the box next to the candidate(s) of your choice.</p>

  <p style="font-weight:700; margin-top:12px;">Use this proxy as indicated in one of the boxes below (please check <u>one</u> box only):</p>

  <div class="option-block">
    <div class="lbl"><span class="opt-box">[&nbsp;&nbsp;]</span> Option 1 &mdash; ${escapeHtml(opts.quorum_only_label)}</div>
    <div class="body">This proxy may be used for quorum purposes only. The Secretary of the Association will not cast my vote.</div>
  </div>

  <div class="option-block">
    <div class="lbl"><span class="opt-box">[&nbsp;&nbsp;]</span> Option 2 &mdash; Assign Proxy</div>
    <div class="body">My Designated Proxy named above is authorized to vote on my behalf as he/she best determines.</div>
  </div>

  <div class="option-block">
    <div class="lbl"><span class="opt-box">[&nbsp;&nbsp;]</span> Option 3 &mdash; Directed Ballot (Absentee Vote)</div>
    <div class="body">
      Vote for ${seatsPhrase} ${seatsOpen === 1 ? 'candidate' : 'candidates'} by checking the box next to the candidate's name:
      <div class="ballot-candidates">${directedHtml}</div>
      ${writeInHtml}
    </div>
  </div>

  <p style="font-size:10pt; color:#475569; font-style:italic; margin-top:8px;">Note: If none of the above options is checked, your proxy will be used to establish quorum only.</p>

  <div class="owner-info" style="margin-top:14px;">
    <div class="owner-row"><label>Property Address:</label><span class="line"></span><label style="margin-left:14px;">Date:</label><span class="line" style="max-width:140px;"></span></div>
    <div class="owner-row"><label>Owner(s) Signature(s):</label><span class="line"></span><span class="line"></span></div>
  </div>

</div>
` : `
<!-- ============================================================ -->
<!-- DETAILED MODE — Page 1: Annual Meeting Notice + Agenda        -->
<!-- ============================================================ -->
<div class="page">
  <div class="head">
    ${logo
      ? `<img src="${logo}" alt="${escapeHtml(communityName)}">`
      : `<div style="font-size:20pt; font-weight:700; color:${BRAND.colors.navy};">${escapeHtml(communityName)}</div>`}
    <div class="community">${escapeHtml(upperName)}</div>
    <div class="sub">${escapeHtml(opts.voting_year)} Annual Meeting Notice</div>
  </div>

  <p>Dear Homeowner,</p>
  <p>The ${escapeHtml(opts.voting_year)} Annual Meeting of the Members of the ${escapeHtml(associationLegalName)} will be held as follows:</p>

  <div class="meeting-block">
    <div class="when">${escapeHtml(fmtDate(meetingDate))}${meetingTime ? ` &mdash; ${escapeHtml(fmtTime12h(meetingTime))}` : ''}</div>
    ${meetingLocation ? `<div class="where">${escapeHtml(meetingLocation)}</div>` : ''}
  </div>

  <p>Your attendance and participation are requested as we discuss topics that affect you and your community. At this meeting, we will review the events of the past year and the Board's plans for the coming year. The Agenda is as follows:</p>

  <h2 class="agenda-title">AGENDA</h2>
  <ol class="agenda">
    ${agendaItems.map((it, i) => `<li><span class="num">${toRoman(i + 1)}.</span> <span class="title">${escapeHtml(typeof it === 'string' ? it : (it.title || ''))}</span></li>`).join('')}
  </ol>

</div>
`}

${opts.layout_mode !== 'compact' ? `
<!-- ============================================================ -->
<!-- DETAILED MODE — Page 2: Voting Instructions                   -->
<!-- ============================================================ -->
<div class="page">
  <div style="text-align:center; padding-bottom:6px; font-size:10pt; color:#475569; letter-spacing:1px;">${escapeHtml(upperName)}</div>
  <div class="sec-title">Voting Instructions</div>

  <p>You may participate in this election using any one of the following ${methodNum >= 2 ? numberToWords(methodNum) : ''} methods. All methods are weighted equally — one (1) vote per lot.</p>

  ${methodSections.join('')}

  <div class="important-notes">
    <h4>Important Notes on Voting</h4>
    <p><strong>One vote per lot.</strong> ${escapeHtml(opts.vote_override_rule)}</p>
    <p><strong>Quorum-only proxies.</strong> If you cannot vote and do not wish to assign your vote to a specific person, you may submit the ballot below marked "${escapeHtml(opts.quorum_only_label)}" so your presence counts toward establishing a quorum.</p>
  </div>

  ${biosLocationHtml}
  ${floorNoticeHtml}
  ${tx209Callout}

</div>

<!-- ============================================================ -->
<!-- DETAILED MODE — Page 3: Proxy / Absentee Ballot               -->
<!-- ============================================================ -->
<div class="page">
  <div style="text-align:center; padding-bottom:6px; font-size:10pt; color:#475569; letter-spacing:1px;">${escapeHtml(upperName)}</div>
  <div class="sec-title">Proxy / Absentee Ballot</div>

  <p class="ballot-intro">I, the undersigned, a Member of the ${escapeHtml(associationLegalName)}, do hereby select <strong>one (1)</strong> of the following options for the ${escapeHtml(opts.voting_year)} Annual Meeting on ${escapeHtml(fmtDateShort(meetingDate))}. Owners are entitled to one (1) vote per lot.${txEmbedded}</p>

  <p style="text-align:center; font-weight:700; color:#475569;">— Select only one of the three options below —</p>

  <div class="option-block">
    <div class="lbl"><span class="opt-box">[&nbsp;&nbsp;]</span> Option 1 &mdash; ${escapeHtml(opts.quorum_only_label)}</div>
    <div class="body">This proxy may be used for quorum purposes only. The Secretary of the Association will not cast my vote.</div>
  </div>

  <div class="option-block">
    <div class="lbl"><span class="opt-box">[&nbsp;&nbsp;]</span> Option 2 &mdash; Assign Proxy</div>
    <div class="body">
      I assign this proxy to: <span class="fill-line"></span><br>
      <em style="font-size:10pt; color:#64748b;">(If left blank, the Secretary of the Association is designated.) My designated proxy is authorized to vote on my behalf as he or she best determines.</em>
    </div>
  </div>

  <div class="option-block">
    <div class="lbl"><span class="opt-box">[&nbsp;&nbsp;]</span> Option 3 &mdash; Directed Ballot (Absentee Vote)</div>
    <div class="body">
      Vote for ${seatsPhrase} ${seatsOpen === 1 ? 'candidate' : 'candidates'} by checking the box next to the candidate's name:
      <div class="ballot-candidates">${directedHtml}</div>
      ${writeInHtml}
    </div>
  </div>

  <div class="owner-info">
    <h4>Owner Information</h4>
    <div class="owner-row"><label>Property Address:</label><span class="line"></span></div>
    <div class="owner-row"><label>Owner(s) Printed Name(s):</label><span class="line"></span></div>
    <div class="owner-row"><label>Owner(s) Signature(s):</label><span class="line"></span></div>
    <div class="owner-row"><label>Date:</label><span class="line" style="max-width:200px;"></span></div>
  </div>

  <div class="form-must-sign">
    <span class="hdr">FORM MUST BE SIGNED TO BE VALID.</span><br>
    Please complete, sign, and return by the deadline using the methods on the prior page. This proxy will continue in effect until a quorum of members, in person or by proxy, is achieved at the ${escapeHtml(opts.voting_year)} Annual Meeting, or until revoked by the undersigned in writing and delivered to the Board of the Association c/o ${BRAND.service.name}.
  </div>

</div>
` : ''}

<!-- ============================================================ -->
<!-- PAGES 4+ — Candidate Statements (one .page per pair)         -->
<!-- Rendered only when opts.include_candidate_bios is TRUE.       -->
<!-- The "mailing" version of the Notice omits this section to    -->
<!-- shorten the mailed packet; the website version keeps it.     -->
<!-- ============================================================ -->
${opts.include_candidate_bios ? candidatePairs.map((pair) => `
<div class="page">
  <div class="head" style="padding-bottom:8px; margin-bottom:10px;">
    ${logo
      ? `<img src="${logo}" alt="${escapeHtml(communityName)}" style="max-height:60px;">`
      : `<div style="font-size:15pt; font-weight:700; color:${BRAND.colors.navy};">${escapeHtml(communityName)}</div>`}
    <div class="community" style="font-size:13pt;">${escapeHtml(upperName)}</div>
    <div class="sub" style="font-size:11pt;">${escapeHtml(opts.voting_year)} Annual Meeting &mdash; Candidate Statements</div>
  </div>
  ${pair}
</div>
`).join('') : ''}

</body></html>`;
}

module.exports = {
  renderAnnualMeetingNoticeHTML,
  defaultAgenda,
  DEFAULT_VOTE_OVERRIDE_RULE,
  TX_209_TEXT,
};
