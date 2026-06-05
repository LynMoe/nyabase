# Multi-User Red-Team Test Design

Session: `multi-user-redteam/20260602T035546Z`
Role: architect

## Goal

Execute a complete, repeatable nyabase deployment test in which at least five non-admin users exercise the system from user state only, stressing multi-user isolation, multi-image and multi-container behavior, quota boundaries, enforcement, concurrency, cleanup, metrics, audit, and stability.

## Interfaces

No product interface changes are planned. The test uses the current public surfaces below.

| Area | Interfaces under test | Before/after |
| --- | --- | --- |
| Auth and identity | `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET/POST/DELETE /api/auth/tokens` | No shape change; verify JWT/API-token behavior and user-only token scope. |
| Users and SSH keys | `GET/POST/PATCH/DELETE /api/users`, `GET/POST/DELETE /api/users/:id/ssh-keys` | No shape change; admin setup may manage users, user agents may only self-manage allowed fields/keys. |
| Groups and grants | `GET/POST/PATCH/DELETE /api/groups`, group/user `server-grants`, `image-grants`, `mount-source-grants`, `GET /api/me/access`, `GET /api/users/:userId/effective-access` | No shape change; verify grant resolution and forbidden management APIs from non-admin users. |
| Servers and images | `GET /api/servers`, `GET /api/servers/:id`, `GET /api/servers/:id/gpus`, `GET /api/servers/:id/disks`, `GET /api/images`, `GET /api/images/:id`, `POST /api/images/:id/pull`, `GET /api/images/:id/status` | No shape change; setup/admin only for create/update/delete/token operations. |
| Containers | `GET/POST /api/containers`, `GET/POST/DELETE /api/containers/:serverId/:dockerId`, `GET/PATCH /api/containers/:serverId/:dockerId/mounts`, `GET /api/containers/:serverId/:dockerId/stats`, `POST /api/containers/:serverId/:dockerId/exec`, `/ws/console` | No shape change; user agents create and operate only their own containers unless explicit negative tests expect denial. |
| Data dirs and mounts | `GET/POST/DELETE /api/data-dirs`, `GET /api/mount-sources`, `GET/POST/DELETE /api/mount-sources/grants`, `GET/POST/PATCH/DELETE /api/system/remote-fs-mounts` | No shape change; remote FS creation/assignment is admin-only setup, mount use is user-state when granted. |
| Metrics and audit | `GET /api/metrics/servers/:id/{host,gpus,users,containers}`, `GET /api/metrics/query`, `GET /api/metrics/query_range`, `GET /api/audit` | No shape change; verify normal-user label injection/isolation and admin-only audit visibility. |
| Agent/runtime | Agent WebSocket state, command RPCs, managed Docker, XFS project quota, GPU monitor, IP allocator, state cache, VictoriaMetrics | No shape change; devops captures runtime evidence and residual scans only. |

## Data Model Changes

No schema or migration changes are planned.

The test may create disposable rows and runtime resources with a single run prefix: `murt-<UTC>`. Cleanup must remove all created users, groups, grants, images, containers, data directories, container mounts, API tokens, SSH keys, and remote/local test artifacts. Tester/devops must never record raw passwords, JWTs, refresh tokens, API-token secrets, agent tokens, SSH private keys, or remote host credentials in session docs.

## File-Level Change List

| Path | Expected change |
| --- | --- |
| `.codex/skills/harness/docs/multi-user-redteam/20260602T035546Z/design.md` | Create this executable test design and traceability contract. |
| `.codex/skills/harness/docs/multi-user-redteam/20260602T035546Z/tests.md` | Tester/devops later records run ids, commands/procedures, outputs, pass/fail, cleanup, reruns, and evidence. |
| `.codex/skills/harness/docs/multi-user-redteam/20260602T035546Z/implementation.md` | Created only if product/test/infra fixes are required after a failure. |
| `.codex/skills/harness/docs/multi-user-redteam/20260602T035546Z/review.md` | Reviewer/PM later records final DoD status and blockers. |

## Admin Setup Prerequisites

All setup is performed by a devops/admin setup agent before user-state subagents begin. User-state agents must not receive or use admin tokens.

1. Verify environment health per `TEST_DEPLOY.md`: VictoriaMetrics health/query `200`, backend unauthenticated `/api/auth/me` returns `401`, frontend `/` returns `200`, CPU and GPU agents online, managed Docker active, GPU list present where supported, and common-src artifact guard returns no generated files.
2. Record server ids for one CPU server and one GPU server. If GPU is unavailable or quota-precondition blocked, mark GPU cases `blocked-infra` with exact host/quota evidence and continue CPU cases.
3. Create or identify local data disk source on the CPU server with XFS project quota enabled. Create or identify remote FS mount source assigned to the CPU server. Record source ids only, not host secrets.
4. Create disposable groups and direct user grants under prefix `murt-<UTC>`. Avoid modifying existing persistent user/grant policy except to read ids.
5. Create four image records:
   - `img-cpu-a`: active, `ubuntu:24.04`, granted to users A/B/E as specified.
   - `img-cpu-b-same-ref`: active, also `ubuntu:24.04`, granted differently from `img-cpu-a` to prove grants are by image id, not Docker ref.
   - `img-gpu-a`: active, GPU-capable base image available on the GPU server; if only `ubuntu:22.04` is present, use it for create/lifecycle and treat GPU workload proof as conditional on `nvidia-smi` availability.
   - `img-inactive`: same or harmless Docker ref, set `isActive=false`; granted to at least one user to prove inactive images cannot be used by normal users.
   - After inactive checks, delete/deactivate one disposable image record and verify stale grants/access disappear.
6. Pull/status check images on target servers using admin-only image APIs if local images are absent. User-state agents do not pull images unless the product grants that capability through normal user flows, which current design does not require.

## User Personas and Grants

Create at least the following five distinct non-admin users. None receives management capabilities such as `manage_users`, `manage_groups`, `manage_servers`, `manage_images`, `manage_grants`, `manage_containers_any`, `view_audit`, or `view_metrics_all`.

| User | Purpose | Server grants | Image grants | Mount-source grants | Allowed user-state actions |
| --- | --- | --- | --- | --- | --- |
| `murt-alpha` | CPU small quota and exact-boundary tests | CPU only: `cpuMillis=500`, `memBytes=256MiB`, `diskBytes=64MiB`, `gpuMode=none` | CPU `img-cpu-a` only | CPU local disk only | Login, self `/me`, create/list/detail/stats/exec/start/stop/restart/delete own CPU containers, create/delete own local data dirs, own API token, own SSH keys. |
| `murt-beta` | CPU medium, same Docker ref different grant, remote mount user | CPU only: `cpuMillis=1000`, `memBytes=512MiB`, `diskBytes=128MiB`, `gpuMode=none` | CPU `img-cpu-b-same-ref` only | CPU remote FS only | Same own-container lifecycle, create/use/delete own remote data dirs, verify cannot use alpha local-only source or `img-cpu-a` unless explicitly granted. |
| `murt-gamma` | GPU single-index user | GPU only: `cpuMillis=1000`, `memBytes=1GiB`, `diskBytes=256MiB`, `gpuMode=indices`, `gpuIndices=[0]` | GPU `img-gpu-a` only | None unless GPU local source exists and is explicitly granted | Create GPU container on GPU index `0`, query own GPU stats/metrics, verify indices other than `0` and CPU server access are denied. |
| `murt-delta` | Mixed CPU/GPU quota race and cross-user attacker | CPU grant: `cpuMillis=1500`, `memBytes=1GiB`, `diskBytes=256MiB`, `gpuMode=none`; GPU grant: `cpuMillis=1000`, `memBytes=1GiB`, `diskBytes=256MiB`, `gpuMode=indices`, `gpuIndices=[1]` | CPU `img-cpu-a`; GPU `img-gpu-a` | CPU local disk and CPU remote FS | Legit own CPU/GPU operations, plus negative attempts against alpha/beta/gamma ids, mounts, metrics labels, tokens, SSH keys, and management APIs. |
| `murt-epsilon` | Denied/no-access control user | No server grant, or one CPU grant with `cpuMillis=250`, `memBytes=128MiB`, `diskBytes=32MiB`, `gpuMode=none` depending on batch | No active image grants initially; later grant only inactive/deleted image for negative checks | No mount-source grants | Verify empty access, forbidden create/list/detail/use of ids; after temporary tiny grant, test over-limit and cleanup, then revoke to verify access disappears. |

Optional sixth user `murt-zeta` may be created as a read-only metrics/control user with exactly one CPU grant and one CPU image grant to increase concurrency fan-out, but the five required users above are sufficient.

## Executable Batches

Each batch must record `runId`, actor user, exact endpoint/command/procedure, expected result, actual result, evidence, cleanup status, and failure classification. User-state batches run in parallel where noted, using separate subagents and only that user's JWT or self-created API token.

| Batch | TEST_OUTLINE mapping | Actor lane | Procedure | Pass criteria |
| --- | --- | --- | --- | --- |
| B0 environment and baseline | 1, 10-12, 14-20, 30 | devops/admin setup | Health probes from `TEST_DEPLOY.md`, common-src artifact guard, CPU/GPU service status, VM query, agent online/state cache, available images/disks/GPUs. | All core services healthy or GPU-specific cases marked `blocked-infra` with exact proof; no common-src artifacts. |
| B1 admin setup | 3-7, 9, 13 | devops/admin setup | Create users, groups, grants, image records, local/remote source grants, optional API fixtures. Record ids in tests doc with secrets redacted. | Exactly defined persona access appears in `GET /api/users/:id/effective-access`; normal users have no management caps. |
| B2 auth and self-state | 2, 3, 21 | five user agents | Each user logs in, calls `/auth/me`, rotates refresh, creates user API token, uses token for `/auth/me`, deletes token, verifies deletion; self displayName/password update and SSH key add/list/delete; forbidden attempts to list users/groups/audit. | User auth works, token secret appears once, deleted token fails, self operations allowed, all management APIs return `403`/`404` as appropriate. |
| B3 access and image matrix | 4-7, 23 | five user agents | Call `/me/access`, `/servers`, `/images`; try allowed image create container dry path, disallowed image detail/create, inactive image list/detail/create, deleted/deactivated image access, same Docker ref with different grants. | Lists contain only granted active resources; inactive/deleted and ungranted images cannot be used; same Docker ref does not bypass image-id grants. |
| B4 CPU container lifecycle | 8, 15, 20, 24, 29 | alpha, beta, delta, epsilon if tiny grant | Create CPU containers below and exact quota; list own; get detail/stats; exec shell; stop/start/restart; delete running and stopped containers; force-delete path through normal `DELETE`. | Own lifecycle succeeds within grants; stats non-empty when agent reports; shell outputs run id; delete removes API and Docker residuals. |
| B5 GPU container lifecycle | 6, 8, 18, 19, 20, 24, 27, 29 | gamma and delta | Where GPU server supports product containers, create containers with granted GPU indices, query `/servers/:id/gpus`, detail/stats, metrics users/containers, shell if image supports it, lifecycle and cleanup. Try ungranted index and over-count requests. | Granted GPU create/lifecycle succeeds; ungranted GPU requests fail before runtime mutation; GPU metrics are attributed to the owning user/container when workload produces samples. |
| B6 quota boundaries | 5, 8, 11, 15, 16, 19, 29 | five user agents | CPU/mem/disk/GPU cases: below, exact, over, remaining-quota exhaustion, concurrent race. Include writable-layer and mounted data-dir writes below/over disk limit; CPU/mem create requests over grant; GPU index/count over grant. | Below/exact succeed, over-limit returns `400/403/502` only where infra precondition fails; no over-quota resource remains; disk writes fail with enforced limit and no host quota leak. |
| B7 data dirs and mounts | 8, 9, 16, 17, 20, 25 | alpha, beta, delta | Create/list/delete local and remote dirs according to grants; mount at container create and via `PATCH /containers/:id/mounts`; same-owner sharing; cross-user source/dir guessing; delete in-use denial; cleanup after container delete. | Granted mounts work, ungranted source/other-user dirs fail, in-use deletes are denied, delete cleanup removes mount rows and host/runtime residuals. |
| B8 cross-user red-team isolation | 2-9, 12, 13, 21-28 | delta plus all users | Directly guess other users' docker ids, server ids, image ids, source ids, token ids, SSH key ids; attempt detail/stats/start/stop/restart/delete/exec/mount updates; query metrics with injected labels and `all=true`; attempt audit and management APIs. | Owner or capability checks prevent all cross-user actions; no metrics leak through label injection; token/SSH ids from other users return `404/403`; audit hidden from normal users. |
| B9 concurrency and state stability | 8, 10, 11, 15, 19, 20, 29 | all five user agents in parallel | Near-concurrent create/delete bursts on CPU and GPU where available; repeated lifecycle loops; simultaneous quota-exhausting creates; near-concurrent local/remote data-dir create/delete; record IPs and statuses. Trigger agent reconnect/state reconciliation only through allowed devops operation if this batch is assigned to devops, never by user agents. | No duplicate IP allocation, quota races, stuck creating/deleting states, orphaned containers/mounts, stale API rows, or state-cache mismatch after reconciliation. |
| B10 metrics and audit evidence | 12, 13, 18, 19, 27, 28 | admin evidence agent plus user agents | Normal users query own host/gpu/container/user metrics and raw PromQL attempts; admin queries audit after representative allow/deny operations and metrics all-view only with admin token. | User metrics are scoped to accessible servers and own containers where product semantics require; audit records successful and rejected sensitive operations where implemented; normal users cannot read audit. |
| B11 cleanup and residual scans | 8-20, 29, 30 | devops/admin cleanup | Delete all created containers, mounts, data dirs, grants, images, groups, users, remote assignments if disposable; scan product API, managed Docker, XFS projects/projid lines, remote/local paths, VM noise if relevant. | Zero residual product rows and zero exact run-prefix runtime resources; services remain healthy; common-src guard clean. |

## Quota Boundary Matrix

Use binary byte values in requests and evidence. For each resource, record the user's resolved grant from `/me/access` before the operation.

| Resource | Below grant | Exact grant | Over grant | Remaining-quota exhaustion | Race probe |
| --- | --- | --- | --- | --- | --- |
| CPU | Create with `cpuMillis = grant - 1` or half grant. | Create with `cpuMillis = grant`. | Create with `grant + 1`; expect rejection before runtime mutation. | Create multiple containers whose sum reaches grant, then one more small container; expect final rejection. | Two simultaneous creates whose individual values fit but combined value exceeds remaining quota; at most one may succeed. |
| Memory | Same pattern using `memBytes`, minimum practical values aligned to product constraints. | Same as grant. | `grant + 1` or clearly over grant. | Multiple live containers consume remaining memory grant. | Simultaneous memory creates racing the same remaining quota. |
| Disk writable layer | Container create with `diskBytes` under grant and below-limit in-container write. | Grant-sized write/load where practical; exact enforcement can be proven by quota report hard limit if exact write is too brittle. | Over-limit write must fail with no-space/truncation and quota hard limit visible. | Multiple containers/data dirs share user's disk quota until exhausted. | Two simultaneous disk-heavy writes or creates against remaining quota. |
| Local/remote data dirs | Below-limit write into mounted dir. | Exact hard-limit proof for local XFS where feasible; remote FS may be capacity-only if no XFS quota. | Over-limit local write fails; remote behavior documented according to mounted FS semantics. | Multiple dirs/containers for same user exhaust disk grant. | Concurrent create/delete and writes to same owner dir. |
| GPU indices/count | Request granted index (`[0]` for gamma, `[1]` for delta). | Request exactly all granted indices. | Request ungranted index, duplicate/invalid index, or `gpuCount` greater than grant; expect rejection. | If a user has multiple allowed indices, consume all then request one more; otherwise use cross-user contention on same physical GPU only if product has scheduling semantics. | Gamma/delta simultaneous creates on different granted indices; no unauthorized index allocation or stuck states. |

## Cross-User Bypass Checklist

For each attempted bypass, record target owner, attacker, endpoint/procedure, expected denial code, and proof that target resource state did not change.

- Container list/detail/stats/action/exec/delete by guessed `serverId` and full/short `dockerId`.
- Container mount list/update with another user's container id or source id.
- Data-dir list/create/delete using another user's `sourceKind/sourceId/name`.
- Remote FS source use without mount-source grant, including direct mount source id guessing.
- Metrics raw query label injection: `nyabase_container_mem_used_bytes{user_id="<victim>"}`, duplicate `user_id`, regex selectors, `or` expressions, aggregation `by/without`, string literals containing metric names, `all=true` on container metrics.
- API token deletion/list attempts for another user's token id; verify token secrets are never disclosed after creation.
- SSH key list/add/delete for another user id.
- Management APIs: users, groups, servers create/update/delete, server token regenerate, image create/update/delete/pull where normal users lack caps, remote FS management, audit list, admin data-dir issue list.
- Direct id guessing for inactive/deleted images, revoked grants, deleted containers, and deleted users.

## Evidence Expectations

`tests.md` should be concise but traceable. Each batch entry must include:

- `Run ID`: `murt-<UTC>-<batch>`.
- `Actors`: admin setup, devops, or specific user persona; explicitly state no user-state actor used admin token.
- `Inputs`: server/image/source ids, grants, request resource values, redacted auth method.
- `Procedure`: exact commands or API call summaries sufficient to rerun; raw secrets redacted.
- `Expected` and `Actual`: status codes, key response fields, Docker/runtime state, quota reports, VM/backend metrics, audit rows.
- `Cleanup`: API cleanup plus runtime residual scan; exact remaining resources if any.
- `Classification`: `pass`, `fail-product`, `fail-test`, `fail-infra`, `blocked-infra`, or `not-applicable`.

Evidence must be enough to prove both success and non-mutation on rejected attempts. For concurrency batches, include operation start timestamps or monotonic ordering, final state snapshot, and residual scan.

## Cleanup Rules

Cleanup runs after every batch and again at final teardown.

1. Prefer product API deletes for containers, data dirs, grants, images, users, groups, and remote assignments.
2. Only devops/admin cleanup may inspect managed Docker, host paths, XFS project files, or remote hosts. User-state agents never perform host-level cleanup.
3. Delete containers before data dirs and mount-source grants; delete image/server grants before image/user records; delete API tokens before users where possible.
4. Residual scan keys are exact run prefix, user ids, image ids, docker ids, data-dir names, mount ids, and XFS project/projid lines. Do not broad-delete unrelated resources.
5. If cleanup fails, classify as `fail-product` when product API cannot remove a product-owned resource, `fail-infra` when host/runtime mutation is unavailable, or `fail-test` when the harness lost ids or issued invalid cleanup.

## Rerun and Fix Loop Routing

- Product/API/runtime behavior failure: record minimal reproducer, evidence, expected behavior from this design, and route to architect only if expected behavior or scope is ambiguous; otherwise route to developer, then tester/devops reruns the smallest failing batch and B11 cleanup.
- Test harness/procedure failure: tester/devops fixes only the test procedure or docs, reruns affected operations, and preserves failed-attempt history.
- Infrastructure failure: devops documents exact host/service/precondition, performs allowed remediation if in scope, then reruns affected batches. If remediation would mutate production-like remote host state beyond `TEST_DEPLOY.md`, mark `blocked-infra`.
- Security/isolation failure: treat as high priority `fail-product`; keep affected resource ids until evidence is captured, then cleanup.
- Visual/UI-only failure discovered during frontend flows: route through tester/developer visual path and require visual checks; this design is primarily API/runtime but frontend regressions are not ignored.
- After any code change, require `bash scripts/check.sh`; after rendered frontend changes, require `bash scripts/check-visual.sh` and visual acceptance per harness.

## Acceptance Criteria

1. At least five distinct non-admin users are created and tested, with exact grants matching the persona table and no user-state use of admin tokens.
2. Batches B0-B11 map `TEST_OUTLINE.md` themes across auth, users, groups, grants, servers, images, containers, data dirs, remote mounts, metrics, audit, agent quotas, state cache, and deployment health.
3. Multi-image behavior covers allowed, disallowed, inactive, deleted/deactivated, and same Docker ref with different image grants.
4. Multi-container behavior covers CPU and GPU where supported, including create, list, detail, stats, shell/exec, start, stop, restart, delete/force-delete, cleanup, and residual scans.
5. CPU, memory, disk, and GPU quota boundaries cover below, exact, over, remaining-quota exhaustion, and concurrent race probes.
6. Cross-user isolation attempts cover container detail/stats/actions, data dirs, remote mounts, metrics label injection, API tokens, SSH keys, management APIs, and direct id guessing.
7. Stability probes cover near-concurrent create/delete, repeated lifecycle loops, agent reconnect/state reconciliation, IP allocation uniqueness, and absence of residual resources.
8. Metrics and audit evidence is captured for representative successful and rejected operations, with normal-user scoping and admin-only audit/all-metrics behavior verified.
9. Cleanup proves no exact run-prefix product rows, Docker containers, mount rows, host paths, XFS project/projid entries, or disposable grants/users/images remain.
10. Every failure is classified and routed through product/test/infra fix loops with a focused rerun and concise traceability in session docs.

## Risks and Trade-Offs

- GPU cases depend on host quota, NVIDIA runtime, and image availability; design continues CPU/security coverage if GPU is `blocked-infra` rather than stopping the full matrix.
- Exact disk boundary writes can be brittle due to filesystem metadata; quota hard-limit reports may be used as exact-boundary proof, with over-limit writes proving enforcement.
- Concurrent tests can create timing-dependent outcomes; pass/fail is based on invariants after convergence: no over-quota success, no duplicate IPs, no stuck states, and no residuals.
- Same Docker ref with separate image records is included because grant resolution should key by image id; alternative was testing only distinct Docker refs, which would miss this bypass class.
- User-state agents are constrained to public APIs and console WS; host-level verification is reserved for devops to avoid invalid red-team privileges.

## Out of Scope

- Source, test, script, config, database schema, or runtime service changes in this design dispatch.
- Permanent production hardening unrelated to failures found by these batches.
- Destructive broad cleanup of unrelated containers, images, host files, users, groups, or grants.
- Recording raw secrets or credentials.
- Asking PM/user for per-case decisions; blockers and risks are classified autonomously with evidence.
