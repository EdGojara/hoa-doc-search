# RFP / Bid Workflow comparison fixtures

Real proposal sets that Amanda must classify, normalize and recommend on correctly.
Run: `node tests/test_amanda_rfp_comparison.js` (also in `npm test`), or the readable
report: `node scripts/amanda_rfp_dry_run.js`.

Each fixture JSON has:

- `board_email`: the message as received (subject, body, attachment names and sizes)
- `proposals`: one item per proposal, in the shape `lib/vendors/proposal_extract.js`
  produces and `validateProposal()` accepts, transcribed from the real documents
  (a packet with several proposals becomes several items with `document.pages`)
- `db_seed`: a snapshot of the community's books state (accounts, trial balance,
  bank accounts, reconciliations, periods, budget), labelled as a snapshot, never live
- `expected`: classifications, recommended key, costs (cents, `tolerance_cents`),
  not-viable keys, open-item topics, confidence labels

Adding a case: drop a new JSON next to this one with the same keys, then add a loop
over the directory in the test if more than one fixture exists. Never invent a figure:
every number must trace to a page of a real document.

## Canyon Gate cameras: provenance

- Proposals: transcribed from the 9/17/2026 and 10/15/2026 board emails and the July 2026 packet. Envera's tax is stored as the quote prints it, with no rate, exactly as the live extraction returned it.
- Books (`db_seed`): match the live read-only dry run of 2026-10-16: operating $41,104.86 and reserve $948,452.23, both provisional, no month closed.
- Community context (`context_seed`): a snapshot of the documented Canyon Gate records (contracts, bills, project, reserve components, the 9/17 thread). It also includes must-omit cases: the message being answered and its thread reply, the United Protective "Contract - For Review" emails, and pool items.
- Line items (`itech-2026-a.line_items`, `scope_statements`, `printed_subtotal_cents`): transcribed from iTech_Video Proposal_Sept 2026.pdf. Page numbers follow the PDF page text: p3 scope + items 1-2, p4 items 3-22, p7 Summary of Cost. The model's own camera and license totals are removed; lib/vendors/line_items.js computes them (14 new + 13 reused = 27; 20 licenses; $44,619.75 matches the printed subtotal).
