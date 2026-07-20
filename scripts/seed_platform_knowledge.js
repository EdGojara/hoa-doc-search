#!/usr/bin/env node
// ============================================================================
// scripts/seed_platform_knowledge.js  (Ed 2026-07-07)
// ----------------------------------------------------------------------------
// The platform's self-knowledge: what trustEd does, where each screen lives,
// how to use it. askEd + Claire retrieve these from the `playbook` (semantic),
// so "where is X / how do I do Y" gets the REAL answer instead of a
// hallucinated one (the Laurie/Homeowner-360 incident).
//
// DISCIPLINE (see CLAUDE.md): when you ship or move a feature, add/update its
// entry here and re-run this script. A feature isn't "done" until the platform
// can explain it. Idempotent — deletes the prior platform_feature set and
// re-inserts, so this file is the single source of truth.
//
//   node -r dotenv/config scripts/seed_platform_knowledge.js
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Each: what a staffer might ASK (situation, drives semantic match) → the real
// answer (response). Keep responses accurate; if unsure of an exact click-path,
// describe WHAT it does rather than invent a menu.
const FEATURES = [
  {
    situation: 'How do I get prior meeting minutes or an agenda into the platform, or into a board packet? Can I just email them to Paige?',
    response: 'Yes — email Paige at paige@bedrocktx.com like you would a person: attach the minutes or agenda as a PDF (or paste the full text into the email body) and say what it is and which community, e.g. "please add this to Lakes of Pine Forest minutes." Paige reads the file, files it into the platform as a DRAFT record — minutes go to the Minutes module, agendas to the Agenda module — and replies confirming what she filed. It is a real association record from then on: searchable, exportable on takeover, and it flows into the board packet\'s Prior Minutes / Agenda section automatically for this meeting and every future one. A person still opens the Minutes/Agenda module to review and finalize it (drafts are never auto-finalized). If a file is a Word doc or a scan Paige can\'t read, she\'ll ask you to resend it as a PDF. You can also do it by hand in the Board Packets screen by dropping the PDF on the Prior Minutes or Agenda section card — but emailing Paige is the easy path.',
  },
  {
    situation: 'Where is Homeowner 360, how do I look up a homeowner or pull up a single address to see its violations in detail, the inspection photos, the letters we sent, the balance, and the history?',
    response: 'Homeowner 360 is a tab in the TOP navigation bar (labeled 360 with a person icon), or go to /admin/homeowner. It is NOT inside a property record. Search by name, address, email, or phone and one screen shows: open violations (each with the specific detail of what was seen, a Photo link to the inspection photo, and a Letter link to the exact letter that was mailed for that violation), balance + recent payments, ARC, pool access, all correspondence and calls, an AI recap, and a box at the bottom to add notes or upload emails to the record.',
  },
  {
    situation: 'Where do I see emails coming into info@ or claire@, Claire’s drafted replies, and how do I pull new mail or send an email as Claire?',
    response: 'Communications is a top-nav tab (envelope icon) at /admin/communications. During beta it is owner-only (only Ed sees it; other staff see a "coming soon" screen). It shows every email to info@ and claire@, auto-classified and linked to the homeowner, with a Claire-drafted reply for each to review, edit, and Approve & send (or dismiss). "Pull inbox" pulls new mail on demand; "New email" composes a fresh email as Claire. Nothing sends without approval.',
  },
  {
    situation: 'How do I send an email as Claire or Emma, or have one of them write an email for me to review before it goes out?',
    response: 'Use the "AI Team Email" top-nav tab (envelope icon, admin-only). At the top pick who it sends as: Claire (front office, for homeowners and boards, from claire@bedrocktx.com) or Emma (accounts payable, for vendors, from emma@bedrocktx.com). Enter recipients (commas for multiple, plus Cc), then either type the message or use "Have Claire/Emma write it" — give the gist, the AI drafts it, you edit, then Send. It goes out with the Bedrock logo + that person’s honest-AI signature; Claire’s mail logs on the homeowner’s record when the address matches. (Inside Communications, replies auto-send in the right voice — Emma for vendor/AP threads, Claire otherwise.)',
  },
  {
    situation: 'How do I add or upload a payment plan, and where do I see everyone who is on a payment plan?',
    response: 'Payment Plans is a top-nav tab (card icon) at /admin/payment-plans (admin-only). Pick the association and drop the signed payment-plan agreement PDF (or a firm report listing several) — the AI reads the terms (total balance, installment amount, frequency, dates), matches each to a property and its current owner, and you review before anything files. On approve, each plan is filed and appears on that homeowner’s 360 (in a Payment plans card) with a link to the signed agreement. The roster on the same page lists everyone currently on a plan across the portfolio, filterable by association and status (active/completed/defaulted/cancelled); each row links to that homeowner’s 360. A property has one active plan at a time — re-uploading a corrected agreement updates it rather than making a duplicate.',
  },
  {
    situation: 'Where do I see how much we spend with each vendor by community, run the 1099 report, upload a W-9, or set whether a vendor is 1099-required?',
    response: 'The Vendors tab (building icon, under Operations) is the vendor master. To capture past spend, use the "Historical Invoices (record only)" box — drop invoices already paid, pick the community and the paid date (the paid date drives the 1099 year, cash basis), and it files the spend and adds new vendors automatically. That box is for record only: anything that still needs to be PAID goes to Emma (accounts payable), not here. Current spend flows in automatically from what Emma pays, so each vendor\'s annual total combines both. Open a vendor to see its Tax & 1099 panel: toggle "1099 required", and drag/drop the vendor\'s W-9 PDF — the system reads the tax classification + TIN, files the W-9, and sets the 1099 flag (you can override). The "📊 Spend & 1099 Report" button runs the report: total paid per vendor by community for a tax year, with a "1099 file" view that shows vendors at/above $600 (the threshold is per community, since each association is its own filing EIN), flags any 1099 vendor missing a W-9, links each W-9, and exports to CSV.',
  },
  {
    situation: 'Where do I register pool fobs or key tags and extended-hours swim forms, and how do I see who has pool access and their tag numbers?',
    response: 'Pool Access is a top-nav tab (swimmer icon) at /admin/pool-access. Pick a pool community (Waterview, Eaglewood, Lakes of Pine Forest, or Canyon Gate), then drop a batch of fob-registration or extended-hours PDFs — the system reads each form, matches the homeowner, and you review before anything files. The roster lists everyone with access and their tag numbers, and it also appears on the homeowner’s 360.',
  },
  {
    situation: 'How do I do a field inspection, capture violation photos, and where do the violation letters get drafted and printed?',
    response: 'The Inspect tab (under Operations) is the field tool: drive a community, capture photos, and the AI flags likely violations. Back at the office the Drafts queue holds a draft letter for each — review it, use Fix to correct the category if the AI got it wrong, Regenerate, or Reject, then Lock + Print. Regenerate only re-renders the current data; to change the violation type you must use Fix.',
  },
  {
    situation: 'How do violation letters work — courtesy notices, certified 209, force-mow, and general cleanup self-help letters?',
    response: 'Letters draft automatically from a violation in the Drafts queue and escalate courtesy 1 → courtesy 2 → certified 209. The 10-day certified self-help letters (force-mow for lawns, and general cleanup/abatement for trash/debris) draft from an open violation using the self-help button, but only for communities configured with their Declaration self-help authority (Eaglewood is set up). Every letter is reviewed and Locked before printing. The exact letter that was mailed is linked on the homeowner’s 360.',
  },
  {
    situation: 'Where do I see violations coming due, cure deadlines, lapsed cures, and certified 209 cases across communities?',
    response: 'The Cures tab (sprout icon) is portfolio case management: what is coming due in the next 30 days, what has lapsed past its cure date, and the certified 209 cases per community. The cure-lapse processor advances expired violations to the next stage and drafts the new letter.',
  },
  {
    situation: 'What is askEd and how do I ask a question about a community, a homeowner’s account, Texas 209, or how to handle a situation?',
    response: 'askEd is the staff AI assistant (brain icon, top nav). Ask it about a community’s governing documents, Texas Property Code 209, a homeowner’s account, vendor contacts, or how to handle a situation — it answers grounded in the documents and account data. Quick mode is for fast facts; full mode gives advisor-level reasoning. It is Bedrock’s own tool, not a vendor — there is no external support desk.',
  },
  {
    situation: 'Where do I see what a homeowner owes, receivables, aging, or the general ledger?',
    response: 'A homeowner’s balance shows on their 360. Owner Receivables (Owner AR) ingests Vantaca AR aging PDFs into per-property balance snapshots. The general ledger / accounting lives at /admin/accounting (Finance). Vantaca is still the live ledger; trustEd mirrors it until the GL cutover for each community.',
  },
  {
    situation: 'How do I see a community map with each house and its violations, owner, and balance?',
    response: 'The Community Map shows every house in a community as a clickable tile. Click a house to see its open violations, ACC, AR, and owner — the same data as Homeowner 360, on the map. Field crews also use it to locate properties on a drive.',
  },
  {
    situation: 'Where do I see the team’s work, what is due, and what might fall through the cracks?',
    response: 'The Status tab (clipboard icon) is the team work board: every inbound mail and email plus every active project, each with an owner, a status, and an SLA due date from the Operations Standard, so nothing falls through.',
  },
  {
    situation: 'How do I search a community’s governing documents, CC&Rs, or bylaws?',
    response: 'The Documents tab keyword-searches a community’s uploaded governing documents. For a reasoned answer that combines the documents with Texas 209 and the homeowner’s account, ask askEd instead.',
  },
  {
    situation: 'How do I handle a resale request, a closing, or a new-owner ownership transfer?',
    response: 'Home Sales (/admin/home-sales) handles resale requests before closing and closing packets after: scan the title company’s closing mail and the system records the ownership transfer from seller to buyer and the transfer fee.',
  },
  {
    situation: 'How do I log physical mail that comes into the office?',
    response: 'Mail Scan (mailbox icon) is physical-mail intake: scan a piece of mail and the system classifies it, routes it, and logs it to the association record.',
  },
];

(async () => {
  // Idempotent: clear the prior platform-knowledge set (both category labels
  // used during rollout) so this file stays the single source of truth.
  const { error: delErr } = await sb.from('playbook').delete().in('category', ['platform_feature', 'platform_navigation']);
  if (delErr) console.warn('delete prior entries:', delErr.message);

  let inserted = 0;
  for (const f of FEATURES) {
    let embedding = null;
    try {
      const emb = await openai.embeddings.create({ model: 'text-embedding-ada-002', input: f.situation.replace(/\s+/g, ' ').slice(0, 8000) });
      embedding = emb.data[0].embedding;
    } catch (e) { console.warn('embed failed (saving without):', e.message); }
    const { error } = await sb.from('playbook').insert({
      situation: f.situation, response: f.response,
      category: 'platform_feature', tags: ['navigation', 'how_to', 'platform'],
      applies_to: ['asked'], reasoning: 'Platform self-knowledge so askEd/Claire answer how-to questions correctly instead of hallucinating.',
      embedding,
    });
    if (error) { console.warn('insert failed:', error.message); continue; }
    inserted += 1;
  }
  console.log(`platform knowledge seeded: ${inserted}/${FEATURES.length} entries`);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
