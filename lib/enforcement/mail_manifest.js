// ============================================================================
// lib/enforcement/mail_manifest.js  (Issue #5 follow-up, Ed 2026-09-28)
// ----------------------------------------------------------------------------
// A locked print batch, shown the way it is PRINTED: one row per envelope.
// Letters for one house that share one combined PDF (interactions.content) are
// ONE envelope. That's the same rule Re-download uses to merge each combined
// letter once.
//
// Scar: the manifest listed one row per violation ("80 letters · 9 with
// multiple violations (each a separate notice)"). Both rows of a two-violation
// house opened the same combined letter, so printing from the rows printed that
// house twice, and the label told staff each violation was its own notice.
// ============================================================================

// items: [{ id, address, category, letter_type, content, property_id }]
function groupManifestEnvelopes(items = []) {
  const byKey = new Map();
  for (const it of items) {
    const key = it.content ? `c:${it.content}` : `i:${it.id}`;   // no PDF: its own row (flagged)
    if (!byKey.has(key)) {
      byKey.set(key, { key, address: it.address || null, property_id: it.property_id || null, letter_type: it.letter_type,
        categories: [], interaction_ids: [], view_id: it.id, has_pdf: !!it.content });
    }
    const e = byKey.get(key);
    if (it.category && !e.categories.includes(it.category)) e.categories.push(it.category);
    e.interaction_ids.push(it.id);
  }
  const envelopes = [...byKey.values()].map((e) => ({ ...e, violation_count: e.interaction_ids.length, combined: e.interaction_ids.length > 1 }));
  envelopes.sort((a, b) => String(a.address || '').localeCompare(String(b.address || ''), undefined, { numeric: true }));
  const perProperty = envelopes.reduce((m, e) => { if (e.property_id) m[e.property_id] = (m[e.property_id] || 0) + 1; return m; }, {});
  return {
    envelopes,
    envelope_count: envelopes.length,
    combined_envelopes: envelopes.filter((e) => e.combined).length,
    // A house with MORE THAN ONE envelope in the same batch (e.g. different
    // stages) is unusual, so it's surfaced rather than hidden.
    properties_with_multiple_envelopes: Object.values(perProperty).filter((n) => n > 1).length,
  };
}

module.exports = { groupManifestEnvelopes };
