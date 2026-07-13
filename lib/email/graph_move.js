// ============================================================================
// lib/email/graph_move.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// After trustEd ingests a message, move it OUT of the mailbox's Inbox into an
// "Addressed by trustEd" folder, so the Outlook inbox drains to empty and Ed
// can see at a glance that everything has been taken into the system. Nothing
// is deleted — the original sits in the folder for audit. trustEd's roster is
// where the mail is actually worked.
//
// Needs Mail.ReadWrite on the mailbox (Mail.Read alone can't move). Until that
// is granted the move just no-ops with a logged warning — ingest is unaffected.
// ============================================================================
const { getToken, isConfigured } = require('./graph_send');

const FILED_FOLDER = 'Addressed by trustEd';
const _folderCache = {};   // mailbox -> { folderName -> id }
const _inboxCache = {};     // mailbox -> inbox folder id

async function getInboxId(mailbox) {
  const key = String(mailbox).toLowerCase();
  if (_inboxCache[key]) return _inboxCache[key];
  try {
    const token = await getToken();
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = await r.json();
    _inboxCache[key] = j.id || null;
    return _inboxCache[key];
  } catch (_) { return null; }
}

// Find (or create) the destination folder; cache its id per mailbox.
async function ensureFolder(mailbox, name = FILED_FOLDER) {
  const key = String(mailbox).toLowerCase();
  _folderCache[key] = _folderCache[key] || {};
  if (_folderCache[key][name]) return _folderCache[key][name];
  try {
    const token = await getToken();
    const list = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders?$top=200&$select=id,displayName`, { headers: { Authorization: `Bearer ${token}` } });
    if (list.ok) {
      const j = await list.json();
      const f = (j.value || []).find((x) => String(x.displayName || '').toLowerCase() === name.toLowerCase());
      if (f) { _folderCache[key][name] = f.id; return f.id; }
    }
    const cr = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }),
    });
    if (cr.ok) { const j = await cr.json(); _folderCache[key][name] = j.id; return j.id; }
    return null;
  } catch (_) { return null; }
}

// Move a message to the filed folder. Returns { moved, new_id? }. Best-effort:
// a permission/API failure returns { moved:false } and never throws.
async function fileMessage(mailbox, messageId, name = FILED_FOLDER) {
  if (!isConfigured() || !mailbox || !messageId) return { moved: false };
  try {
    const dest = await ensureFolder(mailbox, name);
    if (!dest) return { moved: false, error: 'no_folder' };
    const token = await getToken();
    // Mark it read before filing, so the "Addressed by trustEd" folder doesn't
    // look like a pile the system ignored. Best-effort — never blocks the move.
    try {
      await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ isRead: true }),
      });
    } catch (_) {}
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/move`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ destinationId: dest }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (r.status === 403) console.warn(`[graph_move] can't file mail for ${mailbox} — grant Mail.ReadWrite on the Azure app.`);
      return { moved: false, status: r.status, detail: t.slice(0, 160) };
    }
    const j = await r.json().catch(() => ({}));
    return { moved: true, new_id: j.id || null };
  } catch (e) { console.warn('[graph_move] file failed:', e.message); return { moved: false }; }
}

module.exports = { getInboxId, ensureFolder, fileMessage, FILED_FOLDER };
