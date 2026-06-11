# Vantaca violation export fixtures

Real production files from Bedrock-managed communities, kept here as
permanent regression cases. Every time staff (or Ed) hits a Vantaca
import that fails or extracts wrong, the file gets added here and the
test suite gets a new expected-output assertion. This is the
**no-regression contract** — we cannot break what worked before.

## File naming

`<community-slug>-<period>.<ext>` — e.g. `lakes-pine-forest-2026-05.csv`.

If the same community has both a PDF and CSV export of the same
period, give them the same base name with different extensions. The
runner treats each as an independent test.

## Files

| File | Source | Shape | Expected rows | Notes |
|---|---|---|---|---|
| `lakes-pine-forest-2026-05.csv` | Vantaca SSRS export | `textBox*` headers | 150 | Source had 7 duplicates that the parser dedupes |
| `lakes-pine-forest-2026-05.pdf` | Vantaca SSRS PDF | 12 pages, status-grouped | 150 | Same data as the CSV |

## Adding a new fixture

1. Drop the file in this directory with the naming convention above.
2. Add a row to `expected-counts.json` with the row count + stage
   distribution.
3. Run `npm run test:vantaca` to confirm the new fixture passes.

That's it. The test runner discovers fixtures by directory scan, so
adding a file is enough — no test code changes required.

## Why this exists

Ed 2026-06-10: "this business must be able to function without me at
some point." Test fixtures are the discipline that converts
"works for Ed today" into "works for Laurie tomorrow + every franchise
operator after." See memory note `project_ed_not_in_loop_test`.
