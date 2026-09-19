// evals/lib/cost.js — turn usage + a model's price row into USD.
// Anthropic standard prompt-caching rates: cache READ = 0.1x input, cache WRITE
// = 1.25x input. price_in/price_out are $ per 1,000,000 tokens. Returns null
// when the model has no prices set yet (e.g. an unfilled OpenAI placeholder), so
// the report shows tokens + latency honestly rather than a fabricated dollar.
function costUSD(usage, priceRow) {
  if (!priceRow || priceRow.price_in == null || priceRow.price_out == null) return null;
  const M = 1_000_000;
  const inp = (usage.input || 0) * priceRow.price_in / M;
  const out = (usage.output || 0) * priceRow.price_out / M;
  const cr = (usage.cache_read || 0) * (priceRow.price_in * 0.1) / M;
  const cw = (usage.cache_write || 0) * (priceRow.price_in * 1.25) / M;
  return inp + out + cr + cw;
}

function fmtUSD(v) {
  if (v == null) return 'n/a';
  if (v < 0.01) return '$' + v.toFixed(5);
  return '$' + v.toFixed(4);
}

module.exports = { costUSD, fmtUSD };
