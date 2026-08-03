// ============================================================================
// lib/newsletters/render.js  (Ed 2026-08-03)
// ----------------------------------------------------------------------------
// ONE renderer, two outputs: the web newsletter and the print/PDF page. Both
// come from the same issue + sections so they can't drift. The PDF route points
// puppeteer at the print HTML (mode:'print') — same pattern as board packets.
//
// No paid design tool: "professional-looking" is HTML + CSS rendered by Chrome.
// ============================================================================

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Tiny, safe markdown → HTML (bold, italic, links, bullet lists, paragraphs).
// Deliberately small — we control the input (AI prose + staff edits).
function mdToHtml(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r/g, '').split('\n');
  let html = '', inList = false;
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => `<a href="${esc(url)}">${esc(txt)}</a>`);
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (line) html += `<p>${inline(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

const NAVY = '#0B1D34', GOLD = '#C6A15B', INK = '#20303f', MUTED = '#5f7488', LINE = '#e5e9ef', PAPER = '#ffffff';

function reviewFlag(section) {
  const b = section.body_json || {};
  const text = JSON.stringify(b);
  return section.needs_review || /\[STAFF REVIEW REQUIRED\]/.test(text);
}

// ---- Section renderers -----------------------------------------------------

function renderCover(s) {
  const b = s.body_json || {};
  const img = s.image_url;
  return `
  <section class="nl-cover${img ? ' has-img' : ''}"${img ? ` style="background-image:linear-gradient(180deg, rgba(11,29,52,.15), rgba(11,29,52,.78)), url('${esc(img)}');"` : ''}>
    <div class="nl-cover-inner">
      <div class="nl-cover-kicker">${esc(b.month || s.subtitle || '')}</div>
      <h1 class="nl-cover-title">${esc(s.title || 'Community Newsletter')}</h1>
      ${b.tagline ? `<p class="nl-cover-tag">${esc(b.tagline)}</p>` : ''}
    </div>
  </section>`;
}

function renderProse(s) {
  const b = s.body_json || {};
  return `
  <section class="nl-section nl-prose">
    <h2 class="nl-h2">${esc(s.title || '')}</h2>
    ${s.subtitle ? `<div class="nl-sub">${esc(s.subtitle)}</div>` : ''}
    ${s.image_url ? `<img class="nl-img" src="${esc(s.image_url)}" alt="">` : ''}
    <div class="nl-body">${mdToHtml(b.markdown || b.body || '')}</div>
  </section>`;
}

// Feature / spotlight: image beside the story (local business, resident, home,
// "in the news", featured event). Falls back to a stacked layout with no image.
function renderFeature(s) {
  const b = s.body_json || {};
  const kick = { resident_spotlight: 'Resident Spotlight', vendor_spotlight: 'Local Business', advertisement: 'Sponsor', event_feature: 'Featured Event', in_the_news: 'In the News' }[s.section_type] || '';
  const cta = (b.cta_label && b.cta_url) ? `<a class="nl-feat-cta" href="${esc(b.cta_url)}">${esc(b.cta_label)}</a>` : '';
  const img = s.image_url ? `<div class="nl-feat-img" style="background-image:url('${esc(s.image_url)}');"></div>` : '';
  return `
  <section class="nl-section">
    <div class="nl-feature${img ? '' : ' no-img'}">
      ${img}
      <div class="nl-feat-body">
        ${kick ? `<div class="nl-feat-kick">${esc(kick)}</div>` : ''}
        <h2 class="nl-h2">${esc(s.title || '')}</h2>
        ${s.subtitle ? `<div class="nl-sub">${esc(s.subtitle)}</div>` : ''}
        <div class="nl-body">${mdToHtml(b.markdown || b.body || '')}</div>
        ${cta}
      </div>
    </div>
  </section>`;
}

function renderEventGrid(s) {
  const b = s.body_json || {};
  const events = Array.isArray(b.events) ? b.events : [];
  const cards = events.map((e) => `
    <article class="nl-event">
      <div class="nl-event-date">${esc(e.date_label || e.date || '')}${e.time ? ` · ${esc(e.time)}` : ''}</div>
      <h3 class="nl-event-title">${esc(e.title || 'Event')}</h3>
      ${e.location ? `<div class="nl-event-loc">📍 ${esc(e.location)}</div>` : ''}
      ${e.description ? `<p class="nl-event-desc">${esc(e.description)}</p>` : ''}
    </article>`).join('');
  return `
  <section class="nl-section">
    <h2 class="nl-h2">${esc(s.title || 'Events')}</h2>
    <div class="nl-events">${cards || '<p class="nl-empty">No events listed.</p>'}</div>
  </section>`;
}

function renderCalendarList(s) {
  const b = s.body_json || {};
  const events = Array.isArray(b.events) ? b.events : [];
  const rows = events.map((e) => `
    <li class="nl-cal-row"><span class="nl-cal-date">${esc(e.date_label || e.date || '')}</span><span class="nl-cal-title">${esc(e.title || '')}${e.time ? ` · ${esc(e.time)}` : ''}</span></li>`).join('');
  return `
  <section class="nl-section">
    <h2 class="nl-h2">${esc(s.title || 'Looking Ahead')}</h2>
    <ul class="nl-cal">${rows || '<p class="nl-empty">Nothing scheduled yet.</p>'}</ul>
  </section>`;
}

function renderContacts(s) {
  const b = s.body_json || {};
  const groups = Array.isArray(b.groups) ? b.groups : [];
  const cols = groups.map((g) => `
    <div class="nl-contact-group">
      <h3 class="nl-contact-h">${esc(g.name || '')}</h3>
      <ul>${(g.items || g.contacts || []).map((it) => `
        <li><span class="nl-contact-label">${esc(it.label || it.name || '')}</span>${it.phone ? `<span class="nl-contact-v">${esc(it.phone)}</span>` : ''}${it.email ? `<span class="nl-contact-v">${esc(it.email)}</span>` : ''}${it.url ? `<span class="nl-contact-v"><a href="${esc(it.url)}">${esc(it.url)}</a></span>` : ''}</li>`).join('')}</ul>
    </div>`).join('');
  return `
  <section class="nl-section">
    <h2 class="nl-h2">${esc(s.title || 'Contacts')}</h2>
    <div class="nl-contacts">${cols}</div>
  </section>`;
}

function renderLinks(s) {
  const b = s.body_json || {};
  const links = Array.isArray(b.links) ? b.links : [];
  const items = links.map((l) => `<a class="nl-link" href="${esc(l.url || '#')}">${esc(l.label || l.url || 'Link')}</a>`).join('');
  return `
  <section class="nl-section nl-links-sec">
    <h2 class="nl-h2">${esc(s.title || 'Stay Connected')}</h2>
    <div class="nl-links">${items}</div>
    ${b.note ? `<p class="nl-links-note">${esc(b.note)}</p>` : ''}
  </section>`;
}

function renderGeneric(s) {
  const b = s.body_json || {};
  if (b.markdown || b.body) return renderProse(s);
  return `
  <section class="nl-section">
    <h2 class="nl-h2">${esc(s.title || 'Section')}</h2>
    ${s.image_url ? `<img class="nl-img" src="${esc(s.image_url)}" alt="">` : ''}
    ${s.subtitle ? `<p class="nl-sub">${esc(s.subtitle)}</p>` : ''}
  </section>`;
}

function renderSection(s, mode) {
  const flag = (mode !== 'print' && reviewFlag(s))
    ? '<div class="nl-review">Needs review before publishing</div>' : '';
  let html;
  switch (s.section_type) {
    case 'cover': return renderCover(s); // cover has no review flag chrome
    case 'board_message':
    case 'hoa_corner':
    case 'custom_article':
    case 'project_update':
    case 'amenity_update': html = renderProse(s); break;
    case 'resident_spotlight':
    case 'vendor_spotlight':
    case 'advertisement':
    case 'in_the_news':
    case 'event_feature': html = renderFeature(s); break;
    case 'event_grid': html = renderEventGrid(s); break;
    case 'calendar': html = renderCalendarList(s); break;
    case 'community_contacts':
    case 'emergency_contacts': html = renderContacts(s); break;
    case 'important_links': html = renderLinks(s); break;
    default: html = renderGeneric(s); break;
  }
  return flag + html;
}

// ---- Page shell ------------------------------------------------------------

function styles(mode) {
  const print = mode === 'print';
  return `
  *{box-sizing:border-box;}
  body{margin:0;font-family:Georgia,'Times New Roman',serif;color:${INK};background:${print ? PAPER : '#eef1f5'};-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .nl-doc{max-width:${print ? '8.5in' : '820px'};margin:0 auto;background:${PAPER};${print ? '' : 'box-shadow:0 10px 40px rgba(11,29,52,.12);margin-top:24px;margin-bottom:48px;border-radius:10px;overflow:hidden;'}}
  .nl-sans{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;}
  .nl-cover{position:relative;background:${NAVY};color:#fff;padding:64px 48px;background-size:cover;background-position:center;}
  .nl-cover.has-img{min-height:340px;display:flex;align-items:flex-end;}
  .nl-cover-inner{position:relative;}
  .nl-cover-kicker{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:.22em;text-transform:uppercase;font-size:12px;color:${GOLD};font-weight:700;margin-bottom:10px;}
  .nl-cover-title{font-size:44px;line-height:1.05;margin:0;font-weight:700;letter-spacing:-.01em;}
  .nl-cover-tag{font-size:17px;margin:14px 0 0;color:#eaf0f7;max-width:34em;}
  .nl-section{padding:26px 48px;border-bottom:1px solid ${LINE};}
  .nl-section:last-child{border-bottom:none;}
  .nl-h2{font-size:24px;color:${NAVY};margin:0 0 14px;font-weight:700;position:relative;padding-bottom:8px;}
  .nl-h2:after{content:'';position:absolute;left:0;bottom:0;width:46px;height:3px;background:${GOLD};border-radius:2px;}
  .nl-sub{color:${MUTED};font-size:14px;margin:-6px 0 12px;}
  .nl-body{font-size:16px;line-height:1.66;}
  .nl-body p{margin:0 0 12px;} .nl-body ul{margin:0 0 12px 18px;} .nl-body a{color:${NAVY};}
  .nl-events{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}
  .nl-event{border:1px solid ${LINE};border-radius:10px;padding:14px 16px;background:#fbfcfe;break-inside:avoid;}
  .nl-event-date{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${GOLD};}
  .nl-event-title{font-size:18px;color:${NAVY};margin:6px 0 4px;}
  .nl-event-loc{font-size:13px;color:${MUTED};} .nl-event-desc{font-size:14px;line-height:1.5;margin:8px 0 0;}
  .nl-cal{list-style:none;margin:0;padding:0;}
  .nl-cal-row{display:flex;gap:14px;padding:8px 0;border-bottom:1px dashed ${LINE};}
  .nl-cal-date{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-weight:700;color:${NAVY};min-width:180px;font-size:14px;}
  .nl-cal-title{font-size:15px;}
  .nl-contacts{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;}
  .nl-contact-group h3{font-size:15px;color:${NAVY};margin:0 0 6px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;}
  .nl-contact-group ul{list-style:none;margin:0;padding:0;font-size:14px;}
  .nl-contact-group li{padding:4px 0;border-bottom:1px solid ${LINE};display:flex;flex-wrap:wrap;gap:4px 12px;}
  .nl-contact-label{font-weight:600;} .nl-contact-v{color:${MUTED};}
  .nl-links{display:flex;flex-wrap:wrap;gap:10px;}
  .nl-link{display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;font-weight:600;}
  .nl-links-note{color:${MUTED};font-size:14px;margin:12px 0 0;}
  .nl-img{max-width:100%;border-radius:10px;margin:8px 0;display:block;}
  .nl-feature{display:flex;gap:22px;align-items:flex-start;}
  .nl-feature.no-img{display:block;}
  .nl-feat-img{flex:0 0 40%;min-height:210px;background-size:cover;background-position:center;border-radius:12px;}
  .nl-feat-body{flex:1;}
  .nl-feat-kick{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:11.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${GOLD};margin-bottom:4px;}
  .nl-feat-cta{display:inline-block;margin-top:10px;background:${NAVY};color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;font-weight:700;}
  @media(max-width:640px){ .nl-feature{flex-direction:column;} .nl-feat-img{width:100%;flex-basis:auto;height:200px;} }
  .nl-empty{color:${MUTED};font-style:italic;}
  .nl-review{background:#fef3c7;color:#92400e;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:11px;font-weight:700;padding:3px 10px;border-radius:0;text-transform:uppercase;letter-spacing:.04em;}
  .nl-foot{background:${NAVY};color:#cdd8e6;text-align:center;padding:20px 48px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12.5px;}
  .nl-foot strong{color:#fff;}
  @media(max-width:640px){ .nl-events,.nl-contacts{grid-template-columns:1fr;} .nl-cover{padding:44px 24px;} .nl-cover-title{font-size:32px;} .nl-section{padding:22px 24px;} .nl-cal-date{min-width:120px;} }
  ${print ? `
  @page{size:Letter;margin:0.5in;}
  .nl-doc{box-shadow:none;max-width:none;}
  .nl-section,.nl-event{break-inside:avoid;}
  .nl-cover{break-after:avoid;}
  a{color:${NAVY};text-decoration:none;}
  ` : ''}
  `;
}

// ---- Flyer (single-page event poster) --------------------------------------

const FLYER_THEMES = {
  summer:  { bg: 'linear-gradient(160deg,#0ea5e9 0%,#0369a1 60%,#0b3a63 100%)', accent: '#fde68a', fg: '#ffffff', chip: 'rgba(255,255,255,.16)' },
  festive: { bg: 'linear-gradient(160deg,#f97316 0%,#db2777 100%)',            accent: '#fde68a', fg: '#ffffff', chip: 'rgba(255,255,255,.18)' },
  autumn:  { bg: 'linear-gradient(160deg,#b45309 0%,#7c2d12 100%)',            accent: '#fed7aa', fg: '#fff7ed', chip: 'rgba(255,255,255,.14)' },
  spring:  { bg: 'linear-gradient(160deg,#22c55e 0%,#15803d 100%)',            accent: '#fef08a', fg: '#ffffff', chip: 'rgba(255,255,255,.16)' },
  holiday: { bg: 'linear-gradient(160deg,#b91c1c 0%,#14532d 100%)',           accent: '#fde68a', fg: '#ffffff', chip: 'rgba(255,255,255,.16)' },
  formal:  { bg: 'linear-gradient(160deg,#0B1D34 0%,#132f52 100%)',           accent: '#C6A15B', fg: '#ffffff', chip: 'rgba(255,255,255,.12)' },
};

function renderFlyerHTML({ issue, sections, community }, opts = {}) {
  const mode = opts.mode === 'print' ? 'print' : 'web';
  const s = (sections || []).find((x) => x.section_type === 'flyer') || (sections || [])[0] || { body_json: {} };
  const b = s.body_json || {};
  const th = FLYER_THEMES[b.theme] || FLYER_THEMES.summer;
  const commName = (community && community.name) || '';
  const headline = b.headline || issue.title || 'Community Event';
  const details = [];
  if (b.event_date) details.push({ icon: '📅', text: b.event_date });
  if (b.event_time) details.push({ icon: '🕒', text: b.event_time });
  if (b.location_name || b.location_address) details.push({ icon: '📍', text: [b.location_name, b.location_address].filter(Boolean).join(' · ') });
  const detailHtml = details.map((d) => `<div class="fl-detail"><span class="fl-di">${d.icon}</span><span>${esc(d.text)}</span></div>`).join('');
  const cta = (b.cta_label && b.cta_url) ? `<a class="fl-cta" href="${esc(b.cta_url)}">${esc(b.cta_label)}</a>` : '';
  const img = b.image_url ? `<div class="fl-img" style="background-image:url('${esc(b.image_url)}');"></div>` : '';

  const css = `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:${mode === 'print' ? '#fff' : '#e7ebf1'};font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .fl-page{width:8.5in;min-height:11in;margin:${mode === 'print' ? '0' : '24px auto'};background:${th.bg};color:${th.fg};
    display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0.9in 0.8in;position:relative;overflow:hidden;
    ${mode === 'print' ? '' : 'box-shadow:0 16px 50px rgba(11,29,52,.28);border-radius:12px;'}}
  .fl-kicker{font-size:19px;font-weight:800;letter-spacing:.28em;text-transform:uppercase;color:${th.accent};margin-bottom:18px;}
  .fl-headline{font-size:76px;line-height:1.02;font-weight:900;letter-spacing:-.01em;margin-bottom:16px;text-shadow:0 2px 18px rgba(0,0,0,.18);}
  .fl-tag{font-size:26px;font-weight:500;line-height:1.35;max-width:15em;margin:0 auto 26px;opacity:.96;}
  .fl-img{width:100%;max-width:5.4in;height:2.7in;background-size:cover;background-position:center;border-radius:16px;margin:6px auto 26px;box-shadow:0 10px 30px rgba(0,0,0,.25);}
  .fl-details{display:flex;flex-direction:column;gap:12px;margin:6px auto 26px;}
  .fl-detail{display:inline-flex;align-items:center;gap:12px;background:${th.chip};border-radius:999px;padding:12px 26px;font-size:24px;font-weight:700;}
  .fl-di{font-size:24px;}
  .fl-blurb{font-size:21px;line-height:1.5;max-width:20em;margin:0 auto 28px;opacity:.97;}
  .fl-cta{display:inline-block;background:${th.accent};color:#20303f;font-weight:900;font-size:22px;text-decoration:none;padding:14px 34px;border-radius:12px;box-shadow:0 8px 22px rgba(0,0,0,.2);}
  .fl-foot{position:absolute;left:0;right:0;bottom:0.5in;font-size:15px;font-weight:600;letter-spacing:.03em;opacity:.9;}
  @media(max-width:640px){ .fl-page{width:100%;min-height:auto;padding:44px 24px;} .fl-headline{font-size:48px;} .fl-tag{font-size:20px;} .fl-detail{font-size:18px;} }
  ${mode === 'print' ? '@page{size:Letter;margin:0;} .fl-page{margin:0;box-shadow:none;border-radius:0;} a{color:inherit;text-decoration:none;}' : ''}
  `;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(headline)}</title><style>${css}</style></head>
<body><div class="fl-page">
  ${b.kicker ? `<div class="fl-kicker">${esc(b.kicker)}</div>` : (commName ? `<div class="fl-kicker">${esc(commName)}</div>` : '')}
  <h1 class="fl-headline">${esc(headline)}</h1>
  ${b.tagline ? `<div class="fl-tag">${esc(b.tagline)}</div>` : ''}
  ${img}
  ${detailHtml ? `<div class="fl-details">${detailHtml}</div>` : ''}
  ${b.description ? `<div class="fl-blurb">${esc(b.description)}</div>` : ''}
  ${cta}
  <div class="fl-foot">${esc(commName)}${commName ? ' · ' : ''}Bedrock Association Management</div>
</div></body></html>`;
}

function renderNewsletterHTML({ issue, sections, community }, opts = {}) {
  if (issue && issue.format_key === 'flyer') return renderFlyerHTML({ issue, sections, community }, opts);
  const mode = opts.mode === 'print' ? 'print' : 'web';
  const ordered = (sections || []).slice().sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  const visible = ordered.filter((s) => {
    const vis = Array.isArray(s.visibility) ? s.visibility : ['web', 'email', 'pdf'];
    return mode === 'print' ? vis.includes('pdf') : vis.includes('web');
  });
  const hasCover = visible.some((s) => s.section_type === 'cover');
  const body = visible.map((s) => renderSection(s, mode)).join('\n');
  const commName = (community && community.name) || (issue && issue.title) || 'Community';
  const foot = `<div class="nl-foot"><strong>${esc(commName)}</strong> · managed by Bedrock Association Management<br>info@bedrocktx.com · 832-588-2485</div>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc((issue && issue.title) || 'Newsletter')}</title>
<style>${styles(mode)}</style>
</head><body>
<div class="nl-doc">
${hasCover ? '' : `<section class="nl-cover"><div class="nl-cover-inner"><div class="nl-cover-kicker">${esc((issue && issue.issue_month) || '')}</div><h1 class="nl-cover-title">${esc((issue && issue.title) || commName)}</h1></div></section>`}
${body}
${foot}
</div>
</body></html>`;
}

module.exports = { renderNewsletterHTML, mdToHtml };
