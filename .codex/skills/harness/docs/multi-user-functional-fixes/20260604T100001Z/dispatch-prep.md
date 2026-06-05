# Dispatch Preparation

## Architect dispatch readiness

The PM is waiting for explicit CONFIRM_REQ from the user before dispatching architect. Once confirmed, the architect should design fixes for all four defects from the prior test report.

## Source reports

- `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/review.md`
- `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/tests.md`
- Current fix requirements: `.codex/skills/harness/docs/multi-user-functional-fixes/20260604T100001Z/requirements.md`

## Defect-to-code map

### 1. Container create queued / outbox command pending

Evidence:

- New container creates stayed operation `queued`, command `pending`, `attempts: 0`.
- Affected command kind: `AgentCommandKind.ContainerApplySpec`.

Relevant files:

- `packages/backend/src/containers/containers.controller.ts`
- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/operations/operations.service.ts`
- `packages/backend/src/operations/operation-orchestrator.service.ts`
- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- `packages/backend/src/operations/operations.module.ts`
- `packages/backend/src/app.module.ts`
- Existing tests:
  - `packages/backend/src/containers/__tests__/container-create-durable.test.ts`
  - `packages/backend/src/operations/__tests__/operations.service.test.ts`

Intake notes:

- `ContainersService.createContainer()` calls `OperationsService.dispatchAgentCommand()` with `ContainerApplySpec`.
- `OperationOrchestratorService.createAgentCommand()` creates `OperationEntity` queued and `AgentCommandOutboxEntity` pending.
- `AgentCommandOutboxWorkerService.onModuleInit()` starts a timer that calls `processBatch(1)`.
- Architect should identify whether this is a worker activation/module-provider issue, due-command query issue, transaction/lock issue, agent-online classification issue, or runtime deployment issue. Design should include a deterministic unit/integration test that would fail when commands stay pending with an online agent.

### 2. Invalid SSH public key accepted

Evidence:

- `POST /api/users/:id/ssh-keys` accepted `keyText: "not-an-ssh-public-key"` with `201`.

Relevant files:

- `packages/common/src/protocol/rest-schema.ts`
- `packages/backend/src/users/users.controller.ts`
- `packages/backend/src/users/users.service.ts`
- Existing related tests:
  - `packages/common/src/__tests__/protocol.test.ts`
  - `packages/backend/src/containers/__tests__/container-ssh-reconcile-tasks.test.ts`

Intake notes:

- `zAddSshKeyRequest.keyText` currently only requires non-empty string.
- `UsersService.addSshKey()` trims and persists directly, then enqueues SSH sync.
- Design should specify accepted OpenSSH public key formats and reject malformed text with `400`.

### 3. Image detail leaks ungranted metadata

Evidence:

- `/api/images` and `/me/access` excluded an image, but `GET /api/images/:id` returned `200`.

Relevant files:

- `packages/backend/src/images/images.controller.ts`
- `packages/backend/src/images/images.service.ts`
- `packages/backend/src/access/access-resolver.service.ts`
- `packages/backend/src/groups/groups.service.ts`
- Existing related tests:
  - search for image grant/access tests under `packages/backend/src/**/__tests__`.

Intake notes:

- `ImagesController.get()` already calls `AccessResolverService.isImageAccessibleForUser()`.
- `isImageAccessibleForUser()` currently returns true if any `imageGrants` set contains the image ID, without intersecting with effective `serverGrants`.
- `findAccessibleForUser()` and `/me/access` only expose images through accessible servers, so detail should use the same effective-access semantics.

### 4. Ordinary user direct `/users` route renders management UI

Evidence:

- Sidebar hides the Users nav item, but direct route renders `用户管理` and `添加用户`.

Relevant files:

- `packages/frontend/src/routes/users/index.tsx`
- `packages/frontend/src/pages/users-page.tsx`
- `packages/frontend/src/components/layout/app-layout.tsx`
- `packages/frontend/src/routes/__root.tsx`
- Existing visual/e2e:
  - `packages/frontend/e2e/persona-routes.spec.ts`
  - `packages/frontend/e2e/ROUTES.md`

Intake notes:

- Route lazy-loads `UsersPage` with no capability guard.
- `UsersPage` renders controls before local capability checks.
- Design should decide between route-level redirect/access-denied, a reusable capability guard, and/or page-level guard. Since rendered frontend changes are expected, visual checks and user visual acceptance are required.

## Required acceptance criteria for design

1. Valid container create against an online agent is dispatched past pending/queued; tests cover the outbox worker dispatch path.
2. Invalid SSH public keys are rejected with `400`; valid keys are accepted.
3. Image detail access follows effective server+image grant semantics.
4. Unauthorized `/users` direct navigation does not render management controls.
5. Unit/integration tests cover backend regressions.
6. Frontend route/page behavior is covered by Playwright or equivalent e2e/visual test, with `ROUTES.md` updated if coverage expands.
7. Full project checks and visual checks are part of final DoD.
