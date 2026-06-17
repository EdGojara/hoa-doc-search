// ============================================================================
// lib/governing_doc_health_digest.js
// ----------------------------------------------------------------------------
// Single source of truth for the weekly governing-doc health digest. Used by:
//   - api/documents.js POST /governing-health/digest (manual / curl trigger)
//   - lib/scheduler.js governing_health_weekly_digest job (Monday 8am Central)
//
// Returns { totals, html, subject } so the caller decides whether to send via
// Resend, render in a UI panel, log to cron_runs, etc.
//
// Week-over-week deltas: alongside "this week" numbers, includes a "prior
// week" comparison for the same window length so the digest signals
// DIRECTION not just state. A portfolio holding steady at 14 pending reviews
// is fine; the same portfolio jumping 4 -> 14 in a week means something
// changed upstream and deserves attention.
// ============================================================================

const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Renders a delta chip: "+3 (was 1)" / "no change" / "-2"
function deltaChip(current, prior) {
  if (current === prior) return '<span style="color:#6b7280; font-size:11px;">no change</span>';
  const delta = current - prior;
  if (delta > 0) {
    return `<span style="color:#dc2626; font-size:11px; font-weight:600;">+${delta} (was ${prior})</span>`;
  }
  return `<span style="color:#166534; font-size:11px; font-weight:600;">${delta} (was ${prior})</span>`;
}

// Snapshot: structural exposures as of a given cutoff date. A community is
// missing-foundation if it has no Declaration or Bylaws CREATED ON OR BEFORE
// the cutoff. Lets us compare last-week-end vs this-week-end without
// needing a historical snapshots table.
function snapshotMissingFoundation(communities, docs, cutoffIso) {
  return communities
    .map((c) => {
      const myDocsAsOf = docs.filter((d) =>
        d.community_id === c.id && d.created_at && d.created_at <= cutoffIso);
      const missing = [];
      if (myDocsAsOf.filter((d) => d.category === 'declaration_ccrs').length === 0) missing.push('Declaration');
      if (myDocsAsOf.filter((d) => d.category === 'bylaws').length === 0) missing.push('Bylaws');
      return missing.length > 0 ? { name: c.name, missing } : null;
    })
    .filter(Boolean);
}

async function buildDigest({ supabase, sinceIso }) {
  if (!sinceIso) sinceIso = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  // Prior period of equal length immediately before the current window.
  const sinceMs = new Date(sinceIso).getTime();
  const windowMs = Date.now() - sinceMs;
  const priorStartIso = new Date(sinceMs - windowMs).toISOString();
  // Cutoff for "as of" comparisons: the start of the current week.
  const cutoffIso = sinceIso;

  const { data: communities } = await supabase
    .from('communities')
    .select('id, name')
    .eq('management_company_id', BEDROCK_MGMT_CO_ID)
    .eq('active', true);
  if (!communities || communities.length === 0) {
    return { totals: { error: 'no_communities' }, html: null, subject: null };
  }
  const communityIds = communities.map((c) => c.id);

  const { data: libDocs } = await supabase
    .from('library_documents')
    .select('id, title, category, status, community_id, effective_date, supersedes_library_document_id, supersession_recorded_at, created_at')
    .in('community_id', communityIds)
    .in('category', ['declaration_ccrs', 'bylaws', 'rules_and_regulations', 'articles_of_incorporation']);
  const docs = libDocs || [];

  // Current vs prior period deltas
  const uploadedCurrent = docs.filter((d) => d.created_at && d.created_at >= sinceIso).length;
  const uploadedPrior = docs.filter((d) => d.created_at && d.created_at >= priorStartIso && d.created_at < sinceIso).length;
  const confirmedCurrent = docs.filter((d) =>
    d.supersession_recorded_at && d.supersession_recorded_at >= sinceIso).length;
  const confirmedPrior = docs.filter((d) =>
    d.supersession_recorded_at && d.supersession_recorded_at >= priorStartIso && d.supersession_recorded_at < sinceIso).length;

  // Structural exposures: now vs one window ago
  const missingNow = snapshotMissingFoundation(communities, docs, new Date().toISOString());
  const missingPriorEnd = snapshotMissingFoundation(communities, docs, cutoffIso);

  // Pending amendment suggestion count (NEW in the window for delta; total
  // pending right now for state). The current pending count needs the
  // confirmed-set filter so we don't include already-actioned suggestions.
  const docIds = docs.map((d) => d.id);
  let pendingTotal = 0;
  let newSuggestionsCurrent = 0;
  let newSuggestionsPrior = 0;
  if (docIds.length > 0) {
    const { data: pendingLogs } = await supabase
      .from('library_document_amendment_log')
      .select('amendment_library_document_id, recorded_at, action')
      .in('amendment_library_document_id', docIds);
    const confirmedSet = new Set(docs.filter((d) => d.supersession_recorded_at).map((d) => d.id));
    const seen = new Set();
    for (const row of (pendingLogs || [])) {
      if (row.action !== 'ai_suggested') continue;
      if (row.recorded_at && row.recorded_at >= sinceIso) newSuggestionsCurrent += 1;
      if (row.recorded_at && row.recorded_at >= priorStartIso && row.recorded_at < sinceIso) newSuggestionsPrior += 1;
      if (confirmedSet.has(row.amendment_library_document_id)) continue;
      if (seen.has(row.amendment_library_document_id)) continue;
      seen.add(row.amendment_library_document_id);
      pendingTotal += 1;
    }
  }

  // Zero-chunk doc count (state-only — meaningful as gap to close, not a delta)
  let zeroChunkCount = 0;
  if (docIds.length > 0) {
    const [{ data: byMeta }, { data: byCol }] = await Promise.all([
      supabase.from('documents').select('metadata').in('metadata->>library_document_id', docIds),
      supabase.from('documents').select('migrated_to_library_id').in('migrated_to_library_id', docIds),
    ]);
    const haveChunks = new Set();
    for (const r of (byMeta || [])) if (r.metadata?.library_document_id) haveChunks.add(r.metadata.library_document_id);
    for (const r of (byCol || [])) if (r.migrated_to_library_id) haveChunks.add(r.migrated_to_library_id);
    zeroChunkCount = docs.filter((d) => !haveChunks.has(d.id)).length;
  }

  // Subject signals the BIGGEST change of the week. If structural exposures
  // are new this week, that's most important. Otherwise lead with delta or
  // operator queue.
  const newExposures = missingNow.filter((m) => !missingPriorEnd.find((p) => p.name === m.name)).length;
  let subject;
  if (newExposures > 0) {
    subject = `[Bedrock Doc Health] ⚠ ${newExposures} new structural gap${newExposures === 1 ? '' : 's'} this week`;
  } else if (missingNow.length > 0) {
    subject = `[Bedrock Doc Health] ${missingNow.length} structural gap${missingNow.length === 1 ? '' : 's'} unchanged · ${uploadedCurrent} new upload${uploadedCurrent === 1 ? '' : 's'}`;
  } else {
    subject = `[Bedrock Doc Health] All ${communities.length} clear · ${uploadedCurrent} new · ${confirmedCurrent} confirmed`;
  }

  const sinceLabel = new Date(sinceIso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const nowLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
      <h2 style="margin: 0 0 6px; color: #1e3a8a;">⚖️ Governing Doc Health — Weekly Digest</h2>
      <div style="font-size: 12px; color: #6b7280; margin-bottom: 18px;">Portfolio state as of ${nowLabel} · since ${sinceLabel}</div>

      <h3 style="margin: 18px 0 6px; color: #1e40af; font-size: 14px;">This week</h3>
      <ul style="margin: 0 0 12px; padding-left: 18px; font-size: 13px;">
        <li><strong>${uploadedCurrent}</strong> new governing doc${uploadedCurrent === 1 ? '' : 's'} uploaded &nbsp; ${deltaChip(uploadedCurrent, uploadedPrior)}</li>
        <li><strong>${confirmedCurrent}</strong> amendment link${confirmedCurrent === 1 ? '' : 's'} confirmed &nbsp; ${deltaChip(confirmedCurrent, confirmedPrior)}</li>
        <li><strong>${newSuggestionsCurrent}</strong> new AI amendment suggestion${newSuggestionsCurrent === 1 ? '' : 's'} logged &nbsp; ${deltaChip(newSuggestionsCurrent, newSuggestionsPrior)}</li>
      </ul>

      <h3 style="margin: 18px 0 6px; color: ${missingNow.length > 0 ? '#dc2626' : '#1e40af'}; font-size: 14px;">Structural exposures ${missingNow.length === missingPriorEnd.length ? '<span style="font-size:11px; color:#6b7280; font-weight:normal;">(unchanged)</span>' : ''}</h3>
      ${missingNow.length > 0
        ? `<div style="background:#fef2f2; border:2px solid #dc2626; padding:10px 12px; border-radius:6px; font-size:12.5px; color:#7f1d1d;">
            <strong>${missingNow.length} communit${missingNow.length === 1 ? 'y' : 'ies'} missing Declaration or Bylaws.</strong> Without these, askEd queries against the community fall back to whatever ranks closest across the portfolio.
            <ul style="margin:6px 0 0 18px; padding:0;">${missingNow.map((m) => {
              const wasNew = !missingPriorEnd.find((p) => p.name === m.name);
              return `<li>${escapeHtml(m.name)} — missing: ${escapeHtml(m.missing.join(', '))}${wasNew ? ' <span style="background:#fca5a5; color:#7f1d1d; padding:1px 7px; border-radius:99px; font-size:10px; font-weight:700; margin-left:4px;">NEW THIS WEEK</span>' : ''}</li>`;
            }).join('')}</ul>
          </div>`
        : `<div style="background:#dcfce7; padding:8px 12px; border-radius:6px; font-size:12.5px; color:#166534;">All ${communities.length} communities have both Declaration and Bylaws ingested. ✓</div>`}

      <h3 style="margin: 18px 0 6px; color: #1e40af; font-size: 14px;">Operator queue</h3>
      <ul style="margin: 0 0 12px; padding-left: 18px; font-size: 13px;">
        <li><strong>${pendingTotal}</strong> pending amendment review${pendingTotal === 1 ? '' : 's'}${pendingTotal > 10 ? ' — consider the bulk confirm workflow' : ''}</li>
        <li><strong>${zeroChunkCount}</strong> doc${zeroChunkCount === 1 ? '' : 's'} with zero chunks linked${zeroChunkCount > 0 ? ' — run the re-link button on the portfolio matrix' : ''}</li>
      </ul>

      <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af;">
        Bedrock Intelligence · Generated automatically · Reply to flag anything that looks off.
      </div>
    </div>
  `;

  return {
    totals: {
      uploadedCurrent,
      uploadedPrior,
      confirmedCurrent,
      confirmedPrior,
      newSuggestionsCurrent,
      newSuggestionsPrior,
      missingFoundationCount: missingNow.length,
      missingFoundationPriorCount: missingPriorEnd.length,
      newExposuresThisWeek: newExposures,
      pendingTotal,
      zeroChunkCount,
      communityCount: communities.length,
    },
    html,
    subject,
  };
}

module.exports = { buildDigest };
