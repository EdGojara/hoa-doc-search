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

// Default agenda — used when the cycle doesn't have a custom one. Pulls
// directly from the Canyon Gate 2026 template which is the Bedrock standard.
function defaultAgenda(seatsOpen, termYears) {
  const seatPhrase = (seatsOpen === 1 ? 'One (1)' : `${seatsOpen} (${seatsOpen})`) + ` Director${seatsOpen === 1 ? '' : 's'}`;
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
async function renderAnnualMeetingNoticeHTML({
  cycle,
  candidates = [],
  voting_methods = {},
  options = {},
}) {
  const communityName = cycle.community_name || 'the Association';
  const associationLegalName = cycle.association_legal_name || `${communityName} Association, Inc.`;
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
    mgmt_address:        options.mgmt_address || '12808 West Airport Blvd, Ste 253, Sugar Land, TX 77478',
    mgmt_phone:          options.mgmt_phone   || '(832) 588-2485',
    mgmt_website:        options.mgmt_website || 'bedrocktx.com',
    voting_year:         options.voting_year || (meetingDate ? new Date(meetingDate).getFullYear() : new Date().getFullYear()),
  };

  const agendaItems = options.agenda && options.agenda.length
    ? options.agenda
    : defaultAgenda(seatsOpen, opts.term_years);

  const logo = getCommunityLogo(communityName);
  const upperName = communityName.toUpperCase();

  const pageFooter = `
    <div class="page-footer">
      ${escapeHtml(associationLegalName)} &nbsp;|&nbsp; c/o Bedrock Association Management, LLC<br>
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
      const addr = methods.mail.return_address || `Bedrock Association Management, ${opts.mgmt_address}`;
      channelsLi.push(`<li><strong>Mail:</strong> ${escapeHtml(addr)}</li>`);
    }
    if (methods.email && methods.email.enabled) {
      channelsLi.push(`<li><strong>Email:</strong> ${escapeHtml(methods.email.address || 'info@bedrocktx.com')}</li>`);
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

  // ---- Proxy/Absentee Ballot section ---------------------------------------
  const directedHtml = candidates.length > 0
    ? candidates.map((c) => `
        <div class="ballot-candidate">
          [ &nbsp; ] &nbsp; ${escapeHtml(c.nominee_name || '')}${c.is_incumbent ? ' <em>(incumbent)</em>' : ''}
        </div>
      `).join('')
    : '<p style="color:#94A3B8; font-style:italic;">(Candidate names will be inserted from the nominations on slate.)</p>';

  const writeInHtml = (options.write_in_allowed !== false)
    ? `<div class="ballot-candidate" style="margin-top:8px;">[ &nbsp; ] &nbsp; Write-in: <span class="fill-line"></span></div>`
    : '';

  const seatsPhrase = seatsOpen === 1 ? 'one (1)' : `${seatsOpen} (${seatsOpen})`;
  const directorWord = seatsOpen === 1 ? 'Director' : 'Directors';

  // Embedded TX 209 inside proxy intro (Waterview style) — present only when
  // the callout style is NOT used.
  const txEmbedded = opts.tx_209_disclosure === 'embedded'
    ? ` <em>${escapeHtml(TX_209_TEXT)}</em>`
    : '';

  // ---- Candidate Statements section ----------------------------------------
  const sortedCandidates = [...candidates].sort((a, b) => {
    const la = (a.nominee_name || '').split(' ').slice(-1)[0].toLowerCase();
    const lb = (b.nominee_name || '').split(' ').slice(-1)[0].toLowerCase();
    return la.localeCompare(lb);
  });

  const candidateBlocks = sortedCandidates.map((c) => {
    // Resolution order: pre-resolved data URI > signed URL > raw path.
    // Callers (API route generating the PDF) should resolve photo_storage_path
    // to either a data URI (preferred, so puppeteer can embed it directly
    // without needing network access during render) or a signed URL.
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
  }).join('');

  // ============================ HTML ========================================
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0.75in 0.85in 0.9in 0.85in; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: #1a1a1a;
    line-height: 1.55;
    font-size: 11pt;
    margin: 0;
  }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  /* Letterhead */
  .head { text-align: center; padding-bottom: 14px; border-bottom: 2px solid #1E2761; margin-bottom: 16px; }
  .head img { max-height: 96px; max-width: 220px; display: block; margin: 0 auto 6px; }
  .head .community { font-size: 17pt; font-weight: 700; color: #1E2761; letter-spacing: 0.5px; }
  .head .sub { font-size: 12pt; color: #475569; font-weight: 600; margin-top: 4px; }

  .sec-title {
    text-align: center;
    font-size: 14pt;
    font-weight: 700;
    color: #1E2761;
    letter-spacing: 0.5px;
    padding-bottom: 8px;
    border-bottom: 1px solid #1E2761;
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
    color: #1E2761;
  }
  .meeting-block .where {
    font-size: 11pt;
    color: #1f2937;
    margin-top: 4px;
  }

  h2.agenda-title {
    text-align: center;
    font-size: 16pt;
    color: #1E2761;
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
    color: #1E2761;
    font-size: 12pt;
    margin: 18px 0 6px;
  }
  h3.method-heading .num { color: #1E2761; margin-right: 4px; }
  ul.channel-list { margin: 4px 0 8px 22px; padding: 0; }
  ul.channel-list li { margin: 3px 0; }
  .deadline-line { color: #1E2761; }

  .important-notes {
    margin: 22px 0 14px;
    padding: 12px 16px;
    background: #f8fafc;
    border-left: 3px solid #1E2761;
    border-radius: 0 6px 6px 0;
  }
  .important-notes h4 {
    margin: 0 0 6px;
    color: #1E2761;
    font-size: 11.5pt;
  }
  .important-notes p { margin: 0 0 6px; font-size: 10.5pt; }

  .floor-notice {
    margin: 14px 0;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 10.5pt;
    line-height: 1.5;
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
    margin: 16px 0;
    padding: 12px 14px;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font-size: 10.5pt;
    line-height: 1.55;
  }
  .tx209-callout .hdr { font-weight: 700; color: #1E2761; margin-bottom: 4px; }

  /* Proxy / Absentee Ballot */
  .ballot-intro {
    margin: 14px 0 8px;
    font-size: 11pt;
  }
  .option-block {
    margin: 12px 0;
    padding: 8px 0;
  }
  .option-block .lbl {
    font-weight: 700;
    color: #1E2761;
    font-size: 11.5pt;
    margin-bottom: 4px;
  }
  .option-block .lbl .opt-box { font-family: Consolas, monospace; margin-right: 4px; }
  .option-block .body { margin-left: 4px; font-size: 10.5pt; }
  .ballot-candidates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 18px;
    row-gap: 6px;
    margin: 8px 0 0 4px;
  }
  .ballot-candidate { font-size: 11pt; padding: 2px 0; }
  .fill-line {
    display: inline-block;
    border-bottom: 1px solid #1a1a1a;
    min-width: 240px;
    height: 14px;
    margin-left: 4px;
    vertical-align: bottom;
  }

  .owner-info {
    margin: 22px 0 12px;
  }
  .owner-info h4 {
    margin: 0 0 8px;
    color: #1E2761;
    font-size: 12pt;
    border-bottom: 1px solid #1E2761;
    padding-bottom: 4px;
  }
  .owner-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 8px 0;
    font-size: 11pt;
  }
  .owner-row label { min-width: 200px; }
  .owner-row .line {
    flex: 1;
    border-bottom: 1px solid #1a1a1a;
    height: 14px;
  }

  .form-must-sign {
    margin-top: 14px;
    padding: 10px 14px;
    background: #fefce8;
    border-left: 3px solid #ca8a04;
    border-radius: 0 6px 6px 0;
    font-size: 10.5pt;
  }
  .form-must-sign .hdr { font-weight: 700; color: #854d0e; }

  /* Candidate statements */
  .cand-intro {
    margin: 14px 0 18px;
    color: #475569;
    font-size: 10.5pt;
    font-style: italic;
  }
  .cand-row {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 14px;
    padding: 12px 0;
    border-bottom: 1px solid #e2e8f0;
    page-break-inside: avoid;
  }
  .cand-row:last-child { border-bottom: 0; }
  .cand-photo img { width: 110px; height: 110px; object-fit: cover; border-radius: 6px; }
  .cand-photo-empty {
    width: 110px; height: 110px; border-radius: 6px;
    background: #f1f5f9; color: #94A3B8;
    display: flex; align-items: center; justify-content: center;
    text-align: center; font-size: 10pt;
  }
  .cand-name { font-size: 13pt; font-weight: 700; color: #1E2761; }
  .cand-name .incumbent { color: #475569; font-weight: 500; font-style: italic; font-size: 10.5pt; }
  .cand-years { font-size: 10.5pt; color: #475569; font-style: italic; margin: 2px 0 8px; }
  .cand-bio { font-size: 10.5pt; line-height: 1.55; white-space: pre-line; }

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

<!-- ============================================================ -->
<!-- PAGE 1 — Annual Meeting Notice                                -->
<!-- ============================================================ -->
<div class="page">
  <div class="head">
    ${logo
      ? `<img src="${logo}" alt="${escapeHtml(communityName)}">`
      : `<div style="font-size:20pt; font-weight:700; color:#1E2761;">${escapeHtml(communityName)}</div>`}
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

  ${pageFooter}
</div>

<!-- ============================================================ -->
<!-- PAGE 2 — Voting Instructions                                  -->
<!-- ============================================================ -->
<div class="page">
  <div style="text-align:center; padding-bottom:6px; font-size:10pt; color:#475569; letter-spacing:1px;">${escapeHtml(upperName)}</div>
  <div class="sec-title">Voting Instructions</div>

  <p>You may participate in this election using any one of the following ${methodNum >= 2 ? methodNum : 'methods'} methods. All methods are weighted equally — one (1) vote per lot.</p>

  ${methodSections.join('')}

  <div class="important-notes">
    <h4>Important Notes on Voting</h4>
    <p><strong>One vote per lot.</strong> ${escapeHtml(opts.vote_override_rule)}</p>
    <p><strong>Quorum-only proxies.</strong> If you cannot vote and do not wish to assign your vote to a specific person, you may submit the ballot below marked "${escapeHtml(opts.quorum_only_label)}" so your presence counts toward establishing a quorum.</p>
  </div>

  ${floorNoticeHtml}
  ${tx209Callout}

  ${pageFooter}
</div>

<!-- ============================================================ -->
<!-- PAGE 3 — Proxy / Absentee Ballot                              -->
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
    Please complete, sign, and return by the deadline using the methods on the prior page. This proxy will continue in effect until a quorum of members, in person or by proxy, is achieved at the ${escapeHtml(opts.voting_year)} Annual Meeting, or until revoked by the undersigned in writing and delivered to the Board of the Association c/o Bedrock Association Management.
  </div>

  ${pageFooter}
</div>

<!-- ============================================================ -->
<!-- PAGE 4+ — Candidate Statements                                -->
<!-- ============================================================ -->
${candidates.length > 0 ? `
<div class="page">
  <div class="head">
    ${logo
      ? `<img src="${logo}" alt="${escapeHtml(communityName)}">`
      : `<div style="font-size:18pt; font-weight:700; color:#1E2761;">${escapeHtml(communityName)}</div>`}
    <div class="community">${escapeHtml(upperName)}</div>
    <div class="sub">${escapeHtml(opts.voting_year)} Annual Meeting &mdash; Candidate Statements</div>
  </div>

  <p class="cand-intro">The following ${candidates.length} ${candidates.length === 1 ? 'candidate has' : 'candidates have'} been nominated for the ${escapeHtml(opts.voting_year)} Annual Meeting election to elect ${seatsPhrase} ${directorWord}. Bios below are presented as submitted by each candidate. Candidates listed in alphabetical order by last name. For complete voting instructions and the ballot, please refer to the enclosed Annual Meeting Notice.</p>

  ${candidateBlocks}

  ${pageFooter}
</div>
` : ''}

</body></html>`;
}

module.exports = {
  renderAnnualMeetingNoticeHTML,
  defaultAgenda,
  DEFAULT_VOTE_OVERRIDE_RULE,
  TX_209_TEXT,
};
