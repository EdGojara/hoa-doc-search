# trustEd model eval harness

Runs real trustEd tasks against multiple models, scores them against a rubric,
prices each run, and cross-checks one model's answer with another. It exists so
model choice is an **evidence-based, model-agnostic** decision: when a new or
cheaper model appears, add it to `models.json` and re-run — nothing in the
product changes. Judge **cost per completed task**, not cost per token.

## Run

```bash
node evals/run.js                          # default case, all enabled models
node evals/run.js --case clma-bid-analysis
node evals/run.js --models haiku-4-5,sonnet-5
node evals/run.js --no-crosscheck
```

Each run prints a table (score / cost / latency / which rubric checks were
missed), the cross-check findings, and saves a full JSON report under
`evals/reports/`. **Every run calls the models and costs real money** (cents for
the current case) — it is not free.

## Layout

- `models.json` — the model roster. Prices are USD per 1M tokens. Anthropic
  ids/prices are filled from the claude-api reference; **OpenAI entries are
  placeholders** — put a verified model id + prices from OpenAI's live pricing
  page and set `enabled: true` to turn on the cross-*provider* check. Never trust
  model names/prices from memory.
- `lib/model_client.js` — the first provider-agnostic caller in the codebase
  (`callModel({provider, model, system, prompt, maxTokens, thinking})`). Prove
  the abstraction here, then promote it into `lib/ai/` for production routing.
- `lib/cost.js` — usage → USD (Anthropic cache read 0.1×, write 1.25× input).
- `lib/score.js` — deterministic rubric scoring (number / regex / absent checks).
- `cases/<id>/case.js` — a case: `{ system, prompt, maxTokens, rubric }`.
- `reports/` — saved run reports (gitignored-worthy; keep or prune as you like).

## Adding a case

Drop a new folder under `cases/` with a `case.js` exporting `id`, `title`,
`system`, `prompt`, `maxTokens`, and a `rubric` (list of weighted checks with a
factual ground truth). Real work makes the best cases: an ACC end-to-end
decision, a messy reconciliation, an Amanda governance question, a board packet.

## What the first run showed (clma-bid-analysis)

The cheap model (haiku) scored 100% on the mechanical rubric for ~$0.01 and beat
the mid model on cost. The cross-check (sonnet-5, ~$0.02) then caught real gaps
the rubric didn't encode (e.g. none of the bids cover the required *esplanades*).
Lesson: cheap-model + targeted cross-check is the right shape for board-facing
work; the check earns its cents by catching judgment-level misses, and it also
surfaces gaps to fold back into the rubric.
