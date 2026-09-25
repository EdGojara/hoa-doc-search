# Judge calibration plan (30 responses)

**Why:** the baseline showed frequent judge splits and run-to-run swings. Automatic verdicts can't be trusted until they agree with a human who knows what excellent looks like. Until then every Academy result is advisory.

## The set
- **30 responses**, built by `node academy/tools/calibrate.js build <reports…> --n 30`.
- **Sources:**
  - the 16 baseline responses (`sample-baseline.json`, production prompt);
  - responses from the v1.1 regression-baseline and candidate runs.
- **Picked round-robin by case,** so every case and both prompt versions appear, and good and bad replies are both represented.
- **Only responses both judges graded** are eligible, so each item has a Claude label, a GPT label and a merged label to compare.
- **Files (`academy/calibration/`):**
  - `set_v1.json`: responses plus sealed judge labels. The human does not open it before labeling.
  - `packet_v1.md`: the **blind** labeling packet, with each case's situation, context and Amanda's verbatim reply. No judge verdicts.
  - `labels_v1.json`: the blank human labels.

## What the human labels (per response)
- `expertise`, `judgment`, `relationship`, `execution`: each **pass | needs_review | fail**, judged independently. Verdicts only, never wording.
- `critical_failures`: the codes they see (catalog in `academy/lib/critical.js`).
- `would_a_board_member_enjoy_this`: yes / no / mixed. This is the "does she sound like someone you'd enjoy working with" question, and it isn't reduced to a score.
- `notes`: optional; becomes lesson material.

Suggested labeler: Ed, with about 60 to 90 minutes for 30 items. A second labeler on 10 of the items measures human-to-human agreement, which is the realistic ceiling.

## What is reported (`calibrate.js score` → `calibration_report_v1.json`)

**Per dimension,** for Claude, GPT and the merged verdict:
- exact agreement with the human, and Cohen's kappa (three classes);
- pass-vs-not agreement;
- **false positives:** a judge flags a problem the human didn't see;
- **false negatives:** a judge passes what the human flagged;
- **severe misses:** a judge says pass where the human says fail.

**Per critical-failure code:** true positives, false positives and false negatives, per judge and for the merged verdict.

**Judge vs judge:** agreement and kappa per dimension, plus a list of every disagreement next to the human label, which shows which judge was right in each area.

## Decision rules after scoring (proposed)
- **Trust a dimension's automatic verdict** only when the merged verdict has kappa ≥ 0.6 against the human and zero severe misses on critical items.
- **Otherwise that dimension stays needs_review** for a human to decide, and the rubric wording for it gets revised. Tune the **definitions** (what counts as fail), never toward particular phrasing.
- **Drop a judge from a dimension** if it's consistently worse than the other there, and keep two-provider judging where both add signal.
- **Re-run the set** after any rubric or judge-model change. The calibration set is itself versioned (v1, v2…) and never edited in place.
