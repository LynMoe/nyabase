# Test Record

## Environment

- Date/time: 2026-06-04 Asia/Shanghai
- Workspace: `/root/nyabase`
- Role: tester
- Product source edits: none by tester
- Test/doc/e2e edits only:
  - `packages/backend/src/operations/__tests__/operations.service.test.ts`
  - `packages/common/src/__tests__/protocol.test.ts`
  - `packages/backend/src/users/__tests__/users-ssh-key-callbacks.test.ts`
  - `packages/backend/src/access/__tests__/access-resolver.test.ts`
  - `packages/frontend/e2e/persona-routes.spec.ts`
  - `packages/frontend/e2e/management-routes.spec.ts`
  - `packages/frontend/e2e/ROUTES.md`
  - `packages/frontend/e2e/__screenshots__/chromium/persona-routes.spec.ts/normal-users-access-denied.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/profile-user-center.png`

## Commands And Outcomes

| Command | Outcome |
| --- | --- |
| `pnpm --filter @nyabase/common exec vitest run src/__tests__/protocol.test.ts` | PASS: 1 file, 22 tests |
| `pnpm --filter @nyabase/backend exec vitest run src/operations/__tests__/operations.service.test.ts` | PASS: 1 file, 8 tests |
| `pnpm --filter @nyabase/backend exec vitest run src/users/__tests__/users-ssh-key-callbacks.test.ts src/access/__tests__/access-resolver.test.ts` | PASS after test-only access resolver entity mocks: 2 files, 12 tests |
| `pnpm --filter @nyabase/frontend exec playwright test e2e/persona-routes.spec.ts` | First run produced expected missing snapshot for new `normal-users-access-denied.png`; assertions passed before snapshot check. Fresh render inspected and accepted for criteria. |
| `pnpm --filter @nyabase/frontend exec playwright test e2e/persona-routes.spec.ts --update-snapshots` | PASS: 7 tests, generated new denied-state baseline |
| `pnpm --filter @nyabase/frontend exec playwright test e2e/persona-routes.spec.ts` | PASS: 7 tests, deterministic after baseline promotion |
| `bash scripts/check-visual.sh` | Initial run failed: 32 passed, 1 failed. Cause was e2e test fixture using invalid fake SSH key now rejected by frontend schema validation. |
| `pnpm --filter @nyabase/frontend exec playwright test e2e/management-routes.spec.ts` | Initial rerun after fixture fix failed only on `profile-user-center.png` pixel diff from replacing invalid fake key with valid key. Fresh render inspected and accepted. |
| `pnpm --filter @nyabase/frontend exec playwright test e2e/management-routes.spec.ts --update-snapshots` | PASS: 10 tests, updated profile screenshot baseline for valid key fixture |
| `pnpm --filter @nyabase/frontend exec playwright test e2e/management-routes.spec.ts` | PASS: 10 tests, deterministic after profile baseline update |
| `bash scripts/check-visual.sh` | PASS: 33 tests |
| `pnpm test:unit` | PASS: common 47, backend 147, agent 71 |
| `bash scripts/check.sh` | PASS: common build, typecheck, lint, unit tests. ESLint emitted 12 existing warnings and 0 errors. |
| `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) \| sort` | PASS: no output |

## Failures Encountered And Resolved

- `packages/backend/src/access/__tests__/access-resolver.test.ts` initially failed before running tests because importing `AccessResolverService` imported TypeORM entities, including `ImageEntity`, whose decorators require emitted metadata in this runner path. Root cause: test setup. Resolution: test-only `vi.mock` entity modules and repository stubs while exercising the real resolver public method.
- `packages/frontend/e2e/management-routes.spec.ts::profile route generates an SSH key name when no comment is present` initially timed out waiting for POST because the filled public key was fake and now rejected by the frontend schema. Root cause: test fixture. Resolution: replaced form-entered fake key strings with valid OpenSSH Ed25519 key material.
- `packages/frontend/e2e/management-routes.spec.ts::profile route shows password and SSH key management` then had an intentional screenshot diff caused by the valid key text. Fresh render had no overlap/clipping and still displayed the intended profile UI; baseline updated and rerun passed.

## Acceptance Criteria Coverage

- AC 1: Outbox worker schedules due commands for different resource keys while an earlier online command awaits ack.
  - Covered by `packages/backend/src/operations/__tests__/operations.service.test.ts::outbox worker schedules due commands for different resource keys while an earlier command awaits ack`.
- AC 2: Outbox worker preserves same-resource serialization.
  - Covered by `packages/backend/src/operations/__tests__/operations.service.test.ts::outbox worker preserves same-resource serialization while a command is in flight`.
- AC 3: `zAddSshKeyRequest` rejects malformed/multiline/mismatched keys and accepts valid OpenSSH public keys.
  - Covered by `packages/common/src/__tests__/protocol.test.ts::zAddSshKeyRequest accepts and normalizes valid one-line OpenSSH public keys`.
  - Covered by `packages/common/src/__tests__/protocol.test.ts::zAddSshKeyRequest rejects malformed, multiline, and mismatched OpenSSH public keys`.
- AC 4: `UsersService.addSshKey` rejects invalid key text before save/enqueue and accepts a valid key.
  - Covered by `packages/backend/src/users/__tests__/users-ssh-key-callbacks.test.ts::rejects invalid public key text before saving or enqueueing SSH reconciliation`.
  - Covered by `packages/backend/src/users/__tests__/users-ssh-key-callbacks.test.ts::enqueues durable SSH reconcile work after adding a public key without rolling back the save`.
- AC 5: `AccessResolverService.isImageAccessibleForUser` requires matching effective server+image grant for ordinary users and admin bypass remains.
  - Covered by `packages/backend/src/access/__tests__/access-resolver.test.ts::requires an ordinary user image grant to match an effectively granted server`.
  - Covered by `packages/backend/src/access/__tests__/access-resolver.test.ts::allows an ordinary user when effective server access and image grant share a server`.
  - Covered by `packages/backend/src/access/__tests__/access-resolver.test.ts::keeps admin capability bypass for image detail authorization`.
- AC 6: Ordinary user direct `/users` route does not render `用户管理`/`添加用户` and does not request `/api/users`; admin route still renders management UI.
  - Covered by `packages/frontend/e2e/persona-routes.spec.ts::direct users route shows denied state without loading user management for ordinary users`.
  - Covered by `packages/frontend/e2e/persona-routes.spec.ts::users route still renders management UI for admins`.
- AC 7: Visual output for unauthorized `/users` denied state is captured and passes visual checks.
  - Covered by `packages/frontend/e2e/__screenshots__/chromium/persona-routes.spec.ts/normal-users-access-denied.png`.
  - `bash scripts/check-visual.sh` PASS: 33 tests.
- AC 8: Required visual and overall checks run.
  - `bash scripts/check-visual.sh` PASS.
  - `bash scripts/check.sh` PASS.

## Visual Artifacts

- `packages/frontend/e2e/__screenshots__/chromium/persona-routes.spec.ts/normal-users-access-denied.png` - new baseline.
- `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/profile-user-center.png` - updated baseline for valid SSH key fixture text.

Fresh denied-state render was inspected before promotion. Later Playwright runs cleaned the transient `.test-results` actual image; the promoted durable artifact is:

- `packages/frontend/e2e/__screenshots__/chromium/persona-routes.spec.ts/normal-users-access-denied.png`

Route ledger updated:

- `packages/frontend/e2e/ROUTES.md` row for `/users` ordinary-user denied state.

## Verdict

PASS
