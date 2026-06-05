# Worklog

## Evidence Read Locally

- `/root/.codex/history.jsonl` entries 104 and 107-109 show the user explicitly
  requested multiple groups, quotas, images, subagent personas, red-team probes,
  and a complete report, then challenged why group quota/permission tests were
  not executed.
- `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/final-functional-test-report.md`
  reported "Different groups" and "Quota/grants" as partial, with open concerns
  to add group-derived grant/quota/image/mount tests.
- `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/coverage-matrix.md`
  explicitly identified missing live group personas, group-derived permissions,
  and quota-abuse cases before the final report.
- `.codex/skills/harness/docs/full-system-state-machine-test/20260605-090229/requirements.md`
  and `test-report.md` show a better pattern: requirements were enumerated and
  blockers were listed up front.
- Existing harness rules had general "hard requirements are preserved" language
  but no mandatory requirement-to-evidence ledger at intake/report/review time.

## Subagents

- Conversation-history audit: `019e9679-72f7-79b2-8c2f-54ae2d7ee3b7`.
  - Found the exact user request and later admission that existing automated
    suites were wrongly treated as the boundary.
  - Also found runtime-staleness, old API-plane, and plan-assumption failure
    patterns.
- Harness-doc audit: `019e9679-9ca3-7a51-a6a0-cc8ed90bf5a6`.
  - Found stale final reports, scope changes not reflected in requirements,
    conflicting `covered`/`partial` labels, stale artifact paths, lane-local AC
    numbering, transcript-only evidence, and missing top-level rollups.
- Rule-gap audit: `019e9679-ae35-79f2-954b-23aaf8e7bc8a`.
  - Found that current rules had broad hard-requirement language but no
    enforceable user-requested-test closure in intake, DoD, tester reports, or
    reviewer stop conditions.

## Planned Changes

1. Add a lightweight "requirements ledger" rule to intake and session records.
2. Strengthen verification and final-response language so unverified hard
   requirements block scoped PASS/DONE unless impossible/unsafe and named.
3. Update tester, implementer, developer, reviewer, dispatch, test-report,
   review-report, and DoD wording around acceptance evidence.
4. Add role lessons for the observed failure pattern.

## Files Changed

- `.codex/skills/harness/SKILL.md`
- `.codex/skills/harness/workflow.md`
- `.codex/skills/harness/checklists/definition-of-done.md`
- `.codex/skills/harness/templates/test-report.md`
- `.codex/skills/harness/templates/task-dispatch.md`
- `.codex/skills/harness/templates/review-report.md`
- `.codex/skills/harness/roles/pm.md`
- `.codex/skills/harness/roles/tester.md`
- `.codex/skills/harness/roles/implementer.md`
- `.codex/skills/harness/roles/developer.md`
- `.codex/skills/harness/roles/reviewer.md`
- `.codex/skills/harness/roles/devops.md`
- `.codex/skills/harness/lessons/tester.md`
- `.codex/skills/harness/lessons/developer.md`
- `.codex/skills/harness/docs/harness-requirement-coverage/20260605T063122Z/requirements.md`
- `.codex/skills/harness/docs/harness-requirement-coverage/20260605T063122Z/worklog.md`

## Independent Review

- Reviewer subagent `019e967e-93e6-7ac0-939d-5c010294b231` returned
  `Verdict: PASS` for the harness rule text.
- Reviewer found no blocker on the four focus areas: explicit commands/tests
  and matrix rows are required ACs; skipped hard requirements block PASS/DONE;
  stale multi-lane/transcript-only evidence has guards; the changes preserve
  the fast-path/risk-based philosophy.
- Follow-up suggestions accepted:
  - Added DevOps acceptance coverage and skipped requested-item RED/BLOCKED
    rule.
  - Updated this requirements file with AC evidence/status.

## Verification

- Searched active harness control files and lessons for old hard-gate or stale
  placeholder wording: `CONFIRM_REQ`, `CONFIRM_DESIGN`, `VISUAL_ACCEPTANCE`,
  `MUST NOT dispatch`, `AskQuestion`, `All pending proposals`, `PM-only`, and
  `(no entries yet)`; no matches.
- Searched active harness files for the new safeguards and confirmed rules exist
  for requirements ledger, user-requested probes, existing-suite boundaries,
  route/API-plane runtime evidence, runtime fingerprint refresh,
  stale/superseded reports, transcript-only evidence, and acceptance coverage.
- Ran the common-source artifact guard; output was empty.
- Confirmed `/root/nyabase` has no `.git` directory, so no standard git
  diff/status was available.
