# Multi-user Functional Fixes

## Original request

启动架构师、开发、测试进行修复流程。

## User confirmation

- CONFIRM_REQ: confirmed by user after the PM requirements summary.
- Additional instruction: simplify this round's flow to improve efficiency and handoff quality while preserving required harness gates and verification.
- CONFIRM_DESIGN: confirmed by user after PM summarized `.codex/skills/harness/docs/multi-user-functional-fixes/20260604T100001Z/design.md`.
- Additional instruction after design confirmation: proceed directly through later flow without further routine confirmations.

## Source evidence

Prior multi-user black-box test session:

- `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/review.md`
- `.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/tests.md`

## Target defects

1. Container create operations remain queued and never dispatch to the online agent.
2. Invalid SSH public key text is accepted and persisted by `POST /api/users/:id/ssh-keys`.
3. `GET /api/images/:id` leaks ungranted image metadata to ordinary users.
4. Direct frontend navigation to `/users` renders user-management UI for ordinary users without `manage_users`.

## Scope

### Included

- Root-cause and fix the operation/outbox/dispatch behavior that leaves new container creates queued with pending `container.applySpec` commands and `attempts: 0`.
- Add backend SSH public-key validation for user SSH-key creation/update paths touched by the defect.
- Align image detail authorization with list/effective-access behavior.
- Add frontend route/page authorization handling for `/users` so unauthorized users see access denied or are redirected before admin controls render.
- Add/update automated tests for all four regressions.
- Run required checks, including visual checks because `packages/frontend/src/**` is expected to change.

### Excluded

- Manual cleanup of previously stuck desired container/data-dir rows unless explicitly needed for deterministic tests.
- Redesign of the entire operations architecture beyond the narrow dispatch bug.
- New product-facing documentation.
- Changing account/grant semantics beyond the reported authorization defects.

## Constraints

- Follow nyabase harness role separation: architect designs, developer edits product source, tester edits/runs tests, reviewer reviews.
- Do not leave generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` files under `packages/common/src/**`.
- Preserve existing API shapes unless the design identifies a necessary compatible error behavior change.
- Existing service on port 5173 may be used for context, but final verification must rely on deterministic repo tests/checks where possible.

## Draft acceptance criteria

1. Creating a valid container against an online server enqueues and dispatches the appropriate agent command instead of leaving operation queued with command `pending` and `attempts: 0`; tests cover the dispatch path.
2. Malformed SSH public-key text such as `not-an-ssh-public-key` is rejected with `400`, and valid public keys remain accepted.
3. Ordinary users cannot read image detail for images outside their effective image grants; authorized users/admins still can.
4. Ordinary users navigating directly to `/users` do not see user-management controls such as `添加用户`.
5. Automated backend/frontend tests cover the four regressions.
6. Required project checks pass: `bash scripts/check.sh`; visual checks pass for frontend rendered-output changes, and screenshots are available for visual acceptance if needed.

## Open questions / risks

- The container dispatch defect may involve backend operation scheduling, agent websocket delivery, or runtime environment state. Architect should identify the narrowest code-level root cause before implementation.
- The `/users` frontend fix may produce a visible access-denied state; this triggers visual test and user visual acceptance.
- Because `packages/frontend/src/**` is expected to change, final DoD requires `bash scripts/check-visual.sh` and a `VISUAL_ACCEPTANCE` user confirmation after PM shows the rendered unauthorized `/users` state screenshot.

## PM intake notes for architect

- Container create entrypoint:
  - `packages/backend/src/containers/containers.controller.ts`
  - `packages/backend/src/containers/containers.service.ts`
  - `createContainer()` calls `OperationsService.dispatchAgentCommand()` with `AgentCommandKind.ContainerApplySpec`.
  - `beforePersist` creates `ContainerEntity` with `lifecyclePhase: Creating`; outbox command starts as `AgentCommandStatus.Pending`.
- Durable operation / outbox code:
  - `packages/backend/src/operations/operations.service.ts`
  - `packages/backend/src/operations/operation-orchestrator.service.ts`
  - `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
  - `OperationsModule` provides `AgentCommandOutboxWorkerService`; architect should verify why live commands can remain `pending` / `attempts: 0` despite worker registration.
- SSH key validation:
  - `packages/common/src/protocol/rest-schema.ts` has `zAddSshKeyRequest.keyText: z.string().min(1)` only.
  - `packages/backend/src/users/users.controller.ts` parses `zAddSshKeyRequest`.
  - `packages/backend/src/users/users.service.ts` persists `keyText.trim()` and enqueues SSH sync.
- Image detail authorization:
  - `packages/backend/src/images/images.controller.ts` already calls `AccessResolverService.isImageAccessibleForUser()`.
  - `packages/backend/src/access/access-resolver.service.ts` currently checks whether any `imageGrants` set contains the image id, without requiring the same server to also be in effective `serverGrants`.
  - This likely explains why list/effective-access can filter an image while direct detail still returns `200`.
- Frontend `/users` authorization:
  - `packages/frontend/src/routes/users/index.tsx` directly lazy-loads `UsersPage`.
  - `packages/frontend/src/pages/users-page.tsx` renders management controls before any local capability guard.
  - `packages/frontend/src/components/layout/app-layout.tsx` hides nav items by capability, but direct route navigation bypasses that UI-only hiding.
