# Test Record

Session: `multi-user-redteam-continuation/20260603T143528Z`
Role: devops

## Current Environment Preflight

Prepared: `2026-06-03T14:37:49Z`
Role: devops
Scope: current read-mostly preflight for local backend/frontend/VictoriaMetrics, remote CPU/GPU agents, managed Docker daemons, XFS quota/GPU basics, product online state via admin API when available from `test/.env`, and common-src artifact guard. No product source, tests, scripts, configs, lockfiles, services, images, containers, users, grants, or fixtures were edited, restarted, created, deleted, or cleaned. Admin credentials from `test/.env` were used only in-process; no raw password, JWT, refresh token, API-token secret, agent token, SSH key, or remote secret is recorded.

Overall classification: `pass`

### Local Services

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend auth guard | pass | `curl -sS -o /tmp/nyabase-preflight-auth-me.out -w '%{http_code}' --max-time 8 http://localhost:3001/api/auth/me` returned `401`; body tail `{"message":"Unauthorized","statusCode":401}`. |
| Frontend root | pass | `curl -sS -o /tmp/nyabase-preflight-frontend.out -w '%{http_code}' --max-time 8 http://localhost:5173/` returned `200`; body begins `<!doctype html> <html lang="en">`. |
| VictoriaMetrics health | pass | `curl -sS -o /tmp/nyabase-preflight-vm-health.out -w '%{http_code}' --max-time 8 http://127.0.0.1:8428/health` returned `200`; body `OK`. |
| VictoriaMetrics query | pass | `curl -sS -o /tmp/nyabase-preflight-vm-query.out -w '%{http_code}' --max-time 8 'http://127.0.0.1:8428/api/v1/query?query=up'` returned `200`; JSON status `success`, result type `vector`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned exactly no paths; count `0`. |

### Product API Online State

Command/procedure: Node one-shot read `test/.env`, logged in as `ADMIN_USERNAME || admin` using `ADMIN_INIT_PASSWORD`, called `GET /api/servers`, and printed only username, capability count, server names/ids/GPU flags/statuses, and derived online booleans.

| Surface | Status | Evidence |
| --- | --- | --- |
| Admin API login from `test/.env` | pass | `POST /api/auth/login` returned `200`; admin user `admin`, capability count `8`. |
| CPU server online state | pass | `nyabase-cpu-batch-20260601T163636Z` id `05cea385-d6ca-490a-a126-e00d0ae23b70`, `isGpu=false`, status `online`; derived `product_online cpu=true`. |
| GPU server online state | pass | `nyabase-gpu-batch-20260601T163636Z` id `db1112fe-1c55-4314-9511-6d8510c523c2`, `isGpu=true`, status `online`; derived `product_online gpu=true`. |
| Other product rows | pass | Additional servers were present but offline: `nyabase-test-1` id `5336594b-4f9a-4cef-b389-3ef9aa1eca78` and `nyabase-gpu-1` id `291118dd-673f-4b26-8d15-b27a0ed374ad`, both `isGpu=true`, status `offline`. They were not used for the continuation online-state pass. |

### CPU Agent Host `root@10.8.96.91`

Command/procedure: `ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 'bash -s'` read-only probes: timestamp, hostname, `systemctl is-active/status` for `nyabase-agent` and `nyabase-docker.service`, journal grep for `[WS] Connected`, managed Docker `info` and `system df` over `/run/nyabase-agent/docker.sock`, `/data` `findmnt`/`df`, and `xfs_quota -x -c 'state -p' /data`.

| Surface | Status | Evidence |
| --- | --- | --- |
| SSH/host identity | pass | Host reachable; timestamp `2026-06-03T14:37:49Z`; hostname `nyabase-test-1`. |
| Agent service | pass | `systemctl is-active nyabase-agent` returned `active`; status showed `Active: active (running) since Tue 2026-06-02 23:44:55 CST`, main PID `2219942`. |
| Managed Docker service | pass | `systemctl is-active nyabase-docker.service` returned `active`; status showed `Active: active (running) since Tue 2026-06-02 23:44:57 CST`, main PID `2219991`. |
| WebSocket connection evidence | pass | Full journal grep tail included `Jun 02 23:44:57 nyabase-test-1 nyabase-agent[2219942]: [WS] Connected`; no new connection line appeared in the last four hours, but the service is active and product API reports the CPU batch server online. |
| Managed Docker root/socket | pass | Socket `/run/nyabase-agent/docker.sock`; Docker `ServerVersion=29.4.3`, `RootDir=/data/nyabase-docker`, `CgroupDriver=systemd`, runtimes `io.containerd.runc.v2 runc`. |
| Managed Docker inventory | pass | `docker system df`: `Images 1`, `Containers 1`, `Local Volumes 0`, `Build Cache 0`. |
| XFS quota basics | pass | `/data` mount: `/dev/sdb xfs rw,...,prjquota`; `df -h /data`: size `32G`, used `3.3G`, available `29G`, use `11%`; `xfs_quota state -p /data`: project quota accounting `ON`, enforcement `ON`. |

### GPU Agent Host `lyn@10.8.1.12`

Command/procedure: `ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 'bash -s'` read-only probes with `sudo -n` for privileged reads: timestamp, hostname, `systemctl is-active/status` for `nyabase-agent` and `nyabase-docker.service`, journal grep for `[WS] Connected`, managed Docker `info` and `system df` over `/run/nyabase-agent/docker.sock`, NVIDIA runtime/version, `nvidia-smi --query-gpu=index,name,memory.total,uuid`, active Docker root `findmnt`/`df`, and `xfs_quota -x -c 'state -p'`.

| Surface | Status | Evidence |
| --- | --- | --- |
| SSH/host identity | pass | Host reachable; timestamp `2026-06-03T14:36:42Z`; hostname `aya-1`. |
| Agent service | pass | `sudo -n systemctl is-active nyabase-agent` returned `active`; status showed `Active: active (running) since Mon 2026-06-01 23:27:19 UTC`, main PID `2105164`. |
| Managed Docker service | pass | `sudo -n systemctl is-active nyabase-docker.service` returned `active`; status showed `Active: active (running) since Mon 2026-06-01 23:27:21 UTC`, main PID `2105268`. |
| WebSocket connection evidence | pass | Full journal grep tail included `Jun 02 15:43:06 aya-1 nyabase-agent[2105164]: [WS] Connected`; no new connection line appeared in the last four hours, but the service is active and product API reports the GPU batch server online. |
| Managed Docker root/socket | pass | Socket `/run/nyabase-agent/docker.sock`; Docker `ServerVersion=29.0.2`, `RootDir=/data0/nbTest/nyabase-docker-pquota`, `CgroupDriver=systemd`, runtimes `io.containerd.runc.v2 nvidia runc`. |
| Managed Docker inventory | pass | `docker system df`: `Images 2`, `Containers 3`, `Local Volumes 0`, `Build Cache 0`. |
| NVIDIA runtime | pass | `nvidia-container-runtime` path `/usr/bin/nvidia-container-runtime`; version `1.18.0`, commit `f8daa5e26de9fd7eb79259040b6dd5a52060048c`. |
| GPU inventory | pass | `nvidia-smi` reported four `NVIDIA L40` GPUs: index `0` UUID `GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19`, index `1` UUID `GPU-23d8fdac-e091-5c42-df3c-8f72f52ef5fe`, index `2` UUID `GPU-597b76dd-7b55-577b-cad7-bc6638a43541`, index `3` UUID `GPU-14a856ae-d536-7446-a361-008dc8c3f4a7`; each memory total `46068` MiB. |
| Active Docker root filesystem/quota | pass | `findmnt -T /data0/nbTest/nyabase-docker-pquota`: target `/data0/nbTest/nyabase-docker-pquota`, source `/dev/loop3`, type `xfs`, options include `prjquota`; `df -h`: size `20G`, used `342M`, available `20G`, use `2%`; `xfs_quota state -p` reported project quota accounting `ON` and enforcement `ON`. |
| Quota command warning tail | pass | `xfs_quota` also printed transient stale-overlay warnings such as `cannot find mount point for path .../overlay2/.../diff` and `.../work`; the command still reached the quota state block showing accounting/enforcement `ON`. Classification remains `pass`; preserve this tail for later infra comparison if quota operations behave oddly. |

### Blockers / Failures

None. All required preflight surfaces were available. No `fail-infra` or `blocked-infra` classification was needed.

### Commands Run

- `curl -sS -o /tmp/nyabase-preflight-auth-me.out -w '%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-preflight-frontend.out -w '%{http_code}\n' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-preflight-vm-health.out -w '%{http_code}\n' --max-time 8 http://127.0.0.1:8428/health`
- `curl -sS -o /tmp/nyabase-preflight-vm-query.out -w '%{http_code}\n' --max-time 8 'http://127.0.0.1:8428/api/v1/query?query=up'`
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
- `node <<'NODE' ... read test/.env; POST /api/auth/login; GET /api/servers; print non-secret statuses ... NODE`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 'bash -s' ... CPU host service, Docker, filesystem, quota readback ...`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 "journalctl -u nyabase-agent --no-pager | grep -F '[WS] Connected' | tail -n 5 || true"`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 'bash -s' ... GPU host service, Docker, NVIDIA, filesystem, quota readback ...`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 "sudo -n journalctl -u nyabase-agent --no-pager | grep -F '[WS] Connected' | tail -n 5 || true"`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 "sudo -n xfs_quota -x -c 'state -p' /data0/nbTest/nyabase-docker-pquota 2>&1 | tail -n 14"`


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T14:51:04.218Z`
Run prefix: `murtc-20260603t145052z-c616aa`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-test`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t145052z-c616aa`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t145052z-c616aa-alpha | 30c07a95-fbff-4c5e-8b84-b3487304f22d | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]}]} |
| beta | murtc-20260603t145052z-c616aa-beta | c0f550ce-830a-4072-8c1c-08dd354c4573 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]}]} |
| gamma | murtc-20260603t145052z-c616aa-gamma | f882eeee-3d48-45fa-bc8d-e83919e4c8b7 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["0890ba3a-8d7a-4b96-94e2-d2eb704a0525"]}]} |
| delta | murtc-20260603t145052z-c616aa-delta | 0766462d-c8e9-455a-bc23-c453cd525fba | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["0890ba3a-8d7a-4b96-94e2-d2eb704a0525"]}]} |
| epsilon | murtc-20260603t145052z-c616aa-epsilon | 12501f9a-17b4-4573-a2cd-18675ce9706b | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t145052z-c616aa-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/8125627e87d9, alpha:murtc-20260603t145052z-c616aa-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/9582f44925ff, beta:murtc-20260603t145052z-c616aa-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/af3e2f14dad7
- Deleted containers: beta:murtc-20260603t145052z-c616aa-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/af3e2f14dad7, alpha:murtc-20260603t145052z-c616aa-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/9582f44925ff, alpha:murtc-20260603t145052z-c616aa-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/8125627e87d9
- Created users: 30c07a95-fbff-4c5e-8b84-b3487304f22d, c0f550ce-830a-4072-8c1c-08dd354c4573, f882eeee-3d48-45fa-bc8d-e83919e4c8b7, 0766462d-c8e9-455a-bc23-c453cd525fba, 12501f9a-17b4-4573-a2cd-18675ce9706b
- Deleted users: 30c07a95-fbff-4c5e-8b84-b3487304f22d, c0f550ce-830a-4072-8c1c-08dd354c4573, f882eeee-3d48-45fa-bc8d-e83919e4c8b7, 0766462d-c8e9-455a-bc23-c453cd525fba, 12501f9a-17b4-4573-a2cd-18675ce9706b
- Created images: 0257c666-c87e-4f5e-af9b-41fb6a28d6a6, 0890ba3a-8d7a-4b96-94e2-d2eb704a0525
- Deleted images: 0890ba3a-8d7a-4b96-94e2-d2eb704a0525, 0257c666-c87e-4f5e-af9b-41fb6a28d6a6

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["30c07a95-fbff-4c5e-8b84-b3487304f22d","c0f550ce-830a-4072-8c1c-08dd354c4573","f882eeee-3d48-45fa-bc8d-e83919e4c8b7","0766462d-c8e9-455a-bc23-c453cd525fba","12501f9a-17b4-4573-a2cd-18675ce9706b"],"deletedImages":["0890ba3a-8d7a-4b96-94e2-d2eb704a0525","0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["30c07a95-fbff-4c5e-8b84-b3487304f22d","c0f550ce-830a-4072-8c1c-08dd354c4573","f882eeee-3d48-45fa-bc8d-e83919e4c8b7","0766462d-c8e9-455a-bc23-c453cd525fba","12501f9a-17b4-4573-a2cd-18675ce9706b"],"imageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6","0890ba3a-8d7a-4b96-94e2-d2eb704a0525"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"30c07a95-fbff-4c5e-8b84-b3487304f22d","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"c0f550ce-830a-4072-8c1c-08dd354c4573","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f882eeee-3d48-45fa-bc8d-e83919e4c8b7","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["0890ba3a-8d7a-4b96-94e2-d2eb704a0525"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"0766462d-c8e9-455a-bc23-c453cd525fba","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6","0890ba3a-8d7a-4b96-94e2-d2eb704a0525"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"12501f9a-17b4-4573-a2cd-18675ce9706b","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["0257c666-c87e-4f5e-af9b-41fb6a28d6a6"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"8125627e87d9","exactDockerId":"9582f44925ff","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"af3e2f14dad7","exhaustedStatus":400}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: gamma create gamma-gpu-granted failed because the new continuation spec omitted the GPU-agent-required `sshPubKeys` field from `POST /api/containers`; rerun after fixing the test fixture payload. The API returned 502 with agent validation for missing `sshUser`, `sshUid`, and `sshPubKeys` in the agent command. (root cause: test)


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T14:53:18.181Z`
Run prefix: `murtc-20260603t145306z-b70680`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-test`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t145306z-b70680`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t145306z-b70680-alpha | 8c2516c2-57ec-400f-9cae-dd4826d38528 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1"]}]} |
| beta | murtc-20260603t145306z-b70680-beta | c96bce8b-f461-48b0-96ac-ce0b5ed8a197 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1"]}]} |
| gamma | murtc-20260603t145306z-b70680-gamma | e4c8dd05-de7b-4d10-a111-ebebfe7b15a9 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["068e864b-f77d-4c02-bc04-c195caba5200"]}]} |
| delta | murtc-20260603t145306z-b70680-delta | f5dfe729-1afc-4fdc-87ca-927bccfa21df | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["068e864b-f77d-4c02-bc04-c195caba5200"]}]} |
| epsilon | murtc-20260603t145306z-b70680-epsilon | 1e65e01b-3455-4e10-a011-25823aa19c4d | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t145306z-b70680-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/33a3d479080d, alpha:murtc-20260603t145306z-b70680-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/0c01348ba1e2, beta:murtc-20260603t145306z-b70680-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/221f9de56e56
- Deleted containers: beta:murtc-20260603t145306z-b70680-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/221f9de56e56, alpha:murtc-20260603t145306z-b70680-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/0c01348ba1e2, alpha:murtc-20260603t145306z-b70680-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/33a3d479080d
- Created users: 8c2516c2-57ec-400f-9cae-dd4826d38528, c96bce8b-f461-48b0-96ac-ce0b5ed8a197, e4c8dd05-de7b-4d10-a111-ebebfe7b15a9, f5dfe729-1afc-4fdc-87ca-927bccfa21df, 1e65e01b-3455-4e10-a011-25823aa19c4d
- Deleted users: 8c2516c2-57ec-400f-9cae-dd4826d38528, c96bce8b-f461-48b0-96ac-ce0b5ed8a197, e4c8dd05-de7b-4d10-a111-ebebfe7b15a9, f5dfe729-1afc-4fdc-87ca-927bccfa21df, 1e65e01b-3455-4e10-a011-25823aa19c4d
- Created images: 83776569-26e2-4903-a5d5-9fcdf3e014e1, 068e864b-f77d-4c02-bc04-c195caba5200
- Deleted images: 068e864b-f77d-4c02-bc04-c195caba5200, 83776569-26e2-4903-a5d5-9fcdf3e014e1

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["8c2516c2-57ec-400f-9cae-dd4826d38528","c96bce8b-f461-48b0-96ac-ce0b5ed8a197","e4c8dd05-de7b-4d10-a111-ebebfe7b15a9","f5dfe729-1afc-4fdc-87ca-927bccfa21df","1e65e01b-3455-4e10-a011-25823aa19c4d"],"deletedImages":["068e864b-f77d-4c02-bc04-c195caba5200","83776569-26e2-4903-a5d5-9fcdf3e014e1"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["8c2516c2-57ec-400f-9cae-dd4826d38528","c96bce8b-f461-48b0-96ac-ce0b5ed8a197","e4c8dd05-de7b-4d10-a111-ebebfe7b15a9","f5dfe729-1afc-4fdc-87ca-927bccfa21df","1e65e01b-3455-4e10-a011-25823aa19c4d"],"imageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1","068e864b-f77d-4c02-bc04-c195caba5200"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"8c2516c2-57ec-400f-9cae-dd4826d38528","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"c96bce8b-f461-48b0-96ac-ce0b5ed8a197","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"e4c8dd05-de7b-4d10-a111-ebebfe7b15a9","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["068e864b-f77d-4c02-bc04-c195caba5200"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f5dfe729-1afc-4fdc-87ca-927bccfa21df","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["068e864b-f77d-4c02-bc04-c195caba5200","83776569-26e2-4903-a5d5-9fcdf3e014e1"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"1e65e01b-3455-4e10-a011-25823aa19c4d","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["83776569-26e2-4903-a5d5-9fcdf3e014e1"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"33a3d479080d","exactDockerId":"0c01348ba1e2","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"221f9de56e56","exhaustedStatus":400}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: gamma create gamma-gpu-granted: {"message":"Agent error: [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"undefined\",\n    \"path\": [\n      \"sshUser\"\n    ],\n    \"message\": \"Required\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"number\",\n    \"received\": \"undefined\",\n    \"path\": [\n      \"sshUid\"\n    ],\n    \"message\": \"Required\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"array\",\n    \"received\": \"undefined\",\n    \"path\": [\n      \"sshPubKeys\"\n    ],\n    \"message\": \"Required\"\n  }\n]","error":"Bad Gateway","statusCode":502}: expected 502 to be 201 // Object.is equality (root cause: product)

Rerun diagnosis: the continuation test create helper was updated before this run to include top-level `sshUser: "root"`, `sshUid: 1000`, and `sshPubKeys: []` on every `POST /api/containers` request while preserving the `diskBytes` create-body exclusion. The live failure persisted because current `zCreateContainerRequest` strips legacy SSH request fields and accepts `sshServerEnabled`; current backend dispatch sends `sshServerEnabled` in the agent create payload, while the live GPU agent rejected the dispatched payload for missing legacy `sshUser`, `sshUid`, and `sshPubKeys`. Classification is therefore `fail-product` after the test-procedure fix, with cleanup complete for exact-prefix users/images/containers recorded above.

## Agent Rebuild Redeploy After Create Payload Fix

Prepared: `2026-06-03T15:00:46Z`
Role: devops
Scope: rebuilt `dist/nyabase-agent` from current source after the `packages/agent/src/commands/dispatcher.ts` create-payload fix, deployed the same binary to CPU `root@10.8.96.91` and GPU `lyn@10.8.1.12`, restarted only `nyabase-agent` plus the managed `nyabase-docker.service` as required for binary replacement, and verified reconnect/health. No product source, tests, scripts, configs, lockfiles, deployment files, tokens, agent YAML, systemd units, or unrelated runtime resources were edited.

Overall classification: `pass`

### Build Artifact

| Surface | Status | Evidence |
| --- | --- | --- |
| Agent build | pass | `bash scripts/build-agent-binary.sh` exited `0`; output ended with `Agent: /root/nyabase/dist/nyabase-agent (73M)`. |
| Local binary metadata | pass | SHA-256 `73b91331f0daaa3a8a069911043494adcced46fbf68a67c258ebcde36925ce46`; size `76210800`; mode `755`; mtime `2026-06-03 22:59:17.357434991 +0800`; path `dist/nyabase-agent`. |

### Remote Deployment

| Host | Status | Evidence |
| --- | --- | --- |
| CPU `root@10.8.96.91` | pass | Before deploy remote SHA-256 was `ac3aa1846c92c1dacd338bb76e7937953a253e85ec7832e92ad141cfb17e502f`; after deploy `/usr/local/bin/nyabase-agent` SHA-256 is `73b91331f0daaa3a8a069911043494adcced46fbf68a67c258ebcde36925ce46`, size `76210800`, mode `755`, mtime `2026-06-03 22:59:45.511134554 +0800`. |
| GPU `lyn@10.8.1.12` | pass | Before deploy remote SHA-256 was `234aaa8ac9a11afe93ab8e730c3be52d47372e3ebcb4eea97e18c21200f781f5`; after deploy `/usr/local/bin/nyabase-agent` SHA-256 is `73b91331f0daaa3a8a069911043494adcced46fbf68a67c258ebcde36925ce46`, size `76210800`, mode `755`, mtime `2026-06-03 14:58:58.539232482 +0000`. |
| Scoped restarts | pass | CPU command stopped `nyabase-agent` and `nyabase-docker.service`, removed/replaced the binary, `chmod +x`, then started `nyabase-agent`; GPU command used the documented `sudo -n` path for the same scoped stop/replace/start sequence. No broad Docker/resource cleanup was run. |

### Reconnect And Health

| Surface | Status | Evidence |
| --- | --- | --- |
| CPU services | pass | `systemctl is-active nyabase-agent` returned `active`; `systemctl is-active nyabase-docker.service` returned `active`. Journal after restart showed `[Agent] nyabase-docker daemon is running`, `[WS] Connecting to ws://10.8.96.92:3001/ws/agent...`, and `[WS] Connected` at `2026-06-03 22:59:47 +0800`. |
| GPU services | pass | `sudo -n systemctl is-active nyabase-agent` returned `active`; `sudo -n systemctl is-active nyabase-docker.service` returned `active`. Journal after restart showed `[Agent] nyabase-docker daemon is running`, `[WS] Connecting to ws://10.8.96.92:3001/ws/agent...`, and `[WS] Connected` at `2026-06-03 14:59:00 +0000`. |
| Backend auth guard | pass | `curl -sS -o /tmp/nyabase-redeploy-auth-me.out -w '%{http_code}' --max-time 8 http://localhost:3001/api/auth/me` returned `401`. |
| VictoriaMetrics health/query | pass | `curl -sS -o /tmp/nyabase-redeploy-vm-health.out -w '%{http_code}' --max-time 8 http://127.0.0.1:8428/health` returned `200`; `curl -sS -o /tmp/nyabase-redeploy-vm-query.out -w '%{http_code}' --max-time 8 'http://127.0.0.1:8428/api/v1/query?query=up'` returned `200`. |
| Product CPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-cpu-batch-20260601T163636Z` id `05cea385-d6ca-490a-a126-e00d0ae23b70`, `isGpu=false`, status `online`, `lastSeenAt=2026-06-03T15:00:37.180Z`; derived `product_online_cpu=true`. |
| Product GPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-gpu-batch-20260601T163636Z` id `db1112fe-1c55-4314-9511-6d8510c523c2`, `isGpu=true`, status `online`, `lastSeenAt=2026-06-03T15:00:38.035Z`; derived `product_online_gpu=true`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned exactly no paths before and after deployment. |

### Commands Run

- `bash scripts/build-agent-binary.sh`
- `sha256sum dist/nyabase-agent && stat -c 'size=%s mode=%a mtime=%y path=%n' dist/nyabase-agent`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 'systemctl stop nyabase-agent && systemctl stop nyabase-docker.service 2>/dev/null; rm -f /usr/local/bin/nyabase-agent'`
- `scp -q dist/nyabase-agent root@10.8.96.91:/usr/local/bin/nyabase-agent`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 'chmod +x /usr/local/bin/nyabase-agent && systemctl start nyabase-agent'`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 'sudo -n systemctl stop nyabase-agent; sudo -n systemctl stop nyabase-docker.service 2>/dev/null; sudo -n rm -f /usr/local/bin/nyabase-agent'`
- `scp -q dist/nyabase-agent lyn@10.8.1.12:/tmp/nyabase-agent`
- `ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 'sudo -n mv /tmp/nyabase-agent /usr/local/bin/nyabase-agent && sudo -n chmod +x /usr/local/bin/nyabase-agent && sudo -n systemctl start nyabase-agent'`
- Remote verification commands for `systemctl is-active`, `sha256sum`, `stat`, and recent `journalctl -u nyabase-agent`.
- Local verification commands for `/api/auth/me`, VictoriaMetrics `/health`, VictoriaMetrics `query=up`, common-src artifact guard, and admin `GET /api/servers` status readback.

### Notes

- CPU journal output still contained older pre-redeploy `reconcileContainerMounts` 404 lines for containers from the earlier failed live-test cleanup window; after the fresh restart, the relevant service sequence reached managed Docker running and `[WS] Connected`.
- GPU journal output still contained older pre-redeploy Zod validation errors requiring legacy `sshUser`/`sshUid`/`sshPubKeys`; after the fresh restart, the relevant service sequence reached managed Docker running and `[WS] Connected`.


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:02:06.258Z`
Run prefix: `murtc-20260603t150204z-f4ed09`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t150204z-f4ed09`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t150204z-f4ed09-alpha | 32b3a387-0353-4fc5-a351-fb790fa0d6bf | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b"]}]} |
| beta | murtc-20260603t150204z-f4ed09-beta | 926199f3-5c1e-4cd8-a9dd-8d3188e104e4 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b"]}]} |
| gamma | murtc-20260603t150204z-f4ed09-gamma | e016a581-af0e-4382-8597-524bdcd0a3fa | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["d97eb7f2-10bd-4903-abdd-fee1507ae94e"]}]} |
| delta | murtc-20260603t150204z-f4ed09-delta | 4c3200a7-fc43-44a8-afd0-1aa8ede086a0 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["d97eb7f2-10bd-4903-abdd-fee1507ae94e"]}]} |
| epsilon | murtc-20260603t150204z-f4ed09-epsilon | 305463b7-00e4-45ac-a95a-ca9058616b43 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b"]}]} |

### Created / Deleted Runtime IDs

- Created containers: none
- Deleted containers: none
- Created users: 32b3a387-0353-4fc5-a351-fb790fa0d6bf, 926199f3-5c1e-4cd8-a9dd-8d3188e104e4, e016a581-af0e-4382-8597-524bdcd0a3fa, 4c3200a7-fc43-44a8-afd0-1aa8ede086a0, 305463b7-00e4-45ac-a95a-ca9058616b43
- Deleted users: 32b3a387-0353-4fc5-a351-fb790fa0d6bf, 926199f3-5c1e-4cd8-a9dd-8d3188e104e4, e016a581-af0e-4382-8597-524bdcd0a3fa, 4c3200a7-fc43-44a8-afd0-1aa8ede086a0, 305463b7-00e4-45ac-a95a-ca9058616b43
- Created images: 1897cff0-a8a0-4668-9008-d9d7d2598e2b, d97eb7f2-10bd-4903-abdd-fee1507ae94e
- Deleted images: d97eb7f2-10bd-4903-abdd-fee1507ae94e, 1897cff0-a8a0-4668-9008-d9d7d2598e2b

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["32b3a387-0353-4fc5-a351-fb790fa0d6bf","926199f3-5c1e-4cd8-a9dd-8d3188e104e4","e016a581-af0e-4382-8597-524bdcd0a3fa","4c3200a7-fc43-44a8-afd0-1aa8ede086a0","305463b7-00e4-45ac-a95a-ca9058616b43"],"deletedImages":["d97eb7f2-10bd-4903-abdd-fee1507ae94e","1897cff0-a8a0-4668-9008-d9d7d2598e2b"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["32b3a387-0353-4fc5-a351-fb790fa0d6bf","926199f3-5c1e-4cd8-a9dd-8d3188e104e4","e016a581-af0e-4382-8597-524bdcd0a3fa","4c3200a7-fc43-44a8-afd0-1aa8ede086a0","305463b7-00e4-45ac-a95a-ca9058616b43"],"imageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b","d97eb7f2-10bd-4903-abdd-fee1507ae94e"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"32b3a387-0353-4fc5-a351-fb790fa0d6bf","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"926199f3-5c1e-4cd8-a9dd-8d3188e104e4","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"e016a581-af0e-4382-8597-524bdcd0a3fa","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["d97eb7f2-10bd-4903-abdd-fee1507ae94e"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"4c3200a7-fc43-44a8-afd0-1aa8ede086a0","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b","d97eb7f2-10bd-4903-abdd-fee1507ae94e"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"305463b7-00e4-45ac-a95a-ca9058616b43","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["1897cff0-a8a0-4668-9008-d9d7d2598e2b"]}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: alpha create alpha-below: {"message":"Agent error: Direct command createContainer is disabled; lifecycle commands must use agentCommand","error":"Bad Gateway","statusCode":502}: expected 502 to be 201 // Object.is equality (root cause: product)

## Backend Rebuild Restart After AgentCommand Dispatch Fix

Prepared: `2026-06-03T15:08:37Z`
Role: devops
Scope: rebuilt `@nyabase/backend` from current source, attempted to restart the local backend tmux pane serving `localhost:3001` from `packages/backend/dist/main.js` with `test/.env`, and collected health evidence. No product source, tests, scripts, configs, lockfiles, deployment files, remote hosts, users/images/containers/grants, agent binaries, or unrelated runtime resources were edited.

Overall classification: `fail-product`

### Build And Dist Evidence

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend build | pass | `pnpm --filter @nyabase/backend build` exited `0`. |
| Stale direct create RPC check | pass | `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist` returned no matches after rebuild. Broader `createContainer` matches remained only as queued `commandKind`, tests, and the gateway lifecycle blocklist entry. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths before and after rebuild/restart attempt. |

### Restart And Health

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend restart | fail-product | Restarted `nyabase:dev.0` with `cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js`; process exited during Nest initialization. |
| Backend auth guard | fail-product | `curl -sS -o /tmp/nyabase-backend-rebuild-auth-me.out -w '%{http_code}' --max-time 8 http://localhost:3001/api/auth/me` returned `000` with connection failure because the rebuilt backend was not listening. |
| Frontend root | pass | `curl -sS -o /tmp/nyabase-backend-rebuild-frontend.out -w '%{http_code}' --max-time 8 http://localhost:5173/` returned `200`. |
| VictoriaMetrics health/query | pass | `/health` returned `200`; `/api/v1/query?query=up` returned `200`. |
| Product CPU/GPU server online state | fail-product | Not verifiable after restart because the rebuilt backend exited before serving the product API. |

### Failure Tail

```text
[Nest] 2552434 - 06/03/2026, 11:08:03 PM ERROR [ExceptionHandler] Nest can't resolve dependencies of the DataDirsService (DataDirectoryEntityRepository, DataDiskEntityRepository, ContainerMountEntityRepository, ?, RemoteFsMountEntityRepository, RemoteFsServerAssignmentEntityRepository, ServersService, UsersService, AuditService, OperationsService). Please make sure that the argument "ContainerRuntimeObservationEntityRepository" at index [3] is available in the DataDirsModule context.

Error: Nest can't resolve dependencies of the DataDirsService (...). Please make sure that the argument "ContainerRuntimeObservationEntityRepository" at index [3] is available in the DataDirsModule context.
    at Injector.lookupComponentInParentModules (.../@nestjs/core/injector/injector.js:262:19)
    at async Injector.resolveComponentInstance (.../@nestjs/core/injector/injector.js:215:33)
    at async resolveParam (.../@nestjs/core/injector/injector.js:129:38)
    at async Promise.all (index 3)
    at async Injector.resolveConstructorParams (.../@nestjs/core/injector/injector.js:144:27)
```

### Commands Run

- `pnpm --filter @nyabase/backend build`
- `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist`
- `tmux send-keys -t nyabase:dev.0 C-c`
- `tmux send-keys -t nyabase:dev.0 'cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js' Enter`
- `curl -sS -o /tmp/nyabase-backend-rebuild-auth-me.out -w '%{http_code}' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-backend-rebuild-frontend.out -w '%{http_code}' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-backend-rebuild-vm-health.out -w '%{http_code}' --max-time 8 http://127.0.0.1:8428/health`
- `curl -sS -o /tmp/nyabase-backend-rebuild-vm-query.out -w '%{http_code}' --max-time 8 'http://127.0.0.1:8428/api/v1/query?query=up'`
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort`

## Backend Rebuild Restart After DataDirsModule DI Fix

Prepared: `2026-06-03T15:12:58Z`
Role: devops
Scope: reran the backend rebuild/restart after developer added `ContainerRuntimeObservationEntity` to `DataDirsModule` `TypeOrmModule.forFeature`; restarted only the local backend tmux pane from `packages/backend/dist/main.js` with `test/.env`; verified local health, product agent online state, VictoriaMetrics, common-src artifact guard, and stale direct create RPC absence. No product source, tests, scripts, configs, lockfiles, deployment files, remote hosts, users/images/containers/grants, agent binaries, or unrelated runtime resources were edited.

Overall classification: `pass`

### Build And Dist Evidence

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend build | pass | `pnpm --filter @nyabase/backend build` exited `0`. |
| DataDirsModule DI fix present in dist | pass | `packages/backend/dist/datadirs/datadirs.module.js` contains `ContainerRuntimeObservationEntity`; `packages/backend/dist/datadirs/datadirs.service.js` injects it at constructor index `3`. |
| Stale direct create RPC check | pass | `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist` returned no matches after rebuild. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths before and after rebuild/restart. |

### Restart And Health

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend restart | pass | `nyabase:dev.0` restarted with `cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js`; logs showed `Nest application successfully started`, `Agent WebSocket gateway ready at /ws/agent`, `Console WebSocket gateway ready at /ws/console`, and `Backend listening on port 3001`. Active PID: `2553061`. |
| Backend auth guard | pass | `curl -sS -o /tmp/nyabase-backend-di-auth-me.out -w '%{http_code}' --max-time 8 http://localhost:3001/api/auth/me` returned `401`. |
| Frontend root | pass | `curl -sS -o /tmp/nyabase-backend-di-frontend.out -w '%{http_code}' --max-time 8 http://localhost:5173/` returned `200`. |
| VictoriaMetrics health/query | pass | `/health` returned `200`; `/api/v1/query?query=up` returned `200`. |
| Product CPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-cpu-batch-20260601T163636Z` id `05cea385-d6ca-490a-a126-e00d0ae23b70`, status `online`, `lastSeenAt=2026-06-03T15:12:47.477Z`; derived `cpu_online=true`. |
| Product GPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-gpu-batch-20260601T163636Z` id `db1112fe-1c55-4314-9511-6d8510c523c2`, status `online`, `lastSeenAt=2026-06-03T15:12:52.243Z`; derived `gpu_online=true`. |
| Agent reconnect logs | pass | Backend logs showed `Hello from nyabase-gpu-batch-20260601T163636Z: aya-1, 4 GPUs`; CPU/GPU `lastSeenAt` advanced after backend restart. Existing `Unknown numericUserId` warnings were observed during state reports and did not prevent online product status. |

### Commands Run

- `pnpm --filter @nyabase/backend build`
- `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist`
- `rg "ContainerRuntimeObservationEntity" packages/backend/dist/datadirs packages/backend/dist/containers`
- `tmux send-keys -t nyabase:dev.0 C-c`
- `tmux send-keys -t nyabase:dev.0 'cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js' Enter`
- `curl -sS -o /tmp/nyabase-backend-di-auth-me.out -w '%{http_code}' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-backend-di-frontend.out -w '%{http_code}' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-backend-di-vm-health.out -w '%{http_code}' --max-time 8 http://127.0.0.1:8428/health`
- `curl -sS -o /tmp/nyabase-backend-di-vm-query.out -w '%{http_code}' --max-time 8 'http://127.0.0.1:8428/api/v1/query?query=up'`
- Admin `POST /api/auth/login` using `ADMIN_INIT_PASSWORD` from `test/.env`, then `GET /api/servers`; raw JWT, refresh token, and password were not recorded.
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort`

## Backend Rebuild Restart After GPU Duplicate-Index Validation Fix

Prepared: `2026-06-03T15:19:09Z`
Role: devops
Scope: rebuilt `@nyabase/backend` from current source after duplicate explicit `gpuIndices` rejection was added, restarted the local backend tmux pane from `packages/backend/dist/main.js` with `test/.env`, verified local health/product server online state, and performed exact-prefix residual scan/cleanup for failed tester run `murtc-20260603t151358z-d62df3`. No product source, tests, scripts, configs, lockfiles, deployment files, agent binaries, or unrelated runtime resources were edited. No broad cleanup was run.

Overall classification: `pass`

### Build And Dist Evidence

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend build | pass | `pnpm --filter @nyabase/backend build` exited `0`. |
| Duplicate GPU index guard in dist | pass | `packages/backend/dist/containers/resource-quota.policy.js` and `packages/backend/dist/containers/containers.service.js` contain `new Set(gpuIndices).size !== gpuIndices.length` and throw `BadRequestException('Duplicate GPU indices requested')`. |
| Stale direct create RPC check | pass | `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist` returned no matches after rebuild. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths before and after rebuild/restart. |

### Restart And Health

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend restart | pass | `nyabase:dev.0` restarted with `cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js`; backend remained running as PID `2555830`. Logs showed CPU agent hello at `2026-06-03 23:17:27 +0800`. |
| Backend auth guard | pass | `curl -sS -o /tmp/nyabase-gpufix-auth-me-final.out -w 'auth=%{http_code}' --max-time 8 http://localhost:3001/api/auth/me` returned `401`. |
| Frontend root | pass | `curl -sS -o /tmp/nyabase-gpufix-frontend-final.out -w 'frontend=%{http_code}' --max-time 8 http://localhost:5173/` returned `200`. |
| VictoriaMetrics health/query | pass | `/health` returned `200`; `/api/v1/query?query=up` returned `200`. |
| Product CPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-cpu-batch-20260601T163636Z` id `05cea385-d6ca-490a-a126-e00d0ae23b70`, status `online`, `lastSeenAt=2026-06-03T15:19:07.512Z`; derived `cpu_online=true`. |
| Product GPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-gpu-batch-20260601T163636Z` id `db1112fe-1c55-4314-9511-6d8510c523c2`, status `online`, `lastSeenAt=2026-06-03T15:19:07.363Z`; derived `gpu_online=true`. |

### Exact-Prefix Residual Scan And Cleanup

Target prefix: `murtc-20260603t151358z-d62df3`

| Surface | Status | Evidence |
| --- | --- | --- |
| Product API containers | pass | Admin `GET /api/containers` returned `200`; exact-prefix matches before cleanup: `0`; deleted: `0`; remaining: `0`. |
| Product API users | pass | Admin `GET /api/users` returned `200`; exact-prefix matches before cleanup: `0`; deleted: `0`; remaining: `0`. |
| Product API images | pass | Admin `GET /api/images` returned `200`; exact-prefix matches before cleanup: `0`; deleted: `0`; remaining: `0`. |
| Product API grants | pass | No exact-prefix users/images were present, so there were no exact-prefix server/image grants to delete through the known fixture cleanup routes. |
| CPU managed Docker/runtime paths/quota | pass | On `root@10.8.96.91`, exact-prefix scans of managed Docker container list, `/data`, `/data/nyabase-docker`, `/run/nyabase-agent`, `/var/lib/nyabase-agent`, `/etc/projects`, `/etc/projid`, and `xfs_quota -x -c "report -p -n" /data` returned no matches. |
| GPU managed Docker/runtime paths/quota | pass | On `lyn@10.8.1.12`, exact-prefix scans of managed Docker container list, `/data0/nbTest`, `/run/nyabase-agent`, `/var/lib/nyabase-agent`, `/etc/projects`, `/etc/projid`, and `xfs_quota -x -c "report -p -n" /data0` returned no matches. |
| Cleanup actions | pass | Nothing matched the exact prefix, so no product/runtime delete commands were issued beyond zero-match product cleanup logic. |

### Runtime Notes

- Backend logs during reconnect included existing state-report warnings for unknown numeric user IDs and a `dataDirReport` SQLite savepoint error: `SqliteError: no such savepoint: typeorm_1`. The backend remained serving, `/api/auth/me` returned `401`, and both CPU/GPU product servers were online afterward. This was recorded as non-blocking for this devops rebuild/restart and exact-prefix cleanup dispatch.
- Admin credentials from `test/.env` were used only in process for API login; raw password, JWT, refresh token, API-token secret, and agent tokens were not recorded.

### Commands Run

- `pnpm --filter @nyabase/backend build`
- `rg "duplicate|gpuIndices|GPU" packages/backend/dist/containers/containers.service.js packages/backend/dist/containers/resource-quota.policy.js`
- `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist`
- `tmux send-keys -t nyabase:dev.0 C-c`
- `tmux send-keys -t nyabase:dev.0 'cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js' Enter`
- `curl -sS -o /tmp/nyabase-gpufix-auth-me-final.out -w 'auth=%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-gpufix-frontend-final.out -w 'frontend=%{http_code}\n' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-gpufix-vm-health-final.out -w 'vm_health=%{http_code}\n' --max-time 8 http://127.0.0.1:8428/health`
- `curl -sS -o /tmp/nyabase-gpufix-vm-query-final.out -w 'vm_query=%{http_code}\n' --max-time 8 'http://127.0.0.1:8428/api/v1/query?query=up'`
- Admin exact-prefix product scan/cleanup script for `/api/containers`, `/api/users`, `/api/images`, and known user grant delete routes, scoped to `murtc-20260603t151358z-d62df3`.
- CPU remote exact-prefix scan: managed Docker `ps -a`, selected host paths, `/etc/projects`, `/etc/projid`, and `xfs_quota` report.
- GPU remote exact-prefix scan: managed Docker `ps -a`, selected host paths, `/etc/projects`, `/etc/projid`, and `xfs_quota` report.
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort`

## Diagnostic Cleanup For Disk Runtime Create Timeout Prefix

Prepared: `2026-06-03T15:34:44Z`
Role: devops
Scope: collected backend tmux logs and exact-prefix product/runtime residual evidence for failed tester prefix `murtc-20260603t152826z-3e786d`; attempted safe exact-prefix cleanup through product API and managed Docker only. No product source, tests, scripts, configs, lockfiles, deployment files, agent binaries, unrelated runtime resources, or database rows were edited. No raw admin password, JWT, refresh token, API-token secret, or agent token was recorded.

Overall classification: `fail-product`

### Key Finding

The failed disk-runtime create left product API-visible exact-prefix container state that is not safely removable through the public container delete API because the target row has empty `spec.dockerId`. During the failure window, backend tmux logs repeatedly showed `QueryFailedError: SqliteError: no such savepoint` while handling agent `operationProgress`, including an outbox worker interval failure. CPU/GPU managed Docker and host/quota scans had no matching runtime residuals, and read-only SQLite checks found no matching durable `containers` table rows, so the remaining residual is product API/read-model state rather than a live Docker resource.

### Backend Log Evidence

Captured from `nyabase:dev.0` to `/tmp/nyabase-murtc-152826-backend-pane.log` with `tmux capture-pane -S -5000`.

| Surface | Status | Evidence |
| --- | --- | --- |
| Exact prefix in pane logs | diagnostic | Grep for `murtc-20260603t152826z-3e786d` and `alpha-disk-runtime` in captured tmux history returned no literal prefix hits. |
| Operation progress handling | fail-product | From approximately `2026-06-03 23:26:53` through `23:31:25` local time, logs repeatedly showed `ERROR [AgentGateway] Error handling message operationProgress from <serverId>: QueryFailedError: SqliteError: no such savepoint: typeorm_N`. |
| Failure-window CPU errors | fail-product | In the target window around `2026-06-03T15:28:26Z` to `15:29:52Z`, CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` repeatedly logged `operationProgress` handling failures with `no such savepoint`, including at local `23:28:29` through `23:29:52`. |
| Outbox worker | fail-product | At local `23:29:59`, backend logged `WARN [AgentCommandOutboxWorkerService] outbox interval failed: SqliteError: no such savepoint: typeorm_181`. |
| Existing observation warnings | diagnostic | The pane also contained repeated `Unknown numericUserId` and `Skipping desired container import ... missing ownerId, name, imageId` warnings from CPU state reports. These were not exact-prefix literal hits but coincide with stale/read-model behavior. |

### Product API Scan And Cleanup

Target prefix: `murtc-20260603t152826z-3e786d`

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend health before cleanup | pass | `GET /api/auth/me` returned `401`; admin login for scan returned `200`; `GET /api/servers` returned `200`. |
| Product API containers before cleanup | fail-product | Admin `GET /api/containers` returned `6` exact-prefix matches. One was `murtc-20260603t152826z-3e786d-alpha-disk-runtime` on CPU with `status=unknown`, `spec.dockerId=""`, `cpuMillis=1`, `memBytes=1048576`, `createdAt=2026-06-03T15:28:52.000Z`. Five additional exact-prefix rows had docker IDs and `status=running`: CPU `alpha-below`, `alpha-exact`, `beta-exact`; GPU `gamma-gpu-granted`, `delta-gpu-granted`. |
| Product API users/images | pass | Admin `GET /api/users` and `GET /api/images` returned `0` exact-prefix matches, so tester cleanup had removed exact-prefix users/images. |
| Product API delete attempts | partial | For the five exact-prefix rows with non-empty docker IDs, `DELETE /api/containers/:serverId/:dockerId` returned `200`. The disk-runtime row with empty docker ID was not deletable through the route shape and was left untouched. |
| Product API containers after cleanup | fail-product | After the delete attempts and another agent report interval, `GET /api/containers` still returned the same `6` exact-prefix matches, including the empty-dockerId disk-runtime row and the five previously delete-requested rows. |
| Operation IDs | diagnostic | Product API did not expose operation IDs for these rows. Read-only SQLite query of `operations`, `operation_steps`, and `agent_command_outbox` by exact prefix/resource ID returned no rows because the exact-prefix items were not present in durable `containers`. |
| Read-only DB check | diagnostic | SQLite `containers` query by exact-prefix name returned no rows. `container_runtime_observations` query by exact-prefix labels returned no rows. This supports API/read-model or in-memory state residual rather than durable DB/runtime residual. |

### Runtime Scan And Cleanup

| Surface | Status | Evidence |
| --- | --- | --- |
| CPU managed Docker | pass | On `root@10.8.96.91`, exact-prefix managed Docker `ps -a` scan returned no matches before cleanup, so no `docker rm` was run. Post-scan also returned no matches. |
| CPU host/quota | pass | Exact-prefix scans of `/data`, `/data/nyabase-docker`, `/run/nyabase-agent`, `/var/lib/nyabase-agent`, `/etc/projects`, `/etc/projid`, and `xfs_quota -x -c "report -p -n" /data` returned no matches. |
| GPU managed Docker | pass | On `lyn@10.8.1.12`, exact-prefix managed Docker `ps -a` scan returned no matches before cleanup, so no `docker rm` was run. Post-scan also returned no matches. |
| GPU host/quota | pass | Exact-prefix scans of `/data0/nbTest`, `/run/nyabase-agent`, `/var/lib/nyabase-agent`, `/etc/projects`, `/etc/projid`, and `xfs_quota -x -c "report -p -n" /data0` returned no matches. |

### Final Health

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend auth guard | pass | `curl ... http://localhost:3001/api/auth/me` returned `401`. |
| Frontend root | pass | `curl ... http://localhost:5173/` returned `200`. |
| VictoriaMetrics health/query | pass | VictoriaMetrics `/health` returned `200`; `/api/v1/query?query=up` returned `200`. |
| Product CPU server online | pass | Admin `GET /api/servers` returned CPU batch `nyabase-cpu-batch-20260601T163636Z` id `05cea385-d6ca-490a-a126-e00d0ae23b70`, status `online`, `lastSeenAt=2026-06-03T15:34:42.863Z`. |
| Product GPU server online | pass | Admin `GET /api/servers` returned GPU batch `nyabase-gpu-batch-20260601T163636Z` id `db1112fe-1c55-4314-9511-6d8510c523c2`, status `online`, `lastSeenAt=2026-06-03T15:34:44.121Z`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

### Commands Run

- `tmux capture-pane -t nyabase:dev.0 -p -S -5000 > /tmp/nyabase-murtc-152826-backend-pane.log`
- `rg -n "murtc-20260603t152826z-3e786d|alpha-disk-runtime|createContainer|outbox|quota|error|ERROR|ack|progress|Unknown numericUserId|operation|Operation" /tmp/nyabase-murtc-152826-backend-pane.log`
- Admin exact-prefix product scan/cleanup script for `/api/containers`, `/api/users`, `/api/images`, and known user grant delete routes, scoped to `murtc-20260603t152826z-3e786d`.
- Read-only SQLite exact-prefix queries against `containers`, `operations`, `operation_steps`, `agent_command_outbox`, and `container_runtime_observations`.
- CPU remote exact-prefix scan: managed Docker `ps -a`, selected host paths, `/etc/projects`, `/etc/projid`, and `xfs_quota` report.
- GPU remote exact-prefix scan: managed Docker `ps -a`, selected host paths, `/etc/projects`, `/etc/projid`, and `xfs_quota` report.
- `curl` checks for backend auth guard, frontend root, VictoriaMetrics health/query.
- Admin `POST /api/auth/login` using `ADMIN_INIT_PASSWORD` from `test/.env`, then `GET /api/servers`; raw JWT, refresh token, and password were not recorded.
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort`

## Backend Rebuild Restart After GPU Count Normalization Fix

Prepared: `2026-06-03T15:25:13Z`
Role: devops
Scope: rebuilt `@nyabase/backend` from current source after GPU count normalization and ambiguous `gpuIndices`/`gpuCount` rejection changes, restarted the local backend tmux pane from `packages/backend/dist/main.js` with `test/.env`, verified local health/product server online state, confirmed rebuilt dist evidence where practical, and performed exact-prefix residual scan/cleanup for failed tester run `murtc-20260603t152020z-1f46a9`. No product source, tests, scripts, configs, lockfiles, deployment files, agent binaries, or unrelated runtime resources were edited. No broad cleanup was run.

Overall classification: `pass`

### Build And Dist Evidence

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend build | pass | `pnpm --filter @nyabase/backend build` exited `0`. |
| GPU count normalization in dist | pass | `packages/backend/dist/containers/resource-quota.policy.js` and `packages/backend/dist/containers/containers.service.js` now derive `explicitGpuIndices` only when `req.gpuIndices.length > 0`, so `gpuIndices: []` no longer masks positive `gpuCount`. Both files compute `requestedGpuCount = explicitGpuIndices?.length ?? req.gpuCount ?? 0`. |
| Ambiguous GPU request guard in dist | pass | Both rebuilt files contain `if (explicitGpuIndices && req.gpuCount && req.gpuCount > 0)` and throw `BadRequestException('Specify either gpuIndices or gpuCount, not both')`. |
| Stale direct create RPC check | pass | `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist` returned no matches after rebuild. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths before and after rebuild/restart. |

### Restart And Health

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend restart | pass | `nyabase:dev.0` restarted with `cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js`; logs showed `Nest application successfully started`, `Backend listening on port 3001`, and both CPU/GPU agents connected. Backend remained running as PID `2558986`. |
| Backend auth guard | pass | `curl -sS -o /tmp/nyabase-gpucount-auth-me-final.out -w 'auth=%{http_code}' --max-time 8 http://localhost:3001/api/auth/me` returned `401`. |
| Frontend root | pass | `curl -sS -o /tmp/nyabase-gpucount-frontend-final.out -w 'frontend=%{http_code}' --max-time 8 http://localhost:5173/` returned `200`. |
| VictoriaMetrics health/query | pass | `/health` returned `200`; `/api/v1/query?query=up` returned `200`. |
| Product CPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-cpu-batch-20260601T163636Z` id `05cea385-d6ca-490a-a126-e00d0ae23b70`, status `online`, `lastSeenAt=2026-06-03T15:24:17.612Z`; derived `cpu_online=true`. |
| Product GPU server online | pass | Admin API login returned `200`; `GET /api/servers` returned `200`; `nyabase-gpu-batch-20260601T163636Z` id `db1112fe-1c55-4314-9511-6d8510c523c2`, status `online`, `lastSeenAt=2026-06-03T15:24:19.067Z`; derived `gpu_online=true`. |

### Exact-Prefix Residual Scan And Cleanup

Target prefix: `murtc-20260603t152020z-1f46a9`

| Surface | Status | Evidence |
| --- | --- | --- |
| Product API containers | pass | Admin `GET /api/containers` returned `200`; exact-prefix matches before cleanup: `0`; deleted: `0`; remaining: `0`. |
| Product API users | pass | Admin `GET /api/users` returned `200`; exact-prefix matches before cleanup: `0`; deleted: `0`; remaining: `0`. |
| Product API images | pass | Admin `GET /api/images` returned `200`; exact-prefix matches before cleanup: `0`; deleted: `0`; remaining: `0`. |
| Product API grants | pass | No exact-prefix users/images were present, so there were no exact-prefix server/image grants to delete through the known fixture cleanup routes. |
| CPU managed Docker/runtime paths/quota | pass | On `root@10.8.96.91`, exact-prefix scans of managed Docker container list, `/data`, `/data/nyabase-docker`, `/run/nyabase-agent`, `/var/lib/nyabase-agent`, `/etc/projects`, `/etc/projid`, and `xfs_quota -x -c "report -p -n" /data` returned no matches. |
| GPU managed Docker/runtime paths/quota | pass | On `lyn@10.8.1.12`, exact-prefix scans of managed Docker container list, `/data0/nbTest`, `/run/nyabase-agent`, `/var/lib/nyabase-agent`, `/etc/projects`, `/etc/projid`, and `xfs_quota -x -c "report -p -n" /data0` returned no matches. |
| Cleanup actions | pass | Nothing matched the exact prefix, so no product/runtime delete commands were issued beyond zero-match product cleanup logic. |

### Runtime Notes

- Backend logs during reconnect included existing state-report warnings for unknown numeric user IDs and desired container imports missing owner/name/image metadata on CPU state reports. The backend remained serving, `/api/auth/me` returned `401`, and both CPU/GPU product servers were online afterward. This was recorded as non-blocking for this devops rebuild/restart and exact-prefix cleanup dispatch.
- Admin credentials from `test/.env` were used only in process for API login; raw password, JWT, refresh token, API-token secret, and agent tokens were not recorded.

### Commands Run

- `pnpm --filter @nyabase/backend build`
- `rg "gpuCount|gpuIndices|ambiguous|Duplicate GPU|Cannot specify|positive" packages/backend/dist/containers/containers.service.js packages/backend/dist/containers/resource-quota.policy.js`
- `rg "agentGateway\\.rpc\\([^\\n]*['\\\"]createContainer['\\\"]" packages/backend/dist`
- `tmux send-keys -t nyabase:dev.0 C-c`
- `tmux send-keys -t nyabase:dev.0 'cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js' Enter`
- `curl -sS -o /tmp/nyabase-gpucount-auth-me-final.out -w 'auth=%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-gpucount-frontend-final.out -w 'frontend=%{http_code}\n' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-gpucount-vm-health-final.out -w 'vm_health=%{http_code}\n' --max-time 8 http://127.0.0.1:8428/health`
- `curl -sS -o /tmp/nyabase-gpucount-vm-query-final.out -w 'vm_query=%{http_code}\n' --max-time 8 'http://127.0.0.1:8428/api/v1/query?query=up'`
- Admin exact-prefix product scan/cleanup script for `/api/containers`, `/api/users`, `/api/images`, and known user grant delete routes, scoped to `murtc-20260603t152020z-1f46a9`.
- CPU remote exact-prefix scan: managed Docker `ps -a`, selected host paths, `/etc/projects`, `/etc/projid`, and `xfs_quota` report.
- GPU remote exact-prefix scan: managed Docker `ps -a`, selected host paths, `/etc/projects`, `/etc/projid`, and `xfs_quota` report.
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort`


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:14:00.091Z`
Run prefix: `murtc-20260603t151358z-d62df3`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t151358z-d62df3`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t151358z-d62df3-alpha | e9497ea2-f5ab-4f28-b433-2e9e31435aca | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["da5167f1-18c0-443b-8756-6ef53dc58950"]}]} |
| beta | murtc-20260603t151358z-d62df3-beta | a52ea7fd-2134-47c6-9f83-97648e263c46 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["da5167f1-18c0-443b-8756-6ef53dc58950"]}]} |
| gamma | murtc-20260603t151358z-d62df3-gamma | 725880ef-1d65-459f-a5b0-34df6d90bae3 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["50f930a1-3266-46ce-9820-40b747dface1"]}]} |
| delta | murtc-20260603t151358z-d62df3-delta | f390c0c7-623e-4503-bb5c-e560e2af48d1 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["da5167f1-18c0-443b-8756-6ef53dc58950"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["50f930a1-3266-46ce-9820-40b747dface1"]}]} |
| epsilon | murtc-20260603t151358z-d62df3-epsilon | 257bb143-7366-41e3-9973-c34d5574ba7b | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["da5167f1-18c0-443b-8756-6ef53dc58950"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t151358z-d62df3-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t151358z-d62df3-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, beta:murtc-20260603t151358z-d62df3-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, gamma:murtc-20260603t151358z-d62df3-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, delta:murtc-20260603t151358z-d62df3-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/
- Deleted containers: delta:murtc-20260603t151358z-d62df3-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, gamma:murtc-20260603t151358z-d62df3-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, beta:murtc-20260603t151358z-d62df3-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t151358z-d62df3-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t151358z-d62df3-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/
- Created users: e9497ea2-f5ab-4f28-b433-2e9e31435aca, a52ea7fd-2134-47c6-9f83-97648e263c46, 725880ef-1d65-459f-a5b0-34df6d90bae3, f390c0c7-623e-4503-bb5c-e560e2af48d1, 257bb143-7366-41e3-9973-c34d5574ba7b
- Deleted users: e9497ea2-f5ab-4f28-b433-2e9e31435aca, a52ea7fd-2134-47c6-9f83-97648e263c46, 725880ef-1d65-459f-a5b0-34df6d90bae3, f390c0c7-623e-4503-bb5c-e560e2af48d1, 257bb143-7366-41e3-9973-c34d5574ba7b
- Created images: da5167f1-18c0-443b-8756-6ef53dc58950, 50f930a1-3266-46ce-9820-40b747dface1
- Deleted images: 50f930a1-3266-46ce-9820-40b747dface1, da5167f1-18c0-443b-8756-6ef53dc58950

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["e9497ea2-f5ab-4f28-b433-2e9e31435aca","a52ea7fd-2134-47c6-9f83-97648e263c46","725880ef-1d65-459f-a5b0-34df6d90bae3","f390c0c7-623e-4503-bb5c-e560e2af48d1","257bb143-7366-41e3-9973-c34d5574ba7b"],"deletedImages":["50f930a1-3266-46ce-9820-40b747dface1","da5167f1-18c0-443b-8756-6ef53dc58950"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["e9497ea2-f5ab-4f28-b433-2e9e31435aca","a52ea7fd-2134-47c6-9f83-97648e263c46","725880ef-1d65-459f-a5b0-34df6d90bae3","f390c0c7-623e-4503-bb5c-e560e2af48d1","257bb143-7366-41e3-9973-c34d5574ba7b"],"imageIds":["da5167f1-18c0-443b-8756-6ef53dc58950","50f930a1-3266-46ce-9820-40b747dface1"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"e9497ea2-f5ab-4f28-b433-2e9e31435aca","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["da5167f1-18c0-443b-8756-6ef53dc58950"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"a52ea7fd-2134-47c6-9f83-97648e263c46","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["da5167f1-18c0-443b-8756-6ef53dc58950"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"725880ef-1d65-459f-a5b0-34df6d90bae3","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["50f930a1-3266-46ce-9820-40b747dface1"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f390c0c7-623e-4503-bb5c-e560e2af48d1","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["50f930a1-3266-46ce-9820-40b747dface1","da5167f1-18c0-443b-8756-6ef53dc58950"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"257bb143-7366-41e3-9973-c34d5574ba7b","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["da5167f1-18c0-443b-8756-6ef53dc58950"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"","exactDockerId":"","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"","exhaustedStatus":400}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: expected [ 400, 401, 403, 404, 409, 422 ] to include 201 (root cause: product)

Minimal reproducer: with gamma user `c2677f4e-0bfa-475d-b907-247af19a50a7`, GPU server `db1112fe-1c55-4314-9511-6d8510c523c2`, and GPU image `02374c64-fdb9-48a4-8d84-e3f1e96edd66`, `POST /api/containers` using gamma's own JWT and body `{ serverId, imageId, name: "murtc-20260603t152020z-1f46a9-gamma-gpu-over-count", cpuMillis: 100, memBytes: 134217728, gpuCount: 2, sshUser: "root", sshUid: 1000, sshPubKeys: [] }` returned `201`; design expected over-count denial because gamma is granted only GPU index `[0]`. The duplicate explicit `gpuIndices: [0, 0]` check no longer failed before this step. Tester cleanup deleted tracked containers/users/images, but this over-count negative-case success was not tracked before assertion. Devops must include exact-prefix `murtc-20260603t152020z-1f46a9` product/API and host/runtime residual scans for B11, especially GPU managed Docker containers, host paths, and XFS project/projid entries.

Minimal reproducer: with gamma user `725880ef-1d65-459f-a5b0-34df6d90bae3`, GPU server `db1112fe-1c55-4314-9511-6d8510c523c2`, and GPU image `50f930a1-3266-46ce-9820-40b747dface1`, `POST /api/containers` using the actor's own JWT and body `{ serverId, imageId, name: "murtc-20260603t151358z-d62df3-gamma-gpu-duplicate", cpuMillis: 100, memBytes: 134217728, gpuIndices: [0, 0], sshUser: "root", sshUid: 1000, sshPubKeys: [] }` returned `201`; design expected duplicate GPU index denial with no runtime mutation. Tester cleanup deleted tracked containers/users/images, but this negative-case success was not tracked before assertion. Devops must include exact-prefix `murtc-20260603t151358z-d62df3` product and host/runtime residual scans for B11, especially managed Docker containers and quota/project entries on the GPU host.


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:20:22.030Z`
Run prefix: `murtc-20260603t152020z-1f46a9`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t152020z-1f46a9`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t152020z-1f46a9-alpha | 58d6c358-f0c9-4592-b030-70598cec5c74 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e"]}]} |
| beta | murtc-20260603t152020z-1f46a9-beta | 94f41ad4-cc93-4384-a7e6-1372a5c596c1 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e"]}]} |
| gamma | murtc-20260603t152020z-1f46a9-gamma | c2677f4e-0bfa-475d-b907-247af19a50a7 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["02374c64-fdb9-48a4-8d84-e3f1e96edd66"]}]} |
| delta | murtc-20260603t152020z-1f46a9-delta | 97f3aa4d-5acf-4d20-9850-cfee4d064ef7 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["02374c64-fdb9-48a4-8d84-e3f1e96edd66"]}]} |
| epsilon | murtc-20260603t152020z-1f46a9-epsilon | f78c2eb6-201f-4e56-bbf7-345f3f10f337 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t152020z-1f46a9-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152020z-1f46a9-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, beta:murtc-20260603t152020z-1f46a9-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, gamma:murtc-20260603t152020z-1f46a9-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, delta:murtc-20260603t152020z-1f46a9-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/
- Deleted containers: delta:murtc-20260603t152020z-1f46a9-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, gamma:murtc-20260603t152020z-1f46a9-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, beta:murtc-20260603t152020z-1f46a9-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152020z-1f46a9-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152020z-1f46a9-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/
- Created users: 58d6c358-f0c9-4592-b030-70598cec5c74, 94f41ad4-cc93-4384-a7e6-1372a5c596c1, c2677f4e-0bfa-475d-b907-247af19a50a7, 97f3aa4d-5acf-4d20-9850-cfee4d064ef7, f78c2eb6-201f-4e56-bbf7-345f3f10f337
- Deleted users: 58d6c358-f0c9-4592-b030-70598cec5c74, 94f41ad4-cc93-4384-a7e6-1372a5c596c1, c2677f4e-0bfa-475d-b907-247af19a50a7, 97f3aa4d-5acf-4d20-9850-cfee4d064ef7, f78c2eb6-201f-4e56-bbf7-345f3f10f337
- Created images: 068f531c-605e-4408-b20f-6ef3f1dd609e, 02374c64-fdb9-48a4-8d84-e3f1e96edd66
- Deleted images: 02374c64-fdb9-48a4-8d84-e3f1e96edd66, 068f531c-605e-4408-b20f-6ef3f1dd609e

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["58d6c358-f0c9-4592-b030-70598cec5c74","94f41ad4-cc93-4384-a7e6-1372a5c596c1","c2677f4e-0bfa-475d-b907-247af19a50a7","97f3aa4d-5acf-4d20-9850-cfee4d064ef7","f78c2eb6-201f-4e56-bbf7-345f3f10f337"],"deletedImages":["02374c64-fdb9-48a4-8d84-e3f1e96edd66","068f531c-605e-4408-b20f-6ef3f1dd609e"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["58d6c358-f0c9-4592-b030-70598cec5c74","94f41ad4-cc93-4384-a7e6-1372a5c596c1","c2677f4e-0bfa-475d-b907-247af19a50a7","97f3aa4d-5acf-4d20-9850-cfee4d064ef7","f78c2eb6-201f-4e56-bbf7-345f3f10f337"],"imageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e","02374c64-fdb9-48a4-8d84-e3f1e96edd66"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"58d6c358-f0c9-4592-b030-70598cec5c74","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"94f41ad4-cc93-4384-a7e6-1372a5c596c1","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"c2677f4e-0bfa-475d-b907-247af19a50a7","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["02374c64-fdb9-48a4-8d84-e3f1e96edd66"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"97f3aa4d-5acf-4d20-9850-cfee4d064ef7","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["02374c64-fdb9-48a4-8d84-e3f1e96edd66","068f531c-605e-4408-b20f-6ef3f1dd609e"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f78c2eb6-201f-4e56-bbf7-345f3f10f337","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["068f531c-605e-4408-b20f-6ef3f1dd609e"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"","exactDockerId":"","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"","exhaustedStatus":400}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: expected [ 400, 401, 403, 404, 409, 422 ] to include 201 (root cause: product)


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:26:22.419Z`
Run prefix: `murtc-20260603t152621z-85f660`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t152621z-85f660`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t152621z-85f660-alpha | 7204819d-9501-477e-86f6-5c5fa64d01d0 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91"]}]} |
| beta | murtc-20260603t152621z-85f660-beta | b3995323-072a-4ba9-a5df-cab6db04079d | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91"]}]} |
| gamma | murtc-20260603t152621z-85f660-gamma | ab4035fb-0ea6-451b-97a7-893a5c0ae0ff | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["771fa532-e18f-4d12-b622-768902ab7503"]}]} |
| delta | murtc-20260603t152621z-85f660-delta | 3ce9866c-a258-47ff-bdfe-7fe8c5e4ae49 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["771fa532-e18f-4d12-b622-768902ab7503"]}]} |
| epsilon | murtc-20260603t152621z-85f660-epsilon | 4fd7b711-1117-4e0d-8231-f747266c6e65 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t152621z-85f660-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152621z-85f660-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, beta:murtc-20260603t152621z-85f660-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, gamma:murtc-20260603t152621z-85f660-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, delta:murtc-20260603t152621z-85f660-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/
- Deleted containers: delta:murtc-20260603t152621z-85f660-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, gamma:murtc-20260603t152621z-85f660-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, beta:murtc-20260603t152621z-85f660-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152621z-85f660-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152621z-85f660-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/
- Created users: 7204819d-9501-477e-86f6-5c5fa64d01d0, b3995323-072a-4ba9-a5df-cab6db04079d, ab4035fb-0ea6-451b-97a7-893a5c0ae0ff, 3ce9866c-a258-47ff-bdfe-7fe8c5e4ae49, 4fd7b711-1117-4e0d-8231-f747266c6e65
- Deleted users: 7204819d-9501-477e-86f6-5c5fa64d01d0, b3995323-072a-4ba9-a5df-cab6db04079d, ab4035fb-0ea6-451b-97a7-893a5c0ae0ff, 3ce9866c-a258-47ff-bdfe-7fe8c5e4ae49, 4fd7b711-1117-4e0d-8231-f747266c6e65
- Created images: 106848ce-283c-42f1-9dc1-d1c7950a1b91, 771fa532-e18f-4d12-b622-768902ab7503
- Deleted images: 771fa532-e18f-4d12-b622-768902ab7503, 106848ce-283c-42f1-9dc1-d1c7950a1b91

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["7204819d-9501-477e-86f6-5c5fa64d01d0","b3995323-072a-4ba9-a5df-cab6db04079d","ab4035fb-0ea6-451b-97a7-893a5c0ae0ff","3ce9866c-a258-47ff-bdfe-7fe8c5e4ae49","4fd7b711-1117-4e0d-8231-f747266c6e65"],"deletedImages":["771fa532-e18f-4d12-b622-768902ab7503","106848ce-283c-42f1-9dc1-d1c7950a1b91"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["7204819d-9501-477e-86f6-5c5fa64d01d0","b3995323-072a-4ba9-a5df-cab6db04079d","ab4035fb-0ea6-451b-97a7-893a5c0ae0ff","3ce9866c-a258-47ff-bdfe-7fe8c5e4ae49","4fd7b711-1117-4e0d-8231-f747266c6e65"],"imageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91","771fa532-e18f-4d12-b622-768902ab7503"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"7204819d-9501-477e-86f6-5c5fa64d01d0","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"b3995323-072a-4ba9-a5df-cab6db04079d","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"ab4035fb-0ea6-451b-97a7-893a5c0ae0ff","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["771fa532-e18f-4d12-b622-768902ab7503"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"3ce9866c-a258-47ff-bdfe-7fe8c5e4ae49","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91","771fa532-e18f-4d12-b622-768902ab7503"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"4fd7b711-1117-4e0d-8231-f747266c6e65","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["106848ce-283c-42f1-9dc1-d1c7950a1b91"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"","exactDockerId":"","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"","deltaDockerId":"","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: alpha create alpha-disk-runtime: {"message":"CPU quota exceeded","error":"Bad Request","statusCode":400}: expected 400 to be 201 // Object.is equality (root cause: product)


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:26:48.821Z`
Run prefix: `murtc-20260603t152647z-3c96f7`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t152647z-3c96f7`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t152647z-3c96f7-alpha | 9b93cdc1-d988-4f94-9fc8-df7fd3087e52 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0"]}]} |
| beta | murtc-20260603t152647z-3c96f7-beta | b6ed0e5c-0047-4400-92b2-9dbf576c2d5f | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0"]}]} |
| gamma | murtc-20260603t152647z-3c96f7-gamma | 00b84a51-d9ab-43ad-8157-a7e123be2d3b | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["7d35aae5-821d-4307-a9ef-a9621c0f11d3"]}]} |
| delta | murtc-20260603t152647z-3c96f7-delta | 3a25dbe2-0235-47fb-a13e-5028f81585f2 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["7d35aae5-821d-4307-a9ef-a9621c0f11d3"]}]} |
| epsilon | murtc-20260603t152647z-3c96f7-epsilon | 36ed9696-7039-4a47-9a64-9f039480e9ff | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t152647z-3c96f7-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152647z-3c96f7-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, beta:murtc-20260603t152647z-3c96f7-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, gamma:murtc-20260603t152647z-3c96f7-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, delta:murtc-20260603t152647z-3c96f7-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, epsilon:murtc-20260603t152647z-3c96f7-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/
- Deleted containers: epsilon:murtc-20260603t152647z-3c96f7-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/, delta:murtc-20260603t152647z-3c96f7-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, gamma:murtc-20260603t152647z-3c96f7-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/, beta:murtc-20260603t152647z-3c96f7-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152647z-3c96f7-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/, alpha:murtc-20260603t152647z-3c96f7-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/
- Created users: 9b93cdc1-d988-4f94-9fc8-df7fd3087e52, b6ed0e5c-0047-4400-92b2-9dbf576c2d5f, 00b84a51-d9ab-43ad-8157-a7e123be2d3b, 3a25dbe2-0235-47fb-a13e-5028f81585f2, 36ed9696-7039-4a47-9a64-9f039480e9ff
- Deleted users: 9b93cdc1-d988-4f94-9fc8-df7fd3087e52, b6ed0e5c-0047-4400-92b2-9dbf576c2d5f, 00b84a51-d9ab-43ad-8157-a7e123be2d3b, 3a25dbe2-0235-47fb-a13e-5028f81585f2, 36ed9696-7039-4a47-9a64-9f039480e9ff
- Created images: 4ddba72f-440c-4ada-a33d-d23b7eee61d0, 7d35aae5-821d-4307-a9ef-a9621c0f11d3
- Deleted images: 7d35aae5-821d-4307-a9ef-a9621c0f11d3, 4ddba72f-440c-4ada-a33d-d23b7eee61d0

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["9b93cdc1-d988-4f94-9fc8-df7fd3087e52","b6ed0e5c-0047-4400-92b2-9dbf576c2d5f","00b84a51-d9ab-43ad-8157-a7e123be2d3b","3a25dbe2-0235-47fb-a13e-5028f81585f2","36ed9696-7039-4a47-9a64-9f039480e9ff"],"deletedImages":["7d35aae5-821d-4307-a9ef-a9621c0f11d3","4ddba72f-440c-4ada-a33d-d23b7eee61d0"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["9b93cdc1-d988-4f94-9fc8-df7fd3087e52","b6ed0e5c-0047-4400-92b2-9dbf576c2d5f","00b84a51-d9ab-43ad-8157-a7e123be2d3b","3a25dbe2-0235-47fb-a13e-5028f81585f2","36ed9696-7039-4a47-9a64-9f039480e9ff"],"imageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0","7d35aae5-821d-4307-a9ef-a9621c0f11d3"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"9b93cdc1-d988-4f94-9fc8-df7fd3087e52","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"b6ed0e5c-0047-4400-92b2-9dbf576c2d5f","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"00b84a51-d9ab-43ad-8157-a7e123be2d3b","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["7d35aae5-821d-4307-a9ef-a9621c0f11d3"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"3a25dbe2-0235-47fb-a13e-5028f81585f2","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0","7d35aae5-821d-4307-a9ef-a9621c0f11d3"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"36ed9696-7039-4a47-9a64-9f039480e9ff","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4ddba72f-440c-4ada-a33d-d23b7eee61d0"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"","exactDockerId":"","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"","deltaDockerId":"","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: expected [ 200, 201 ] to include 404 (root cause: test)

Rerun diagnosis: after the epsilon disk-proof sequencing fix, the test created `murtc-20260603t152647z-3c96f7-alpha-disk-runtime` under epsilon and recorded it for cleanup, but `waitForContainerByName()` accepted the visible product row before `spec.dockerId` was populated. The subsequent exec request used an empty docker id, producing `404`. This is a continuation test wait-condition bug, not a product finding. Exact cleanup recorded by the test: tracked containers deleted, users deleted, images deleted. Devops should still include exact-prefix `murtc-20260603t152647z-3c96f7` in B11 host-level residual scans because live runtime was touched before the test failure.


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:29:52.644Z`
Run prefix: `murtc-20260603t152826z-3e786d`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t152826z-3e786d`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t152826z-3e786d-alpha | 15e15f3c-23a9-41ee-8732-03161f63a88b | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}]} |
| beta | murtc-20260603t152826z-3e786d-beta | 128a7186-c698-4a2b-97a8-1495c5464cc2 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}]} |
| gamma | murtc-20260603t152826z-3e786d-gamma | 5c74dc1b-3f7a-431d-bb12-43e915b2b57e | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["9549dd12-29ec-4541-8a10-5f4f7bf6e16e"]}]} |
| delta | murtc-20260603t152826z-3e786d-delta | 37a82768-7b3d-44a2-9bfc-ed333cf0c763 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["9549dd12-29ec-4541-8a10-5f4f7bf6e16e"]}]} |
| epsilon | murtc-20260603t152826z-3e786d-epsilon | 5dd73bb5-14dc-4870-a14f-287991c9a4d7 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t152826z-3e786d-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/a2da0dd92b90, alpha:murtc-20260603t152826z-3e786d-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/a3100f28d4f3, beta:murtc-20260603t152826z-3e786d-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/9038e3145842, gamma:murtc-20260603t152826z-3e786d-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/c1279ceee06e, delta:murtc-20260603t152826z-3e786d-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/d2a847cda62c
- Deleted containers: delta:murtc-20260603t152826z-3e786d-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/d2a847cda62c, gamma:murtc-20260603t152826z-3e786d-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/c1279ceee06e, beta:murtc-20260603t152826z-3e786d-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/9038e3145842, alpha:murtc-20260603t152826z-3e786d-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/a3100f28d4f3, alpha:murtc-20260603t152826z-3e786d-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/a2da0dd92b90
- Created users: 15e15f3c-23a9-41ee-8732-03161f63a88b, 128a7186-c698-4a2b-97a8-1495c5464cc2, 5c74dc1b-3f7a-431d-bb12-43e915b2b57e, 37a82768-7b3d-44a2-9bfc-ed333cf0c763, 5dd73bb5-14dc-4870-a14f-287991c9a4d7
- Deleted users: 15e15f3c-23a9-41ee-8732-03161f63a88b, 128a7186-c698-4a2b-97a8-1495c5464cc2, 5c74dc1b-3f7a-431d-bb12-43e915b2b57e, 37a82768-7b3d-44a2-9bfc-ed333cf0c763, 5dd73bb5-14dc-4870-a14f-287991c9a4d7
- Created images: e6901e1a-1a2d-4760-9f77-fe7da69ba83a, 9549dd12-29ec-4541-8a10-5f4f7bf6e16e
- Deleted images: 9549dd12-29ec-4541-8a10-5f4f7bf6e16e, e6901e1a-1a2d-4760-9f77-fe7da69ba83a

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["15e15f3c-23a9-41ee-8732-03161f63a88b","128a7186-c698-4a2b-97a8-1495c5464cc2","5c74dc1b-3f7a-431d-bb12-43e915b2b57e","37a82768-7b3d-44a2-9bfc-ed333cf0c763","5dd73bb5-14dc-4870-a14f-287991c9a4d7"],"deletedImages":["9549dd12-29ec-4541-8a10-5f4f7bf6e16e","e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["15e15f3c-23a9-41ee-8732-03161f63a88b","128a7186-c698-4a2b-97a8-1495c5464cc2","5c74dc1b-3f7a-431d-bb12-43e915b2b57e","37a82768-7b3d-44a2-9bfc-ed333cf0c763","5dd73bb5-14dc-4870-a14f-287991c9a4d7"],"imageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a","9549dd12-29ec-4541-8a10-5f4f7bf6e16e"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"15e15f3c-23a9-41ee-8732-03161f63a88b","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"128a7186-c698-4a2b-97a8-1495c5464cc2","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"5c74dc1b-3f7a-431d-bb12-43e915b2b57e","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["9549dd12-29ec-4541-8a10-5f4f7bf6e16e"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"37a82768-7b3d-44a2-9bfc-ed333cf0c763","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["9549dd12-29ec-4541-8a10-5f4f7bf6e16e","e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"5dd73bb5-14dc-4870-a14f-287991c9a4d7","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["e6901e1a-1a2d-4760-9f77-fe7da69ba83a"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"a2da0dd92b90","exactDockerId":"a3100f28d4f3","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"9038e3145842","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"c1279ceee06e","deltaDockerId":"d2a847cda62c","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: Error: timed out waiting for murtc-20260603t152826z-3e786d-alpha-disk-runtime (root cause: product)

Minimal reproducer: after CPU/memory and GPU quota cases passed, epsilon user `5dd73bb5-14dc-4870-a14f-287991c9a4d7` with CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` and CPU image `e6901e1a-1a2d-4760-9f77-fe7da69ba83a` issued `POST /api/containers` for `murtc-20260603t152826z-3e786d-alpha-disk-runtime` with `{ serverId, imageId, cpuMillis: 1, memBytes: 1048576, gpuIndices: [], sshUser: "root", sshUid: 1000, sshPubKeys: [] }`. The create call returned `201`, but repeated `GET /api/containers?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70&ownOnly=true` with epsilon's JWT did not show a matching container with non-empty `spec.dockerId` and non-creating/non-deleting state within 60s. Tester cleanup deleted all tracked containers/users/images, but this disk-runtime row was not tracked because it never reached a populated docker id. Devops must include exact-prefix `murtc-20260603t152826z-3e786d` product/API and host/runtime residual scans for B11, especially CPU managed Docker containers, product rows with empty docker id, host paths, and XFS project/projid entries.

## DevOps Backend Rebuild/Restart After Serialized Transaction Fix

Timestamp: `2026-06-03T15:45:06Z`

Command: backend rebuild/restart after serialized transaction fix
Exit code: 0
Backend typecheck/build: pass
Backend health: pass
Common-src artifact guard: pass
Frontend visual: skipped
Failing output (tail): none
Status: GREEN

### Command Outcomes

- `pnpm --filter @nyabase/common build && pnpm --filter @nyabase/backend build`: exit `0`.
- Previous backend listener before restart: PID `2558986`, command `node -r tsconfig-paths/register dist/main.js`, listening on `*:3001`.
- Restart command: stopped PID `2558986`, then launched rebuilt backend from `packages/backend` with `PORT=3001 NODE_ENV=development node -r tsconfig-paths/register dist/main.js`.
- Final backend PID/session/log source: PID `2568160`, session id `2568160`, process state `Ssl`, listener `*:3001`, log `/tmp/nyabase-backend-serialized-transaction-20260603T154416Z-setsid.log`.
- Rebuilt-output evidence: `packages/backend/dist/database/serialized-transaction.js` exists and changed backend dist files import/use `runSerializedTransaction` in operation outbox, operation orchestrator, resource lock, reconcile worker, runtime observation writer, container mounts, operations service, and users service.
- Health/auth guard: `curl http://localhost:3001/api/auth/me` returned `401` on three unauthenticated probes, which is expected and proves the backend route/auth guard is reachable.
- Startup/idle log scan: `rg -i 'no such savepoint|Nest cannot resolve dependencies|UnknownDependenciesException|ExceptionHandler|SqliteError' /tmp/nyabase-backend-serialized-transaction-20260603T154416Z-setsid.log` returned no matches after restart and idle health checks.
- Common-src artifact guard: `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort | wc -l` returned `0`.
- Frontend visual: skipped; backend-only rebuild/restart dispatch, no frontend rendered output changed.

Note: an initial non-detached `nohup` launch reached `Backend listening on port 3001` but exited when the command-runner shell ended and left no backend error tail. The final `setsid` launch survived the shell exit and remained the active listener for the health checks above.


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:46:30.298Z`
Run prefix: `murtc-20260603t154630z-8531e6`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t154630z-8531e6`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a |

### Created / Deleted Runtime IDs

- Created containers: none
- Deleted containers: none
- Created users: none
- Deleted users: none
- Created images: none
- Deleted images: none

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"not-started"}`

### Step Evidence



### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: expected online CPU server: expected undefined to be truthy (root cause: product)

Minimal reproducer: immediately after admin login from `test/.env`, the test called `GET /api/servers` and selected `servers.find((server) => server.status === "online" && !server.isGpuServer)`. The result was `undefined`, so no exact-prefix users/images/containers were created for run prefix `murtc-20260603t154630z-8531e6`. This contradicts the pre-dispatch GREEN note that the product API reported the CPU batch server online and should be treated as a product/API state or server DTO/status regression until devops confirms otherwise. Backend log check for this rerun: `grep -n "no such savepoint: typeorm_" /tmp/nyabase-backend-serialized-transaction-20260603T154416Z-setsid.log | tail -n 20` returned no matches. B11 residual list still includes prior prefixes needing or already receiving host-level scans: `murtc-20260603t152826z-3e786d` and earlier failed continuation prefixes recorded above; current prefix `murtc-20260603t154630z-8531e6` created no resources.

## DevOps Agent/Server Online-State Restoration

Timestamp: `2026-06-03T15:50:00Z`

Command: agent/server online-state restoration after backend restart
Exit code: 0
Backend health: pass
CPU agent/product online: pass
GPU agent/product online: pass
Common-src artifact guard: pass
Frontend visual: skipped
Failing output (tail): none
Status: GREEN

### Command Outcomes

- Initial finding: backend PID `2568160` was listening on `*:3001`, but its process environment did not include `DB_PATH`; because it was started from `packages/backend`, it used `packages/backend/nyabase.db`. Admin `GET /api/servers` returned only one unrelated historical server row, so agents for the intended CPU/GPU IDs were rejected or absent from that API result.
- CPU host `root@10.8.96.91`: `nyabase-agent` and `nyabase-docker.service` were already `active`; `/etc/nyabase/agent.yaml` had `serverId=05cea385-d6ca-490a-a126-e00d0ae23b70`. Journal showed repeated backend WebSocket connects followed by `4003 Invalid token`, consistent with the backend using the wrong DB. CPU agent service was not restarted.
- GPU host `lyn@10.8.1.12`: `nyabase-agent` and `nyabase-docker.service` were already `active`; `/etc/nyabase/agent.yaml` had `serverId=db1112fe-1c55-4314-9511-6d8510c523c2`. GPU agent service was not restarted.
- Restoration action: stopped backend PID `2568160` and restarted only the backend from `packages/backend` with env loaded from `test/.env`; new PID `2570305`, log `/tmp/nyabase-backend-online-restore-20260603T155000Z.log`.
- Backend health: `curl http://localhost:3001/api/auth/me` returned `401`, expected for unauthenticated access and proving the backend route/auth guard is reachable.
- Backend log: startup reached `Nest application successfully started` and `Backend listening on port 3001`; log showed both agent connections for `nyabase-cpu-batch-20260601T163636Z` and `nyabase-gpu-batch-20260601T163636Z`. Grep for `no such savepoint: typeorm_`, DI startup failures, `UnknownDependenciesException`, and `ExceptionHandler` returned no matches.
- Product API verification: admin `GET /api/servers` reported CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` as `online` with `lastSeenAt=2026-06-03T15:49:58.112Z`, and GPU server `db1112fe-1c55-4314-9511-6d8510c523c2` as `online` with `lastSeenAt=2026-06-03T15:49:58.070Z`.
- Common-src artifact guard: `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort` returned no files.


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T15:52:48.654Z`
Run prefix: `murtc-20260603t155125z-4c16fc`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t155125z-4c16fc`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t155125z-4c16fc-alpha | f084a32e-ec5d-489b-a2b3-a0e5822b3478 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]}]} |
| beta | murtc-20260603t155125z-4c16fc-beta | 18a4f9b6-bb5e-44ec-99bc-a1d3f10e66e2 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]}]} |
| gamma | murtc-20260603t155125z-4c16fc-gamma | 409f3b26-4ef0-414f-845f-e7c32e543da8 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["1ff7ef09-b050-4327-b0b8-f814378fe32a"]}]} |
| delta | murtc-20260603t155125z-4c16fc-delta | 136b9f63-9f34-4707-b161-c76d37b7b43b | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["1ff7ef09-b050-4327-b0b8-f814378fe32a"]}]} |
| epsilon | murtc-20260603t155125z-4c16fc-epsilon | e7d6eba5-53ca-46b4-adc9-4b9f334564d1 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t155125z-4c16fc-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/01fba7b163cf, alpha:murtc-20260603t155125z-4c16fc-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/7b4fe9a28238, beta:murtc-20260603t155125z-4c16fc-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/78f782c57f85, gamma:murtc-20260603t155125z-4c16fc-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/f2b1075579f2, delta:murtc-20260603t155125z-4c16fc-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/5d6dd58ba43a
- Deleted containers: delta:murtc-20260603t155125z-4c16fc-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/5d6dd58ba43a, gamma:murtc-20260603t155125z-4c16fc-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/f2b1075579f2, beta:murtc-20260603t155125z-4c16fc-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/78f782c57f85, alpha:murtc-20260603t155125z-4c16fc-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/7b4fe9a28238, alpha:murtc-20260603t155125z-4c16fc-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/01fba7b163cf
- Created users: f084a32e-ec5d-489b-a2b3-a0e5822b3478, 18a4f9b6-bb5e-44ec-99bc-a1d3f10e66e2, 409f3b26-4ef0-414f-845f-e7c32e543da8, 136b9f63-9f34-4707-b161-c76d37b7b43b, e7d6eba5-53ca-46b4-adc9-4b9f334564d1
- Deleted users: f084a32e-ec5d-489b-a2b3-a0e5822b3478, 18a4f9b6-bb5e-44ec-99bc-a1d3f10e66e2, 409f3b26-4ef0-414f-845f-e7c32e543da8, 136b9f63-9f34-4707-b161-c76d37b7b43b, e7d6eba5-53ca-46b4-adc9-4b9f334564d1
- Created images: 1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a, 1ff7ef09-b050-4327-b0b8-f814378fe32a
- Deleted images: 1ff7ef09-b050-4327-b0b8-f814378fe32a, 1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["f084a32e-ec5d-489b-a2b3-a0e5822b3478","18a4f9b6-bb5e-44ec-99bc-a1d3f10e66e2","409f3b26-4ef0-414f-845f-e7c32e543da8","136b9f63-9f34-4707-b161-c76d37b7b43b","e7d6eba5-53ca-46b4-adc9-4b9f334564d1"],"deletedImages":["1ff7ef09-b050-4327-b0b8-f814378fe32a","1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["f084a32e-ec5d-489b-a2b3-a0e5822b3478","18a4f9b6-bb5e-44ec-99bc-a1d3f10e66e2","409f3b26-4ef0-414f-845f-e7c32e543da8","136b9f63-9f34-4707-b161-c76d37b7b43b","e7d6eba5-53ca-46b4-adc9-4b9f334564d1"],"imageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a","1ff7ef09-b050-4327-b0b8-f814378fe32a"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f084a32e-ec5d-489b-a2b3-a0e5822b3478","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"18a4f9b6-bb5e-44ec-99bc-a1d3f10e66e2","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"409f3b26-4ef0-414f-845f-e7c32e543da8","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["1ff7ef09-b050-4327-b0b8-f814378fe32a"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"136b9f63-9f34-4707-b161-c76d37b7b43b","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a","1ff7ef09-b050-4327-b0b8-f814378fe32a"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"e7d6eba5-53ca-46b4-adc9-4b9f334564d1","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"01fba7b163cf","exactDockerId":"7b4fe9a28238","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"78f782c57f85","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"f2b1075579f2","deltaDockerId":"5d6dd58ba43a","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: Error: timed out waiting for murtc-20260603t155125z-4c16fc-alpha-disk-runtime (root cause: product)

Minimal reproducer: after fresh five-user setup and successful CPU/memory plus GPU quota boundary checks, epsilon user `e7d6eba5-53ca-46b4-adc9-4b9f334564d1` with CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` and CPU image `1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a` issued `POST /api/containers` for `murtc-20260603t155125z-4c16fc-alpha-disk-runtime` with `{ serverId, imageId, cpuMillis: 1, memBytes: 1048576, gpuIndices: [], sshUser: "root", sshUid: 1000, sshPubKeys: [] }`. The create call returned `201`, but repeated `GET /api/containers?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70&ownOnly=true` with epsilon's JWT did not show a matching container with non-empty `spec.dockerId` and non-creating/non-deleting state within 60s. Tester cleanup deleted tracked containers/users/images, but this disk-runtime row was not tracked because it never reached a populated docker id. Backend log check for this rerun: `grep -n "no such savepoint: typeorm_" /tmp/nyabase-backend-online-restore-20260603T155000Z.log | tail -n 20` returned no matches. Devops must include exact-prefix `murtc-20260603t155125z-4c16fc` product/API and host/runtime residual scans for B11, especially CPU managed Docker containers, product rows with empty docker id, host paths, and XFS project/projid entries. Prior failed prefix `murtc-20260603t152826z-3e786d` remains on the B11 residual list unless already scanned.

## DevOps Diagnostic / Residual Cleanup For `murtc-20260603t155125z-4c16fc`

Prepared: `2026-06-03T15:58:00Z`
Role: devops
Command: diagnostic/cleanup for `murtc-20260603t155125z-4c16fc`
Exit code: `0`
Classification: `pass-diagnostic-cleanup`
Visual artifacts: n/a; frontend visual skipped.

Scope: exact-prefix backend log/API/SQLite/host scan for why `murtc-20260603t155125z-4c16fc-alpha-disk-runtime` returned `201` but never converged to a non-empty docker id. Used admin credentials from `test/.env` only in process; no raw password, JWT, refresh token, API-token secret, user password, private key, or agent token is recorded. Did not run the focused Vitest suite. Did not edit product source, tests, scripts, configs, lockfiles, or runtime files outside exact-prefix cleanup.

### Backend Log Diagnosis

- Backend PID/log: `2570305`, `/tmp/nyabase-backend-online-restore-20260603T155000Z.log`; backend env showed `DB_DRIVER=sqlite`, `DB_PATH=/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`.
- `rg -c 'murtc-20260603t155125z-4c16fc' /tmp/nyabase-backend-online-restore-20260603T155000Z.log` returned `0`: this backend log does not print exact container names, operation IDs, outbox sends, or the Docker create error for the prefix.
- The log window around `2026-06-03T15:51:25Z` contains background state-report warnings, not exact-prefix operation logs:
  - `23:51:29` local / `15:51:29Z`: GPU state reports had unknown numeric users `12` and `13`.
  - `23:51:30` local / `15:51:30Z`: repeated `ContainerRuntimeObservationWriter` warnings for GPU server `db1112fe-1c55-4314-9511-6d8510c523c2`: `Skipping desired container import ... missing ownerId, name, imageId`.
  - `23:51:50` local / `15:51:50Z`: CPU state report warnings for unknown numeric users `10`, `11`, and `13`, followed by `Failed to persist stateReport observations for 05cea385-d6ca-490a-a126-e00d0ae23b70: QueryFailedError: SqliteError: UNIQUE constraint failed: data_disk_runtime_observations.serverId, data_disk_runtime_observations.diskId, data_disk_runtime_observations.reportSeq`.
- The missing docker id root cause was recovered from durable operation/outbox rows: Docker rejected the create with `(HTTP code 400) bad parameter - Minimum memory limit allowed is 6MB`. The failing request had `memBytes=1048576` and `cpuMillis=1`.
- `rg -c 'no such savepoint: typeorm_' /tmp/nyabase-backend-online-restore-20260603T155000Z.log` returned `0`; no savepoint regression was observed for this run.

### Product/API Residuals

Initial admin API scan before devops cleanup:

- `GET /api/containers` returned six exact-prefix entries.
- Five were already logically deleted from tester cleanup:
  - CPU: `alpha-below` docker `01fba7b163cf`, `alpha-exact` docker `7b4fe9a28238`, `beta-exact` docker `78f782c57f85`.
  - GPU: `gamma-gpu-granted` docker `f2b1075579f2`, `delta-gpu-granted` docker `5d6dd58ba43a`.
- One row remained undeleted and unusable: `murtc-20260603t155125z-4c16fc-alpha-disk-runtime`, CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70`, owner `e7d6eba5-53ca-46b4-adc9-4b9f334564d1`, image `1a2f6c70-cbe5-43ec-bf16-2e774bdfe61a`, `spec.dockerId=""`, status `unknown`, lifecycle phase `failed`, operation `364e7635-aa35-441c-8a87-a546dea67bad` status `failed`, last error `(HTTP code 400) bad parameter - Minimum memory limit allowed is 6MB`.
- `GET /api/users` and `GET /api/images` had zero exact-prefix matches before devops cleanup; tester cleanup had already deleted the five users and two images.
- The normal product delete route is keyed by `DELETE /api/containers/:serverId/:dockerId`, so the failed row with empty/null docker id could not be deleted through the public container route.

Post-clean API confirmation:

- Admin `GET /api/containers`, `/api/users`, `/api/images`, and `/api/servers` all returned `200` and `0` exact-prefix matches.

### Durable DB Residuals

Initial SQLite scan for exact prefix showed durable rows, not merely transient/API cache state:

- `containers`: six rows. Five had `lifecyclePhase=deleted`; the disk-runtime row `b6db613d-e9da-44b1-8ab0-eba2105d4cc1` had `dockerId=null`, `lifecyclePhase=failed`, `powerIntent=running`, `memBytes=1048576`.
- `operations`: thirteen rows. The failing disk-runtime create operation `364e7635-aa35-441c-8a87-a546dea67bad` had `status=failed`, `attempts=1`, `startedAt=2026-06-03 15:51:48.389`, `completedAt=2026-06-03 15:51:48.398`, and last error `(HTTP code 400) bad parameter - Minimum memory limit allowed is 6MB`.
- `agent_command_outbox`: thirteen rows. The disk-runtime outbox row `b02dfbf5-b5fa-4732-a04d-e0f59f69782d` was `commandKind=createContainer`, `status=failed`, `attempts=1`, `sentAt=2026-06-03 15:51:48.389`, `completedAt=2026-06-03 15:51:48.398`, same Docker minimum-memory error.
- `operation_steps`: two GPU mount reconcile steps, both succeeded; no failed step row for disk-runtime create.
- `container_runtime_observations`: two rows for the GPU containers only, both stale after delete; no runtime observation for disk-runtime because Docker never created a container.
- `reconcile_tasks`: two GPU mount reconcile tasks, both succeeded.
- `quota_desired`: six rows for the exact-prefix owners, now orphaned because users had already been deleted; `quota_runtime_observations`: zero exact-owner rows.
- `users` and `images`: zero exact-prefix or referenced owner/image rows before cleanup.

Exact-prefix SQLite cleanup performed after evidence collection:

- Deleted only rows tied to exact-prefix container names, operation requests/results/errors, outbox payloads, exact container IDs/docker IDs, and orphan quota rows for the exact-prefix owners that no longer existed in `users`.
- Pre-clean counts: `containers=6`, `operations=13`, `agent_command_outbox=13`.
- Post-clean DB check: `containers=0`, `operations=0`, `agent_command_outbox=0`, `container_runtime_observations=0`, `container_mounts=0`, `container_mount_runtime=0`, `container_ssh_enablements=0`, `reconcile_tasks=0`, `users=0`, `images=0`, exact orphan `quota_desired=0`.
- `pragma_foreign_key_check` returned `0` rows after cleanup.

### Host / Runtime Residuals

CPU host `root@10.8.96.91`:

- Managed Docker scan using `/run/nyabase-agent/docker.sock`: no `docker ps -a --filter name=murtc-20260603t155125z-4c16fc` results.
- `/data/nyabase-docker` and `/data` exact-prefix `find` scans returned no paths.
- `/etc/projects` and `/etc/projid` exact-prefix greps returned no lines.
- `xfs_quota -x -c 'report -p -n' /data` showed no project rows for exact numeric users `5` through `9`.

GPU host `lyn@10.8.1.12`:

- Included because the same prefix had created GPU runtime containers before cleanup.
- Managed Docker scan using `/run/nyabase-agent/docker.sock`: no `docker ps -a --filter name=murtc-20260603t155125z-4c16fc` results.
- `/data0/nbTest/nyabase-docker-pquota` and `/data0/nbTest` exact-prefix `find` scans returned no paths.
- `/etc/projects` exact-prefix grep returned no lines.
- `xfs_quota -x -c 'report -p -n' /data0/nbTest/nyabase-docker-pquota` showed no project rows for exact numeric users `7` and `8`.

### Required Output Summary

Command: diagnostic/cleanup for `murtc-20260603t155125z-4c16fc`
Exit code: `0`
Backend log diagnosis: exact prefix absent from backend log; time window contains background state-report warnings and CPU `data_disk_runtime_observations` unique-constraint warnings. Durable operation/outbox rows show disk-runtime create failed immediately because Docker rejected `memBytes=1048576` with minimum memory limit `6MB`.
Product/API residuals: initial API had six exact-prefix containers, including one failed empty-dockerId disk-runtime row; users/images already had zero exact-prefix matches. After exact-prefix DB cleanup, admin API shows zero exact-prefix matches on containers/users/images/servers.
Durable DB residuals: initial durable rows existed in `containers`, `operations`, `agent_command_outbox`, GPU runtime observations/reconcile rows, and orphan `quota_desired`; not transient-only. Exact-prefix cleanup removed them; post-clean counts and `foreign_key_check` are zero.
Host/runtime residuals: CPU and GPU managed Docker, Docker roots, host data paths, project/projid files, and XFS project reports show no exact-prefix residuals.
Cleanup: completed exact-prefix durable DB cleanup after evidence collection; no host Docker/path cleanup was needed.
No-savepoint regression check: pass
Frontend visual: skipped
Failing output (tail): none
Status: GREEN


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T16:01:18.713Z`
Run prefix: `murtc-20260603t160041z-7ca035`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t160041z-7ca035`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t160041z-7ca035-alpha | cbd1623d-5359-4f56-9850-3d3693679735 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca"]}]} |
| beta | murtc-20260603t160041z-7ca035-beta | d5376808-ebcf-4ad0-9928-f172d9f9dc29 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca"]}]} |
| gamma | murtc-20260603t160041z-7ca035-gamma | 485ee975-0610-44ad-8538-8289d160ab59 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["26a885db-bba4-487b-9f2b-0af16aeed456"]}]} |
| delta | murtc-20260603t160041z-7ca035-delta | 31195684-2bcf-48ae-ad98-b1851dc3ef04 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["26a885db-bba4-487b-9f2b-0af16aeed456"]}]} |
| epsilon | murtc-20260603t160041z-7ca035-epsilon | 66453044-4b4a-4023-bcee-2e14cdc67392 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t160041z-7ca035-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/14d132b601b9, alpha:murtc-20260603t160041z-7ca035-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/e8069f6e0a52, beta:murtc-20260603t160041z-7ca035-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/a1e65c077dd5, gamma:murtc-20260603t160041z-7ca035-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/aa288f86a3ab, delta:murtc-20260603t160041z-7ca035-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/f82467d8d344, epsilon:murtc-20260603t160041z-7ca035-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/496dada6452b
- Deleted containers: epsilon:murtc-20260603t160041z-7ca035-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/496dada6452b, delta:murtc-20260603t160041z-7ca035-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/f82467d8d344, gamma:murtc-20260603t160041z-7ca035-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/aa288f86a3ab, beta:murtc-20260603t160041z-7ca035-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/a1e65c077dd5, alpha:murtc-20260603t160041z-7ca035-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/e8069f6e0a52, alpha:murtc-20260603t160041z-7ca035-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/14d132b601b9
- Created users: cbd1623d-5359-4f56-9850-3d3693679735, d5376808-ebcf-4ad0-9928-f172d9f9dc29, 485ee975-0610-44ad-8538-8289d160ab59, 31195684-2bcf-48ae-ad98-b1851dc3ef04, 66453044-4b4a-4023-bcee-2e14cdc67392
- Deleted users: cbd1623d-5359-4f56-9850-3d3693679735, d5376808-ebcf-4ad0-9928-f172d9f9dc29, 485ee975-0610-44ad-8538-8289d160ab59, 31195684-2bcf-48ae-ad98-b1851dc3ef04, 66453044-4b4a-4023-bcee-2e14cdc67392
- Created images: 4275ef7f-9e1b-451b-8b51-f04987239dca, 26a885db-bba4-487b-9f2b-0af16aeed456
- Deleted images: 26a885db-bba4-487b-9f2b-0af16aeed456, 4275ef7f-9e1b-451b-8b51-f04987239dca

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["cbd1623d-5359-4f56-9850-3d3693679735","d5376808-ebcf-4ad0-9928-f172d9f9dc29","485ee975-0610-44ad-8538-8289d160ab59","31195684-2bcf-48ae-ad98-b1851dc3ef04","66453044-4b4a-4023-bcee-2e14cdc67392"],"deletedImages":["26a885db-bba4-487b-9f2b-0af16aeed456","4275ef7f-9e1b-451b-8b51-f04987239dca"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["cbd1623d-5359-4f56-9850-3d3693679735","d5376808-ebcf-4ad0-9928-f172d9f9dc29","485ee975-0610-44ad-8538-8289d160ab59","31195684-2bcf-48ae-ad98-b1851dc3ef04","66453044-4b4a-4023-bcee-2e14cdc67392"],"imageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca","26a885db-bba4-487b-9f2b-0af16aeed456"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"cbd1623d-5359-4f56-9850-3d3693679735","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"d5376808-ebcf-4ad0-9928-f172d9f9dc29","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"485ee975-0610-44ad-8538-8289d160ab59","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["26a885db-bba4-487b-9f2b-0af16aeed456"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"31195684-2bcf-48ae-ad98-b1851dc3ef04","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["26a885db-bba4-487b-9f2b-0af16aeed456","4275ef7f-9e1b-451b-8b51-f04987239dca"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"66453044-4b4a-4023-bcee-2e14cdc67392","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4275ef7f-9e1b-451b-8b51-f04987239dca"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"14d132b601b9","exactDockerId":"e8069f6e0a52","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"a1e65c077dd5","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"aa288f86a3ab","deltaDockerId":"f82467d8d344","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/496dada6452b/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"496dada6452b","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # Killed OVER_CODE:137"}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: alpha create b9-alpha: {"message":"CPU quota exceeded","error":"Bad Request","statusCode":400}: expected 400 to be 201 // Object.is equality (root cause: product)

## DevOps Exact-Prefix Quota Diagnosis And Cleanup

Prepared: `2026-06-03T16:25:xxZ`
Role: devops
Run prefix: `murtc-20260603t162119z-4e5b35`
Command: diagnostic/cleanup for `murtc-20260603t162119z-4e5b35`
Exit code: `0`
Frontend visual: skipped

Scope: backend/API/DB/host/runtime diagnostics and exact-prefix cleanup only. No product source, tests, focused vitest suite, broad runtime cleanup, or secret disclosure.

### Backend Log Diagnosis

- Relevant backend log files checked: `/tmp/nyabase-backend-delete-visibility-20260603T160243Z-rebuild-detached-20260603T161924Z.log`, `/tmp/nyabase-backend-delete-visibility-20260603T160243Z-rebuild-20260603T161803Z.log`, and `/tmp/nyabase-backend-online-restore-20260603T155000Z.log`.
- Around `2026-06-03T16:21:19Z` onward, logs had no exact-prefix request lines and no request-level quota accounting lines. The matching live backend log window showed repeated CPU state-report persistence warnings: `UNIQUE constraint failed: data_disk_runtime_observations.serverId, data_disk_runtime_observations.diskId, data_disk_runtime_observations.reportSeq` at local `00:21:59`, `00:22:50`, `00:23:49`, etc.
- Operation/outbox timing in DB supplied the create/delete diagnosis: B6 deletes were created at `2026-06-03 16:21:59`; alpha delete operations completed at `16:22:01.120` and `16:22:02.122`; B9 operations for other actors were also created at `16:21:59`, proving B9 started before all cleanup operations had converged.
- `rg -n "no such savepoint: typeorm_"` across the relevant current backend logs returned no matches.

### Quota Diagnosis

- Product root cause confirmed: `ContainersService.desiredResourceUsage()` sums durable `containers` rows where `lifecyclePhase != deleted`; it does not exclude `deleting` or otherwise reserve/release quota at delete request acceptance.
- At B9 start, alpha still had two B6 CPU rows in the delete operation window. Their requested CPU was `250 + 250 = 500`, exactly alpha's CPU grant, so alpha `b9-alpha` with `cpuMillis: 1` was rejected as `400 CPU quota exceeded`.
- By later DB inspection, the two alpha B6 rows had reached `lifecyclePhase = deleted` with `deletedAt` set, so current quota-code CPU sum for alpha on CPU server was empty/zero. This means the failure was a stale cleanup convergence/race in desired-state quota accounting, not a lasting quota sum after `deleted`.
- B9 also persisted three failed rows for epsilon/delta/gamma with empty `dockerId`; their agent failures were unrelated minimum-memory rejects for `memBytes: 1048576` (`Minimum memory limit allowed is 6MB`).

### Product/API Residuals Before Cleanup

Admin API `GET /api/containers` before cleanup returned 9 exact-prefix rows:

- 6 deleted tombstones with docker IDs: alpha `a6bc91640aa0`, alpha `21d5b8cf95ff`, beta `00346eb0c582`, gamma `cec062adc736`, delta `83cc6fd21752`, epsilon disk-runtime `f33fab946e99`; all had `lifecycle.phase = deleted`, `status = unknown`, and latest operation `container.delete/succeeded`.
- 3 failed empty-docker-id B9 rows: `b9-epsilon`, `b9-delta`, and `b9-gamma`; each had `lifecycle.phase = failed`, latest operation `container.create/failed`, and last error `Minimum memory limit allowed is 6MB`.
- Admin API `GET /api/users` and `GET /api/images` returned zero exact-prefix users/images; tester cleanup had already removed them.

### Durable DB Residuals Before Cleanup

- `containers`: 9 exact-prefix rows.
- `operations`: 15 exact-prefix container operations.
- `agent_command_outbox`: 15 exact-prefix container command rows.
- `container_runtime_observations`, `container_mount_runtime`, `container_mounts`, `container_ssh_enablements`, `reconcile_tasks`: zero exact-prefix rows for the container set at initial residual check.
- `server_grants` and `image_grants`: zero rows for the five disposable user IDs.
- `quota_desired`: 6 rows for deleted disposable users: alpha numeric `5` CPU limit `67108864`, beta numeric `6` CPU limit `134217728`, gamma numeric `7` GPU limit `268435456`, delta numeric `8` CPU/GPU limits `268435456`, epsilon numeric `9` CPU limit `67108864`. Related `quota.apply` operations/outbox/steps/reconcile rows were also present by user ID.
- `quota_runtime_observations`: zero rows for the five disposable user IDs.

### Host/Runtime Residuals

- CPU host `root@10.8.96.91`, managed Docker `DOCKER_HOST=unix:///run/nyabase-agent/docker.sock`: no `docker ps -a --no-trunc` matches for the exact prefix or CPU docker IDs `a6bc91640aa0`, `21d5b8cf95ff`, `00346eb0c582`, `f33fab946e99`; no matching host paths under `/data/nyabase-docker` or `/data`; no `/etc/projects` or `/etc/projid` matches. XFS hard limits for exact numeric project IDs `10005`, `10006`, `10008`, `10009` were reset to `0`.
- GPU host `lyn@10.8.1.12`, managed Docker with `sudo -n env DOCKER_HOST=unix:///run/nyabase-agent/docker.sock`: no managed Docker matches for exact prefix or GPU docker IDs `cec062adc736`, `83cc6fd21752`; no matching host paths under `/data0/nbTest/nyabase-docker-pquota`; no `/etc/projects` or `/etc/projid` matches. XFS hard limits for exact numeric project IDs `10007` and `10008` were reset to `0`.
- GPU XFS still reports tiny used blocks for project IDs `10007`/`10008` after hard-limit reset (`160K`/`128K` in the sampled report). Inspection showed anonymous overlay2 NVIDIA runtime paths tagged with those project IDs, not exact-prefix/docker-id paths. They were not deleted because the paths are not safely attributable by prefix.

### Cleanup

Safe exact-prefix cleanup performed after evidence collection:

- Deleted durable container residuals: `15` `agent_command_outbox`, `15` `operations`, `9` `containers`; related container child tables had zero rows.
- Deleted exact-user quota residuals: `12` quota outbox rows, `12` quota operation steps, `12` quota reconcile tasks, `12` quota operations, and `6` `quota_desired` rows.
- Reset host XFS hard limits for exact deleted numeric users: CPU `10005`, `10006`, `10008`, `10009`; GPU `10007`, `10008`.

Post-cleanup verification:

- Admin API exact-prefix containers: `0`.
- Durable DB exact-prefix/name/user residual checks: `containers=0`, `operations_prefix=0`, `operations_userids=0`, `outbox_prefix_or_userids=0`, `quota_desired=0`, `server_grants=0`, `image_grants=0`, `users=0`, `images=0`.
- Managed Docker exact-prefix and exact docker-ID scans remained empty on CPU and GPU.

No-savepoint regression check: pass
Failing output (tail): none
Status: GREEN

Minimal reproducer: run prefix `murtc-20260603t162119z-4e5b35` reached fresh fixture validity, CPU/memory quota boundaries, GPU bad-index/duplicate/over-count boundaries, and disk runtime write proof. Disk-runtime delete convergence passed enough for the suite to continue into B9. During pre-B9 cleanup, tracked deletes were recorded for alpha containers `a6bc91640aa0` and `21d5b8cf95ff`, beta `00346eb0c582`, gamma `cec062adc736`, delta `83cc6fd21752`, and epsilon disk-runtime `f33fab946e99`. Immediately afterward, B9 near-concurrent create attempted alpha `POST /api/containers` for `murtc-20260603t162119z-4e5b35-b9-alpha` on CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` with `cpuMillis: 1`, `memBytes: 1048576`, `gpuIndices: []`, and no `diskBytes`; it returned `400 CPU quota exceeded`. Expected: after deleted alpha B6 proof containers were no longer visible via `GET /api/containers/:serverId/:dockerId`, alpha should have available CPU quota for a 1 milliCPU B9 container. Backend savepoint check across `/tmp/nyabase-backend-online-restore-20260603T155000Z.log` and `/tmp/nyabase-backend-*.log` found no `no such savepoint: typeorm_` matches. Tester cleanup recorded deleted users/images; devops must include exact prefix `murtc-20260603t162119z-4e5b35` in B11 product/API, DB, Docker, host path, and XFS scans because B9 stopped before final convergence checks.


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T16:02:20.323Z`
Run prefix: `murtc-20260603t160145z-d9e089`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t160145z-d9e089`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t160145z-d9e089-alpha | 937d45c0-a1cc-4e65-9ca5-d24241705d09 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e"]}]} |
| beta | murtc-20260603t160145z-d9e089-beta | 7a5808bf-6c45-48b1-a57c-7f3910f45b56 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e"]}]} |
| gamma | murtc-20260603t160145z-d9e089-gamma | aa047ac5-7395-4951-9ba8-be772c511547 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["71f1d53e-6f55-42a9-9d75-3b92a8c33563"]}]} |
| delta | murtc-20260603t160145z-d9e089-delta | abfe1647-e335-47da-a9ae-5cf83e482661 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["71f1d53e-6f55-42a9-9d75-3b92a8c33563"]}]} |
| epsilon | murtc-20260603t160145z-d9e089-epsilon | c0d75b12-7fa1-417d-b03e-0dccb416fc60 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t160145z-d9e089-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/9e82d8384e29, alpha:murtc-20260603t160145z-d9e089-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/b871b786d259, beta:murtc-20260603t160145z-d9e089-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/64ff4f21be9d, gamma:murtc-20260603t160145z-d9e089-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/fd6ccdb01ad5, delta:murtc-20260603t160145z-d9e089-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/a6beaffff570, epsilon:murtc-20260603t160145z-d9e089-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/9bb6db15b422
- Deleted containers: epsilon:murtc-20260603t160145z-d9e089-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/9bb6db15b422, delta:murtc-20260603t160145z-d9e089-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/a6beaffff570, gamma:murtc-20260603t160145z-d9e089-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/fd6ccdb01ad5, beta:murtc-20260603t160145z-d9e089-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/64ff4f21be9d, alpha:murtc-20260603t160145z-d9e089-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/b871b786d259, alpha:murtc-20260603t160145z-d9e089-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/9e82d8384e29
- Created users: 937d45c0-a1cc-4e65-9ca5-d24241705d09, 7a5808bf-6c45-48b1-a57c-7f3910f45b56, aa047ac5-7395-4951-9ba8-be772c511547, abfe1647-e335-47da-a9ae-5cf83e482661, c0d75b12-7fa1-417d-b03e-0dccb416fc60
- Deleted users: 937d45c0-a1cc-4e65-9ca5-d24241705d09, 7a5808bf-6c45-48b1-a57c-7f3910f45b56, aa047ac5-7395-4951-9ba8-be772c511547, abfe1647-e335-47da-a9ae-5cf83e482661, c0d75b12-7fa1-417d-b03e-0dccb416fc60
- Created images: 4c0b4df7-2821-4e84-867f-dffa24b1376e, 71f1d53e-6f55-42a9-9d75-3b92a8c33563
- Deleted images: 71f1d53e-6f55-42a9-9d75-3b92a8c33563, 4c0b4df7-2821-4e84-867f-dffa24b1376e

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["937d45c0-a1cc-4e65-9ca5-d24241705d09","7a5808bf-6c45-48b1-a57c-7f3910f45b56","aa047ac5-7395-4951-9ba8-be772c511547","abfe1647-e335-47da-a9ae-5cf83e482661","c0d75b12-7fa1-417d-b03e-0dccb416fc60"],"deletedImages":["71f1d53e-6f55-42a9-9d75-3b92a8c33563","4c0b4df7-2821-4e84-867f-dffa24b1376e"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["937d45c0-a1cc-4e65-9ca5-d24241705d09","7a5808bf-6c45-48b1-a57c-7f3910f45b56","aa047ac5-7395-4951-9ba8-be772c511547","abfe1647-e335-47da-a9ae-5cf83e482661","c0d75b12-7fa1-417d-b03e-0dccb416fc60"],"imageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e","71f1d53e-6f55-42a9-9d75-3b92a8c33563"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"937d45c0-a1cc-4e65-9ca5-d24241705d09","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"7a5808bf-6c45-48b1-a57c-7f3910f45b56","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"aa047ac5-7395-4951-9ba8-be772c511547","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["71f1d53e-6f55-42a9-9d75-3b92a8c33563"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"abfe1647-e335-47da-a9ae-5cf83e482661","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e","71f1d53e-6f55-42a9-9d75-3b92a8c33563"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"c0d75b12-7fa1-417d-b03e-0dccb416fc60","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["4c0b4df7-2821-4e84-867f-dffa24b1376e"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"9e82d8384e29","exactDockerId":"b871b786d259","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"64ff4f21be9d","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"fd6ccdb01ad5","deltaDockerId":"a6beaffff570","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/9bb6db15b422/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"9bb6db15b422","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # dd: error writing '/tmp/nyabase-di"}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: alpha create b9-alpha: {"message":"CPU quota exceeded","error":"Bad Request","statusCode":400}: expected 400 to be 201 // Object.is equality (root cause: product)

## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T16:05:19.814Z`
Run prefix: `murtc-20260603t160243z-2adeda`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t160243z-2adeda`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t160243z-2adeda-alpha | f27f5632-184b-4b8c-93ce-d34aa4cccfad | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618"]}]} |
| beta | murtc-20260603t160243z-2adeda-beta | 806540a1-0611-468b-97d8-a50c96605ebd | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618"]}]} |
| gamma | murtc-20260603t160243z-2adeda-gamma | 63447ac7-69f9-4f5e-b78d-0b782bf26205 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["64a15cda-6107-4e9e-b36e-688863e84f4d"]}]} |
| delta | murtc-20260603t160243z-2adeda-delta | 45627be4-3e4f-4dad-8527-b894e1e4f612 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["64a15cda-6107-4e9e-b36e-688863e84f4d"]}]} |
| epsilon | murtc-20260603t160243z-2adeda-epsilon | f99d93b2-85b7-4fe6-9de0-945a0975477b | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t160243z-2adeda-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/a7ef99bd9794, alpha:murtc-20260603t160243z-2adeda-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/3811374ac83a, beta:murtc-20260603t160243z-2adeda-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/63d6bddd162d, gamma:murtc-20260603t160243z-2adeda-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/4bc4481fdff3, delta:murtc-20260603t160243z-2adeda-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/e82d6ee0b266, epsilon:murtc-20260603t160243z-2adeda-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/7a9f8ea8b6d2
- Deleted containers: epsilon:murtc-20260603t160243z-2adeda-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/7a9f8ea8b6d2, epsilon:murtc-20260603t160243z-2adeda-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/7a9f8ea8b6d2
- Created users: f27f5632-184b-4b8c-93ce-d34aa4cccfad, 806540a1-0611-468b-97d8-a50c96605ebd, 63447ac7-69f9-4f5e-b78d-0b782bf26205, 45627be4-3e4f-4dad-8527-b894e1e4f612, f99d93b2-85b7-4fe6-9de0-945a0975477b
- Deleted users: f27f5632-184b-4b8c-93ce-d34aa4cccfad, 806540a1-0611-468b-97d8-a50c96605ebd, 63447ac7-69f9-4f5e-b78d-0b782bf26205, 45627be4-3e4f-4dad-8527-b894e1e4f612, f99d93b2-85b7-4fe6-9de0-945a0975477b
- Created images: 836a5be3-1a7e-4e51-b493-c187f9d59618, 64a15cda-6107-4e9e-b36e-688863e84f4d
- Deleted images: 64a15cda-6107-4e9e-b36e-688863e84f4d, 836a5be3-1a7e-4e51-b493-c187f9d59618

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["f27f5632-184b-4b8c-93ce-d34aa4cccfad","806540a1-0611-468b-97d8-a50c96605ebd","63447ac7-69f9-4f5e-b78d-0b782bf26205","45627be4-3e4f-4dad-8527-b894e1e4f612","f99d93b2-85b7-4fe6-9de0-945a0975477b"],"deletedImages":["64a15cda-6107-4e9e-b36e-688863e84f4d","836a5be3-1a7e-4e51-b493-c187f9d59618"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["f27f5632-184b-4b8c-93ce-d34aa4cccfad","806540a1-0611-468b-97d8-a50c96605ebd","63447ac7-69f9-4f5e-b78d-0b782bf26205","45627be4-3e4f-4dad-8527-b894e1e4f612","f99d93b2-85b7-4fe6-9de0-945a0975477b"],"imageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618","64a15cda-6107-4e9e-b36e-688863e84f4d"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f27f5632-184b-4b8c-93ce-d34aa4cccfad","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"806540a1-0611-468b-97d8-a50c96605ebd","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"63447ac7-69f9-4f5e-b78d-0b782bf26205","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["64a15cda-6107-4e9e-b36e-688863e84f4d"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"45627be4-3e4f-4dad-8527-b894e1e4f612","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["64a15cda-6107-4e9e-b36e-688863e84f4d","836a5be3-1a7e-4e51-b493-c187f9d59618"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f99d93b2-85b7-4fe6-9de0-945a0975477b","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["836a5be3-1a7e-4e51-b493-c187f9d59618"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"a7ef99bd9794","exactDockerId":"3811374ac83a","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"63d6bddd162d","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"4bc4481fdff3","deltaDockerId":"e82d6ee0b266","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/7a9f8ea8b6d2/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"7a9f8ea8b6d2","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # Killed OVER_CODE:137"}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: Error: timed out waiting for deleted container 7a9f8ea8b6d2 (root cause: product)
- user container cleanup: Error: timed out waiting for deleted container 7a9f8ea8b6d2 (root cause: infra)

Minimal reproducer: run prefix `murtc-20260603t160243z-2adeda` reached fresh fixture validity, CPU/memory quota boundaries, GPU bad-index/duplicate/over-count boundaries, and disk runtime write proof. Epsilon container `murtc-20260603t160243z-2adeda-alpha-disk-runtime` on CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` had docker id `7a9f8ea8b6d2`; exec below-limit write succeeded and over-limit write failed with `Killed OVER_CODE:137`, while create body omitted `diskBytes`. During pre-B9 cleanup, `DELETE /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/7a9f8ea8b6d2` returned an accepted cleanup status, but repeated `GET /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/7a9f8ea8b6d2` with epsilon's JWT did not return 403/404 within 60s. Backend log check for this rerun: `grep -n "no such savepoint: typeorm_" /tmp/nyabase-backend-online-restore-20260603T155000Z.log | tail -n 20` returned no matches. Tester cleanup attempted tracked container cleanup and admin fixture cleanup; admin cleanup deleted the five users and two images, but B11 devops must scan exact prefix `murtc-20260603t160243z-2adeda` across product/API rows, managed Docker, host paths, and XFS project/projid entries because delete convergence failed before B9.

## DevOps B11 Exact-Prefix Diagnosis/Cleanup

Prepared: `2026-06-03T16:11:33Z`
Role: devops
Scope: exact prefix `murtc-20260603t160243z-2adeda`; backend log/API/DB/host/runtime scans and exact-prefix cleanup only. No product source or tests were edited, and no focused Vitest suite was run.

### Backend Log Diagnosis

- Backend PID/log: `2570305`, `/tmp/nyabase-backend-online-restore-20260603T155000Z.log`.
- Log grep for `murtc-20260603t160243z-2adeda`, all six docker ID prefixes, `container.delete`, `deleteContainer`, `agent_command_outbox`, status-report/progress terms, and `no such savepoint: typeorm_` found no exact-prefix/delete/outbox error lines and no savepoint regression.
- Around the run window, the log contains console connect/disconnect lines at local `2026-06-04 00:02:14` to `00:02:20`, then state-report warnings. At `00:02:32`, GPU state reports logged `Unknown numericUserId 5/7/8/12/13` and `Skipping desired container import ... missing ownerId, name, imageId`. At `00:02:50`, CPU state reports logged unknown numeric user IDs and a duplicate `data_disk_runtime_observations` report-seq warning. These are runtime observation warnings, not delete-command failures for `7a9f8ea8b6d2`.

### Product/API And DB Evidence Before Cleanup

- Current admin API after tester fixture cleanup: admin login `200`; `GET /api/containers` exact-prefix count `0`; `GET /api/users` exact-prefix count `0`; `GET /api/images` exact-prefix count `0`; admin `GET /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/7a9f8ea8b6d2` returned `404`. Epsilon credential replay was infeasible because the disposable user had already been deleted; login returned `400`.
- Admin `GET` for all six exact-prefix docker IDs returned `404`, so product API could not be used for cleanup after owner deletion.
- Durable DB before cleanup still had six exact-prefix `containers` rows:
  - CPU active/running: `a7ef99bd9794` alpha-below, `3811374ac83a` alpha-exact, `63d6bddd162d` beta-exact.
  - GPU active/running: `4bc4481fdff3` gamma-gpu-granted, `e82d6ee0b266` delta-gpu-granted.
  - CPU deleted/stopped: `7a9f8ea8b6d2` alpha-disk-runtime with `deletedAt=2026-06-03 16:04:19.518`, `deletedBy=f99d93b2-85b7-4fe6-9de0-945a0975477b`.
- Delete command evidence for disk-runtime: two `container.delete` operations for container row `2e00c5d0-61ba-46b6-80ab-257a57232de1`, both `succeeded`; outbox rows `95fd4f08-aad1-4e84-8288-739439e2a701` and `ea820bd9-18e6-4748-9453-842d92005cd9` were `deleteContainer`, `status=succeeded`, `attempts=1`, no `lastError`, payload docker ID `7a9f8ea8b6d2`.
- Runtime observation evidence: CPU disk-runtime docker ID `7a9f8ea8b6d2` had no current runtime observation rows after deletion. GPU active containers had running runtime observations through report seq `26`; reconcile/mount tasks for those GPU rows succeeded repeatedly through `2026-06-03 16:08:36`.
- Quota desired rows remained for the five deleted fixture users before cleanup: numeric user IDs `5`, `6`, `7`, `8`, `9`, matching the unknown numeric-user state-report warnings after user deletion.
- Diagnosis: the disk-runtime Docker delete itself succeeded; the tester failure was stale durable/read-model/API convergence behavior while the deleted container row still existed and was returned from the user's GET view during the 60s wait. Separately, after admin user/image cleanup, five still-running exact-prefix containers became invisible to product API because their owners were gone, leaving product DB/runtime residuals.

### Host/Runtime Evidence Before Cleanup

- CPU managed Docker before cleanup: exact-prefix containers `a7ef99bd9794`, `3811374ac83a`, and `63d6bddd162d` were running; disk-runtime `7a9f8ea8b6d2` was absent.
- GPU managed Docker before cleanup: exact-prefix containers `4bc4481fdff3` and `e82d6ee0b266` were running.
- CPU `/data` path scan, `/etc/projects`, `/etc/projid`, and XFS project report grep found no exact-prefix path/projid residuals. GPU `/data0`/`/data` path scan, `/etc/projects`, `/etc/projid`, and XFS project report grep found no exact-prefix path/projid residuals.

### Cleanup And Post-Cleanup Verification

- Removed exact-prefix managed Docker containers: CPU `a7ef99bd9794`, `3811374ac83a`, `63d6bddd162d`; GPU `4bc4481fdff3`, `e82d6ee0b266`. CPU `7a9f8ea8b6d2` was already absent.
- Took SQLite backup before DB cleanup: `/tmp/nyabase-db-before-murtc-20260603t160243z-2adeda-cleanup.db`.
- Deleted exact-prefix durable rows linked by the six container IDs/docker IDs and five user IDs from `containers`, `operations`, `operation_steps`, `agent_command_outbox`, `container_runtime_observations`, `container_mount_runtime`, `container_mounts`, `container_ssh_enablements`, `quota_desired`, `quota_runtime_observations`, grants/members/tokens/SSH keys/audit/resource locks where linked. `PRAGMA foreign_key_check` returned no rows.
- Post-clean API: admin login `200`; exact-prefix containers/users/images counts all `0`; admin GET disk-runtime `7a9f8ea8b6d2` returned `404`.
- Post-clean DB counts all `0` for exact-prefix `containers`, `operations`, `operation_steps`, `agent_command_outbox`, `container_runtime_observations`, `quota_desired`, `reconcile_tasks`, `users`, and `images`.
- Post-clean CPU managed Docker: `a7ef99bd9794`, `3811374ac83a`, `63d6bddd162d`, and `7a9f8ea8b6d2` all absent; no exact-prefix `/data` path or projid entries.
- Post-clean GPU managed Docker: `4bc4481fdff3` and `e82d6ee0b266` absent; no exact-prefix `/data0`/`/data` path or projid entries.

### Required Output

```text
Command: diagnostic/cleanup for murtc-20260603t160243z-2adeda
Exit code: 0
Backend log diagnosis: no exact-prefix/delete/outbox failure lines; disk-runtime delete/outbox success proven in DB; state-report warnings showed unknown numeric users after fixture user deletion, plus unrelated duplicate data-disk report-seq warnings; no savepoint error.
Product/API residuals: before cleanup admin API showed zero exact-prefix containers/users/images and 404 for disk-runtime GET; deleted epsilon user made user GET replay infeasible; admin GET for all exact-prefix docker IDs was 404. Post-clean API counts are zero and disk-runtime GET is 404.
Durable DB residuals: before cleanup six container rows remained; five active/running rows plus deleted/stopped disk-runtime row. Two disk-runtime delete operations and outbox commands succeeded with no lastError, so Docker delete succeeded but stale durable/read-model state remained visible during tester convergence. Quota desired rows also remained for deleted fixture users. Post-clean DB residual counts and foreign_key_check are zero.
Host/runtime residuals: before cleanup CPU had three exact-prefix running containers and disk-runtime absent; GPU had two exact-prefix running containers; no exact-prefix host path/projid residuals. Post-clean CPU/GPU Docker and host/projid scans are clean.
Cleanup: exact-prefix Docker containers removed; exact-prefix linked DB rows removed after backup `/tmp/nyabase-db-before-murtc-20260603t160243z-2adeda-cleanup.db`; nothing remains for the prefix.
No-savepoint regression check: pass
Frontend visual: skipped
Failing output (tail): none
Status: GREEN
```

## Backend Rebuild/Restart After Delete Visibility Fix

Prepared: `2026-06-03T16:20:12Z`
Role: devops
Scope: rebuilt `@nyabase/backend` from current source after the container delete/tombstone visibility fix, restarted only the local backend from rebuilt `packages/backend/dist`, and verified auth health, product online state, startup logs, and common-src artifact guard. No product source, tests, scripts, package files, lockfiles, or broad residual cleanup were edited or run.

### Evidence

- Backend build: `pnpm --filter @nyabase/backend build` exited `0`.
- Backend restart: replaced prior backend PID `2570305`; final stable detached PID `2582847`, command `node -r tsconfig-paths/register dist/main.js`, PPID `1`, log `/tmp/nyabase-backend-delete-visibility-20260603T160243Z-rebuild-detached-20260603T161924Z.log`.
- Auth health: `GET http://localhost:3001/api/auth/me` unauthenticated returned `401` with body `{"message":"Unauthorized","statusCode":401}`.
- Product API online state: admin login from `test/.env` returned `200`; `GET /api/servers` returned `200`; CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` (`nyabase-cpu-batch-20260601T163636Z`) status `online`, `lastSeenAt=2026-06-03T16:20:03.886Z`; GPU server `db1112fe-1c55-4314-9511-6d8510c523c2` (`nyabase-gpu-batch-20260601T163636Z`) status `online`, `lastSeenAt=2026-06-03T16:20:05.800Z`.
- Startup log scan after health checks: `di_fail_count=0`, `savepoint_count=0`, `startup_success_count=1`, `agent_connected_count=2`. Log shows `Backend listening on port 3001` and both target agents connected. Runtime state-report warnings were present, but no startup DI failure and no `no such savepoint` spam were found.
- Common-src artifact guard: `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort` returned no paths.

### Required Output

```text
Command: backend rebuild/restart after delete visibility fix
Exit code: 0
Backend typecheck/build: pass
Backend health: pass
CPU/GPU product online: pass
Common-src artifact guard: pass
Frontend visual: skipped
Failing output (tail): none
Status: GREEN
```


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T16:21:59.143Z`
Run prefix: `murtc-20260603t162119z-4e5b35`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t162119z-4e5b35`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t162119z-4e5b35-alpha | 4d11d3c6-4988-4fbf-8ade-e26cdfb9f6b1 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]}]} |
| beta | murtc-20260603t162119z-4e5b35-beta | 43b7b6f8-4864-4505-b54d-a41a87104e42 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]}]} |
| gamma | murtc-20260603t162119z-4e5b35-gamma | 3a49f2ff-2037-41ff-95f0-36b5b356711c | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["8604cd44-f109-4e9f-a9a5-5a5e7838f9ae"]}]} |
| delta | murtc-20260603t162119z-4e5b35-delta | 3a246cc6-a7b7-47c0-a2a1-05363cf53a96 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["8604cd44-f109-4e9f-a9a5-5a5e7838f9ae"]}]} |
| epsilon | murtc-20260603t162119z-4e5b35-epsilon | 2b54675d-70c2-42c5-9c7d-4d9cfd234e4e | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t162119z-4e5b35-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/a6bc91640aa0, alpha:murtc-20260603t162119z-4e5b35-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/21d5b8cf95ff, beta:murtc-20260603t162119z-4e5b35-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/00346eb0c582, gamma:murtc-20260603t162119z-4e5b35-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/cec062adc736, delta:murtc-20260603t162119z-4e5b35-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/83cc6fd21752, epsilon:murtc-20260603t162119z-4e5b35-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/f33fab946e99
- Deleted containers: epsilon:murtc-20260603t162119z-4e5b35-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/f33fab946e99, delta:murtc-20260603t162119z-4e5b35-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/83cc6fd21752, gamma:murtc-20260603t162119z-4e5b35-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/cec062adc736, beta:murtc-20260603t162119z-4e5b35-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/00346eb0c582, alpha:murtc-20260603t162119z-4e5b35-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/21d5b8cf95ff, alpha:murtc-20260603t162119z-4e5b35-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/a6bc91640aa0
- Created users: 4d11d3c6-4988-4fbf-8ade-e26cdfb9f6b1, 43b7b6f8-4864-4505-b54d-a41a87104e42, 3a49f2ff-2037-41ff-95f0-36b5b356711c, 3a246cc6-a7b7-47c0-a2a1-05363cf53a96, 2b54675d-70c2-42c5-9c7d-4d9cfd234e4e
- Deleted users: 4d11d3c6-4988-4fbf-8ade-e26cdfb9f6b1, 43b7b6f8-4864-4505-b54d-a41a87104e42, 3a49f2ff-2037-41ff-95f0-36b5b356711c, 3a246cc6-a7b7-47c0-a2a1-05363cf53a96, 2b54675d-70c2-42c5-9c7d-4d9cfd234e4e
- Created images: 7fd5c455-ad2c-4b48-99a2-ebd4084e5c30, 8604cd44-f109-4e9f-a9a5-5a5e7838f9ae
- Deleted images: 8604cd44-f109-4e9f-a9a5-5a5e7838f9ae, 7fd5c455-ad2c-4b48-99a2-ebd4084e5c30

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["4d11d3c6-4988-4fbf-8ade-e26cdfb9f6b1","43b7b6f8-4864-4505-b54d-a41a87104e42","3a49f2ff-2037-41ff-95f0-36b5b356711c","3a246cc6-a7b7-47c0-a2a1-05363cf53a96","2b54675d-70c2-42c5-9c7d-4d9cfd234e4e"],"deletedImages":["8604cd44-f109-4e9f-a9a5-5a5e7838f9ae","7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["4d11d3c6-4988-4fbf-8ade-e26cdfb9f6b1","43b7b6f8-4864-4505-b54d-a41a87104e42","3a49f2ff-2037-41ff-95f0-36b5b356711c","3a246cc6-a7b7-47c0-a2a1-05363cf53a96","2b54675d-70c2-42c5-9c7d-4d9cfd234e4e"],"imageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30","8604cd44-f109-4e9f-a9a5-5a5e7838f9ae"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"4d11d3c6-4988-4fbf-8ade-e26cdfb9f6b1","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"43b7b6f8-4864-4505-b54d-a41a87104e42","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"3a49f2ff-2037-41ff-95f0-36b5b356711c","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["8604cd44-f109-4e9f-a9a5-5a5e7838f9ae"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"3a246cc6-a7b7-47c0-a2a1-05363cf53a96","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30","8604cd44-f109-4e9f-a9a5-5a5e7838f9ae"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"2b54675d-70c2-42c5-9c7d-4d9cfd234e4e","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["7fd5c455-ad2c-4b48-99a2-ebd4084e5c30"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"a6bc91640aa0","exactDockerId":"21d5b8cf95ff","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"00346eb0c582","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"cec062adc736","deltaDockerId":"83cc6fd21752","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/f33fab946e99/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"f33fab946e99","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # dd: error writing '/tmp/nyabase-di"}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: alpha create b9-alpha: {"message":"CPU quota exceeded","error":"Bad Request","statusCode":400}: expected 400 to be 201 // Object.is equality (root cause: product)


## Backend Rebuild Restart After Quota Deleting-Exclusion Fix

Prepared: `2026-06-03T16:39:00Z`
Role: devops
Scope: rebuilt backend from current source after quota accounting fix, restarted backend from rebuilt `dist/main.js` against product SQLite DB, and verified health/online state. No product source, tests, scripts, package files, lockfiles, or broad residual cleanup were edited or run.

- Backend build: `pnpm --filter @nyabase/backend build` exited `0`.
- Backend restart: replaced prior backend PID `2582847`; final stable detached PID `2589799`, command `node -r tsconfig-paths/register dist/main.js`, PPID `1`, DB handle `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`, log `/tmp/nyabase-backend-quota-deleting-exclusion-restart-productdb-20260603T163734Z.log`.
- Backend health: unauthenticated `GET http://localhost:3001/api/auth/me` returned `401` with body `{"message":"Unauthorized","statusCode":401}`.
- Product API online state: admin login from `test/.env` returned `200`; `GET /api/servers` returned `200`; CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` (`nyabase-cpu-batch-20260601T163636Z`) status `online`; GPU server `db1112fe-1c55-4314-9511-6d8510c523c2` (`nyabase-gpu-batch-20260601T163636Z`) status `online`.
- Startup/health log scan: no startup DI failure patterns and no `savepoint` / `no such savepoint` entries after restart and health checks. Log shows `Nest application successfully started`, `Backend listening on port 3001`, and both target agents connected. Runtime state-report warnings and one VictoriaMetrics write error were present but outside the requested startup DI/savepoint checks.
- Common-src artifact guard: `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort` returned no paths.

### Required Output

```text
Command: backend rebuild/restart after quota deleting-exclusion fix
Exit code: 0
Backend typecheck/build: pass
Backend health: pass
CPU/GPU product online: pass
Common-src artifact guard: pass
Frontend visual: skipped
Failing output (tail): none
Status: GREEN
```


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T16:45:07.839Z`
Run prefix: `murtc-20260603t164332z-cf001e`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t164332z-cf001e`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t164332z-cf001e-alpha | 63c3c5d6-93be-43af-bd46-c978d5fddc4b | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}]} |
| beta | murtc-20260603t164332z-cf001e-beta | 376fc272-7923-4e5a-8c56-5bce2d056612 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}]} |
| gamma | murtc-20260603t164332z-cf001e-gamma | 5c19ce2a-dc0f-4055-8978-83cd6dcf5a84 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["3f554163-e2b6-4927-819d-f173a3611bcd"]}]} |
| delta | murtc-20260603t164332z-cf001e-delta | eb0724eb-b654-449c-b8ab-477fa64a1e59 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["3f554163-e2b6-4927-819d-f173a3611bcd"]}]} |
| epsilon | murtc-20260603t164332z-cf001e-epsilon | c84f0cbe-6862-4308-9c55-6cd8cfbf0c51 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t164332z-cf001e-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/bddaf0e0a1a2, alpha:murtc-20260603t164332z-cf001e-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/f1d5eb155646, beta:murtc-20260603t164332z-cf001e-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/6ff4cba47467, gamma:murtc-20260603t164332z-cf001e-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/42ba87b9641c, delta:murtc-20260603t164332z-cf001e-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/2a0c1c366e50, epsilon:murtc-20260603t164332z-cf001e-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/dc3e7563433d
- Deleted containers: epsilon:murtc-20260603t164332z-cf001e-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/dc3e7563433d, delta:murtc-20260603t164332z-cf001e-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/2a0c1c366e50, gamma:murtc-20260603t164332z-cf001e-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/42ba87b9641c, beta:murtc-20260603t164332z-cf001e-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/6ff4cba47467, alpha:murtc-20260603t164332z-cf001e-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/f1d5eb155646, alpha:murtc-20260603t164332z-cf001e-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/bddaf0e0a1a2
- Created users: 63c3c5d6-93be-43af-bd46-c978d5fddc4b, 376fc272-7923-4e5a-8c56-5bce2d056612, 5c19ce2a-dc0f-4055-8978-83cd6dcf5a84, eb0724eb-b654-449c-b8ab-477fa64a1e59, c84f0cbe-6862-4308-9c55-6cd8cfbf0c51
- Deleted users: 63c3c5d6-93be-43af-bd46-c978d5fddc4b, 376fc272-7923-4e5a-8c56-5bce2d056612, 5c19ce2a-dc0f-4055-8978-83cd6dcf5a84, eb0724eb-b654-449c-b8ab-477fa64a1e59, c84f0cbe-6862-4308-9c55-6cd8cfbf0c51
- Created images: 905ee94c-58b7-47a0-a34f-7ebd61a0f454, 3f554163-e2b6-4927-819d-f173a3611bcd
- Deleted images: 3f554163-e2b6-4927-819d-f173a3611bcd, 905ee94c-58b7-47a0-a34f-7ebd61a0f454

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["63c3c5d6-93be-43af-bd46-c978d5fddc4b","376fc272-7923-4e5a-8c56-5bce2d056612","5c19ce2a-dc0f-4055-8978-83cd6dcf5a84","eb0724eb-b654-449c-b8ab-477fa64a1e59","c84f0cbe-6862-4308-9c55-6cd8cfbf0c51"],"deletedImages":["3f554163-e2b6-4927-819d-f173a3611bcd","905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["63c3c5d6-93be-43af-bd46-c978d5fddc4b","376fc272-7923-4e5a-8c56-5bce2d056612","5c19ce2a-dc0f-4055-8978-83cd6dcf5a84","eb0724eb-b654-449c-b8ab-477fa64a1e59","c84f0cbe-6862-4308-9c55-6cd8cfbf0c51"],"imageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454","3f554163-e2b6-4927-819d-f173a3611bcd"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"63c3c5d6-93be-43af-bd46-c978d5fddc4b","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"376fc272-7923-4e5a-8c56-5bce2d056612","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"5c19ce2a-dc0f-4055-8978-83cd6dcf5a84","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["3f554163-e2b6-4927-819d-f173a3611bcd"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"eb0724eb-b654-449c-b8ab-477fa64a1e59","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["3f554163-e2b6-4927-819d-f173a3611bcd","905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"c84f0cbe-6862-4308-9c55-6cd8cfbf0c51","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["905ee94c-58b7-47a0-a34f-7ebd61a0f454"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"bddaf0e0a1a2","exactDockerId":"f1d5eb155646","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"6ff4cba47467","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"42ba87b9641c","deltaDockerId":"2a0c1c366e50","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/dc3e7563433d/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"dc3e7563433d","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # Killed OVER_CODE:137"}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: Error: timed out waiting for murtc-20260603t164332z-cf001e-b9-alpha (root cause: product)

Minimal reproducer: run prefix `murtc-20260603t164332z-cf001e` reached fresh fixture validity, CPU/memory quota boundaries, GPU bad-index/duplicate/over-count boundaries, disk runtime write proof, and pre-B9 cleanup/delete convergence. This verifies the prior `400 CPU quota exceeded` failure is fixed. B9 then attempted alpha `POST /api/containers` for `murtc-20260603t164332z-cf001e-b9-alpha` on CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` using alpha's own JWT with `cpuMillis: 1`, `memBytes: 1048576`, `gpuIndices: []`, and no `diskBytes`. The create request did not fail with quota error, but repeated `GET /api/containers?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70&ownOnly=true` did not show a matching container with non-empty `spec.dockerId` and non-creating/non-deleting state within 60s. Backend savepoint check across `/tmp/nyabase-backend*.log` found no `no such savepoint: typeorm_` matches. Tester cleanup recorded deleted users/images and tracked B6 containers; devops must include exact prefix `murtc-20260603t164332z-cf001e` in B11 product/API, DB, Docker, host path, and XFS scans because B9 stopped before final convergence checks.

## Devops Diagnostic/Cleanup: murtc-20260603t164332z-cf001e

Prepared: `2026-06-03T16:49Z`
Scope: exact-prefix read-only diagnosis plus safe cleanup for `murtc-20260603t164332z-cf001e`. Admin credentials from `test/.env` were used only in process; no raw token, password, API-token secret, SSH key, agent token, or generated user password is recorded.

### Backend Logs

- Log source: `/tmp/nyabase-backend-quota-deleting-exclusion-restart-productdb-20260603T163734Z.log` plus `/tmp/nyabase-backend*.log`.
- Exact-prefix grep found no prefix-specific backend exception lines. The backend log is sparse for operation payloads; durable DB operation/outbox rows are the authoritative operation trace.
- Around local `2026-06-04 00:42:25` through `00:47:05` (UTC `2026-06-03T16:42:25Z` through `16:47:05Z`), logs show repeated `MetricsWriter` `fetch failed`, CPU `stateReport` warnings for unknown numeric user IDs, repeated CPU `UNIQUE constraint failed: data_disk_runtime_observations.serverId, data_disk_runtime_observations.diskId, data_disk_runtime_observations.reportSeq`, and GPU desired-container import warnings for missing owner/name/image metadata. These did not correspond to B9 alpha create progress failure; the B9 alpha operation reached a terminal durable `failed` state.
- `grep -n "no such savepoint: typeorm_" /tmp/nyabase-backend*.log` returned no rows.

### Product/API Snapshot Before Cleanup

- Admin `GET /api/containers?all=true`: `11` exact-prefix matches.
- B9 rows before cleanup: `murtc-20260603t164332z-cf001e-b9-alpha`, `b9-beta`, `b9-epsilon`, `b9-delta`, and `b9-gamma` all had empty `spec.dockerId`, `status=unknown`, `lifecyclePhase=failed`, `powerIntent=running`, `cpuMillis=1`, `memBytes=1048576`; gamma had `gpuIndices=[0]`, the CPU rows had `gpuIndices=[]`.
- B6 rows before cleanup: six deleted/stopped rows remained with docker IDs `bddaf0e0a1a2`, `f1d5eb155646`, `6ff4cba47467`, `dc3e7563433d`, `42ba87b9641c`, and `2a0c1c366e50`.
- Admin `GET /api/users`, `GET /api/images`, and `GET /api/servers`: zero exact-prefix user/image/server matches. Tester admin cleanup had already removed users/images.

### Durable DB Diagnosis

- `containers`: `11` exact-prefix rows before cleanup. The B9 alpha row `428b3fba-5f2d-4628-a487-ca0af8cdf08e` was `lifecyclePhase=failed`, `dockerId=NULL`, `cpuMillis=1`, `memBytes=1048576`, created `2026-06-03 16:44:07`, updated `16:44:16`.
- `operations`: `17` exact-prefix/user operations before cleanup. B6 create/delete operations all succeeded. B9 alpha operation `592871ff-dad3-4044-8e87-83451439d9fa` was `container.create`, `status=failed`, `attempts=1`, `startedAt=2026-06-03 16:44:16.551`, `completedAt=2026-06-03 16:44:16.565`, `lastError=(HTTP code 400) bad parameter - Minimum memory limit allowed is 6MB`.
- `agent_command_outbox`: B9 alpha command `c37d169a-847a-4c78-9e88-f2cd3ce33ea7` was `createContainer`, `status=failed`, `attempts=1`, with the same Docker API error. The B9 beta/epsilon/delta/gamma create outbox rows failed with the same error. B6 create/delete outbox rows succeeded.
- `operation_steps`, `container_runtime_observations`, `reconcile_tasks`, and `quota_runtime_observations`: zero exact-prefix rows before cleanup. No runtime observation ever reported B9 alpha because Docker rejected container creation before a docker ID existed.
- `quota_desired`: six rows remained for the deleted fixture user IDs before cleanup.
- Diagnosis boundary: B9 alpha failed at Docker daemon create validation, surfaced through outbox/progress persistence into durable operation/container state. It was not an outbox dispatch stall, not a terminal-progress persistence miss, not a read-model-only mismatch, and not a runtime state-report convergence issue.

### Host/Runtime Scan

- CPU host `root@10.8.96.91`, managed Docker `/run/nyabase-agent/docker.sock`: no container matches for exact prefix or docker IDs `bddaf0e0a1a2`, `f1d5eb155646`, `6ff4cba47467`, `dc3e7563433d`, `42ba87b9641c`, `2a0c1c366e50`.
- CPU host paths under `/data/nyabase-docker` and `/data`: no exact-prefix/docker-ID path matches.
- GPU host `lyn@10.8.1.12`, managed Docker with `sudo -n env DOCKER_HOST=unix:///run/nyabase-agent/docker.sock`: no container matches for exact prefix or the known docker IDs.
- GPU host paths under `/data0/nbTest` and `/data0/nbTest/nyabase-docker-pquota`: no exact-prefix/docker-ID path matches.
- `/etc/projects` and `/etc/projid` exact-prefix scans found no prefix or docker-ID matches. Numeric project entries for prior disposable numeric users exist in Docker overlay quota files, but they are not exact-prefix identifiable and were not broad-cleaned.

### Cleanup

- Deleted exact-prefix durable rows linked to the 11 container IDs and five disposable user IDs: `agent_command_outbox=17`, `operations=17`, `containers=11`, and `quota_desired=6`; related runtime/steps/reconcile rows were already zero.
- Post-clean admin API: `/api/containers?all=true`, `/api/users`, and `/api/images` each returned zero exact-prefix matches.
- Post-clean DB counts: `containers=0`, `operations=0`, `agent_command_outbox=0`, `operation_steps=0`, `container_runtime_observations=0`, `quota_desired=0`, `users=0`, `images=0`. `PRAGMA foreign_key_check` returned no rows.
- Post-clean managed Docker and host path scans on CPU/GPU remained zero for exact prefix and known docker IDs.

Command: diagnostic/cleanup for murtc-20260603t164332z-cf001e
Exit code: 0
Backend log diagnosis: no prefix-specific backend exception or savepoint lines; B9 window logs contained unrelated VM write errors and state-report/data-disk duplicate warnings; durable operation/outbox rows show terminal Docker create failure.
Create convergence diagnosis: B9 alpha create was accepted by product quota/API path but failed at Docker create because `memBytes=1048576` is below Docker daemon minimum memory limit (`Minimum memory limit allowed is 6MB`); no dockerId could be produced.
Product/API residuals: before cleanup 11 exact-prefix containers were visible to admin, including five B9 failed rows with empty dockerId and six deleted B6 rows; users/images already zero. Post-clean API exact-prefix matches are zero.
Durable DB residuals: before cleanup 11 containers, 17 operations, 17 outbox rows, and 6 quota_desired rows remained; operation_steps/runtime/reconcile/quota_runtime rows were zero. Post-clean DB exact-prefix/user residual counts and foreign_key_check are zero.
Host/runtime residuals: no CPU/GPU managed Docker containers and no exact-prefix/docker-ID host paths remained; no exact-prefix `/etc/projects` or `/etc/projid` entries found. Numeric overlay quota entries were observed but not broad-cleaned because they were not exact-prefix-identifiable.
Cleanup: exact-prefix durable DB/API residuals removed; no Docker or host path deletion was needed.
No-savepoint regression check: pass
Frontend visual: skipped
Failing output (tail): none
Status: GREEN


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T16:55:18.193Z`
Run prefix: `murtc-20260603t165306z-1e52ac`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t165306z-1e52ac`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t165306z-1e52ac-alpha | 6e311399-5410-485c-b4d0-68658110c966 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]}]} |
| beta | murtc-20260603t165306z-1e52ac-beta | 32a42e55-5faf-427f-b84d-8ce71a09e6ce | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]}]} |
| gamma | murtc-20260603t165306z-1e52ac-gamma | be23ac38-a2a6-416f-8d91-bad98d046665 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["c0bbf598-7c95-4a7c-8340-9e20d549ace4"]}]} |
| delta | murtc-20260603t165306z-1e52ac-delta | dbca5a61-4cc5-4b16-967f-bc1da96e3bab | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["c0bbf598-7c95-4a7c-8340-9e20d549ace4"]}]} |
| epsilon | murtc-20260603t165306z-1e52ac-epsilon | 47580db6-28d5-432f-af20-4f073622e6a0 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t165306z-1e52ac-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/245d47101f13, alpha:murtc-20260603t165306z-1e52ac-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/08a3e8e19530, beta:murtc-20260603t165306z-1e52ac-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/7947adde6854, gamma:murtc-20260603t165306z-1e52ac-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/e396d9b08a89, delta:murtc-20260603t165306z-1e52ac-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/3533d32b4bb0, epsilon:murtc-20260603t165306z-1e52ac-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/8c2cc9148502, epsilon:murtc-20260603t165306z-1e52ac-b9-epsilon:05cea385-d6ca-490a-a126-e00d0ae23b70/f0e3849bcea5, gamma:murtc-20260603t165306z-1e52ac-b9-gamma:db1112fe-1c55-4314-9511-6d8510c523c2/12e3948efd9c, delta:murtc-20260603t165306z-1e52ac-b9-delta:05cea385-d6ca-490a-a126-e00d0ae23b70/beec60b2fdf7, alpha:murtc-20260603t165306z-1e52ac-b9-alpha:05cea385-d6ca-490a-a126-e00d0ae23b70/38cea0d354f6, beta:murtc-20260603t165306z-1e52ac-b9-beta:05cea385-d6ca-490a-a126-e00d0ae23b70/b20873119c96
- Deleted containers: epsilon:murtc-20260603t165306z-1e52ac-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/8c2cc9148502, delta:murtc-20260603t165306z-1e52ac-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/3533d32b4bb0, gamma:murtc-20260603t165306z-1e52ac-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/e396d9b08a89, beta:murtc-20260603t165306z-1e52ac-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/7947adde6854, alpha:murtc-20260603t165306z-1e52ac-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/08a3e8e19530, alpha:murtc-20260603t165306z-1e52ac-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/245d47101f13, beta:murtc-20260603t165306z-1e52ac-b9-beta:05cea385-d6ca-490a-a126-e00d0ae23b70/b20873119c96, alpha:murtc-20260603t165306z-1e52ac-b9-alpha:05cea385-d6ca-490a-a126-e00d0ae23b70/38cea0d354f6, delta:murtc-20260603t165306z-1e52ac-b9-delta:05cea385-d6ca-490a-a126-e00d0ae23b70/beec60b2fdf7, gamma:murtc-20260603t165306z-1e52ac-b9-gamma:db1112fe-1c55-4314-9511-6d8510c523c2/12e3948efd9c, epsilon:murtc-20260603t165306z-1e52ac-b9-epsilon:05cea385-d6ca-490a-a126-e00d0ae23b70/f0e3849bcea5
- Created users: 6e311399-5410-485c-b4d0-68658110c966, 32a42e55-5faf-427f-b84d-8ce71a09e6ce, be23ac38-a2a6-416f-8d91-bad98d046665, dbca5a61-4cc5-4b16-967f-bc1da96e3bab, 47580db6-28d5-432f-af20-4f073622e6a0
- Deleted users: 6e311399-5410-485c-b4d0-68658110c966, 32a42e55-5faf-427f-b84d-8ce71a09e6ce, be23ac38-a2a6-416f-8d91-bad98d046665, dbca5a61-4cc5-4b16-967f-bc1da96e3bab, 47580db6-28d5-432f-af20-4f073622e6a0
- Created images: 8463a6b8-5ad8-4be3-ab83-f213fce9a03f, c0bbf598-7c95-4a7c-8340-9e20d549ace4
- Deleted images: c0bbf598-7c95-4a7c-8340-9e20d549ace4, 8463a6b8-5ad8-4be3-ab83-f213fce9a03f

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["6e311399-5410-485c-b4d0-68658110c966","32a42e55-5faf-427f-b84d-8ce71a09e6ce","be23ac38-a2a6-416f-8d91-bad98d046665","dbca5a61-4cc5-4b16-967f-bc1da96e3bab","47580db6-28d5-432f-af20-4f073622e6a0"],"deletedImages":["c0bbf598-7c95-4a7c-8340-9e20d549ace4","8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["6e311399-5410-485c-b4d0-68658110c966","32a42e55-5faf-427f-b84d-8ce71a09e6ce","be23ac38-a2a6-416f-8d91-bad98d046665","dbca5a61-4cc5-4b16-967f-bc1da96e3bab","47580db6-28d5-432f-af20-4f073622e6a0"],"imageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f","c0bbf598-7c95-4a7c-8340-9e20d549ace4"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"6e311399-5410-485c-b4d0-68658110c966","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"32a42e55-5faf-427f-b84d-8ce71a09e6ce","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"be23ac38-a2a6-416f-8d91-bad98d046665","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["c0bbf598-7c95-4a7c-8340-9e20d549ace4"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"dbca5a61-4cc5-4b16-967f-bc1da96e3bab","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f","c0bbf598-7c95-4a7c-8340-9e20d549ace4"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"47580db6-28d5-432f-af20-4f073622e6a0","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["8463a6b8-5ad8-4be3-ab83-f213fce9a03f"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"245d47101f13","exactDockerId":"08a3e8e19530","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"7947adde6854","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"e396d9b08a89","deltaDockerId":"3533d32b4bb0","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/8c2cc9148502/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"8c2cc9148502","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # Killed OVER_CODE:137"}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: Error: timed out waiting for murtc-20260603t165306z-1e52ac-undefined (root cause: product)


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T16:59:12.641Z`
Run prefix: `murtc-20260603t165550z-589922`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t165550z-589922`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t165550z-589922-alpha | 3b2772ea-21b8-4dc8-834a-7700d55dc492 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}]} |
| beta | murtc-20260603t165550z-589922-beta | c31a21ac-eb9f-441d-a827-49a59af2b6eb | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}]} |
| gamma | murtc-20260603t165550z-589922-gamma | 04c8968b-3ba9-4190-8dd7-ce2be1fa158f | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["c512bc5c-cb47-47e1-9496-066220ce1e1f"]}]} |
| delta | murtc-20260603t165550z-589922-delta | f55cb85d-031a-4158-9daa-88df3a77e1b5 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["c512bc5c-cb47-47e1-9496-066220ce1e1f"]}]} |
| epsilon | murtc-20260603t165550z-589922-epsilon | e7254369-a8c9-4cd9-862b-9cc12b0e6364 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t165550z-589922-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/20945354b3e5, alpha:murtc-20260603t165550z-589922-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/73cbe81767db, beta:murtc-20260603t165550z-589922-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/36d7f619da0a, gamma:murtc-20260603t165550z-589922-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/0ebd1f8fa6cc, delta:murtc-20260603t165550z-589922-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/bea6e83f520c, epsilon:murtc-20260603t165550z-589922-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/47879e698ac9, alpha:murtc-20260603t165550z-589922-b9-alpha:05cea385-d6ca-490a-a126-e00d0ae23b70/6a5909097116, epsilon:murtc-20260603t165550z-589922-b9-epsilon:05cea385-d6ca-490a-a126-e00d0ae23b70/357a61862107, beta:murtc-20260603t165550z-589922-b9-beta:05cea385-d6ca-490a-a126-e00d0ae23b70/b616b9ba264f, delta:murtc-20260603t165550z-589922-b9-delta:05cea385-d6ca-490a-a126-e00d0ae23b70/bb7bf7abcd36, gamma:murtc-20260603t165550z-589922-b9-gamma:db1112fe-1c55-4314-9511-6d8510c523c2/873cae03948f, epsilon:murtc-20260603t165550z-589922-epsilon-race-a:05cea385-d6ca-490a-a126-e00d0ae23b70/4b624eabe528
- Deleted containers: epsilon:murtc-20260603t165550z-589922-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/47879e698ac9, delta:murtc-20260603t165550z-589922-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/bea6e83f520c, gamma:murtc-20260603t165550z-589922-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/0ebd1f8fa6cc, beta:murtc-20260603t165550z-589922-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/36d7f619da0a, alpha:murtc-20260603t165550z-589922-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/73cbe81767db, alpha:murtc-20260603t165550z-589922-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/20945354b3e5, epsilon:murtc-20260603t165550z-589922-epsilon-race-a:05cea385-d6ca-490a-a126-e00d0ae23b70/4b624eabe528, gamma:murtc-20260603t165550z-589922-b9-gamma:db1112fe-1c55-4314-9511-6d8510c523c2/873cae03948f, delta:murtc-20260603t165550z-589922-b9-delta:05cea385-d6ca-490a-a126-e00d0ae23b70/bb7bf7abcd36, beta:murtc-20260603t165550z-589922-b9-beta:05cea385-d6ca-490a-a126-e00d0ae23b70/b616b9ba264f, epsilon:murtc-20260603t165550z-589922-b9-epsilon:05cea385-d6ca-490a-a126-e00d0ae23b70/357a61862107, alpha:murtc-20260603t165550z-589922-b9-alpha:05cea385-d6ca-490a-a126-e00d0ae23b70/6a5909097116
- Created users: 3b2772ea-21b8-4dc8-834a-7700d55dc492, c31a21ac-eb9f-441d-a827-49a59af2b6eb, 04c8968b-3ba9-4190-8dd7-ce2be1fa158f, f55cb85d-031a-4158-9daa-88df3a77e1b5, e7254369-a8c9-4cd9-862b-9cc12b0e6364
- Deleted users: 3b2772ea-21b8-4dc8-834a-7700d55dc492, c31a21ac-eb9f-441d-a827-49a59af2b6eb, 04c8968b-3ba9-4190-8dd7-ce2be1fa158f, f55cb85d-031a-4158-9daa-88df3a77e1b5, e7254369-a8c9-4cd9-862b-9cc12b0e6364
- Created images: c7d00fa4-ffec-4ce1-90c3-8f8a86b74829, c512bc5c-cb47-47e1-9496-066220ce1e1f
- Deleted images: c512bc5c-cb47-47e1-9496-066220ce1e1f, c7d00fa4-ffec-4ce1-90c3-8f8a86b74829

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| alpha | direct-victim-selector | 200 | none | none | none |
| alpha | duplicate-user-id | 200 | none | none | none |
| alpha | regex-user-id | 200 | none | none | none |
| alpha | negative-matcher | 200 | none | none | none |
| alpha | or-expression | 200 | none | none | none |
| alpha | aggregation | 200 | none | none | none |
| alpha | aggregation-without | 200 | none | none | none |
| alpha | nested-rate-range | 200 | none | none | none |
| alpha | selector-less-nyabase | 200 | none | none | none |
| alpha | range-query | 200 | none | none | none |
| alpha | string-literal | 200 | none | none | none |
| alpha | non-nyabase-up | 200 | none | none | none |

### B9 Convergence / Cleanup

- Quota race: attempted `2`, success `1`, denied `1`, aggregate CPU `200`, aggregate mem `67108864`.
- Invariants: `{"noDuplicateDockerIds":true,"noStuckStates":true,"userVisibleRunContainers":["murtc-20260603t165550z-589922-b9-alpha:6a5909097116:unknown","murtc-20260603t165550z-589922-b9-beta:b616b9ba264f:unknown","murtc-20260603t165550z-589922-b9-delta:bb7bf7abcd36:unknown","murtc-20260603t165550z-589922-epsilon-race-a:4b624eabe528:unknown","murtc-20260603t165550z-589922-b9-epsilon:357a61862107:unknown","murtc-20260603t165550z-589922-b9-gamma:873cae03948f:unknown"],"quotaRace":{"attempted":2,"success":1,"denied":1,"aggregateCpuMillis":200,"aggregateMemBytes":67108864}}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["3b2772ea-21b8-4dc8-834a-7700d55dc492","c31a21ac-eb9f-441d-a827-49a59af2b6eb","04c8968b-3ba9-4190-8dd7-ce2be1fa158f","f55cb85d-031a-4158-9daa-88df3a77e1b5","e7254369-a8c9-4cd9-862b-9cc12b0e6364"],"deletedImages":["c512bc5c-cb47-47e1-9496-066220ce1e1f","c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["3b2772ea-21b8-4dc8-834a-7700d55dc492","c31a21ac-eb9f-441d-a827-49a59af2b6eb","04c8968b-3ba9-4190-8dd7-ce2be1fa158f","f55cb85d-031a-4158-9daa-88df3a77e1b5","e7254369-a8c9-4cd9-862b-9cc12b0e6364"],"imageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829","c512bc5c-cb47-47e1-9496-066220ce1e1f"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"3b2772ea-21b8-4dc8-834a-7700d55dc492","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"c31a21ac-eb9f-441d-a827-49a59af2b6eb","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"04c8968b-3ba9-4190-8dd7-ce2be1fa158f","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["c512bc5c-cb47-47e1-9496-066220ce1e1f"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f55cb85d-031a-4158-9daa-88df3a77e1b5","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["c512bc5c-cb47-47e1-9496-066220ce1e1f","c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"e7254369-a8c9-4cd9-862b-9cc12b0e6364","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["c7d00fa4-ffec-4ce1-90c3-8f8a86b74829"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"20945354b3e5","exactDockerId":"73cbe81767db","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"36d7f619da0a","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"0ebd1f8fa6cc","deltaDockerId":"bea6e83f520c","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/47879e698ac9/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"47879e698ac9","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # dd: error writing '/tmp/nyabase-di"}`.
- B9 five-user near-concurrent create lifecycle quota race: actor `epsilon`, POST `/containers + lifecycle endpoints`, status `201`, expected five personas created near-concurrently; lifecycle converged; race did not oversubscribe quota, ids `{"actorCount":5,"createdDockerIds":["6a5909097116","b616b9ba264f","bb7bf7abcd36","357a61862107","873cae03948f"],"raceSuccess":1,"raceDenied":1,"noDuplicateDockerIds":true}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/host?range=5m`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/users?range=5m`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/containers?range=5m`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/containers?range=5m&all=true`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/db1112fe-1c55-4314-9511-6d8510c523c2/gpus?range=5m`, status `404`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 raw PromQL bypass matrix: actor `alpha`, GET `/metrics/query + /metrics/query_range`, status `200`, expected all required bypass probes returned no victim identifiers, ids `{"probes":["direct-victim-selector","duplicate-user-id","regex-user-id","negative-matcher","or-expression","aggregation","aggregation-without","nested-rate-range","selector-less-nyabase","range-query","string-literal","non-nyabase-up"],"victimCount":4}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: AssertionError: expected '[{"id":"2604f41e-d8ba-4821-b5a0-0ce31…' to match /CreateContainer\|DeleteContainer\|Resta…/ (root cause: product)


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-03T17:03:43.179Z`
Run prefix: `murtc-20260603t170009z-fa3173`
Command: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `pass`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/tmp/nyabase-murtc-20260603t170009z-fa3173`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260603t170009z-fa3173-alpha | 3974aa15-a855-453a-980c-248a46bfec82 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331"]}]} |
| beta | murtc-20260603t170009z-fa3173-beta | b8a1501c-108b-4f97-b75c-cc99b9740f98 | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331"]}]} |
| gamma | murtc-20260603t170009z-fa3173-gamma | 4652464d-1161-4c8b-83ef-4c086f4979e4 | none | {"servers":[{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["7ef01a83-175e-4111-92a3-a0061118a548"]}]} |
| delta | murtc-20260603t170009z-fa3173-delta | 0260aa95-66ac-44eb-8415-871a5f702c7c | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331"]},{"serverId":"db1112fe-1c55-4314-9511-6d8510c523c2","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["7ef01a83-175e-4111-92a3-a0061118a548"]}]} |
| epsilon | murtc-20260603t170009z-fa3173-epsilon | c342b0d1-5c95-4015-9cec-d938475fa27f | none | {"servers":[{"serverId":"05cea385-d6ca-490a-a126-e00d0ae23b70","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260603t170009z-fa3173-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/65071f7806e9, alpha:murtc-20260603t170009z-fa3173-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/d0601b0ecc67, beta:murtc-20260603t170009z-fa3173-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/968a123de865, gamma:murtc-20260603t170009z-fa3173-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/c21ead0d52c7, delta:murtc-20260603t170009z-fa3173-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/ef4b68008080, epsilon:murtc-20260603t170009z-fa3173-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/f1be1767195d, alpha:murtc-20260603t170009z-fa3173-b9-alpha:05cea385-d6ca-490a-a126-e00d0ae23b70/406e024006b5, epsilon:murtc-20260603t170009z-fa3173-b9-epsilon:05cea385-d6ca-490a-a126-e00d0ae23b70/c39412816cbc, beta:murtc-20260603t170009z-fa3173-b9-beta:05cea385-d6ca-490a-a126-e00d0ae23b70/5ac9106f163f, gamma:murtc-20260603t170009z-fa3173-b9-gamma:db1112fe-1c55-4314-9511-6d8510c523c2/7feda2f2e319, delta:murtc-20260603t170009z-fa3173-b9-delta:05cea385-d6ca-490a-a126-e00d0ae23b70/61cadb606686, epsilon:murtc-20260603t170009z-fa3173-epsilon-race-a:05cea385-d6ca-490a-a126-e00d0ae23b70/f2bb3e09711c
- Deleted containers: epsilon:murtc-20260603t170009z-fa3173-alpha-disk-runtime:05cea385-d6ca-490a-a126-e00d0ae23b70/f1be1767195d, delta:murtc-20260603t170009z-fa3173-delta-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/ef4b68008080, gamma:murtc-20260603t170009z-fa3173-gamma-gpu-granted:db1112fe-1c55-4314-9511-6d8510c523c2/c21ead0d52c7, beta:murtc-20260603t170009z-fa3173-beta-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/968a123de865, alpha:murtc-20260603t170009z-fa3173-alpha-exact:05cea385-d6ca-490a-a126-e00d0ae23b70/d0601b0ecc67, alpha:murtc-20260603t170009z-fa3173-alpha-below:05cea385-d6ca-490a-a126-e00d0ae23b70/65071f7806e9, epsilon:murtc-20260603t170009z-fa3173-epsilon-race-a:05cea385-d6ca-490a-a126-e00d0ae23b70/f2bb3e09711c, delta:murtc-20260603t170009z-fa3173-b9-delta:05cea385-d6ca-490a-a126-e00d0ae23b70/61cadb606686, gamma:murtc-20260603t170009z-fa3173-b9-gamma:db1112fe-1c55-4314-9511-6d8510c523c2/7feda2f2e319, beta:murtc-20260603t170009z-fa3173-b9-beta:05cea385-d6ca-490a-a126-e00d0ae23b70/5ac9106f163f, epsilon:murtc-20260603t170009z-fa3173-b9-epsilon:05cea385-d6ca-490a-a126-e00d0ae23b70/c39412816cbc, alpha:murtc-20260603t170009z-fa3173-b9-alpha:05cea385-d6ca-490a-a126-e00d0ae23b70/406e024006b5
- Created users: 3974aa15-a855-453a-980c-248a46bfec82, b8a1501c-108b-4f97-b75c-cc99b9740f98, 4652464d-1161-4c8b-83ef-4c086f4979e4, 0260aa95-66ac-44eb-8415-871a5f702c7c, c342b0d1-5c95-4015-9cec-d938475fa27f
- Deleted users: 3974aa15-a855-453a-980c-248a46bfec82, b8a1501c-108b-4f97-b75c-cc99b9740f98, 4652464d-1161-4c8b-83ef-4c086f4979e4, 0260aa95-66ac-44eb-8415-871a5f702c7c, c342b0d1-5c95-4015-9cec-d938475fa27f
- Created images: 0c29f749-85c1-4851-9e3a-d22c10ab2331, 7ef01a83-175e-4111-92a3-a0061118a548
- Deleted images: 7ef01a83-175e-4111-92a3-a0061118a548, 0c29f749-85c1-4851-9e3a-d22c10ab2331

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| alpha | direct-victim-selector | 200 | none | none | none |
| alpha | duplicate-user-id | 200 | none | none | none |
| alpha | regex-user-id | 200 | none | none | none |
| alpha | negative-matcher | 200 | none | none | none |
| alpha | or-expression | 200 | none | none | none |
| alpha | aggregation | 200 | none | none | none |
| alpha | aggregation-without | 200 | none | none | none |
| alpha | nested-rate-range | 200 | none | none | none |
| alpha | selector-less-nyabase | 200 | none | none | none |
| alpha | range-query | 200 | none | none | none |
| alpha | string-literal | 200 | none | none | none |
| alpha | non-nyabase-up | 200 | none | none | none |

### B9 Convergence / Cleanup

- Quota race: attempted `2`, success `1`, denied `1`, aggregate CPU `200`, aggregate mem `67108864`.
- Invariants: `{"noDuplicateDockerIds":true,"noStuckStates":true,"userVisibleRunContainers":["murtc-20260603t170009z-fa3173-b9-alpha:406e024006b5:unknown","murtc-20260603t170009z-fa3173-b9-beta:5ac9106f163f:unknown","murtc-20260603t170009z-fa3173-b9-delta:61cadb606686:unknown","murtc-20260603t170009z-fa3173-epsilon-race-a:f2bb3e09711c:unknown","murtc-20260603t170009z-fa3173-b9-epsilon:c39412816cbc:unknown","murtc-20260603t170009z-fa3173-b9-gamma:7feda2f2e319:running"],"quotaRace":{"attempted":2,"success":1,"denied":1,"aggregateCpuMillis":200,"aggregateMemBytes":67108864}}`
- Cleanup: `{"status":"admin-cleanup-finished","userVisibleResiduals":{"alpha":[],"beta":[],"gamma":[],"delta":[],"epsilon":[]},"deletedUsers":["3974aa15-a855-453a-980c-248a46bfec82","b8a1501c-108b-4f97-b75c-cc99b9740f98","4652464d-1161-4c8b-83ef-4c086f4979e4","0260aa95-66ac-44eb-8415-871a5f702c7c","c342b0d1-5c95-4015-9cec-d938475fa27f"],"deletedImages":["7ef01a83-175e-4111-92a3-a0061118a548","0c29f749-85c1-4851-9e3a-d22c10ab2331"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"05cea385-d6ca-490a-a126-e00d0ae23b70","gpuServerId":"db1112fe-1c55-4314-9511-6d8510c523c2","userIds":["3974aa15-a855-453a-980c-248a46bfec82","b8a1501c-108b-4f97-b75c-cc99b9740f98","4652464d-1161-4c8b-83ef-4c086f4979e4","0260aa95-66ac-44eb-8415-871a5f702c7c","c342b0d1-5c95-4015-9cec-d938475fa27f"],"imageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331","7ef01a83-175e-4111-92a3-a0061118a548"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"3974aa15-a855-453a-980c-248a46bfec82","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"b8a1501c-108b-4f97-b75c-cc99b9740f98","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"4652464d-1161-4c8b-83ef-4c086f4979e4","visibleServerIds":["db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["7ef01a83-175e-4111-92a3-a0061118a548"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"0260aa95-66ac-44eb-8415-871a5f702c7c","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70","db1112fe-1c55-4314-9511-6d8510c523c2"],"visibleImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331","7ef01a83-175e-4111-92a3-a0061118a548"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"c342b0d1-5c95-4015-9cec-d938475fa27f","visibleServerIds":["05cea385-d6ca-490a-a126-e00d0ae23b70"],"visibleImageIds":["0c29f749-85c1-4851-9e3a-d22c10ab2331"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"65071f7806e9","exactDockerId":"d0601b0ecc67","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"968a123de865","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"c21ead0d52c7","deltaDockerId":"ef4b68008080","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/f1be1767195d/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"f1be1767195d","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # dd: error writing '/tmp/nyabase-di"}`.
- B9 five-user near-concurrent create lifecycle quota race: actor `epsilon`, POST `/containers + lifecycle endpoints`, status `201`, expected five personas created near-concurrently; lifecycle converged; race did not oversubscribe quota, ids `{"actorCount":5,"createdDockerIds":["406e024006b5","5ac9106f163f","61cadb606686","c39412816cbc","7feda2f2e319"],"raceSuccess":1,"raceDenied":1,"noDuplicateDockerIds":true}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/host?range=5m`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/users?range=5m`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/containers?range=5m`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/containers?range=5m&all=true`, status `200`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 scoped metrics endpoint: actor `alpha`, GET `/metrics/servers/db1112fe-1c55-4314-9511-6d8510c523c2/gpus?range=5m`, status `404`, expected normal user endpoint contains no victim identifiers, ids `{"leakedVictimIds":[],"leakedVictimNames":[],"leakedVictimContainers":[]}`.
- B10 raw PromQL bypass matrix: actor `alpha`, GET `/metrics/query + /metrics/query_range`, status `200`, expected all required bypass probes returned no victim identifiers, ids `{"probes":["direct-victim-selector","duplicate-user-id","regex-user-id","negative-matcher","or-expression","aggregation","aggregation-without","nested-rate-range","selector-less-nyabase","range-query","string-literal","non-nyabase-up"],"victimCount":4}`.
- B10 audit visibility: actor `alpha`, GET `/audit?limit=20`, status `403`, expected normal user denied; admin observes representative setup/lifecycle events, ids `{"normalUserStatus":403,"adminStatus":200,"auditRows":100,"actorIdSeen":true}`.
- user-state cleanup residual check: actor `n/a`, GET `/containers?ownOnly=true`, status `200`, expected zero exact-prefix containers visible to all five users, ids `{"residualCounts":{"alpha":0,"beta":0,"gamma":0,"delta":0,"epsilon":0}}`.

### Failures

- none

### Supplemental Backend Log / B11 Notes

## Final B11 Residual Sweep And DoD Check

Prepared: `2026-06-03T17:11:51Z`
Role: devops
Scope: final exact-prefix residual cleanup/verification for all continuation `murtc-*` prefixes recorded in this file, including requested failed prefixes and latest PASS prefix `murtc-20260603t170009z-fa3173`; then `bash scripts/check.sh`. No product source or tests were edited. Visual suite was not run except as part of `scripts/check.sh`; `scripts/check.sh` was invoked without `--with-visual`.

Continuation prefixes scanned: `murtc-20260603t145052z-c616aa`, `murtc-20260603t145306z-b70680`, `murtc-20260603t150204z-f4ed09`, `murtc-20260603t151358z-d62df3`, `murtc-20260603t152020z-1f46a9`, `murtc-20260603t152621z-85f660`, `murtc-20260603t152647z-3c96f7`, `murtc-20260603t152826z-3e786d`, `murtc-20260603t154630z-8531e6`, `murtc-20260603t155125z-4c16fc`, `murtc-20260603t160041z-7ca035`, `murtc-20260603t160145z-d9e089`, `murtc-20260603t160243z-2adeda`, `murtc-20260603t162119z-4e5b35`, `murtc-20260603t164332z-cf001e`, `murtc-20260603t165306z-1e52ac`, `murtc-20260603t165550z-589922`, `murtc-20260603t170009z-fa3173`.

### Residual Sweep

| Surface | Status | Evidence |
| --- | --- | --- |
| Latest PASS prefix discovery | pass | Latest `Classification: pass` live continuation run in this file is `murtc-20260603t170009z-fa3173`; included in final scans with all known failed continuation prefixes. |
| Product/admin API exact-prefix scan | pass | Admin API `GET /users`, `GET /images`, `GET /containers`, and user-grant endpoints showed `users=0`, `containers=0`, `images=0`, `serverGrants=0`, `imageGrants=0`, `mountGrants=0` for the 18 exact prefixes. |
| Durable DB exact-prefix scan before cleanup | pass-cleaned | Live DB `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db` initially had exact-prefix rows: `containers=54`, `operations=54`, `agent_command_outbox=54`; `users/images/grants/runtime/quota/reconcile` were already `0`. |
| Durable DB exact-prefix cleanup/recheck | pass | Deleted only rows matching the listed prefixes from dependent runtime/control tables, then parent `operations`/`containers`. Recheck: `users=0`, `images=0`, `server_grants=0`, `image_grants=0`, `mount_source_grants=0`, `containers=0`, `operations=0`, `agent_command_outbox=0`, `runtime_observations=0`, `quota_desired=0`, `reconcile_tasks=0`. |
| DB foreign key check | pass | `PRAGMA foreign_key_check` returned no rows after cleanup. |
| CPU managed Docker exact-prefix cleanup/recheck | pass | CPU `root@10.8.96.91` initially had 13 exact-prefix managed Docker containers, including one running container from `murtc-20260603t165306z-1e52ac`; removed only `murtc-` named containers. Final recheck: `docker_name=0`, `docker_known_id=0`, `/data` path matches `0`, `/etc/projects`/`/etc/projid` matches `0`, XFS project-name matches `0`. |
| GPU managed Docker exact-prefix cleanup/recheck | pass | GPU `lyn@10.8.1.12` initially had 11 exact-prefix managed Docker containers; removed only `murtc-` named containers. Final recheck: `docker_name=0`, `docker_known_id=0`, `/data0/nbTest/nyabase-docker-pquota` path matches `0`, `/etc/projects`/`/etc/projid` matches `0`, XFS project-name matches `0`. |
| Backend savepoint regression log check | pass | Active backend log `/tmp/nyabase-backend-quota-deleting-exclusion-restart-productdb-20260603T163734Z.log` contains no `no such savepoint: typeorm_` after the final PASS window. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

### DoD Check

Command: final residual sweep + bash scripts/check.sh
Exit code: 1
Backend typecheck: pass
Backend lint: pass
Backend tests: 138/1/0
Frontend typecheck: pass
Frontend lint: pass
Frontend tests: 0/0/0 (not reached; script stopped at backend tests)
Frontend visual: skipped
Residual sweep: pass
Common-src artifact guard: pass
Failing output (tail): `packages/backend/src/containers/__tests__/resource-quota.policy.test.ts > resolveGpuIndices > GpuGrantMode.None > passes with empty gpuIndices array (no GPU request)` failed: `AssertionError: expected undefined to deeply equal []` at line `147`; backend Vitest summary `Test Files 1 failed | 27 passed (28)`, `Tests 1 failed | 138 passed (139)`.
Status: RED

- Tester command result: `pnpm exec vitest run test/multi-user-redteam-continuation.spec.ts --reporter=verbose` passed with `1` test passed, `0` failed, `0` skipped.
- Backend savepoint regression check after rerun: `grep -n "no such savepoint: typeorm_" /tmp/nyabase-backend*.log /tmp/nyabase-backend*setsid.log 2>/dev/null | tail -n 20 || true` returned no matches.
- Current exact prefix requiring devops B11 final host-level confirmation: `murtc-20260603t170009z-fa3173`.
- Prior failed prefixes to include only if not already closed by devops final scan history: `murtc-20260603t165550z-589922` and earlier failed prefixes recorded above; devops has already reported cleanup complete for `murtc-20260603t164332z-cf001e`.
- Devops B11 final scans/checks needed for the current pass prefix: product/API exact-prefix search, managed Docker containers on CPU/GPU hosts, host data/workdir paths, and XFS project/projid quota entries. Suggested exact-prefix checks are `docker ps -a --filter "name=murtc-20260603t170009z-fa3173"`, host path `find`/`grep` for the prefix under managed nyabase data roots, and quota project/projid scans for the prefix on both CPU and GPU hosts.

## Backend Unit Rerun After GPU Empty-Array Semantics Update

Prepared: `2026-06-03T17:13:28Z`
Command: `pnpm exec vitest run packages/backend/src/containers/__tests__/resource-quota.policy.test.ts --reporter=verbose`
Classification: `pass`
Visual artifacts: n/a (backend unit test)

Change under test: `packages/backend/src/containers/__tests__/resource-quota.policy.test.ts` now expects `resolveGpuIndices()` to return `undefined` for `GpuGrantMode.None` with `gpuIndices: []`, preserving coverage that an empty array is accepted as a no-GPU request after product normalization.

Result: `1` test file passed, `27` tests passed, `0` failed, `0` skipped.

Failures: none.

## Full DoD Check After Unit Expectation Update

Prepared: `2026-06-03T17:14:31Z`
Role: devops

Command: bash scripts/check.sh after unit expectation update
Exit code: 0
Backend typecheck: pass
Backend lint: pass
Backend tests: 139/0/0
Frontend typecheck: pass
Frontend lint: pass
Frontend tests: 0/0/0
Frontend visual: skipped
Common-src artifact guard: pass
Failing output (tail): none
Status: GREEN

## Current-State Read-Only DevOps Audit 2026-06-04T01:17:43Z

Prepared: `2026-06-04T01:17:43Z`
Role: devops
Scope: current-state read-only / verification-first audit for local backend/frontend/VictoriaMetrics, CPU/GPU agent and product server online state, common-src artifact guard, `bash scripts/check.sh`, and exact-prefix `murtc-*` residual scan. No product source, test source, config, lockfile, remote resource, container, quota entry, or host path was edited, restarted, deleted, or cleaned. Admin credentials from `test/.env` were used only in-process; no raw secret, password, JWT, refresh token, API token, or agent token is recorded.

Overall classification: `pass`

### Local Services

| Surface | Status | Evidence |
| --- | --- | --- |
| Backend auth guard | pass | `curl --max-time 8 http://localhost:3001/api/auth/me` returned HTTP `401`; body tail `{"message":"Unauthorized","statusCode":401}`. |
| Frontend root | pass | `curl --max-time 8 http://localhost:5173/` returned HTTP `200`; body begins `<!doctype html> <html lang="en">`. |
| VictoriaMetrics health/query | pass | `/health` returned HTTP `200` body `OK`; `/api/v1/query?query=up` returned HTTP `200`, JSON `status=success`, `resultType=vector`, `results=0`. |
| Product API login/readback | pass | Admin login returned HTTP `200`; `GET /api/servers` returned HTTP `200`; admin user `admin`, capability count `8`. |

### CPU/GPU Agent And Product Online State

| Surface | Status | Evidence |
| --- | --- | --- |
| Product CPU server online | pass | `nyabase-cpu-batch-20260601T163636Z` id `05cea385-d6ca-490a-a126-e00d0ae23b70`, `isGpuServer=false`, status `online`, `lastSeenAt=2026-06-04T01:13:29.138Z`. |
| Product GPU server online | pass | `nyabase-gpu-batch-20260601T163636Z` id `db1112fe-1c55-4314-9511-6d8510c523c2`, `isGpuServer=true`, status `online`, `lastSeenAt=2026-06-04T01:13:27.160Z`. |
| CPU host `root@10.8.96.91` | pass | Host `nyabase-test-1`; `nyabase-agent` active since `2026-06-03 22:59:45 CST`; `nyabase-docker.service` active since `2026-06-03 22:59:47 CST`; managed Docker `29.4.3`, root `/data/nyabase-docker`, cgroup `systemd`; `/data` XFS `prjquota`, project quota accounting/enforcement `ON`, `32G` size, `11%` used. |
| GPU host `lyn@10.8.1.12` | pass | Host `aya-1`; `nyabase-agent` active since `2026-06-03 14:58:58 UTC`; `nyabase-docker.service` active since `2026-06-03 14:59:00 UTC`; managed Docker `29.0.2`, root `/data0/nbTest/nyabase-docker-pquota`, runtimes include `nvidia`; four `NVIDIA L40` GPUs reported by `nvidia-smi`; XFS project quota accounting/enforcement `ON`, `20G` size, `2%` used. |
| GPU quota warning tail | pass | `xfs_quota` again printed stale overlay path warnings before the quota state block; accounting/enforcement still reached `ON`, matching earlier infra behavior. |

### Common-Source Artifact Guard

Command: `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`

Result: no paths; count `0`.

### DoD Check

Command: `bash scripts/check.sh`
Exit code: `0`
Backend typecheck: pass
Backend lint: pass
Backend tests: `139/0/0`
Frontend typecheck: pass
Frontend lint: pass
Frontend tests: `0/0/0`
Frontend visual: skipped
Common-src artifact guard: pass
Failing output (tail): none
Status: GREEN

Notes: lint emitted `13` warnings and `0` errors; `scripts/check.sh` remained green. Unit-test totals were common `45/0/0`, backend `139/0/0`, agent `71/0/0`.

### Exact-Prefix Residual Scan

Run prefixes scanned from this file: `murtc-20260603t145052z-c616aa`, `murtc-20260603t145306z-b70680`, `murtc-20260603t150204z-f4ed09`, `murtc-20260603t151358z-d62df3`, `murtc-20260603t152020z-1f46a9`, `murtc-20260603t152621z-85f660`, `murtc-20260603t152647z-3c96f7`, `murtc-20260603t152826z-3e786d`, `murtc-20260603t154630z-8531e6`, `murtc-20260603t155125z-4c16fc`, `murtc-20260603t160041z-7ca035`, `murtc-20260603t162119z-4e5b35`, `murtc-20260603t160145z-d9e089`, `murtc-20260603t160243z-2adeda`, `murtc-20260603t164332z-cf001e`, `murtc-20260603t165306z-1e52ac`, `murtc-20260603t165550z-589922`, `murtc-20260603t170009z-fa3173`.

Latest PASS prefix confirmed from this file: `murtc-20260603t170009z-fa3173`.

| Surface | Status | Evidence |
| --- | --- | --- |
| Product/admin API exact-prefix scan | pass | `GET /api/users`, `/api/images`, `/api/containers`, and matching-user grant endpoints returned exact-prefix counts `users=0`, `images=0`, `containers=0`, `serverGrants=0`, `imageGrants=0`, `mountGrants=0`. Latest PASS prefix counts were `users=0`, `images=0`, `containers=0`. |
| Durable SQLite exact-prefix sample | pass | On `DB_PATH` from `test/.env`, exact-prefix counts were `users=0`, `images=0`, `containers=0`, `operations=0`, `agent_command_outbox=0`, `container_runtime_observations=0`, `quota_desired=0`, `reconcile_tasks=0`; latest PASS prefix counts were `users=0`, `images=0`, `containers=0`; `PRAGMA foreign_key_check` count `0`. |
| CPU managed Docker / host path / quota scan | pass | CPU host counts: managed Docker names `0`, latest PASS Docker names `0`, `/data` path matches `0`, latest PASS `/data` path matches `0`, `/etc/projects`/`/etc/projid` matches `0`, latest PASS project/projid matches `0`, XFS project-name matches `0`, latest PASS XFS project-name matches `0`. |
| GPU managed Docker / host path / quota scan | pass | GPU host counts: managed Docker names `0`, latest PASS Docker names `0`, `/data0/nbTest/nyabase-docker-pquota` path matches `0`, latest PASS host path matches `0`, `/etc/projects`/`/etc/projid` matches `0`, latest PASS project/projid matches `0`, XFS project-name matches `0`, latest PASS XFS project-name matches `0`. |

### Blockers / Failures

None. No `fail-product`, `fail-test`, `fail-infra`, or `blocked-infra` classification was needed.


## Tester Live Continuation B6/B9/B10

Prepared: `2026-06-04T15:25:09.441Z`
Run prefix: `murtc-20260604t152325z-3de301`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-continuation.spec.ts --reporter=verbose`
Backend URL: `http://localhost:3001`
Classification: `fail-product`
Visual artifacts: n/a (backend/API/runtime live test)

Secrets redaction: admin password from `test/config/local.env`, raw JWTs, refresh tokens, API-token secrets, and generated user passwords were used only in process or temp credential files under `/root/nyabase/test/runtime/murtc/20260604t152325z-3de301`; none are recorded here.

### Actor Validity

| Persona | Username | User ID | Management caps | Access summary |
| --- | --- | --- | --- | --- |
| alpha | murtc-20260604t152325z-3de301-alpha | b56a5e04-7d50-4d78-b7a3-5aa59eafd317 | none | {"servers":[{"serverId":"1b9c08fa-32e1-4943-8dc5-d83772cd52f9","cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["24cf1488-e911-4477-b6db-337f8d11460a"]}]} |
| beta | murtc-20260604t152325z-3de301-beta | 0d97efa5-82fe-4735-8131-2571a4053ac0 | none | {"servers":[{"serverId":"1b9c08fa-32e1-4943-8dc5-d83772cd52f9","cpuMillis":1000,"memBytes":536870912,"diskBytes":134217728,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["24cf1488-e911-4477-b6db-337f8d11460a"]}]} |
| gamma | murtc-20260604t152325z-3de301-gamma | f8e10f7d-5f51-461d-b620-486c367f2fdd | none | {"servers":[{"serverId":"343488f6-2689-488a-8bf8-8c02caf25989","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[0],"allowedImageIds":["752d469c-77b7-42bd-af85-338d9ad70fb0"]}]} |
| delta | murtc-20260604t152325z-3de301-delta | 94ec3442-79be-44e2-ac8f-0499752294ab | none | {"servers":[{"serverId":"1b9c08fa-32e1-4943-8dc5-d83772cd52f9","cpuMillis":1500,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["24cf1488-e911-4477-b6db-337f8d11460a"]},{"serverId":"343488f6-2689-488a-8bf8-8c02caf25989","cpuMillis":1000,"memBytes":1073741824,"diskBytes":268435456,"gpuMode":"indices","gpuIndices":[1],"allowedImageIds":["752d469c-77b7-42bd-af85-338d9ad70fb0"]}]} |
| epsilon | murtc-20260604t152325z-3de301-epsilon | 7627a940-cc5a-469f-9148-c609a636fc3e | none | {"servers":[{"serverId":"1b9c08fa-32e1-4943-8dc5-d83772cd52f9","cpuMillis":250,"memBytes":134217728,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[],"allowedImageIds":["24cf1488-e911-4477-b6db-337f8d11460a"]}]} |

### Created / Deleted Runtime IDs

- Created containers: alpha:murtc-20260604t152325z-3de301-alpha-below:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/31b361afd297, alpha:murtc-20260604t152325z-3de301-alpha-exact:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/01539d391a17, beta:murtc-20260604t152325z-3de301-beta-exact:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/f1124311c8db, gamma:murtc-20260604t152325z-3de301-gamma-gpu-granted:343488f6-2689-488a-8bf8-8c02caf25989/ac63a76a9b99, delta:murtc-20260604t152325z-3de301-delta-gpu-granted:343488f6-2689-488a-8bf8-8c02caf25989/2f5751960b3f, epsilon:murtc-20260604t152325z-3de301-alpha-disk-runtime:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/8bae01e9c905, delta:murtc-20260604t152325z-3de301-b9-delta:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/01a042376b02, alpha:murtc-20260604t152325z-3de301-b9-alpha:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/7a423156b2c7, gamma:murtc-20260604t152325z-3de301-b9-gamma:343488f6-2689-488a-8bf8-8c02caf25989/0da8a32c1b9b
- Deleted containers: epsilon:murtc-20260604t152325z-3de301-alpha-disk-runtime:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/8bae01e9c905, delta:murtc-20260604t152325z-3de301-delta-gpu-granted:343488f6-2689-488a-8bf8-8c02caf25989/2f5751960b3f, gamma:murtc-20260604t152325z-3de301-gamma-gpu-granted:343488f6-2689-488a-8bf8-8c02caf25989/ac63a76a9b99, beta:murtc-20260604t152325z-3de301-beta-exact:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/f1124311c8db, alpha:murtc-20260604t152325z-3de301-alpha-exact:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/01539d391a17, alpha:murtc-20260604t152325z-3de301-alpha-below:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/31b361afd297, gamma:murtc-20260604t152325z-3de301-b9-gamma:343488f6-2689-488a-8bf8-8c02caf25989/0da8a32c1b9b, alpha:murtc-20260604t152325z-3de301-b9-alpha:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/7a423156b2c7, delta:murtc-20260604t152325z-3de301-b9-delta:1b9c08fa-32e1-4943-8dc5-d83772cd52f9/01a042376b02
- Created users: b56a5e04-7d50-4d78-b7a3-5aa59eafd317, 0d97efa5-82fe-4735-8131-2571a4053ac0, f8e10f7d-5f51-461d-b620-486c367f2fdd, 94ec3442-79be-44e2-ac8f-0499752294ab, 7627a940-cc5a-469f-9148-c609a636fc3e
- Deleted users: b56a5e04-7d50-4d78-b7a3-5aa59eafd317, 0d97efa5-82fe-4735-8131-2571a4053ac0, f8e10f7d-5f51-461d-b620-486c367f2fdd, 94ec3442-79be-44e2-ac8f-0499752294ab, 7627a940-cc5a-469f-9148-c609a636fc3e
- Created images: 24cf1488-e911-4477-b6db-337f8d11460a, 752d469c-77b7-42bd-af85-338d9ad70fb0
- Deleted images: 752d469c-77b7-42bd-af85-338d9ad70fb0, 24cf1488-e911-4477-b6db-337f8d11460a

### PromQL / Metrics Probes

| Actor | Probe | HTTP status | Victim user IDs returned | Victim usernames returned | Victim containers returned |
| --- | ---: | ---: | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a |

### B9 Convergence / Cleanup

- Quota race: attempted `0`, success `0`, denied `0`, aggregate CPU `0`, aggregate mem `0`.
- Invariants: `{}`
- Cleanup: `{"status":"admin-cleanup-finished","deletedUsers":["b56a5e04-7d50-4d78-b7a3-5aa59eafd317","0d97efa5-82fe-4735-8131-2571a4053ac0","f8e10f7d-5f51-461d-b620-486c367f2fdd","94ec3442-79be-44e2-ac8f-0499752294ab","7627a940-cc5a-469f-9148-c609a636fc3e"],"deletedImages":["752d469c-77b7-42bd-af85-338d9ad70fb0","24cf1488-e911-4477-b6db-337f8d11460a"]}`

### Step Evidence

- admin exact-prefix fixture setup: actor `admin`, POST `/users + /images + grants`, status `201`, expected five disposable users with redacted credentials, ids `{"cpuServerId":"1b9c08fa-32e1-4943-8dc5-d83772cd52f9","gpuServerId":"343488f6-2689-488a-8bf8-8c02caf25989","userIds":["b56a5e04-7d50-4d78-b7a3-5aa59eafd317","0d97efa5-82fe-4735-8131-2571a4053ac0","f8e10f7d-5f51-461d-b620-486c367f2fdd","94ec3442-79be-44e2-ac8f-0499752294ab","7627a940-cc5a-469f-9148-c609a636fc3e"],"imageIds":["24cf1488-e911-4477-b6db-337f8d11460a","752d469c-77b7-42bd-af85-338d9ad70fb0"]}`.
- fresh five-user fixture validity: actor `alpha`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"b56a5e04-7d50-4d78-b7a3-5aa59eafd317","visibleServerIds":["1b9c08fa-32e1-4943-8dc5-d83772cd52f9"],"visibleImageIds":["24cf1488-e911-4477-b6db-337f8d11460a"]}`.
- fresh five-user fixture validity: actor `beta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"0d97efa5-82fe-4735-8131-2571a4053ac0","visibleServerIds":["1b9c08fa-32e1-4943-8dc5-d83772cd52f9"],"visibleImageIds":["24cf1488-e911-4477-b6db-337f8d11460a"]}`.
- fresh five-user fixture validity: actor `gamma`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"f8e10f7d-5f51-461d-b620-486c367f2fdd","visibleServerIds":["343488f6-2689-488a-8bf8-8c02caf25989"],"visibleImageIds":["752d469c-77b7-42bd-af85-338d9ad70fb0"]}`.
- fresh five-user fixture validity: actor `delta`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"94ec3442-79be-44e2-ac8f-0499752294ab","visibleServerIds":["1b9c08fa-32e1-4943-8dc5-d83772cd52f9","343488f6-2689-488a-8bf8-8c02caf25989"],"visibleImageIds":["24cf1488-e911-4477-b6db-337f8d11460a","752d469c-77b7-42bd-af85-338d9ad70fb0"]}`.
- fresh five-user fixture validity: actor `epsilon`, GET `/auth/me + /me/access + /servers + /images`, status `200`, expected own JWT proves identity/access; admin effective-access readback matches, ids `{"userId":"7627a940-cc5a-469f-9148-c609a636fc3e","visibleServerIds":["1b9c08fa-32e1-4943-8dc5-d83772cd52f9"],"visibleImageIds":["24cf1488-e911-4477-b6db-337f8d11460a"]}`.
- B6 CPU/memory below exact over exhaustion: actor `alpha`, POST `/containers`, status `201`, expected below/exact accepted; over/exhausted denied and invisible, ids `{"belowDockerId":"31b361afd297","exactDockerId":"01539d391a17","overCpuStatus":400,"overMemStatus":400,"exhaustedStatus":400}`.
- B6 second-user exact remaining exhaustion: actor `beta`, POST `/containers`, status `201`, expected exact grant accepted, next create denied, ids `{"exactDockerId":"f1124311c8db","exhaustedStatus":400}`.
- B6 GPU granted denied over-count: actor `gamma`, POST `/containers`, status `201`, expected allowed index accepted; ungranted/duplicate/over-count denied, ids `{"gammaDockerId":"ac63a76a9b99","deltaDockerId":"2f5751960b3f","badIndexStatus":403,"duplicateStatus":400,"overCountStatus":409}`.
- B6 disk runtime write quota: actor `epsilon`, POST+/ws `/containers/1b9c08fa-32e1-4943-8dc5-d83772cd52f9/0d09c68a-7ff/exec`, status `200`, expected create body omitted diskBytes; below write succeeded; over write failed in runtime, ids `{"dockerId":"8bae01e9c905","createBodyHasDiskBytes":false,"belowSeen":true,"overSummary":"set +e; dd if=/dev/zero of=/tmp/nyabase-disk-over bs=1M count=96 status=none; code=$?; rm -f /tmp/nyabase-disk-over; echo OVER_CODE:$code; exit # dd: error writing '/tmp/nyabase-di"}`.

### Failures

- multi-user red-team continuation B6/B9/B10 live coverage: Error: timed out waiting for murtc-20260604t152325z-3de301-b9-beta (root cause: product)
