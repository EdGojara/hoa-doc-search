// ============================================================================
// lib/enforcement/mail_manifest.js  (Issue #5 follow-up, Ed 2026-09-28)
// ----------------------------------------------------------------------------
// A locked print batch, shown the way it is PRINTED: one row per envelope.
//
// Scar: the manifest listed one row per violation ("80 letters · 9 with
// multiple violations (each a separate notice)"). Both rows of a two-violation
// house opened the same combined letter, so printing from the rows printed that
// house twice, and the label told staff each violation was its own notice.
//
// Grouping is explicit and FAIL-VISIBLE (ChatGPT review): nothing is collapsed
// on a shared file path alone.
//   * envelope identity = bundle_id when present, else property_id + content
//     (a letter with no PDF is always its own row);
//   * the members of a bundle must agree on property, content and letter type.
//     If they don't, each member is shown as its own row, flagged;
//   * a content path used by more than one envelope (different properties or
//     bundles) flags every envelope involved. Nothing is hidden.
// ============================================================================

// items: [{ id, address, category, letter_type, content, property_id, bundle_id }]
function groupManifestEnvelopes(items = []) {
  const groups = new Map();
  for (const it of items) {
    const key = it.bundle_id ? `b:${it.bundle_id}`
      : it.content ? `pc:${it.property_id || '?'}|${it.content}`
        : `i:${it.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const envelope = (key, members, warning = null) => {
    const categories = [];
    for (const m of members) if (m.category && !categories.includes(m.category)) categories.push(m.category);
    return {
      key, address: members[0].address || null, property_id: members[0].property_id || null,
      bundle_id: members[0].bundle_id || null, content: members[0].content || null,
      letter_type: members[0].letter_type, categories, interaction_ids: members.map((m) => m.id),
      view_id: members[0].id, has_pdf: !!members[0].content, violation_count: members.length,
      combined: members.length > 1, integrity_warning: warning,
    };
  };

  const envelopes = [];
  for (const [key, members] of groups) {
    if (members.length > 1) {
      const differs = (f) => new Set(members.map((m) => m[f] || null)).size > 1;
      const bad = ['property_id', 'content', 'letter_type'].filter(differs);
      if (bad.length) {
        // Don't merge a group whose members disagree: one flagged row each.
        for (const m of members) envelopes.push(envelope(`i:${m.id}`, [m], `bundle ${String(m.bundle_id || '').slice(0, 8)} members disagree on ${bad.join(', ')}: check before printing`));
        continue;
      }
    }
    envelopes.push(envelope(key, members));
  }

  // One content file must belong to exactly one envelope.
  const byContent = new Map();
  for (const e of envelopes) if (e.content) (byContent.get(e.content) || byContent.set(e.content, []).get(e.content)).push(e);
  for (const list of byContent.values()) {
    if (list.length < 2) continue;
    const owners = new Set(list.map((e) => `${e.property_id}|${e.bundle_id || ''}`));
    if (owners.size > 1 || list.some((e) => !e.integrity_warning)) {
      for (const e of list) if (!e.integrity_warning) e.integrity_warning = 'this PDF is also used by another envelope in the batch: check before printing';
    }
  }

  envelopes.sort((a, b) => String(a.address || '').localeCompare(String(b.address || ''), undefined, { numeric: true }));
  const perProperty = envelopes.reduce((m, e) => { if (e.property_id) m[e.property_id] = (m[e.property_id] || 0) + 1; return m; }, {});
  return {
    envelopes,
    envelope_count: envelopes.length,
    combined_envelopes: envelopes.filter((e) => e.combined).length,
    properties_with_multiple_envelopes: Object.values(perProperty).filter((n) => n > 1).length,
    integrity_warnings: envelopes.filter((e) => e.integrity_warning).length,
  };
}

module.exports = { groupManifestEnvelopes };
