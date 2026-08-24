// ============================================================================
// lib/welcome/render.js — the welcome packet, printed.
// ----------------------------------------------------------------------------
// Stage three of extract → validate → render. This file prints what
// lib/welcome/assemble.js handed it and decides nothing. If a section is null
// it does not appear; there is no default copy, no "contact your manager for
// details" placeholder standing in for a fact we do not have.
//
// One renderer, two outputs — screen and print — from the same bundle, so the
// PDF a homeowner receives cannot drift from the preview the operator approved.
// (Same pattern as newsletters and board packets.)
//
// Voice rules (memory: feedback_no_em_dashes, feedback_bespoke_touch,
// feedback_we_are_the_manager, feedback_no_document_citation_voice): commas not
// em-dashes, the owner by name and the lot by address, we ARE the manager and
// never ask which community they are in. The one place a document reference is
// allowed is the covenant hook under "What gets noticed here", because there
// the whole point is showing the rule rather than asserting it.
// ============================================================================

const BRAND = require('../brand');
const { SECTIONS } = require('./sections');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NAVY = '#0B1D34';
const GOLD = '#D4AF37';
const INK = '#1f2937';
const STONE = '#6B7280';
const LINE = '#e5e7eb';
const WASH = '#F7F5EF';

function longDate(d) {
  if (!d) return '';
  const dt = new Date(String(d) + (String(d).length <= 10 ? 'T00:00:00' : ''));
  return Number.isNaN(dt.getTime()) ? String(d)
    : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function dollars(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// A tile key from portal_module_config, said the way a homeowner would say it.
const TILE_LABEL = {
  balance: 'your account balance',
  arc: 'architectural requests',
  documents: 'community documents',
  contacts: 'local contacts',
  messages: 'messages with our office',
  events: 'community events',
  clubhouse: 'clubhouse reservations',
  key_fob: 'pool key fobs',
  meetings: 'meetings and minutes',
  vendor_directory: 'the vendor directory',
  financials: 'association financials',
  claire: null,   // the AI assistant is not a packet talking point
  map: 'the community map',
};

function joinList(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return a[0] + ' and ' + a[1];
  return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
}

function block(title, inner) {
  if (!inner) return '';
  return `<section class="blk">
    <h2>${esc(title)}</h2>
    ${inner}
  </section>`;
}

function contactRows(items) {
  return items.map((c) => {
    const bits = [
      c.phone ? `<span class="mono">${esc(c.phone)}</span>` : '',
      c.email ? esc(c.email) : '',
      c.url ? esc(String(c.url).replace(/^https?:\/\//, '')) : '',
    ].filter(Boolean).join(' &middot; ');
    return `<tr>
      <td class="cname">${esc(c.name)}</td>
      <td>${bits || '<span class="stone">on file with our office</span>'}${c.notes ? `<div class="stone small">${esc(c.notes)}</div>` : ''}</td>
    </tr>`;
  }).join('');
}

const CATEGORY_HEADING = {
  emergency: 'Emergency',
  utility: 'Utilities',
  trash: 'Trash',
  tv_internet: 'TV and internet',
  community: 'Community',
  other: 'Other',
};

/**
 * Render the packet.
 *
 * @param {object} bundle    from assembleWelcomePacket (must be allowed:true)
 * @param {object} [opts]
 * @param {'print'|'screen'} [opts.mode='print']
 * @returns {string} a complete HTML document
 */
function renderWelcomePacketHTML(bundle, opts = {}) {
  if (!bundle || !bundle.allowed) throw new Error('renderWelcomePacketHTML requires an allowed bundle');
  const mode = opts.mode === 'screen' ? 'screen' : 'print';
  const s = bundle.sections || {};
  const svc = BRAND.service;
  const w = s.welcome || {};
  const firstName = w.owner_name ? String(w.owner_name).trim().split(/\s+/)[0] : '';

  // ---- cover ---------------------------------------------------------------
  const greeting = w.owner_name
    ? `${esc(w.owner_name)},`
    : 'Welcome home,';
  const openingLine = w.effective_date
    ? `Congratulations on ${esc(w.property_address)}. Your closing was ${esc(longDate(w.effective_date))}, and ${esc(w.community_name)} is now your community.`
    : `Congratulations on ${esc(w.property_address)}. ${esc(w.community_name)} is now your community.`;

  const cover = `<section class="cover">
    <div class="lockup">
      <div class="brandname">${esc(svc.name)}</div>
      <div class="tagline">${esc(svc.taglineUpper)}</div>
    </div>
    <div class="covertitle">
      <div class="eyebrow">Welcome to</div>
      <h1>${esc(w.community_name)}</h1>
      <div class="lot">${esc(w.property_address)}${w.city_state_zip ? `<span class="stone">, ${esc(w.city_state_zip)}</span>` : ''}</div>
    </div>
    <div class="coverbody">
      <p class="hello">${greeting}</p>
      <p>${openingLine}</p>
      <p>Your new home comes with a community, and we are here to make that part easy. On behalf of your neighbors, the board, and the Bedrock team, welcome. This packet is your community in one place: your team, your amenities, how to get answers, and the handful of things worth knowing, all specific to ${esc(w.community_name)}.</p>
      ${w.note ? `<p class="note">${esc(w.note)}</p>` : ''}
      <p class="sign">${esc(svc.name)}<br>
        <span class="stone">${esc(svc.phone)} &middot; ${esc(svc.email)}</span></p>
    </div>
  </section>`;

  // ---- your team -----------------------------------------------------------
  // "Welcomed, not processed": the association introduces itself as the people
  // who help before it lists anything it enforces. Always prints; falls back to
  // the office line when no manager is named.
  const m = s.manager || {};
  const managerBlock = block('Your team', `
    <p>We manage ${esc(w.community_name)} for its board, so we are the people to call about your account, the amenities, an architectural request, or anything that does not look right on your street.</p>
    ${m.manager_name ? `<p><strong>${esc(m.manager_name)}</strong> is your ${esc(m.manager_title && !/community manager/i.test(m.manager_title) ? m.manager_title : 'community manager')}.</p>` : ''}
    ${m.onsite_hours ? `<p>${m.onsite ? 'On site' : 'Available'} ${esc(m.onsite_hours)}.</p>` : ''}
    <table class="kv">
      <tr><td class="cname">Call</td><td class="mono">${esc(m.community_phone || svc.phone)}</td></tr>
      <tr><td class="cname">Email</td><td>${esc(m.community_email || svc.email)}</td></tr>
      <tr><td class="cname">Mail</td><td>${esc(svc.addressInline)}</td></tr>
    </table>
    ${m.extra && m.extra.length ? `<table class="kv">${contactRows(m.extra)}</table>` : ''}
  `);

  // ---- claire --------------------------------------------------------------
  // Prints only where Claire is live (assemble.js gates it). Honest-AI rule:
  // she is named as the community assistant, never a specific human.
  const cl = s.claire;
  const claireBlock = cl ? block('Just ask Claire', `
    <p>Meet Claire, your community assistant. Claire can answer questions about ${esc(w.community_name)} whenever you have them, day or night, from your resident portal: assessments, amenities, architectural requests, trash days, the rules, and more.</p>
    <p>No searching through documents, and no figuring out who to email. Ask Claire in plain language and you get an answer specific to your community.</p>
  `) : '';

  // ---- assessments ---------------------------------------------------------
  const a = s.assessments;
  const freqWord = a && a.frequency === 'annual' ? 'once a year'
    : a && a.frequency === 'quarterly' ? 'quarterly'
      : a && a.frequency === 'monthly' ? 'monthly' : (a ? esc(a.frequency) : '');
  const assessBlock = a ? block('Your assessments', `
    <p class="lede">${dollars(a.annual_dollars)} a year, billed ${freqWord}.</p>
    <p>Assessments fund everything the association pays for, the common areas, the insurance, the landscaping, and the reserves that pay for the next roof or the next repave. ${a.fiscal_year_end ? `The association's fiscal year ends ${esc(a.fiscal_year_end)}. ` : ''}Your first statement will show the exact amount and the due date for your lot.</p>
    ${a.online_payments ? '<p>You can pay online from your resident portal, or mail a check to our office.</p>' : '<p>Statements come by mail, and you can mail a check to our office or call us to arrange payment.</p>'}
  `) : '';

  // ---- portal / get started ------------------------------------------------
  const p = s.portal;
  const tileWords = p ? joinList(p.tiles.map((t) => TILE_LABEL[t]).filter(Boolean)) : '';
  const portalBlock = p ? block('Get started online', `
    <p>Your resident portal is where ${tileWords || 'your account and your requests'} live. Setting it up takes about two minutes, and there is no password to remember, we email you a sign-in link.</p>
    <ol class="steps">
      <li><strong>Activate your account.</strong> Open the link we send and confirm it is you.</li>
      <li><strong>Tell us how to reach you.</strong> Email, text, or both.</li>
      <li><strong>Explore your community.</strong> Amenities, events, contacts, and your account are all there.</li>
    </ol>
    ${p.url ? `<p class="lede">${esc(String(p.url).replace(/^https?:\/\//, ''))}</p>` : ''}
  `) : '';

  // ---- arc -----------------------------------------------------------------
  const r = s.arc;
  const arcBlock = r ? block('Before you change anything outside', `
    <p>Paint, fences, roofs, patios, pools, sheds, play structures, and anything else that changes how your home looks from the street needs written approval before the work starts. This is not a formality, it is how the whole neighborhood keeps its value, and approval after the fact is a much harder conversation than approval before.</p>
    <p>${r.submit_via_portal ? 'Submit your request from your resident portal, ' : 'Send your request to our office, '}with a description, a drawing or photo, and the materials and colors you plan to use.${r.fee_label ? ` There is a ${esc(r.fee_label)} review fee.` : ''}</p>
    ${r.guidelines_on_file ? '<p>The architectural guidelines for your community are available from our office, and they are worth reading before you plan the project.</p>' : ''}
  `) : '';

  // ---- compliance ----------------------------------------------------------
  const c = s.compliance;
  const complianceBlock = c ? block('What gets noticed here', `
    <p>Every community enforces its own deed restrictions differently. Rather than hand you a list of rules, here is what owners in ${esc(w.community_name)} were actually written about over the last year. Nothing on this list is a surprise once you know it is on the list.</p>
    <ol class="cites">
      ${c.categories.map((cat) => `<li>
        <div class="citelabel">${esc(cat.label)}</div>
        ${cat.what_it_means ? `<div class="stone small">${esc(cat.what_it_means)}</div>` : ''}
        ${cat.citation_quote ? `<blockquote>${esc(cat.citation_quote)}<div class="src">${esc([cat.citation_reference, cat.citation_title].filter(Boolean).join(' &middot; '))}</div></blockquote>` : ''}
      </li>`).join('')}
    </ol>
    <p class="stone small">If something at your home ever needs attention, you will hear from us in writing first, with time to take care of it. Nobody gets fined by surprise.</p>
  `) : '';

  // ---- trash ---------------------------------------------------------------
  const t = s.trash;
  const trashBlock = t ? block('Trash and recycling', `
    <table class="kv">
      ${t.collection_days.length ? `<tr><td class="cname">Trash</td><td>${esc(joinList(t.collection_days))}</td></tr>` : ''}
      ${t.recycling_days.length ? `<tr><td class="cname">Recycling</td><td>${esc(joinList(t.recycling_days))}</td></tr>` : ''}
      ${t.curbside_deadline ? `<tr><td class="cname">At the curb by</td><td>${esc(t.curbside_deadline)}</td></tr>` : ''}
      ${t.heavy_trash_pattern ? `<tr><td class="cname">Heavy trash</td><td>${esc(t.heavy_trash_pattern)}</td></tr>` : ''}
      ${t.vendor ? `<tr><td class="cname">Provider</td><td>${esc(t.vendor.name)}${t.vendor.phone ? ` &middot; <span class="mono">${esc(t.vendor.phone)}</span>` : ''}</td></tr>` : ''}
    </table>
    ${t.notes ? `<p class="stone small">${esc(t.notes)}</p>` : ''}
    ${t.holidays_no_service ? '<p class="stone small">Holiday weeks shift collection, so watch for the notice.</p>' : ''}
  `) : '';

  // ---- amenities -----------------------------------------------------------
  const am = s.amenities;
  const amenBlock = am ? block('Amenities', `
    <table class="kv">
      ${am.items.map((i) => `<tr>
        <td class="cname">${esc(i.name)}</td>
        <td>${esc(i.hours || '')}${i.rentable ? `${i.hours ? ' &middot; ' : ''}available to reserve` : ''}${i.address ? `<div class="stone small">${esc(i.address)}</div>` : ''}</td>
      </tr>`).join('')}
    </table>
  `) : '';

  // ---- contacts ------------------------------------------------------------
  const ct = s.contacts;
  let contactsBlock = '';
  if (ct) {
    const groups = {};
    for (const item of ct.items) (groups[item.category] = groups[item.category] || []).push(item);
    contactsBlock = block('Numbers worth keeping', Object.keys(groups)
      .sort((x, y) => (CATEGORY_HEADING[x] || x).localeCompare(CATEGORY_HEADING[y] || y))
      .map((cat) => `<h3>${esc(CATEGORY_HEADING[cat] || cat)}</h3><table class="kv">${contactRows(groups[cat])}</table>`)
      .join(''));
  }

  // ---- documents -----------------------------------------------------------
  const d = s.documents;
  const docsBlock = d ? block('Your governing documents', `
    <p>These are the documents that govern ${esc(w.community_name)}. ${d.via_portal ? 'They are in your resident portal, and we can send any of them by email if that is easier.' : 'Ask us for any of them and we will send them, there is no charge and no form to fill out.'}</p>
    <ul class="docs">${d.items.map((i) => `<li>${esc(i.label)}</li>`).join('')}</ul>
  `) : '';

  // Value-first order comes from the section registry, not from a hand-kept
  // array here, so render order and the readiness report cannot drift. The
  // "A few things worth knowing" divider prints at the first `knowing` section,
  // and only if a knowing section actually rendered.
  const BLOCKS = {
    welcome: cover,
    manager: managerBlock,
    claire: claireBlock,
    amenities: amenBlock,
    contacts: contactsBlock,
    portal: portalBlock,
    assessments: assessBlock,
    arc: arcBlock,
    trash: trashBlock,
    compliance: complianceBlock,
    documents: docsBlock,
  };
  const divider = `<section class="divider"><h2>A few things worth knowing</h2>
        <p class="stone">The practical parts of living here, in plain language.</p></section>`;

  const parts = [];
  let dividerShown = false;
  for (const def of SECTIONS) {
    const html = BLOCKS[def.key];
    if (!html) continue;
    if (def.part === 'knowing' && !dividerShown) { parts.push(divider); dividerShown = true; }
    parts.push(html);
  }
  const body = parts.join('');

  const footer = `<footer class="pfoot">
    ${esc(svc.name)} &middot; ${esc(svc.addressInline)} &middot; ${esc(svc.phone)} &middot; ${esc(svc.email)}
  </footer>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to ${esc(w.community_name)}${firstName ? ' — ' + esc(firstName) : ''}</title>
<style>
  @page { size: Letter; margin: 0.6in 0.7in; }
  * { box-sizing: border-box; }
  body { margin:0; color:${INK}; font-family:'Segoe UI',-apple-system,Helvetica,Arial,sans-serif;
         font-size:11.5pt; line-height:1.62; background:${mode === 'screen' ? '#eceae4' : '#fff'}; }
  .sheet { background:#fff; ${mode === 'screen' ? 'max-width:8.5in;margin:24px auto;padding:0.7in;box-shadow:0 2px 18px rgba(0,0,0,.12);' : ''} }
  h1 { font-family:Georgia,'Times New Roman',serif; font-size:30pt; line-height:1.1; margin:0; color:${NAVY}; }
  h2 { font-family:Georgia,'Times New Roman',serif; font-size:15pt; color:${NAVY}; margin:0 0 8px;
       border-bottom:2px solid ${GOLD}; padding-bottom:5px; }
  h3 { font-size:9.5pt; text-transform:uppercase; letter-spacing:.09em; color:${STONE};
       margin:12px 0 3px; font-weight:700; }
  p { margin:0 0 9px; }
  .cover { border-bottom:1px solid ${LINE}; padding-bottom:16px; margin-bottom:20px; }
  .lockup { border-bottom:3px solid ${GOLD}; padding-bottom:10px; margin-bottom:22px; }
  .brandname { font-family:Georgia,serif; font-size:15pt; font-weight:700; color:${NAVY}; letter-spacing:.3px; }
  .tagline { font-size:8pt; letter-spacing:.18em; color:${GOLD}; font-weight:700; margin-top:2px; }
  .eyebrow { font-size:9pt; letter-spacing:.16em; text-transform:uppercase; color:${STONE}; margin-bottom:3px; }
  .lot { font-size:12pt; margin-top:6px; font-weight:600; }
  .coverbody { margin-top:18px; }
  .hello { font-size:12.5pt; font-weight:600; margin-bottom:10px; }
  .note { background:${WASH}; border-left:3px solid ${GOLD}; padding:10px 14px; margin:12px 0; }
  .sign { margin-top:14px; font-weight:600; }
  .blk { margin:0 0 20px; page-break-inside:avoid; }
  .divider { margin:26px 0 18px; page-break-before:auto; }
  .divider h2 { border-bottom:none; margin-bottom:2px; }
  .divider p { margin:0; }
  ol.steps { margin:8px 0 10px; padding-left:20px; }
  ol.steps li { margin-bottom:5px; }
  .lede { font-size:13pt; font-weight:700; color:${NAVY}; margin-bottom:6px; }
  table.kv { width:100%; border-collapse:collapse; margin:6px 0 4px; }
  table.kv td { padding:5px 0; border-bottom:1px solid #f1f0ec; vertical-align:top; }
  td.cname { width:34%; font-weight:600; padding-right:12px; }
  .mono { font-variant-numeric:tabular-nums; }
  .stone { color:${STONE}; }
  .small { font-size:9.5pt; line-height:1.45; }
  ol.cites { margin:8px 0 10px; padding-left:20px; }
  ol.cites li { margin-bottom:10px; page-break-inside:avoid; }
  .citelabel { font-weight:700; color:${NAVY}; }
  blockquote { margin:6px 0 0; padding:8px 12px; background:${WASH}; border-left:3px solid ${GOLD};
               font-size:10pt; line-height:1.5; }
  blockquote .src { margin-top:5px; font-size:8.5pt; color:${STONE}; letter-spacing:.02em; }
  ul.docs { margin:6px 0 0; padding-left:20px; }
  ul.docs li { margin-bottom:3px; }
  .pfoot { margin-top:26px; padding-top:10px; border-top:1px solid ${LINE};
           font-size:8.5pt; color:${STONE}; text-align:center; }
</style></head><body><div class="sheet">${body}${footer}</div></body></html>`;
}

// ============================================================================
// The one-page cover letter — the doorway, not the house.
// ----------------------------------------------------------------------------
// Ed 2026-08-24: a world-class welcome is a minimal, beautiful page that drives
// to the experience, with the reference packet available but not shoved at the
// owner. This is that page: heavy white space, the community name, a QR to
// "start here", three steps, "just ask Claire", sign-off. Almost nothing
// bureaucratic. The rich packet is a separate artifact.
//
// The QR is a START url (portal sign-in), NOT a live authenticated link on
// paper — anyone who sees the envelope would otherwise be signed in. The owner
// taps, enters their email, and gets a magic link, which honours the
// require-a-click rule. (feedback_no_auto_consume_magic_links.)
//
// @param {object} bundle    from assembleWelcomePacket (allowed:true)
// @param {object} opts
// @param {string} [opts.qrDataUrl]  data: URI PNG of the start URL (from the API)
// @param {string} [opts.startUrl]   the human-readable start URL, printed under the QR
// @param {'print'|'screen'} [opts.mode='print']
// ============================================================================
function renderWelcomeLetterHTML(bundle, opts = {}) {
  if (!bundle || !bundle.allowed) throw new Error('renderWelcomeLetterHTML requires an allowed bundle');
  const mode = opts.mode === 'screen' ? 'screen' : 'print';
  const s = bundle.sections || {};
  const svc = BRAND.service;
  const w = s.welcome || {};
  const firstName = w.owner_name ? String(w.owner_name).trim().split(/\s+/)[0] : '';
  const greeting = firstName ? `Hi ${esc(firstName)},` : 'Welcome home,';
  const claireLive = !!s.claire;
  const startLabel = opts.startUrl ? esc(String(opts.startUrl).replace(/^https?:\/\//, '')) : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to ${esc(w.community_name)}${firstName ? ' — ' + esc(firstName) : ''}</title>
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body { margin:0; color:${INK}; font-family:'Segoe UI',-apple-system,Helvetica,Arial,sans-serif;
         line-height:1.6; background:${mode === 'screen' ? '#eceae4' : '#fff'}; }
  .page { background:#fff; width:8.5in; min-height:11in; margin:${mode === 'screen' ? '24px auto' : '0'};
          padding:1in 1in 0.9in; ${mode === 'screen' ? 'box-shadow:0 2px 18px rgba(0,0,0,.12);' : ''}
          display:flex; flex-direction:column; }
  .top { border-bottom:3px solid ${GOLD}; padding-bottom:12px; }
  .brandname { font-family:Georgia,serif; font-size:15pt; font-weight:700; color:${NAVY}; }
  .tagline { font-size:8pt; letter-spacing:.18em; color:${GOLD}; font-weight:700; margin-top:3px; text-transform:uppercase; }
  h1 { font-family:Georgia,'Times New Roman',serif; font-size:34pt; line-height:1.08; color:${NAVY}; margin:0.6in 0 6px; }
  .eyebrow { font-size:10pt; letter-spacing:.16em; text-transform:uppercase; color:${STONE}; }
  .promise { font-size:14pt; color:${NAVY}; font-weight:600; margin:0 0 0.35in; }
  .body p { font-size:12pt; margin:0 0 11px; max-width:5.6in; }
  .start { display:flex; gap:26px; align-items:center; margin:0.3in 0; padding:20px 22px;
           background:${WASH}; border-radius:12px; }
  .start .qr { width:1.5in; height:1.5in; flex:none; background:#fff; border-radius:8px; padding:8px; }
  .start .qr img { width:100%; height:100%; display:block; }
  .start .startcopy h2 { font-family:Georgia,serif; font-size:16pt; color:${NAVY}; border:none; margin:0 0 4px; }
  .start .startcopy p { font-size:11pt; margin:0 0 4px; }
  .start .startcopy .url { font-weight:700; color:${NAVY}; }
  .steps { display:flex; gap:18px; margin:0.15in 0 0.3in; }
  .step { flex:1; }
  .step .n { width:24px; height:24px; border-radius:50%; background:${NAVY}; color:#fff;
             font-weight:700; font-size:11pt; text-align:center; line-height:24px; margin-bottom:6px; }
  .step h3 { font-size:11pt; color:${NAVY}; text-transform:none; letter-spacing:0; margin:0 0 2px; font-weight:700; }
  .step p { font-size:10pt; color:${STONE}; margin:0; line-height:1.45; }
  .claire { border-left:3px solid ${GOLD}; padding:2px 0 2px 16px; margin:0.2in 0; }
  .claire b { color:${NAVY}; }
  .sign { margin-top:auto; padding-top:0.3in; }
  .sign .k { font-weight:700; color:${NAVY}; }
  .stone { color:${STONE}; }
  .foot { margin-top:16px; padding-top:10px; border-top:1px solid ${LINE}; font-size:8.5pt; color:${STONE}; }
</style></head><body><div class="page">
  <div class="top">
    <div class="brandname">${esc(svc.name)}</div>
    <div class="tagline">${esc(svc.taglineUpper)}</div>
  </div>

  <div class="eyebrow" style="margin-top:0.5in;">Welcome to</div>
  <h1>${esc(w.community_name)}</h1>
  <p class="promise">Your new home comes with a community. We are here to make both easier.</p>

  <div class="body">
    <p>${greeting}</p>
    <p>On behalf of your neighbors, the board, and the Bedrock team, welcome to ${esc(w.community_name)}. Moving comes with a thousand things to do, so we have made getting started with your association simple.</p>
  </div>

  <div class="start">
    ${opts.qrDataUrl ? `<div class="qr"><img src="${opts.qrDataUrl}" alt="Scan to get started"></div>` : ''}
    <div class="startcopy">
      <h2>Start here</h2>
      <p>Scan the code to set up your resident portal: your account and payments, architectural requests, amenities, documents, and events, all in one place.</p>
      ${startLabel ? `<p class="url">${startLabel}</p>` : ''}
    </div>
  </div>

  <div class="steps">
    <div class="step"><div class="n">1</div><h3>Activate your account</h3><p>About two minutes. No password to remember.</p></div>
    <div class="step"><div class="n">2</div><h3>Choose how we reach you</h3><p>Email, text, or both.</p></div>
    <div class="step"><div class="n">3</div><h3>Explore your community</h3><p>Amenities, events, and contacts are waiting.</p></div>
  </div>

  ${claireLive ? `<div class="claire">
    <p style="font-size:12pt; margin:0;"><b>Have a question? Just ask Claire.</b> Claire is your community assistant, available whenever you need her from your portal. No searching through documents, no figuring out who to email.</p>
  </div>` : ''}

  <div class="sign">
    <p style="margin:0 0 4px;">We manage communities a little differently. Our goal is simple: fast answers, clear information, and an easy way to handle anything involving your association. Welcome home.</p>
    <p style="margin:10px 0 0;"><span class="k">${esc(svc.name)}</span><br>
      <span class="stone">${esc(svc.taglineUpper)} &middot; ${esc(svc.phone)} &middot; ${esc(svc.email)}</span></p>
    <div class="foot">${esc(svc.addressInline)}</div>
  </div>
</div></body></html>`;
}

module.exports = { renderWelcomePacketHTML, renderWelcomeLetterHTML };
