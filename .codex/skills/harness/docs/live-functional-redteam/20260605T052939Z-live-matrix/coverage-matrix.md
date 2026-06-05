# Live Functional / Red-Team Coverage Matrix

Session: `20260605T052939Z-live-matrix`
Lane: tester, read-only analysis
Scope: mapped existing live suites and functional coverage only. No services were started and no destructive live tests were run.

## Suite Entry Points

Required preflight/runtime setup from `test/README.md` and `test/docs/RUNBOOK.md`:

```bash
bash test/scripts/reset-local.sh
node test/scripts/register-agents.mjs
bash test/scripts/deploy-agents.sh
bash test/scripts/run-live-suite.sh smoke
```

Requested live flow commands:

```bash
bash test/scripts/run-live-suite.sh admin-setup
bash test/scripts/run-live-suite.sh continuation
bash test/scripts/run-live-suite.sh personas
node test/scripts/create-mount-fixture.mjs
bash test/scripts/run-live-suite.sh mounts
bash test/scripts/run-live-suite.sh dropbear
```

Functional API smoke outside the live spec tree:

```bash
pnpm test:functional
```

## Coverage Matrix

| Requested area | Existing command/spec | Current coverage | Gaps / notes |
| --- | --- | --- | --- |
| Admin account setup | `run-live-suite.sh smoke`, `multi-user-redteam-admin-setup.spec.ts`, `dropbear-live-runtime.spec.ts` | Admin login, admin management capabilities, server discovery, user/image/grant setup. | No explicit admin UI flow; API-only. |
| User account creation | `multi-user-redteam-admin-setup.spec.ts`, `create-mount-fixture.mjs`, `dropbear-live-runtime.spec.ts`, `pnpm test:functional` | Creates multiple non-admin users/personas; verifies login and no management capabilities. | Good API coverage. |
| User groups | `test/scripts/run-functional.sh` | Creates one group with `manage_images`, adds user as member, reads user. | Live multi-user/red-team specs do not create persona groups or group-based quota/image/mount grants. Main requested "分配几个不同的用户组" is only lightly covered by functional script, not live personas. |
| Quota/grants setup | `multi-user-redteam-admin-setup.spec.ts`, `dropbear-live-runtime.spec.ts`, `create-mount-fixture.mjs` | Server grants include CPU/memory/disk and GPU mode/indices per persona; effective access exact-match assertions. | Quota enforcement is not directly stress-tested with over-CPU/over-memory/over-disk create requests. No multi-container aggregate quota exhaustion test found. |
| Image setup/access | `multi-user-redteam-admin-setup.spec.ts`, `create-mount-fixture.mjs`, `dropbear-live-runtime.spec.ts` | Creates active CPU/GPU images, inactive image grant for epsilon, image grants per user/server, image pull/status in mount/dropbear fixtures. | Image denial is implicit through unauthorized create attempts; no explicit "granted server but ungranted image" denial matrix for every persona. |
| Create instance/container | `multi-user-redteam-alpha/beta/gamma/delta/continuation.spec.ts`, `multi-user-redteam-mount-sources.spec.ts`, `dropbear-live-runtime.spec.ts` | Creates CPU, optional GPU, mounted, plain, and SSH-enabled containers using V2 operation flow. | Good live API coverage. |
| Start/stop/restart | `multi-user-redteam-alpha.spec.ts`, `multi-user-redteam-beta.spec.ts`, `multi-user-redteam-continuation.spec.ts`, `dropbear-live-runtime.spec.ts` | Alpha stop/start/restart, beta stop/start, continuation restart, Dropbear restart with SSH revalidation. | Good coverage for owner actions; no admin start/stop/restart any-owner live test found. |
| Delete instance/container | `multi-user-redteam-alpha/beta/gamma/delta/continuation.spec.ts`, `multi-user-redteam-mount-sources.spec.ts`, `dropbear-live-runtime.spec.ts` | Owner delete via operation; cleanup and residual scans in mount/dropbear. | Good owner cleanup coverage. |
| SSH / Dropbear | `run-live-suite.sh dropbear` -> `dropbear-live-runtime.spec.ts` | Adds/deletes SSH keys, create-time SSH enabled, manual enable, password rejection, real SSH login, key sync after deletion, Dropbear kill and reconcile repair, restart persistence, User B denials. | Strongest coverage area. |
| Console/exec | `multi-user-redteam-mount-sources.spec.ts`, `dropbear-live-runtime.spec.ts` | Opens exec sessions over console WebSocket; reads/writes mounted data; kills Dropbear via console. | Covered as part of mount/SSH, not a standalone permission matrix for all users. |
| Mount sources | `node test/scripts/create-mount-fixture.mjs`, `run-live-suite.sh mounts` -> `multi-user-redteam-mount-sources.spec.ts` | Creates local disk and remote NFS fixture, grants local/remote/both personas, verifies visible sources, denies ungranted source use, creates data dirs, creates mounted containers, dynamic update-mounts add/remove, read/write, guarded in-use delete, cleanup. | Strong coverage. Requires `NYABASE_MOUNT_*` env and actual NFS/local mount availability. |
| Group permissions | `pnpm test:functional` only | Ordinary user isolation plus one group capability assignment. | Missing live red-team group personas. No cross-group resource denial, group priority conflict, inherited quota/image/mount grants, or group capability escalation tests found. |
| Image access denial | `multi-user-redteam-epsilon.spec.ts`, `multi-user-redteam-alpha.spec.ts`, `multi-user-redteam-gamma-delta-attack.spec.ts` | Epsilon cannot create with CPU image despite inactive-only grant; alpha denied GPU create; delta cannot access gamma container. | Missing explicit CPU ungranted-image denial and inactive-image create denial by epsilon using its inactive image ID. |
| Cross-user/resource denial | `multi-user-redteam-gamma-delta-attack.spec.ts`, `multi-user-redteam-mount-sources.spec.ts`, `dropbear-live-runtime.spec.ts` | Delta denied gamma detail/stats/stop/delete; User B denied User A container detail/stats/start/stop/restart/delete/SSH actions; delta denied deleting alpha/beta data dirs. | Good bounded cross-user coverage. |
| Quota abuse / destructive attempts | `multi-user-redteam-epsilon.spec.ts`, `multi-user-redteam-alpha.spec.ts` | No-access user create denied; non-GPU persona GPU create denied. | Missing requested red-team quota abuse: over quota CPU/memory/disk/GPU index, aggregate quota exhaustion, concurrent create race, disk fill or mount abuse attempts. |
| Metrics/logs | `multi-user-redteam-gamma.spec.ts`, `run-functional.sh`, `run-live-suite.sh smoke` | Container stats endpoint checked by owner; gamma metrics server container path accepts 200 or 403; VictoriaMetrics health checked; ordinary user cannot read audit in functional script. | Logs are not tested beyond service log files existing as runtime artifacts. No audit/event log completeness assertions found. Metrics access expectation allows either 200 or 403, so it is a non-leak smoke, not strict authorization coverage. |
| Cleanup evidence | `multi-user-redteam-mount-sources.spec.ts`, `dropbear-live-runtime.spec.ts` | Prefix residual scans and best-effort cleanup for containers/data dirs/users/images/grants/SSH keys in the deeper suites. | Persona specs delete their own containers but do not write a consolidated cleanup ledger. |

## Exact Spec Files

- `test/specs/live/multi-user-redteam-admin-setup.spec.ts`
- `test/specs/live/multi-user-redteam-continuation.spec.ts`
- `test/specs/live/multi-user-redteam-alpha.spec.ts`
- `test/specs/live/multi-user-redteam-beta.spec.ts`
- `test/specs/live/multi-user-redteam-gamma.spec.ts`
- `test/specs/live/multi-user-redteam-delta.spec.ts`
- `test/specs/live/multi-user-redteam-epsilon.spec.ts`
- `test/specs/live/multi-user-redteam-gamma-delta-attack.spec.ts`
- `test/specs/live/multi-user-redteam-mount-sources.spec.ts`
- `test/specs/live/dropbear-live-runtime.spec.ts`

## Missing Requested Coverage

1. Live personas using different user groups. Existing live setup grants users directly; group coverage is limited to `pnpm test:functional`.
2. Quota enforcement under abusive requests: over CPU, memory, disk, GPU index, aggregate multi-container quota exhaustion, and concurrent quota race.
3. Group-derived permissions/quotas/images/mount sources and cross-group denial/escalation attempts.
4. Explicit ungranted-image and inactive-image create denial assertions.
5. Strict metrics/log authorization and audit completeness; current checks are reachability or non-leak smoke.
6. A single complete live functional report that merges admin-setup, persona, mount, Dropbear, cleanup, and residual evidence. Mount and Dropbear already emit reports; other live persona specs do not.

## Recommended Execution Order For Full Report

1. Devops lane: runtime fingerprint and reset/register/deploy/smoke.
2. Admin fixture lane: `bash test/scripts/run-live-suite.sh admin-setup`; record users, grants, setup gaps.
3. Persona lane: `bash test/scripts/run-live-suite.sh continuation && bash test/scripts/run-live-suite.sh personas`.
4. Mount lane: `node test/scripts/create-mount-fixture.mjs && bash test/scripts/run-live-suite.sh mounts`.
5. SSH lane: `bash test/scripts/run-live-suite.sh dropbear`.
6. Red-team gap lane: add or run supplemental tests for group-based grants and quota-abuse cases before claiming the original request is fully covered.
