// lib/ai/objective_conditions.js — deterministic enforcement of objective ACC
// curing conditions (Ed/ChatGPT 2026-09-19; Phase 2 of EVIDENCE_READINESS.md).
//
// THE BOUNDARY: the MODEL determines a rule APPLIES (it produces the item / the
// scope). Once it does, CODE guarantees the required objective condition is
// attached — the model never has to "remember" an objective consequence again.
// This is the fix for the masonry finding where the "match-existing / no
// substitution" condition (grounded in Waterview Design Guidelines 3.9.1)
// appeared on some runs and not others.
//
// Registry is a community-scoped CONFIG file (objective_conditions.config.json),
// not a DB. Pure + deterministic; no API, no side effects.
const REGISTRY = require('./objective_conditions.config.json');

function rulesFor(community) {
  const scoped = (community && REGISTRY[community]) || [];
  const dflt = REGISTRY._default || [];
  return [...scoped, ...dflt].filter((r) => r && r.requirement_id && r.applies_when);
}

const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Given a structured ACC decision + the community, guarantee every applicable
// objective condition is present on its item. Returns { struct, enforced:[...] }.
// `enforced` lists the requirement_ids that were ADDED (already-present ones are
// left as-is; presence is matched on normalized condition text so we never
// duplicate a condition the model already wrote in its own words).
function enforceObjectiveConditions(struct, community) {
  const rules = rulesFor(community);
  const enforced = [];
  if (!struct || !Array.isArray(struct.items) || !rules.length) return { struct, enforced };

  for (const item of struct.items) {
    for (const rule of rules) {
      let re;
      try { re = new RegExp(rule.applies_when.item_type_matches, 'i'); } catch (_) { continue; }
      if (!re.test(String(item.type || ''))) continue; // model didn't put this scope in play

      const want = _norm(rule.required_condition);
      const reqs = item.requirements || (item.requirements = []);
      const already = reqs.some((r) => r.condition && (_norm(r.condition).includes(want) || want.includes(_norm(r.condition)) && _norm(r.condition).length > 20));
      if (already) continue;

      // attach the objective condition deterministically
      reqs.push({
        rule: rule.source, source_document: rule.source, rule_type: 'SUBJECTIVE',
        requirement: rule.required_condition, resolved_from: 'governing_docs',
        condition: rule.required_condition, complies: false,
        _objective_enforced: rule.requirement_id,
      });
      // an item that gains a required curing condition is APPROVE_WITH_CONDITIONS,
      // never a plain APPROVE (a real condition now rides on it). Never downgrade
      // a DENY/NEED_INFO.
      if (item.disposition === 'APPROVE') item.disposition = rule.disposition_if_added || 'APPROVE_WITH_CONDITIONS';
      enforced.push({ item: item.type, requirement_id: rule.requirement_id });
    }
  }
  // if any item became conditional, the overall decision must reflect it.
  if (enforced.length && struct.decision === 'APPROVE') struct.decision = 'APPROVE_WITH_CONDITIONS';
  return { struct, enforced };
}

module.exports = { enforceObjectiveConditions, rulesFor };
