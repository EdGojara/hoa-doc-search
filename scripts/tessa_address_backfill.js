#!/usr/bin/env node
// ============================================================================
// scripts/tessa_address_backfill.js  (Ed 2026-10-07, Nicole Hill)
// ----------------------------------------------------------------------------
// Teach Tessa what her mailbox already knows: every hard bounce sitting in
// tessa@ / Ed's mailbox becomes delivery evidence (migration 499), and every
// address-book contact whose address bounced is moved onto the verified address
// that replaced it, when the mail proves it (lib/ea/address_status.js rules:
// we wrote to the new address on the bounced thread, they replied after the
// bounce, and it is a near-typo or carries the contact's name).
//
// DRY RUN by default: prints what it would record and change, writes nothing.
//   node scripts/tessa_address_backfill.js            # dry run
//   node scripts/tessa_address_backfill.js --apply    # record + supersede
// Needs migration 499 applied. Idempotent: an NDR already on file is one event.
// ============================================================================
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || undefined, quiet: true });
const { createClient } = require('@supabase/supabase-js');
const graphSend = require('../lib/email/graph_send');
const { searchMailbox } = require('../lib/email/graph_search');
const AS = require('../lib/ea/address_status');

const APPLY = process.argv.includes('--apply');
const NDR_TERMS = ['Undeliverable', 'Delivery Status Notification', 'Mail delivery failed', 'Undelivered Mail', 'failure notice'];

// Reads from the database; in a dry run, writes go to memory and are printed.
function dryStore(db) {
  const pending = [];
  return {
    pending,
    async events(emails) {
      const s = new Set(emails.map((e) => String(e).toLowerCase()));
      return [...await db.events(emails), ...pending.filter((e) => s.has(e.email))];
    },
    async addEvents(rows) {
      for (const r of rows) {
        const e = { actor: 'system', detail: {}, ...r, email: String(r.email).toLowerCase(), created_at: new Date().toISOString() };
        if (!pending.some((x) => x.email === e.email && x.kind === e.kind && x.message_ref === e.message_ref)) pending.push(e);
      }
      return rows.length;
    },
    async supersede(args) {
      console.log(`  WOULD SUPERSEDE ${args.bad} -> ${args.good} (evidence: ${JSON.stringify(args.evidence)})`);
      pending.push({ email: String(args.bad).toLowerCase(), kind: 'supersede', message_ref: args.message_ref, occurred_at: args.occurred_at, related_email: String(args.good).toLowerCase(), created_at: new Date().toISOString() });
      return { dry_run: true };
    },
    contactNames: (e) => db.contactNames(e),
    async restore() { throw new Error('dry run'); },
  };
}

(async () => {
  if (!graphSend.isConfigured()) throw new Error('Microsoft Graph is not configured');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { error: schemaErr } = await sb.from('ea_email_events').select('id').limit(1);
  if (schemaErr) throw new Error('migration 499 is not applied yet: ' + schemaErr.message);
  const db = AS.supabaseStore(sb);
  const store = APPLY ? db : dryStore(db);
  const mailboxes = [graphSend.TESSA_MAILBOX, graphSend.ED_MAILBOX].filter(Boolean);
  const own = Object.entries(graphSend).filter(([k, v]) => /_MAILBOX$/.test(k) && typeof v === 'string').map(([, v]) => v);

  // 1. Every hard bounce in the mailboxes.
  const bounced = new Map();
  for (const mb of mailboxes) {
    for (const term of NDR_TERMS) {
      let r;
      try { r = await searchMailbox(mb, term, { top: 100 }); } catch (e) { console.warn(`search ${mb} "${term}" failed: ${e.message}`); continue; }
      for (const m of r.messages || []) {
        const ndr = AS.parseNdr(m, own);
        if (!ndr || !ndr.hard) continue;
        for (const email of ndr.failed) {
          const evs = AS.eventsFromMessages(email, [m], own);
          if (!evs.length) continue;
          await store.addEvents(evs);
          bounced.set(email, (bounced.get(email) || 0) + 1);
        }
      }
    }
  }
  console.log(`${APPLY ? 'Recorded' : 'Would record'} hard bounces for ${bounced.size} address(es):`);
  for (const [e, n] of bounced) console.log(`  ${e}  (${n} report${n > 1 ? 's' : ''})`);

  // 2. Address-book contacts on a bounced address: find the verified replacement.
  const list = [...bounced.keys()];
  const { data: book, error } = await sb.from('ea_contacts').select('id, name, email').not('email', 'is', null).limit(2000);
  if (error) throw error;
  const onFile = list.filter((e) => (book || []).some((c) => String(c.email).toLowerCase() === e));
  console.log(`\n${onFile.length} bounced address(es) are in Tessa's address book:`);
  for (const e of onFile) console.log(`  ${e}  (${(book || []).filter((c) => String(c.email).toLowerCase() === e).map((c) => c.name).join(', ')})`);
  const statuses = onFile.length ? await AS.learnFromMailboxes(onFile, { store, searchMailbox, mailboxes, ownAddresses: own }) : {};
  console.log('\nResult:');
  for (const e of onFile) {
    const st = statuses[e];
    console.log(`  ${e}: ${st && st.superseded_by ? 'superseded by ' + st.superseded_by : 'bounced, no verified replacement in the mail (Tessa will ask)'}`);
  }
  if (!APPLY) console.log('\nDry run: nothing was written. Re-run with --apply to record this.');
})().catch((e) => { console.error(e.message); process.exit(1); });
