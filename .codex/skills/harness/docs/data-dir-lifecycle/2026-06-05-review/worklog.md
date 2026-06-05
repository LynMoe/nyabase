# Worklog

## Commands

- `pnpm --filter @nyabase/backend test -- --run src/datadirs/datadirs-operations.test.ts src/datadirs/datadirs.service.test.ts src/remote-fs/remote-fs-mounts-operations.test.ts`
  - Result: passed, 3 files / 9 tests.
- `pnpm --filter @nyabase/agent test -- --run src/commands/dispatcher.test.ts`
  - Result: passed, 1 file / 34 tests.
- `pnpm --filter @nyabase/backend test -- --run src/operations/operations.service.test.ts src/operations/lifecycle-hook-registry.service.test.ts`
  - Result: passed, 2 files / 4 tests.
- `pnpm test:unit`
  - Result: passed, common 3 files / 50 tests, backend 24 files / 106 tests, agent 5 files / 76 tests.
- `tools/mount-helper/target/release/nyabase-mount-helper mount --pid $$ --src /tmp/nyabase-helper-review-*/src --dst /tmp/nyabase-helper-review-*/dst`
  - Result: mounted, read `helper-mount-lifecycle-ok`, helper list returned the dst entry, helper umount succeeded.
- Cleanup checks:
  - `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
  - `find /tmp -maxdepth 1 -type d \( -name 'nyabase-mount-review-*' -o -name 'nyabase-helper-review-*' \) -print | sort`
  - Result: both empty.

## Notes

- `cargo test --manifest-path tools/mount-helper/Cargo.toml` could not run because `cargo` is not installed in this environment.
- The existing release mount-helper binary was available and was used for actual mount/umount execution.

## Review Result

- Local data dir create/delete has durable desired-state and terminal operation cleanup hooks.
- Remote data dir create/delete uses the same `DataDirsManager` path after `remote_fs.apply` adds the remote source.
- Remote FS mount removal and unassignment guard only `container_mounts`; they do not guard or cascade `data_directories` rows that still reference the remote source.
- On successful full remote mount removal, `remote_fs_mounts`, assignments, and grants are deleted, but `data_directories` for `sourceKind='remote'` and the removed `sourceId` are not deleted.

## Fix Follow-up

- Added source-removal guards so local disks and remote FS mounts cannot be removed while data directories still reference the source.
- Added regression tests for local disk removal, remote mount removal, and remote assignment removal with existing data directories.
- Verification after fix:
  - `pnpm --filter @nyabase/backend test -- --run src/servers/servers-operations.test.ts src/remote-fs/remote-fs-mounts-operations.test.ts src/datadirs/datadirs-operations.test.ts src/datadirs/datadirs.service.test.ts`: passed, 4 files / 15 tests.
  - `pnpm --filter @nyabase/backend typecheck`: passed.
  - `pnpm test:unit`: passed, common 3 files / 50 tests, backend 24 files / 109 tests, agent 5 files / 76 tests.
  - `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`: empty.

## Live Boundary Retest

- Rebuilt and restarted local backend/frontend with `bash test/scripts/start-local.sh`; CPU and GPU agents reconnected online.
- `bash test/scripts/run-live-suite.sh smoke`: passed.
- `bash test/scripts/run-live-suite.sh mounts`: failed in the console exec lane with `console websocket timed out; output=`. The suite did create a local data dir and two mounted containers before the failure, and its `finally` cleanup removed them. Report evidence:
  - `test/runtime/mount/20260605t053331z-1d1805/mount-runtime-report.md`
  - Final residuals in that report: alpha-local/beta-remote/delta-both all `containers=0 dataDirs=0`.
- Added and ran API-only live probe:
  - `test/runtime/nyabase-data-dir-live-probe.mjs`
  - Passing report: `test/runtime/mount/manual-20260605t084645z/data-dir-live-probe.json`
  - Covered: local data-dir create, mounted container create, mounted data-dir delete guard, local disk removal guard, remote data-dir create, remote mount removal guard, remote unassign guard, dynamic mount add/remove, container delete, local/remote data-dir delete, final residual check.
  - Final residuals: `containers=[]`, `dataDirs=[]`, `issues=[]`.
- During the first API probe, `/admin/data-dirs/issues` retained a probe orphan after cleanup. Root cause: `dataDirReport` ingestion never staled observations omitted from later reports, so historical `present=true` rows could remain visible as latest issues. Fixed by staling previous non-stale rows for the server on each data-dir report and filtering stale rows out of `getIssues`.
- Added regression test:
  - `packages/backend/src/datadirs/data-dir-reconciler.test.ts`
  - Verifies an orphan disappears after a later empty data-dir report.
- Verification after live fix:
  - `pnpm --filter @nyabase/backend test -- --run src/datadirs/data-dir-reconciler.test.ts src/servers/servers-operations.test.ts src/remote-fs/remote-fs-mounts-operations.test.ts src/datadirs/datadirs-operations.test.ts src/datadirs/datadirs.service.test.ts`: passed, 5 files / 16 tests.
  - `pnpm --filter @nyabase/backend typecheck`: passed.
  - `pnpm test:unit`: passed, common 3 files / 50 tests, backend 25 files / 110 tests, agent 5 files / 76 tests.
  - `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`: empty.

## Target Server Warning Cleanup

- Queried `/api/admin/data-dirs/issues`; current warnings were on CPU server `nyabase-test-cpu` source `/data/nyabase-docker`.
- SSH target: `root@10.8.96.91`.
- Classified `/data/nyabase-docker` as the agent Docker root from `/api/admin/servers`, so Docker internal directories were not deleted:
  - `buildkit`, `containers`, `image`, `network`, `overlay2`, `plugins`, `runtimes`, `swarm`, `tmp`, `volumes`.
- Removed only empty human/test residue directories:
  - `/data/nyabase-docker/test`
  - `/data/nyabase-docker/hitest`
- Added agent-side filtering so data-dir reports skip Docker root reserved directories when a local data source root equals `config.dockerRoot`.
  - Changed `packages/agent/src/datadirs/data-dirs.ts`.
  - Passed `config.dockerRoot` from `packages/agent/src/app.ts`.
  - Added `packages/agent/src/datadirs/data-dirs.test.ts`.
- Rebuilt standalone agent with `bash scripts/build-agent-binary.sh`, deployed to CPU target, and restarted `nyabase-agent`.
- Verification:
  - `/api/admin/data-dirs/issues`: `[]`.
  - CPU/GPU agents online.
  - `ssh root@10.8.96.91 'find /data/nyabase-docker -maxdepth 1 -mindepth 1 -type d \( -name "test" -o -name "hitest" -o -name "mount-*" -o -name "probe-*" \) -print | sort'`: empty.
  - `pnpm --filter @nyabase/agent test -- --run src/datadirs/data-dirs.test.ts src/commands/dispatcher.test.ts`: passed, 2 files / 35 tests.
  - `pnpm --filter @nyabase/agent typecheck`: passed.
  - `pnpm --filter @nyabase/backend test -- --run src/datadirs/data-dir-reconciler.test.ts`: passed.
  - `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`: empty.
