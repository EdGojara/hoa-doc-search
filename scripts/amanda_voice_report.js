#!/usr/bin/env node
// ============================================================================
// scripts/amanda_voice_report.js  (Talk to Amanda, 2026-11-26)
// ----------------------------------------------------------------------------
// READ-ONLY. Measured latency, reliability and cost of Talk to Amanda from
// production records: claire_sessions (surface 'conversation') with their
// metrics, plus the per-call model rows in agent_runs attributed to each
// conversation. Same roll-up as GET /api/amanda/voice/metrics.
//   node scripts/amanda_voice_report.js [--days=7] [--json]
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { aggregateMetrics } = require('../api/amanda_voice')._test;

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const days = Math.max(1, Number(arg('days', 7)) || 7);

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const { data, error } = await sb.from('claire_sessions').select('id, started_at, ended_at, status, end_reason, audio_seconds, cost_usd, metrics, summary').eq('surface', 'conversation').gte('started_at', since).order('started_at', { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  const agg = aggregateMetrics(data || []);
  const { data: calls, error: cErr } = await sb.from('agent_runs').select('workflow, model, ok, duration_ms, cost_usd, input_tokens, output_tokens, cache_read_tokens, created_at').eq('run_kind', 'model_call').in('workflow', ['team.amanda_conversation', 'team.amanda_memory_extract', 'team.amanda_request']).gte('created_at', since).limit(5000);
  if (cErr) throw new Error(cErr.message);
  const byWf = {};
  for (const c of calls || []) {
    const w = (byWf[c.workflow] = byWf[c.workflow] || { calls: 0, failed: 0, cost_usd: 0, ms: [] });
    w.calls++; if (!c.ok) w.failed++; w.cost_usd += Number(c.cost_usd) || 0; if (c.duration_ms != null) w.ms.push(c.duration_ms);
  }
  const S = require('../lib/amanda/voice_elevenlabs').summarize;
  for (const w of Object.values(byWf)) { w.cost_usd = Math.round(w.cost_usd * 10000) / 10000; w.duration_ms = S(w.ms); delete w.ms; }
  const out = { days, ...agg, model_calls_by_workflow: byWf };
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`Talk to Amanda, last ${days} day(s)`);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('report failed:', e.message); process.exit(1); });
