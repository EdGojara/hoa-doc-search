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

module.exports = { fetchAttachmentBlocks, fetchMessageText, fetchAttachmentBuffers, htmlToText };
