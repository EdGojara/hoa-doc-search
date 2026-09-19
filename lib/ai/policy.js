// lib/ai/policy.js — per-subclass routing policy (data-driven, from
// policy.config.json). No behavior lives here; decide.js reads these fields.
const cfg = require('./policy.config.json');

function policyFor(subclass) {
  const p = cfg.subclasses[subclass];
  if (!p) throw new Error(`no policy for subclass: ${subclass}`);
  return { subclass, policy_version: cfg.policy_version, ...p };
}

function subclasses() { return Object.keys(cfg.subclasses); }
function policyVersion() { return cfg.policy_version; }

module.exports = { policyFor, subclasses, policyVersion };
