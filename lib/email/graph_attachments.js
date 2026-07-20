// ============================================================================
// lib/email/graph_attachments.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// Fetch a message's file attachments from Microsoft Graph and turn them into
// Claude content blocks, so Claire can actually SEE a forwarded PDF or photo
// when a teammate forwards an email asking for help — instead of replying
// "forward me the details." Best-effort: any failure returns nothing and the
// draft proceeds on text alone.
//
// Only inline-able types are returned: images (png/jpeg/gif/webp) as image
// blocks, PDFs as document blocks. Other file types (docx, xlsx, .eml item
// attachments, OneDrive reference attachments) are named in the summary so
// Claire knows they exist, but not sent as blocks (Claude can't read them here).
// ============================================================================
const { getToken, isConfigured } = require('./graph_send');

// Cheap HTML -> readable text. Good enough to give Claire the actual message
// content (not for rendering). Drops scripts/styles, turns block tags into
// newlines, strips remaining tags, decodes the common entities, collapses runs.
function htmlToText(html) {
  if (!html) return '';
  if (!/[<&]/.test(html)) return html.trim(); // already plain text
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/ *\n */g, '\n')
    .trim();
}

// Fetch a single message's full body as readable text (draft-time fallback when
// the stored body_full is empty — e.g. anything ingested before body_full was
// captured). Best-effort.
async function fetchMessageText(mailbox, graphId) {
  if (!isConfigured() || !mailbox || !graphId) return '';
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}?$select=body,bodyPreview`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return '';
    const j = await r.json();
    const raw = (j.body && j.body.content) || j.bodyPreview || '';
    return (j.body && j.body.contentType === 'html' ? htmlToText(raw) : String(raw).trim()).slice(0, 20000);
  } catch (_) { return ''; }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const MAX_BLOCKS = 6;                 // cap how many we hand to Claude
const MAX_BYTES = 4.5 * 1024 * 1024;  // per-attachment raw ceiling (~6MB base64)

// Returns { blocks: [...Claude content blocks], summary: 'text describing what was attached' }
async function fetchAttachmentBlocks(mailbox, graphId) {
  if (!isConfigured() || !mailbox || !graphId) return { blocks: [], summary: '' };
  let items = [];
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}/attachments`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { blocks: [], summary: '' };
    const j = await r.json();
    items = Array.isArray(j.value) ? j.value : [];
  } catch (_) { return { blocks: [], summary: '' }; }

  const blocks = []; const named = []; const skipped = []; const seen = new Set();
  for (const a of items) {
    const type = a['@odata.type'] || '';
    const name = a.name || 'attachment';
    // Only file attachments carry contentBytes; item/reference attachments don't.
    if (!/fileAttachment/i.test(type) || !a.contentBytes) { skipped.push(name); continue; }
    const ct = String(a.contentType || '').toLowerCase().split(';')[0].trim();
    const size = a.size || 0;
    // Dedupe identical images (signature/logo repeated across a forward chain):
    // fingerprint on size + a slice of the bytes so we don't send the same logo
    // to Claire several times.
    const fp = `${size}:${String(a.contentBytes).slice(0, 96)}`;
    if (seen.has(fp)) { continue; }
    seen.add(fp);
    if (size > MAX_BYTES) { skipped.push(`${name} (too large)`); continue; }
    if (blocks.length >= MAX_BLOCKS) { skipped.push(name); continue; }

    if (IMAGE_TYPES.has(ct)) {
      const media = ct === 'image/jpg' ? 'image/jpeg' : ct;
      blocks.push({ type: 'image', source: { type: 'base64', media_type: media, data: a.contentBytes } });
      named.push(`${name} (photo)`);
    } else if (ct === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.contentBytes } });
      named.push(`${name} (PDF)`);
    } else {
      skipped.push(`${name} (${ct || 'unknown type'})`);
    }
  }

  let summary = '';
  if (named.length) summary += `Attachments included below for you to read: ${named.join(', ')}.`;
  if (skipped.length) summary += `${summary ? ' ' : ''}Also attached but not shown here (unreadable format): ${skipped.join(', ')}.`;
  return { blocks, summary };
}

// Fetch a message's PDF attachments as raw buffers (for AP invoice intake).
// Returns [{ filename, buffer }]. Best-effort.
async function fetchAttachmentBuffers(mailbox, graphId) {
  if (!isConfigured() || !mailbox || !graphId) return [];
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}/attachments`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const a of (j.value || [])) {
      if (!/fileAttachment/i.test(a['@odata.type'] || '') || !a.contentBytes) continue;
      const ct = String(a.contentType || '').toLowerCase();
      const isPdf = ct.includes('pdf') || /\.pdf$/i.test(a.name || '');
      if (!isPdf) continue;
      out.push({ filename: a.name || 'invoice.pdf', buffer: Buffer.from(a.contentBytes, 'base64') });
    }
    return out;
  } catch (_) { return []; }
}

// Fetch ALL readable file attachments (PDFs AND images) as raw buffers — for
// ACC/ARC application intake, where the application form is a PDF but the
// supporting site plans and property photos are images. Returns
// [{ filename, buffer, contentType, isPdf, isImage }]. Best-effort.
async function fetchAllAttachmentBuffers(mailbox, graphId) {
  if (!isConfigured() || !mailbox || !graphId) return [];
  try {
    const token = await getToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}/attachments`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const a of (j.value || [])) {
      if (!/fileAttachment/i.test(a['@odata.type'] || '') || !a.contentBytes) continue;
      const ct = String(a.contentType || '').toLowerCase().split(';')[0].trim();
      const isPdf = ct.includes('pdf') || /\.pdf$/i.test(a.name || '');
      const isImage = /^image\//.test(ct) || /\.(png|jpe?g|gif|webp|heic)$/i.test(a.name || '');
      if (!isPdf && !isImage) continue; // skip docx/xlsx/etc — the pipeline can't read them here
      out.push({ filename: a.name || (isPdf ? 'application.pdf' : 'photo.jpg'), buffer: Buffer.from(a.contentBytes, 'base64'), contentType: ct || (isPdf ? 'application/pdf' : 'image/jpeg'), isPdf, isImage });
    }
    return out;
  } catch (_) { return []; }
}

// Find and download the ONE attachment that's actually the invoice — metadata
// first, so we never pull a 15MB pile of jobsite photos (a forwarded lawn-care
// bill came with 24 JPEGs, ~15MB, that timed out the download) or run intake on
// a W9 / ACH form / void that happened to be attached alongside the real bill.
// Lists names+types cheaply, scores the PDFs for invoice-likeness, and fetches
// the best candidate's bytes by id. Returns { status, filename, buffer } —
// status: 'ok' | 'stale' (graph 404, email was filed → re-pull) | 'no_pdf'.
async function fetchInvoicePdf(mailbox, graphId, { hintNumber } = {}) {
  if (!isConfigured() || !mailbox || !graphId) return { status: 'no_pdf' };
  try {
    const token = await getToken();
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(graphId)}/attachments`;
    // Metadata only — no contentBytes, so a 24-photo email is a tiny response.
    const listR = await fetch(`${base}?$select=id,name,contentType,size,isInline`, { headers: { Authorization: `Bearer ${token}` } });
    if (listR.status === 404) return { status: 'stale' };
    if (!listR.ok) return { status: 'no_pdf' };
    const list = (await listR.json()).value || [];
    const pdfs = list.filter((a) => !a.isInline && (String(a.contentType || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(a.name || '')));
    if (!pdfs.length) return { status: 'no_pdf' };
    const hint = hintNumber ? String(hintNumber).replace(/[^0-9a-z]/gi, '').toLowerCase() : '';
    const score = (a) => {
      const n = String(a.name || '').toLowerCase();
      let s = 0;
      if (/invoice|inv[-_ ]?\d|statement|bill|payment/.test(n)) s += 3;
      if (hint && n.replace(/[^0-9a-z]/g, '').includes(hint)) s += 4;   // filename carries the invoice #
      if (/\bw-?9\b|ach|void|contract|agreement|coi|insurance|w9/.test(n)) s -= 5; // not the bill
      s -= Math.min(2, (a.size || 0) / (2 * 1024 * 1024)); // slight bias to the smaller, bill-sized PDF
      return s;
    };
    pdfs.sort((a, b) => score(b) - score(a));
    // Download only the best candidate's bytes (by id).
    const best = pdfs[0];
    const oneR = await fetch(`${base}/${encodeURIComponent(best.id)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!oneR.ok) return { status: 'no_pdf' };
    const one = await oneR.json();
    if (!one.contentBytes) return { status: 'no_pdf' };
    return { status: 'ok', filename: best.name || 'invoice.pdf', buffer: Buffer.from(one.contentBytes, 'base64'), candidates: pdfs.length };
  } catch (_) { return { status: 'no_pdf' }; }
}

module.exports = { fetchAttachmentBlocks, fetchMessageText, fetchAttachmentBuffers, fetchAllAttachmentBuffers, fetchInvoicePdf, htmlToText };
