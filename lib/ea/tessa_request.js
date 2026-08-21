// ============================================================================
// lib/ea/tessa_request.js — one box: tell Tessa what you want done.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "can we maybe add request for tessa somewhere where she can do
// what i ask for example tessa please send email to canyon gate board and ask
// if they want us to set up a follow up virtual meeting with security company
// the one with Grant as the contact" and "she should be able to find the email
// in my inbox or sent item for this when i talk to her, i want her to be really
// a true executive assistant that knows me the best on the team."
//
// The old flow made Ed do the assistant's work: look up the board's addresses,
// paste them into a To field, then describe the message. A real EA is handed
// the sentence and comes back with a draft.
//
// Four steps, in this order, because each one feeds the next:
//   1. PARSE   the sentence into who / what / search terms
//   2. LOOK UP the thread in Ed's own mailbox (inbox AND sent), so the draft
//      references what was actually said rather than a generic ask
//   3. RESOLVE the people, groups included
//   4. DRAFT   grounded in 2, addressed to 3
//
// Nothing is sent and nothing is booked. Ed reviews and clicks.
//
// THE RULE THAT MATTERS: she never invents an address and never quietly drops a
// recipient she could not find. Anything unresolved comes back as a question.
// Ed: "i want the AI team to ask for what they need to do their job."
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { resolveBoardGroup, parseGroupHint } = require('./tessa_resolve');
const { resolveKnownIdentity } = require('./tessa_identity');
const { parseGroupWord, resolveStaffGroup, resolveAiTeamGroup, teamFactsForPrompt } = require('./tessa_groups');
const { draftEmail } = require('./tessa');

const MODEL = 'claude-sonnet-4-5';

const PARSE_PROMPT = `You are the intake step for Ed Gojara's executive assistant at Bedrock
Association Management (an HOA management company in Texas). Ed speaks or types
a single instruction. Turn it into JSON. You are NOT writing the email here.

Return ONLY this JSON, no prose, no code fence:
{
  "action": "email" | "email_and_meeting" | "meeting" | "unclear",
  "to_hints": ["<each recipient exactly as Ed referred to them>"],
  "cc_hints": ["<any he said to copy>"],
  "mention_hints": ["<people referred to in the message but NOT recipients>"],
  "instruction": "<what Ed wants the email to accomplish, one or two sentences>",
  "search_terms": ["<2-4 short phrases to find the relevant thread in Ed's mailbox>"],
  "unclear": ["<anything genuinely ambiguous that a good assistant would ask about>"]
}

Rules:
- Keep the recipient hints in Ed's own words. "canyon gate board" stays
  "canyon gate board". Do not guess an email address, ever.
- A person described by role and company ("the security company, the one with
  Grant") goes in mention_hints if the email is ABOUT them, or to_hints if the
  email is TO them. Read the sentence carefully; getting this backwards sends
  association business to the vendor.
- search_terms are for finding the existing thread. Use distinctive nouns from
  the request (company names, community names, the subject matter). Do not
  include generic words like "email", "meeting", "follow up".
- Put something in "unclear" ONLY if you genuinely cannot proceed. A slightly
  loose instruction is normal and is not unclear.`;

async function parseRequest(text) {
  const completion = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 900,
    system: PARSE_PROMPT,
    messages: [{ role: 'user', content: String(text).trim() }],
  });
  const raw = completion.content?.[0]?.text || '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const p = JSON.parse(cleaned);
    return {
      action: p.action || 'email',
      to_hints: Array.isArray(p.to_hints) ? p.to_hints.filter(Boolean) : [],
      cc_hints: Array.isArray(p.cc_hints) ? p.cc_hints.filter(Boolean) : [],
      mention_hints: Array.isArray(p.mention_hints) ? p.mention_hints.filter(Boolean) : [],
      instruction: p.instruction || String(text).trim(),
      search_terms: Array.isArray(p.search_terms) ? p.search_terms.filter(Boolean).slice(0, 4) : [],
      unclear: Array.isArray(p.unclear) ? p.unclear.filter(Boolean) : [],
    };
  } catch (e) {
    return { degraded: true, error: e.message, raw: cleaned.slice(0, 400) };
  }
}

// Search Ed's own mailbox for the thread this request is about.
//
// Reads live and stores nothing. Tessa is owner-only, so pulling Ed's
// correspondence into the shared email_messages table (which every staff
// surface reads) would break that; the search happens at request time and the
// result lives only in this response.
async function findContext(searchTerms, { searchMailbox, mailboxes, perTerm = 8 }) {
  const byThread = new Map();
  const errors = [];
  for (const term of searchTerms) {
    for (const mb of mailboxes) {
      if (!mb) continue;
      try {
        // 1200 chars, not the 300-char default: the draft is grounded in these,
        // and a teaser that stops mid-sentence grounds nothing.
        const r = await searchMailbox(mb, term, { top: perTerm, previewChars: 1200 });
        for (const m of (r.messages || [])) {
          // SCAR: these were read as m.receivedDateTime / m.conversationId /
          // m.bodyPreview — the RAW Graph names. searchMailbox already maps them
          // to received_at / conversation_id / preview, so every field came back
          // undefined: previews were empty strings, the recency sort was a no-op
          // on all-null dates, and dedup fell back to message id so one thread
          // could fill the whole list. The draft looked fine because the contact
          // book supplied the names, which is exactly how a silent context
          // failure hides. (Found 2026-08-21.)
          const key = m.conversation_id || m.id;
          if (!key) continue;
          const prev = byThread.get(key);
          if (prev) { prev.terms.add(term); continue; }
          byThread.set(key, {
            subject: m.subject || '(no subject)',
            from: (m.from && (m.from.name || m.from.email)) || null,
            from_email: (m.from && m.from.email) || null,
            received: m.received_at || null,
            preview: m.preview || '',
            mailbox: mb,
            terms: new Set([term]),
          });
        }
      } catch (e) {
        // A blocked mailbox is a configuration answer, not "no results". Surface
        // it rather than letting an empty context read as "nothing on file".
        errors.push({ mailbox: mb, term, error: String(e.message).slice(0, 160) });
      }
    }
  }

  // Rank by how many DISTINCT search terms a thread matched, then recency.
  //
  // Without this, one broad term ("Canyon Gate") floods the list with budget and
  // ACC mail while the thread that matched three terms — the one Ed is actually
  // talking about — never makes the cut.
  const threads = [...byThread.values()]
    .map((t) => ({ ...t, hits: t.terms.size, matched: [...t.terms] }))
    .sort((a, b) => (b.hits - a.hits)
      || String(b.received || '').localeCompare(String(a.received || '')))
    .slice(0, 6)
    .map(({ terms, ...rest }) => rest);

  return { threads, errors };
}

// Who do we ACTUALLY deal with at this company?
//
// Ed 2026-08-21: "yeah maybe not grant, need to find who have been
// communicating with at that company." He was right to doubt it. The address
// book had two people at United Protective and the parse picked the one Ed
// happened to name from memory; the mail showed Haley Bellanger wrote more
// recently and more often than Grant.
//
// So a company reference is answered from correspondence, not from whichever
// name surfaced first. Ranking is: how recently they were in a thread, then how
// many messages they are in. Both people come back with the evidence attached —
// she leads with the likeliest and shows the alternative rather than silently
// choosing, because "who is our contact there" is a question Ed can answer in
// one glance and a wrong guess emails the wrong person at a vendor.
async function rankByCorrespondence(people, { searchMailbox, mailboxes, terms }) {
  if (!people.length || !searchMailbox || !mailboxes || !mailboxes.length) return people;
  const wanted = new Map();
  for (const p of people) {
    if (p.email) wanted.set(p.email.toLowerCase(), { ...p, wrote: 0, addressed: 0, last: null });
  }
  if (!wanted.size) return people;

  for (const term of terms) {
    for (const mb of mailboxes) {
      if (!mb) continue;
      try {
        const r = await searchMailbox(mb, term, { top: 25 });
        for (const m of (r.messages || [])) {
          const parties = [m.from, ...(m.to || []), ...(m.cc || [])].filter(Boolean);
          for (const party of parties) {
            const k = String(party.email || '').toLowerCase();
            const hit = wanted.get(k);
            if (!hit) continue;
            if (m.from && String(m.from.email || '').toLowerCase() === k) hit.wrote++;
            else hit.addressed++;
            if (!hit.last || String(m.received_at || '') > hit.last) hit.last = m.received_at || null;
          }
        }
      } catch (_) { /* a blocked mailbox just means no evidence from it */ }
    }
  }

  const ranked = [...wanted.values()].sort((a, b) => {
    // Someone who WROTE to us is a live contact; being cc'd is weaker evidence.
    const seen = (x) => (x.wrote * 2) + x.addressed;
    return String(b.last || '').localeCompare(String(a.last || '')) || (seen(b) - seen(a));
  });
  // No evidence either way? Leave the original order rather than inventing one.
  if (!ranked.some((x) => x.wrote || x.addressed)) return people;
  return ranked;
}

// Resolve one hint to addressees. Groups first (a board is not one person),
// then the individual resolver the caller supplies.
async function resolveOne(hint, resolveRecipient, mailCtx = null) {
  // The people she should never have to look up: Ed himself, first-person
  // references to him, and the AI team.
  //
  // Ed 2026-08-21: "tessa is having a hard time understanding me, she doesn't
  // know who Ed is." He asked her to copy "ed and martha" and she came back
  // asking which of five people he meant. This runs first because it is both
  // the cheapest check and the most certain answer — no search, no ambiguity,
  // no question.
  const known = resolveKnownIdentity(hint);
  if (known) {
    return { hint, kind: 'person', people: [known], question: null, picked_by: 'known_identity' };
  }

  // A word that names a GROUP must never resolve to an individual.
  //
  // Ed 2026-08-21: "this is totally wrong." He asked her to "send email to
  // staff to introduce them to ai team" and she addressed it to Stafford Beck
  // at vantaca.com — "staff" was the only ILIKE %staff% match in the book, a
  // single match auto-fills the To field, and an internal note about our own
  // team was one click from a Vantaca employee.
  //
  // This runs BEFORE any person search, and it never falls through to one. If
  // the group cannot be resolved she asks: "who do you mean by staff" costs a
  // sentence, mailing the wrong company costs a great deal more.
  const groupWord = parseGroupWord(hint);
  if (groupWord) {
    if (groupWord.kind === 'ai_team') {
      const t = resolveAiTeamGroup();
      return { hint, kind: 'group', group: 'ai_team', people: t.people, question: t.people.length ? null : 'I could not load the AI team roster.' };
    }
    const s = await resolveStaffGroup();
    if (s.people && s.people.length) {
      return { hint, kind: 'group', group: 'staff', people: s.people, question: null };
    }
    return {
      hint, kind: 'group', group: 'staff', people: [],
      question: `I could not work out who "${hint}" means. Name the people and I'll send it.`,
    };
  }

  if (parseGroupHint(hint)) {
    const g = await resolveBoardGroup(hint);
    if (g.ok) {
      return {
        hint, kind: 'group', community: g.community ? g.community.name : null,
        people: g.people, question: null,
      };
    }
    return {
      hint, kind: 'group', people: [],
      question: g.detail || `I could not work out who "${hint}" is.`,
      reason: g.reason,
      options: (g.ambiguous || []).map((c) => c.name),
    };
  }
  const r = await resolveRecipient(hint);
  if (r && r.best) {
    return {
      hint, kind: 'person',
      people: [{ name: r.best.name, email: r.best.email, position: r.best.role || null, source: r.best.source }],
      question: null,
    };
  }
  let matches = (r && r.matches) || [];

  // Several people matched. If they are at the same company, the mail decides
  // who we actually deal with there — see rankByCorrespondence above.
  if (matches.length > 1 && mailCtx) {
    const ranked = await rankByCorrespondence(
      matches.map((c) => ({ name: c.name, email: c.email, position: c.role || null, org: c.org || null, source: c.source })),
      { ...mailCtx, terms: [hint, ...(mailCtx.terms || [])].slice(0, 3) }
    );
    if (ranked.length && (ranked[0].wrote || ranked[0].addressed)) {
      const [top, ...rest] = ranked;
      return {
        hint, kind: 'person', people: [top],
        question: null,
        picked_by: 'correspondence',
        evidence: `${top.name} is who we have been dealing with${top.last ? ' (last on the thread ' + String(top.last).slice(0, 10) + ')' : ''}.`,
        alternates: rest.filter((x) => x.wrote || x.addressed).map((x) => ({
          name: x.name, email: x.email,
          note: `${x.wrote} sent, ${x.addressed} copied${x.last ? ', last ' + String(x.last).slice(0, 10) : ''}`,
        })),
      };
    }
    matches = ranked.length ? ranked : matches;
  }

  return {
    hint, kind: 'person', people: [],
    question: matches.length
      ? `Which one did you mean by "${hint}"?`
      : `I do not have anyone on file for "${hint}".`,
    options: matches.map((c) => `${c.name}${c.org ? ' at ' + c.org : ''} <${c.email}>`),
    reason: matches.length ? 'ambiguous' : 'not_found',
  };
}

function contextBlock(threads) {
  if (!threads.length) return '';
  return '\n\nRelevant messages already in Ed\'s mailbox (most recent first). Use these '
    + 'for facts, names and where things stand. Do NOT quote them verbatim and do not '
    + 'invent anything that is not here:\n'
    + threads.map((t, i) => `${i + 1}. [${(t.received || '').slice(0, 10)}] "${t.subject}"`
      + `${t.from ? ' from ' + t.from : ''}\n   ${t.preview}`).join('\n');
}

// The whole flow.
async function runRequest(text, { resolveRecipient, searchMailbox, mailboxes }) {
  const parsed = await parseRequest(text);
  if (parsed.degraded) return { degraded: true, error: parsed.error };

  const mailCtx = { searchMailbox, mailboxes, terms: parsed.search_terms };

  const [toResolved, ccResolved, mentionResolved, ctx] = await Promise.all([
    Promise.all(parsed.to_hints.map((h) => resolveOne(h, resolveRecipient, mailCtx))),
    Promise.all(parsed.cc_hints.map((h) => resolveOne(h, resolveRecipient, mailCtx))),
    Promise.all(parsed.mention_hints.map((h) => resolveOne(h, resolveRecipient, mailCtx))),
    findContext(parsed.search_terms, { searchMailbox, mailboxes }),
  ]);

  // Every hint she could not pin down becomes a question. She does not silently
  // drop a recipient and send to whoever is left.
  const questions = [];
  for (const r of [...toResolved, ...ccResolved]) {
    if (r.question) questions.push({ about: r.hint, ask: r.question, options: r.options || [] });
  }
  for (const u of parsed.unclear) questions.push({ about: null, ask: u, options: [] });

  const to = toResolved.flatMap((r) => r.people);
  const cc = ccResolved.flatMap((r) => r.people);

  // Who the email is ABOUT, so the draft names Grant correctly instead of
  // writing "the security company representative".
  const mentions = mentionResolved.flatMap((r) => r.people.map((p) => ({
    ...p, hint: r.hint, evidence: r.evidence || null, alternates: r.alternates || [],
  })));

  let draft = null;
  if (to.length) {
    const audience = toResolved.map((r) => (r.kind === 'group'
      ? `the ${r.community || ''} board (${r.people.length} people)`.trim()
      : r.people.map((p) => p.name).join(', '))).filter(Boolean).join('; ');
    const mentionLine = mentions.length
      ? '\n\nPeople this email is about (use their real names and companies): '
        + mentions.map((m) => `${m.name}${m.position ? ', ' + m.position : ''}`
          + `${m.email ? ' <' + m.email + '>' : ''}`).join('; ')
      : '';
    // When the email is ABOUT the AI team, hand her the roster.
    //
    // Ed 2026-08-21, asked for an introduction to the AI team, got: "Kat Reed
    // works with board members, helping them stay informed and engaged" — Kat is
    // the ACCOUNTING MANAGER — and an introduction to "Daniel Ibarra", who does
    // not exist. Claire, Emma, Annie, Miranda, Amanda, Reese and Paige were left
    // out entirely.
    //
    // She invented her own colleagues because nothing put the roster in front of
    // her. lib/team/roster.js is the source of truth for who works here and what
    // they do, and this is what actually shows it to her. Same shape as every
    // other bug today: the data existed and nothing read it.
    const aboutTheTeam = /\b(ai\s+team|the\s+team|each\s+of\s+you|who\s+(?:you|we)\s+are|introduce\s+(?:them|everyone|the\s+team))\b/i
      .test(`${parsed.instruction} ${String(text || '')}`);
    const teamBlock = aboutTheTeam ? `\n\n${teamFactsForPrompt()}` : '';

    const thought = `${parsed.instruction}\n\nThis email goes to: ${audience}.`
      + mentionLine + teamBlock + contextBlock(ctx.threads);
    const d = await draftEmail({
      thought,
      recipientName: toResolved[0] && toResolved[0].kind === 'group'
        ? `the ${toResolved[0].community || ''} board`.trim()
        : (to[0] && to[0].name) || null,
      onEdsBehalf: true,
    });
    if (!d.degraded) draft = { subject: d.subject, body: d.body };
  }

  return {
    parsed, to, cc, mentions, questions, draft,
    resolved: { to: toResolved, cc: ccResolved, mentions: mentionResolved },
    context: ctx.threads,
    context_errors: ctx.errors,
    wants_meeting: parsed.action === 'email_and_meeting' || parsed.action === 'meeting',
  };
}

module.exports = { runRequest, parseRequest, findContext, resolveOne };
