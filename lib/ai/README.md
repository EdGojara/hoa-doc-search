# lib/ai — model routing & execution layer (Step 1: standalone, not yet wired)

Implements `evals/ROUTING_POLICY.md`. **Touches no production call path.** The
~160 existing inline `anthropic.messages.create` calls are unchanged; this layer
is built and tested in isolation first, then surfaces migrate to it one at a time
(starting with an ACC shadow run) only after review.

## Modules (separate concerns)
- `model_client.js` — the ONLY code that knows a provider SDK/response shape
  (provider independence). Retries transient failures, records usage, and turns
  **empty output into an error** so truncation can never read as a valid answer.
- `tiers.js` / `tiers.config.json` — capability tiers (`economy`/`standard`/
  `advanced`/`frontier`) → concrete models, and a cross-provider verifier per
  primary provider. Data-driven; models swap after evals without code changes.
- `policy.js` / `policy.config.json` — per-**subclass** policy: default tier,
  verify?, human floor, retrieval gate, autonomy state, max execution, severity.
- `verify.js` — cross-provider verification + **structured** agreement (facts /
  cited rules / calculations / disposition, not prose).
- `decide.js` — `route(ctx)`: the deterministic pipeline. Emits three first-class
  outputs — **business decision** (APPROVE/DENY/NEED_INFO/ESCALATE/ANALYZE),
  **execution** (EXECUTE/REVIEW/BLOCK/ERROR), **notification level**
  (DECISION_REQUIRED/OPERATIONAL_EXCEPTION/ANOMALY_WATCH) — plus a reason code.
  EXECUTE is reachable only after every gate passes.
- `audit.js` — the decision trail: what Miranda knew (policy version, document
  versions, model versions), each model's structured decision, which gates fired,
  the final verdict + reason, and a slot for the human override (→ future
  fixture/precedent).
- `usage.js` — token/cost/latency/retry/error instrumentation from day one.

## Run
```bash
npm run test:ai-router     # selftest: proves no failure mode reaches EXECUTE (no API)
npm run test:evaluator     # evaluator self-check: gate TP/FP/FN/TN (no API)
node lib/ai/run_cases.js   # live: route the five eval cases end-to-end (~$0.06)
```

## Status vs the 10 requirements
Business/execution/notification separated ✓ · policy data-driven by subclass ✓ ·
ERROR≠BLOCK, no fall-through to EXECUTE ✓ (selftest) · verify fails closed ✓ ·
structured comparison ✓ · rich audit record ✓ · provider independence ✓ ·
usage/cost/latency/retries/errors instrumented ✓ · safety tests ✓ · ran against
the five cases + evaluator fixtures ✓.

## Not done on purpose (needs review before proceeding)
- **No migration** of existing model calls.
- `test:ai-router` + `test:evaluator` are runnable but not yet added to the
  `run_all_tests.js` CI suite — do that when Step 2 is greenlit.
- Domain structured parsers in `verify.js` are light (enough to prove the
  pipeline); each surface gets a real parser as it's productionized.
- Autonomy states are all `shadow` at launch; graduation is performance-based
  (see ROUTING_POLICY.md), measured from the ASSIST sample once a surface is wired.
