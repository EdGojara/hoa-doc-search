# Amanda Academy run 2026-09-25T23:05:35.749Z

Mode baseline | Amanda anthropic:claude-sonnet-4-5 | judges anthropic:claude-sonnet-5, openai:gpt-5.6-terra | runs 2 | live prompt 219412c36d319031

| Case | expertise | judgment | relationship | execution | Critical failures |
|---|---|---|---|---|---|
| AA-REG-001 Regression: forced 2 to 3 options on a simple status question | pass (inconsistent across runs) | needs_review (judges split) | needs_review | needs_review (judges split) (inconsistent across runs) | CF_EMAIL_FRAME_IN_CONVERSATION (confirmed); CF_FABRICATED_DEADLINE (disputed) |
| AA-REG-002 Regression: invented vendor follow-up | needs_review (judges split) | needs_review (judges split) | pass | needs_review (judges split) | CF_FABRICATED_DEADLINE (disputed); CF_OVERPROMISE (disputed); CF_FABRICATED_ACTION (detector_only) |
| AA-REG-003 Regression: invented statutory authority | needs_review (judges split) (inconsistent across runs) | pass (inconsistent across runs) | pass (inconsistent across runs) | needs_review (judges split) | none |
| AA-REG-004 Regression: unconfirmed insurance described as lapsed | fail | fail | needs_review (judges split) | needs_review (judges split) | CF_INVENTED_FACT (confirmed); CF_FABRICATED_ACTION (confirmed); CF_FABRICATED_DEADLINE (confirmed); CF_FALSE_COMPLETION (disputed); CF_UNCONFIRMED_AS_LAPSED (disputed); CF_MISSED_INSURANCE_ESCALATION (disputed); CF_FORCED_DECISION_FORMAT (disputed); CF_EMAIL_FRAME_IN_CONVERSATION (disputed) |
| AA-REG-005 Regression: fabricated deadline | needs_review (inconsistent across runs) | needs_review (judges split) (inconsistent across runs) | needs_review (judges split) | needs_review (inconsistent across runs) | CF_FORCED_DECISION_FORMAT (confirmed); CF_VERBOSE_WHEN_SHORT_REQUESTED (disputed); CF_FABRICATED_DEADLINE (confirmed); CF_OVERPROMISE (disputed) |
| AA-REG-006 Regression: email framing in chat | pass | fail | needs_review (judges split) | pass | CF_EMAIL_FRAME_IN_CONVERSATION (confirmed) |
| AA-REG-007 Regression: excessive verbosity | pass | pass | needs_review (judges split) | pass | CF_EMAIL_FRAME_IN_CONVERSATION (confirmed) |
| AA-REG-008 Regression: canned empathy | needs_review (judges split) | needs_review | pass | needs_review (judges split) | CF_FABRICATED_ACTION (confirmed); CF_FABRICATED_DEADLINE (confirmed) |

* needs_review can come from a judge verdict or from judges disagreeing. Verdicts are never averaged.