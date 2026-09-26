#!/usr/bin/env node
// academy/tools/full_report.js
// ----------------------------------------------------------------------------
// Full, unsummarized evaluation report for human review:
//   node academy/tools/full_report.js academy/reports/sample-baseline.json [out.md]
//
// Per case: case summary, EVERY raw Amanda response (verbatim, never
// summarized), each dimension with the Claude judge and the GPT judge side by
// side (verdict, reasoning, evidence, expected), cross-run differences,
// critical-failure flags with provenance, and PRODUCTION-PROMPT FINDINGS:
// behavior that appears to be driven by the live system prompt itself.
// Prompt findings are heuristics for review, not verdicts. The production
// prompt is never changed by this tool.
// ----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { wordCount } = require('../lib/critical');

const casesDir = path.join(__dirname, '..', 'cases');
const CASES = Object.fromEntries(fs.readdirSync(casesDir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.json'))
  .flatMap((d) => JSON.parse(fs.readFileSync(path.join(casesDir, d.name), 'utf8'))).map((c) => [c.case_id, c]));
// Team cases (wrapped in { cases }) use must / must_not keys; map them onto the
// fields this report reads so their replies and judge reasoning render too.
const teamDir = path.join(__dirname, '..', 'team', 'cases');
if (fs.existsSync(teamDir)) {
  for (const f of fs.readdirSync(teamDir).filter((x) => x.endsWith('.json'))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(teamDir, f), 'utf8')).cases || []) {
      CASES[c.case_id] = { domain: ['judgment', 'execution', 'relationship'], ...c, answer_key: { facts: c.answer_key.must || [], unknowns: [], hidden_traps: c.answer_key.must_not || [], expected_communication: { tone: 'see routing', must: c.answer_key.must, must_not: c.answer_key.must_not }, expected_next_action: { action: `${c.expected_routing.mode} (${c.expected_routing.owner_class.join(', ')})`, owner: c.expected_routing.owner }, ...c.answer_key } };
    }
  }
}

const DIMS = ['expertise', 'judgment', 'relationship', 'execution'];
const LENGTH_WORDS = { 'one line': 25, short: 90, 'short to medium': 160, medium: 220, detailed: 600 };

// Prompt text each finding traces back to (quoted from lib/community/amanda_reply.js).
const SRC = {
  options: 'AMANDA_BOARD_SYSTEM: "give 2 to 3 clear options with the tradeoffs, and state YOUR recommendation" (applies to every board message, including status questions)',
  numbered: 'All Amanda prompts: "if you list options, use short numbered lines" / board: "put each option on its own short numbered line"',
  recommendation: 'AMANDA_BOARD_SYSTEM: "state YOUR recommendation. The board decides, often by a vote."',
  emailFrame: 'All Amanda prompts: "Write the FULL message body only, greeting through sign-off" (email-drafting frame; no chat/voice variant exists)',
  empathy: 'AMANDA_SYSTEM fallback + escalation framing ("warm but direct"); no rule against stock empathy in the Amanda prompts (the TONE_CASUAL_ADDENDUM ban list is not applied on this path)',
  length: 'Email frame + FINANCE_PRIMER (~5k chars) + options/recommendation structure push toward long replies; no length-matching instruction',
  formal: 'Board prompt: "concise, professional, decision-oriented"; email frame; no instruction to match the person\'s register',
  boilerplate: 'GROUNDING: "If it is not there, say you will confirm and follow up"; NO_OVERPROMISE_RULE; "When you cannot fully resolve the matter now, give ONE clear next step and a timeline"',
};

const EMPATHY_RE = /\b(i (completely |totally |truly )?understand (your|how|the) (frustrat|concern|how)|i('m| am) (so |really |truly )?sorry (for|about|that|to hear)|i apologi[sz]e|thank you for (reaching out|your patience|bringing this|letting me know|flagging)|i hear you|that must be (frustrating|difficult)|rest assured|we value|i appreciate your (patience|understanding))\b/gi;
const BOILERPLATE_RE = /\b(i('ll| will) (confirm|follow up|get back to you|circle back|keep you (posted|updated))|let me know if you have any (other |further )?questions|please don'?t hesitate|feel free to reach out|happy to help|i('ll| will) stay on (this|top of this))\b/gi;
const FORMAL_RE = /\b(please be advised|kindly|pursuant to|herein|aforementioned|at your earliest convenience|we wish to inform|per our (records|conversation)|i am writing to)\b/gi;

function uniq(a) { return [...new Set(a.map((x) => x.trim().toLowerCase()))]; }

function promptFindings(c, msg) {
  const out = [];
  const words = wordCount(msg);
  const numbered = (msg.match(/(^|\n)\s*\d[.)]\s+\S/g) || []).length;
  const exp = c.answer_key.expected_communication || {};
  const lenKey = String(exp.length || '').toLowerCase();
  const budget = exp.max_words || LENGTH_WORDS[lenKey] || null;
  const conversational = ['chat', 'phone'].includes(c.channel);
  const asksDecision = /\b(should (we|i)|can (we|the board)|decide|approve|vote|go ahead|sign|which option|what do you recommend)\b/i.test(c.incoming_message.text);
  const shortWanted = /one line|short/.test(lenKey) && !/medium/.test(lenKey);

  if (numbered >= 2 && (shortWanted || conversational)) out.push({ flag: 'unnecessary_numbered_list', evidence: `${numbered} numbered lines in a ${c.channel} reply expected to be ${exp.length}`, source: SRC.numbered });
  if (c.audience === 'board' && !asksDecision && (numbered >= 2 || /\b(option (1|2|one|two|a|b)|options? (are|include)|two (paths|ways|options)|tradeoff)/i.test(msg))) out.push({ flag: 'forced_options_no_decision_needed', evidence: 'lays out options/tradeoffs although the person asked for information or status, not a decision', source: SRC.options });
  const recs = (msg.match(/\b(recommend(ation|ed|s)?|i'?d suggest|my suggestion)\b/gi) || []).length;
  if (recs >= 2 || (recs >= 1 && !asksDecision && c.audience === 'board')) out.push({ flag: 'recommendation_language_overuse', evidence: `${recs} "recommend…" mention(s)${asksDecision ? '' : ' with no decision asked'}`, source: SRC.recommendation });
  const greet = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^\n]{0,40}[,!]?\s*\n/i.test(msg.trim());
  const signoff = /\n\s*(best|thanks|thank you|regards|warm regards|kind regards|sincerely|cheers|talk soon)[,!.]?\s*(\n[^\n]{0,40})?\s*$/i.test(msg.trim());
  if (conversational && (greet || signoff)) out.push({ flag: 'email_format_in_chat', evidence: `${greet ? 'greeting line' : ''}${greet && signoff ? ' + ' : ''}${signoff ? 'sign-off' : ''} in a ${c.channel} reply`, source: SRC.emailFrame });
  const emp = uniq(msg.match(EMPATHY_RE) || []);
  if (emp.length) out.push({ flag: 'canned_empathy', evidence: emp.join(' | '), source: SRC.empathy });
  if (budget && words > budget * 1.5) out.push({ flag: 'excessive_verbosity', evidence: `${words} words vs about ${budget} expected (${exp.length || 'max_words'})`, source: SRC.length });
  const formal = uniq(msg.match(FORMAL_RE) || []);
  const casualIn = /\b(hey|lol|haha|😅|quick q|whatever happened|y\/n)\b/i.test(c.incoming_message.text) || c.incoming_message.text === c.incoming_message.text.toLowerCase();
  if (formal.length || (casualIn && (greet && signoff))) out.push({ flag: 'overly_formal_tone', evidence: formal.length ? formal.join(' | ') : 'formal letter structure in reply to a casual message', source: SRC.formal });
  const bp = uniq(msg.match(BOILERPLATE_RE) || []);
  if (bp.length >= 2 || (bp.length && !(c.answer_key.unknowns || []).length)) out.push({ flag: 'repetitive_boilerplate', evidence: bp.join(' | '), source: SRC.boilerplate });
  return out;
}

const judgeName = (j) => (/openai|gpt/i.test(j) ? 'GPT judge' : /anthropic|claude/i.test(j) ? 'Claude judge' : j);
const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');

function render(report) {
  const L = [];
  L.push('# Amanda Academy: full sample evaluation (baseline)', '');
  L.push(`Run ${report.at} | mode **${report.mode}** (live production prompt, unmodified) | Amanda \`${report.amanda}\` | judges ${report.judges.map((j) => '`' + j + '`').join(' + ')} | ${report.runs} run(s) per case | live prompt fingerprint \`${report.live_prompt_fingerprint}\``, '');
  L.push('Verdicts are pass / needs_review / fail per dimension and are never averaged; a split between judges is needs_review. **Amanda\'s wording below is verbatim.** Production-prompt findings are heuristics tied to the prompt text that drives them; they are for review, not verdicts.', '');

  const index = [];
  L.push('## Summary', '', `| Case | ${DIMS.join(' | ')} | Critical failures | Prompt findings |`, `|---|${DIMS.map(() => '---').join('|')}|---|---|`);
  for (const r of report.results) {
    const c = CASES[r.case_id];
    const runs = r.runs.filter((x) => x.dimensions);
    const cell = (d) => runs.map((x) => x.dimensions[d].verdict + (x.dimensions[d].agreement === 'disagree' ? '*' : '')).join(' / ') || 'error';
    const crit = [...new Set(runs.flatMap((x) => x.critical_failures.map((f) => `${f.code} (${f.status})`)))].join('; ') || 'none';
    const pf = [...new Set(runs.flatMap((x) => promptFindings(c, x.message).map((e) => e.flag)))].join(', ') || 'none';
    L.push(`| ${r.case_id} ${esc(r.title)} | ${DIMS.map(cell).join(' | ')} | ${crit} | ${pf} |`);
  }
  L.push('', 'Cells list run 1 / run 2. `*` = the two judges split on that run (merged to needs_review).', '');

  for (const r of report.results) {
    const c = CASES[r.case_id];
    const k = c.answer_key;
    L.push('---', '', `## ${r.case_id} v${r.version}: ${r.title}`, '');
    L.push(`**Audience** ${c.audience} | **channel** ${c.channel} | **tests** ${c.domain.join(', ')}`, '');
    L.push(`**Scenario (evaluator view):** ${c.scenario}`, '');
    if ((c.conversation_history || []).length) L.push('**History Amanda had:**', ...c.conversation_history.map((h) => `> [${h.at}] ${h.from}: ${h.text}`), '');
    L.push(`**Message from ${c.incoming_message.from}:**`, `> ${c.incoming_message.text.replace(/\n/g, '\n> ')}`, '');
    L.push('**Context Amanda was given:**', ...c.available_context.map((f) => `- [${f.kind}] ${f.text} _(${f.source})_`), '');
    L.push('**What an excellent reply does (answer key, hidden from Amanda):**');
    L.push(`- Tone and length: ${k.expected_communication.tone}; ${k.expected_communication.length || ''}${k.expected_communication.max_words ? ` (max ~${k.expected_communication.max_words} words)` : ''}`);
    L.push(`- Must: ${(k.expected_communication.must || []).join('; ') || 'n/a'} | Must not: ${(k.expected_communication.must_not || []).join('; ') || 'n/a'}`);
    L.push(`- Next action: ${k.expected_next_action.action} (owner: ${k.expected_next_action.owner})`);
    L.push(`- Unknowns she must not fill: ${(k.unknowns || []).map((u) => (typeof u === 'string' ? u : u.text)).join('; ') || 'none'}`);
    L.push(`- Traps: ${k.hidden_traps.join('; ')}`, '');

    for (const run of r.runs) {
      L.push(`### Run ${run.run}`, '');
      if (run.error) { L.push(`Amanda call failed: ${run.error}`, ''); continue; }
      L.push(`**Amanda's raw response** (${wordCount(run.message)} words, verbatim):`, '', '```text', run.message, '```', '');
      if (run.internal) L.push('<details><summary>Internal contract</summary>', '', '```json', JSON.stringify(run.internal, null, 2), '```', '</details>', '');
      if (run.guard) {
        const g = run.guard;
        L.push(`**Classified intent:** ${g.intent ? `${g.intent.mode}${g.intent.underlying_mode !== g.intent.mode ? ` (over ${g.intent.underlying_mode})` : ''}, confidence ${g.intent.confidence}, signals ${g.intent.signals.join(', ') || 'none'}` : 'n/a'}`, '');
        if (g.first_violations && g.first_violations.length) {
          L.push(`**Integrity guard fired on the first draft** (${g.first_violations.length}): ${g.first_violations.map((v) => `${v.rule}: "${esc(v.sentence)}"`).join(' | ')}`, '');
          if (g.first_draft) L.push('<details><summary>First draft (before the guard-requested revision), verbatim</summary>', '', '```text', g.first_draft, '```', '</details>', '');
          L.push(`**After one revision:** ${g.final_violations && g.final_violations.length ? g.final_violations.map((v) => `${v.rule} still present: "${esc(v.sentence)}"`).join(' | ') : 'clean'}`, '');
        } else L.push('**Integrity guard:** clean on the first draft', '');
      }
      const judgeErrs = run.judge_errors || (run.judges || []).filter((j) => j && j.error);
      if (judgeErrs.length) L.push(`**Judge errors:** ${judgeErrs.map((j) => `${judgeName(j.judge)}: ${esc(j.error)}`).join(' | ')} (the remaining judge's verdict stands as single_judge)`, '');
      for (const d of DIMS) {
        const dm = run.dimensions[d];
        L.push(`**${d}: ${dm.verdict}**${dm.agreement === 'disagree' ? ' (judges split)' : dm.agreement === 'single_judge' ? ' (single judge)' : ''}`);
        for (const [j, v] of Object.entries(dm.by_judge || {})) {
          L.push(`- ${judgeName(j)}: **${v.verdict}**. ${esc(v.explanation)}`);
          if (v.evidence) L.push(`  - Evidence: "${esc(v.evidence)}"`);
          if (v.expected) L.push(`  - Expected: ${esc(v.expected)}`);
        }
        L.push('');
      }
      if (run.critical_failures.length) {
        L.push('**Critical-failure flags:**');
        for (const f of run.critical_failures) L.push(`- ${f.code} (**${f.status}**): ${f.flags.map((x) => `${judgeName(x.judge)}: "${esc(x.evidence)}"${x.why ? `. ${esc(x.why)}` : ''}`).join(' || ')}`);
        L.push('');
      } else L.push('**Critical-failure flags:** none', '');
      const sig = (run.detectors && run.detectors.signals) || [];
      if (sig.length) L.push(`**Detector signals:** ${sig.map((s) => `${s.code} [${s.hits.map(esc).join(' | ')}]`).join('; ')}`, '');
      const pf = promptFindings(c, run.message);
      if (pf.length) {
        L.push('**Production-prompt findings (baseline, prompt not changed):**');
        for (const e of pf) { L.push(`- **${e.flag}**: ${esc(e.evidence)}. Driven by: ${e.source}`); index.push({ case_id: r.case_id, run: run.run, ...e }); }
        L.push('');
      }
    }

    const ok = r.runs.filter((x) => x.dimensions);
    if (ok.length > 1) {
      L.push('### Cross-run differences', '');
      for (const d of DIMS) { const vs = ok.map((x) => x.dimensions[d].verdict); L.push(`- ${d}: ${vs.join(' vs ')}${vs.every((v) => v === vs[0]) ? ' (consistent)' : ' **(INCONSISTENT)**'}`); }
      L.push(`- length: ${ok.map((x) => wordCount(x.message)).join(' vs ')} words`);
      const cs = ok.map((x) => x.critical_failures.map((f) => f.code).sort().join(',') || 'none');
      L.push(`- critical flags: ${cs.join(' vs ')}${cs.every((v) => v === cs[0]) ? ' (consistent)' : ' **(INCONSISTENT)**'}`);
      const pfs = ok.map((x) => promptFindings(c, x.message).map((e) => e.flag).sort().join(',') || 'none');
      L.push(`- prompt findings: ${pfs.join(' vs ')}`, '');
    }
  }

  L.push('---', '', '## Production-prompt findings across all runs (baseline; prompt not changed)', '');
  if (!index.length) L.push('No prompt-driven findings detected by the heuristics.');
  else {
    const by = {};
    for (const e of index) (by[e.flag] = by[e.flag] || []).push(e);
    L.push('| Finding | Runs | Cases | Prompt source |', '|---|---|---|---|');
    for (const [flag, list] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) L.push(`| ${flag} | ${list.length} | ${[...new Set(list.map((x) => x.case_id))].join(', ')} | ${esc(list[0].source)} |`);
  }
  L.push('', `Cost: ${JSON.stringify(report.usage || {})}`);
  return L.join('\n');
}

const src = process.argv[2];
if (!src) { console.error('usage: full_report.js report.json [out.md]'); process.exit(1); }
const report = JSON.parse(fs.readFileSync(src, 'utf8'));
const out = process.argv[3] || src.replace(/\.json$/, '.full.md');
fs.writeFileSync(out, render(report));
console.log('written', path.resolve(out));
