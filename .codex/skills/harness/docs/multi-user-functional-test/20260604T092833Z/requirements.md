# Multi-user Functional Test

## Original request

启动多个测试 subagent，模拟管理员、多个普通用户进行操作，测试系统的各项功能，包括用户、容器、挂载、配额、ssh 等功能。所有测试执行完后，整理出问题报告。已有运行在 5173 的服务。

## Scope

- Target service: `http://localhost:5173` frontend, with backend API expected behind the running local stack.
- Mode: black-box / end-to-end exploratory testing using multiple concurrent tester agents.
- Personas:
  - Administrator.
  - Multiple regular users.
- Functional areas:
  - Authentication and current-user behavior.
  - User management, groups, and grants.
  - Servers/images visibility as relevant to grants.
  - Container creation and lifecycle operations.
  - Mount sources / data directories / container mounts.
  - Quota behavior and quota visibility.
  - SSH key and container SSH behavior.
- Output: consolidated issue report with evidence, impact, reproduction notes, and residual coverage gaps.

## Out of scope

- Product source edits.
- Test suite source edits unless an agent needs a temporary artifact under the session record.
- Restarting or rebuilding the already-running service unless testing is blocked.
- Destructive cleanup of remote hosts or production-like data without explicit instruction.

## Acceptance criteria

1. Multiple tester subagents exercise the system concurrently using distinct persona/lane scopes.
2. Admin, ordinary user, container, mount, quota, and SSH behaviors are covered as far as the running environment allows.
3. Failures and suspected defects include concrete reproduction steps and observed vs expected behavior.
4. Blockers and untested areas are explicitly called out rather than silently omitted.
5. A final consolidated problem report is written and summarized to the user.

## Gate handling

This is a test/report-only request with no planned product source change. DESIGN, IMPLEMENT, visual acceptance, and full source review are skipped. CONFIRM_REQ is treated as already satisfied by the explicit user instruction to launch multiple testing subagents against the running service.
