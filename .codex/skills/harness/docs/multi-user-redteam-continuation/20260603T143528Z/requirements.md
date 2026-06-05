# Requirements

## Original Objective

Continue the active objective: use `TEST_DEPLOY.md` and `TEST_OUTLINE.md` to perform complete project testing, emphasizing multi-user, multi-image, multi-container, quota limits, boundary cases, enforcement, and stability. Build the environment first, run multiple subagents from user state with at least five non-admin users, simulate technically capable red-team users, document findings, fix product issues, and repeat until verified. First derive current test rules from code because `TEST_OUTLINE.md` may be stale.

## Continuation Scope

Included:

- Treat `.codex/skills/harness/docs/multi-user-redteam/20260602T035546Z/` as prior evidence, not as proof that the current state on 2026-06-03 is complete.
- Reconstruct the current executable coverage and gaps from source, tests, `TEST_DEPLOY.md`, `TEST_OUTLINE.md`, and prior reports.
- Re-verify current environment health before any new user-state run.
- Re-run or add focused live tests where evidence is stale, missing, or too narrow for the original objective.
- If failures are found, route product/test/infra fixes through the role loop and update records.
- Keep records concise and reproducible; do not record raw secrets.

Excluded unless required by a discovered failure:

- Broad cleanup of unrelated resources.
- Permanent remote host changes outside `TEST_DEPLOY.md`.
- Frontend visual work unless a tested failure touches rendered UI.

## Acceptance Criteria

1. A current test-rule/gap analysis exists, derived from the code and current tests rather than only `TEST_OUTLINE.md`.
2. Current deployment health is proven for backend, frontend, VictoriaMetrics, CPU agent, GPU agent, managed Docker/quota basics, and the common-src artifact invariant.
3. Any necessary continuation test run uses at least five non-admin user personas or explains with strong evidence why an existing current run still satisfies that requirement.
4. Multi-image, multi-container, CPU/memory/disk/GPU quota boundary, cross-user isolation, concurrency/stability, metrics/audit, data-dir/mount, cleanup, and residual-scan requirements are each proven or explicitly listed as remaining gaps with evidence.
5. Product failures are fixed and retested through focused reruns plus `bash scripts/check.sh`; frontend visual checks run if rendered frontend output changes.
6. Session docs in this directory are complete enough to reproduce the continuation: requirements, design/rule analysis, tests, implementation if changed, and review.

## Gate Notes

The original objective explicitly requested autonomous decisions without asking at decision points. CONFIRM_REQ and CONFIRM_DESIGN are therefore treated as already confirmed for this continuation. No frontend visual gate is needed unless this continuation changes rendered frontend output.
