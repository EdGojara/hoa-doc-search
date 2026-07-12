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
  if (mailbox === String(graphSend.MIRANDA_MAILBOX || '').toLowerCase()) return 'miranda';
  if (ex.drv && ex.drv.persona === 'miranda') return 'miranda';
  if (mailbox === String(graphSend.ANNIE_MAILBOX || '').toLowerCase()) return 'annie';
  if (cls === 'acc_request') return 'annie';
  if (mailbox === String(graphSend.EMMA_MAILBOX || '').toLowerCase()) return 'emma';
  if (m.resolved_vendor_id) return 'emma';
  if (['vendor_financial', 'vendor_general'].includes(cls)) return 'emma';
  return 'claire';
}

// The roster shown on the board. Tessa is intentionally NOT here — she is Ed's
// owner-only EA on a separate surface (/admin/tessa, ea_inbox), not the shared
// team inbox.
const TEAM = [
  { persona: 'claire',  name: 'Claire',         title: 'Front office',        mailbox: 'info@ / claire@', emoji: '💬' },
  { persona: 'emma',    name: 'Emma Brooks',    title: 'Accounts payable',    mailbox: 'emma@',           emoji: '🧾' },
  { persona: 'annie',   name: 'Annie Reeves',   title: 'ACC / ARC',           mailbox: 'annie@',          emoji: '🏗️' },
  { persona: 'miranda', name: 'Miranda Pierce', title: 'Compliance / DRV',    mailbox: 'miranda@',        emoji: '📋' },
];

module.exports = { personaForMessage, TEAM };
