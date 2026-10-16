// Ed's acceptance criteria for Amanda's reply to Hugh Durlam's "Create RFP" email
// (Canyon Gate, 2026-10-16: "can you scrub the numbers on this proposal and create
// an RFP for me quickly?"). Shared by tests/test_amanda_reply_focus.js and
// scripts/amanda_reply_dry_run.js. Deterministic; returns { ok, results:[{name, ok}] }.
const sentences = (t) => String(t || '').replace(/\r\n/g, '\n').split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
// A question put to Hugh / the Board (not an RFP requirement or a vendor question).
const asks = (t, topic) => sentences(t).some((s) => /\?|\b(?:do you want|would you like|should (?:the|we|i|it)|confirm with you|let me know (?:whether|if|which)|tell me (?:whether|which)|required or optional|(?:be|as|treated as) (?:required|a required [\w ]{0,20}) or optional)\b/i.test(s) && topic.test(s));

const CHECKS = [
  ['greets Hugh by name, not a role label', (t) => /^\s*(?:(?:hi|hello|dear|(?:good )?(?:morning|afternoon|evening)),?\s+)?Hugh\b/i.test(t)],
  ['does not ask whether monitoring (or a maintenance/monitoring plan) should be included', (t) => !asks(t, /\b(?:monitor\w*|maintenance)\b/i)],
  ['does not ask whether she should proceed', (t) => !/\b(?:let me know if you(?:'d| would) like (?:me )?to proceed|would you like me to (?:proceed|go ahead)|do you want me to (?:proceed|go ahead)|(?:shall|should) i (?:proceed|go ahead))\b/i.test(t)],
  ['does not require vendor-list direction before drafting', (t) => !asks(t, /\b(?:vendors?|bidders?|vendor list|bid pool)\b/i) && !/\b(?:once i hear back|before i (?:send|finali[sz]e|draft)[^.?!]{0,80}confirm)\b/i.test(t)],
  ['states she is creating the RFP now', (t) => sentences(t).some((s) => /\bRFP\b/i.test(s)
    && /\b(?:(?:i am|i'm) (?:now )?(?:creating|preparing|drafting|building|putting together|working on|scrubbing|writing)|(?:i have|i've) (?:started|begun)|underway|now)\b/i.test(s)
    && !/\b(?:i can|i could|i will|i'll|once i|after i|when i)\s+(?:\w+\s+){0,2}(?:create|prepare|draft|build|start)\s+(?:the|an|a|that|this)?\s*RFP\b/i.test(s)
    && !/\b(?:not|n't|never)\s+(?:\w+\s+)?(?:building|creating|preparing|drafting|issuing|doing|running)\b|\b(?:issuing|running|building) (?:a|an|the) (?:new|fresh) RFP (?:now )?would\b|\b(?:instead of|rather than) (?:a|an|the) (?:new|fresh) RFP\b/i.test(s))],
  ['does not refuse or replace the requested RFP', (t) => !sentences(t).some((s) => /\bRFP\b|\bbid(?:ding)? cycle\b/i.test(s) && /\b(?:i'?m not|i am not|i won'?t|i will not|not going to|rather than (?:a|an|the) (?:new|fresh)|instead of (?:a|an|the) (?:new|fresh))\b/i.test(s))],
  ['keeps no-monitoring as a hard constraint', (t) => sentences(t).some((s) => /\bmonitor/i.test(s) && /\b(?:explicitly )?exclud\w*|out of scope|decided against|no (?:active |ongoing )?monitoring|not (?:include|including|part of)\b/i.test(s)) || /\b(?:no (?:active |ongoing )?monitoring|without (?:any |active |ongoing )?monitoring|exclud\w* (?:any |active |ongoing )?monitoring|monitoring (?:is|will be) (?:excluded|out of scope|not (?:included|part))|not (?:include|including|requesting|asking for) (?:any |active )?monitoring)\b/i.test(t)],
  ['says the draft comes back for review before it is sent', (t) => /\b(?:for (?:your|the board'?s|board) review|to you (?:and the board )?for review|back to (?:you|the board)[^.?!]{0,80}(?:review|approv|before)|review[^.?!]{0,40}before (?:it|anything|the rfp)|before (?:it|anything|the rfp) (?:goes|is sent|goes out|is issued|it'?s issued)|nothing (?:goes|will go|is sent)(?: out)?(?: to (?:any )?vendors?)? (?:until|before|without))\b/i.test(t)],
  ['does not claim vendor contact that is not happening', (t) => !/\b(?:i am|i'm) (?:now |currently )?(?:confirming|checking|asking|contacting|reaching out to) (?:with )?(?:itech|envera|netwatch|the vendors?|vendors)\b/i.test(t)],
  // Ed's review of #216: choosing bidders is the Board's decision (RFP item B-03).
  ['does not name vendors to invite or commit to inviting / contacting bidders', (t) => !sentences(t).some((s) => /\b(?:invit\w*|re-?bid|solicit\w*|reach(?:ing)? out to|send(?:ing)? (?:the rfp|it) to|request(?:ing)? (?:bids?|quotes?|pricing) from)\b/i.test(s) && !/\bpropos\w* (?:a |the )?(?:bidder|vendor|bid) list\b/i.test(s))],
  ['says a bidder list will be proposed for the Board to confirm', (t) => /\bpropos\w* (?:a |the )?(?:bidder|vendor|bid) list\b[^.?!]{0,80}\b(?:board|you)\b[^.?!]{0,30}\b(?:confirm\w*|approv\w*)/i.test(t)],
  ['does not claim the RFP is finished or sent', (t) => !/\b(?:(?:i have|i've) (?:sent|issued|circulated|finished|finalized|completed) (?:the|it)|the rfp (?:is|has been|went) (?:out|sent|issued|finished|finalized|complete[d]?))\b/i.test(t)],
];

function verifyHughReply(text) {
  const results = CHECKS.map(([name, fn]) => ({ name, ok: !!fn(String(text || '')) }));
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { verifyHughReply, CHECKS };
