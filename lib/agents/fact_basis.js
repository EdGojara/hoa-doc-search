// ============================================================================
// lib/agents/fact_basis.js — investigate first, then write (Ed 2026-10-14)
// ----------------------------------------------------------------------------
// Every AI-team draft that asks someone outside for information is built on a
// FACT BASIS assembled from trustEd's own records before a word is written:
//   observed     what the records show, each with its source ("NewFirst notice of
//                10/13/2026 lists the address; the 10/9 notice does not");
//   conclusions  what we infer from those facts, labeled as our assessment
//                ("we do not recognize the address as an authorized contact");
//   unknown      what only the recipient can tell us: the ONLY things the
//                correspondence asks.
// Never ask someone for a fact we already hold; never present a conclusion as
// an observation. The basis is shown to the reviewer beside the draft, so the
// person approving can see what was checked and where each statement came from.
// Shape is plain data so any agent (Kat, Amanda, Emma...) can produce it.
// ============================================================================

function basis({ observed = [], conclusions = [], unknown = [] } = {}) {
  const clean = (xs) => xs.filter((x) => x && (x.fact || x.text)).map((x) => ({ text: String(x.fact || x.text), source: x.source ? String(x.source) : null }));
  return { observed: clean(observed), conclusions: clean(conclusions), unknown: clean(unknown) };
}

// Prompt block for a model-written draft: the facts it may state, how to state them, and the
// only questions it may ask.
function promptBlock(b) {
  if (!b || (!b.observed.length && !b.conclusions.length && !b.unknown.length)) return '';
  const list = (xs) => xs.map((x) => `- ${x.text}${x.source ? ` [source: ${x.source}]` : ''}`).join('\n');
  return `\nFACT BASIS (assembled from our records before drafting; ground the reply in it):
${b.observed.length ? `OBSERVED in our records (state these plainly as what our records show; do not soften them into questions):\n${list(b.observed)}\n` : ''}${b.conclusions.length ? `OUR CONCLUSIONS (present these as our assessment, e.g. "we do not recognize", never as established fact):\n${list(b.conclusions)}\n` : ''}${b.unknown.length ? `STILL UNKNOWN (ask ONLY these; never ask the recipient for anything listed above as observed):\n${list(b.unknown)}\n` : ''}`;
}

// Reviewer-facing text beside the draft.
function reviewText(b) {
  if (!b) return '';
  const part = (h, xs) => (xs.length ? `${h}: ${xs.map((x) => `${x.text}${x.source ? ` (${x.source})` : ''}`).join('; ')}.` : '');
  return [part('Observed', b.observed), part('Concluded', b.conclusions), part('Asked', b.unknown)].filter(Boolean).join(' ');
}

module.exports = { basis, promptBlock, reviewText };
