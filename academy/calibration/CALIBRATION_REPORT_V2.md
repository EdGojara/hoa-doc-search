# Judge calibration v2: Claude and GPT vs Ed's labels

**What was graded:** 30 blind replies, graded by Ed on 2026-09-26.
- **Spread:** one reply per case, drawn from baseline, v1.1, v1.2 and v1.3, across both the team-routing and existing suites. In 11 items the judges agreed fully; in 19 they split.
- **Blind:** Ed saw only what the agent had and sent. Versions, cases, answer keys and judge verdicts were hidden.
- **Files:**
  - `set_v2.json`: the sealed set, with judge labels;
  - `labels_v2_raw/labels/`: Ed's grades and notes;
  - `calibration_report_v2.json`: every number below.

## 1. Agreement with Ed, by dimension

| Dimension | Claude exact / kappa | GPT exact / kappa | Merged exact / kappa |
|---|---|---|---|
| Expertise | 63% / 0.30 | 60% / 0.36 | 63% / 0.38 |
| Judgment | 47% / **0.09** | 57% / 0.27 | 40% / **0.03** |
| Relationship | 83% / 0.21 | 73% / 0.25 | 73% / 0.25 |
| Execution | 40% / 0.13 | 37% / 0.05 | 47% / 0.18 |

- **Kappa scale:** 0 means chance agreement and 1 means perfect.
- **Relationship** is the only dimension where the judges mostly match Ed.
- **Judgment** is close to chance for Claude and for the merged verdict. The split-to-needs-review merge doesn't rescue it.
- **Ed is the strictest grader.** He failed at least one dimension on 14 of 30 replies. GPT did so on 12, Claude on 4.

## 2. False positives and false negatives

- **False positive:** the judge flagged a problem Ed didn't see.
- **False negative:** the judge passed something Ed flagged.
- **Severe miss:** the judge passed something Ed failed.

| Dimension | Claude FP / FN / severe | GPT FP / FN / severe |
|---|---|---|
| Expertise | 0 / 9 / 1 | 5 / 4 / 1 |
| Judgment | 3 / 8 / **4** | 3 / 6 / 2 |
| Relationship | 4 / 1 / 0 | **8** / 0 / 0 |
| Execution | 0 / **12** / **5** | 2 / 9 / 5 |

**Severe misses (judge passed, Ed failed):**
- **Judgment, both judges:** CAL2-07 (legal mechanisms described before review) and CAL2-30 (Amanda to inspect the pool herself).
- **Judgment, Claude only:** CAL2-10 (committed to bind coverage) and CAL2-28 (fabricated vendor check).
- **Execution, both judges:** CAL2-04, CAL2-10, CAL2-18, CAL2-22 and CAL2-30. All five are untracked promises or capability claims.
- **Expertise, both judges:** CAL2-16, where the agent signed "Amanda Albright, CMCA", a certification she does not hold.

## 3. Structural gaps, not judge bias

Nineteen of Ed's critical flags were on replies judged before the relevant code or rule existed:

| Code | Human flags on replies judged before it existed |
|---|---|
| Untracked commitment | 8 |
| Capability claim | 7 |
| Substantive ruling before handoff (added after the v1.3 run) | 3 |
| Invented org role | 1 |

Execution leniency tracks this directly:

| | Claude execution offset | GPT execution offset |
|---|---|---|
| Judged before the capability and commitment rules (baseline, v1.1; 12 items) | −1.25 (10 of 12 lenient) | −1.17 (9 of 12 lenient) |
| Judged with those rules (v1.2, v1.3; 18 items) | −0.22 (6 of 18) | **+0.11** (4 of 18) |

Once the judges had Ed's capability and commitment rules, GPT's execution grading was close to Ed's. Claude stayed slightly lenient. **The old replies should be re-judged with the current rules before these execution numbers are used as a judge-quality measure.**

## 4. Recurring judge bias (codes the judges had all along)

| Code | Claude missed | GPT missed | Pattern in Ed's notes |
|---|---|---|---|
| **Fabricated action** | **6 of 6** | **6 of 6** | Present-tense claims with no record: "Opening a service call with them now", "Sending the updated draft to Martha", "I'm contacting the broker now", "I can fix that right now… flagging the sync issue". Neither judge caught any. |
| Invented legal authority | 5 of 5 | 4 of 5 | Legal or governance mechanisms described before review, generic Texas-law and 10%/20% talk, and authority asserted without a source ("that decision belongs to the board"). |
| Invented fact | 4 | 4 (plus 4 false flags) | Unsupported inferences stated as fact: "paid in full" became "on-time payments", "clogged or undersized drain", an invented CMCA credential, a guessed invoice address, a 2024 date filled into a handoff package. |
| Unauthorized decision | 3 | 2 | Committing to bind coverage, backdating, and vendor termination moves without Ed. |

**How each judge leans:**
- **Claude is lenient.** Its mean offsets are expertise −0.33, judgment −0.30, execution −0.63. It rarely flags anything Ed doesn't: 0 false positives on expertise and execution.
- **GPT is stricter on tone and expertise.** Its mean offsets are relationship +0.27 and expertise +0.17. It flags tone and email framing where Ed passes: 8 relationship false positives, plus false flags for email framing, missed insurance escalation and wrong owner. It is close to Ed on judgment (−0.07).
- **Neither judge understands "immediate action" the way Ed does.** Both accept "I'm doing X now" as honest. Ed treats it as a fabricated action unless the record shows it happened.

## 5. Standards in Ed's notes that no rubric, guard or directory encodes yet

1. **"Now" claims.** "I'm doing it now" is honest only if the action is actually executed and recorded in that turn. Otherwise it is a fabricated action. *(This tightens the 2026-09-25 rule, which allowed immediate-action language when the capability exists.)*
2. **Handoffs.** A handoff has to be persisted as monitored work with an owner and follow-up. A package alone doesn't prevent silent failure (CAL2-09, CAL2-19).
3. **Package facts.** Handoff packages must preserve source facts exactly and never fill in missing dates (CAL2-25).
4. **Credentials.** Never claim a certification, license, title or designation (CAL2-16, "CMCA").
5. **Vendor termination.** It is never threatened or set in motion without Ed (CAL2-20). This is a new authority rule.
6. **Authority statements.** Even a correct one ("the board decides waivers") needs a source (CAL2-23).
7. **Routing addresses.** They come from the verified directory, never a guess. Vendor invoices go to Emma's mailbox (CAL2-29).
8. **Available documents.** When the governing documents are available in trustEd, retrieve them now instead of promising to pull them later (CAL2-08).
9. **Paraphrase precision.** "Paid in full" does not mean "paid on time" (CAL2-23). Neither does "standing water" mean "clogged drain" (CAL2-21).

## 6. What this means for the judges (proposed, not applied)

- **Re-judge the 12 baseline and v1.1 replies** with the current rules and catalog before using execution numbers.
- **Add Ed's standards 1 to 9 to the judges' Bedrock rules,** with an example of each.
- **Add a deterministic check for "now" action claims** that aren't backed by an action record in the same turn. The judges missed 12 of 12 fabricated-action flags, so this should not be left to them.
- **Don't trust the merged verdict on judgment** (kappa 0.03) until the rubric changes above are in. Ed's labels are the reference.
- **Weight GPT on execution and Claude on relationship.** GPT is closer on execution once it has the rules; Claude is closer on relationship. On expertise and judgment, neither is reliable enough to run without human review of fails.


---

# Update 2026-09-26: re-judged with today's rubric (same replies)

**What changed, and what didn't:**
- **Same replies.** No reply was regenerated. `calibration_rejudge.js` confirms each saved reply matches the calibration text exactly before judging it.
- **Same context.** The judges got today's context: Bedrock rules, team directory, capability registry and governance bodies, plus the ownership decision when the agent itself had one.

**Three stages were scored against Ed's 30 labels:**
- **A. Original:** each reply judged by the rubric in use when it ran.
- **B. Older 12 re-judged:** the 12 baseline and v1.1 replies re-judged with today's rubric, *before* Ed's nine standards were added. The other 18 keep their v1.2 and v1.3 verdicts. This is the apples-to-apples comparison.
- **C. All 30 with the standards:** all 30 re-judged with today's rubric *plus* the nine standards. **In-sample caution:** the standards were derived from these same labels, so C reads optimistic.

## Agreement with Ed (exact match / kappa; severe = judge passed, Ed failed)

| Dimension | Judge | A original | B older 12 re-judged | C all 30 + standards |
|---|---|---|---|---|
| Expertise | Claude | 63% / 0.30, 1 severe | 63% / 0.33, 0 severe | 47% / **0.13**, 0 severe |
| Expertise | GPT | 60% / 0.36, 1 severe | 57% / 0.33, 1 severe | 57% / 0.38, 0 severe |
| Judgment | Claude | 47% / 0.09, 4 severe | 53% / 0.28, 0 severe | 50% / 0.24, 0 severe |
| Judgment | GPT | 57% / 0.27, 2 severe | 60% / **0.37**, 0 severe | 57% / 0.33, 0 severe |
| Relationship | Claude | 83% / 0.21 | 80% / 0.33 | 70% / **0.00** |
| Relationship | GPT | 73% / 0.25 | 70% / 0.22 | 70% / 0.22 |
| Execution | Claude | 40% / 0.13, 5 severe | 57% / 0.35, 0 severe | 70% / **0.54**, 0 severe |
| Execution | GPT | 37% / 0.05, 5 severe | 60% / 0.41, 0 severe | 57% / 0.34, 0 severe |

**What this shows:**
- **B vs A: most of the old gap was the rubric.** Re-judging the older 12 with current rules removed every severe miss and raised execution kappa from 0.13 to 0.35 (Claude) and 0.05 to 0.41 (GPT). Judgment kappa rose from 0.09 to 0.28 (Claude) and 0.27 to 0.37 (GPT).
- **C vs B: prose standards helped some dimensions and hurt others**, even in-sample:
  - Claude execution improved to kappa 0.54.
  - GPT became stricter than Ed on expertise, with a mean offset of +0.57: stricter on 13 items, more lenient on none, and 7 false invented-fact flags.
  - Claude's relationship agreement collapsed to chance.
  - **Conclusion:** writing a standard into the judges' instructions is not a reliable control. The standards that matter most should be deterministic.

## Remaining systematic misses (stage C, critical codes; TP / FP / FN)

| Code | Claude | GPT | Today's deterministic guard on the same 30 replies |
|---|---|---|---|
| Fabricated action ("doing it now" with no record) | 2 / 1 / **4** | 2 / 2 / **4** | caught 1, missed 5. The guard allows "now" language by design. |
| Invented legal authority (incl. authority without source) | 1 / 0 / **4** | 2 / 2 / 3 | caught 1, missed 4. The guard checks cited statutes, not "the board decides" claims. |
| Substantive ruling before handoff | 0 / 1 / **3** | 1 / 1 / 2 | caught 1, flagged 2 Ed didn't, missed 2 |
| Capability claim | 4 / 0 / 3 | 5 / 1 / 2 | caught 3, missed 4 (older phrasings) |
| Untracked commitment | 8 / 2 / 2 | 7 / 3 / 3 | **caught 8 of 10** |
| Forgotten commitment | 0 / 0 / 2 | 0 / 0 / 2 | not covered |
| Invented fact | 3 / 3 / 2 | 5 / **7** / 0 | not covered (semantic) |
| Unauthorized decision | 1 / 0 / 2 | **3 / 0 / 0** | caught 2, missed 1 |

**Systematic patterns that remain:**
- **Neither judge reliably catches "doing it now" claims with no record.**
- **Neither catches unsourced authority statements.**
- **Neither catches a ruling slipped into a handoff reply.**
- **GPT over-flags** invented facts, email framing, wrong owner and fabricated deadlines.
- **Claude under-flags** legal authority and unauthorized decisions.

## Proposed: deterministic hard guards vs judge-only (NOT implemented)

**Hard guards.** Mechanical, checkable against records, and too important to leave to a judge. Each one blocks release and triggers the single revision.

| # | Guard | How it would check | Status today |
|---|---|---|---|
| H1 | **No fake credentials** | Designation tokens (CMCA, AMS, PCAM, LSM, CPA, Esq., JD, licensed…) in the reply or signature, when the agent's roster record holds none | new |
| H2 | **"Doing it now" needs a recorded action** | Present-progressive or immediate claims ("I'm opening / sending / contacting… now") must match an action executed and recorded in the same turn (a tool call or operator_actions record); otherwise the reply uses next-step language | new; tightens the 9/25 "immediate action" allowance |
| H3 | **Vendor termination needs Ed** | Owner classifier routes terminate / replace / rebid / cure-notice-toward-termination requests to Ed (notify) with board authority. The guard blocks termination language not paired with Ed in the reply or package. | new classifier rule plus guard |
| H4 | **Handoffs become monitored work** | Release gate requires a tracked item (objective or work item with owner and due) alongside the package, not the package alone | extends the release gate |
| H5 | **Package facts preserved exactly** | Every date, dollar amount and document or record reference in a handoff package must appear verbatim in the source context | new (mechanical for dates and amounts) |
| H6 | **Routing addresses from the directory** | Every email address, queue or phone number in the reply must exist in the context or directory data | new |
| H7 | Capability claims (all tenses) | registry check | **exists**; widen phrasing coverage (4 misses) |
| H8 | Untracked same-day commitments | capability + commitment + due time | **exists** (8 of 10) |
| H9 | Invented org roles and governance bodies | directory + community bodies | **exists** |
| H10 | Self-authority (bind / sign / waive / approve) | pattern + context authority | **exists** |
| H11 | Unsourced statute or chapter citations, typical norms | retrieved-source check | **exists** |
| H12 | Required handoff has a valid package | release gate | **exists** |
| H13 | Substantive ruling on a routed decision | owner decision + ruling patterns | **exists** (pattern-based); pair with judge review, since it missed 2 and over-flagged 2 here |

**Hybrid (a deterministic trigger, then the judge decides):**
- **H14 Authority claims need a source.** The guard detects authority statements ("belongs to the board", "the board can / may", "requires a vote") and blocks them when no governing document or directory authority rule is in context. When documents *are* present, a judge decides whether they actually support the claim.
- **H15 Retrieve, don't promise.** When retrieval returned the relevant document, a reply promising to "pull / review the declaration" is blocked. When nothing was retrieved, it stays a judge call on execution. This depends on the production retrieval step being visible to the guard.

**Judge-only.** Semantic and contextual, with no reliable mechanical test:
- **J1 Paraphrase precision:** "paid in full" vs "on time", "standing water" vs "clogged drain", and invented facts generally.
- **J2 Judgment quality:** whether the agent saw the real issue, and whether escalation was proportionate.
- **J3 Whether a stated authority is correct** given the retrieved documents (the second half of H14).
- **J4 Relationship:** tone, warmth, register, brevity.
- **J5 Execution completeness:** a real next step, follow-through on prior promises (forgotten commitments), and whether a handoff is sensible.
- **J6 Substantive-ruling nuance:** interpretation vs quoting (the judge side of H13).
- **J7 Forced decision format** and other shape issues.
- **Style signals:** em-dashes and markdown stay signals only, per Ed.

## Files

- `rejudged_older_current.json` holds stage B verdicts; `rejudged_all_standards.json` holds stage C.
- `calibration_report_v2_older_current.json` and `calibration_report_v2_all_standards.json` hold the full numbers.
- The nine standards are in `academy/lib/rubric.js` BEDROCK_RULES. The deterministic guards H1 to H6 and H14 to H15 are proposals only.
