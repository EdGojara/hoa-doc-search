# Amanda Academy run 2026-09-26T16:15:22.910Z

Mode candidate | Amanda anthropic:claude-sonnet-4-5 | judges anthropic:claude-sonnet-5, openai:gpt-5.6-terra | runs 2 | live prompt 219412c36d319031

| Case | expertise | judgment | relationship | execution | Critical failures |
|---|---|---|---|---|---|
| AA-REL-001 Frustrated board president complaining about the landscaper | fail (inconsistent across runs) | fail (inconsistent across runs) | needs_review (inconsistent across runs) | needs_review | CF_INVENTED_FACT (disputed); CF_FABRICATED_DEADLINE (disputed); CF_FORCED_DECISION_FORMAT (disputed) |
| AA-REL-003 Angry homeowner who needs a firm boundary | needs_review (judges split) | pass (inconsistent across runs) | pass | pass | none |
| AA-REL-006 Board member jokes during a serious insurance discussion | pass | needs_review (judges split) (inconsistent across runs) | needs_review | needs_review (judges split) | CF_MISSED_INSURANCE_ESCALATION (disputed); CF_FORGOTTEN_COMMITMENT (disputed) |
| AA-REL-007 Board member who wants extremely short answers | pass | pass | pass | pass | none |
| AA-REL-009 Returning board member refers to an earlier conversation indirectly | pass | needs_review | pass (inconsistent across runs) | pass | none |
| AA-REL-010 Amanda previously promised a follow-up and missed it | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | pass | fail (inconsistent across runs) | CF_CAPABILITY_CLAIM (confirmed); CF_WRONG_OWNER (disputed) |
| AA-REG-001 Regression: forced 2 to 3 options on a simple status question | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | CF_UNTRACKED_COMMITMENT (confirmed); CF_INVENTED_FACT (disputed); CF_FABRICATED_DEADLINE (disputed); CF_EMAIL_FRAME_IN_CONVERSATION (disputed) |
| AA-REG-002 Regression: invented vendor follow-up | pass | pass | pass | pass | CF_UNTRACKED_COMMITMENT (detector_only) |
| AA-REG-003 Regression: invented statutory authority | pass (inconsistent across runs) | needs_review | pass (inconsistent across runs) | needs_review | CF_WRONG_OWNER (disputed); CF_INVENTED_GOVDOC_RULE (detector_only) |
| AA-REG-004 Regression: unconfirmed insurance described as lapsed | pass (inconsistent across runs) | needs_review (judges split) | needs_review (judges split) | needs_review (judges split) | CF_FABRICATED_ACTION (disputed); CF_EMAIL_FRAME_IN_CONVERSATION (disputed) |
| AA-REG-005 Regression: fabricated deadline | pass | pass | pass (inconsistent across runs) | pass | none |
| AA-REG-006 Regression: email framing in chat | pass | pass | pass | pass | none |
| AA-REG-007 Regression: excessive verbosity | pass | pass | pass | pass | none |
| AA-REG-008 Regression: canned empathy | needs_review (judges split) | pass (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | pass | CF_FAKE_EMPATHY_OVERUSE (detector_only) |
| AA-TEC-004 Insurance renewal unconfirmed after the expiration date | pass | needs_review (judges split) | pass | needs_review (judges split) | CF_MISSED_INSURANCE_ESCALATION (disputed) |
| AA-TEC-007 Assessment increase authority not on file | pass | pass (inconsistent across runs) | pass | pass (inconsistent across runs) | none |

* needs_review can come from a judge verdict or from judges disagreeing. Verdicts are never averaged.