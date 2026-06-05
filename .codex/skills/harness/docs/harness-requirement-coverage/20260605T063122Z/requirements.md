# Harness Requirement Coverage Iteration

## User Request

Improve the nyabase harness skill by studying historical development records and
Codex conversation history. The concrete failure mode is that explicit requested
coverage, especially multi-group quota/permission live testing, was not executed
but was treated as an acceptable coverage gap.

## Classification

- Mode: harness maintenance.
- Risk tier: high-risk doc/process change because it edits the operating
  contract for future implementation and testing work.

## Hard Requirements

1. Use multiple subagents to read historical conversations, harness documents,
   and current rules.
2. Identify process problems behind requirement/output mismatch, incomplete
   tests, and corner-cutting.
3. Update `.codex/skills/harness/**` so explicit user requirements cannot be
   silently narrowed to existing suites or residual risks.
4. Keep the harness practical: add enforceable checks, not a heavy serial
   process.
5. Do not change product source.

## Acceptance Criteria

| AC | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Intake requires explicit user requirements to be tracked as acceptance items before execution. | covered | `workflow.md` intake ledger rule; `SKILL.md` documentation ledger rule. |
| 2 | Test/report templates require every acceptance item to be mapped to direct evidence, skipped with a blocker, or marked as a failing coverage gap. | covered | `templates/test-report.md`, `templates/task-dispatch.md`. |
| 3 | DoD and reviewer rules fail any final `PASS`/`DONE` claim where a hard requirement is unverified without a concrete impossibility or safety blocker. | covered | `checklists/definition-of-done.md`, `roles/reviewer.md`, `templates/review-report.md`. |
| 4 | Live-test rules prohibit treating "existing suite did not cover it" as a valid boundary for a user-requested probe. | covered | `workflow.md`, `roles/tester.md`, `roles/devops.md`. |
| 5 | Historical evidence and subagent findings are summarized in the worklog. | covered | `worklog.md` evidence and subagent sections. |

## Boundaries

- No product code changes.
- No rewriting historical records.
- No destructive runtime operations.
