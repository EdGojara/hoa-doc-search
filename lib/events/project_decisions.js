// ============================================================================
// lib/events/project_decisions.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// "trustEd needs the full picture of what's going on so the AI team can do its
// job." The projects and vendor decisions that actually run a community happen
// in STAFF email (Martha Bravo / mbravo@ the community manager, Celina / cdeleon@,
// and the rest of the team), not in a form — so the structured project tracker
// drifts from reality and the newsletter printed "Board Deciding" for a soccer-
// field irrigation the board had already approved.
//
// This reads the STAFF correspondence that already sits in the archive mailboxes
// (archive1emails@ / archive2@ — everything is BCC'd there by a tenant transport
// rule) and extracts the real project/vendor DECISIONS, each tied to the source
// email. It PROPOSES; a human confirms before anything resident-facing publishes
// (a wrong "Approved" in a newsletter is a real mistake). Same shape as the
// key-events scanner — email in, structured community record out, source cited.
//
// Grounded ONLY in the email text: never invents a project, amount, or approval.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const graphSend = require('./../email/graph_send');

const ARCHIVE_BOXES = ['archive1emails@bedrocktx.com', 'archive2@bedrocktx.com'];
const STAFF_DOMAIN = 'bedrocktx.com';

// The project/decision vocabulary that flags a thread worth reading. Deliberately
// broad on recall (an AI pass filters precision) but skips pure homeowner/AR noise.
const PROJECT_TERMS = [
  'approved the', 'i approved', 'approve the estimate', 'estimate', 'proposal', 'bid',
  'project', 'irrigation', 'field', 'sidewalk', 'lighting', 'repair', 'replacement',
  'install', 'landscaping', 'fence', 'pool', 'gate', 'sign', 'tree removal', 'reserve',
];

async function graphSearch(box, query, top = 25) {
  const token = await graphSend.getToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(box)}/messages`
    + `?$search=${encodeURIComponent(`"${query}"`)}&$top=${top}`
    + `&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
  if (!r.ok) return [];
  const j = await r.json();
  return j.value || [];
}

// Gather candidate staff project threads for a community from the archive.
async function gatherStaffThreads({ communityName, terms = PROJECT_TERMS, perTerm = 8 }) {
  const seen = new Map(); // conversation-ish key -> message
  for (const box of ARCHIVE_BOXES) {
    for (const term of terms) {
      let msgs = [];
      try { msgs = await graphSearch(box, `${term} ${communityName}`, perTerm); } catch (_) {}
      for (const m of msgs) {
        const from = (m.from && m.from.emailAddress && m.from.emailAddress.address || '').toLowerCase();
        const text = `${m.subject || ''} ${m.bodyPreview || ''}`;
        // Community gate: the mail must actually reference this community (archive
        // mail is portfolio-wide and untagged), and a person on our side must be on it.
        if (!new RegExp(communityName.split(/\s+/)[0], 'i').test(text)) continue;
        const key = `${(m.subject || '').replace(/^(re|fw|fwd):\s*/i, '').trim().toLowerCase()}`;
        // Keep the richest copy of a thread (longest body), staff-authored preferred.
        const prev = seen.get(key);
        const bodyLen = (m.body && m.body.content || '').length;
        const staff = from.endsWith('@' + STAFF_DOMAIN);
        if (!prev || bodyLen > (prev._bodyLen || 0) || (staff && !prev._staff)) {
          m._bodyLen = bodyLen; m._staff = staff; seen.set(key, m);
        }
      }
    }
  }
  return [...seen.values()];
}

function plain(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

const DECISION_STATUSES = ['approved', 'declined', 'deferred', 'in_progress', 'completed', 'proposed'];

// AI-extract the concrete project/vendor decisions from the gathered threads.
async function extractDecisions({ communityName, threads }) {
  if (!threads.length) return [];
  const blocks = threads.slice(0, 25).map((m, i) => {
    const from = (m.from && m.from.emailAddress && m.from.emailAddress.address) || '?';
    const body = plain(m.body && m.body.content || m.bodyPreview || '').slice(0, 2500);
    return `[#${i} | ${String(m.receivedDateTime || '').slice(0, 10)} | from: ${from} | subject: ${m.subject || ''}]\n${body}`;
  }).join('\n\n---\n\n');

  const sys = `You extract concrete PROJECT and VENDOR decisions for an HOA community from staff email, so a community's project tracker reflects reality. Return ONLY what the emails actually say — never infer a decision, amount, or approval that is not written.

For each real project/vendor decision you find, return an object:
- project: short name of the work (e.g. "Soccer field irrigation repair", "2026 Christmas lighting", "Main line leak repair")
- status: one of ${DECISION_STATUSES.join(' | ')} (approved = someone with authority approved/authorized it; proposed = an estimate/bid received but not yet approved; in_progress = work underway; completed = done; declined/deferred as stated)
- amount: dollar amount if stated, else null
- vendor: vendor/company name if stated, else null
- decided_by: who approved/decided, by name, if stated (e.g. "Martha Bravo", "board (Vince, Alexis)"), else null
- date: the decision/email date (YYYY-MM-DD) from the source
- source_index: the [#N] index of the email this came from
- quote: a SHORT verbatim snippet (< 20 words) from the email that establishes the decision

Rules: one entry per distinct project (merge a thread's messages). Skip pure homeowner ACC/violation/account matters, invoices with no decision, and generic vendor solicitations. If nothing qualifies, return an empty array. Return STRICT JSON: {"decisions": [...]}. No prose.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 1500, system: sys,
    messages: [{ role: 'user', content: `Community: ${communityName}\n\nEMAILS:\n${blocks}` }],
  });
  let out = { decisions: [] };
  try {
    const t = (resp.content || []).map((c) => c.text || '').join('');
    out = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch (_) {}
  const decisions = (out.decisions || []).filter((d) => d && d.project && DECISION_STATUSES.includes(d.status));
  // Attach the real source email metadata so every decision is verifiable.
  return decisions.map((d) => {
    const src = threads[d.source_index];
    return {
      project: d.project, status: d.status, amount: d.amount || null, vendor: d.vendor || null,
      decided_by: d.decided_by || null, date: d.date || (src && String(src.receivedDateTime || '').slice(0, 10)) || null,
      quote: d.quote || null,
      source: src ? {
        from: (src.from && src.from.emailAddress && src.from.emailAddress.address) || null,
        subject: src.subject || null, received_at: src.receivedDateTime || null, graph_id: src.id || null,
      } : null,
    };
  });
}

async function scanProjectDecisions({ communityName }) {
  const threads = await gatherStaffThreads({ communityName });
  const decisions = await extractDecisions({ communityName, threads });
  return { communityName, scanned: threads.length, decisions };
}

module.exports = { scanProjectDecisions, gatherStaffThreads, extractDecisions, DECISION_STATUSES };
