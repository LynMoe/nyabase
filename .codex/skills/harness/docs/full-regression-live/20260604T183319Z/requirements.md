# Requirements — Full regression live flow

User objective: run the complete test flow with multiple subagents from real user and admin perspectives, collect bugs, fix and regress, and ensure the container control plane is smooth, elegant, and robust.

## Hard requirements

1. Use multiple subagent/testing lanes for user-level functional coverage.
2. Test ordinary user flows from a user perspective.
3. Test admin flows, including users, containers, quotas, and related controls.
4. Run existing full/local test flow where feasible: static checks, unit tests, functional/live tests, frontend/e2e when relevant.
5. Summarize discovered bugs with evidence, fix product/test defects in-scope, and rerun regression checks.
6. Review container control-plane architecture for robustness and stale legacy paths.
7. Preserve common-source invariant: no generated `.js`, `.js.map`, `.d.ts`, `.d.ts.map` under `packages/common/src/**`.

## Classification

Tier: `release` + `live-test` + `high-risk` because the request spans full regression, real local services/agents, admin/security/quota paths, and control-plane architecture.

## Execution mode

Lead acts as PM/devops/integrator. Use multiple subagents for independent user/admin/runtime/architecture lanes. Lead runs baseline checks, integrates fixes, and performs final regression.
