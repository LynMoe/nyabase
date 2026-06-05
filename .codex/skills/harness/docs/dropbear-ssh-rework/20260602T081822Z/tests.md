# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: TEST.unit
Date: 2026-06-02

## Scope

Focused unit coverage for non-visual Dropbear SSH rework behavior in common, backend, and agent packages.

Updated test/config files:

- `packages/common/src/__tests__/protocol.test.ts`
- `packages/backend/src/gateway/__tests__/state-cache.test.ts`
- `packages/backend/src/containers/__tests__/container-delete-mount-cleanup.test.ts`
- `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts`
- `packages/backend/src/users/__tests__/users-ssh-key-callbacks.test.ts`
- `packages/backend/vitest.config.ts`
- `packages/agent/src/commands/dispatcher.test.ts`
- `packages/agent/src/docker/docker-client.test.ts`
- `packages/agent/src/dropbear/dropbear-manager.test.ts`
- `packages/agent/vitest.config.ts`

No product source files were edited.

## Commands

### Source/Artifact Guards

```sh
find packages/common/src -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' | sort
```

Output: no files.

```sh
rg -n "sshUser|sshUid|sshPubKeys|injectSshKeys|nyabase\.ssh_user|nyabase\.ssh_uid|/home/.+authorized_keys" packages/common/src packages/backend/src packages/agent/src packages/frontend/src scripts -g '!**/*.test.ts' -g '!**/*.spec.ts'
```

Output: no product-source matches.

Note: `packages/common/dist*` still contains stale generated legacy SSH output from before this source change. Backend/agent unit tests now alias `@nyabase/common` to `packages/common/src/index.ts` in Vitest config so unit tests verify current source without requiring a build in the tester lane. Full build/check should regenerate or otherwise address `dist*` later.

### Package Unit Suites

```sh
pnpm --filter @nyabase/common test
```

Final output:

```text
Test Files  2 passed (2)
Tests       41 passed (41)
```

```sh
pnpm --filter @nyabase/agent test
```

Initial failure: agent tests resolved stale `@nyabase/common` built output from `packages/common/dist-esm`, so `zCreateContainerPayload` still required legacy `sshUser`, `sshUid`, and `sshPubKeys`, and `SPEC_VERSION` was still `1`.

Action: updated `packages/agent/vitest.config.ts` to alias `@nyabase/common` to `../common/src/index.ts`.

Final output:

```text
Test Files  5 passed (5)
Tests       69 passed (69)
```

```sh
pnpm --filter @nyabase/backend test
```

Initial failures:

- `users-ssh-key-callbacks.test.ts` imported `UsersService`, which imported TypeORM-decorated entities before metadata was usable in this isolated test path. Fixed by mocking entity modules in that test because callback behavior does not exercise entity decorators.
- Same test assumed a hard-coded SSH key UUID; fixed to assert `expect.any(String)`.

Action: updated `packages/backend/vitest.config.ts` to alias `@nyabase/common` to `../common/src/index.ts`; isolated the users callback test from TypeORM entity decorators.

Final output:

```text
Test Files  12 passed (12)
Tests       97 passed (97)
```

```sh
pnpm test:unit
```

Final output:

```text
@nyabase/common:  Test Files 2 passed,  Tests 41 passed
@nyabase/backend: Test Files 12 passed, Tests 97 passed
@nyabase/agent:   Test Files 5 passed,  Tests 69 passed
```

Combined final count: 207 passed, 0 failed, 0 skipped.

## Coverage Of Acceptance Criteria

- AC #1: covered by `packages/common/src/__tests__/protocol.test.ts` :: `requires createDirs ownerUid and ignores legacy SSH injection fields`, `uses sshServerEnabled instead of legacy sshUser/sshUid in ContainerSpec`, `zCreateContainerRequest accepts sshServerEnabled and ignores legacy SSH request fields`; source scan also found no product-source legacy field references.
- AC #2: covered by `packages/agent/src/commands/dispatcher.test.ts` :: `passes sshServerEnabled to Docker create and does not invoke Dropbear during createContainer`; source scan found no `injectSshKeys` or `/home/.../authorized_keys` product-source references.
- AC #3: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `maps createDirs ownerUid from image.defaultUid and does not fetch keys in createContainer payload`; `packages/agent/src/commands/dispatcher.test.ts` :: `passes sshServerEnabled to Docker create and does not invoke Dropbear during createContainer`.
- AC #4: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `maps createDirs ownerUid from image.defaultUid and does not fetch keys in createContainer payload`; `packages/agent/src/commands/dispatcher.test.ts` :: `assigns local quota-enabled createDirs plus Docker upper/work dirs to the owner project`.
- AC #5: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `creates a durable row before strict SSH reconcile for SSH-enabled creates`; `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `updates keys without restarting a running process when the binary hash is unchanged`.
- AC #6: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `enables a running container idempotently and immediately reconciles SSH`.
- AC #7: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `persists one durable enablement row idempotently and deletes it only for container cleanup`.
- AC #8: covered by source scan; no disable route/RPC/service/product-source control was found in unit scope. Frontend visual/control verification is pending TEST.visual.
- AC #9: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `enables a running container idempotently and immediately reconciles SSH`.
- AC #10: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `persists enablement but defers reconciliation for stopped and offline containers`; lifecycle catch-up covered by `registers lifecycle and key-change callbacks that reconcile running SSH-enabled containers`.
- AC #11: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `backfills v2 enabled label snapshots but leaves missing/v1 labels disabled`; `packages/agent/src/docker/docker-client.test.ts` :: `defaults missing or v1 SSH server labels to disabled`.
- AC #12: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `overlays DB enablement onto a raw running snapshot and synthesizes unknown SSH state`, `overlays stopped enabled snapshots as container_stopped without losing root/port contract`.
- AC #13: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `manual reconcile uses the SSH sync service and preserves enabled state on failure`.
- AC #14: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `rejects manual reconcile for disabled containers without creating an enablement row`.
- AC #15: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `manual reconcile uses the SSH sync service and preserves enabled state on failure`; `fetches fresh user public keys and sends reconcileContainerSsh with the expected hash`.
- AC #16: covered by `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `restarts Dropbear when the pid file process check shows it was killed`.
- AC #17: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `returns stopped/offline statuses for manual reconcile without invoking the agent`.
- AC #18: covered by `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `starts Dropbear public-key-only for an empty key set and keeps forwarding options open`.
- AC #19: covered by `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `starts Dropbear public-key-only for an empty key set and keeps forwarding options open`.
- AC #20: covered by `packages/backend/src/users/__tests__/users-ssh-key-callbacks.test.ts` :: `triggers registered callbacks after adding a public key without rolling back the save`; `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `registers lifecycle and key-change callbacks that reconcile running SSH-enabled containers`.
- AC #21: covered by `packages/backend/src/users/__tests__/users-ssh-key-callbacks.test.ts` :: `triggers registered callbacks after deleting a public key`; `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `updates keys without restarting a running process when the binary hash is unchanged`.
- AC #22: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `registers lifecycle and key-change callbacks that reconcile running SSH-enabled containers`.
- AC #23: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `registers lifecycle and key-change callbacks that reconcile running SSH-enabled containers`.
- AC #24: covered by `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `updates keys without restarting a running process when the binary hash is unchanged`, `replaces a changed binary hash and restarts the running Dropbear process`, `treats the reconcile command as authoritative even without an enabled Docker label`.
- AC #25: covered by `packages/common/src/__tests__/protocol.test.ts` :: `requires runtime SSH server state on snapshots`; `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: overlay state tests; `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `reports runtime pid, key hash, and last error visibility after a failed reconcile`.
- AC #26: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `cleans up container, mounts, and enablement row when strict SSH setup fails during create`.
- AC #27: covered by the focused common/backend/agent suites listed above.
- AC #29: unit subset covered by final `pnpm test:unit` pass and clean `packages/common/src` generated-artifact guard. Full `bash scripts/check.sh` was not run in this tester unit dispatch.

## Visual Artifacts

n/a (TEST.unit dispatch; frontend visual gate pending)

## Verdict

PASS

---

# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: TEST.unit follow-up
Date: 2026-06-02T12:02:49Z

## Scope

Added focused test-lane coverage for the reviewer blocker and explicit missing Dropbear asset behavior.

Updated test files:

- `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts`
- `packages/agent/src/dropbear/dropbear-manager.test.ts`

No product source files were edited.

## Commands

Focused backend SSH rework suite:

```sh
pnpm --filter @nyabase/backend exec vitest run src/containers/__tests__/container-ssh-rework.test.ts
```

Final output summary:

```text
Test Files  1 passed (1)
Tests       16 passed (16)
```

Focused agent Dropbear suite:

```sh
pnpm --filter @nyabase/agent exec vitest run src/dropbear/dropbear-manager.test.ts
```

Final output summary:

```text
Test Files  1 passed (1)
Tests       12 passed (12)
```

Workspace unit suites:

```sh
pnpm test:unit
```

Final output summary:

```text
@nyabase/common:  Test Files 2 passed,  Tests 41 passed
@nyabase/backend: Test Files 12 passed, Tests 98 passed
@nyabase/agent:   Test Files 5 passed,  Tests 71 passed
```

Combined final count: 210 passed, 0 failed, 0 skipped.

Common source artifact guard:

```sh
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort
```

Output: no files.

Legacy SSH product-source guard:

```sh
rg -n "sshUser|sshUid|sshPubKeys|injectSshKeys" packages/common/src packages/backend/src packages/agent/src packages/frontend/src scripts -g '!**/*.test.ts' -g '!**/*.spec.ts' -g '!**/__tests__/**'
```

Output: no product-source matches.

Note: an initial focused backend invocation used a root-relative filter after pnpm changed into the backend package and Vitest reported no matching test files. It was rerun with the package-relative path shown above and is not a product failure.

## Coverage Of Acceptance Criteria

- AC #1: covered by `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `strictly reconciles SSH-enabled create from durable enablement context when state cache is empty`.
- AC #2: covered by existing `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts` :: `cleans up container, mounts, and enablement row when strict SSH setup fails during create`.
- AC #3: covered by `packages/agent/src/dropbear/dropbear-manager.test.ts` :: `fails before Docker work when the Dropbear asset is missing`; `reports a missing source-mode Dropbear asset as a failing binary check`.
- AC #4: covered by final `pnpm test:unit`; common, backend, and agent unit suites passed.
- AC #5: covered by the generated-artifact guard; `packages/common/src/**` has no `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` outputs.
- AC #6: covered by the legacy-reference scan; no product-source `sshUser`, `sshUid`, `sshPubKeys`, or `injectSshKeys` references were found outside tests/specs.
- AC #7: covered by this follow-up record; visual artifacts are n/a because this is a backend/agent test follow-up and previous TEST.visual PASS remains recorded.

## Visual Artifacts

n/a (backend/agent test follow-up; previous TEST.visual PASS remains recorded)

## Failure Classification

No failures.

## Verdict

PASS

---

# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: WORKER.dropbear-asset
Date: 2026-06-02T12:37:11Z

## Source / Checksum

- Dropbear version: `2026.91`
- Official source URL: `https://matt.ucc.asn.au/dropbear/releases/dropbear-2026.91.tar.bz2`
- Source checksum source: official `https://matt.ucc.asn.au/dropbear/releases/SHA256SUM.asc`
- Pinned source tarball SHA256: `defa924475abf6bc1e74abc00173e46bfdc804bd47caafa14f5a4ef0cc76da34`
- Generated binary SHA256: `f14a199e4aaed06c7ca2fa613c718a2156b459b8d0b405a6af4941a6d8162547`

## Commands

```sh
docker buildx build --platform linux/amd64 \
  -f packages/agent/assets/dropbear/Dockerfile \
  --output type=local,dest=packages/agent/assets/dropbear \
  packages/agent/assets/dropbear
```

First run failed after compilation because the Dockerfile attempted to run `file`
without installing the Alpine `file` package. The Dockerfile was fixed to install
`file` and to make the `dropbear -h` smoke check explicit.

Second run exit code: 0.

```text
dropbear.tar.bz2: OK
/out/nyabase-dropbear-linux-x64: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, BuildID[sha1]=88076c6ae159cb28b56a25aba61cf91e5d029ce1, stripped
exporting to client directory: done
```

```sh
sha256sum -c nyabase-dropbear-linux-x64.sha256
```

Workdir: `/root/nyabase/packages/agent/assets/dropbear`

Exit code: 0

```text
nyabase-dropbear-linux-x64: OK
```

```sh
file packages/agent/assets/dropbear/nyabase-dropbear-linux-x64
ldd packages/agent/assets/dropbear/nyabase-dropbear-linux-x64 || true
./packages/agent/assets/dropbear/nyabase-dropbear-linux-x64 -h 2>&1 | sed -n '1,40p'
```

Exit code: 0

```text
packages/agent/assets/dropbear/nyabase-dropbear-linux-x64: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, BuildID[sha1]=88076c6ae159cb28b56a25aba61cf91e5d029ce1, stripped
not a dynamic executable
Dropbear server v2026.91 https://matt.ucc.asn.au/dropbear/dropbear.html
-a Allow connections to forwarded ports from any host
```

```sh
bash scripts/check.sh
```

Exit code: 0

Outcome:

- Common src artifact guard: pass; no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` files under `packages/common/src/**`.
- Common build: pass.
- Common typecheck: pass.
- Backend typecheck: pass.
- Agent typecheck: pass.
- Frontend typecheck: pass.
- Workspace lint: pass with 0 errors and 12 pre-existing warnings.
- Common unit tests: 41 passed.
- Backend unit tests: 98 passed.
- Agent unit tests: 71 passed.

```sh
bash scripts/build-agent-binary.sh
```

Exit code: 0

Outcome:

- Built `tools/mount-helper` as `target/x86_64-unknown-linux-musl/release/nyabase-mount-helper`.
- Rebuilt `@nyabase/common`.
- Bundled agent with esbuild.
- `scripts/build-agent-binary.sh` consumed the default Dropbear asset and sidecar from `packages/agent/assets/dropbear/` without `NYABASE_DROPBEAR_PATH`.
- Generated standalone agent: `/root/nyabase/dist/nyabase-agent` (`73M`).

## Artifacts

- `packages/agent/assets/dropbear/Dockerfile`
- `packages/agent/assets/dropbear/README.md`
- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`
- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64.sha256`
- `dist/nyabase-agent`

## Failure Classification

No remaining failures. The initial Dockerfile verification failure was fixed and re-run successfully.

## Verdict

PASS

# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: TEST.unit follow-up
Date: 2026-06-02T11:30:40Z

## Scope

Revalidated unit/source coverage after the narrow common export/check-script follow-up:

- `packages/common/src/index.ts`
- `scripts/check.sh`
- `.codex/skills/harness/docs/dropbear-ssh-rework/20260602T081822Z/implementation.md`

No product source or test files were edited in this follow-up.

## Commands

```sh
pnpm test:unit
```

Final output summary:

```text
@nyabase/common:  Test Files 2 passed,  Tests 41 passed
@nyabase/backend: Test Files 12 passed, Tests 97 passed
@nyabase/agent:   Test Files 5 passed,  Tests 69 passed
```

Combined count: 207 passed, 0 failed, 0 skipped.

```sh
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort
```

Output: no files.

```sh
rg -n "sshUser|sshUid|sshPubKeys|injectSshKeys" packages/common/src packages/backend/src packages/agent/src packages/frontend/src scripts -g '!**/*.test.ts' -g '!**/*.spec.ts' -g '!**/__tests__/**'
```

Output: no product-source matches.

## Coverage Of Acceptance Criteria

- AC #1: covered by `pnpm test:unit`; common, backend, and agent unit suites passed after the common export follow-up.
- AC #2: covered by the generated-artifact guard; `packages/common/src/**` has no `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` outputs.
- AC #3: covered by the legacy-reference scan; no product-source `sshUser`, `sshUid`, `sshPubKeys`, or `injectSshKeys` references were found outside tests/specs.
- AC #4: covered by this follow-up record; visual artifacts are n/a because the follow-up has no frontend rendered change and prior TEST.visual PASS remains recorded above.

## Visual Artifacts

n/a (follow-up has no frontend rendered change; previous TEST.visual PASS remains recorded)

## Failure Classification

No failures.

## Verdict

PASS

---

# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: DEVOPS.final-check
Date: 2026-06-02T11:06:42Z

## Command

```sh
bash scripts/check.sh
```

Exit code: 2

## Outcome

- Common src artifact guard: pass; `scripts/check.sh` proceeded past the generated-artifact guard.
- Common typecheck: pass.
- Backend typecheck: fail.
- Agent typecheck: not reached; `set -e` stopped after backend typecheck failure.
- Frontend typecheck: not reached; `set -e` stopped after backend typecheck failure.
- Workspace lint: not reached.
- Workspace unit tests: not reached.
- Frontend visual: skipped; `--with-visual` was not requested.

## Failing Output Tail

```text
src/containers/__tests__/container-ssh-rework.test.ts(32,41): error TS2339: Property 'sshServer' does not exist on type ...
src/containers/__tests__/container-ssh-rework.test.ts(47,7): error TS2353: Object literal may only specify known properties, and 'sshServerEnabled' does not exist in type ...
src/containers/container-ssh-enablements.service.ts(7,3): error TS2305: Module '"@nyabase/common"' has no exported member 'ContainerSshServerState'.
src/containers/container-ssh-enablements.service.ts(105,52): error TS2339: Property 'sshServerEnabled' does not exist on type ...
src/containers/container-ssh-enablements.service.ts(144,18): error TS2339: Property 'sshServer' does not exist on type 'SnapshotWithServer'.
src/containers/container-ssh-sync.service.ts(121,45): error TS2345: Argument of type '"reconcileContainerSsh"' is not assignable to parameter of type ...
src/containers/containers.service.ts(26,3): error TS2724: '"@nyabase/common"' has no exported member named 'EnableContainerSshResponse'. Did you mean 'ContainerStatsResponse'?
src/containers/containers.service.ts(27,3): error TS2305: Module '"@nyabase/common"' has no exported member 'ReconcileContainerSshResponse'.
src/containers/containers.service.ts(180,36): error TS2339: Property 'sshServerEnabled' does not exist on type ...
src/gateway/__tests__/state-cache.test.ts(39,7): error TS2353: Object literal may only specify known properties, and 'sshServerEnabled' does not exist in type ...
/root/nyabase/packages/backend:
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @nyabase/backend@0.1.0 typecheck: `tsc --noEmit`
Exit status 2
ELIFECYCLE Command failed with exit code 2.
```

## Routing

Likely root-cause lane: developer, covering the common/backend API and schema contract. Backend product code and tests reference Dropbear SSH fields/responses (`sshServerEnabled`, `sshServer`, `ContainerSshServerState`, `EnableContainerSshResponse`, `ReconcileContainerSshResponse`, `reconcileContainerSsh`) that are not present in the currently resolved common/backend types.

## Verdict

RED

# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: TEST.visual
Date: 2026-06-02

## Scope

Updated Playwright visual coverage for the frontend Dropbear SSH UX:

- Replaced legacy container fixture fields in e2e with `spec.sshServerEnabled` and `sshServer` runtime state.
- Added focused visual states for create-container SSH opt-in, SSH-enabled container detail, SSH-disabled container detail, and console toolbar IP display.
- Updated `packages/frontend/e2e/ROUTES.md` for the new visual states.
- Promoted intentional screenshots only after inspecting fresh default-size renders against the visual acceptance criteria.

No product source files were edited.

## Commands

```sh
rg -n "sshUser|sshUid|sshPubKeys" packages/frontend/e2e -S
```

Output: no matches.

```sh
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort
```

Output: no files.

```sh
pnpm --filter @nyabase/frontend exec playwright test e2e/ssh-ux.spec.ts --list
```

Output: 4 tests discovered in `e2e/ssh-ux.spec.ts`.

```sh
pnpm --filter @nyabase/frontend exec playwright test e2e/ssh-ux.spec.ts
```

Initial focused result: 3 passed, 1 failed because `container-console-toolbar-ip.png` was a new missing baseline after semantic assertions passed. Earlier missing-baseline failures for the other three new screenshots were inspected before promotion. One selector was tightened to use exact IP text because the IP appears in both the header and console toolbar.

```sh
bash scripts/check-visual.sh
```

Initial full result: 15 passed, 1 failed. Failure was an intentional existing baseline diff:

- `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png`

Fresh render was inspected and matched the design: legacy SSH user/UID rows were removed, the new `SSH 访问` card showed `ssh root@10.8.110.20`, status `可用`, and `修复 SSH`, while the positive GPU memory rows still rendered.

```sh
pnpm --filter @nyabase/frontend exec playwright test --update-snapshots
```

Final output:

```text
16 passed
```

Intentional baseline updates/new baselines:

- `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png`
- `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/create-container-dialog-ssh-option.png`
- `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-detail-ssh-enabled.png`
- `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-detail-ssh-disabled.png`
- `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-console-toolbar-ip.png`

```sh
bash scripts/check-visual.sh
```

Final no-update output:

```text
16 passed
```

Combined final visual count: 16 passed, 0 failed, 0 skipped.

## Coverage Of Visual Acceptance Criteria

- AC #1: covered by `packages/frontend/e2e/management-routes.spec.ts` and `packages/frontend/e2e/gpu-metrics.spec.ts` fixture updates; `rg -n "sshUser|sshUid|sshPubKeys" packages/frontend/e2e -S` returned no matches.
- AC #2: covered by `packages/frontend/e2e/ssh-ux.spec.ts` :: `create container dialog shows SSH opt-in in advanced options`.
- AC #3: covered by `packages/frontend/e2e/ssh-ux.spec.ts` :: `container detail shows enabled SSH access and repair action`.
- AC #4: covered by `packages/frontend/e2e/ssh-ux.spec.ts` :: `container detail shows one-way enable action when SSH is disabled`.
- AC #5: covered by final `bash scripts/check-visual.sh`; existing impacted routes in `management-routes.spec.ts` and `gpu-metrics.spec.ts` rendered successfully after fixture and intentional baseline updates.
- AC #6: covered by final `bash scripts/check-visual.sh` pass: 16 passed, 0 failed, 0 skipped.
- AC #7: covered by default Playwright viewport screenshots listed below.

## Visual Artifacts

- `/root/nyabase/packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/create-container-dialog-ssh-option.png` (new)
- `/root/nyabase/packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-detail-ssh-enabled.png` (new)
- `/root/nyabase/packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-detail-ssh-disabled.png` (new)
- `/root/nyabase/packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-console-toolbar-ip.png` (new)
- `/root/nyabase/packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png` (updated)
- `/root/nyabase/packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/containers-own.png` (unchanged)

## Verdict

PASS

---

# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: DEVOPS.final-check follow-up
Date: 2026-06-02T11:33:22Z

## Command

```sh
bash scripts/check.sh
```

Exit code: 0

## Outcome

- Common src artifact guard: pass; `scripts/check.sh` proceeded past the generated-artifact guard with no `packages/common/src/**` `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` artifact reported.
- Common build: pass.
- Common typecheck: pass.
- Backend typecheck: pass.
- Agent typecheck: pass.
- Frontend typecheck: pass.
- Workspace lint: pass; eslint reported 0 errors and 12 warnings.
- Common unit tests: 41 passed, 0 failed, 0 skipped.
- Backend unit tests: 97 passed, 0 failed, 0 skipped.
- Agent unit tests: 69 passed, 0 failed, 0 skipped.
- Combined unit-test count: 207 passed, 0 failed, 0 skipped.
- Frontend unit tests: not run by `scripts/check.sh`; no frontend unit test script exists in the command path.
- Frontend visual: skipped; `--with-visual` was not requested.

## Output Summary

```text
@nyabase/common build: pass
@nyabase/common typecheck: pass
@nyabase/backend typecheck: pass
@nyabase/agent typecheck: pass
@nyabase/frontend typecheck: pass
eslint packages/common/src packages/backend/src packages/agent/src packages/frontend/src: pass (0 errors, 12 warnings)
@nyabase/common tests: 41 passed
@nyabase/backend tests: 97 passed
@nyabase/agent tests: 69 passed
```

## Failure Classification

No failures.

## Verdict

PASS

---

# Tests: Dropbear SSH Rework

Session: 20260602T081822Z
Role: DEVOPS.final-check follow-up
Date: 2026-06-02T12:05:57Z

## Command

```sh
bash scripts/check.sh
```

Exit code: 0

## Outcome

- Common src artifact guard: pass; `scripts/check.sh` proceeded past the generated-artifact guard with no `packages/common/src/**` `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` artifact reported.
- Common build: pass.
- Common typecheck: pass.
- Backend typecheck: pass.
- Agent typecheck: pass.
- Frontend typecheck: pass.
- Workspace lint: pass; eslint reported 0 errors and 12 warnings.
- Common unit tests: 41 passed, 0 failed, 0 skipped.
- Backend unit tests: 98 passed, 0 failed, 0 skipped.
- Agent unit tests: 71 passed, 0 failed, 0 skipped.
- Combined unit-test count: 210 passed, 0 failed, 0 skipped.
- Frontend unit tests: not run by `scripts/check.sh`; no frontend unit test script is included in the command path.
- Frontend visual: skipped; `--with-visual` was not requested.

## Output Summary

```text
@nyabase/common build: pass
@nyabase/common typecheck: pass
@nyabase/backend typecheck: pass
@nyabase/agent typecheck: pass
@nyabase/frontend typecheck: pass
eslint packages/common/src packages/backend/src packages/agent/src packages/frontend/src: pass (0 errors, 12 warnings)
@nyabase/common tests: 41 passed
@nyabase/backend tests: 98 passed
@nyabase/agent tests: 71 passed
```

## Failure Classification

No failures.

## Verdict

PASS

---

# Latest Status: Dropbear Asset Follow-Up

Session: 20260602T081822Z
Date: 2026-06-02T12:37:11Z

The remaining Dropbear asset blocker is resolved. The detailed worker record
above (`Role: WORKER.dropbear-asset`) documents:

- Dockerfile archived at `packages/agent/assets/dropbear/Dockerfile`.
- Rebuild instructions archived at `packages/agent/assets/dropbear/README.md`.
- Official Dropbear `2026.91` source tarball URL and pinned source SHA256.
- Generated asset path `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`.
- Generated sidecar path `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64.sha256`.
- Binary SHA256 `f14a199e4aaed06c7ca2fa613c718a2156b459b8d0b405a6af4941a6d8162547`.
- Docker build, binary/static verification, `bash scripts/check.sh`, and `bash scripts/build-agent-binary.sh` all PASS.

## Verdict

PASS

## Live Dropbear Runtime Deployment Preflight

Session: 20260602T081822Z
Role: DEVOPS.runtime-preflight
Date: 2026-06-02
Status: pass

Scope: CPU-only live Dropbear runtime deployment preflight. GPU host was not deployed or changed.

Completed preflight facts:

- `bash scripts/check.sh` passed with 0 errors and 210 unit tests passed.
- Common-src artifact guard was clean: no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` artifacts were reported under `packages/common/src/**`.
- Local backend was built and restarted as `node -r tsconfig-paths/register dist/main.js`.
- Local probes confirmed `/api/auth/me` returned `401` and frontend root returned `200`.
- `bash scripts/build-agent-binary.sh` succeeded using the default Dropbear asset without `NYABASE_DROPBEAR_PATH`.
- CPU host `10.8.96.91` had `/usr/local/bin/nyabase-agent` replaced and `nyabase-agent` restarted.
- CPU `nyabase-agent` and `nyabase-docker.service` were confirmed active.
- Dropbear self-check returned `dropbear_binary ok` and `dropbear_options ok`.
- GPU host remained unchanged.

Verdict: PASS

---

## Live Dropbear User-State Runtime Test

Session: 20260602T081822Z
Role: TEST.live-runtime
Date: 2026-06-02T16:37:21Z
Status: pass

Scope: focused CPU-agent live Dropbear user-state runtime test after fixing the test harness kill helper false positive. No product source, scripts, configs, lockfiles, frontend source, backend source, agent source, or common source files were edited.

Updated test file:

- `test/dropbear-live-runtime.spec.ts`

Harness fix summary:

- `killDropbearWithConsole` now selects Dropbear targets from `/run/nyabase-dropbear.pid` plus `/proc/<pid>/comm` validation, with a `/proc/*/comm` fallback only.
- Removed `/proc/*/cmdline` matching so the running shell/script text is not treated as a Dropbear target.
- Removed the hard failure on `aliveAfterKillCount !== 0`; killed PIDs can remain briefly observable. The decisive assertion is product-observable state: API SSH status not running/unavailable or a fresh SSH login failure, followed by successful `/ssh/reconcile` repair and key login.
- Old kill-helper target/alive failures are classified as test failures, not product failures.

Command:

```sh
pnpm exec vitest run test/dropbear-live-runtime.spec.ts --reporter=verbose
```

Final output:

```text
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    80.18s
```

Counts: 1 passed, 0 failed, 0 skipped.

Runtime artifacts:

- `/tmp/nyabase-dropbear-live-20260602t163601z-a1051d/dropbear-live-report.redacted.md`
- `/tmp/nyabase-dropbear-live-20260602t163601z-a1051d/dropbear-live-report.redacted.json`

Prior-prefix cleanup summary:

- `dropbear-live-20260602t160927z-c22669`: scanned c/u/i/g/k=0/0/0/0/0; removed=0; residual c/u/i/g/k=0/0/0/0/0
- `dropbear-live-20260602t161114z-bd9158`: scanned c/u/i/g/k=0/0/0/0/0; removed=0; residual c/u/i/g/k=0/0/0/0/0
- `dropbear-live-20260602t162132z-ea21b7`: scanned c/u/i/g/k=0/0/0/0/0; removed=0; residual c/u/i/g/k=0/0/0/0/0
- `dropbear-live-20260602t162314z-f69a37`: scanned c/u/i/g/k=0/0/0/0/0; removed=0; residual c/u/i/g/k=0/0/0/0/0
- `dropbear-live-20260602t162622z-f44369`: scanned c/u/i/g/k=0/0/0/0/0; removed=0; residual c/u/i/g/k=0/0/0/0/0
- `dropbear-live-20260602t162921z-885616`: scanned c/u/i/g/k=0/0/0/0/0; removed=0; residual c/u/i/g/k=0/0/0/0/0

Coverage of live Dropbear acceptance criteria:

- Non-admin fixtures: two disposable non-admin users were created, granted one CPU server and one active Ubuntu image, and verified to have no management capabilities.
- Create-time SSH enablement: User A created an SSH-enabled container, API reported `sshServer.status=running`, root/key SSH login succeeded, and password/no-key auth was rejected.
- Cross-user isolation: User B received 403 denials for detail, stats, lifecycle, delete, `/ssh/enable`, and `/ssh/reconcile`; User A's container remained running.
- Manual enable path: disabled container `/ssh/reconcile` returned 409, `/ssh/enable` succeeded, API reached running state, and root/key SSH login succeeded.
- Kill/repair path: console kill targeted Dropbear by pidfile/comm validation; despite `aliveAfterKillCount=2`, a fresh SSH login failed, so the harness accepted the kill as product-observable. `/ssh/reconcile` returned `reconciled`, API reached running state again, and key login succeeded.
- Key sync: adding a second key allowed login; deleting the first key rejected the old key while the second key still succeeded.
- Lifecycle: restarting the SSH-enabled container restored running SSH state and key login.
- Cleanup: current run containers were deleted through product API, current image/user/grant rows were removed through product API, temp secret files were removed, and exact-prefix product residual scan reported no current-run product containers.

Common source artifact guard:

```sh
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort
```

Output: no files.

Visual artifacts:

- n/a (backend/API/runtime SSH-only test; no frontend rendered output touched)

Failure classification:

No failures.

Verdict: PASS

---

## Final Dropbear Live Standard Check

Session: 20260602T081822Z
Role: DEVOPS.final-check
Date: 2026-06-02T16:43:47Z
Status: pass

Scope: final standard check and exact-prefix residual verification after the live Dropbear test-file changes. No product source, tests, scripts, configs, lockfiles, services, or runtime resources were changed.

Standard check:

```sh
bash scripts/check.sh
```

Result: exit 0.

Summary:

```text
@nyabase/common build: pass
@nyabase/common typecheck: pass
@nyabase/backend typecheck: pass
@nyabase/agent typecheck: pass
@nyabase/frontend typecheck: pass
eslint packages/common/src packages/backend/src packages/agent/src packages/frontend/src: pass (0 errors, 12 warnings)
@nyabase/common tests: 41 passed
@nyabase/backend tests: 98 passed
@nyabase/agent tests: 71 passed
frontend tests: skipped by scripts/check.sh
frontend visual: skipped
```

Common source artifact guard:

```sh
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort
```

Output: no files.

Product API exact-prefix residual scan:

```sh
node --input-type=module
```

Read-only admin API scan of `/api/containers`, `/api/users`, `/api/images`, `/api/users/:id/ssh-keys`, `/api/users/:id/server-grants`, and `/api/users/:id/image-grants`; output was restricted to counts only.

```text
dropbear-live-20260602t160927z-c22669 c/u/i/g/k=0/0/0/0/0
dropbear-live-20260602t161114z-bd9158 c/u/i/g/k=0/0/0/0/0
dropbear-live-20260602t162132z-ea21b7 c/u/i/g/k=0/0/0/0/0
dropbear-live-20260602t162314z-f69a37 c/u/i/g/k=0/0/0/0/0
dropbear-live-20260602t162622z-f44369 c/u/i/g/k=0/0/0/0/0
dropbear-live-20260602t162921z-885616 c/u/i/g/k=0/0/0/0/0
dropbear-live-20260602t163601z-a1051d c/u/i/g/k=0/0/0/0/0
total_residuals=0
```

CPU managed Docker exact-prefix read-only scan:

```sh
ssh root@10.8.96.91 'DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker ps -a --format "{{.Names}}"'
```

Per-prefix result:

```text
dropbear-live-20260602t160927z-c22669 containers=0
dropbear-live-20260602t161114z-bd9158 containers=0
dropbear-live-20260602t162132z-ea21b7 containers=0
dropbear-live-20260602t162314z-f69a37 containers=0
dropbear-live-20260602t162622z-f44369 containers=0
dropbear-live-20260602t162921z-885616 containers=0
dropbear-live-20260602t163601z-a1051d containers=0
```

Service health probes:

```sh
curl -s -o /tmp/nyabase-auth-me-body.txt -w '%{http_code}' http://localhost:3001/api/auth/me
curl -s -o /tmp/nyabase-frontend-root-body.txt -w '%{http_code}' http://localhost:5173/
curl -s -o /tmp/nyabase-vm-health-body.txt -w '%{http_code}' http://localhost:8428/health
ssh root@10.8.96.91 'systemctl is-active nyabase-agent; systemctl is-active nyabase-docker.service'
```

Result:

```text
backend /api/auth/me: 401
frontend root: 200
VictoriaMetrics /health: 200
CPU nyabase-agent: active
CPU nyabase-docker.service: active
```

Visual artifacts: n/a.

Failure classification: no failures.

Verdict: PASS
