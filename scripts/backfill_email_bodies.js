// ============================================================================
// scripts/backfill_email_bodies.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Repairs email_messages.body_full on mail that was ingested while the column
// was never written.
//
// THE BUG: mapGraphMessage computed body_full correctly, and the insert row in
// graph_ingest.js listed body_preview and omitted body_full. A draft written
// during the ingest run saw the whole email because it was still in memory, so
// nothing looked wrong. Everything that read the message back afterwards — a
// redraft, Amanda's or Kat's review, a 360 timeline, a search — got
// body_preview, which Graph caps at 255 characters.
//
// 980 of 1,053 stored messages had no body. 824 of those are info@, the main
// homeowner inbox, so every reply drafted off stored history was written from
// the first 255 characters of the customer's email. It never looked broken,
// because a model given the first 255 characters still writes fluent, confident
// prose. That is the whole reason this needed a repair and not just a fix.
//
// This script does ONE thing: fetch the body from Graph and UPDATE it. No
// classify, no draft, no resolve, no filing, no delete-then-insert. It cannot
// re-send anything, cannot change triage state, and cannot move Outlook mail.
// A full re-ingest with force:true would do all of those on a year of old mail.
//
// Only fills rows where body_full IS NULL. Re-runnable; already-filled rows are
// left alone. --dry-run prints what it would touch.
//
//   node scripts/backfill_email_bodies.js --dry-run
//   node scripts/backfill_email_bodies.js
//   node scripts/backfill_email_bodies.js --mailbox info@bedrocktx.com
// ============================================================================
require('dotenv').config();
const { getToken, isConfigured } = require('../lib/email/graph_send');
const { htmlToText } = require('../lib/email/graph_attachments');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');
function argValue(name) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3) || null;
  const i = process.argv.indexOf(`--${name}`);
  // indexOf returns -1 when the flag is absent, and argv[0] is the node binary,
  // so an unguarded i+1 silently "filters" every mailbox to a path. It did.
  if (i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return null;
}
const ONLY = argValue('mailbox');

/** Same derivation as mapGraphMessage — one shape of body text, not two. */
function bodyTextOf(m) {
  const raw = (m.body && m.body.contentType === 'html')
    ? htmlToText(m.body.content)
    : ((m.body && m.body.content) || m.bodyPreview || '');
  return (raw || '').slice(0, 40000) || null;
}

/**
 * Which rows still need a body, and how far back to ask Graph.
 * Paginated: this is exactly the "all rows for X" read the truncation scar
 * covers, and a capped read here would silently under-repair.
 */
async function emptyRowsByMailbox() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('email_messages')
      .select('id, mailbox, internet_message_id, received_at, subject')
      .is('body_full', null)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`read email_messages failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const by = new Map();
  for (const r of rows) {
    // No mailbox address means there is no Graph mailbox to ask. Rows tagged
    // 'imported' came from a file, and outbound sends are logged without one.
    if (!r.mailbox || !r.mailbox.includes('@')) continue;
    if (!r.internet_message_id) continue;
    if (ONLY && r.mailbox.toLowerCase() !== ONLY.toLowerCase()) continue;
    if (!by.has(r.mailbox)) by.set(r.mailbox, []);
    by.get(r.mailbox).push(r);
  }
  return { by, scanned: rows.length };
}

async function backfillMailbox(mailbox, rows) {
  const wanted = new Map(rows.map((r) => [r.internet_message_id, r]));
  // Ask Graph only as far back as the oldest row that actually needs repair.
  const oldest = rows.map((r) => r.received_at).filter(Boolean).sort()[0];
  const since = oldest ? new Date(new Date(oldest).getTime() - 864e5).toISOString() : null;

  const token = await getToken();
  const sel = 'internetMessageId,bodyPreview,body';
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`
    + `?$select=${sel}&$top=50&$orderby=receivedDateTime desc`
    + (since ? `&$filter=receivedDateTime ge ${since}` : '');

  let seen = 0, filled = 0, stillEmpty = 0, pages = 0;
  while (url && wanted.size) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`graph ${r.status} on ${mailbox}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    pages++;
    for (const m of j.value || []) {
      seen++;
      const row = wanted.get(m.internetMessageId);
      if (!row) continue;
      wanted.delete(m.internetMessageId);
      const text = bodyTextOf(m);
      // Graph really can return an empty body (a bare attachment, a meeting
      // response). Count it rather than writing an empty string, so the tally
      // separates "we could not find it" from "there is nothing there".
      if (!text) { stillEmpty++; continue; }
      if (DRY) { filled++; continue; }
      const { error } = await supabase.from('email_messages')
        .update({ body_full: text }).eq('id', row.id);
      if (error) { console.warn(`  ! update ${row.id} failed: ${error.message}`); continue; }
      filled++;
    }
    url = j['@odata.nextLink'] || null;
  }
  return { filled, stillEmpty, notFound: wanted.size, seen, pages };
}

(async () => {
  if (!isConfigured()) { console.error('graph_not_configured — set GRAPH_* env vars'); process.exit(1); }
  const { by, scanned } = await emptyRowsByMailbox();
  const repairable = [...by.values()].reduce((n, v) => n + v.length, 0);
  console.log(`${scanned} rows with no body; ${repairable} of them are in a Graph mailbox`
    + (ONLY ? ` (filtered to ${ONLY})` : '') + (DRY ? '  [DRY RUN]' : ''));

  const totals = { filled: 0, stillEmpty: 0, notFound: 0 };
  for (const [mailbox, rows] of by.entries()) {
    process.stdout.write(`  ${mailbox}: ${rows.length} to repair ... `);
    try {
      const s = await backfillMailbox(mailbox, rows);
      totals.filled += s.filled; totals.stillEmpty += s.stillEmpty; totals.notFound += s.notFound;
      console.log(`${s.filled} filled, ${s.stillEmpty} genuinely empty, ${s.notFound} not found in Graph (${s.pages} pages)`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
  console.log(`\ntotal: ${totals.filled} filled, ${totals.stillEmpty} genuinely empty, ${totals.notFound} not found`);
  if (totals.notFound) console.log('  "not found" is normal for mail deleted or moved out of the mailbox since ingest.');
})().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
