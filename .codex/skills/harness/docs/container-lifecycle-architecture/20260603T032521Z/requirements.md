# Requirements

## Original Request

让架构师优化架构，系统性解决容器生命周期、数据存储、周边系统 hook、一致性和流程问题。无需考虑兼容，可以大范围重构。要求不能改变功能。

## Scope

- Produce architecture design only; no product source changes in this step.
- Preserve existing user-visible functionality:
  - container create/list/get/start/stop/restart/delete
  - container stats and exec console
  - data directory mounts, local disks, remote FS
  - Dropbear SSH enable/reconcile and SSH key sync
  - grants/access checks, quota enforcement, audit logs
  - agent reconnect/state reporting behavior
- Compatibility may be broken at schema/RPC/API internals if the migration/design keeps feature parity.
- Systematically address risks found in the prior two-agent review:
  - create/delete side-effect ordering and compensation gaps
  - in-process-only operation lock
  - stale stateCache/observer window
  - read-path SSH backfill side effect
  - unclear container mount `userId` ownership semantics
  - best-effort hooks without durable retry/status visibility
  - scattered command/reconcile/status flows

## Acceptance Criteria

1. Design defines a single authoritative lifecycle model for commands, observed runtime state, and durable desired state.
2. Design includes data model changes and migration notes, with no requirement to preserve old schema compatibility.
3. Design covers backend, agent, common protocol/RPC, frontend observation, tests, and operational rollout.
4. Design explicitly maps current features to the new architecture and states that feature parity is preserved.
5. Design identifies risks/trade-offs and a staged implementation plan.

## Non-goals

- No source implementation in this task.
- No UI redesign beyond state/progress visibility required to preserve and clarify existing workflows.
- No new container feature beyond current behavior.
