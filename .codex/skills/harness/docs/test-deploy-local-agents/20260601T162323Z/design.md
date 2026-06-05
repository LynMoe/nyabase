# Local Test Deployment and Agent Verification Design

## Goal

Deploy the documented local nyabase test stack, connect one CPU agent and one GPU agent, verify every requested Agent and Backend capability in independent batches, and route any product failures through architecture, development, testing, and review.

## Source of Truth

- Runbook: `TEST_DEPLOY.md`.
- Test outline: `TEST_OUTLINE.md`.
- Environment file: `test/.env`.
- Requirement record: `.codex/skills/harness/docs/test-deploy-local-agents/20260601T162323Z/requirements.md`.
- Target topology:
  - Local VictoriaMetrics: `127.0.0.1:8428`.
  - Local backend: `localhost:3001`, started from `packages/backend/dist/main.js` with `test/.env`.
  - Local frontend: `localhost:5173`.
  - CPU agent host: `root@10.8.96.91`, `dockerRoot=/data/nyabase-docker`, `parentIface=eth0`.
  - GPU agent host: `lyn@10.8.1.12` via `sudo`, `dockerRoot=/data0/nbTest/nyabase-docker`, `parentIface=bond0`, `isGpuServer=true`, 4 NVIDIA L40 expected where host state matches the runbook.

## Interfaces

### REST Interfaces

No interface redesign is planned before verification. The deployment and test batches exercise the current public API:

- Auth and users:
  - `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`, `/api/auth/tokens`.
  - `GET/POST /api/users`, `GET/PATCH/DELETE /api/users/:id`, `GET/POST/DELETE /api/users/:id/ssh-keys`.
- Groups, capabilities, grants:
  - `GET/POST /api/groups`, `GET/PATCH/DELETE /api/groups/:id`.
  - `POST/DELETE /api/groups/:id/members`.
  - `POST/DELETE /api/groups/:id/server-grants/:serverId`.
  - `POST/DELETE /api/groups/:id/image-grants...`.
  - User-scoped equivalents under `/api/users/:id/server-grants` and `/api/users/:id/image-grants`.
  - Mount source grants under `/api/mount-sources/grants`.
- Servers:
  - `GET/POST /api/servers`, `GET/PATCH/DELETE /api/servers/:id`.
  - `PATCH /api/servers/:id/defaults`.
  - `POST /api/servers/:id/regenerate-token`.
  - `GET /api/servers/:id/gpus`.
  - `GET/POST/PATCH/DELETE /api/servers/:id/disks`.
  - `GET /api/servers/:id/self-check`.
  - `POST /api/servers/:id/docker-daemon/reconcile`.
- Images:
  - `GET/POST /api/images`, `GET/PATCH/DELETE /api/images/:id`, image pull endpoints and progress SSE where used by UI/API.
- Containers:
  - `GET/POST /api/containers`.
  - `GET /api/containers/:serverId/:dockerId`.
  - `POST /api/containers/:serverId/:dockerId/start|stop|restart`.
  - `DELETE /api/containers/:serverId/:dockerId` currently maps to forced agent deletion (`force: true`).
  - `GET/PATCH /api/containers/:serverId/:dockerId/mounts`.
  - `GET /api/containers/:serverId/:dockerId/stats`.
  - `POST /api/containers/:serverId/:dockerId/exec`.
- Data directories and storage:
  - `/api/data-dirs`.
  - `/api/remote-fs-mounts` and server assignment/remount endpoints.
  - `/api/mount-sources`.
- Metrics:
  - `GET /api/metrics/query`.
  - `GET /api/metrics/query_range`.
  - `GET /api/metrics/servers/:id/host`.
  - `GET /api/metrics/servers/:id/gpus`.
  - `GET /api/metrics/servers/:id/users`.
  - `GET /api/metrics/servers/:id/containers`.

If verification exposes missing fields or wrong semantics, the expected change is additive or behavior-preserving unless a bug requires strict validation. Do not break existing DTO names without a follow-up compatibility design.

### Agent WebSocket Protocol

Current Agent to Backend messages are the verification contract:

- `hello`: baseline report including hostname, CPU cores, memory, disks, `gpus`, local images, docker root/socket.
- `heartbeat`: liveness.
- `stateReport`: containers, XFS project usage, disks, remote FS statuses.
- `metricsBatch`: VictoriaMetrics samples.
- `commandAck`: RPC result.
- `containerEvent`: lifecycle updates.
- `logChunk`: shell output.
- `dataDirReport`: storage directory inventory.
- `remoteFsMountStatus`: NFS/CephFS mount status.
- `dockerDaemonStatus`: managed dockerd state.

Current Backend to Agent commands are the verification contract:

- Container lifecycle: `createContainer`, `startContainer`, `stopContainer`, `restartContainer`, `deleteContainer`, `fetchContainerStats`.
- Shell: `execStream`, `execResize`, `execInput`, `execClose`.
- Storage and quotas: `checkDisk`, `applyDataDisk`, `removeDataDisk`, `createDataDir`, `deleteDataDir`, `updateUserQuota`.
- Remote mounts and container mounts: `applyRemoteFsMount`, `removeRemoteFsMount`, `reconcileContainerMounts`, `applyContainerMount`, `removeContainerMount`.
- Operations: `pullImage`, `reconcile`, `selfCheck`, `reconcileDockerDaemon`.

### Metrics Names

Verification must check raw samples in VictoriaMetrics and product API/UI display:

- Host: `nyabase_host_cpu_usage_ratio`, `nyabase_host_mem_used_bytes`, `nyabase_host_mem_total_bytes`, `nyabase_host_load1`, disk and net counters.
- Disk capacity and user quota usage: `nyabase_disk_total_bytes`, `nyabase_disk_used_bytes`, `nyabase_user_disk_used_bytes`.
- Container: `nyabase_container_cpu_usage_usec`, `nyabase_container_mem_used_bytes`, IO and network counters.
- GPU host: `nyabase_gpu_util_ratio`, `nyabase_gpu_mem_used_bytes`, `nyabase_gpu_temp_celsius`, `nyabase_gpu_power_watts`.
- GPU per-container attribution: `nyabase_gpu_proc_mem_used_bytes` with `container_id` and `user_id` labels.

Watch item: `nyabase_user_disk_used_bytes` is emitted from the agent with numeric Linux user IDs, while backend user metrics currently aggregate by UUID user IDs. Tester should explicitly verify whether user disk usage appears under the expected product user identity.

## Data Flows

1. Local backend starts with `test/.env`, syncs SQLite schema, creates initial `admin/admin123`, and exposes REST plus `/ws/agent`.
2. Admin creates CPU and GPU server records; raw one-time agent tokens are copied into each host's `/etc/nyabase/agent.yaml`.
3. Agent starts, reconciles the nyabase-managed dockerd service, connects to `/ws/agent` with `Authorization: Bearer <agentToken>`, sends `hello`, and receives `reconcile`.
4. Backend stores online status in the database and live state in `AgentGateway.stateCache`.
5. Backend reconnect hooks push known local disks, remote FS mounts, and quota limits back to the agent.
6. Agent sends full `stateReport`, `dataDirReport`, `dockerDaemonStatus`, and periodic `metricsBatch`.
7. Backend `MetricsWriter` imports Prometheus lines into VictoriaMetrics; metrics APIs query VM and merge stateCache inventory for display DTOs.
8. Container requests resolve permissions and quotas in `AccessResolverService`, validate resources in `resource-quota.policy.ts`, call agent RPC, and reconcile state after lifecycle operations.
9. Shell requests open an exec RPC, register a console session, and stream `logChunk` messages to browser console WebSocket clients.
10. Mount requests persist expected mounts in the backend database, then agent applies mount namespace changes through the embedded mount helper.

## Data Model Changes

No up-front schema migration is required for deployment verification.

Likely data model change areas if bugs are found:

- GPU metrics and attribution:
  - `packages/common/src/protocol/agent-messages.ts`: `GpuInfo`, `MetricPoint`, `ContainerStatsSummary` shape if attribution needs additional labels or GPU UUID/index mapping.
  - `packages/backend/src/metrics/metrics.controller.ts`: merge VM series with `stateCache` and DTO identity mapping.
  - `packages/agent/src/gpu/gpu-monitor.ts`: PID-to-container detection and labels.
- Permissions and quotas:
  - `packages/backend/src/entities/server-grant.entity.ts`, `server.entity.ts`, and grant DTOs if GPU quotas need persistence beyond `GpuGrantMode` plus indices.
  - `packages/backend/src/access/access-resolver.service.ts` and `containers/resource-quota.policy.ts` for effective access and GPU selection semantics.
  - `packages/backend/src/groups/groups.service.ts` and user grant controllers for quota sync side effects.
- Storage/mounts:
  - `DataDiskEntity`, `DataDirectoryEntity`, `RemoteFsMountEntity`, `RemoteFsServerAssignmentEntity`, `ContainerMountEntity`, `MountSourceGrantEntity` if ownership, cross-container sharing, or source assignment is not representable.
- Container lifecycle:
  - No durable container entity exists; live container state is stateCache plus Docker labels. If tests require historical or offline container management, a separate design is needed.

## Verification Batches

Each batch is independently executable after its prerequisites are satisfied. Every checklist row must record status, timestamp, commands or UI/API actions, artifacts, observed output, and next action.

### Batch 0: Static Preflight and Hygiene

Purpose: establish local code and environment baseline without changing product behavior.

Evidence:

- `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print | sort` returns empty.
- `test/.env` values captured, especially `PORT`, `DB_PATH`, `VICTORIA_METRICS_URL`, `ADMIN_INIT_PASSWORD`.
- Reachability evidence for `10.8.96.91` and `10.8.1.12` before install actions.
- Host disk/filesystem evidence for CPU `/data`, GPU `/data0/nbTest`, and any XFS test mount.

Pass/fail:

- PASS if required hosts and local files are inspectable and common source artifact guard is clean.
- FAIL-ENV if SSH/network/sudo prerequisites block deployment.
- FAIL-PRODUCT only if repository state violates the common source artifact invariant.

### Batch 1: Local Services

Purpose: deploy local VictoriaMetrics, backend, and frontend per `TEST_DEPLOY.md`.

Evidence:

- VictoriaMetrics container is running and `curl http://127.0.0.1:8428/api/v1/query?query=up` returns valid VM JSON.
- Backend process/log artifact shows startup with `test/.env`.
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/auth/me` returns `401`.
- Frontend process/log artifact shows Vite URL.
- `curl -s http://localhost:5173/` returns HTML containing the frontend entry point.

Pass/fail:

- PASS if all four services respond as expected.
- Route backend boot, DB sync, config, or auth issues to developer after architect confirms scope.
- Route docker/port/process issues to devops.

### Batch 2: Admin Bootstrap and Server Registration

Purpose: create credentials and server records for CPU and GPU agents.

Evidence:

- Admin login returns `accessToken`, `refreshToken`, and user DTO with admin capabilities.
- CPU server creation response includes server ID and one-time `agentToken`; record only token presence and masked prefix/suffix in docs.
- GPU server creation response includes server ID and one-time `agentToken`; `isGpuServer=true`, `parentIface=bond0`, `ipCidr=10.8.110.0/24`, `gateway=10.8.0.1`, `reservedIps` includes `10.8.1.12`.
- `GET /api/servers/:id` returns expected defaults and status before agent connection.

Pass/fail:

- PASS if both server records are created and tokens are available for agent config.
- User/auth/server API defects route to developer.
- Ambiguity in production-safe CIDR is out of scope; use runbook test CIDRs.

### Batch 3: CPU Agent Deployment and Baseline Reporting

Purpose: install/connect the CPU-only agent and prove basic reporting.

Evidence:

- Build artifact path and checksum/size for `dist/nyabase-agent`.
- Remote service files and `/etc/nyabase/agent.yaml` contain the documented CPU config with masked token.
- `systemctl status nyabase-agent` and `nyabase-docker.service` are active.
- Journal contains `[WS] Connected` and dockerd reconciliation messages.
- `GET /api/servers/:cpuId` returns `status=online`, `dockerRoot=/data/nyabase-docker`, nonzero CPU/memory fields through stateCache.
- `GET /api/servers/:cpuId/disks` works after local disk registration or returns expected empty list before registration.
- Raw VM query for host CPU/memory metrics with the CPU server label returns samples.
- Frontend servers/dashboard page displays CPU server online and host metrics.

Pass/fail:

- PASS if service is active, backend online status is correct, and baseline metrics are queryable.
- Agent binary/service/dockerd failures route to devops unless code logs show agent product error.
- WebSocket protocol/stateCache/metrics writer failures route to developer.

### Batch 4: GPU Agent Deployment and GPU Baseline Reporting

Purpose: install/connect GPU agent and prove GPU inventory plus basic GPU metrics.

Evidence:

- Remote `nvidia-smi -L` or equivalent shows GPUs; expected 4 NVIDIA L40 where host matches runbook.
- `sudo systemctl status nyabase-agent` and `nyabase-docker.service` are active.
- `sudo DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker info` lists `nvidia` runtime.
- Agent journal contains `[WS] Connected` and no `nvidia-smi probe failed` message.
- `GET /api/servers/:gpuId/gpus` returns `index`, `uuid`, `model`, `totalMemMiB`.
- Raw VM queries return samples for utilization, memory, temperature, and power where supported:
  - `nyabase_gpu_util_ratio`
  - `nyabase_gpu_mem_used_bytes`
  - `nyabase_gpu_temp_celsius`
  - `nyabase_gpu_power_watts`
- `GET /api/metrics/servers/:gpuId/gpus?range=...` returns series for each GPU.
- Frontend server/dashboard GPU section renders GPU cards/series.

Pass/fail:

- PASS if inventory and at least supported `nvidia-smi` metrics flow from agent to VM to API/UI.
- Unsupported `nvidia-smi` fields are WARN with host command evidence, not product FAIL.
- Missing runtime config routes to devops; missing parsing/DTO/display routes to developer.

### Batch 5: Backend Management APIs and Permissions

Purpose: verify the requested Backend capabilities independent of container runtime risk.

Evidence:

- User management: create/list/get/update/disable/enable/delete or supported lifecycle, including SSH key lifecycle.
- Permissions:
  - Capability checks reject unauthorized user management, image management, server management, grants, audit, and metrics-all access.
  - Server grants enforce CPU, memory, disk quota, GPU mode (`none`, `indices`, `all`), and image visibility.
  - Mount source grants affect local and remote storage access.
- Image management: create/list/update/deactivate/delete, plus pull where feasible.
- Server management: create/list/get/update/defaults/delete/regenerate token; online server detail includes disks, GPUs, docker daemon status.
- Resource metrics storage and display:
  - Raw VM instant/range APIs work.
  - Host/GPU/user/container metrics DTO APIs work.
  - Frontend dashboard renders server, user, and container views.
- Storage management: local data disks, remote FS definitions, server assignments, mount source grants.
- Container management API surface: create/list/detail/start/stop/restart/delete/force-delete/stats/exec endpoints return correct status and authorization behavior.

Pass/fail:

- PASS if each requested Backend capability has positive and negative authorization evidence.
- Permission or quota semantics route to architect first if behavior is unclear, then developer.
- UI-only metrics display defects route to developer with frontend visual testing required.

### Batch 6: CPU Container Lifecycle and Shell

Purpose: verify agent container creation/deletion/force deletion and shell on CPU host.

Evidence:

- Test image exists locally or image pull progress completes.
- Authorized user grant and image grant exist.
- `POST /api/containers` succeeds on CPU server.
- Container appears in `GET /api/containers` and remote `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker ps -a` with nyabase labels.
- Start/stop/restart commands return success and state changes appear in API/state report.
- Force delete removes running or wedged container; API list and Docker list no longer contain it.
- Shell:
  - `POST /api/containers/:serverId/:dockerId/exec` returns session ID.
  - Console WebSocket or equivalent test receives command output for `whoami`, `pwd`, `echo`, and EOF/close behaves correctly.
- Metrics:
  - Container CPU/memory/network metrics appear in VM and `/metrics/servers/:id/containers`.

Pass/fail:

- PASS if lifecycle, forced removal, shell streaming, and metrics pass on CPU host.
- Docker API, labels, IP allocation, cgroup metrics, and exec defects route to developer.
- Host macvlan/dockerd health defects route to devops.

### Batch 7: Local Storage, XFS Quota, and Same-User Cross-Container Mounts

Purpose: verify local mounts and XFS quota semantics.

Evidence:

- Registered local disk uses XFS and `pquotaEnabled=true`.
- Server/user grants include disk quota.
- Creating a data directory results in:
  - DB/API row.
  - Host directory under the registered source.
  - `dataDirReport` includes it.
  - XFS project usage includes the user's numeric ID and hard limit.
- Container A and Container B for the same user mount the same data dir at expected paths.
- Write in Container A is visible from Container B.
- Quota enforcement:
  - A write below hard limit succeeds.
  - A write above hard limit fails or is truncated with host/container evidence.
  - API quota endpoint and metrics reflect used bytes after reporting delay.
- Deleting a data dir and removing mounts produce expected cleanup or documented refusal while in use.

Pass/fail:

- PASS if same-user cross-container visibility and XFS hard limit are proven.
- XFS/project ID/path assignment defects route to developer.
- Missing XFS support, mount options, or host filesystem constraints route to devops.

### Batch 8: Remote Mounts via Local NFS

Purpose: verify remote mount lifecycle and container usage with a locally controlled NFS server.

Evidence:

- NFS server/export setup record: export path, allowed client, version.
- Remote FS mount creation uses `params.type=nfs`, `nfsServer`, `exportPath`, and version.
- Server assignment dispatches `applyRemoteFsMount`.
- Agent reports `remoteFsMountStatus.status=mounted` with capacity if available.
- `/api/remote-fs-mounts` includes per-server status.
- User or group mount source grant allows a non-admin user to list and use the remote source.
- Container mount of remote data dir succeeds; read/write through container is visible on exported path.
- Remount and removal work when no containers reference the mount.
- Refusal behavior is correct while a container mount still references the remote source.

Pass/fail:

- PASS if NFS definition, assignment, grant, mount, container use, and cleanup pass.
- NFS package/service/export/firewall issues route to devops.
- Backend dispatch/status/grant or agent mount helper issues route to developer.

### Batch 9: GPU Container Lifecycle and Per-Container GPU Attribution

Purpose: verify GPU quota, container GPU access, and per-container memory attribution.

Evidence:

- GPU server grant tests:
  - `gpuMode=none` rejects GPU request.
  - `gpuMode=indices` permits only listed indices and rejects unlisted indices.
  - `gpuMode=all` or allowed `gpuCount` auto-selects available GPUs.
- GPU container creation includes GPU indices in API/state report and Docker labels.
- Remote `docker inspect` shows `Runtime=nvidia` or equivalent runtime behavior and `NVIDIA_VISIBLE_DEVICES`.
- In-container GPU workload or `nvidia-smi` creates measurable GPU process memory on a known GPU.
- Raw VM query `nyabase_gpu_proc_mem_used_bytes{server="<gpuId>"}` returns samples with:
  - non-empty `container_id`.
  - `user_id` matching product UUID owner.
  - `gpu_uuid`.
  - value greater than zero while workload runs.
- `/api/metrics/servers/:gpuId/containers?range=...` shows `gpuMemUsed` for the target container.
- `/api/metrics/servers/:gpuId/users?range=...` shows GPU memory attributed to the owning user.
- Frontend container and user metrics tabs display GPU memory series.
- Cleanup force-deletes the GPU container and metrics eventually stop growing.

Pass/fail:

- PASS if GPU access and memory attribution are observable at Docker, VM, API, and UI levels.
- PID-to-container mapping, UUID/index joins, labels, or DTO aggregation defects route to developer.
- Workload availability or driver/runtime defects route to devops unless product config caused them.

### Batch 10: Frontend Workflow Verification

Purpose: verify user-facing display for the requested Backend and Agent capabilities.

Evidence:

- Screenshots or Playwright artifacts for:
  - Login and app shell.
  - Servers list/detail with CPU/GPU online state, GPUs, disks, daemon status.
  - Images management.
  - Users/groups/grants management including GPU quota fields.
  - Containers list/detail, lifecycle controls, web console.
  - Data dirs/local storage.
  - Remote FS management.
  - Dashboard host/GPU/user/container metrics.
- API-backed UI actions match backend evidence from prior batches.

Pass/fail:

- PASS if rendered UI exposes and correctly updates each requested capability.
- Any frontend source change requires tester to run visual checks and PM to handle visual acceptance before DONE.

### Batch 11: Regression Checks and Final Review

Purpose: prove fixes did not regress the workspace.

Evidence:

- `bash scripts/check.sh` passes after any code change.
- `bash scripts/check-visual.sh` passes if rendered frontend output changed.
- Common source artifact guard remains empty.
- Session checklist has every item marked PASS, FAIL with routed issue, BLOCKED-ENV, or SKIP with reason.
- Review report returns `Verdict: PASS` before PM DONE.

Pass/fail:

- PASS if regression checks and review pass.
- Check failures route to developer/tester/devops based on failing area.

## Failure Routing

- Route to architect when:
  - Requirements conflict with existing product semantics.
  - A failing test needs new or changed API/DTO/schema/permission semantics.
  - GPU quota or storage sharing behavior is not representable in current data models.
- Route to developer when:
  - Backend REST, auth, permission, quota, stateCache, metrics aggregation, or WebSocket logic is wrong.
  - Agent Docker, GPU parser, PID attribution, XFS quota, mount helper, shell, or RPC handling is wrong.
  - Frontend API usage, state rendering, forms, or metrics display is wrong.
- Route to tester when:
  - A verification script/checklist/test needs to be created or corrected.
  - A fix requires focused regression, API, or Playwright coverage.
  - Evidence is insufficient or non-reproducible.
- Route to devops when:
  - Local service process management, Docker/VictoriaMetrics, SSH, sudo, systemd, NFS server, network, driver/runtime, or host filesystem setup fails.
  - Build/start/install commands or environment setup need operational adjustment.
- Route to reviewer when:
  - A development/testing loop claims completion.
  - The risk surface crosses roles or needs independent inspection.
  - Final session DoD must be validated.

## Likely Product Change Areas if Bugs Are Found

- GPU metrics:
  - `packages/agent/src/gpu/gpu-monitor.ts`
  - `packages/agent/src/app.ts`
  - `packages/backend/src/metrics/metrics-writer.ts`
  - `packages/backend/src/metrics/metrics.controller.ts`
  - `packages/frontend/src/components/dashboard/metrics-charts.tsx`
  - `packages/frontend/src/pages/dashboard-page.tsx`
- Per-container GPU memory attribution:
  - `packages/agent/src/gpu/gpu-monitor.ts` for `/proc/<pid>/cgroup` parsing and container ID normalization.
  - `packages/agent/src/app.ts` for owner mapping from Docker labels.
  - `packages/backend/src/metrics/metrics.controller.ts` for container/user series grouping and permissions.
- Storage and mounts:
  - `packages/agent/src/datadirs/data-dirs.ts`
  - `packages/agent/src/quota/xfs-quota.ts`
  - `packages/agent/src/fs/nfs-driver.ts`
  - `packages/agent/src/fs/remote-fs-mounter.ts`
  - `packages/agent/src/commands/dispatcher.ts`
  - `packages/backend/src/datadirs/**`
  - `packages/backend/src/remote-fs/**`
  - `packages/backend/src/mount-sources/**`
  - `packages/backend/src/containers/container-mounts.service.ts`
- Permissions and quotas:
  - `packages/common/src/enums.ts`
  - `packages/common/src/protocol/rest-schema.ts`
  - `packages/backend/src/access/access-resolver.service.ts`
  - `packages/backend/src/access/grant-utils.ts`
  - `packages/backend/src/containers/resource-quota.policy.ts`
  - `packages/backend/src/groups/**`
  - `packages/backend/src/users/**`
- Container lifecycle and shell:
  - `packages/backend/src/containers/**`
  - `packages/backend/src/gateway/agent-session.ts`
  - `packages/backend/src/gateway/exec-session-registry.ts`
  - `packages/backend/src/gateway/console-gateway.ts`
  - `packages/agent/src/docker/docker-client.ts`
  - `packages/agent/src/commands/dispatcher.ts`
- Metrics display:
  - `packages/common/src/protocol/rest.ts`
  - `packages/backend/src/metrics/**`
  - `packages/frontend/src/components/dashboard/**`
  - `packages/frontend/src/pages/dashboard-page.tsx`
- Deployment tooling:
  - `scripts/build-agent-binary.sh`
  - `scripts/check.sh`
  - `scripts/check-visual.sh`
  - `scripts/test-functional.sh` only if PM dispatches tester/devops to update test tooling.

## Acceptance Criteria

1. VictoriaMetrics is running and answers valid JSON queries on `127.0.0.1:8428`.
2. Backend starts from `test/.env`; unauthenticated `GET /api/auth/me` returns `401`.
3. Frontend starts and serves the Vite app HTML.
4. CPU agent is installed on `10.8.96.91`, connects to backend, has active nyabase-managed dockerd, and reports baseline host metrics.
5. GPU agent is installed on `10.8.1.12`, connects to backend, has active nyabase-managed dockerd with NVIDIA runtime, and reports GPU inventory.
6. GPU utilization, memory, temperature, power/frequency-equivalent fields supported by `nvidia-smi` are queryable in VictoriaMetrics and through product metrics APIs.
7. Agent container create/delete/force-delete works on the CPU server.
8. Agent container create/delete/force-delete works on the GPU server when GPU host prerequisites are healthy.
9. Shell attachment works for a created container, including session creation, output streaming, input, resize/close where testable, and cleanup.
10. Local storage registration requires XFS, reports `pquotaEnabled`, and supports data directory lifecycle.
11. XFS quota enforcement is proven with below-limit and above-limit writes.
12. Same-user cross-container local mount access is proven by writing in one container and reading in another.
13. Remote NFS mount lifecycle works from definition through server assignment, agent mount status, grants, container mount, read/write, remount, and cleanup.
14. GPU grant enforcement covers `none`, `indices`, `all`, explicit indices, and auto-selection via GPU count where supported.
15. Per-container GPU memory accounting reports `nyabase_gpu_proc_mem_used_bytes` with non-empty container ID, owning product user ID, GPU UUID, and nonzero value during workload.
16. Backend user management lifecycle works, including permission denial for unauthorized users.
17. Backend permissions work for containers, CPU/memory/disk quotas, GPU quotas, images, servers, metrics, and mount sources.
18. Backend image management lifecycle works, including active/inactive visibility and image grants.
19. Backend server management lifecycle works, including token regeneration, defaults, disks, GPU detail, daemon status, and deletion semantics.
20. Backend resource metrics are stored in VictoriaMetrics and displayed/retrievable through host, GPU, user, container, raw instant, and raw range APIs.
21. Backend storage management works for local disks, data directories, remote FS definitions, server assignments, and mount source grants.
22. Backend container management works for list, detail, create, start, stop, restart, delete/force-delete, stats, mounts, and shell.
23. A complete checklist exists with every item carrying status, timestamp, evidence, and next action.
24. Every product failure found in a completed batch is fixed and retested, or recorded as BLOCKED-ENV with repeated blocker evidence.
25. `bash scripts/check.sh` passes after code changes; visual checks pass when frontend rendering changes.
26. No generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` artifacts remain under `packages/common/src/**`.

## Out of Scope

- Production hardening, HA, TLS, public DNS, certificate automation, and multi-backend scaling.
- Permanent changes to host services beyond documented test deployment paths.
- Redesigning persistent container history/offline container state unless a verified failure requires it.
- CephFS verification unless it is needed to isolate remote FS code after NFS fails.
- Benchmarking or stress testing beyond functional verification.
- Replacing VictoriaMetrics or changing the metrics storage backend.
- User-facing product documentation outside the harness session record.

## Environment Risks

- Remote SSH or sudo access may fail or host addresses may not be reachable from the current machine.
- GPU host may not match the documented driver/runtime state; `nvidia-smi`, `nvidia-container-runtime`, or Docker versions may differ.
- macvlan CIDRs can collide with existing networks or fail because of switch/host network policy.
- XFS project quotas depend on filesystem mount options and `xfsprogs`; non-XFS disks should be treated as environment blockers unless product validation is wrong.
- NFS export behavior varies with root squash, UID mapping, firewall, and mount version.
- VictoriaMetrics may contain old samples if the persistent volume is reused; evidence should query by server label and recent time range.
- Long-running image pulls and GPU workloads can be affected by external registry/network availability.
- The repository is not a Git worktree for this session, so change evidence must use file snapshots, command output, and harness records rather than Git diff.

## Focused Design: GPU Clock Metrics and Container Detail GPU Memory

### Goal

Expose GPU clock/frequency metrics alongside existing GPU utilization, memory, temperature, and power metrics, and populate per-container GPU memory in `GET /api/containers/:serverId/:dockerId/stats`.

### Interfaces

Current metric contract stays additive. Existing metric names and labels remain unchanged:

- `nyabase_gpu_util_ratio{server,gpu_index}`
- `nyabase_gpu_mem_used_bytes{server,gpu_index}`
- `nyabase_gpu_temp_celsius{server,gpu_index}`
- `nyabase_gpu_power_watts{server,gpu_index}`
- `nyabase_gpu_proc_mem_used_bytes{server,gpu_uuid,container_id,user_id}`

Add one new host GPU metric:

- `nyabase_gpu_clock_graphics_mhz{server,gpu_index}`
  - `server`: product server UUID, same label as existing VM metrics.
  - `gpu_index`: stringified NVIDIA GPU index, same identity key as existing GPU host metrics.
  - Value unit: MHz.
  - Source: `nvidia-smi --query-gpu=clocks.gr`.
  - Unsupported/missing values: if `nvidia-smi` returns `N/A`, empty, `Unknown Error`, a non-finite number, or a negative value, the agent must not emit this metric point for that GPU sample. The backend API must then return the normal empty/null `MetricSeries` for the affected GPU instead of synthesizing `0`.

`GpuStats` in `packages/agent/src/gpu/gpu-monitor.ts` changes from:

```ts
{
  index: number;
  uuid: string;
  utilizationPercent: number;
  memUsedMiB: number;
  memTotalMiB: number;
  temperatureCelsius: number;
  powerWatts: number;
}
```

to:

```ts
{
  index: number;
  uuid: string;
  utilizationPercent: number;
  memUsedMiB: number;
  memTotalMiB: number;
  temperatureCelsius: number;
  powerWatts: number;
  graphicsClockMHz?: number;
}
```

`GpuMetrics` in `packages/common/src/protocol/rest.ts` changes additively:

```ts
export interface GpuMetrics {
  index: number;
  model: string;
  memTotalMiB: number;
  util: MetricSeries;
  memUsed: MetricSeries;
  temp: MetricSeries;
  power: MetricSeries;
  graphicsClockMHz: MetricSeries;
}
```

For container detail stats, keep the existing `ContainerStatsSummary.gpuMemUsedMiB: Record<string, number>` field and populate it without changing the DTO name or units:

- Key choice: GPU UUID, matching the existing `nyabase_gpu_proc_mem_used_bytes` `gpu_uuid` label and avoiding ambiguity if GPU indices reorder.
- Value unit: MiB, matching the existing field name.
- Population source: live `nvidia-smi --query-compute-apps=pid,used_memory,gpu_uuid` mapped through `/proc/<pid>/cgroup` to the Docker container ID.
- Matching: accept both full 64-character Docker IDs and 12-character short IDs when comparing requested `dockerId` to process `containerId`.
- Aggregation: sum all processes for the requested container per GPU UUID.
- Fallback behavior: return `{}` when the agent is not GPU-enabled, `nvidia-smi` is unavailable, the container has no GPU processes, `used_memory` is unsupported/non-numeric, or PID-to-container mapping cannot resolve a process. Do not fail the stats RPC solely because GPU process attribution is unavailable.

### Data Model Changes

No database schema or VictoriaMetrics migration is required.

- VictoriaMetrics accepts the new `nyabase_gpu_clock_graphics_mhz` series automatically through the existing metrics writer.
- `ContainerStatsSummary.gpuMemUsedMiB` already exists in the WebSocket protocol and REST response shape; only its producer behavior changes.
- The shared Zod protocol shape remains compatible because `gpuMemUsedMiB` is still `z.record(z.number())`.
- `GpuMetricsDto` is expanded additively; current clients that ignore unknown JSON fields continue to work.

### File-Level Change List

- `packages/agent/src/gpu/gpu-monitor.ts`
  - Extend `GpuStats` with optional `graphicsClockMHz`.
  - Query `clocks.gr` in `getGpuStats`.
  - Parse numeric fields through a helper that treats unsupported `nvidia-smi` values as `undefined` or skips unsafe host metrics where appropriate.
  - Emit `nyabase_gpu_clock_graphics_mhz{server,gpu_index}` only when `graphicsClockMHz` is finite.
  - Add a helper such as `getContainerGpuMemUsedMiB(dockerId: string): Promise<Record<string, number>>` that reuses `getGpuProcesses()` and returns per-GPU UUID MiB sums for the requested container.
- `packages/agent/src/docker/docker-client.ts`
  - Change `fetchContainerStats` to accept an optional GPU memory provider callback or method dependency.
  - Keep `parseDockerStats` focused on Docker stats and continue to default `gpuMemUsedMiB` to `{}`.
  - Merge provider output into the returned `ContainerStatsSummary.gpuMemUsedMiB`.
- `packages/agent/src/app.ts`
  - Wire `GpuMonitor` into Docker stats collection for state reports, metric-loop stats fetches, and command-dispatched stats.
  - Ensure CPU-only agents and failed GPU probes continue returning `{}` with no stats failure.
- `packages/agent/src/commands/dispatcher.ts`
  - Inject or receive the GPU memory provider used by `fetchContainerStats` so `fetchContainerStats` RPC responses include GPU memory.
- `packages/common/src/protocol/rest.ts`
  - Add `graphicsClockMHz: MetricSeries` to `GpuMetrics`.
  - Do not rename or remove any existing `GpuMetrics` or `ContainerStatsSummary` fields.
- `packages/backend/src/metrics/metrics.controller.ts`
  - Query `nyabase_gpu_clock_graphics_mhz{server="<id>"}` by `gpu_index`.
  - Include `graphicsClockMHz` in each `GpuMetrics` item, using `emptySeries(step)` when absent.
  - Preserve the current union of GPU indices from stateCache plus existing metrics, and include clock-only indices in that union if they appear.
- `packages/frontend/src/components/dashboard/metrics-charts.tsx`
  - Render a GPU clock chart for `gpu.graphicsClockMHz`, labeled in MHz, alongside existing utilization, memory, temperature, and power charts.
  - Keep rendering tolerant of empty/null series.
- `packages/frontend/src/pages/container-detail-page.tsx`
  - Display `stats.stats.gpuMemUsedMiB` in the live resource card when non-empty, using GPU UUID keys and MiB values.
  - Preserve current behavior when the map is `{}`.

### Acceptance Criteria

1. `GpuMonitor.getGpuStats()` queries `clocks.gr` and parses supported numeric values into `graphicsClockMHz`.
2. The agent emits `nyabase_gpu_clock_graphics_mhz{server,gpu_index}` in MHz only for finite supported clock values.
3. Existing GPU metric names and labels are unchanged, and existing VM clients still receive util/memory/temp/power series.
4. `GET /api/metrics/servers/:id/gpus` returns `graphicsClockMHz: MetricSeries` for each GPU item and returns an empty/null series when clock samples are absent.
5. `ContainerStatsSummary.gpuMemUsedMiB` in `/api/containers/:serverId/:dockerId/stats` is keyed by GPU UUID and sums MiB across all matching processes for the requested container.
6. Container stats GPU memory returns `{}` instead of failing when GPU support, `nvidia-smi`, process memory, or PID attribution is unavailable.
7. CPU-only agents and non-GPU containers keep their current stats behavior with `gpuMemUsedMiB: {}`.
8. Frontend GPU charts show the new graphics clock series without removing existing charts, and container detail displays GPU memory only when the map is non-empty.

### Focused Test Plan

- Agent GPU parser tests:
  - Mock `nvidia-smi --query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr`.
  - Assert numeric `clocks.gr` produces `graphicsClockMHz` and a `nyabase_gpu_clock_graphics_mhz` point.
  - Assert `N/A`, empty, and non-numeric clock values do not emit a clock point while other supported metrics still emit.
- Agent container GPU memory tests:
  - Mock compute-app rows with multiple PIDs on the same GPU UUID and different GPU UUIDs; assert per-UUID MiB sums.
  - Mock full and short Docker ID matches through cgroup contents; assert both resolve.
  - Mock no match, bad memory value, missing `/proc/<pid>/cgroup`, and disabled GPU monitor; assert `{}` and no thrown stats RPC error.
- Backend metrics API tests:
  - Mock range query service results for `nyabase_gpu_clock_graphics_mhz` and existing GPU metrics; assert `GpuMetricsDto.gpus[].graphicsClockMHz` is present.
  - Assert GPU index union includes indices from stateCache and from clock-only metric results, without dropping existing util-only indices.
  - Assert absent clock data returns `emptySeries(step)`.
- Container stats API tests:
  - Mock agent `fetchContainerStats` response with `gpuMemUsedMiB: { "GPU-abc": 512 }`; assert `/api/containers/:serverId/:dockerId/stats` returns the same map.
  - Mock `{}` on CPU/non-GPU cases; assert response remains valid and existing CPU/memory/network/block fields are unchanged.
- Frontend tests:
  - Component/API fixture for GPU metrics includes `graphicsClockMHz`; assert the clock chart label/value renders.
  - Container detail fixture includes non-empty `gpuMemUsedMiB`; assert GPU memory is displayed.
  - Fixture with `{}` asserts no placeholder regression or layout break.

### Risks and Trade-Offs

- `clocks.gr` is NVIDIA-specific; this matches the existing `nvidia-smi` implementation. A vendor-neutral metric model is out of scope.
- GPU index is retained for host GPU metrics to preserve current VM label shape, while container memory uses GPU UUID because process metrics already expose UUID and UUID is stable across index reorder. Alternative considered: add `gpu_uuid` to all host GPU metrics; rejected for this fix because it would change cardinality and client grouping beyond the reported gap.
- Docker stats do not contain GPU process memory, so the agent must combine Docker stats with `nvidia-smi` process data at request time. Alternative considered: backend reads VictoriaMetrics `nyabase_gpu_proc_mem_used_bytes`; rejected for container detail stats because `/stats` is a live agent RPC and should not depend on recent VM ingestion lag.
- Some GPU workloads or driver modes may hide process memory or report `N/A`; returning `{}` preserves current API behavior and avoids false zero values.

### Out of Scope

- Renaming `GpuMetrics.power` or existing chart labels.
- Adding persistent storage, migrations, or historical downsampling for clock metrics.
- Adding GPU SM/memory clocks beyond `clocks.gr`.
- Changing `nyabase_gpu_proc_mem_used_bytes` label names.
- Redesigning GPU quota selection or container creation semantics.

## Focused Design: XFS Project Quota Enforcement for Local Data and Container Writable Layers

### Goal

Make user disk grants hard-enforced by XFS project quotas for every local data-dir path and every container writable-layer path while preserving same-user cross-container sharing of the same local data directory.

### Root Cause

The likely product root cause is that the agent treats quota setup as best-effort but reports it as enabled:

- `XfsQuotaManager.initProject()` and `addPathToProject()` catch command failures and only log warnings, so container/data-dir creation can continue even when the kernel never tags the target inode tree with the user's project ID.
- `DataDirsManager.getDiskInfo()` reports `pquotaEnabled: src.quotaEnabled`, and `applyDataDisk` sets `quotaEnabled: true` for any local XFS path. This proves only that the path was registered as a local source, not that XFS project quota accounting and enforcement are enabled on that filesystem.
- `updateUserQuota` can successfully set or attempt a limit for a project while the actual write paths remain outside that project; in that case a 40 MiB write can pass under a 20 MiB grant because the inode tree being written is unassigned or enforcement is off.

### Interfaces

No public REST or WebSocket shape change is required for the minimal fix.

Keep current command names and payloads:

- `updateUserQuota { numericUserId, diskBytes }`
- `createDataDir { diskId, name, uid, numericUserId }`
- `createContainer { ..., numericOwnerId, createDirs }`

Behavior changes:

- Agent RPCs that require quota enforcement must fail closed when project quota support, project initialization, path assignment, or limit application cannot be verified.
- `DiskInfo.pquotaEnabled` must mean "project quota accounting and enforcement are active on this local source filesystem", not merely "the source is local and XFS".
- `checkDisk`/`applyDataDisk` must reject or report non-enforcing XFS mounts clearly enough that backend disk registration does not mark them usable for quota-backed local storage.

Optional additive diagnostic fields may be introduced only if developer finds them necessary for UI/debuggability, for example `quotaStatus` or `quotaError` on disk/self-check DTOs. They are not required to fix enforcement and should not block the minimal product fix.

### Data Model Changes

No database schema change is required.

Project ID mapping remains deterministic: `projectId = numericUserId + XFS_PROJECT_OFFSET`. This preserves existing user usage aggregation and avoids migrations.

The same data-dir DB row and filesystem path remain shared for the same user. The path is assigned to that user's project ID, so two same-owner containers mounting the same host directory continue seeing the same files and are jointly constrained by the same user's disk grant.

### File-Level Change List

- `packages/agent/src/quota/xfs-quota.ts`
  - Replace warning-only behavior in `initProject()` and `addPathToProject()` with throwing failures that include the failed command context.
  - Add an explicit capability check such as `checkProjectQuotaEnforcement(pathOrMount): { accounting: boolean; enforcement: boolean }` using `xfs_quota` state/report output, and use it before registering a local disk as quota-capable.
  - Make `setLimit()` verify that the applied hard limit is visible in `report -N -p -b` for the expected project ID; fail the RPC if the reported limit does not match.
  - Add a path verification helper that confirms a newly assigned path is accounted under the expected project, for example by running `project -s -p <path> <projectId>` and then checking `report -N -p -b`/project state. The helper must not silently pass on missing `xfs_quota`, disabled pquota, bad `/etc/projects`, or command errors.
  - Keep `removePathFromProject()` best-effort because it is cleanup/compensation only.
- `packages/agent/src/datadirs/data-dirs.ts`
  - Store quota capability from the XFS enforcement check, not from `kind === "local"`.
  - Report `pquotaEnabled=false` when accounting or enforcement cannot be proven.
  - Do not change the single-layer shared data-dir layout `{source.root}/{dirName}`.
- `packages/agent/src/commands/dispatcher.ts`
  - In `applyDataDisk`, require XFS plus verified project quota accounting and enforcement before adding a quota-enabled local source. If enforcement is unavailable, fail the RPC so backend disk registration returns a 4xx instead of a false-positive disk.
  - In `createDataDir`, after creating/chowning a local quota-enabled directory, assign that exact host path to `numericUserId` and fail the command if assignment fails.
  - In `createContainer`, assign any local `createDirs` paths created or reused through `createDirs` to `numericOwnerId`; this closes the gap where container creation can create a data directory without routing through `createDataDir`.
  - In `createContainer`, keep assigning Docker graph driver `upperDir` and `workDir` to `numericOwnerId`, but fail container creation and run existing compensation if assignment fails. Do not treat missing graph driver dirs as success unless the Docker driver genuinely exposes no writable layer path; that case should return a clear agent error because quota cannot be enforced for container writes.
  - In `updateUserQuota`, use the stricter `setLimit()` verification so backend grant sync cannot appear successful when the kernel did not apply the limit.
- `packages/backend/src/groups/groups.service.ts`
  - Preserve all existing `syncUserQuota()` trigger points for group/user grant changes and reconnect. No interface change is needed, but failures from future RPC-based quota sync should be logged clearly if developer converts fire-and-forget `notify()` to an awaited RPC.
- `packages/backend/src/servers/servers.service.ts`
  - Preserve default-grant disk sync behavior. If developer changes quota sync from `notify()` to `rpc()` for reliability, failed quota application should be visible in logs and should not mark the disk/grant state as successfully enforced.
- `packages/common/src/protocol/agent-messages.ts`
  - No required change. Only add diagnostic fields if implementation needs them for disk/self-check reporting.

### Required Semantics

- A local data disk is quota-capable only when the agent proves XFS project quota accounting and enforcement are active for that filesystem.
- A user disk grant constrains the aggregate usage of all paths assigned to that user's project on the server: local data dirs, same-user shared mounts, and container writable layers.
- Same-user cross-container sharing is preserved by keeping one host data-dir path per `{sourceId, dirName}` and assigning that shared path to the owning user's project. Containers mount the same host path; quota is per user project, not per container.
- Fail closed: if quota enforcement is required but cannot be verified, container/data-dir/disk registration fails rather than allowing unbounded writes.
- Remote FS mounts remain out of XFS project quota enforcement unless separately designed; they should continue using `quotaEnabled=false`.

### Acceptance Criteria

1. Registering a local disk reports `pquotaEnabled=true` only when XFS project quota accounting and enforcement are active; a plain XFS mount without enforcing pquota is rejected or reported false.
2. `XfsQuotaManager.initProject()`, `addPathToProject()`, and limit application no longer swallow failures that would leave writes unbounded.
3. `updateUserQuota` applies and verifies the expected hard limit for the deterministic project ID derived from `numericUserId`.
4. `createDataDir` assigns the created local host path to the user's project before returning success.
5. `createContainer` assigns local `createDirs` host paths plus Docker writable-layer paths (`upperDir` and `workDir` where applicable) to the container owner's project before returning success.
6. If any required path/project assignment fails, container creation fails and existing compensation removes the container and stale project entries where possible.
7. Two same-owner containers mounting the same local data dir still see each other's writes because the shared host path and mount reconciliation model are unchanged.
8. A live XFS deployment with a 20 MiB disk grant allows a below-limit write and rejects or truncates a 40 MiB write in both the mounted local data dir and the container writable layer.

### Focused Test Plan

- Agent unit tests for `XfsQuotaManager`:
  - Mock `xfs_quota` failures for project init, path assignment, and limit setting; assert methods reject instead of warning-only success.
  - Mock project quota state with accounting/enforcement off; assert local disk registration cannot report `pquotaEnabled=true`.
  - Mock successful `limit -p` followed by `report -N -p -b`; assert the expected hard limit is verified for the computed project ID.
- Agent dispatcher tests:
  - `createDataDir` on a quota-enabled local source calls path assignment with `numericUserId` and fails the command if assignment rejects.
  - `createContainer` with local `createDirs` assigns those host paths to `numericOwnerId`.
  - `createContainer` fails and compensates if writable-layer assignment fails.
  - Existing same-user mount behavior is not changed by quota assignment.
- Backend tests:
  - Disk registration returns a failure when the agent reports XFS but cannot verify project quota enforcement.
  - Grant/default updates still send `updateUserQuota` with the resolved effective `diskBytes` and numeric user ID.
- Live deployment verification:
  - On CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` with `/data`, verify pquota state before disk registration.
  - Create a user with a 20 MiB disk grant, create a local data dir, and create two same-owner containers mounting it.
  - Prove Container A writes are visible in Container B.
  - Write below the grant successfully, then attempt a 40 MiB write from the shared data dir and from an unmounted container writable path; both must fail or truncate with command evidence.
  - Confirm `/api/servers/:id/quota`, `stateReport.xfsProjects`, and `nyabase_user_disk_used_bytes` reflect used bytes after the report interval.

### Risks and Trade-Offs

- Failing closed may reject hosts that previously appeared usable because they were XFS but mounted without project quota enforcement. This is intended; otherwise disk grants are not meaningful.
- Verifying Docker writable-layer paths depends on Docker storage driver behavior. If a driver does not expose assignable `upperDir`/`workDir`, the safe behavior is to reject quota-backed container creation on that host until a driver-specific design exists.
- Converting backend quota sync from fire-and-forget `notify()` to awaited `rpc()` would improve observability but can make grant updates fail when agents are offline. Minimal implementation may keep reconnect sync and log failures; a separate operational status model can be designed later.
- Project quotas are per user per server, not per data directory or per container. This is the desired behavior for preserving same-user sharing, but it means all of a user's local data and container writes consume the same grant.

### Out of Scope

- Quota enforcement for remote NFS/CephFS mounts.
- Per-container disk quotas separate from user disk grants.
- Changing the filesystem layout for local data dirs.
- Database migrations or new persistent quota state.
- Frontend redesign for quota diagnostics beyond optional additive status fields.

## Focused Design: Backend Stale Mount Cleanup on Container Delete

### Goal

When a container is deleted through the product API, delete the backend's expected `container_mounts` rows for that exact `{serverId, dockerId}` so stale mount references do not block later local disk cleanup.

### Interfaces

No public REST, WebSocket, DTO, or agent protocol shape changes are required.

Current public behavior:

- `DELETE /api/containers/:serverId/:dockerId` checks ownership/access, requires the agent online, calls agent `deleteContainer` with `{ dockerId, force: true }`, audits `AuditAction.DeleteContainer`, and returns `{ ok: true }` from the controller.
- Expected mount rows are persisted in `container_mounts` but are not removed by container deletion.
- `DELETE /api/servers/:id/disks/:diskId` refuses deletion if any `container_mounts` row still references `{ serverId, sourceKind: "local", sourceId: diskId }`.

New public behavior:

- `DELETE /api/containers/:serverId/:dockerId` keeps the same request/response and authorization contract.
- After the agent `deleteContainer` RPC succeeds, the backend deletes all `container_mounts` rows matching that same `{serverId, dockerId}` before writing the container delete audit entry.
- If the agent `deleteContainer` RPC fails or maps to an HTTP error, the backend does not delete any expected mount rows and does not write the container delete audit entry. This preserves existing failure semantics for containers that may still exist on the agent.
- Mount cleanup is database-only. Do not call `removeContainerMount`, `reconcileContainerMounts`, or any other mount RPC after deleting the container, because the target mount namespace no longer exists.

Internal service interface addition:

```ts
// packages/backend/src/containers/container-mounts.service.ts
async deleteAllForContainer(serverId: string, dockerId: string): Promise<number>
```

Semantics:

- Delete all rows where `serverId` and `dockerId` match exactly, regardless of `sourceKind`.
- Return the number of affected rows, using `0` as a successful idempotent result.
- Do not delete rows for the same `dockerId` on another server, rows for another container on the same disk, or any `dockerId IS NULL` rows.
- Do not perform agent reconciliation or unmount RPCs.

### Data Model Changes

No schema migration or entity shape change is required.

`ContainerMountEntity.dockerId` remains nullable for compatibility with the existing table definition, but the cleanup method targets only the concrete docker ID passed to product API container deletion.

### File-Level Change List

- `packages/backend/src/containers/container-mounts.service.ts`
  - Add `deleteAllForContainer(serverId, dockerId): Promise<number>`.
  - Implement it with a single repository delete against `ContainerMountEntity` filtered by `{ serverId, dockerId }`.
  - Keep the method idempotent and DB-only; no agent RPC and no reconcile call.
- `packages/backend/src/containers/containers.service.ts`
  - In `ContainersService.deleteContainer()`, keep the existing lock, ownership check, online requirement, and `deleteContainer` agent RPC.
  - Call `await this.containerMountsService.deleteAllForContainer(serverId, dockerId)` only after `rpcWithErrorMapping(...deleteContainer...)` resolves successfully.
  - Keep `AuditAction.DeleteContainer` after successful mount cleanup so the audit reflects a fully completed product-level delete operation.
- `packages/backend/src/entities/container-mount.entity.ts`
  - No change expected.
- `packages/backend/src/servers/servers.service.ts`
  - No change expected. `ServersService.removeDisk()` should naturally stop rejecting a disk after the deleted container's mount rows are cleaned up.

### Required Semantics

- Product API container deletion is the ownership boundary for expected mount cleanup. Direct database edits, direct Docker deletion outside nyabase, or future orphan-reconciliation jobs are out of scope for this fix.
- Cleanup must be ordered after successful agent deletion, not before it. The backend must not forget expected mounts while a failed agent delete may have left the container running.
- Cleanup must run inside the existing per-container operation lock in `ContainersService.deleteContainer()` so concurrent mount updates and deletion remain serialized for the same `{serverId, dockerId}`.
- Cleanup removes both local and remote expected mount rows for the deleted container. Local disk deletion is the immediate bug, but remote mount rows are equally stale after container deletion.
- A zero-row cleanup is success. This covers containers without mounts and repeated cleanup attempts in tests without changing the public API response.

### Acceptance Criteria

1. `ContainersService.deleteContainer()` calls agent `deleteContainer` before deleting any `container_mounts` rows.
2. If agent `deleteContainer` fails, no `container_mounts` rows are deleted for that container and `AuditAction.DeleteContainer` is not written.
3. If agent `deleteContainer` succeeds, all `container_mounts` rows for the exact `{serverId, dockerId}` are deleted before the container delete audit is written.
4. Cleanup deletes both local and remote mount rows for the deleted container, while preserving rows for other containers, other servers, and `dockerId IS NULL`.
5. Deleting a container that had a local disk mount allows `ServersService.removeDisk(serverId, diskId)` to proceed afterward when no other `container_mounts` row references that disk.
6. Deleting a container with no mount rows still returns success and writes the normal container delete audit after the agent delete succeeds.
7. No REST DTO, agent command payload, database entity, or migration change is introduced.

### Focused Test Plan

- Add backend service tests for `ContainerMountsService.deleteAllForContainer()`:
  - Seed rows for `{serverA, dockerA}` with local and remote sources, plus rows for `{serverA, dockerB}`, `{serverB, dockerA}`, and `dockerId=null`.
  - Call `deleteAllForContainer(serverA, dockerA)`.
  - Assert only the exact `{serverA, dockerA}` rows are gone and the returned count matches the deleted row count.
  - Assert a second call returns `0` and does not throw.
- Add backend service tests for `ContainersService.deleteContainer()`:
  - Mock a successful agent `deleteContainer` RPC and assert call order is: ownership/online checks, agent RPC, `containerMountsService.deleteAllForContainer(serverId, dockerId)`, `AuditAction.DeleteContainer`.
  - Mock a failing agent `deleteContainer` RPC and assert `deleteAllForContainer()` and the delete audit are not called.
  - Mock a container with no mounts and assert successful deletion still audits normally.
- Add a focused disk-cleanup regression test:
  - Arrange a `DataDiskEntity` and a matching local `ContainerMountEntity` for a container.
  - Delete the container through `ContainersService.deleteContainer()` with a successful agent RPC.
  - Assert the matching mount row is gone.
  - Call `ServersService.removeDisk(serverId, diskId)` and assert it no longer throws `This disk is still used by container mounts; remove those mounts first` when no other mount references exist.
  - Add a control row for a second container on the same disk and assert disk deletion still refuses while that row remains.

Suggested test locations:

- `packages/backend/src/containers/__tests__/container-mounts.service.test.ts`
- `packages/backend/src/containers/__tests__/containers.service.test.ts`
- `packages/backend/src/servers/__tests__/servers.service.test.ts` or an equivalent focused backend service/integration test if the existing backend test harness favors one file.

### Risks and Trade-Offs

- If database cleanup fails after the agent has already deleted the container, the product operation cannot be fully rolled back. Letting that error surface is preferable to returning success while leaving stale rows that still block disk cleanup.
- Direct Docker deletions outside the product API can still leave stale expected mount rows. A separate orphan-reconciliation design would be needed for that broader cleanup.
- The fix relies on existing single-process operation locks. The broader design already notes that multi-backend deployments need a distributed lock before horizontal scaling.

### Out of Scope

- Cleaning historical orphaned `container_mounts` rows created before this fix.
- Changing disk deletion guard semantics in `ServersService.removeDisk()`.
- Adding cascade foreign keys or a persistent container table.
- Changing mount reconciliation behavior for running containers.

## Focused Design: NFS Container Mount Fix

### Goal

Make `PATCH /api/containers/:serverId/:dockerId/mounts` return success for a running container only after the requested remote NFS data directory is actually visible at the container path and can be read/written from inside the container.

### Why PATCH Can Succeed While `/mnt/nfs` Is Absent

The live evidence already proves the host-level remote FS path: the temporary NFS export mounted on the CPU host, product status was `mounted`, and host/export read-write passed. The remaining failure surface is the dynamic bind injection into the running container.

Likely product failure surfaces:

- `CommandDispatcher.applySingleMount()` runs `mount-helper mount` and returns void. It does not list or verify the container mount namespace after the helper exits.
- `CommandDispatcher.reconcileContainerMounts()` returns a final `listContainerMounts(pid)` result, but it does not fail if the expected destination is still missing. `ContainerMountsService.reconcile()` also ignores the returned `current` list, so backend `PATCH` can report `{ ok: true }` without proving visibility.
- `listContainerMounts()` catches helper/list failures and returns `[]`. That is acceptable for best-effort observation, but unsafe as a postcondition for a running-container mount update.
- The mount helper enters the target mount namespace, but destination creation and `move_mount` must resolve the destination inside the target container root, not merely against the helper process root after `setns`. If `/mnt/nfs` is created/mounted in the wrong root view, helper exit can be successful while `docker exec ... test -d /mnt/nfs` still fails.
- Current reconcile source comparison uses `cur.src !== spec.hostPath`. For NFS and other bind-mounted filesystems, mountinfo `source` may be the remote superblock source, not the host path. Source identity should be verified by mount presence/stat identity rather than a raw source-string equality check.
- Propagation should not depend on host mount propagation settings for this path; `open_tree`/`move_mount` should inject the mounted subtree directly. If propagation is still relevant on a host/kernel combination, the post-apply verification must catch it and surface a clear agent error.

### Interfaces

No public REST request/response change is required for the minimal product fix.

Internal agent command acks should become more informative for container mount commands by returning a typed result in the existing `commandAck.data` field:

```ts
type ContainerMountEntry = {
  dst: string;
  src?: string;
  fsType?: string;
  options?: string;
};

type ContainerMountApplyResult = {
  dockerId: string;
  pid: number;
  expected: ContainerMountSpec[];
  current: ContainerMountEntry[];
};
```

The existing command names stay unchanged:

- `applyContainerMount`
- `removeContainerMount`
- `reconcileContainerMounts`

Behavior change:

- For a running container, agent mount commands fail the ack when post-apply verification does not find every expected destination.
- For a stopped container, backend may keep the expected DB rows and rely on the existing container-start reconcile hook; this preserves current expected-mount semantics.
- Backend `PATCH /containers/:serverId/:dockerId/mounts` must not return success for a running online container if the agent reports or proves that expected mounts are absent.

### Data Model Changes

No database schema migration is required.

`container_mounts` remains the desired-state table. The fix changes runtime reconciliation semantics and diagnostics only. Existing local mounts and host-level remote FS mounts keep their current storage and assignment models.

### Minimal Product Fix Path

1. Make agent container-mount operations verify their postcondition in the target container mount namespace.
2. Make helper destination handling resolve paths inside the target container root when needed.
3. Make backend reconcile consume and validate the agent's returned visibility result before `PATCH` reports success for running containers.
4. Keep remote host FS mounting unchanged; the host remote FS status already passed live NFS verification.

### File-Level Change List

- `packages/agent/src/commands/dispatcher.ts`
  - Introduce a shared helper such as `verifyContainerMounts(pid, expected)` used by both `applySingleMount()` and `reconcileContainerMounts()`.
  - Make final `listContainerMounts` strict during post-apply verification; do not swallow list errors when command success depends on the list.
  - After every mount/reconcile for a running container, fail the command if an expected `containerPath` is absent.
  - Replace raw `cur.src !== spec.hostPath` as the only source-change test. Prefer helper/stat verification of source identity; at minimum, do not treat NFS mountinfo source strings as proof that the host path differs.
  - Include `dockerId`, `pid`, `expected`, and `current` in ack data for successful apply/reconcile.
  - Add clear errors for missing host path, non-running container during immediate apply, helper failures, and post-verify missing destination.
- `tools/mount-helper/src/main.rs`
  - Audit `mount` destination handling after `setns(CLONE_NEWNS)`.
  - Ensure `create_dir_all(dst)` and `move_mount(..., dst, ...)` operate relative to the target container root. A safe implementation is to open `/proc/<pid>/root`, enter the mount namespace, `fchdir`/`chroot` to that root, then create and move the mount to the normalized absolute destination.
  - Add or extend helper output/commands if needed so the agent can verify destination presence and source identity from the same namespace view used by the container.
  - Keep `open_tree(src)` in the host namespace so remote NFS host mounts continue to be cloned from the already-mounted host path.
- `packages/common/src/protocol/agent-messages.ts`
  - Add optional internal result types/schemas for container mount apply/reconcile results if tests need typed command data. This is additive because `commandAck.data` is already unknown/optional.
- `packages/backend/src/containers/container-mounts.service.ts`
  - Change `reconcile()` to return the agent reconcile result for running containers.
  - In `setExpectedMounts()` and `addMount()`, validate that the returned `current` list contains every expected `containerPath` when the container is running.
  - Move or supplement audit/logging so a successful audit for a running container means the expected mount was verified, not merely stored in DB.
  - Preserve DB desired-state writes for stopped/offline containers so mounts can still reconcile on start/reconnect.
- `packages/backend/src/containers/containers.service.ts`
  - Keep existing authorization and per-container locking unchanged; no public DTO change is expected.

### Required Semantics

- A running-container mount update is successful only when every expected mount path is visible in the target container mount namespace after reconciliation.
- A missing or unverifiable destination is an agent command failure, mapped by backend to the existing agent error HTTP path instead of a false `{ ok: true }`.
- Local container mounts continue using the same expected-mount table and same runtime helper path. The verification logic must work for both local and remote sources.
- Remote host FS mount lifecycle remains unchanged: `applyRemoteFsMount` still mounts NFS/CephFS on the host and registers a `DataDirsManager` remote source with `quotaEnabled=false`.
- Stopped/offline containers keep desired-state semantics; the backend can store expected mounts and reconcile when the container starts or the agent reconnects.

### Focused Tests

- Agent dispatcher tests:
  - `reconcileContainerMounts` fails ack when helper `mount` exits 0 but strict final list does not contain the expected `containerPath`.
  - `applyContainerMount` fails ack on final list failure instead of returning success with `[]`.
  - `reconcileContainerMounts` returns `current` with the expected destination when verification succeeds.
  - NFS-style list entries whose `src` is not the host path are not repeatedly treated as source mismatch if destination/source identity verification passes.
  - Stopped containers still return without attempting dynamic namespace mutation, preserving desired-state-on-start behavior.
- Mount helper tests or equivalent integration checks:
  - Destination directory creation occurs inside the target container root view.
  - A helper `mount --pid <pid> --src <hostPath> --dst /mnt/nfs` makes `/mnt/nfs` visible from a command executed inside that container.
  - Helper `list --pid <pid>` reports the destination path after mount and omits it after unmount.
- Backend tests:
  - `ContainerMountsService.setExpectedMounts()` for a running container propagates an agent verification failure, so `PATCH mounts` does not return success.
  - `ContainerMountsService.reconcile()` validates returned `current` against expected paths for running containers.
  - Offline/stopped-container expected mount updates still persist DB rows and do not require immediate visibility.
  - Local mount cases still pass with the same semantics as remote mount cases.

### Live NFS Container Read-Write Verification

The AGT-018 retry passes only when all of the following are captured:

- Temporary local NFS export is mounted on the CPU host and product reports the remote FS assignment status as `mounted`.
- Host/export bidirectional read-write still passes before container testing.
- A restricted user, grant, remote data dir, and running CPU container are created through the product API.
- `PATCH /api/containers/:serverId/:dockerId/mounts` returns success and the agent/backend evidence includes a verified `current` entry for `/mnt/nfs`.
- Inside the running container:
  - `test -d /mnt/nfs` passes.
  - `findmnt /mnt/nfs` or `/proc/self/mountinfo` shows `/mnt/nfs`.
  - Writing a file under `/mnt/nfs` is visible on the exported path.
  - A file written on the export is readable from `/mnt/nfs`.
- Removing the container mount makes `/mnt/nfs` disappear from the running container, and cleanup leaves no API records, Docker containers, host mount paths, exportfs entries, or common-src generated artifacts.

### Risks and Trade-Offs

- The mount-helper root handling may require touching `tools/mount-helper/src/main.rs`, which is outside the normal package source directories and should be explicitly allowed in the implementation dispatch.
- Strict verification can turn previously silent dynamic-mount no-ops into visible 502-style errors. This is intended for running containers because false success hides data access failures.
- Source-string comparison from mountinfo is not stable across local bind mounts, NFS, and overlay-backed paths. Stat/root identity verification is more robust but requires helper support.
- If a kernel lacks the expected `open_tree`/`move_mount` behavior, the product should fail clearly and keep DB desired state rather than claiming the mount is live.

### Out of Scope

- Redesigning remote FS definitions, assignments, grants, or host NFS mounting.
- Changing public REST DTOs or frontend behavior.
- Quota enforcement for remote NFS/CephFS.
- Historical cleanup of old failed mount rows beyond the normal test cleanup path.

## Follow-Up: NFS-Backed Dynamic Container Mount Source Verification

### Goal

Make dynamic container mount verification accept a successful NFS-backed mount when the container mount namespace reports the canonical NFS source, while still failing closed for absent, unrelated, or unprovable mounts.

### Root Cause

The live CPU NFS verification after the latest fail-closed agent change proved that the runtime mount existed and read/write worked, but the product API still returned HTTP 500:

- Requested/expected host bind source: `/mnt/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`.
- `mount-helper list` actual source: `10.8.96.92:/srv/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`.
- Destination: `/mnt/nfs`.
- Direct container inspection showed `/mnt/nfs` present as `nfs4`.
- Export-to-container and container-to-export/host read-write both passed.

The false failure is in `CommandDispatcher.verifyExpectedContainerMounts()`: it treats `actual.src !== spec.hostPath` as a mismatch. For a host path that is a subdirectory of a mounted NFS export, the container mount entry can report the NFS superblock source plus the relative suffix instead of the local host mount path. In the live run, `/mnt/nfs-live-20260601t214626z` was backed by `10.8.96.92:/srv/nfs-live-20260601t214626z`, so the expected host subpath `rw-nfslive20260601t214626z` is equivalent to the helper source `10.8.96.92:/srv/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`.

### Interfaces

No public REST, protocol, schema, or frontend change is required for this defect. Code inspection shows that the backend already sends the agent a `ContainerMountSpec` with the agent-visible `hostPath`; the failure is the agent's internal verification rule.

Internal agent behavior changes only:

- `applyContainerMount` and `reconcileContainerMounts` keep the same WebSocket command names and payloads.
- Successful command acks remain successful only after post-apply verification.
- Failed command acks keep using the existing error path when the destination is missing or the source cannot be proven equivalent.
- `verifyExpectedContainerMounts()` should become async, or delegate to an async verifier, because it must read current host mount state from `/proc/mounts`.

### Verification Rule

For each expected `ContainerMountSpec`:

1. Require a `mount-helper list` entry whose `dst` exactly equals `spec.containerPath`. If it is absent, fail closed.
2. If `actual.src === spec.hostPath`, pass as the existing exact-source case.
3. If the source is not exact, resolve `spec.hostPath` on the agent host. If the path cannot be resolved, fail closed.
4. Read current host `/proc/mounts` with a fresh read or cache bypass for verification, decode proc path escapes, and find the longest mountpoint that contains the resolved expected host path on a path boundary.
5. Compute the relative suffix from that host mountpoint to the resolved expected host path.
6. Build the canonical backed source by appending the relative suffix to the host mount entry's source using POSIX slash rules.
7. Accept the non-exact source only when this canonical backed source exactly equals `actual.src`. The live expected result is `10.8.96.92:/srv/nfs-live-20260601t214626z` plus `rw-nfslive20260601t214626z` equals `10.8.96.92:/srv/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`.
8. If no containing host mount exists, the suffix is outside the mount, the fstype/source grammar cannot prove equivalence, or the canonical source differs, fail closed.

Use the same equivalence check in both places that compare sources:

- In `reconcileContainerMounts()`, decide whether an existing destination is already acceptable before unmounting/remounting it.
- In post-apply verification for both `applySingleMount()` and `reconcileContainerMounts()`, decide whether the final observed mount satisfies the expected spec.

### Data Model Notes

No database migration is required. `container_mounts` continues to store desired state, and remote FS assignments continue to provide host mountpoints through existing data directory resolution. No new persisted fields are needed because the backing source can be derived from current agent host `/proc/mounts`.

### File-Level Change List

- `packages/agent/src/commands/dispatcher.ts`
  - Modify `verifyExpectedContainerMounts()` to use a shared source-equivalence verifier instead of raw string inequality.
  - Make verification async where needed and await it from `applySingleMount()` and `reconcileContainerMounts()`.
  - Use the same verifier when deciding whether an existing destination in `reconcileContainerMounts()` must be replaced.
  - Keep missing destinations, helper list failures during postconditions, unresolved host paths, and unprovable source mismatches as command failures.
  - Keep clear error text that includes `dockerId`, `pid`, expected host source, actual source, destination, and whether equivalence proof failed.
- `packages/agent/src/fs/proc-mounts.ts`
  - Add a small parser/helper for `/proc/mounts` entries, including proc escape decoding and longest-containing-mount lookup.
  - Add a fresh-read or cache-bypass path for verification so recent remote mounts are not hidden by the existing 5 second cache.
  - Keep the current cached reader behavior available for periodic observation callers.
- `packages/agent/src/commands/dispatcher.test.ts`
  - Add focused coverage for exact source success, NFS canonical-source equivalence success, missing destination failure, unrelated NFS source failure, unresolved host path failure, non-NFS mismatch failure, and reconcile no-op behavior when an existing NFS-backed destination is already equivalent.
  - Existing dynamic-mount fail-closed tests should remain meaningful and be updated only where the expected source is now provably equivalent.
- Devops/tester live verification record
  - Rerun the CPU live NFS container verification after redeploying the fixed agent.
  - Expect `PATCH /api/containers/:serverId/:dockerId/mounts` success, `/mnt/nfs` visible in-container as NFS/NFS4, bidirectional container/export/host read-write success, BCK-014 delete/unassign guards still HTTP 409 while the mount row exists, and cleanup residuals none.

No backend, common protocol, frontend, script, config, lockfile, or mount-helper change is expected for this follow-up. If implementation discovers that `mount-helper list` does not expose enough source information, stop and return to architecture before expanding scope.

### Risks and Trade-Offs

- `/proc/mounts` parsing is easy to get subtly wrong for escaped spaces, nested mounts, and path-boundary matching. A small parser with unit coverage is safer than ad hoc string splitting at the call site.
- The backing-source-plus-suffix proof depends on host and helper source strings using the same canonical NFS source format. If they diverge, the system should fail closed rather than silently accept.
- Cache staleness can cause a false negative immediately after a mount is created. Verification should use a fresh read or an explicit bypass.
- Broadly accepting non-exact sources would hide real wrong-mount bugs. The non-exact path should be accepted only when the current host mount ancestry proves the exact helper-reported source.
- Symlink-heavy host paths may need `realpath` normalization on both the expected path and mountpoint containment checks. If resolution fails, fail closed.

### Acceptance Criteria

- The live false mismatch is explained in code comments/tests or implementation notes using the exact shape: expected local host path `/mnt/nfs-live-.../rw-...` versus actual NFS source `10.8.96.92:/srv/nfs-live-.../rw-...`.
- `applyContainerMount` succeeds when `mount-helper list` reports the expected destination and an exact source match.
- `applyContainerMount` succeeds when the expected host path is a subpath of a current NFS host mount and the host mount source plus relative suffix equals the helper-reported source.
- `reconcileContainerMounts` treats an already-mounted equivalent NFS-backed destination as satisfied and does not unmount/remount only because `actual.src` differs from `spec.hostPath`.
- Verification fails closed when the expected destination is absent.
- Verification fails closed when the helper source points to a different NFS server, export, or relative suffix.
- Verification fails closed when the expected host path cannot be resolved or cannot be matched to a current containing host mount.
- Verification fails closed for non-exact local/non-NFS cases unless an implementation can prove equivalence with the same current-host-mount ancestry rule and focused tests.
- Focused agent unit tests pass, and the CPU live NFS container verification passes with product `PATCH` success, container read/write evidence, BCK-014 guards, and no cleanup residuals.

### Out of Scope

- Public REST DTO, WebSocket payload, database schema, or frontend changes.
- Redesigning remote FS definitions, grants, assignments, or host NFS mount lifecycle.
- Changing the mount-helper unless source information is proven insufficient during implementation.
- Generalizing source equivalence for CephFS or other filesystems without a separate design and live evidence.
- Historical cleanup of old mount rows or unrelated deployment/test harness changes.

## Focused Deployment Design: GPU Docker Root XFS Project Quota Remediation

### Goal

Allow restricted GPU containers to be created on the GPU test host while preserving fail-closed XFS project quota semantics, so the live GPU metrics API attribution proof can be rerun and produce per-container/per-user GPU memory evidence.

### Failure Classification

The focused GPU API proof failed on a deployment/runtime precondition, not on product behavior:

- Backend, VictoriaMetrics, GPU agent, managed Docker, NVIDIA runtime, GPU inventory, and the managed `ubuntu:22.04` image were available.
- The restricted product user, GPU grant, and image grant were created successfully.
- Restricted `POST /api/containers` failed only when the agent tried to assign the Docker writable-layer `upperDir`/`workDir` paths to the owner's XFS project.
- The active Docker root `/data0/nbTest/nyabase-docker` is on `/data0`, mounted as XFS with `noquota`; `xfs_quota state -p` did not show project accounting or enforcement, and a runtime remount attempt did not change the mount state.
- All inspected existing GPU host XFS mounts (`/`, `/data0`, `/data1`, `/fast0`) reported `noquota`.

The product should keep failing closed. The current quota design says local data and container writable layers must not be allowed when project quota assignment cannot be verified. Weakening this would make user disk grants unenforced while reporting a successful restricted container create. A product change would be required only if requirements explicitly changed to permit unquotaed restricted containers; that would need a new policy/API design because it would contradict the existing XFS quota enforcement design and the CPU writable-layer proof.

### Interfaces

No product API, WebSocket protocol, database schema, common type, frontend, or source-code interface change is required.

Runtime/deployment interface touched by devops only:

- GPU agent `/etc/nyabase/agent.yaml`
  - Before: `dockerRoot: /data0/nbTest/nyabase-docker`
  - After: `dockerRoot` points to an XFS filesystem mounted with project quota accounting and enforcement enabled, for example `/data0/nbTest/nyabase-docker-pquota`.
- GPU host mount table
  - Add or select a mount whose `findmnt` options include `prjquota` or `pquota`, and whose `xfs_quota -x -c "state -p"` reports project accounting `ON` and enforcement `ON`.
- Managed Docker image inventory
  - Preserve or restore `ubuntu:22.04` in the new nyabase-managed Docker data root before rerunning the proof.

Backend server records can remain unchanged. On reconnect, the agent reports the new Docker root in `hello`/daemon status; the existing backend state cache should reflect it without schema changes.

### Data Model Changes

None.

No migration is needed because the failure is the filesystem backing the managed Docker data root, not persisted product state.

### Minimal Deployment Remediation

Preferred remediation is to place the GPU agent's managed Docker root on a quota-capable XFS mount and restart the agent so it regenerates `nyabase-docker.service` with the new `--data-root`.

1. Preflight and preserve current state:
   - Confirm no active product GPU test containers need to be retained.
   - Record current service status and backend online status without raw tokens.
   - Confirm current root and failure state with `findmnt -T /data0/nbTest/nyabase-docker` and `xfs_quota -x -c "state -p" /data0`.
   - Save the existing managed image while the old managed Docker daemon is still reachable:
     - `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker image inspect ubuntu:22.04`
     - `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker save ubuntu:22.04 -o /data0/nbTest/ubuntu-22.04-nyabase-managed.tar`
   - Keep `/data0/nbTest/nyabase-docker` intact as rollback data; do not delete or move it during the remediation.

2. Create or select a quota-capable XFS target:
   - If an existing filesystem can be mounted persistently with project quotas, use a new empty directory on that mount, for example `/data0/nbTest/nyabase-docker-pquota`.
   - Because all currently inspected mounts report `noquota`, the safe test-environment fallback is a loopback XFS filesystem:
     - Create a sufficiently sized sparse backing file under `/data0/nbTest`, for example `/data0/nbTest/nyabase-docker-pquota.img`. Size it for the proof plus image layers and cleanup headroom.
     - Format it as XFS with overlay-compatible directory entry support; verify `xfs_info` reports `ftype=1`.
     - Mount it at `/data0/nbTest/nyabase-docker-pquota` with `prjquota` or `pquota`.
     - Prefer a persistent `/etc/fstab` entry or a systemd mount unit for the duration of the test session, so a host reboot does not silently return the agent to an unmounted parent directory.
   - Required checks before starting Docker on the new root:
     - `findmnt -T /data0/nbTest/nyabase-docker-pquota -o TARGET,FSTYPE,OPTIONS -n` shows `xfs` and `prjquota`/`pquota`.
     - `xfs_quota -x -c "state -p" /data0/nbTest/nyabase-docker-pquota` shows project accounting and enforcement `ON`.
     - `xfs_info /data0/nbTest/nyabase-docker-pquota` shows `ftype=1`.

3. Move the GPU agent runtime to the new root:
   - Stop `nyabase-agent` and `nyabase-docker.service`.
   - Update only the GPU host runtime config so `/etc/nyabase/agent.yaml` uses the new `dockerRoot`.
   - Start `nyabase-agent`; agent startup should reconcile the managed Docker unit with `--data-root=<new root>` and start `nyabase-docker.service`.
   - Verify:
     - Both `nyabase-agent` and `nyabase-docker.service` are `active`.
     - `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker info` reports the new Docker root and `overlay2`.
     - `docker info` still lists the NVIDIA runtime on the managed daemon.
     - Backend reports the GPU server `online`.

4. Restore required image into the new root:
   - Load from the saved tar:
     - `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker load -i /data0/nbTest/ubuntu-22.04-nyabase-managed.tar`
   - If the tar is unavailable and registry/network access is acceptable, pull `ubuntu:22.04` through the managed daemon instead.
   - Verify:
     - `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker image inspect ubuntu:22.04` succeeds.
     - `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker run --rm --gpus device=0 ubuntu:22.04 nvidia-smi -L` prints GPU 0.

5. Rerun the focused GPU metrics API attribution proof.

### Rollback and Cleanup

Rollback returns the host to the previous noquota Docker root for service recovery only; it will not satisfy restricted-container quota tests.

- Stop `nyabase-agent` and `nyabase-docker.service`.
- Restore `/etc/nyabase/agent.yaml` to `dockerRoot: /data0/nbTest/nyabase-docker`.
- Start `nyabase-agent` and verify the managed Docker daemon and backend online status recover.
- If using the loopback fallback and it is no longer needed:
  - Ensure no loopback-root containers are running.
  - Unmount `/data0/nbTest/nyabase-docker-pquota`.
  - Remove the temporary fstab/systemd mount entry.
  - Detach any loop device associated with `/data0/nbTest/nyabase-docker-pquota.img`.
  - Remove the loopback image file and the saved `ubuntu:22.04` tar only after rollback or successful proof retention decisions are complete.
- After either remediation or rollback, scan and clean exact helper artifacts from the focused proof:
  - No run-id containers in managed Docker.
  - No run-id API users, image records, grants, or containers.
  - No exact run-id paths in `/etc/projects` or `/etc/projid`.
  - No temporary cleanup backup files.
  - `nyabase-agent` and `nyabase-docker.service` end `active`; backend GPU server ends `online`.

### File-Level Change List

No repository source, tests, scripts, lockfiles, frontend baselines, or harness `tests.md` changes are required.

Runtime files to be changed by a later devops dispatch only:

- GPU host `/etc/nyabase/agent.yaml` - modify `dockerRoot` to the quota-capable XFS target.
- GPU host mount configuration (`/etc/fstab` or a systemd mount unit) - optional but recommended for the loopback test filesystem if the proof may span service or host restarts.
- GPU host generated `nyabase-docker.service` - not edited directly; the agent rewrites/reconciles it from `dockerRoot`.

### Risks and Trade-Offs

- Loopback XFS is a test-environment workaround. It is acceptable for proving product behavior but should not be treated as production storage guidance without capacity, performance, and reboot policy review.
- The backing file must have enough space for Docker image layers, writable layers, and cleanup headroom. Undersizing the loopback filesystem can produce unrelated Docker `ENOSPC` failures.
- If the mount is not persistent, a reboot can leave the mountpoint as a normal directory on `/data0` with `noquota`; devops must verify `findmnt` and `xfs_quota` after every restart before testing.
- Docker data-root changes make the new root start with an empty image/container inventory. Saving/loading `ubuntu:22.04` avoids coupling the proof to external registry availability.
- Rollback to the old root restores previous service behavior but also restores the quota blocker for restricted GPU containers.

### Acceptance Criteria

1. The failure is recorded as a deployment/runtime precondition: GPU Docker root is on XFS `noquota`, while the product correctly fail-closes when writable-layer project quota enforcement cannot be verified.
2. No product source, test, script, lockfile, frontend baseline, database schema, or public API/protocol change is required; remediation is devops-only runtime configuration and host filesystem setup.
3. GPU agent `dockerRoot` is moved to an XFS mount whose `findmnt` options include `prjquota`/`pquota`, whose `xfs_quota state -p` reports project accounting and enforcement `ON`, and whose `xfs_info` reports overlay-compatible `ftype=1`.
4. If no existing GPU host mount can be remounted with project quotas, a loopback XFS filesystem under `/data0/nbTest` is used as the safe test fallback and is mounted at the new Docker root with project quotas enabled.
5. After the move, `nyabase-agent` and `nyabase-docker.service` are `active`, the managed Docker daemon reports the new Docker root, the NVIDIA runtime remains available, and the backend reports the GPU server `online`.
6. `ubuntu:22.04` is present in the new managed Docker root by loading the saved tar from the old root or by pulling it through the managed daemon, and `docker run --rm --gpus device=0 ubuntu:22.04 nvidia-smi -L` succeeds.
7. Rerun proof restricted GPU container creation succeeds through `POST /api/containers` for the disposable restricted user with GPU index `0`.
8. During the GPU workload, VictoriaMetrics has positive `nyabase_gpu_proc_mem_used_bytes` samples labeled with the target `container_id`, owning product `user_id`, and `gpu_uuid`.
9. Backend `/api/metrics/servers/:gpuId/containers` and `/api/metrics/servers/:gpuId/users` return positive `gpuMemUsed.points` for the target container and owner user, and `/api/containers/:serverId/:dockerId/stats` returns non-empty `gpuMemUsedMiB` keyed by GPU UUID.
10. Cleanup leaves no run-id API records, no run-id managed Docker containers, no exact run-id XFS project/projid entries or temporary cleanup backups, while `nyabase-agent`, `nyabase-docker.service`, backend, frontend, VictoriaMetrics, and the common-src artifact guard all remain healthy.

### Out of Scope

- Weakening fail-closed XFS quota behavior or adding an unquotaed restricted-container mode.
- Product source, tests, scripts, runtime code generation, frontend, schema, or public API changes.
- Migrating old Docker containers from `/data0/nbTest/nyabase-docker`; the focused proof needs only `ubuntu:22.04` and disposable test containers.
- Production storage architecture for GPU hosts beyond this local test deployment remediation.
