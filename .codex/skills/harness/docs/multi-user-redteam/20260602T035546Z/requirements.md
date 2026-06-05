# Requirements

## Original user objective

根据 `TEST_DEPLOY.md` 跟 `TEST_OUTLINE.md`，进行项目的完整测试。着重测试多用户、多镜像、多容器、多种配额限制下的操作、边界情况、限制生效及是否稳定。先构建好环境，然后起多个 subagent 从用户态使用整个系统；需要至少测试五个用户。测试时 subagent 只拥有用户账号，进行各种操作，模拟有技术背景的红队用户对系统进行测试。发现问题后记录、规划并修复，然后重复循环。遇到决策点，选择最优雅、可维护的方式，无需询问用户。进行过程中维护文档完整性，确保可追溯可重复，也要确保文档言简意赅。

## Scope

Included:

- Reuse `TEST_DEPLOY.md` as the deployment runbook and `TEST_OUTLINE.md` as the test coverage source.
- Treat the prior completed `test-deploy-local-agents/20260601T162323Z` session as infrastructure baseline evidence, but do not treat it as sufficient for this stronger multi-user red-team objective.
- Verify current local stack health before user-state testing: VictoriaMetrics, backend, frontend, CPU agent, GPU agent, and common-src artifact guard.
- Run user-state tests with at least five distinct non-admin users, each using only its own user credentials or user-created API token after admin-only setup is complete.
- Cover multi-image, multi-container, CPU/memory/disk/GPU quota limits, authorization boundaries, cross-user isolation, concurrent operations, lifecycle stability, cleanup, audit, and metrics visibility.
- Record every test batch with run id, exact commands/procedures, status, evidence, cleanup, and remaining gaps.
- Route product failures through design, implementation, test, and review loops, then rerun the affected red-team scenarios.

Excluded unless directly required by a discovered failure:

- Production hardening unrelated to test-observed behavior.
- Permanent remote host service changes outside documented nyabase test paths.
- Asking the user for decisions; this objective explicitly instructs autonomous maintainable choices.

## Constraints and Context

- Workspace root: `/root/nyabase`.
- Session id: `20260602T035546Z`.
- Local directory has no `.git` metadata; evidence must come from file state, runtime behavior, command output, and harness records.
- Project invariant: no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` under `packages/common/src/**`.
- Existing completed baseline session: `.codex/skills/harness/docs/test-deploy-local-agents/20260601T162323Z/`.
- User explicitly requested multi-subagent execution and no interactive decision prompts; CONFIRM_REQ and CONFIRM_DESIGN are recorded as auto-confirmed for this continuation.

## Acceptance Criteria

1. The current test environment is healthy: VM, backend, frontend, CPU agent, GPU agent, and common-src artifact guard all pass current probes.
2. A concise, repeatable multi-user red-team test design exists and maps `TEST_OUTLINE.md` coverage to executable batches.
3. At least five distinct non-admin users are tested from user state only after setup, and their credentials/tokens are not given admin capabilities.
4. Multi-image access is tested with at least three image records, including allowed, disallowed, inactive, and deleted/deactivated cases.
5. Multi-container operations are tested across at least five users with create/list/detail/stats/start/stop/restart/delete/force-delete where supported and with cleanup residual scans.
6. CPU, memory, disk, and GPU quota limits are tested for below-limit, exact-boundary, over-limit, and remaining-quota exhaustion cases.
7. Cross-user isolation is tested for containers, data directories/local mounts, remote mounts, metrics queries, API tokens, SSH keys, and forbidden management APIs.
8. Concurrent or near-concurrent operations are tested for duplicate IP allocation, quota races, lifecycle races, and stable state reconciliation.
9. Metrics and audit evidence are checked for successful and rejected user operations where product semantics require records.
10. Every discovered product failure is documented, planned, fixed by the appropriate role, retested, and reviewed; unresolved items must have current blocker evidence.
11. `bash scripts/check.sh` passes after any code changes; visual checks run if rendered frontend output changes.
12. Session records remain complete and concise: `requirements.md`, `design.md`, `implementation.md` if code changes occur, `tests.md`, and `review.md`.

## Gate Notes

- CONFIRM_REQ: auto-confirmed by the active objective and continuation instruction. The user explicitly asked not to stop at decision points and to choose maintainable defaults.
- CONFIRM_DESIGN: will be auto-confirmed for the same reason after the architect creates the design, unless the design reports a true blocker.
