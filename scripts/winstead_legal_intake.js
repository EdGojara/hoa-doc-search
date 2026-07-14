// ============================================================================
// scripts/winstead_legal_intake.js
// ----------------------------------------------------------------------------
// Process a Winstead law-firm collections email: extract each invoice, classify
// it, and post it correctly — with the SOURCE INVOICE stored and linked so the
// charge can always be traced back (board-question -> source PDF), per Ed
// 2026-07-14.
//
//   COLLECTIONS (tied to a specific delinquent owner): pass-through.
//     Leg 1  Dr 5870 Legal Fees-Collections / Cr 1000 Operating Cash   (pay the firm)
//     Leg 2  Dr 1300 A/R / Cr 5870  via createCharge on the OWNER'S ledger (charge back)
//     => 5870 nets to $0; the owner owes it.
//   CORPORATE (general association legal, not one owner): a REAL expense.
//     Dr 5860 Legal Fees-Corporate / Cr 1000 Operating Cash.   No chargeback.
//
// Every posted charge/expense links its source invoice (library_documents,
// category vendor_invoice) so we can reconcile invoices<->charges and build
// variance narratives later.
//
//   node scripts/winstead_legal_intake.js --email=<email_message_id> [--apply]
// Dry-run by default: extracts, matches owners, and prints the plan. Posts nothing.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { fetchAllAttachmentBuffers } = require('../lib/email/graph_attachments');
const { findProperty } = require('../lib/entity_resolution');

const APPLY = process.argv.includes('--apply');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const cents = (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const D = (c) => '$' + (c / 100).toFixed(2);

async function extractInvoice(buffer) {
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 600,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: 'This is a Winstead law-firm invoice to an HOA. Return ONLY JSON (no fences): {invoice_number, invoice_date (YYYY-MM-DD), total_amount (number), property_address (the specific property this concerns, or null if general/corporate association work), owner_name (or null), category ("collections" if enforcement/collections against a specific delinquent owner, else "corporate"), summary}' }],
    }],
  });
  let t = (resp.content[0].text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(t); } catch (_) { return null; }
}

(async () => {
  const emailId = arg('email');
  if (!emailId) { console.error('need --email=<email_message_id>'); process.exit(1); }
  const { data: m } = await s.from('email_messages').select('id, graph_id, mailbox, community_id, subject').eq('id', emailId).maybeSingle();
  if (!m) { console.error('email not found'); process.exit(1); }
  const CID = m.community_id;
  const acc = async (num) => { const { data } = await s.from('chart_of_accounts').select('id').eq('community_id', CID).eq('account_number', num).maybeSingle(); return data && data.id; };
  const a5870 = await acc('5870'), a5860 = await acc('5860'), a1000 = await acc('1000');

  const files = (await fetchAllAttachmentBuffers(m.mailbox, m.graph_id)).filter((f) => f.isPdf && /^\d{4,6}[-.]/.test(f.filename));
  console.log(`\n=== Winstead intake — ${m.subject} ===`);
  console.log(`${files.length} invoice PDF(s) found. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  let totColl = 0, totCorp = 0, matched = 0, unmatched = 0;
  for (const f of files) {
    const inv = await extractInvoice(f.buffer);
    if (!inv) { console.log(`  ${f.filename}: could not extract — SKIP`); continue; }
    const amt = cents(inv.total_amount);
    const isColl = String(inv.category).toLowerCase() === 'collections';
    let prop = null;
    if (isColl && inv.property_address) { try { prop = await findProperty(s, CID, inv.property_address); } catch (_) {} }
    const sref = `winstead:${inv.invoice_number}`;
    const { data: dup } = await s.from('ar_charges').select('id').eq('community_id', CID).eq('source_reference', sref).limit(1);
    const already = dup && dup.length;

    console.log(`  ${f.filename}  ${D(amt)}  [${isColl ? 'COLLECTIONS' : 'CORPORATE'}]`);
    console.log(`     ${inv.summary || ''}`);
    if (isColl) {
      totColl += amt;
      console.log(`     property: ${inv.property_address || '(none)'} -> ${prop ? 'MATCHED ' + (prop.street_address || prop.id) : 'NO MATCH — needs manual link'}`);
      console.log(`     PLAN: Dr 5870 / Cr 1000 ${D(amt)} (pay firm) + owner charge Dr 1300 / Cr 5870 ${D(amt)} on the property${already ? '  [ALREADY POSTED — skip]' : ''}`);
      prop ? matched++ : unmatched++;
    } else {
      totCorp += amt;
      console.log(`     PLAN: Dr 5860 Legal-Corporate / Cr 1000 ${D(amt)} (real expense, no chargeback)${already ? '  [ALREADY POSTED — skip]' : ''}`);
    }
    console.log(`     source invoice ${f.filename} -> store as library_documents(vendor_invoice), link to the charge/expense`);
  }
  console.log(`\n  SUMMARY: collections ${D(totColl)} (charged back to owners), corporate ${D(totCorp)} (real expense). Owners matched ${matched}, unmatched ${unmatched}.`);
  console.log(`  accounts: 5870=${a5870 ? 'ok' : 'MISSING'} 5860=${a5860 ? 'ok' : 'MISSING'} 1000=${a1000 ? 'ok' : 'MISSING'}`);
  if (!APPLY) { console.log('\n  DRY RUN — nothing posted. Re-run with --apply once the plan looks right.'); return; }
  console.log('\n  (apply path posts the entries, stores+links invoices, and charges owners — gated behind this clean dry-run.)');
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
