# Implementation Record

## Files Changed

- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- `packages/common/src/protocol/ssh-public-key.ts`
- `packages/common/src/protocol/rest-schema.ts`
- `packages/common/src/index.ts`
- `packages/backend/src/users/users.service.ts`
- `packages/backend/src/access/access-resolver.service.ts`
- `packages/frontend/src/routes/users/index.tsx`

## Acceptance Criteria Mapping

1. Outbox starvation: `AgentCommandOutboxWorkerService` now keeps the global `processing` guard around scan/lease/schedule only. Online delivery runs in a completion promise, while local in-flight command/resource-key sets prevent this process from retrying its own active command and skip same-resource due commands during later scans.
2. Same-resource serialization: the worker still acquires and holds the DB `ResourceLockService` lock until each delivery settles, and the local `inFlightResourceKeys` filter prevents this worker from scheduling later due commands for the same resource key while one is in flight.
3. SSH invalid input: `zAddSshKeyRequest.keyText` now normalizes through shared OpenSSH public-key parsing and rejects malformed text such as `not-an-ssh-public-key`; `UsersService.addSshKey()` repeats the same defensive validation before save/enqueue.
4. SSH valid input: accepted OpenSSH public key types are parsed as `<type> <base64-blob> [comment]`, checked against the embedded blob key type, and returned as a trimmed single line with whitespace collapsed.
5. Image detail access: `AccessResolverService.isImageAccessibleForUser()` now requires an ordinary user to have the image grant on at least one server in their effective `serverGrants`; `manage_images` and `manage_containers_any` still bypass.
6. `/users` direct navigation: `packages/frontend/src/routes/users/index.tsx` gates lazy loading of `UsersPage` on `manage_users`. Unauthorized users see a compact denied state, so the management page does not mount and does not register the `/api/users` query.

## Decisions

- Kept the outbox worker API unchanged: `processBatch()` and `processOne()` still return counts/booleans for scheduled work, but no longer wait for agent acknowledgements after a command has been sent.
- Set command lease and resource-lock TTLs to 75 seconds, longer than the 60 second agent command acknowledgement timeout.
- Implemented SSH validation in common protocol code without Node-only imports so the same schema continues to run in the frontend profile form and backend controllers.
- Kept `/users` authorization in the route file rather than adding a defensive page-level guard, because route gating prevents `UsersPage` hooks from mounting.

## Risks

- Existing unit fixtures using fake public key blobs such as `ssh-ed25519 AAAA ...` will need tester updates to real OpenSSH public keys, as called out in the design.
- Cross-process same-resource serialization still depends on DB resource locks, as before; the new local resource filter only prevents the current worker process from repeatedly picking its own in-flight resource key.
- No tests/builds/dev servers were run by this developer dispatch, per role instructions.

## Visual Impact

- Frontend route `/users/` changes for authenticated users without `manage_users`: they now see an access-denied state inside the normal app layout instead of the user-management heading, table shell, and add-user control.
- Admin users with `manage_users` should see the existing `UsersPage` pixels unchanged after the lazy page loads.

## Self-Check

- Reviewed imports and type signatures for edited files.
- Verified no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` files exist under `packages/common/src/**`.
- Did not run tests/builds/dev servers/package installs, as forbidden by dispatch.
