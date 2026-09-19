// lib/ai/usage.js — token/cost/latency instrumentation (greenfield; the app has
// none today). Every model call records here so cost-per-completed-task is
// visible from day one. In-process accumulator now; a persistent sink (an
// ai_usage table) is the obvious next step, but the interface stays the same.
const records = [];

// Anthropic standard prompt-caching rates: cache read 0.1x input, write 1.25x.
function costUSD(usage, price) {
  if (!price || price.price_in == null || price.price_out == null) return null;
  const M = 1e6;
  return ((usage.input || 0) * price.price_in
    + (usage.output || 0) * price.price_out
    + (usage.cache_read || 0) * price.price_in * 0.1
    + (usage.cache_write || 0) * price.price_in * 1.25) / M;
}

function record(entry) {
  // entry: { kind, provider, model, usage, price, latency_ms, retries, error }
  const cost = entry.usage ? costUSD(entry.usage, entry.price) : null;
  const row = { at: new Date().toISOString(), cost_usd: cost, ...entry };
  records.push(row);
  return row;
}

function summary() {
  const s = { calls: records.length, errors: 0, retries: 0, cost_usd: 0, cost_known: true, latency_ms: 0, by_kind: {} };
  for (const r of records) {
    if (r.error) s.errors++;
    s.retries += r.retries || 0;
    s.latency_ms += r.latency_ms || 0;
    if (r.cost_usd == null) s.cost_known = false; else s.cost_usd += r.cost_usd;
    const k = r.kind || 'primary';
    s.by_kind[k] = s.by_kind[k] || { calls: 0, cost_usd: 0 };
    s.by_kind[k].calls++; if (r.cost_usd != null) s.by_kind[k].cost_usd += r.cost_usd;
  }
  return s;
}

function reset() { records.length = 0; }

module.exports = { record, summary, reset, costUSD, _records: records };
