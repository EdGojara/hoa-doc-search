# insurance-program fixtures

Cases for the RFP **completeness guard** (`lib/insurance_rfp_validate.js`),
exercised by `tests/test_insurance_rfp_validate.js` (wired into `npm test`).

Each `*.json` file is one scenario:

```jsonc
{
  "description": "what this case represents",
  "sources": ["POLICY - PROP.pdf", "..."],   // the source policy PDFs the program was built from
  "expect": { "ok": true },                    // or { "ok": false, "missing": ["Property", ...] }
  "program": { "entity": {...}, "coverages": [ { "line": "...", "limits": [...] } ] }
}
```

- `ok: true` — the guard must pass (no blockers).
- `ok: false` + `missing` — the guard must block, and every line named in
  `missing` must appear in a blocker message.

## Add a new case (30 seconds)

Whenever a real community's RFP surfaces a new completeness gap, drop a JSON
file here with the source filenames + the coverage lines that came out, set
`expect`, and re-run `npm test`. No test code changes needed — the runner globs
this directory.

The scar this corpus exists for: **Waterview Estates, 2026-09-03.** A generated
RFP asked brokers to quote 5 lines when the association carried 7 — a $941,600
Hartford property policy dropped, Cyber dropped, Crime shown as "not purchased."
The renderer never throws; only this cross-check stands between a dropped line
and a broker's inbox.
