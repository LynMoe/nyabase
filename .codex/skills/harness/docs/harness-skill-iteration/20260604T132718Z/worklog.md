# Harness Skill Iteration Worklog

## Risk Tier

`high-risk` harness-maintenance task. The change edits the orchestration contract itself, but not product runtime code.

## Evidence Summary

Subagents and local inspection found the same recurring issues:

| Problem | Evidence |
|---------|----------|
| Forced user confirmations conflicted with user intent | `/root/.codex/history.jsonl` contains repeated "确认", "后续不需要我确认，直接进行", and "不用设计，不用问我意见". Historical records also used `CONFIRM_REQ`/`CONFIRM_DESIGN` auto-confirm to work around the old rules. |
| Excessive subagent splitting | Codex state showed one lifecycle architecture thread spawning 66 child threads and about 59.6M tokens. User explicitly said "现在分太细了...最多再起两轮 subagent...不要像现在这样逐模块修改". |
| Role boundaries caused ping-pong | Historical `implementation.md` files repeatedly said developer could not run builds/tests and live failures would persist until devops rebuilt/redeployed, causing developer -> devops -> tester loops. |
| Visual acceptance relied too much on humans | Old rules required user `VISUAL_ACCEPTANCE` for any visual change even when tester/reviewer could inspect screenshots. User explicitly requested visual review be model-owned by default. |
| Session docs grew too large | Several `design.md`/`tests.md` records reached thousands of lines, mixing useful evidence with repeated command output and serial handoff text. |
| Runtime drift looked like product failure | Prior live sessions repeatedly hit wrong DB paths, stale `dist`, stale agent binaries, token/server mismatch, and remote cleanup residuals. |

## Decisions

1. Replaced mandatory serial state machine with risk-based flow: `INTAKE -> CLASSIFY -> CLARIFY? -> DESIGN? -> EXECUTE -> VERIFY -> VISUAL_EVIDENCE? -> USER_DECISION? -> REVIEW? -> DONE`.
2. Changed the main agent from PM-only to lead engineer. The lead may execute task-scoped edits and focused verification directly.
3. Added `roles/implementer.md` as the default cohesive code+test lane for normal tasks.
4. Kept strict `developer`, `tester`, `devops`, `architect`, and `reviewer` lanes for high-risk, independent verification, runtime, or review scenarios.
5. Converted `CONFIRM_REQ`, `CONFIRM_DESIGN`, and `VISUAL_ACCEPTANCE` into conditional user decision gates.
6. Made model-owned visual review the default: capture/open screenshots, judge objective criteria, promote baselines only after fresh render judgment.
7. Added flow budget rules: normal tasks target 0-2 subagents and pause at 4; high-risk/live tasks pause at 8; after 2 fail/fix loops, batch root causes.
8. Added live-test preflight requirements for DB path, process/env, ports, agent identity/tokens, artifact freshness, service connectivity, and cleanup ledger.
9. Reworked DoD into risk tiers so small tasks do not inherit release-level requirements.
10. Made harness proposals non-blocking for ordinary product DONE.

## Files Changed

- `.codex/skills/harness/SKILL.md`
- `.codex/skills/harness/workflow.md`
- `.codex/skills/harness/roles/pm.md`
- `.codex/skills/harness/roles/architect.md`
- `.codex/skills/harness/roles/implementer.md`
- `.codex/skills/harness/roles/developer.md`
- `.codex/skills/harness/roles/tester.md`
- `.codex/skills/harness/roles/devops.md`
- `.codex/skills/harness/roles/reviewer.md`
- `.codex/skills/harness/roles/doc-writer.md`
- `.codex/skills/harness/roles/explorer.md`
- `.codex/skills/harness/templates/user-confirmation.md`
- `.codex/skills/harness/templates/task-dispatch.md`
- `.codex/skills/harness/templates/test-report.md`
- `.codex/skills/harness/templates/review-report.md`
- `.codex/skills/harness/templates/proposal.md`
- `.codex/skills/harness/checklists/definition-of-done.md`
- `.codex/skills/harness/docs/harness-skill-iteration/20260604T132718Z/requirements.md`
- `.codex/skills/harness/docs/harness-skill-iteration/20260604T132718Z/worklog.md`

## Verification

- Searched non-history harness files for old hard-gate language: `CONFIRM_REQ`, `CONFIRM_DESIGN`, `VISUAL_ACCEPTANCE`, `AskQuestion`, `MUST NOT dispatch`, `PM-only`, and proposal-blocking phrases. Remaining relevant occurrences are conditional gate names or historical session records.
- Searched mandatory/required language in new control files to confirm it now applies to risk triggers, objective visual review, invariants, or safety checks.
- Counted rewritten role/template/checklist files: 747 total lines, replacing the previous heavier role/template/checklist contract.
- Ran `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`; no generated common source artifacts were found.

## Residual Risk

- Historical session records still contain old gate terminology; they were intentionally not rewritten.
- Future tasks should validate the new flow in practice and tune thresholds if the 4/8 subagent budget is too strict or too loose.

## Second Audit Pass

The user requested more subagents using `GPT-5.3-Codex-Spark`. The available `spawn_agent` schema in this environment does not expose a `model` field, so six additional agents were launched with the available inherited model and assigned independent readonly audit lanes.

| Lane | Agent | Key finding |
|------|-------|-------------|
| confirmations/gates | `019e92df-b77d-7a33-b660-1adf62bcad69` | Mandatory confirmation and visual gates persisted after the user asked to proceed autonomously; `PENDING_USER_REVIEW` was treated as automatic user approval. |
| role/tool adherence | `019e92df-d5f2-7a13-ab1d-7cbb7c296dd6` | Old PM-only and strict developer/tester/devops separation caused ping-pong; direct lead execution should be explicit as `lead as implementer/devops`. |
| visual evidence | `019e92df-f455-7122-bf81-064e33738758` | Models did inspect screenshots, but fresh actual/diff artifacts were often transient; green snapshots proved determinism, not quality. |
| scope drift | `019e92e0-1384-7da1-85bb-c5fd3946a1bd` | No strong evidence of report-only silently becoming repair, but simple delivery tasks were over-designed and run/deploy tasks lacked final usability proof. |
| runtime/env drift | `019e92e0-2bc5-7183-92e5-67fa2e0e5766` | Wrong DB, schema drift, stale dist/binaries, token/server mismatch, ports, and cleanup residuals repeatedly masqueraded as product bugs. |
| reply quality | `019e92e0-7818-7993-a65b-c782084f0eba` | Final replies sometimes used broad `GREEN/PASS/covered` labels despite skipped checks, repeated blocked states, and treated process docs as progress. |

## Second-Pass Decisions

1. Added a simple delivery fast path for "just X", "no design", "write/build/run this", and equivalent requests.
2. Made hard user requirements explicit: designs and summaries cannot move requested deliverables to non-goals without a concrete blocker.
3. Required direct lead execution identity to be recorded when the main agent edits or runs as an execution lane.
4. Clarified that subagent `PENDING_USER_REVIEW` is advisory; only the lead can trigger a user decision gate.
5. Strengthened report-only handling: findings-only output, no silent product repair.
6. Added scoped status wording: `GREEN`, `PASS`, `DONE`, `covered`, and `complete` must name what passed, while skipped checks remain visible.
7. Added blocked-message deduplication: the same blocked reason should be reported once unless new evidence appears.
8. Added visual inspection log requirements, copying fresh actual/diff artifacts out of `.test-results`, and separating determinism, quality, and coverage.
9. Added runtime fingerprint and cleanup ledger templates for live/deploy tasks.
10. Expanded failure taxonomy with concrete subreasons for env drift, stale builds, fixture/baseline bugs, cleanup blockers, infra preconditions, and convergence timeouts.

## Second-Pass Files Changed

- `.codex/skills/harness/SKILL.md`
- `.codex/skills/harness/workflow.md`
- `.codex/skills/harness/roles/pm.md`
- `.codex/skills/harness/roles/architect.md`
- `.codex/skills/harness/roles/implementer.md`
- `.codex/skills/harness/roles/developer.md`
- `.codex/skills/harness/roles/tester.md`
- `.codex/skills/harness/roles/devops.md`
- `.codex/skills/harness/roles/reviewer.md`
- `.codex/skills/harness/templates/user-confirmation.md`
- `.codex/skills/harness/templates/task-dispatch.md`
- `.codex/skills/harness/templates/test-report.md`
- `.codex/skills/harness/templates/review-report.md`
- `.codex/skills/harness/templates/visual-inspection-log.md`
- `.codex/skills/harness/templates/runtime-fingerprint.md`
- `.codex/skills/harness/templates/cleanup-ledger.md`
- `.codex/skills/harness/checklists/definition-of-done.md`
- `.codex/skills/harness/docs/harness-skill-iteration/20260604T132718Z/worklog.md`

## Second-Pass Verification

- Waited for all six audit agents to complete and closed them.
- Confirmed the local multi-agent tool exposed no `model` parameter, so `GPT-5.3-Codex-Spark` could not be selected explicitly in this environment.
- Searched control files for old hard-gate terms: `CONFIRM_REQ`, `CONFIRM_DESIGN`, `AskQuestion`, `MUST NOT dispatch`, and `All pending proposals`; no matches remain.
- Checked `PENDING_USER_REVIEW` occurrences; all remaining mentions state that it is advisory and not an automatic user gate.
- Verified new template files exist: `visual-inspection-log.md`, `runtime-fingerprint.md`, and `cleanup-ledger.md`.
- Verified SKILL/role references to the new templates resolve to existing files.
- Counted active harness control files: 1294 total lines across `SKILL.md`, `workflow.md`, roles, templates, and DoD.
- Ran `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`; no generated common source artifacts were found.

## Rule Clarity Review

The user requested a review of the current harness rules for clarity, non-redundancy, lack of contradictions, practical flow, and role necessity.

Findings:

- `SKILL.md`, `workflow.md`, `roles/pm.md`, and DoD repeated the same gate, visual, report-only, and status-label rules.
- `developer` and `implementer` overlapped enough that future agents could choose the fragmented strict lane for normal work.
- `tester` and `devops` both mentioned broad checks and live/runtime evidence, making ownership ambiguous.
- Some legacy wording such as `USER_VISUAL_ACCEPTANCE` could imply a hard user gate even though the new rule is conditional.
- `doc-writer` and `explorer` still referenced old tool names, which was unnecessary and environment-specific.

Changes made:

1. Rewrote `SKILL.md` as the entrypoint: core principles, start checklist, role map, canonical file links, documentation rules, and final-response rule.
2. Rewrote `workflow.md` into eight executable sections: intake, classify, plan/design, execute, verify, live cleanup, visual review, review/done.
3. Shortened `roles/pm.md` so the lead role owns outcome and delegation without duplicating the full workflow.
4. Reframed `implementer` as the default normal code+test lane and `developer` as a strict product-code lane only for independence.
5. Reframed `tester` as behavior/test/visual evidence owner and `devops` as runtime/build/deploy/environment owner.
6. Simplified `doc-writer` and `explorer` to role boundaries instead of tool lists.
7. Rewrote DoD as a concise final checklist instead of another workflow explanation.
8. Renamed `USER_VISUAL_ACCEPTANCE` template section to `SUBJECTIVE_VISUAL_DECISION`.

Verification:

- Active harness control files now total 993 lines, down from 1294 after the second pass.
- Searched control files for `PM-only`, `CONFIRM_REQ`, `CONFIRM_DESIGN`, `VISUAL_ACCEPTANCE`, `MUST NOT dispatch`, `AskQuestion`, and `All pending proposals`; no matches remain.
- Checked `PENDING_USER_REVIEW` and `User decision needed`; remaining occurrences are advisory/conditional gate language only.
- Ran the common-source artifact guard; no generated files were found under `packages/common/src/**`.
