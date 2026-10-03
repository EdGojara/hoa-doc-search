// public/js/onboarding-intake.js  (Issue #15) — Start-screen intake logic
// Pure functions shared by public/onboarding.html and tests/test_onboarding_intake_ui.js.
// Which box a file was dropped on is NEVER its identity: the report type and
// date come from the server's reading of the PDF itself (POST /recognize). The
// drop target is kept only to tell the user when a file was rerouted.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OnboardingIntake = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const fileKey = (f) => [f.name, f.size, f.lastModified || 0].join('|');
  const mdy = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}` : null);

  // Only files not already held go to the server.
  function newFiles(held, files) {
    const have = new Set(held.map((h) => h.key)); const seen = new Set(); const out = [];
    for (const f of files) { const k = fileKey(f); if (have.has(k) || seen.has(k)) continue; seen.add(k); out.push(f); }
    return out;
  }

  // Merge recognition results (aligned with `files`) into the held set.
  // One file per report type: a file dated at the cutoff is never displaced by a
  // misdated one; otherwise the newer file replaces the older (and we say so).
  function merge(held, files, results, droppedOn) {
    let out = held.slice(); const notices = [];
    files.forEach((file, i) => {
      const r = results[i] || {};
      const entry = { key: fileKey(file), file, filename: file.name, type: r.type || null, as_of: r.as_of || null, period_start: r.period_start || null, dated_at_cutoff: r.dated_at_cutoff ?? null, note: r.note || null, dropped_on: droppedOn || null };
      if (droppedOn && entry.type && entry.type !== droppedOn) notices.push({ kind: 'rerouted', filename: entry.filename, dropped_on: droppedOn, type: entry.type });
      if (droppedOn && !entry.type) notices.push({ kind: 'unrecognized', filename: entry.filename, dropped_on: droppedOn });
      if (entry.type) {
        const prev = out.find((h) => h.type === entry.type);
        if (prev) {
          if (prev.dated_at_cutoff === true && entry.dated_at_cutoff === false) { notices.push({ kind: 'kept_existing', type: entry.type, kept: prev.filename, filename: entry.filename }); return; }
          out = out.filter((h) => h !== prev);
          notices.push({ kind: 'replaced', type: entry.type, old: prev.filename, filename: entry.filename });
        }
      }
      out.push(entry);
    });
    return { held: out, notices };
  }

  // The checklist rows with what is in hand; unrecognized files listed separately.
  function applyToPackage(reports, held) {
    const rows = reports.map((rep) => {
      const h = held.find((x) => x.type === rep.type);
      if (!h) return Object.assign({}, rep, { status: 'needed' });
      return Object.assign({}, rep, { status: 'supplied', file: h.filename, file_key: h.key, as_of: h.as_of, period_start: h.period_start, dated_at_cutoff: h.dated_at_cutoff, dropped_on: h.dropped_on });
    });
    return { reports: rows, unrecognized: held.filter((h) => !h.type).map((h) => ({ filename: h.filename, note: h.note, file_key: h.key })) };
  }

  // "1/1/2026 - 7/31/2026" or "as of 7/31/2026"; the date the report itself prints.
  function periodText(x) {
    if (!x || !x.as_of) return 'no date printed';
    return x.period_start ? `${mdy(x.period_start)} - ${mdy(x.as_of)}` : `as of ${mdy(x.as_of)}`;
  }

  function noticeText(n, nameOf) {
    const nm = (t) => (nameOf && nameOf(t)) || t;
    if (n.kind === 'rerouted') return `${n.filename} was dropped on ${nm(n.dropped_on)}, but its contents are the ${nm(n.type)}; it is filed there.`;
    if (n.kind === 'unrecognized') return `${n.filename} was dropped on ${nm(n.dropped_on)}, but Trusted does not recognize it as a report.`;
    if (n.kind === 'replaced') return `${n.filename} replaces ${n.old} as the ${nm(n.type)}.`;
    if (n.kind === 'kept_existing') return `${n.filename} is not dated at the cutoff; keeping ${n.kept} as the ${nm(n.type)}.`;
    return '';
  }

  return { fileKey, newFiles, merge, applyToPackage, periodText, noticeText };
});
