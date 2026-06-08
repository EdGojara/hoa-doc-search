// ============================================================================
// api/today.js — Operator "Today" dashboard data
// ----------------------------------------------------------------------------
// Mounted at /api/today
//
// Ed 2026-06-08 — Operator command center. ONE endpoint returns
// everything the Home-tab Today panel needs in a single round-trip.
//
// COST DISCIPLINE (Ed's standing rule at current volume):
// - Endpoint runs ONLY when staff explicitly opens the Home tab or
//   clicks Refresh. No polling, no setInterval, no scheduled job.
// - All Supabase queries are bounded with explicit LIMIT.
// - All queries fire in parallel via Promise.allSettled so a slow
//   sub-query doesn't block the rest.
// - No AI calls. No external API calls. Pure DB reads.
//
// SECTIONS:
//   inbox      — threads needing staff first response (open ones only)
//   calls      — most recent inbound homeowner calls (today + recent)
//   uploads    — most recent Vantaca imports (any status)
//   ar_freshness — stalest communities by AR ingest date
//
// Each section returns: { count, items: [...] }
// ============================================================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

router.get('/', async (req, res) => {
  try {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      inboxRes,
      callsRes,
      uploadsRes,
      arRes,
      communitiesRes,
    ] = await Promise.allSettled([
      // Inbox — threads needing staff attention (first response or follow-up).
      // Bounded to last 7 days so the query stays cheap even as volume grows.
      supabase
        .from('homeowner_threads')
        .select('id, community_id, property_id, subject, topic_tag, next_action_status, created_at, last_homeowner_message_at, first_response_due_at, breached_yellow_at, breached_red_at, breached_overdue_at')
        .in('next_action_status', ['awaiting_staff_first_response', 'awaiting_staff_followup'])
        .gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false })
        .limit(10),
      // Recent calls — last 10 inbound
      supabase
        .from('homeowner_calls')
        .select('call_sid, community_id, caller_phone, caller_homeowner_id, started_at, ended_at, duration_seconds, brief')
        .order('started_at', { ascending: false })
        .limit(10),
      // Recent Vantaca imports — last 5 of any status
      supabase
        .from('vantaca_imports')
        .select('id, community_id, report_type, source_filename, status, as_of_date, extraction_row_count, imported_at')
        .order('imported_at', { ascending: false })
        .limit(5),
      // AR freshness — committed transaction batches grouped by community.
      // We'll merge with full community list below.
      supabase
        .from('transaction_upload_batches')
        .select('community_id, as_of_date, committed_at')
        .eq('status', 'committed')
        .order('as_of_date', { ascending: false })
        .limit(500),
      // Community list (cheap, all rows) so we can show "never uploaded"
      supabase
        .from('communities')
        .select('id, name')
        .eq('management_company_id', BEDROCK_MGMT_CO_ID)
        .eq('active', true)
        .order('name'),
    ]);

    // Resolve community names for any community_id we display
    const communities = communitiesRes.status === 'fulfilled' ? (communitiesRes.value?.data || []) : [];
    const communityNameById = new Map();
    communities.forEach(c => communityNameById.set(c.id, c.name));

    // ---- inbox ----
    const inboxItems = (inboxRes.status === 'fulfilled' ? inboxRes.value?.data : []) || [];
    const inbox = {
      count: inboxItems.length,
      items: inboxItems.slice(0, 5).map(t => {
        const sla = (() => {
          if (t.breached_overdue_at) return 'overdue';
          if (t.breached_red_at) return 'red';
          if (t.breached_yellow_at) return 'yellow';
          return 'green';
        })();
        return {
          id: t.id,
          community_name: communityNameById.get(t.community_id) || '',
          subject: t.subject,
          topic_tag: t.topic_tag,
          status: t.next_action_status,
          sla,
          last_homeowner_message_at: t.last_homeowner_message_at,
          created_at: t.created_at,
        };
      }),
    };

    // ---- calls ----
    const callItems = (callsRes.status === 'fulfilled' ? callsRes.value?.data : []) || [];
    const todayStr = today.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const callsTodayCount = callItems.filter(c => {
      if (!c.started_at) return false;
      return c.started_at.slice(0, 10) === todayStr;
    }).length;
    const calls = {
      count_today: callsTodayCount,
      count_recent: callItems.length,
      items: callItems.slice(0, 5).map(c => ({
        call_sid: c.call_sid,
        community_name: communityNameById.get(c.community_id) || '',
        caller_phone: c.caller_phone,
        started_at: c.started_at,
        duration_seconds: c.duration_seconds,
        brief_concern: c.brief?.concern || c.brief?.summary || '',
        brief_next_step: c.brief?.next_step || '',
      })),
    };

    // ---- uploads ----
    const uploadItems = (uploadsRes.status === 'fulfilled' ? uploadsRes.value?.data : []) || [];
    const uploads = {
      count: uploadItems.length,
      items: uploadItems.map(u => ({
        id: u.id,
        community_name: communityNameById.get(u.community_id) || '(unrouted)',
        report_type: u.report_type,
        source_filename: u.source_filename,
        status: u.status,
        as_of_date: u.as_of_date,
        extraction_row_count: u.extraction_row_count,
        imported_at: u.imported_at,
      })),
    };

    // ---- ar_freshness ----
    const batches = (arRes.status === 'fulfilled' ? arRes.value?.data : []) || [];
    const latestByCommunity = new Map();
    for (const b of batches) {
      if (!latestByCommunity.has(b.community_id)) {
        latestByCommunity.set(b.community_id, b.as_of_date);
      }
    }
    const todayDate = new Date(todayStr + 'T00:00:00Z');
    const arRows = communities.map(c => {
      const last = latestByCommunity.get(c.id) || null;
      let daysSince = null;
      if (last) {
        const lastDt = new Date(last + 'T00:00:00Z');
        daysSince = Math.floor((todayDate.getTime() - lastDt.getTime()) / 86400000);
      }
      return {
        community_id: c.id,
        community_name: c.name,
        last_as_of: last,
        days_since: daysSince,
        severity: (daysSince == null) ? 'never' : (daysSince > 60 ? 'very_stale' : (daysSince > 35 ? 'stale' : 'current')),
      };
    });
    arRows.sort((a, b) => {
      const rank = { never: 0, very_stale: 1, stale: 2, current: 3 };
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
      return (b.days_since || -1) - (a.days_since || -1);
    });
    const ar_freshness = {
      total_communities: arRows.length,
      stale_count: arRows.filter(r => r.severity === 'stale' || r.severity === 'very_stale' || r.severity === 'never').length,
      items: arRows.slice(0, 5),
    };

    res.json({
      generated_at: new Date().toISOString(),
      inbox,
      calls,
      uploads,
      ar_freshness,
    });
  } catch (err) {
    console.error('[today] failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
