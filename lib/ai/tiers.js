// lib/ai/tiers.js — capability tier -> concrete model config (data-driven).
// The rest of the system speaks in tiers ('economy'/'standard'/...); only this
// module + model_client know model names, so models swap after evals without
// touching logic.
const cfg = require('./tiers.config.json');

function tier(name) {
  const t = cfg.tiers[name];
  if (!t) throw new Error(`unknown tier: ${name}`);
  return { tier: name, ...t };
}

// A cross-PROVIDER verifier for a given primary provider (different training =>
// independent failure modes). Returns null if none configured.
function verifierFor(primaryProvider) {
  const v = cfg.verifiers[primaryProvider];
  return v ? { ...v } : null;
}

function policyVersion() { return cfg.policy_version; }

module.exports = { tier, verifierFor, policyVersion };
