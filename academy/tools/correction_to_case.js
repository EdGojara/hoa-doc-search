#!/usr/bin/env node
// academy/tools/correction_to_case.js
// ----------------------------------------------------------------------------
// Regression workflow, step 1:  real situation -> Amanda response -> HUMAN
// correction  ==>  a DRAFT regression case + a DRAFT lesson, linked.
//
//   node academy/tools/correction_to_case.js path/to/correction.json
//
// correction.json:
// {
//   "situation": { ...case fields Amanda sees: title, audience, channel, scenario,
//                  people, community_context, conversation_history,
//                  incoming_message, available_context },
//   "amanda_response": "what Amanda actually said",
//   "human_correction": "what should have happened and why",
//   "corrected_by": "Ed Gojara",
//   "answer_key": { ...facts / supported_inferences / unknowns / etc... },
//   "lesson": { "domain", "trigger", "principle", "bad_pattern", "preferred_pattern" }
// }
//
// Output files are written to academy/cases/regression/ and academy/lessons/
// with status "draft". Nothing becomes active without human review + approval
// (lessons.js lifecycle). The original Amanda response and the correction are
// preserved verbatim inside the case, so history is never lost.
// ----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { validateCase } = require('../lib/case_schema');
const { validateLesson } = require('../lib/lessons');

function nextId(dir, prefix, re) {
  let max = 0;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of txt.matchAll(re)) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function main() {
  const src = process.argv[2];
  if (!src) { console.error('usage: correction_to_case.js correction.json'); process.exit(1); }
  const cor = JSON.parse(fs.readFileSync(src, 'utf8'));
  for (const f of ['situation', 'amanda_response', 'human_correction', 'corrected_by', 'answer_key', 'lesson']) if (!cor[f]) throw new Error(`correction.${f} required`);
  const root = path.join(__dirname, '..');
  const caseDir = path.join(root, 'cases', 'regression');
  const lessonDir = path.join(root, 'lessons');
  fs.mkdirSync(caseDir, { recursive: true });
  const caseId = nextId(caseDir, 'AA-REG-', /"AA-REG-(\d{3})"/g);
  const dom = String(cor.lesson.domain || 'judgment').slice(0, 3).toUpperCase().replace('REL', 'REL');
  const lessonId = nextId(lessonDir, `LSN-${dom}-`, new RegExp(`"LSN-${dom}-(\\d{3})"`, 'g'));
  const today = new Date().toISOString().slice(0, 10);

  const c = {
    case_id: caseId, version: 1, status: 'draft', agent: 'amanda',
    domain: [cor.lesson.domain || 'judgment'], topic: cor.situation.topic || 'regression',
    ...cor.situation,
    answer_key: cor.answer_key,
    provenance: `regression from human correction by ${cor.corrected_by} on ${today}`,
    regression: { original_response: cor.amanda_response, human_correction: cor.human_correction, corrected_by: cor.corrected_by, corrected_at: today, lesson_id: lessonId },
    created_by: 'correction_to_case', created_at: today,
  };
  const ce = validateCase(c);
  if (ce.length) throw new Error('generated case invalid: ' + ce.join('; '));

  const l = {
    lesson_id: lessonId, version: 1, agent: 'amanda', domain: cor.lesson.domain,
    trigger: cor.lesson.trigger, principle: cor.lesson.principle, bad_pattern: cor.lesson.bad_pattern, preferred_pattern: cor.lesson.preferred_pattern,
    examples: [cor.amanda_response.slice(0, 300)], source: 'human_correction', originating_case: caseId,
    human_correction: cor.human_correction, confidence: cor.lesson.confidence || 'medium', status: 'draft',
    regression_case_ids: [caseId], reviewed_by: null, reviewed_at: null, approved_by: null, approved_at: null,
    history: [{ from: null, to: 'draft', by: 'correction_to_case', at: new Date().toISOString(), note: `from correction by ${cor.corrected_by}` }],
  };
  const le = validateLesson(l);
  if (le.length) throw new Error('generated lesson invalid: ' + le.join('; '));

  fs.writeFileSync(path.join(caseDir, `${caseId}.json`), JSON.stringify([c], null, 2));
  fs.writeFileSync(path.join(lessonDir, `${lessonId}.json`), JSON.stringify([l], null, 2));
  console.log(`draft case ${caseId} + draft lesson ${lessonId} written (both need human review before activation)`);
}

main();
