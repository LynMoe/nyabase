# Integrated Repair Design

## Goal

Fix the four confirmed multi-user defects so container create commands dispatch reliably, SSH key input is validated, image detail access matches effective grants, and ordinary users cannot render user-management UI through direct navigation.

## Interfaces

### Durable container operation dispatch

Public API shape stays unchanged.

Before:

- `POST /api/containers` returns `{ ok: true, operationId, status: "queued" }`.
- `OperationsService.dispatchAgentCommand()` creates an `operations` row plus an `agent_command_outbox` row with `status: "pending"` and `attempts: 0`.
- `AgentCommandOutboxWorkerService.processOne()` leases a command, waits synchronously for `AgentGateway.sendCommandEnvelope()` to resolve, then clears its global `processing` flag.
- Because one online command can wait for an agent acknowledgement for up to the command timeout, every later due command can remain `pending` with `attempts: 0` even when its target agent is online. This matches the observed create operations staying queued behind the outbox worker rather than being marked `waiting_agent`.

After:

- `POST /api/containers` response remains `{ ok: true, operationId, status }`.
- Outbox scan/lease work is separated from command delivery wait. The worker should be able to schedule more due commands for different resources while an earlier command is still awaiting an acknowledgement.
- Per-resource serialization is preserved: only one command for the same `resourceKey` may be in flight at a time.
- For an online agent and a due `container.applySpec` command, the worker marks the command sent, increments command and operation attempts, sends an `agentCommand` envelope, and moves the operation past `queued`.

Implementation target in `AgentCommandOutboxWorkerService`:

- Keep `processBatch()` as the deterministic entry point, but make the `processing` guard cover only the scan/lease/schedule phase, not the whole agent acknowledgement wait.
- Track in-flight command IDs locally so the timer does not recover or reschedule commands this process already sent.
- Hold the existing DB `ResourceLockService` lock for the delivery promise, then release it in `finally`.
- Set command lease/resource-lock TTLs longer than the `sendCommandEnvelope()` acknowledgement timeout, or explicitly exclude local in-flight commands in `recoverExpiredLeases()`, so the worker does not retry its own active delivery.
- Keep terminal state changes idempotent through `OperationOrchestratorService.markCommandSucceeded()` / `markCommandFailed()`, as today.
- Optionally trigger one immediate `processBatch()` in `onModuleInit()` before the interval; this reduces startup latency but is not the main fix.

### SSH public key creation

Public endpoint shape stays unchanged; error behavior changes for invalid keys.

Before:

- `POST /api/users/:id/ssh-keys` accepts `zAddSshKeyRequest.keyText: z.string().min(1)`.
- `UsersService.addSshKey()` trims and persists arbitrary text such as `not-an-ssh-public-key`.

After:

- `POST /api/users/:id/ssh-keys` returns `400` for malformed key material.
- Valid OpenSSH public keys are accepted and persisted after trimming and whitespace normalization.
- Recommended accepted raw key line format: `<type> <base64-blob> [comment]`.
- Accepted key types: `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `sk-ssh-ed25519@openssh.com`, and `sk-ecdsa-sha2-nistp256@openssh.com`.
- Reject authorized_keys options prefixes, multiline input, missing/malformed base64, empty decoded blobs, and blobs whose embedded key type does not match the text prefix. For ECDSA keys, also verify the embedded curve string matches the key type suffix.
- Validation should live in shared common schema/helper code so the controller's existing `zAddSshKeyRequest.parse(body)` maps failures through `ZodExceptionFilter` to `400`. `UsersService.addSshKey()` should also call the same normalizer defensively before persistence.

### Image detail authorization

Public response shape stays unchanged; unauthorized detail reads become forbidden.

Before:

- `GET /api/images` and `/me/access` expose images only through effective server access.
- `GET /api/images/:id` calls `AccessResolverService.isImageAccessibleForUser()`, but that helper currently returns true if the user has the image granted on any server, even when the same user lacks effective access to that server.

After:

- Admin capabilities `manage_images` and `manage_containers_any` still bypass image detail restrictions.
- Ordinary users can read image detail only when the image appears in the image grants for at least one server that is also present in their effective `serverGrants`.
- Direct image detail authorization becomes at least as restrictive as `/api/images` and `/me/access`.

### Frontend `/users` route authorization

Backend APIs already enforce management authorization; this change prevents direct UI rendering.

Before:

- Sidebar hides the `/users` nav item for ordinary users.
- Direct navigation to `/users` lazy-loads `UsersPage`, which renders `用户管理`, the account table shell, and the `添加用户` control before API requests fail with `403`.

After:

- Direct `/users` navigation by an authenticated user without `manage_users` renders a small access-denied state inside the normal app layout, or redirects before `UsersPage` renders. Preferred implementation: route-level guard rendering an access-denied state so the user receives an explicit explanation without exposing management controls.
- The denied state must not call `GET /api/users`, must not render `用户管理`, and must not render `添加用户`.
- Admin users with `manage_users` still see the existing user-management page.

## Data Model Changes

- No database schema changes and no migrations are required.
- Existing operation, outbox, user SSH key, image grant, and frontend auth storage shapes remain unchanged.
- Existing stuck operation/outbox/container rows from the functional test are not cleaned up in this repair scope. Once the worker fix is deployed, still-due outbox rows may be retried by normal worker behavior; manual cleanup remains out of scope unless PM opens a separate operational task.

## File-Level Change List

### Developer source changes

- `packages/backend/src/operations/agent-command-outbox-worker.service.ts` - modify outbox processing so scan/lease scheduling is not blocked by one long-running online command; preserve per-resource locks; keep offline and retry behavior intact.
- `packages/backend/src/operations/operation-orchestrator.service.ts` - expected no behavior rewrite; touch only if the worker needs a small idempotent helper for terminal command completion.
- `packages/backend/src/operations/operations.module.ts` - expected no functional change; verify the worker provider remains registered and exported.
- `packages/common/src/protocol/rest-schema.ts` - add OpenSSH public-key validation/normalization to `zAddSshKeyRequest.keyText`, or import it from a narrow helper in the same protocol area.
- `packages/common/src/protocol/ssh-public-key.ts` - optional create: shared, browser-safe key normalizer/parser used by both schema and backend service. If created, keep it TypeScript-only and do not leave generated files under `packages/common/src/**`.
- `packages/backend/src/users/users.service.ts` - defensively normalize/validate `keyText` before saving and before enqueueing SSH reconciliation.
- `packages/backend/src/users/users.controller.ts` - expected no logic change if the shared schema is updated; touch only if needed to use normalized schema output.
- `packages/backend/src/access/access-resolver.service.ts` - modify `isImageAccessibleForUser()` to intersect image grants with effective server grants.
- `packages/backend/src/images/images.controller.ts` - expected no logic change; current `get()` call should pick up the stricter resolver semantics.
- `packages/frontend/src/routes/users/index.tsx` - replace unconditional lazy route with a `manage_users` guard. Render a denied state or redirect before `UsersPage` can render for unauthorized users.
- `packages/frontend/src/pages/users-page.tsx` - expected no broad rewrite; add a defensive early capability return only if the route-level guard cannot guarantee no render.

### Tester changes

- `packages/backend/src/operations/__tests__/operations.service.test.ts` - add deterministic worker starvation coverage: a long-running online command for resource A must not leave a later due command for resource B stuck `pending`/`attempts: 0`; same-resource serialization must still hold.
- `packages/backend/src/containers/__tests__/container-create-durable.test.ts` - keep/create coverage that `ContainersService.createContainer()` queues a `container.applySpec` command for the online-worker path and does not call direct RPC.
- `packages/common/src/__tests__/protocol.test.ts` - add `zAddSshKeyRequest` cases for valid OpenSSH keys, trimmed whitespace, `not-an-ssh-public-key`, multiline input, and mismatched key type/blob. Replace any fake `ssh-ed25519 AAAA ...` fixtures that become invalid under strict validation.
- `packages/backend/src/users/__tests__/users-ssh-key-callbacks.test.ts` - update fixtures to real valid public keys; add a negative service-level case proving invalid key text is not saved and does not enqueue SSH reconciliation.
- `packages/backend/src/access/__tests__/access-resolver.service.test.ts` or an equivalent image access test file - add coverage for image grant on an ungranted server returning false, matching server+image grant returning true, and admin capability bypass returning true.
- `packages/frontend/e2e/persona-routes.spec.ts` - add normal-user direct `/users` coverage that asserts admin navigation remains hidden, management heading/button are absent, `/api/users` is not requested, and a denied/redirect state is visible.
- `packages/frontend/e2e/ROUTES.md` - add/update the `/users` normal-user denied route ledger entry.
- `packages/frontend/e2e/__screenshots__/...` - update/add the screenshot baseline for the denied `/users` state only after visual output is reviewed through the harness flow.

## Risks and Trade-Offs

- Outbox concurrency can introduce duplicate or out-of-order delivery if per-resource locking is weakened. Preserve `resourceKey` locking until each delivery promise settles and add tests for same-resource serialization.
- If lease TTLs remain shorter than the acknowledgement timeout, an in-flight command can be recovered and retried by the same worker. Increase TTLs or exclude local in-flight command IDs during recovery.
- Strict SSH validation will reject old tests and any user-entered fake keys that previously saved. This is intended; update fixtures to real public keys. Do not accept authorized_keys options prefixes in this repair because the stored field is meant to be public key material only.
- `manage_users` and `manage_grants` are separate capabilities. This repair only addresses direct `/users` rendering for users without `manage_users`; broader per-tab splitting for users who can manage users but not grants is out of scope.
- The access-denied frontend state is a visible UI change. It requires Playwright visual coverage and the harness `VISUAL_ACCEPTANCE` gate before review.

## Acceptance Criteria

- Container create against an online agent no longer leaves its `container.applySpec` command indefinitely `pending` with `attempts: 0`; the outbox worker marks the command sent and moves the operation past `queued`.
- A deterministic backend test proves that one long-running online command for a different resource does not starve later due online commands.
- Backend tests prove same-resource outbox serialization still prevents concurrent command delivery for one `resourceKey`.
- `POST /api/users/:id/ssh-keys` returns `400` for `keyText: "not-an-ssh-public-key"` and does not persist a row or enqueue SSH reconciliation.
- Valid one-line OpenSSH public keys for the accepted key types are still accepted, trimmed/normalized, persisted, and followed by the existing SSH reconciliation hook.
- `GET /api/images/:id` returns `403` for an ordinary user when the image is granted only on a server the user cannot effectively access.
- `GET /api/images/:id` still returns `200` for admins and for ordinary users with both an effective server grant and an image grant for the same server.
- Direct frontend navigation to `/users` as an ordinary user without `manage_users` never renders `用户管理`, `添加用户`, or the management table controls, and does not issue `GET /api/users`.
- Admin navigation to `/users` still renders the existing management UI and existing `/users` screenshot coverage remains valid or is intentionally updated.
- Final verification includes `bash scripts/check.sh`, `bash scripts/check-visual.sh`, updated frontend route ledger, the rendered unauthorized `/users` screenshot, and PM/user `VISUAL_ACCEPTANCE` before reviewer sign-off.

## Test Strategy

- Unit/backend: extend the existing operation control-plane test setup with an online fake `AgentGateway`. Have command A's `sendCommandEnvelope` promise remain unresolved while command B resolves. After `processBatch()` schedules due commands, assert B reaches `succeeded`/`attempts: 1` while A remains in flight. Then resolve/reject A and assert terminal cleanup.
- Unit/backend: add a same-resource variant where A and B share `resourceKey`; assert B is not delivered until A settles and the lock is released.
- Unit/common: validate `zAddSshKeyRequest` directly with real OpenSSH public keys and malformed lines.
- Unit/backend: validate `UsersService.addSshKey()` rejects invalid key text before repository save and before lifecycle hook enqueue.
- Unit/backend: validate `AccessResolverService.isImageAccessibleForUser()` against effective server+image grants, including admin bypass.
- Frontend e2e/visual: add normal-user direct `/users` route coverage to `persona-routes.spec.ts`. Capture a dedicated screenshot of the denied state or redirected landing state and update `ROUTES.md`.
- Full checks for downstream roles: run `bash scripts/check.sh` and `bash scripts/check-visual.sh`. Because rendered frontend output changes, PM must show the actual unauthorized `/users` screenshot to the user and obtain `VISUAL_ACCEPTANCE` before review.

## Out of Scope

- Manual cleanup of stuck containers, data directories, operations, or outbox rows from the prior black-box session.
- Replacing the durable operations architecture, changing operation API response shapes, or introducing a new job queue.
- Broad redesign of user/grant capability modeling beyond the confirmed `/users` direct-navigation defect.
- Product documentation changes outside the harness session records.
