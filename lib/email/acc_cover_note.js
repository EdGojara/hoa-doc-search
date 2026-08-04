// ============================================================================
// lib/email/acc_cover_note.js  (Ed 2026-07-25)
// ----------------------------------------------------------------------------
// The EMAIL body for an ACC decision is a short, warm cover note from Annie —
// NOT a restatement of the formal letter. The formal letter (all conditions,
// legal language) is the attached PDF and the sealed record. The email says
// what happened, points to the attachment, and thanks them.
//
// Decision-aware: an APPROVAL doesn't restate conditions (they're in the PDF),
// but REQUEST-MORE-INFO must surface the actual items in the email, because the
// homeowner has to act and may not open the attachment.
//
// Bedrock voice: warm, personal, brief. No em-dashes in customer copy (commas).
// ============================================================================

// Pull the homeowner's first name for a personal greeting. Falls back to a
// friendly generic. Never "Dear Homeowner".
function firstName(homeownerName) {
  const n = String(homeownerName || '').trim();
  if (!n) return null;
  // Skip a leading courtesy title if present (Mr./Ms./Dr.).
  const parts = n.replace(/^(mr|mrs|ms|dr|mx)\.?\s+/i, '').split(/\s+/);
  return parts[0] || null;
}

// Greeting name: when the application is in TWO names ("Simon and Maria Lopez",
// "Michael & Danya Martin", "A + B Smith"), address BOTH first names — a joint
// homeowner shouldn't be greeted as only one of them (Ed 2026-08-03). Single
// name falls back to the first name.
function greetingName(homeownerName) {
  const n = String(homeownerName || '').trim();
  if (!n) return null;
  const stripTitle = (x) => String(x).replace(/^(mr|mrs|ms|dr|mx)\.?\s+/i, '').trim();
  const parts = n.split(/\s+(?:and|&|\+)\s+/i);
  if (parts.length === 2) {
    const a = stripTitle(parts[0]).split(/\s+/)[0];   // first person's first name
    const b = stripTitle(parts[1]).split(/\s+/)[0];   // second person's first name (drops shared surname)
    if (a && b) return `${a} and ${b}`;
  }
  return stripTitle(n).split(/\s+/)[0] || null;
}

// Extract the numbered items from the formal letter body so request-more-info
// can list them in the email. Returns up to `max` short lines, or [] if none.
function extractNumberedItems(letterBody, max = 6) {
  const t = String(letterBody || '');
  const items = [];
  // Match lines like "1. ..." / "2) ..." up to the next number or blank block.
  const re = /^\s*(\d{1,2})[.)]\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(t)) && items.length < max) {
    const line = m[2].replace(/\s+/g, ' ').trim();
    if (line) items.push(line);
  }
  return items;
}

function projectPhrase(projectSummary) {
  let p = String(projectSummary || '').trim();
  // Summaries look like "8x8 storage shed — backyard (wood/shingles)". For prose
  // we want just the head noun ("8x8 storage shed"), then prefix "your".
  p = p.split(/\s[—–-]\s|\(/)[0].replace(/\s+/g, ' ').trim();
  return p ? `your ${p}` : 'your application';
}

// Returns the plain-text cover-note body (buildAnnieEmail turns it into HTML +
// signature). decisionType: approved_no_conditions | approved_with_conditions |
// request_more_info | denied.
function composeAccCoverNote({ decisionType, homeownerName, projectSummary, letterBody }) {
  const fn = greetingName(homeownerName);
  const hi = fn ? `Hi ${fn},` : 'Hi there,';
  const proj = projectPhrase(projectSummary);
  const dt = String(decisionType || '').trim();

  if (dt === 'approved_no_conditions') {
    return [
      hi,
      `Good news, ${proj} has been approved. Thanks for submitting it for review before getting started, that is exactly how it is supposed to work.`,
      `Your approval letter is attached for your records. If you have any questions, just reply to this email or give us a call.`,
    ].join('\n\n');
  }

  if (dt === 'approved_with_conditions') {
    return [
      hi,
      `Good news, ${proj} has been approved, subject to a few conditions. Thanks for going through the process before starting.`,
      `The conditions are part of your approval, so please review the attached letter carefully before you begin. If anything about your plans changes, or if you have any questions, just reply to this email or give us a call.`,
    ].join('\n\n');
  }

  if (dt === 'denied') {
    return [
      hi,
      `Thank you for submitting ${proj} for review. After looking it over, we are not able to approve it as submitted.`,
      `The attached letter explains the specific reason and what a revised application would need. We would genuinely be glad to take another look, so please reply or call us if you would like to talk it through.`,
    ].join('\n\n');
  }

  // request_more_info (default)
  const items = extractNumberedItems(letterBody);
  const needBlock = items.length
    ? `Before we can approve it, we need a few things from you:\n\n${items.map((it, i) => `${i + 1}. ${it}`).join('\n')}`
    : `Before we can approve it, we need a little more information (the specifics are in the attached letter).`;
  return [
    hi,
    `Thanks for submitting ${proj}. We have reviewed it and we are close.`,
    needBlock,
    `The attached letter has the full details. Once you send these over, we will keep your application moving. Just reply to this email or give us a call if anything is unclear.`,
  ].join('\n\n');
}

module.exports = { composeAccCoverNote, extractNumberedItems, firstName, greetingName };
