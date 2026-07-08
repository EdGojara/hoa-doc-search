// ============================================================================
// api/system_errors.js  (Ed 2026-07-08) — mounted at /api/system-errors
// ----------------------------------------------------------------------------
// Admin-only view over the system_errors capture table: which endpoints are
// throwing 5xx, how often, and the latest message — so a broken feature is
// visible to Ed in minutes. Grouped by endpoint (most-broken first) plus the
// raw recent list. Last 7 days.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const { requireAdmin } = require('./_require_admin');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

router.get('/', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data, error } = await supabase.from('system_errors')
      .select('id, method, path, status_code, error_message, created_at')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(1000);
    if (error) throw error;
    const rows = data || [];
    const byPath = {};
    for (const e of rows) {
      const k = `${e.method || ''} ${e.path || ''}`.trim();
      if (!byPath[k]) byPath[k] = { endpoint: k, count: 0, last: e.created_at, status: e.status_code, sample: e.error_message };
      byPath[k].count += 1;
    }
    res.json({
      ok: true,
      total: rows.length,
      summary: Object.values(byPath).sort((a, b) => b.count - a.count),
      recent: rows.slice(0, 100),
    });
  } catch (err) {
    console.error('[system-errors] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
