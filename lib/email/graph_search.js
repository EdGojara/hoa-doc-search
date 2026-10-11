// ============================================================================
// lib/email/graph_search.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// Search a mailbox LIVE through Microsoft Graph and return what matched.
// Nothing is stored.
//
// WHY NOT JUST INGEST THE MAILBOX. Tessa's contact lookup reads email_messages,
// the shared Communications table, and Ed's own mailbox has never been in it —
// which is why searching "Ramsey" found nothing. The obvious fix, pointing the
// ingest at egojara@, is the wrong one: it would copy Ed's entire personal and
// business correspondence into a table every staff surface reads. Tessa is
// owner-only precisely so that does not happen.
//
// So the search runs against the live mailbox at request time, under the
// owner's gate, and returns only the matching messages. No copy, no rows, no
// second place for the data to leak from. The mailbox stays the single source
// of truth for Ed's own mail.
//
// $search and $orderby are mutually exclusive in Graph — asking for both is a
// 400. Results come back in relevance order, which is what you want for a
// lookup anyway.
// ============================================================================
const { getToken, isConfigured } = require('./graph_send');

// Graph's $search on messages covers subject, body, and participants, so
// "ramsey" finds a person whether they are the sender, a recipient, or merely
// mentioned in a thread.
async function searchMailbox(mailbox, query, { top = 25, select, previewChars = 300 } = {}) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  if (!mailbox) throw new Error('mailbox_required');
  const q = String(query || '').trim();
  if (!q) return { messages: [], query: '' };

  const fields = select || [
    'id', 'subject', 'from', 'toRecipients', 'ccRecipients',
    'receivedDateTime', 'bodyPreview', 'hasAttachments', 'webLink', 'conversationId',
  ].join(',');

  // The quotes around the term are required by Graph's KQL-ish syntax; a bare
  // term is accepted but matches differently. Escape any quotes in the input so
  // a stray one cannot terminate the expression early.
  const safe = q.replace(/"/g, ' ');
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(mailbox)
    + '/messages?$search=' + encodeURIComponent('"' + safe + '"')
    + '&$top=' + Math.min(Math.max(parseInt(top, 10) || 25, 1), 100)
    + '&$select=' + encodeURIComponent(fields);

  const token = await getToken();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON */ }
  if (!r.ok) {
    throw new Error(j?.error?.message || `Graph search ${r.status}: ${text.slice(0, 200)}`);
  }

  const addr = (x) => x && x.emailAddress
    ? { name: x.emailAddress.name || null, email: (x.emailAddress.address || '').toLowerCase() }
    : null;

  const messages = (j.value || []).map((m) => ({
    id: m.id,
    subject: m.subject || '(no subject)',
    from: addr(m.from),
    to: (m.toRecipients || []).map(addr).filter(Boolean),
    cc: (m.ccRecipients || []).map(addr).filter(Boolean),
    received_at: m.receivedDateTime || null,
    preview: (m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    has_attachments: !!m.hasAttachments,
    web_link: m.webLink || null,
    conversation_id: m.conversationId || null,
  }));

  return { messages, query: q, count: messages.length };
}

// Every distinct person seen across the matches, most recently corresponded
// first. This is the "and their addresses" half of the ask: a lookup should
// answer "what is Ramsey's email" as readily as "what did Ramsey send."
function contactsFromMessages(messages) {
  const seen = new Map();
  for (const m of messages || []) {
    for (const p of [m.from, ...(m.to || []), ...(m.cc || [])]) {
      if (!p || !p.email) continue;
      const cur = seen.get(p.email);
      if (!cur) seen.set(p.email, { name: p.name, email: p.email, last_seen: m.received_at, messages: 1 });
      else {
        cur.messages += 1;
        if (!cur.name && p.name) cur.name = p.name;
        if (m.received_at && (!cur.last_seen || m.received_at > cur.last_seen)) cur.last_seen = m.received_at;
      }
    }
  }
  return [...seen.values()].sort((a, b) => String(b.last_seen || '').localeCompare(String(a.last_seen || '')));
}

// OneDrive / SharePoint (Ed 2026-10-11, legal evidence search): the same live,
// nothing-stored lookup over a user's drive, on the same app token. Returns
// file metadata only; downloadDriveItem fetches one file's bytes when a caller
// needs to read it. If the app registration lacks Files.Read.All, Graph returns
// 403 and the caller records the drive as "not accessible", never as "nothing found".
async function searchDrive(userUpn, query, { top = 25 } = {}) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  const q = String(query || '').replace(/'/g, ' ').trim();
  if (!userUpn || !q) return { items: [], query: q };
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(userUpn)
    + "/drive/root/search(q='" + encodeURIComponent(q) + "')?$top=" + Math.min(Math.max(parseInt(top, 10) || 25, 1), 100)
    + '&$select=' + encodeURIComponent('id,name,webUrl,lastModifiedDateTime,size,file,parentReference');
  const token = await getToken();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON */ }
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `Graph drive search ${r.status}`), { status: r.status });
  const items = (j.value || []).filter((x) => x.file).map((x) => ({
    id: x.id, name: x.name, web_url: x.webUrl || null, modified_at: x.lastModifiedDateTime || null, size: x.size || null,
    path: x.parentReference && x.parentReference.path ? String(x.parentReference.path).replace(/^\/drive\/root:/, '') : null,
  }));
  return { items, query: q, count: items.length };
}

async function downloadDriveItem(userUpn, itemId, { maxBytes = 15 * 1024 * 1024 } = {}) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  const token = await getToken();
  const r = await fetch('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(userUpn) + '/drive/items/' + encodeURIComponent(itemId) + '/content',
    { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw Object.assign(new Error(`Graph drive download ${r.status}`), { status: r.status });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('drive_item_too_large');
  return buf;
}

module.exports = { searchMailbox, contactsFromMessages, searchDrive, downloadDriveItem };
