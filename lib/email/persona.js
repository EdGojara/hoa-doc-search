// ============================================================================
// lib/email/persona.js  (Ed 2026-07-12)
// ----------------------------------------------------------------------------
// Single source of truth for "which AI team member owns this email." Used to
// stamp email_messages.persona at ingest + on outbound, and to drive the team
// roster on the Communications board (see the /team endpoint). Attribution is
// by ROUTING, not just physical mailbox — a DRV response or an ACC application
// physically arrives at info@ but belongs to Miranda / Annie.
//
// Priority order matters: DRV routing (Miranda) beats ACC (Annie) beats vendor
// (Emma) beats the front office (Claire, the default).
// ============================================================================
const graphSend = require('./graph_send');

function personaForMessage(m) {
  if (!m) return 'claire';
  const mailbox = String(m.mailbox || '').toLowerCase();
  const cls = m.classification || '';
  const ex = m.extracted || {};
  const subj = String(m.subject || '').toLowerCase();
  const from = String(m.sender_email || '').toLowerCase();
  // Tessa (Ed's PRIVATE executive assistant) logs her sends from tessa@ or from
  // Ed's own mailbox (ghostwritten). These are personal and owner-only — tag
  // them 'tessa' so they never fall through to Claire and surface to staff.
  if (mailbox === String(graphSend.TESSA_MAILBOX || '').toLowerCase()) return 'tessa';
  if (mailbox === String(graphSend.ED_MAILBOX || '').toLowerCase()) return 'tessa';
  if (mailbox === String(graphSend.MIRANDA_MAILBOX || '').toLowerCase()) return 'miranda';
  if (ex.drv && ex.drv.persona === 'miranda') return 'miranda';
  if (mailbox === String(graphSend.ANNIE_MAILBOX || '').toLowerCase()) return 'annie';
  if (cls === 'acc_request') return 'annie';
  if (mailbox === String(graphSend.EMMA_MAILBOX || '').toLowerCase()) return 'emma';
  // Vendor / money mail. A real BILL, a payment confirmation, or a vendor chasing
  // us is Emma's AP work. But the vendor tag also catches a lot that ISN'T AP —
  // bank/card statements go to Kat (accounting), roster/address changes to Amanda
  // (community mgmt), resale/closing to Reese, and pure notices are noise. Route
  // by content so Emma's queue stays bills-only. (Ed 2026-07-20: "if they are not
  // bills they should go to other ai team members — we're building a whole team
  // of specialists.")
  if (m.resolved_vendor_id || ['vendor_financial', 'vendor_general'].includes(cls)) {
    const text = `${subj} ${String(m.ai_summary || '').toLowerCase()} ${String(m.body_preview || '').toLowerCase()}`;
    let bill = { disposition: 'review' };
    try { bill = require('../ap/email_bill_classifier').classifyBill({ subject: m.subject, bodyText: m.body_full || m.ai_summary || m.body_preview, hasPdf: !!m.has_attachments, extracted: ex }); } catch (_) {}
    const isChase = /past[-\s]?due|overdue|second notice|final notice|please remit|payment reminder|balance (due|remains)|delinquen/.test(text);
    // Actual AP work stays with Emma.
    if (bill.disposition === 'already_paid' || bill.disposition === 'payable' || isChase) return 'emma';
    // Not a bill — hand to the right specialist.
    if (/estoppel|resale|closing (statement|package|disclosure)|title (co\b|company)|settlement statement|transfer of ownership|new owner|home ?wise|realtor/.test(text)) return 'reese';
    if (/mailing address|address (change|update)|roster|owner (update|change|information)|update (their|the|our) (email|address|contact)/.test(text)) return 'amanda';
    // Pure notices/noise checked BEFORE the broad accounting net, so a folder
    // notification about a "Bedrock Accounting" folder doesn't read as Kat's work.
    if (/order(ed)?[:\s]|amazon|shipment|tracking (number|#)|dashboard|monthly report|folder notification|files were added|market notice|newsletter|automatic reply|out of office|\bsurvey\b/.test(text)) return 'general';
    if (/spending summary|statement (is )?(ready|available|attached)|escrow|uncashed|reconcil|bank (statement|draft)|account status|payments? for|refund|deposit|1099|w-?9/.test(text)) return 'kat';
    return 'emma'; // ambiguous vendor mail — AP triages it
  }
  // Automated system mail (spam-quarantine digests, mailer-daemon bounces,
  // no-reply bots) — there is nothing to action or reply to, so it lands in the
  // general bucket, never Claire or a working persona. Ed 2026-07-13 (the
  // AppRiver "Quarantined Message Report" pile-up in Claire's box). NOTE: internal
  // Bedrock staff mail is NOT automated — it still routes to Claire below.
  if (/@appriver\.com|spamlab|mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply/.test(from)
      || /quarantine|quarantined message report/.test(subj)) return 'general';
  // Anything sent straight to Claire's own box is always hers.
  if (mailbox === String(graphSend.CLAIRE_MAILBOX || '').toLowerCase()) return 'claire';
  // Undirected junk that hit the general inbox (info@) — solicitations, marketing,
  // unclassifiable. Its own bucket so it never clutters Claire and never
  // auto-drafts. Real homeowner mail (homeowner_request), legal, and staff
  // (internal) mail still route to Claire.
  if (['spam', 'other'].includes(cls)) return 'general';
  return 'claire';
}

// The roster shown on the board. Tessa is intentionally NOT here — she is Ed's
// owner-only EA on a separate surface (/admin/tessa, ea_inbox), not the shared
// team inbox.
// The email board's columns, DERIVED from the one canonical roster
// (lib/team/roster.js) rather than hand-maintained here. This list used to be
// one of three copies of the team that drifted apart; the copy that fed every
// persona's prompt was missing four people. Adding a teammate is now a single
// entry in the roster and every surface picks them up.
const _roster = require('../team/roster');
const TEAM = _roster.people()
  .filter((m) => m.email_board !== false && !m.owner_only)
  .map((m) => ({ persona: m.persona, name: m.name, title: m.title, mailbox: m.mailbox, emoji: m.emoji }))
  // The unrouted pile is a column on the board but not a teammate, so it comes
  // from the roster separately and always sits last.
  .concat(_roster.ROSTER.filter((m) => m.catch_all).map((m) => ({
    persona: m.persona, name: m.name, title: m.title, mailbox: m.mailbox, emoji: m.emoji, catch_all: true,
  })));

// Tessa is Ed's PRIVATE EA — appended to the roster ONLY for the owner, and her
// card opens her own owner-gated workspace (her forwarded-reply queue, compose,
// and follow-ups all live there). Never shown to staff.
const _tessa = _roster.get('tessa');
const TESSA_CARD = {
  persona: _tessa.persona, name: _tessa.name, title: _tessa.title,
  mailbox: _tessa.mailbox, emoji: _tessa.emoji, owner_only: true, href: _tessa.href,
};

module.exports = { personaForMessage, TEAM, TESSA_CARD };
