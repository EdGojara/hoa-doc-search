// ============================================================================
// lib/ea/tessa_reply_recipients.js — who a reply actually reaches.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "how do i know tessa is replying to all or just sender?"
//
// He could not. The reply screen showed one unlabelled address box, no Cc field,
// and nothing about who was being left out. Underneath, api/tessa.js did:
//
//     const to = parseAddrs(b.to || item.from_email);
//
// Sender only, always. On the Canyon Gate thread — five board aliases plus
// Martha plus Ed — answering director@ alone means four directors and the
// manager never see the answer, and the association's own record of the
// exchange has a hole in it. That is a governance problem, not a UX one.
//
// This module decides the two options and, importantly, is honest about the
// case where it cannot tell.
// ============================================================================

const norm = (s) => String(s || '').trim().toLowerCase();

// Addresses that must never be typed into a reply.
//
// Tessa's own mailbox would loop her queue back on itself: the reply lands in
// tessa@, gets polled, gets drafted, and Ed reviews a reply to a reply he just
// sent. Ed's own address is dropped from To/Cc because he is the one sending —
// mailing himself a copy of his own assistant's reply is noise, and on a thread
// where his address IS the point (someone wrote to him directly) he is already
// the sender being replied to.
function selfAddresses(graphSend) {
  return new Set([
    norm(graphSend.TESSA_MAILBOX),
    norm(graphSend.ED_MAILBOX),
  ].filter(Boolean));
}

// Work out both reply modes for an inbox item.
//
// Returns:
//   {
//     sender:      { to: [addr], cc: [] },
//     all:         { to: [addr...], cc: [addr...] } | null,
//     known:       boolean   — false when the item predates migration 380
//     others:      number    — how many people reply-all reaches beyond the sender
//   }
//
// `known` is the field that matters. Rows polled before the recipient lists were
// stored have NULL, and NULL means "we do not know who else was on this", NOT
// "nobody else was on this". Rendering an empty reply-all for those would be a
// confident lie — the screen must say it cannot tell, and fall back to sender.
function replyOptions(item, graphSend) {
  const self = selfAddresses(graphSend);
  const sender = norm(item.from_email);

  const senderOnly = { to: sender ? [sender] : [], cc: [] };

  // NULL (not [] ) means unknown. An empty array is a real answer: the message
  // genuinely had no other recipients.
  const known = item.to_recipients != null || item.cc_recipients != null;
  if (!known) {
    return { sender: senderOnly, all: null, known: false, others: 0 };
  }

  const rawTo = (item.to_recipients || []).map(norm).filter(Boolean);
  const rawCc = (item.cc_recipients || []).map(norm).filter(Boolean);

  // Reply-all convention: the original sender plus everyone else on To goes on
  // To; the original Cc stays on Cc. Drop our own addresses and de-duplicate,
  // keeping first-seen order so the list reads the way the thread did.
  const seen = new Set();
  const take = (list) => {
    const out = [];
    for (const a of list) {
      if (!a || self.has(a) || seen.has(a)) continue;
      seen.add(a);
      out.push(a);
    }
    return out;
  };

  const to = take([sender, ...rawTo]);
  const cc = take(rawCc);

  // If reply-all reaches nobody the sender would not already get, there is no
  // second option to offer and the UI should not pretend there is.
  const others = (to.length + cc.length) - (to.includes(sender) ? 1 : 0);
  const all = others > 0 ? { to, cc } : null;

  return { sender: senderOnly, all, known: true, others: Math.max(0, others) };
}

// One line describing exactly where a reply will land, for the screen and for
// the confirmation after sending. Never vague: it names addresses or says it
// cannot tell.
function describeRecipients(mode, opts) {
  if (mode === 'all') {
    if (!opts.all) return 'Reply-all is not available on this message.';
    const n = opts.all.to.length + opts.all.cc.length;
    return `Goes to all ${n} on the thread`;
  }
  if (!opts.known) return 'Goes to the sender only (the thread\'s other recipients were not recorded)';
  if (!opts.all) return 'Goes to the sender, who was the only recipient';
  return `Goes to the sender only — ${opts.others} other ${opts.others === 1 ? 'person' : 'people'} on the thread will not see it`;
}

module.exports = { replyOptions, describeRecipients, selfAddresses };
