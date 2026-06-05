# Test Record

Session: `multi-user-redteam/20260602T035546Z`
Role: devops

## Environment Preflight

Prepared: `2026-06-02T03:58:58Z`
Role: devops
Scope: read-only environment probes for local VM/backend/frontend, remote CPU agent host, remote GPU agent host, managed Docker daemons, and common-src artifact guard. Product source, tests, scripts, configs, lockfiles, runtime services, API/DB state, tokens, and remote hosts were not modified. Raw JWTs, refresh tokens, API tokens, and agent tokens were not recorded.

### Summary

Preflight verdict: `PASS`

| Check | Status | Evidence |
| --- | --- | --- |
| VictoriaMetrics `/health` | pass | `GET http://127.0.0.1:8428/health` returned HTTP `200 OK`. |
| VictoriaMetrics simple query | pass | `GET http://127.0.0.1:8428/api/v1/query?query=up` returned HTTP `200 OK` with JSON response headers. |
| Backend unauthenticated auth guard | pass | `GET http://localhost:3001/api/auth/me` returned HTTP `401 Unauthorized`. |
| Frontend root | pass | `GET http://localhost:5173/` returned HTTP `200 OK`, `Content-Type: text/html`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` produced no artifact paths; count `0`. |

### CPU Agent Host `10.8.96.91`

| Check | Status | Evidence |
| --- | --- | --- |
| SSH reachability | pass | `ssh root@10.8.96.91` succeeded; host reported `nyabase-test-1`. |
| `nyabase-agent` status | pass | `systemctl is-active nyabase-agent` returned `active`; status header `nyabase-agent.service - nyabase Agent`. |
| `nyabase-docker.service` status | pass | `systemctl is-active nyabase-docker.service` returned `active`; status header `nyabase-docker.service - nyabase-managed Docker daemon`. |
| Recent WebSocket connection evidence | pass | Agent journal within the last two hours included `Jun 02 11:40:44 nyabase-test-1 nyabase-agent[2171392]: [WS] Connected`. |
| Managed Docker summary | pass | Docker socket `/run/nyabase-agent/docker.sock`; `ServerVersion=29.4.3`, `RootDir=/data/nyabase-docker`, `CgroupDriver=systemd`; runtimes include `runc`; `docker system df` showed `Images 1`, `Containers 0`, `Local Volumes 0`, `Build Cache 0`. |
| `/data` filesystem and quota | pass | `/data` is XFS mounted with `prjquota`; `df -h /data` showed `/dev/sdb` size `32G`, used `3.2G`, available `29G`, use `10%`; `xfs_quota state -p /data` reported project quota accounting `ON` and enforcement `ON`. |

### GPU Agent Host `lyn@10.8.1.12`

| Check | Status | Evidence |
| --- | --- | --- |
| SSH reachability | pass | `ssh lyn@10.8.1.12` succeeded; host reported `aya-1`. |
| `nyabase-agent` status | pass | `sudo systemctl is-active nyabase-agent` returned `active`; status header `nyabase-agent.service - nyabase Agent`. |
| `nyabase-docker.service` status | pass | `sudo systemctl is-active nyabase-docker.service` returned `active`; status header `nyabase-docker.service - nyabase-managed Docker daemon`. |
| Recent WebSocket connection evidence | pass | Agent journal within the last two hours included `Jun 02 03:39:36 aya-1 nyabase-agent[2105164]: [WS] Connected`. |
| Managed Docker summary | pass | Docker socket `/run/nyabase-agent/docker.sock`; `ServerVersion=29.0.2`, `RootDir=/data0/nbTest/nyabase-docker-pquota`, `CgroupDriver=systemd`; runtimes include `runc` and `nvidia`; `docker system df` showed `Images 1`, `Containers 0`, `Local Volumes 0`, `Build Cache 0`. |
| NVIDIA runtime | pass | `nvidia-container-runtime` found at `/usr/bin/nvidia-container-runtime`; version `1.18.0`. |
| GPU inventory | pass | `nvidia-smi` reported four GPUs: indices `0..3`, all `NVIDIA L40`, each `46068` MiB, UUIDs `GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19`, `GPU-23d8fdac-e091-5c42-df3c-8f72f52ef5fe`, `GPU-597b76dd-7b55-577b-cad7-bc6638a43541`, `GPU-14a856ae-d536-7446-a361-008dc8c3f4a7`. |
| Active Docker root filesystem and quota | pass | Active Docker root `/data0/nbTest/nyabase-docker-pquota` is XFS mounted with `prjquota`; `df -h` showed `/dev/loop3` size `20G`, used `259M`, available `20G`, use `2%`; `xfs_quota state -p` reported project quota accounting `ON` and enforcement `ON`. |

### Blockers

None.

### Commands Run

- `curl -sS -i --max-time 5 http://127.0.0.1:8428/health`
- `curl -sS -i --max-time 5 'http://127.0.0.1:8428/api/v1/query?query=up'`
- `curl -sS -i --max-time 5 http://localhost:3001/api/auth/me`
- `curl -sS -i --max-time 5 http://localhost:5173/`
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
- `ssh root@10.8.96.91` read-only probes: hostname, `systemctl is-active/status`, `journalctl` grep for `[WS] Connected`, managed Docker `info`/`system df`, `findmnt`, `df`, `xfs_quota` state/report.
- `ssh lyn@10.8.1.12` read-only probes: hostname, `sudo systemctl is-active/status`, `sudo journalctl` grep for `[WS] Connected`, managed Docker `info`/`system df`, NVIDIA runtime/version, `nvidia-smi`, active Docker root `findmnt`/`df`/`xfs_quota` state/report.



## Admin Fixture Setup

Prepared: `2026-06-02T04:10:13.029Z`
Run ID: `murt-20260602t041011z-abe610`
Command: `pnpm exec vitest run test/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/tmp/nyabase-murt-20260602t041011z-abe610`
State manifest: `/tmp/nyabase-murt-20260602t041011z-abe610/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 05cea385-d6ca-490a-a126-e00d0ae23b70 |
| server | gpu | db1112fe-1c55-4314-9511-6d8510c523c2 |
| image | cpu-a | 720f1a80-b322-44e2-9dc6-eb0059da2b48 |
| image | cpu-b-same-ref | 349627a0-e243-4f11-895e-e66e14fd6fca |
| image | inactive | c963a1bb-237c-45e4-bc58-b75e950d9ad4 |
| image | gpu-a | e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260602t041011z-abe610-alpha | 06aa2a74-5a72-4956-9f06-0167775348ad | 05cea385-d6ca-490a-a126-e00d0ae23b70:500/268435456/67108864/none[] | cpuA:720f1a80-b322-44e2-9dc6-eb0059da2b48@05cea385-d6ca-490a-a126-e00d0ae23b70 | 720f1a80-b322-44e2-9dc6-eb0059da2b48 | none |
| beta | murt-20260602t041011z-abe610-beta | 9753d862-d2fb-46c3-92c1-89d15e97bae7 | 05cea385-d6ca-490a-a126-e00d0ae23b70:1000/536870912/134217728/none[] | cpuB:349627a0-e243-4f11-895e-e66e14fd6fca@05cea385-d6ca-490a-a126-e00d0ae23b70 | 349627a0-e243-4f11-895e-e66e14fd6fca | none |
| gamma | murt-20260602t041011z-abe610-gamma | 69d7f149-356f-481d-a936-fe5b3aca5335 | db1112fe-1c55-4314-9511-6d8510c523c2:1000/1073741824/268435456/indices[0] | gpuA:e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101@db1112fe-1c55-4314-9511-6d8510c523c2 | e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101 | none |
| delta | murt-20260602t041011z-abe610-delta | 043f7473-7ddb-4ac2-99c2-3c257814540a | 05cea385-d6ca-490a-a126-e00d0ae23b70:1500/1073741824/268435456/none[]; db1112fe-1c55-4314-9511-6d8510c523c2:1000/1073741824/268435456/indices[1] | cpuA:720f1a80-b322-44e2-9dc6-eb0059da2b48@05cea385-d6ca-490a-a126-e00d0ae23b70, gpuA:e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101@db1112fe-1c55-4314-9511-6d8510c523c2 | 720f1a80-b322-44e2-9dc6-eb0059da2b48, e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101 | none |
| epsilon | murt-20260602t041011z-abe610-epsilon | 045db296-2c85-48b6-8a95-b7c6b854f9c1 | none | inactive:c963a1bb-237c-45e4-bc58-b75e950d9ad4@05cea385-d6ca-490a-a126-e00d0ae23b70 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 05cea385-d6ca-490a-a126-e00d0ae23b70`; `setup-gap: no remote FS mount assigned to CPU server 05cea385-d6ca-490a-a126-e00d0ae23b70`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260602t041011z-abe610` and manifest `/tmp/nyabase-murt-20260602t041011z-abe610/state.json`; do not perform broad cleanup of unrelated resources.

## Fixture Runnable Image Remediation

Prepared: `2026-06-02T04:24:00Z`
Role: tester
Command: `node <<'NODE' ... PATCH /api/images/:id { cmd: "sleep 3600" } ... NODE`
State manifest: `/tmp/nyabase-murt-20260602t041011z-abe610/state.json`
Classification: `pass`

Patched current live image records through the product admin API so disposable `ubuntu:24.04` images have a long-running default command for shell/stats/lifecycle tests. The inactive image remained inactive. The command used `ADMIN_INIT_PASSWORD` from `test/.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token was recorded in this session document or manifest.

| Label | Image ID | Active | Cmd | Result |
| --- | --- | --- | --- | --- |
| cpuA | 720f1a80-b322-44e2-9dc6-eb0059da2b48 | true | `sleep 3600` | pass |
| cpuB | 349627a0-e243-4f11-895e-e66e14fd6fca | true | `sleep 3600` | pass |
| inactive | c963a1bb-237c-45e4-bc58-b75e950d9ad4 | false | `sleep 3600` | pass |
| gpuA | e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101 | true | `sleep 3600` | pass |

Focused verification command: `node <<'NODE' ... GET /api/images/:id and assert cmd === "sleep 3600", inactive isActive === false, and manifest images match readback ... NODE`
Focused verification result: `pass` for all four image records.
Common-src artifact guard: `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort` returned no paths; result `pass`.
Non-run note: `pnpm exec vitest run test/multi-user-redteam-admin-setup.spec.ts --runInBand` was rejected by Vitest as an unknown option before executing tests, so it did not create a new fixture run or mutate product API state.

## Epsilon No-Access Control Runtime

Prepared: `2026-06-02T04:25:09Z`
Role: tester
Actor: `murt-20260602t041011z-abe610-epsilon`
Command: `pnpm exec vitest run test/multi-user-redteam-epsilon.spec.ts --reporter=verbose`
Suite: `test/multi-user-redteam-epsilon.spec.ts`
Counts: `1 passed / 0 failed / 0 skipped`
Classification: `pass`

The suite used only `/tmp/nyabase-murt-20260602t041011z-abe610/epsilon.env` and `/tmp/nyabase-murt-20260602t041011z-abe610/state.json`. It did not use admin credentials, host access, SSH access, or other users' credential files. Reports omit raw passwords, JWTs, refresh tokens, API-token secrets, and private keys.

Runtime reports:

- Markdown: `/tmp/nyabase-murt-20260602t041011z-abe610/epsilon-report.md`
- JSON: `/tmp/nyabase-murt-20260602t041011z-abe610/epsilon-report.json`
- Marker: `/tmp/nyabase-murt-20260602t041011z-abe610/epsilon-complete`

### Epsilon Coverage

| Acceptance criterion | Covered by |
| --- | --- |
| AC 1 login and `/auth/me` identity without management caps | `multi-user red-team epsilon no-access control > verifies epsilon-only denied baseline and writes reports` |
| AC 2 API token create/use/delete/deleted-token rejection | same |
| AC 3 SSH key self add/list/delete and other-user SSH denial | same |
| AC 4 empty `/me/access`, `/servers`, active `/images`; inactive image not active/usable | same |
| AC 5 create-container denial matrix for CPU/GPU, inactive, active, fake ids; zero epsilon containers | same |
| AC 6 direct ID guessing for servers, GPUs, disks, quota, images, data dirs, mount sources, containers | same |
| AC 7 management APIs denied for users/groups/grants/servers/images/audit/remote FS/admin data-dir/mount-source grants | same |
| AC 8 metrics label injection, regex selectors, duplicate labels, range query, `all=true`; audit denied | same |
| AC 9 report includes status codes, zero-resource assertions, cleanup status, and no raw secrets | same |

### Epsilon Denial Matrix Summary

Report entries: `239`; failures: `0`; status codes observed: `200`, `201`, `204`, `401`, `403`, `404`.

Cleanup status:

- Own API token deleted: `true`
- Own SSH key deleted: `true`
- Epsilon containers remaining: `0`
- Epsilon data dirs remaining: `0`

Visual artifacts: n/a, backend/API runtime only.

## Mount Fixture Final Cleanup

Prepared: `2026-06-02T06:40:00Z`
Role: devops
Run prefix: `mount-20260602t052140z-1f28fd`
Runtime manifest: `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json`
CPU server: `05cea385-d6ca-490a-a126-e00d0ae23b70`
Classification: `pass`

Cleaned only the exact mount fixture product rows, NFS export, host paths, CPU managed-Docker/runtime residuals, and temporary fixture directory. Product source, tests, scripts, configs, lockfiles, unrelated users/images/grants/sources/exports/paths/Docker resources, services, and session docs were not edited or removed. Admin authentication used `ADMIN_INIT_PASSWORD` from `test/.env` in-process only; no raw password, JWT, refresh token, API-token secret, private key, or agent token is recorded.

### Pre-Cleanup Readback

| Surface | Status | Evidence |
| --- | --- | --- |
| Runtime-spec-created objects | pass | User API readback for alpha-local `11cec13e-f783-4018-baaf-9a7be2ba04c0`, beta-remote `94766acd-3abf-40d7-95b1-94ad4dfead49`, and delta-both `8a634f67-b6ae-470b-8e93-3d690cba6d05` returned `containers=0` and `dataDirs=0` for run prefix `mount-20260602t052140z-1f28fd`. |
| Product rows present before cleanup | pass | Admin API readback found only the exact fixture product rows: `3` users, `1` image `cf1545e5-2cd9-49ea-be76-db285403b3c5`, `1` remote FS mount `7d9826c0-db37-420b-bc51-6b93932d3bc0`, `1` local data disk `7e2fc9db-1e94-4c53-867a-f4eba23ddffe`, `4` mount-source grants, `3` image grants, and `3` server grants. Grant UUIDs matched the manifest before deletion. |
| CPU host precheck | pass | Managed Docker exact-prefix scan returned no containers. CPU `/mnt/nyabase-mount-20260602t052140z-1f28fd` was still an NFS mount before product remote-FS cleanup. Spec data-dir paths under `/data` were absent, but `/etc/projects` still had two exact run-prefix entries for previously removed fixture data dirs. |
| NFS/export precheck | pass | `/etc/exports` contained exact line `/srv/nyabase-mount-20260602t052140z-1f28fd 10.8.96.91(rw,sync,no_subtree_check,no_root_squash)`; `exportfs -v` showed `/srv/nyabase-mount-20260602t052140z-1f28fd`; `/srv/nyabase-mount-20260602t052140z-1f28fd` and `/tmp/nyabase-mount-20260602t052140z-1f28fd` existed. |
| Health/common guard before cleanup | pass | Backend auth guard `401`, frontend root `200`, VictoriaMetrics `/health` `200`, and common-src artifact guard returned no paths. |

Non-mutating precheck retries: first Node readback attempt exited `1` because CommonJS `require()` was mixed with top-level `await`; corrected wrapped script exited `0`. First SSH readback attempt exited `2` because a local shell quoting mistake broke the remote `awk`; corrected `ssh ... bash -s` readback exited `0`.

### Product Cleanup

| Product resource | Exact IDs | Result |
| --- | --- | --- |
| Mount-source grants | `0c3738d9-b739-4018-a517-9330b0378d9e`, `80353fa3-8bea-4489-8faf-3a87da5c9007`, `87347061-fb6a-4f29-bed4-1b677905ed3c`, `1c1f60e8-0018-400f-87c3-24c1b780d2f4` | Admin API DELETE returned `204` for all `4`. |
| Image grants | `7d3f977a-53bd-44a6-bd07-24f98d15cc2a`, `04cd1835-5f21-4f69-8cf3-dc183e9130a0`, `fedff72c-2504-496e-ac0b-5e8d8a08bbdd` | Admin API DELETE returned `204` for all `3`. |
| Server grants | `3115a2e7-e105-474c-a651-3e1f971f7fbf`, `033d1c84-58ad-44c1-9a5d-60bd7c2541b0`, `e6edbd96-f9c0-4964-9d5b-3a3456452f44` | Admin API DELETE returned `204` for all `3`. |
| Image | `cf1545e5-2cd9-49ea-be76-db285403b3c5` | Exact image readback matched `mount-20260602t052140z-1f28fd-ubuntu-2404`; DELETE returned `204`. |
| Remote FS mount | `7d9826c0-db37-420b-bc51-6b93932d3bc0` | Exact remote-FS readback matched name `mount-20260602t052140z-1f28fd` and host mount `/mnt/nyabase-mount-20260602t052140z-1f28fd`; DELETE returned `204`. |
| Users | `11cec13e-f783-4018-baaf-9a7be2ba04c0`, `94766acd-3abf-40d7-95b1-94ad4dfead49`, `8a634f67-b6ae-470b-8e93-3d690cba6d05` | Exact username readback matched all three fixture users; DELETE returned `204` for all `3`. |
| Local data disk/source | `7e2fc9db-1e94-4c53-867a-f4eba23ddffe` | Exact disk readback matched `/data` and label `mount-20260602t052140z-1f28fd-local-xfs`; DELETE returned `204`. |

Product residual scan after cleanup: users `0`, images `0`, remote FS mounts `0`, local data disks `0`, exact fixture grants `0`, product/API containers `0`, data dirs `0`; total residuals `0`.

### Host Cleanup

| Surface | Status | Evidence |
| --- | --- | --- |
| NFS export | pass | Removed the exact `/etc/exports` line, ran `exportfs -ra`, and readback showed `exports_line=absent`, `exportfs=absent`. |
| Host paths | pass | Removed/confirmed absent `/srv/nyabase-mount-20260602t052140z-1f28fd`, CPU `/mnt/nyabase-mount-20260602t052140z-1f28fd`, and `/tmp/nyabase-mount-20260602t052140z-1f28fd`. |
| CPU Docker/path residuals | pass | Managed Docker exact run-prefix/name/label scans returned no rows. `find /data -maxdepth 1 -type d -name '*mount-20260602t052140z-1f28fd*'` returned no paths. `/etc/projects` and `/etc/projid` exact-prefix scans returned no rows after removing the two stale exact entries. |
| Health | pass | Backend auth guard `401`, frontend root `200`, VictoriaMetrics `/health` `200`; CPU `nyabase-agent` and `nyabase-docker.service` both `active`; product `GET /api/servers` showed CPU and GPU servers `online`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

Host cleanup retry: first destructive host cleanup command exited `32` after the export line had already been removed and `exportfs -ra` had run; the failure was `umount: /mnt/nyabase-mount-20260602t052140z-1f28fd: not mounted.` The corrected command used `mountpoint -q` for the exact path and exited `0`.

### Commands Run

- `node <<'NODE' ... admin login from test/.env; pre-cleanup exact user residual/product row/grant readback ... NODE` -> first attempt exit `1`, corrected attempt exit `0`.
- `ssh root@10.8.96.91 'bash -s' ... exact CPU Docker/mount/path/project readback ...` -> first attempt exit `2`, corrected attempt exit `0`.
- `grep -F '<exact export line>' /etc/exports; exportfs -v | grep -F '/srv/nyabase-mount-20260602t052140z-1f28fd'; find /srv /tmp -maxdepth 1 -type d -name '*mount-20260602t052140z-1f28fd*'` -> exit `0`.
- `curl ... /api/auth/me`, `curl ... http://localhost:5173/`, `curl ... http://127.0.0.1:8428/health`, common-src artifact guard -> exit `0`.
- `node <<'NODE' ... admin login from test/.env; delete exact mount-source grants, image grants, server grants, image, remote FS mount, users, local data disk; final product residual scan ... NODE` -> exit `0`.
- `perl -0pi` exact-line removal from `/etc/exports`; `exportfs -ra`; remote CPU exact unmount/path/project cleanup; `rm -rf --one-file-system` exact `/srv/...` and `/tmp/...` paths -> first host cleanup attempt exit `32`, corrected attempt exit `0`.
- `node <<'NODE' ... final product residual scan for exact IDs/run prefix, API containers/data dirs/grants, and server statuses ... NODE` -> exit `0`, total residuals `0`.
- `ssh root@10.8.96.91 'bash -s' ... final managed-Docker exact-prefix scan, /data path scan, /etc/projects/projid scan, CPU service health ...` -> exit `0`.
- Final local export/path/health/common-src guard command -> exit `0`.

### Blockers

None.

## Backend Rebuild and Restart After Metrics Fix

Prepared: `2026-06-02T04:50:14Z`
Role: devops
Classification: `pass`

Rebuilt the local backend and restarted only the local backend process from `packages/backend/dist/main.js` using `test/.env`. The frontend, local agent process, remote CPU agent, remote GPU agent, VictoriaMetrics, product source, tests, scripts, configs, lockfiles, and remote hosts were not restarted or edited.

| Check | Status | Evidence |
| --- | --- | --- |
| Backend build | pass | `pnpm --filter @nyabase/backend build` exited `0`. |
| Backend restart | pass | tmux backend pane relaunched `node -r tsconfig-paths/register dist/main.js`; backend log reported `Backend listening on port 3001`. |
| Backend auth guard | pass | `GET http://localhost:3001/api/auth/me` returned HTTP `401`. |
| Frontend root | pass | `GET http://localhost:5173/` returned HTTP `200`. |
| VictoriaMetrics health | pass | `GET http://127.0.0.1:8428/health` returned HTTP `200`. |
| CPU/GPU online | pass | `GET /api/servers` returned HTTP `200`; `nyabase-cpu-batch-20260601T163636Z` status `online`, `nyabase-gpu-batch-20260601T163636Z` status `online`. Backend log also showed both agents reconnected after restart. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

Commands run:

- `pnpm --filter @nyabase/backend build`
- `tmux send-keys -t %0 'cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js' Enter`
- `curl -sS -o /tmp/nyabase-auth-me-after-restart.out -w '%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-frontend-root-after-restart.out -w '%{http_code}\n' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-vm-health-after-restart.out -w '%{http_code}\n' --max-time 8 http://127.0.0.1:8428/health`
- `node <<'NODE' ... admin login from test/.env; GET /api/servers; print only server names, GPU flags, and statuses ... NODE`
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`

No raw admin password, JWT, refresh token, API-token secret, or agent token was recorded.

## Metrics User Scope Unit Test

Prepared: `2026-06-02T04:48:12Z`
Role: tester
Command: `pnpm --filter @nyabase/backend exec vitest run src/metrics/metrics.controller.test.ts --reporter=verbose`
Suite: `packages/backend/src/metrics/metrics.controller.test.ts`
Counts: `3 passed / 0 failed / 0 skipped`
Classification: `pass`

Focused backend unit coverage was added for `GET /api/metrics/servers/:id/users` through direct `MetricsController.userMetrics` tests. No product source, scripts, configs, lockfiles, frontend, agent, common, or live fixture files were edited. No raw secrets were used or recorded.

### Coverage

| Acceptance criterion | Covered by |
| --- | --- |
| AC 1 normal user selectors include `user_id="user-1"` | `MetricsController.userMetrics > filters normal users to their own user_id selector and response user` |
| AC 2 normal user VM extra labels `other-user` and numeric `12` are excluded from response | `MetricsController.userMetrics > filters normal users to their own user_id selector and response user` |
| AC 3 `ensureAccess` path calls `hasCapability` for server access before `Capability.ViewMetricsAll` decision | both `MetricsController.userMetrics` tests assert `hasCapability` calls for `Capability.ManageServers` then `Capability.ViewMetricsAll`, plus accessible-server lookup |
| AC 4 `Capability.ViewMetricsAll` selectors do not include owner filter and response includes all returned ids | `MetricsController.userMetrics > preserves all-user metrics behavior for ViewMetricsAll users` |
| AC 5 focused test command passes | `pnpm --filter @nyabase/backend exec vitest run src/metrics/metrics.controller.test.ts --reporter=verbose` |
| AC 6 test record includes command, counts, coverage, and visual artifacts n/a | this section |

Visual artifacts: n/a, backend unit test only.

## GPU Image Availability Remediation

Prepared: `2026-06-02T04:35:06Z`
Role: devops
Target server: `db1112fe-1c55-4314-9511-6d8510c523c2`
Target image: `e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101`
Docker ref: `ubuntu:24.04`
Classification: `pass`

Remediated the GPU runtime image availability blocker through the product admin API first. The command authenticated with `ADMIN_INIT_PASSWORD` from `test/.env` in-process, called `POST /api/images/:id/pull` with only the GPU server id, and did not record the admin password, raw JWT, refresh token, API-token secret, or agent token.

| Check | Status | Evidence |
| --- | --- | --- |
| Product API pull | pass | `POST /api/images/e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101/pull` returned HTTP `201` with `started: ["db1112fe-1c55-4314-9511-6d8510c523c2"]` and `skipped: []`. |
| Product image status during pull | pass | Initial poll of `GET /api/images/e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101/status` changed from `present: false` to `present: true` for GPU server `db1112fe-1c55-4314-9511-6d8510c523c2` after the pull completed. |
| Product image status follow-up | fail | Later repeated `GET /api/images/e22bb1c8-8aa9-4a5e-b05f-504ce3fa6101/status` calls returned HTTP `200` but `present: false` for the GPU server despite direct managed-Docker evidence below; treated as stale product status evidence, not a runtime availability blocker. |
| Managed Docker image inspect | pass | `ssh lyn@10.8.1.12 "sudo env DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker image inspect ubuntu:24.04 --format '{{.Id}} {{.RepoTags}}'"` returned image id `sha256:0b1ebe5dd42682bb8eda97ecf10a09f70f18d2d4af35f82b9271badac5dbeb27` and repo tag `[ubuntu:24.04]`. |

## Final Standard Check

Prepared: `2026-06-02T05:12:53Z`
Role: devops
Command: `bash scripts/check.sh`
Exit code: `0`
Classification: `pass`

`scripts/check.sh` first ran the common-src artifact guard, then workspace typecheck, lint, and unit tests. Visual snapshots were not requested and were skipped for this backend/test-only change.

| Check | Status | Evidence |
| --- | --- | --- |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print -quit` inside `scripts/check.sh` found no artifact. Explicit guard command `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort` also returned no paths. |
| Common typecheck | pass | `pnpm --filter @nyabase/common typecheck` exited `0`. |
| Backend typecheck | pass | `pnpm --filter @nyabase/backend typecheck` exited `0`. |
| Agent typecheck | pass | `pnpm --filter @nyabase/agent typecheck` exited `0`. |
| Frontend typecheck | pass | `pnpm --filter @nyabase/frontend typecheck` exited `0`. |
| Lint | pass | `pnpm lint` exited `0`; output contained 12 warnings and 0 errors. |
| Common tests | pass | `2` files passed; `36` tests passed, `0` failed, `0` skipped. |

| Backend tests | pass | `9` files passed; `75` tests passed, `0` failed, `0` skipped. |
| Agent tests | pass | `4` files passed; `53` tests passed, `0` failed, `0` skipped. |
| Frontend tests | skipped | `scripts/check.sh` does not invoke a frontend unit test command. |
| Frontend visual | skipped | `--with-visual` was not requested; no visual artifacts produced. |

Failing output tail: none.
Visual artifacts: n/a, skipped.
| Managed Docker image list | pass | `docker images` on the managed socket listed `ubuntu:24.04 0b1ebe5dd426 78.1MB` and left existing `ubuntu:22.04` untouched. |
| GPU services | pass | `sudo systemctl is-active nyabase-agent` and `sudo systemctl is-active nyabase-docker.service` both returned `active`. |
| Backend unauthenticated auth guard | pass | `GET http://localhost:3001/api/auth/me` returned HTTP `401`. |
| VictoriaMetrics health | pass | `GET http://127.0.0.1:8428/health` returned HTTP `200`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

No service restart or redeploy was performed. No broad Docker cleanup, unrelated image mutation, product source change, test change, config change, lockfile change, or deployment-file change was performed. SSH was used only for read-only managed-Docker verification after the product API pull had already completed.

### Commands Run

- `node <<'NODE' ... admin login from test/.env; GET /api/images/:id/status; POST /api/images/:id/pull { serverIds: [gpuServerId] }; poll GET /api/images/:id/status ... NODE`
- `node <<'NODE' ... admin login from test/.env; repeated GET /api/images/:id/status ... NODE`
- `ssh lyn@10.8.1.12 "sudo systemctl is-active nyabase-agent; sudo systemctl is-active nyabase-docker.service; sudo env DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker image inspect ubuntu:24.04 --format '{{.Id}} {{.RepoTags}}'"`
- `ssh lyn@10.8.1.12 "sudo env DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker images --digests --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' | sort"`
- `ssh lyn@10.8.1.12 "sudo journalctl -u nyabase-agent --since '10 minutes ago' --no-pager | tail -80"`
- `curl -sS -o /tmp/nyabase-auth-me-check.out -w '%{http_code}\n' --max-time 5 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-vm-health-check.out -w '%{http_code}\n' --max-time 5 http://127.0.0.1:8428/health`
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`

## Gamma GPU User-State Rerun After Image Remediation

Prepared: `2026-06-02T04:43:31Z`
Role: tester
Actor: `murt-20260602t041011z-abe610-gamma`
Command: `set -a; . /tmp/nyabase-murt-20260602t041011z-abe610/gamma.env; set +a; pnpm exec vitest run test/multi-user-redteam-gamma.spec.ts`
Suite: `test/multi-user-redteam-gamma.spec.ts`
Counts: `0 passed / 1 failed / 0 skipped`
Classification: `fail-product`

The rerun used only `/tmp/nyabase-murt-20260602t041011z-abe610/gamma.env` and `/tmp/nyabase-murt-20260602t041011z-abe610/state.json`. It did not use admin credentials, host access, SSH access, or other users' credential files. The previous blocked reports were preserved as `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-report.md` and `.json`; the rerun reports were written to `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-rerun-report.md` and `.json`. Reports omit raw passwords, JWTs, refresh tokens, API-token secrets, and private keys.

### Gamma Rerun Result

The original GPU image blocker is no longer reproduced. Valid GPU create on granted index `[0]` succeeded, lifecycle list/detail/stats/start/stop/restart/delete succeeded, and `gpuCount: 1` resolved to `[0]` and deleted successfully. Invalid GPU index `[1]` and over-count `gpuCount: 2` were rejected with no residual containers.

The suite failed at metrics scoping. Gamma queried `GET /api/metrics/servers/db1112fe-1c55-4314-9511-6d8510c523c2/users?range=15m`; the endpoint returned HTTP `200` with `userMetricIds` containing gamma plus non-gamma ids `12`, `13`, `5`, `7`, and `8`. Expected scoped response for a normal user is gamma-only rows where samples exist. `GET /api/metrics/servers/:id/containers?range=15m&all=true` returned container rows without non-gamma owner leakage in this run, and `/api/metrics/servers/:id/gpus` returned GPU indices `0..3`.

Runtime reports:

- Markdown: `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-rerun-report.md`
- JSON: `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-rerun-report.json`

### Gamma Coverage

| Acceptance criterion | Covered by |
| --- | --- |
| AC 1 gamma auth/token/SSH/access matrix still passes using only gamma credentials | `multi-user red-team gamma GPU user-state lane > verifies gamma-only auth, GPU access, lifecycle, metrics, and delta target coordination` |
| AC 2 GPU invalid index `[1]` and over-count are rejected with no residuals | same |
| AC 3 valid GPU create on granted index `[0]` succeeds after remediation | same |
| AC 4 valid GPU container list/detail/stats/lifecycle/delete works; metrics endpoints for gpus/containers/users return scoped responses where samples exist | same; lifecycle passed, metrics users scoping failed |
| AC 5 target container for delta attack is coordinated and cleaned | not reached because metrics scoping failed before target creation |
| AC 6 rerun report is clearly marked after GPU image remediation and contains no raw secrets | same |

Cleanup status:

- Own API token deleted: `true`
- Own SSH key deleted: `true`
- Gamma containers deleted in final rerun: `3722e24c3c3ea088399f9060a6979761d7f8cb78aaf6d85aac758d6b41257e88`, `df98723a52fd84a2ebe46fe04bc1778c9c2da3eb9fa62f061b5a5627128790a4`
- Gamma residual containers by gamma own API scan: `[]`
- Cleanup failures: `[]`
- Delta target: not created in the final rerun because the suite failed before target creation
- Stale marker note: `/tmp/nyabase-murt-20260602t041011z-abe610/attack-done-gamma` existed from the previous run, but target coordination was not meaningful in the final rerun because no target was created

Visual artifacts: n/a, backend/API runtime only.

## Consolidated Multi-User Red-Team Runtime Results

Prepared: `2026-06-02T05:00:00Z`
Role: tester
Scope: report consolidation only. No tests were run, no runtime state was mutated, and no product source, tests, scripts, configs, lockfiles, temp reports, or runtime fixtures were edited. Source reports are under `/tmp/nyabase-murt-20260602t041011z-abe610/`; session evidence is this file, `.codex/skills/harness/docs/multi-user-redteam/20260602T035546Z/tests.md`. No raw passwords, JWTs, refresh tokens, API-token secrets, private keys, or agent tokens are recorded here.

### Final Persona Status

| Persona | Final status | Evidence |
| --- | --- | --- |
| alpha | PASS | `/tmp/nyabase-murt-20260602t041011z-abe610/alpha-report.md`, `.json`; CPU user-state run passed `25/0/0`, including granted CPU lifecycle, quota-shaped create attempts, denial evidence, attack marker, and cleanup. |
| beta | PASS | `/tmp/nyabase-murt-20260602t041011z-abe610/beta-report.md`, `.json`; CPU second-image/same-ref lane passed with `0` failures, three containers deleted, and mount-source cases marked as setup gaps where sources were unavailable. |
| gamma | final PASS after infra and product remediation | Initial `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-report.md`, `.json` was `BLOCKED` by missing GPU runtime image. `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-rerun-report.md`, `.json` then failed on `/metrics/servers/:id/users` user-scope leakage. After the metrics fix, focused unit test, backend rebuild/restart, `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-fixed-report.md`, `.json` passed with GPU lifecycle, invalid GPU denial, target coordination, cleanup, and no gamma residual containers. |
| delta | final PASS for CPU/cross-user/metrics plus focused gamma-delta PASS | `/tmp/nyabase-murt-20260602t041011z-abe610/delta-report.md`, `.json` had `0` failures for CPU/cross-user/metrics checks and clean delta residuals. `/tmp/nyabase-murt-20260602t041011z-abe610/gamma-delta-attack-report.md`, `.json` passed focused attack validation against gamma's target, with no leaked gamma user/container ids and clean target cleanup. |
| epsilon | PASS | `/tmp/nyabase-murt-20260602t041011z-abe610/epsilon-report.md`, `.json`; no-access control lane passed, including empty effective access, inactive image denial, API/SSH self-cleanup, direct ID guessing denial, metrics/audit denial probes, and zero epsilon containers/data dirs remaining. |

### Remediation Loops

1. GPU image missing -> product/admin pull -> gamma/delta rerun: gamma initially blocked and delta initially had an infra failure path because `ubuntu:24.04` was not present on the GPU managed Docker daemon. The `GPU Image Availability Remediation` section records `POST /api/images/:id/pull` through the product admin API, read-only managed-Docker verification that `ubuntu:24.04` was present, service health checks, and common-src artifact guard. Gamma and delta GPU-relevant checks were rerun after this remediation.
2. Metrics user leak -> developer fix -> unit test -> backend rebuild -> gamma fixed PASS: gamma rerun exposed normal-user leakage from `GET /api/metrics/servers/:id/users?range=15m`. The `Metrics User Scope Unit Test` section records focused backend coverage for normal-user scoping and `ViewMetricsAll` behavior. The `Backend Rebuild and Restart After Metrics Fix` section records backend rebuild/restart and health checks. Gamma fixed rerun then passed, and gamma-delta focused attack metrics returned no leaked gamma user/container ids.

### Design AC Coverage Matrix

| Design area | Runtime coverage | Status |
| --- | --- | --- |
| Five users/personas | alpha, beta, gamma, delta, epsilon all created in setup and each has a final report. | covered |
| Multi-image | CPU image A, CPU image B with same Docker ref, inactive image, and GPU image exercised through persona-specific grants and denials. | covered |
| Multi-container CPU/GPU | alpha/beta/delta CPU lifecycle and gamma GPU lifecycle passed; gamma invalid GPU index `[1]` and over-count were rejected; delta also covered cross-user attack paths. | covered |
| Quotas | Setup grants recorded distinct CPU/memory/storage/GPU quotas; persona runs exercised quota-shaped container create/lifecycle behavior within their grants and denied unavailable resources. | covered |
| Cross-user isolation | alpha/gamma attack markers, delta attack probes, epsilon ID guessing, and gamma-delta focused attack report showed no cross-user container/user leakage after remediation. | covered |
| Concurrency/coordination | Alpha and gamma target/attack marker coordination plus delta focused attack validation covered concurrent multi-user red-team coordination. | covered |
| Metrics/audit | Epsilon audit denial and metrics denial matrix passed; delta metrics label-injection/regex/or/aggregation probes passed; gamma `/users` leak was fixed and verified by unit test plus gamma fixed rerun; gamma-delta focused metrics showed no gamma leaks. | covered after remediation |
| Cleanup/residual | Reported persona cleanup was clean: beta deleted three containers; gamma fixed deleted three containers, target deleted, no gamma residuals; delta residuals clean; epsilon API token/SSH key deleted and zero containers/data dirs remaining; gamma-delta target residual count `0`. | covered for current run resources |
| Setup gaps | `state.sources.local` and `state.sources.remote` are `null`; local/remote mount-source specific tests were skipped or recorded as setup gaps for alpha/beta/delta. This session does not claim those mount-specific cases passed. | gap |

### Setup Gaps and Cleanup Status

Remaining setup gaps: `/tmp/nyabase-murt-20260602t041011z-abe610/state.json` has `state.sources.local: null` and `state.sources.remote: null`. Reports explicitly list unavailable local data disk and remote FS mount sources for the CPU server, so local/remote mount-source grant, denial, and runtime mount cases remain unverified in this session.

Cleanup status from reports is clean for per-run containers/tokens/SSH keys that each persona created and deleted, but disposable product rows and runtime credential files still exist until final cleanup. Cleanup must target exact run prefixes only:

- Current run: `murt-20260602t041011z-abe610`, manifest `/tmp/nyabase-murt-20260602t041011z-abe610/state.json`.
- Superseded run: `murt-20260602t040905z-f41c9c`, associated temp directory `/tmp/nyabase-murt-20260602t040905z-f41c9c` if present.

Next required steps before final Done: perform exact cleanup for both run prefixes above, run final `bash scripts/check.sh`, and dispatch reviewer. Visual artifacts: n/a, backend/API runtime only.

## Multi-User Fixture Cleanup

Prepared: `2026-06-02T05:16:00Z`
Role: devops
Scope: exact cleanup of disposable product/runtime resources for run prefixes `murt-20260602t041011z-abe610` and `murt-20260602t040905z-f41c9c`. Product source, tests, scripts, configs, lockfiles, deployment files, shared Docker images, services, and unrelated DB/API/host resources were not edited or restarted. Admin authentication used `ADMIN_INIT_PASSWORD` from `test/.env` in-process only; no raw password, JWT, refresh token, API-token secret, private key, or agent token is recorded.

### Cleanup Result

Classification: `pass`

| Prefix | Containers | Data dirs | Server grants | Image grants | Mount grants | SSH keys | Users | Images | Groups | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `murt-20260602t041011z-abe610` | 0 | 0 | 5 | 6 | 0 | 0 | 5 | 4 | 0 | 0 |
| `murt-20260602t040905z-f41c9c` | 0 | 0 | 5 | 6 | 0 | 0 | 5 | 4 | 0 | 0 |

Notes:

- Product API cleanup used exact IDs from `/tmp/nyabase-murt-20260602t041011z-abe610/state.json` and `/tmp/nyabase-murt-20260602t040905z-f41c9c/state.json`, plus exact prefix matches from admin list endpoints.
- No product API containers or data dirs remained from persona runs at cleanup time; persona reports had already deleted their transient containers/data dirs.
- No mount-source grants or per-user SSH keys remained at cleanup time; setup gaps left `state.sources.local` and `state.sources.remote` as `null`.
- Shared runtime image references such as `ubuntu:24.04` were not deleted.

### Residual Scans

| Surface | Status | Evidence |
| --- | --- | --- |
| Product API users/images/groups/containers/data dirs/grants/SSH/API-token prefix scan | pass | Counts after cleanup: users `0`, images `0`, groups `0`, containers `0`, data dirs `0`, server grants `0`, image grants `0`, mount grants `0`, SSH keys `0`, API tokens `0`; details `[]`. |
| CPU managed Docker exact-prefix scan | pass | `ssh root@10.8.96.91` with managed Docker socket found no containers whose names or labels contained either prefix. |
| CPU XFS/project/path exact-prefix scan | pass | `find /data /etc/projects /etc/projid ...` and `grep` over `/etc/projects` and `/etc/projid` found no paths or project entries containing either prefix. |
| GPU managed Docker exact-prefix scan | pass | `ssh lyn@10.8.1.12` with managed Docker socket found no containers whose names or labels contained either prefix. |
| GPU XFS/project/path exact-prefix scan | pass | `sudo find /data0 /etc/projects /etc/projid ...` and `sudo grep` over `/etc/projects` and `/etc/projid` found no paths or project entries containing either prefix. |
| Temp credential/report directories | pass | Removed `/tmp/nyabase-murt-20260602t041011z-abe610` and `/tmp/nyabase-murt-20260602t040905z-f41c9c`; follow-up `ls -ld` returned no entries. |

### Health Checks

| Check | Status | Evidence |
| --- | --- | --- |
| Backend unauthenticated auth guard | pass | `GET http://localhost:3001/api/auth/me` returned HTTP `401`. |
| Frontend root | pass | `GET http://localhost:5173/` returned HTTP `200`. |
| VictoriaMetrics health | pass | `GET http://127.0.0.1:8428/health` returned HTTP `200`. |
| CPU services | pass | `ssh root@10.8.96.91 systemctl is-active nyabase-agent` and `nyabase-docker.service` returned `active`. |
| GPU services | pass | `ssh lyn@10.8.1.12 sudo systemctl is-active nyabase-agent` and `nyabase-docker.service` returned `active`. |
| Product CPU/GPU online status | pass | Admin `GET /api/servers` showed `nyabase-cpu-batch-20260601T163636Z` status `online` and `nyabase-gpu-batch-20260601T163636Z` status `online`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

### Commands Run

- `node <<'NODE' ... admin login from test/.env; exact-prefix/manifest cleanup for containers, data dirs, user server grants, user image grants, user mount grants, SSH keys, users, groups, images; residual product API scan; backend/frontend/VM/servers health ... NODE`
- `ssh root@10.8.96.91 '... DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker ps -a ... exact prefix grep; find /data /etc/projects /etc/projid ...; grep /etc/projects /etc/projid ...; systemctl is-active ...'`
- `ssh lyn@10.8.1.12 '... sudo env DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker ps -a ... exact prefix grep; sudo find /data0 /etc/projects /etc/projid ...; sudo grep /etc/projects /etc/projid ...; sudo systemctl is-active ...'`
- `curl -sS -o /tmp/nyabase-cleanup-auth.out -w 'backend_auth=%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-cleanup-front.out -w 'frontend=%{http_code}\n' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-cleanup-vm.out -w 'vm=%{http_code}\n' --max-time 8 http://127.0.0.1:8428/health`
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
- `rm -rf /tmp/nyabase-murt-20260602t041011z-abe610 /tmp/nyabase-murt-20260602t040905z-f41c9c`
- `ls -ld /tmp/nyabase-murt-20260602t041011z-abe610 /tmp/nyabase-murt-20260602t040905z-f41c9c 2>/dev/null || true`

### Blockers

None.

## Mount Source Fixture Setup

Prepared: `2026-06-02T05:27:00Z`
Role: devops
Run prefix: `mount-20260602t052140z-1f28fd`
Backend URL: `http://localhost:3001`
CPU server: `05cea385-d6ca-490a-a126-e00d0ae23b70`
Runtime directory: `/tmp/nyabase-mount-20260602t052140z-1f28fd`
State manifest: `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json`
Classification: `pass`

Created a fresh exact-prefix mount-source fixture through product admin APIs and documented runtime paths. Product source, tests, scripts, configs, lockfiles, deployment files, agent tokens, and unrelated services were not edited or rotated. Raw admin password, user passwords, JWTs, refresh tokens, API-token secrets, and agent tokens are not recorded here or in `state.json`. Per-user credential files are mode `0600` and contain only that user's credential pair.

### Fixture IDs

| Type | Label | ID / value | Evidence |
| --- | --- | --- | --- |
| source | local CPU XFS data disk | `7e2fc9db-1e94-4c53-867a-f4eba23ddffe` | `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks` returned `/data`, `pquotaEnabled=true`, `totalBytes=34292629504`, `usedBytes=3400380416`. CPU host `findmnt -T /data` showed `xfs ... prjquota`; `xfs_quota state -p /data` reported project quota accounting/enforcement `ON`. |
| source | remote CPU NFS | `7d9826c0-db37-420b-bc51-6b93932d3bc0` | `GET /api/system/remote-fs-mounts?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` returned the source assigned to the CPU server with `serverStatuses[CPU].status=mounted`; CPU `findmnt` showed `10.8.96.92:/srv/nyabase-mount-20260602t052140z-1f28fd nfs4 ... vers=4.2,rw`. |
| export | local NFS export | `/srv/nyabase-mount-20260602t052140z-1f28fd` | Exact `/etc/exports` line: `/srv/nyabase-mount-20260602t052140z-1f28fd 10.8.96.91(rw,sync,no_subtree_check,no_root_squash)`. Host-to-export readback wrote `host-to-export-mount-20260602t052140z-1f28fd`. |
| host mount | CPU remote mount point | `/mnt/nyabase-mount-20260602t052140z-1f28fd` | Product DTO and CPU `findmnt` both showed the mount point. |
| image | `ubuntu:24.04` | `cf1545e5-2cd9-49ea-be76-db285403b3c5` | Product image created with `cmd: "sleep 3600"` and granted to all three fixture users on CPU. |

### Users and Grants

| Persona | Username | User ID | Capabilities | Server grant | Image grant | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha-local | `mount-20260602t052140z-1f28fd-alpha-local` | `11cec13e-f783-4018-baaf-9a7be2ba04c0` | `[]` | `3115a2e7-e105-474c-a651-3e1f971f7fbf`, CPU only, `500/268435456/134217728`, `gpuMode=none` | `7d3f977a-53bd-44a6-bd07-24f98d15cc2a` | local only: `0c3738d9-b739-4018-a517-9330b0378d9e` -> `7e2fc9db-1e94-4c53-867a-f4eba23ddffe` |
| beta-remote | `mount-20260602t052140z-1f28fd-beta-remote` | `94766acd-3abf-40d7-95b1-94ad4dfead49` | `[]` | `033d1c84-58ad-44c1-9a5d-60bd7c2541b0`, CPU only, `500/268435456/134217728`, `gpuMode=none` | `04cd1835-5f21-4f69-8cf3-dc183e9130a0` | remote only: `80353fa3-8bea-4489-8faf-3a87da5c9007` -> `7d9826c0-db37-420b-bc51-6b93932d3bc0` |
| delta-both | `mount-20260602t052140z-1f28fd-delta-both` | `8a634f67-b6ae-470b-8e93-3d690cba6d05` | `[]` | `e6edbd96-f9c0-4964-9d5b-3a3456452f44`, CPU only, `1000/536870912/268435456`, `gpuMode=none` | `fedff72c-2504-496e-ac0b-5e8d8a08bbdd` | local: `87347061-fb6a-4f29-bed4-1b677905ed3c` -> `7e2fc9db-1e94-4c53-867a-f4eba23ddffe`; remote: `1c1f60e8-0018-400f-87c3-24c1b780d2f4` -> `7d9826c0-db37-420b-bc51-6b93932d3bc0` |

Credential files:

- `/tmp/nyabase-mount-20260602t052140z-1f28fd/alpha-local.env`, mode `0600`
- `/tmp/nyabase-mount-20260602t052140z-1f28fd/beta-remote.env`, mode `0600`
- `/tmp/nyabase-mount-20260602t052140z-1f28fd/delta-both.env`, mode `0600`

Restricted-user login and product API readback passed for all three users. `/api/auth/me` returned empty management capability arrays, `/api/servers` exposed the CPU server, `/api/images?activeOnly=true` exposed the fixture image with `cmd: "sleep 3600"`, and `/api/mount-sources?serverId=...` matched the intended local-only, remote-only, and local+remote grants.

### Health Checks

| Check | Status | Evidence |
| --- | --- | --- |
| Backend unauthenticated auth guard | pass | `GET http://localhost:3001/api/auth/me` returned HTTP `401`. |
| Frontend root | pass | `GET http://localhost:5173/` returned HTTP `200`. |
| VictoriaMetrics | pass | `GET http://127.0.0.1:8428/health` returned HTTP `200`. |
| CPU agent and managed Docker | pass | `ssh root@10.8.96.91` showed `nyabase-agent` active, `nyabase-docker.service` active, CPU server product status `online`, Docker daemon state `active`. |
| Common-src artifact guard | pass | Before and after setup, `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print` returned no paths. |
| Manifest hygiene | pass | `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json` mode `0600`; string scan found no `PASSWORD=`, `accessToken`, `refreshToken`, `Bearer`, `ADMIN_INIT_PASSWORD`, or `NYABASE_PASSWORD`. |

### Commands and Results

| Command/procedure | Exit/status | Result | Notes |
| --- | ---: | --- | --- |
| `node /tmp/nyabase-mount-fixture-runner.mjs` | `1` | harmless timing failure before user/NFS setup | First attempt created/registerd the exact-prefix `/data` disk row through `POST /api/servers/:cpuId/disks`, then failed because immediate live DTO merge still showed `pquotaEnabled=false`; a follow-up read showed the same disk row as `pquotaEnabled=true`. No users, image, NFS export, or remote FS were created in this failed attempt. |
| `node <<'NODE' ... admin login; GET /api/servers/:cpuId/disks; GET /api/servers/all-disks ... NODE` | `0` | pass | Readback showed local disk `7e2fc9db-1e94-4c53-867a-f4eba23ddffe`, `/data`, `pquotaEnabled=true`. |
| `NYABASE_MOUNT_RUN_STAMP=20260602t052140z NYABASE_MOUNT_RUN_SUFFIX=1f28fd node /tmp/nyabase-mount-fixture-runner.mjs` | `0` | pass | Reused the exact-prefix local disk row and completed NFS export, remote FS registration, users, image, grants, credential files, manifest, and health checks. |
| `node <<'NODE' ... verify state/credential modes, secret scan, API source/grant readback ... NODE` | `0` | pass | `state.json` and credential files were `0600`; state contained no raw secrets; source/grant API readback matched. |
| `grep -F '/srv/nyabase-mount-20260602t052140z-1f28fd 10.8.96.91(rw,sync,no_subtree_check,no_root_squash)' /etc/exports` | `0` | pass | Exact NFS export line exists. |
| `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` | `0` | pass | No common source compiled artifacts. |

Setup commands that changed runtime state were exact-prefix scoped:

- `chmod 0777 /srv/nyabase-mount-20260602t052140z-1f28fd`
- `cp /etc/exports /tmp/nyabase-exports-backup-mount-20260602t052140z-1f28fd`
- `printf '%s\n' "/srv/nyabase-mount-20260602t052140z-1f28fd 10.8.96.91(rw,sync,no_subtree_check,no_root_squash)" >> /etc/exports`
- `exportfs -ra`

No unrelated NFS exports were modified. `nfs-server` service was already `active`; no service restart was performed.

### Cleanup Plan

Use exact ids and paths from `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json`; do not broad-delete unrelated product rows, exports, or host paths. Recommended order:

1. Delete any fixture containers/data dirs created by later tester runs for run prefix `mount-20260602t052140z-1f28fd`.
2. Delete mount-source grants: `0c3738d9-b739-4018-a517-9330b0378d9e`, `80353fa3-8bea-4489-8faf-3a87da5c9007`, `87347061-fb6a-4f29-bed4-1b677905ed3c`, `1c1f60e8-0018-400f-87c3-24c1b780d2f4`.
3. Delete image grants: `7d3f977a-53bd-44a6-bd07-24f98d15cc2a`, `04cd1835-5f21-4f69-8cf3-dc183e9130a0`, `fedff72c-2504-496e-ac0b-5e8d8a08bbdd`.
4. Delete server grants: `3115a2e7-e105-474c-a651-3e1f971f7fbf`, `033d1c84-58ad-44c1-9a5d-60bd7c2541b0`, `e6edbd96-f9c0-4964-9d5b-3a3456452f44`.
5. Delete image `cf1545e5-2cd9-49ea-be76-db285403b3c5`.
6. Delete remote FS mount `7d9826c0-db37-420b-bc51-6b93932d3bc0`.
7. Delete users `11cec13e-f783-4018-baaf-9a7be2ba04c0`, `94766acd-3abf-40d7-95b1-94ad4dfead49`, `8a634f67-b6ae-470b-8e93-3d690cba6d05`.
8. Delete local data disk registration `7e2fc9db-1e94-4c53-867a-f4eba23ddffe` if no later tester run still uses it.
9. Remove the exact `/etc/exports` line `/srv/nyabase-mount-20260602t052140z-1f28fd 10.8.96.91(rw,sync,no_subtree_check,no_root_squash)`, then run `exportfs -ra`.
10. Remove `/srv/nyabase-mount-20260602t052140z-1f28fd`, CPU host mount point `/mnt/nyabase-mount-20260602t052140z-1f28fd` after product unmount, and `/tmp/nyabase-mount-20260602t052140z-1f28fd`.

### Verdict

Mount-source fixture setup: PASS. The fixture is ready for user-state tester coverage of local-only, remote-only, and local+remote mount-source data-dir paths.

## Mount Source Runtime Matrix

Prepared: `2026-06-02T05:33:39Z`
Role: tester
Command: `NYABASE_MOUNT_STATE=/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json pnpm exec vitest run test/multi-user-redteam-mount-sources.spec.ts --reporter=verbose`
Suite: `test/multi-user-redteam-mount-sources.spec.ts`
Counts: `0 passed / 1 failed / 0 skipped`
Classification: `fail-product`

The suite used only the three fixture user credential files from `/tmp/nyabase-mount-20260602t052140z-1f28fd/`:

- `alpha-local.env`
- `beta-remote.env`
- `delta-both.env`

No admin credentials, host/SSH access, raw passwords, JWTs, refresh tokens, API-token secrets, fixture users/images/sources/grants cleanup, product source edits, setup spec edits, scripts, configs, lockfiles, or session-doc edits outside this test record were used.

Runtime reports:

- Markdown: `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.md`
- JSON: `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.json`

### Result

The suite reproduced a product failure in the in-use data-dir delete guard:

| Check | Expected | Actual |
| --- | --- | --- |
| `DELETE /api/data-dirs/05cea385-d6ca-490a-a126-e00d0ae23b70/7e2fc9db-1e94-4c53-867a-f4eba23ddffe/mount-20260602t052140z-1f28fd-alpha-share?sourceKind=local` while two alpha-owned running containers had that data dir mounted | Conflict/bad request style status (`400`, `409`, `422`, or equivalent failure) and mounted container remains healthy | HTTP `204`; the directory was removed while still mounted |

Failure evidence: `test/multi-user-redteam-mount-sources.spec.ts` line asserting the delete guard, plus `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.md`.

### Covered Before Failure

| Acceptance criterion | Runtime evidence |
| --- | --- |
| AC 1 all three users login with own credentials and no management caps | Covered before failure: `POST /auth/login` and `GET /auth/me` returned `200`; management capability arrays were empty for alpha-local, beta-remote, and delta-both. |
| AC 2 alpha-local local source and same-owner sharing | Partially covered before failure: alpha listed only local source, created a local data dir, created two own CPU containers mounting the same dir, wrote/read marker across both via product console WebSocket exec. Cleanup succeeded. The alpha remote-source denial also returned `403`. |
| AC 5 source denial subset | Partially covered before failure: alpha could not list/create/use remote source; beta could not list/create/use local source. |
| AC 6 in-use delete guard | Covered and failed: mounted data-dir delete returned `204` instead of conflict/bad request. |
| AC 8 reports include status codes, ids/names, cleanup status, and no raw secrets | Covered: reports written; `No raw secrets recorded: true`. |
| AC 9 no spec-created containers/data dirs remain visible through user APIs | Covered: final residuals were zero for alpha-local, beta-remote, and delta-both. |

AC 3 beta remote full read/write, AC 4 delta both local+remote read/write, AC 5 cross-user delete guessing, and AC 7 dynamic mount patch were not reached because tester stop conditions require reporting the first product failure without masking it.

### Cleanup

Spec-created runtime objects were cleaned up through user APIs only:

- `alpha-local` container `mount-20260602t052140z-1f28fd-alpha-two`: `DELETE /containers/...` returned `200`
- `alpha-local` container `mount-20260602t052140z-1f28fd-alpha-one`: `DELETE /containers/...` returned `200`
- `alpha-local` data dir `mount-20260602t052140z-1f28fd-alpha-share`: follow-up best-effort delete returned `404` because the failing in-use delete had already removed it

Final residuals from user APIs:

- `alpha-local`: `containers=0`, `dataDirs=0`
- `beta-remote`: `containers=0`, `dataDirs=0`
- `delta-both`: `containers=0`, `dataDirs=0`

Visual artifacts: n/a, backend/API runtime only.

## Data-Dir Delete Guard Backend Unit Tests

Prepared: `2026-06-02T05:45:39Z`
Role: tester
Changed test file: `packages/backend/src/datadirs/datadirs.service.test.ts`
Classification: `pass`

Focused backend unit coverage was added for the backend-only `DataDirsService.deleteDir()` mounted-directory guard. Product source, runtime specs, scripts, configs, lockfiles, frontend files, agent/common files, live backend processes, and fixture/runtime state were not edited. The live mount runtime spec was intentionally not rerun in this dispatch because the running backend still requires devops rebuild/restart before live verification.

### Commands

- `pnpm --filter @nyabase/backend exec vitest run src/datadirs/datadirs.service.test.ts --reporter=verbose`
  - Result: `1` test file passed; `4 passed / 0 failed / 0 skipped`.
- `pnpm --filter @nyabase/backend test -- --reporter=verbose`
  - Result: `10` test files passed; `79 passed / 0 failed / 0 skipped`.

### Coverage

| Dispatch acceptance criterion | Covered by |
| --- | --- |
| AC 1 exact local source/user/server/dir mounted by a running container conflicts and skips agent/DB delete | `DataDirsService.deleteDir mount guard > throws conflict without agent or DB deletion when the exact local directory is mounted by a running container` |
| AC 2 remote source with data-dir row `serverId: null` and runtime-server mount row conflicts | `DataDirsService.deleteDir mount guard > throws conflict for a remote directory whose DB row has null serverId but mount row is running on the runtime server` |
| AC 3 null, missing, and non-running mount rows do not block; successful path remains agent-first before DB delete/audit | `DataDirsService.deleteDir mount guard > allows deletion for null, missing, and non-running mount rows while keeping agent-first deletion ordering` |
| AC 4 unrelated user/source/server/dir running mount rows do not block requested deletion | `DataDirsService.deleteDir mount guard > ignores running mount rows for unrelated user, source, server, or directory scope` |
| AC 5 relevant backend tests pass and backend-only visual artifacts recorded as n/a | Focused datadirs command and backend package unit command above; visual artifacts below |

### Failures

None.

Visual artifacts: n/a (backend-only change).

## Backend Rebuild and Restart After Data-Dir Delete Guard Fix

Prepared: `2026-06-02T05:50:41Z`
Role: devops
Classification: `pass`

Built the backend package and restarted only the local backend process so `localhost:3001` serves the freshly compiled `packages/backend/dist/main.js`. Product source, tests, scripts, configs, lockfiles, fixture resources, users, images, sources, grants, and mount fixture state under `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json` were not edited or cleaned up.

| Check | Status | Evidence |
| --- | --- | --- |
| Backend build | pass | `pnpm --filter @nyabase/backend build` exited `0`. `packages/backend/dist/main.js` timestamp changed from `2026-06-02 12:49:49.121081520 +0800` to `2026-06-02 13:49:26.165911672 +0800`; size `3183` bytes. |
| Backend restart | pass | Existing listener was `node` pid `1895873` on port `3001`, cwd `/root/nyabase/packages/backend`. Stopped it with `tmux send-keys -t %0 C-c`; confirmed `stopped`. Relaunched pane `%0` with `cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js`. New listener is pid `1918362`, cwd `/root/nyabase/packages/backend`, command `node -r tsconfig-paths/register dist/main.js`. |
| Backend startup evidence | pass | tmux capture showed `Nest application successfully started`, `Backend listening on port 3001`, and CPU/GPU agent reconnect logs for pid `1918362`. |
| Backend auth guard | pass | `curl -sS -o /tmp/nyabase-auth-me-after-datadir-restart.out -w '%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me` returned HTTP `401`. |
| Frontend root | pass | `curl -sS -o /tmp/nyabase-frontend-root-after-datadir-restart.out -w '%{http_code}\n' --max-time 8 http://localhost:5173/` returned HTTP `200`. |
| VictoriaMetrics health | pass | `curl -sS -o /tmp/nyabase-vm-health-after-datadir-restart.out -w '%{http_code}\n' --max-time 8 http://127.0.0.1:8428/health` returned HTTP `200`. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

Commands run:

- `pnpm --filter @nyabase/backend build`
- `stat -c '%y %s %n' packages/backend/dist/main.js`
- `tmux send-keys -t %0 C-c`
- `tmux send-keys -t %0 'cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js' Enter`
- `curl -sS -o /tmp/nyabase-auth-me-after-datadir-restart.out -w '%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me`
- `curl -sS -o /tmp/nyabase-frontend-root-after-datadir-restart.out -w '%{http_code}\n' --max-time 8 http://localhost:5173/`
- `curl -sS -o /tmp/nyabase-vm-health-after-datadir-restart.out -w '%{http_code}\n' --max-time 8 http://127.0.0.1:8428/health`
- `ss -ltnp 'sport = :3001'`
- `ps -o pid,ppid,pgid,sid,stat,etime,cmd -p 1918362`
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`

No raw admin password, JWT, refresh token, API-token secret, or agent token was recorded.

## Mount-Source Runtime Matrix Rerun After Data-Dir Guard Restart

Prepared: `2026-06-02T05:53:40Z`
Role: tester
Runtime manifest: `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json`
Command: `NYABASE_MOUNT_STATE=/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json pnpm exec vitest run test/multi-user-redteam-mount-sources.spec.ts --reporter=verbose`
Suite: `test/multi-user-redteam-mount-sources.spec.ts`
Counts: `0 passed / 1 failed / 0 skipped`
Classification: `fail-product`

The suite used only the three fixture user credential files from `/tmp/nyabase-mount-20260602t052140z-1f28fd/`:

- `alpha-local.env`
- `beta-remote.env`
- `delta-both.env`

No admin credentials, host/SSH access, product source edits, backend rebuild/restart, dependency installs, fixture users/images/sources/grants cleanup, NFS export cleanup, host-path cleanup, raw passwords, JWTs, refresh tokens, or API-token secrets were used or recorded.

Runtime reports:

- Markdown: `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.md`
- JSON: `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.json`

### Rerun Result

The rerun no longer reached the prior in-use delete guard assertion. It failed earlier on a valid alpha-local container create using the granted local mount source.

| Step | Actor | Method | Path | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| login alpha-local | `mount-20260602t052140z-1f28fd-alpha-local` (`11cec13e-f783-4018-baaf-9a7be2ba04c0`) | `POST` | `/auth/login` | `200` | `200` |
| login beta-remote | `mount-20260602t052140z-1f28fd-beta-remote` (`94766acd-3abf-40d7-95b1-94ad4dfead49`) | `POST` | `/auth/login` | `200` | `200` |
| login delta-both | `mount-20260602t052140z-1f28fd-delta-both` (`8a634f67-b6ae-470b-8e93-3d690cba6d05`) | `POST` | `/auth/login` | `200` | `200` |
| alpha source visibility | alpha-local | `GET` | `/mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` | local source only | `200`, count `1`, source `local:7e2fc9db-1e94-4c53-867a-f4eba23ddffe` |
| beta source visibility | beta-remote | `GET` | `/mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` | remote source only | `200`, count `1`, source `remote:7d9826c0-db37-420b-bc51-6b93932d3bc0` |
| delta source visibility | delta-both | `GET` | `/mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` | local and remote sources only | `200`, count `2`, sources `local:7e2fc9db-1e94-4c53-867a-f4eba23ddffe`, `remote:7d9826c0-db37-420b-bc51-6b93932d3bc0` |
| alpha denied remote data dir | alpha-local | `POST` | `/data-dirs` | denied | `403`, `No access to this data source` |
| alpha denied remote mounted container | alpha-local | `POST` | `/containers` | denied | `403`, `Mount source remote:7d9826c0-db37-420b-bc51-6b93932d3bc0 not authorized` |
| beta denied local data dir | beta-remote | `POST` | `/data-dirs` | denied | `403`, `No access to this data source` |
| beta denied local mounted container | beta-remote | `POST` | `/containers` | denied | `403`, `Mount source local:7e2fc9db-1e94-4c53-867a-f4eba23ddffe not authorized` |
| create alpha local data dir | alpha-local | `POST` | `/data-dirs` | `200/201` | `201`, data dir `mount-20260602t052140z-1f28fd-alpha-share`, id `b5f98b97-cd63-422b-be65-b37ef2a96f04` |
| create alpha mounted container | alpha-local | `POST` | `/containers` | `200/201` | `500`, body summary `Internal server error`; follow-up own-container list showed one run-prefix container named `mount-20260602t052140z-1f28fd-alpha-one` |

Failure evidence: `test/multi-user-redteam-mount-sources.spec.ts` assertion in `createMountedContainer()`, plus `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.md`.

### Acceptance Criteria Coverage

| Dispatch acceptance criterion | Runtime evidence |
| --- | --- |
| AC 1 alpha-local local source visible, remote denied, same-owner sharing, in-use delete guard, cleanup | Partially covered and failed. Alpha local source was visible, alpha remote source use was denied with `403`, and alpha local data-dir creation returned `201`. Valid alpha local mounted-container create returned `500` instead of `200/201`, so same-owner sharing and the delete guard were not reached. |
| AC 2 beta-remote remote source visible, local denied, remote read/write, cross-user delete guesses, cleanup | Partially covered before failure. Beta remote source was visible, and beta local source use was denied with `403`. Remote mount read/write and cross-user delete guessing were not reached after the alpha product failure. |
| AC 3 delta-both local and remote visible, both mount paths read/write, dynamic mount patch add/remove, cleanup | Partially covered before failure. Delta listed both local and remote sources. Delta mount read/write and dynamic patch add/remove were not reached after the alpha product failure. |
| AC 4 reports include status codes, user aliases/ids, source ids, cleanup/final residuals, and no raw secrets | Covered. Runtime Markdown and JSON reports were written with status codes, safe aliases, user ids, source ids, cleanup entries, final residuals, and `No raw secrets recorded: true`. |
| AC 5 final residuals for spec-created containers/data dirs are zero via user APIs | Covered and failed. Final residuals were non-zero for alpha-local via user APIs: `containers=1`, `dataDirs=1`; beta-remote and delta-both were zero. |

### Cleanup and Residuals

Spec cleanup used user APIs only. Because `POST /containers` returned `500` before the spec could track the created container id, cleanup could not remove the mutated container. The fixed data-dir guard then correctly prevented deleting the in-use data dir:

- `alpha-local` data dir `mount-20260602t052140z-1f28fd-alpha-share`: best-effort `DELETE /data-dirs/...` returned `409`
- `alpha-local` residual check: failed, one run-prefix container remained

Final residuals from user APIs:

- `alpha-local`: `containers=1`, `dataDirs=1`, `containerNames=mount-20260602t052140z-1f28fd-alpha-one`, `dataDirNames=mount-20260602t052140z-1f28fd-alpha-share`
- `beta-remote`: `containers=0`, `dataDirs=0`
- `delta-both`: `containers=0`, `dataDirs=0`

Visual artifacts: n/a, backend/API runtime only.

## Backend Error Evidence for Mount-Source Container 500

Prepared: `2026-06-02T06:16:00Z`
Role: devops
Scope: non-mutating backend log capture for the failed alpha-local `POST /api/containers` in runtime report `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.md`. Product source, tests, fixtures, running services, residual containers, data dirs, remote hosts, SSH, and admin credentials were not touched.

### Commands and Results

| Command | Exit | Result |
| --- | --- | --- |
| `sed -n '1,260p' /tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.md` | `0` | Confirmed failure window `2026-06-02T05:53:02.501Z` to `2026-06-02T05:53:05.176Z`; valid alpha-local mounted container create returned `500` and follow-up own-container list showed one created container. |
| `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_start_command}'` | `0` | Confirmed backend pane `%0` exists and is running `node`. |
| `tmux capture-pane -pJ -t %0 -S -10000 \| rg -C 10 'mount-20260602t052140z\|POST /api/containers\|500\|error\|Error\|failed\|Failed\|TypeError\|ReferenceError'` | `0` | Captured matching backend pane history around the runtime window. |
| `tmux capture-pane -pJ -t %0 -S -10000 \| rg -C 20 'Container mount verification failed after reconcileContainerMounts'` | `0` | Captured exact backend exception and stack. No fallback process/log metadata inspection was needed. |

### Evidence Summary

Backend log evidence: `pass`
Likely failing component: post-agent ACK handling for container mount verification after `reconcileContainerMounts`, surfaced through `AgentSession.resolveAck` and `AgentGateway.handleMessage`.

The tmux backend pane logged the exception at `06/02/2026, 1:53:05 PM` local time (`2026-06-02T05:53:05Z`), matching the runtime failure finish.

Sanitized relevant backend output:

```text
[Nest] 1918362  - 06/02/2026, 1:53:05 PM   ERROR [ExceptionsHandler] Container mount verification failed after reconcileContainerMounts: mismatched mount dockerId=61997314d2a2659432abe00d35a679c667b1a662edb52e110c4ea517ec4162b4 pid=2194716 expectedSource=/data/mount-20260602t052140z-1f28fd-alpha-share actualSource=/dev/sdb destination=/mnt/shared proofFailure=containing host mount /data is xfs, not nfs/nfs4
Error: Container mount verification failed after reconcileContainerMounts: mismatched mount dockerId=61997314d2a2659432abe00d35a679c667b1a662edb52e110c4ea517ec4162b4 pid=2194716 expectedSource=/data/mount-20260602t052140z-1f28fd-alpha-share actualSource=/dev/sdb destination=/mnt/shared proofFailure=containing host mount /data is xfs, not nfs/nfs4
    at AgentSession.resolveAck (/root/nyabase/packages/backend/dist/gateway/agent-session.js:53:28)
    at AgentGateway.handleMessage (/root/nyabase/packages/backend/dist/gateway/agent-gateway.js:207:29)
    at WebSocket.<anonymous> (/root/nyabase/packages/backend/dist/gateway/agent-gateway.js:160:40)
```

Nearby context included repeated `DataDirReconcilerService` warnings for server `05cea385-d6ca-490a-a126-e00d0ae23b70` with `orphans=6 missing=0`, immediately before the exception. The error text indicates the backend rejected the created container after mount verification because the observed mount source was `/dev/sdb` while the expected source was `/data/mount-20260602t052140z-1f28fd-alpha-share`; the proof check treated containing host mount `/data` as invalid because it was `xfs`, not `nfs/nfs4`.

## Local XFS Mount Source Unit Test

Prepared: `2026-06-02T06:14:00Z`
Role: tester
Command: `pnpm --filter @nyabase/agent exec vitest run src/commands/dispatcher.test.ts --reporter=verbose`
Suite: `packages/agent/src/commands/dispatcher.test.ts`
Counts: `30 passed / 0 failed / 0 skipped`
Classification: `pass`

Focused agent unit coverage was added for local XFS mount-source verification after the live alpha local mount failed because mount-helper reported the containing XFS backing device instead of the expected subdirectory host path. No product source, runtime specs, scripts, configs, lockfiles, frontend files, backend files, live services, containers, data directories, or fixture resources were edited or cleaned up.

Failure details: none. The suite emitted expected stderr from negative-path tests where `CommandDispatcher` logs intentionally failed acknowledgements.

### Coverage

| Acceptance criterion | Covered by |
| --- | --- |
| AC 1 local XFS expected host path under `/data` accepts helper-reported backing device `/dev/sdb` | `CommandDispatcher dynamic container mounts > acks applyContainerMount when a local XFS mount reports the containing backing device` |
| AC 2 existing exact-source success still passes | `CommandDispatcher dynamic container mounts > verifies applyContainerMount after mount-helper mount and acks success when destination and source match` |
| AC 2 existing NFS canonical-source success still passes | `CommandDispatcher dynamic container mounts > acks applyContainerMount when an NFS canonical source matches the host mount plus suffix` |
| AC 3 local non-XFS mismatch remains rejected with local-source/not-XFS proof | `CommandDispatcher dynamic container mounts > returns failed ack for non-exact local sources backed by a non-XFS host mount` |
| AC 4 local XFS wrong backing source remains rejected with local backing-source mismatch proof | `CommandDispatcher dynamic container mounts > returns failed ack when a local XFS mount reports the wrong backing source` |
| AC 5 command, counts, failures, coverage, and visual artifacts are recorded | this section |

Visual artifacts: n/a, backend/agent-only unit test change.
Live runtime note: the focused mount-source runtime matrix was not run in this dispatch; devops still needs to build, deploy, and restart the CPU agent first.

## CPU Agent Deploy and Exact Alpha Residual Cleanup

Prepared: `2026-06-02T06:21:29Z`
Role: devops
Runtime manifest: `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json`
Target CPU host: `root@10.8.96.91`
Classification: `pass`

Built and deployed the updated CPU agent binary, restarted only `nyabase-agent`/`nyabase-docker.service` on the CPU host, verified reconnect/health, and cleaned only the exact alpha-local residual from the previous failed mount runtime run. Product source, tests, scripts, configs, lockfiles, fixture users, images, grants, mount sources, NFS export, and host fixture directories were not edited or broadly cleaned. Raw passwords, JWTs, refresh tokens, API-token secrets, and agent tokens were not recorded.

| Check | Status | Evidence |
| --- | --- | --- |
| Agent build | pass | `bash scripts/build-agent-binary.sh` exited `0`; produced `dist/nyabase-agent` size `75989610` bytes, timestamp `2026-06-02 14:18:11 +0800`, sha256 `00f93504832fc8e109935e26f57889a7ea3f18ee413b22d9db15bfce96eb39b3`. |
| Remote binary replacement | pass | Previous `/usr/local/bin/nyabase-agent` sha256 was `234aaa8ac9a11afe93ab8e730c3be52d47372e3ebcb4eea97e18c21200f781f5`; after `scp`/`chmod`, remote sha256 matched local `00f93504832fc8e109935e26f57889a7ea3f18ee413b22d9db15bfce96eb39b3`. |
| Remote restart | pass | `ssh root@10.8.96.91 'systemctl stop nyabase-agent; systemctl stop nyabase-docker.service 2>/dev/null || true; rm -f /usr/local/bin/nyabase-agent'` exited `0`; `systemctl start nyabase-agent` exited `0`. |
| Service health | pass | `systemctl is-active nyabase-agent` returned `active`; `systemctl is-active nyabase-docker.service` returned `active`. |
| Agent reconnect | pass | CPU agent journal after restart showed `Started nyabase-agent`, `nyabase-docker daemon is running`, and `[WS] Connected` at `Jun 02 14:18:58`. Backend pane showed `Agent disconnected` at `2:18:36 PM` and `Agent connected: server=nyabase-cpu-batch-20260601T163636Z (05cea385-d6ca-490a-a126-e00d0ae23b70)` at `2:18:58 PM`. |
| Backend health | pass | `GET http://localhost:3001/api/auth/me` returned HTTP `401`; admin API `GET /api/servers` returned CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` status `online`. |
| Exact residual precheck | pass | Remote managed Docker exact residual had Docker ID `61997314d2a2659432abe00d35a679c667b1a662edb52e110c4ea517ec4162b4`, product label `nyabase.container_name=mount-20260602t052140z-1f28fd-alpha-one`, owner `11cec13e-f783-4018-baaf-9a7be2ba04c0`, server `05cea385-d6ca-490a-a126-e00d0ae23b70`; exact host dir `/data/mount-20260602t052140z-1f28fd-alpha-share` existed. |
| Exact container cleanup | pass | Alpha-local user API `DELETE /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/61997314d2a2659432abe00d35a679c667b1a662edb52e110c4ea517ec4162b4` returned `200`; follow-up alpha-owned run-prefix container list returned `0`. |
| Exact data-dir cleanup | pass | Alpha-local user API `DELETE /api/data-dirs/05cea385-d6ca-490a-a126-e00d0ae23b70/7e2fc9db-1e94-4c53-867a-f4eba23ddffe/mount-20260602t052140z-1f28fd-alpha-share?sourceKind=local` returned `204`; follow-up alpha run-prefix data-dir list returned `0`. |
| Post-cleanup API residuals | pass | User API checks for `alpha-local`, `beta-remote`, and `delta-both` each returned `containers=0` and `dataDirs=0` for run prefix `mount-20260602t052140z-1f28fd`. |
| Post-cleanup Docker/host residuals | pass | Exact Docker inspect by previous ID returned absent; Docker filters by exact product label/name returned absent; exact host dir `/data/mount-20260602t052140z-1f28fd-alpha-share` returned absent. |
| Common-src artifact guard | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no paths. |

Commands run:

- `bash scripts/build-agent-binary.sh` -> exit `0`.
- `stat -c '%y %s %n' dist/nyabase-agent && sha256sum dist/nyabase-agent` -> exit `0`.
- `ssh root@10.8.96.91 '... stat/sha256sum /usr/local/bin/nyabase-agent ...'` -> exit `0`.
- `ssh root@10.8.96.91 'set -eu; systemctl stop nyabase-agent; systemctl stop nyabase-docker.service 2>/dev/null || true; rm -f /usr/local/bin/nyabase-agent'` -> exit `0`.
- `scp dist/nyabase-agent root@10.8.96.91:/usr/local/bin/nyabase-agent` -> exit `0`.
- `ssh root@10.8.96.91 'set -eu; chmod +x /usr/local/bin/nyabase-agent; systemctl start nyabase-agent; stat ...; sha256sum ...'` -> exit `0`.
- `ssh root@10.8.96.91 '... systemctl is-active ...; journalctl -u nyabase-agent -n 40 --no-pager ...'` -> exit `0`.
- `curl -sS -o /tmp/nyabase-auth-me-after-agent-deploy.out -w '%{http_code}\n' --max-time 8 http://localhost:3001/api/auth/me` -> exit `0`, HTTP `401`.
- `node <<'NODE' ... admin login from test/.env; GET /api/servers; print only CPU id/name/status ... NODE` -> exit `0`, CPU status `online`.
- `node <<'NODE' ... alpha-local login; list exact run-prefix resources; delete exact container; delete exact data dir ... NODE` -> exit `0`.
- `node <<'NODE' ... alpha/beta/delta login; list user API run-prefix containers/dataDirs ... NODE` -> exit `0`, all counts `0`.
- `ssh root@10.8.96.91 '... docker inspect/filter exact residual; exact hostdir check ...'` -> exit `0`, exact Docker ID/label/name and hostdir absent.
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort` -> exit `0`, no output.

Visual artifacts: n/a, backend/agent/runtime DevOps dispatch only.

## Mount-Source Runtime Matrix Rerun After CPU Agent Deploy

Prepared: `2026-06-02T06:25:30Z`
Role: tester
Runtime manifest: `/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json`
Command: `NYABASE_MOUNT_STATE=/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json pnpm exec vitest run test/multi-user-redteam-mount-sources.spec.ts --reporter=verbose`
Suite: `test/multi-user-redteam-mount-sources.spec.ts`
Counts: `1 passed / 0 failed / 0 skipped`
Classification: `pass`

The suite used only the three fixture user credential files from `/tmp/nyabase-mount-20260602t052140z-1f28fd/`:

- `alpha-local.env`
- `beta-remote.env`
- `delta-both.env`

No admin credentials, host/SSH access, product source edits, backend/agent build or restart, dependency installs, fixture users/images/sources/grants cleanup, NFS export cleanup, host-path cleanup, raw passwords, JWTs, refresh tokens, or API-token secrets were used or recorded.

Runtime reports:

- Markdown: `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.md`
- JSON: `/tmp/nyabase-mount-20260602t052140z-1f28fd/mount-runtime-report.json`

### Rerun Result

Runtime report status: `pass`; started `2026-06-02T06:24:38.676Z`, finished `2026-06-02T06:25:21.087Z`. The report records `No raw secrets recorded: true`.

### Status-Code Evidence

| Check | Actor | Method/path | Actual |
| --- | --- | --- | --- |
| login and self identity | alpha-local `mount-20260602t052140z-1f28fd-alpha-local` (`11cec13e-f783-4018-baaf-9a7be2ba04c0`) | `POST /auth/login`, `GET /auth/me` | `200`, `200`; management caps `none` |
| login and self identity | beta-remote `mount-20260602t052140z-1f28fd-beta-remote` (`94766acd-3abf-40d7-95b1-94ad4dfead49`) | `POST /auth/login`, `GET /auth/me` | `200`, `200`; management caps `none` |
| login and self identity | delta-both `mount-20260602t052140z-1f28fd-delta-both` (`8a634f67-b6ae-470b-8e93-3d690cba6d05`) | `POST /auth/login`, `GET /auth/me` | `200`, `200`; management caps `none` |
| source visibility | alpha-local | `GET /mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` | `200`; only `local:7e2fc9db-1e94-4c53-867a-f4eba23ddffe` |
| source visibility | beta-remote | `GET /mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` | `200`; only `remote:7d9826c0-db37-420b-bc51-6b93932d3bc0` |
| source visibility | delta-both | `GET /mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` | `200`; both `local:7e2fc9db-1e94-4c53-867a-f4eba23ddffe` and `remote:7d9826c0-db37-420b-bc51-6b93932d3bc0` |
| denied ungranted remote source | alpha-local | `POST /data-dirs`, `POST /containers` with remote source | `403`, `403`; mount source denied |
| denied ungranted local source | beta-remote | `POST /data-dirs`, `POST /containers` with local source | `403`, `403`; mount source denied |
| alpha local create/share/read-write | alpha-local | `POST /data-dirs`, two `POST /containers`, console exec write/read on `/mnt/shared` | data dir `201`; containers `201`, `201`; exec session `201`; WS read/write `200` |
| alpha in-use delete guard | alpha-local | `DELETE /data-dirs/.../mount-20260602t052140z-1f28fd-alpha-share?sourceKind=local` while mounted | `409`; follow-up `GET /containers/...` returned `200` and container remained visible |
| alpha same-owner and cross-user denial | delta-both against alpha local dir | `DELETE /data-dirs/...alpha-share?sourceKind=local` while mounted and again after cleanup | `404`, `404`; target state not changed |
| beta remote read/write | beta-remote | `POST /data-dirs`, `POST /containers`, console exec write/read on `/mnt/remote` | data dir `201`; container `201`; exec session `201`; WS read/write `200` |
| beta cross-user delete denial | delta-both against beta remote dir | `DELETE /data-dirs/...beta-remote?sourceKind=remote` while mounted and again after cleanup | `404`, `404`; target state not changed |
| delta local and remote read/write | delta-both | local and remote `POST /data-dirs`, two mounted `POST /containers`, console exec write/read | data dirs `201`, `201`; containers `201`, `201`; exec sessions `201`, `201`; WS read/write `200`, `200` |
| dynamic mount patch | delta-both | plain `POST /containers`, `GET/PATCH/GET /mounts`, exec write/read, `PATCH []`, final `GET /mounts` | container `201`; initial mounts `200` empty; patch add `200`; readback `200`; exec session `201`; WS read/write `200`; patch remove `200`; final mounts `200` empty |
| runtime cleanup | alpha-local, beta-remote, delta-both | container deletes, data-dir deletes, final residual lists | six container deletes returned `200`; five data-dir deletes returned `204`; final residual list calls returned `200` |

Spec-created objects: created `6` containers and `5` data dirs; deleted `6` containers and `5` data dirs through user APIs.

### Acceptance Criteria Coverage

| Dispatch acceptance criterion | Runtime evidence |
| --- | --- |
| AC 1 alpha-local local source visible, remote denied, same-owner local shared read/write, in-use delete guard returns conflict/bad-request, mounted container healthy, cleanup | Covered and passed. Alpha listed only local source; remote source creation/use returned `403`; two local-mounted containers shared marker `alpha-to-alpha`; in-use delete returned `409`; follow-up container detail returned `200`; alpha final residuals were zero. |
| AC 2 beta-remote remote source visible, local denied, remote mount read/write, cross-user delete guesses denied, cleanup | Covered and passed. Beta listed only remote source; local source creation/use returned `403`; remote mount marker `beta-remote-rw` was written/read; delta delete guesses returned `404`; beta final residuals were zero. |
| AC 3 delta-both local and remote sources visible, both mount paths read/write, dynamic mount patch add/remove, cleanup | Covered and passed. Delta listed both sources; local marker `delta-local-rw` and remote marker `delta-remote-rw` were written/read; dynamic remote mount patch add/read/write/remove returned `200` with final empty mount list; delta final residuals were zero. |
| AC 4 reports include status codes, user ids/names or safe aliases, source ids, cleanup/final residuals, and no raw secrets | Covered and passed. Runtime Markdown and JSON reports include status-code rows, user aliases/user ids, source ids, cleanup/deleted entries, `No raw secrets recorded: true`, and final residuals. |
| AC 5 final residuals for spec-created containers/data dirs are zero via user APIs | Covered and passed. Final residuals from user API checks: alpha-local `containers=0 dataDirs=0`, beta-remote `containers=0 dataDirs=0`, delta-both `containers=0 dataDirs=0`. |

### Cleanup and Residuals

The spec cleaned up only its own runtime containers and data dirs. Fixture users, image, mount sources, grants, NFS export, and host fixture directories were left intact as required.

Final residuals from user APIs:

- `alpha-local`: `containers=0`, `dataDirs=0`, `containerNames=none`, `dataDirNames=none`
- `beta-remote`: `containers=0`, `dataDirs=0`, `containerNames=none`, `dataDirNames=none`
- `delta-both`: `containers=0`, `dataDirs=0`, `containerNames=none`, `dataDirNames=none`

Visual artifacts: n/a, backend/API runtime only.

## Final Standard Repository Check

Prepared: `2026-06-02T06:40:01Z`
Role: devops
Command: `bash scripts/check.sh`
Exit code: `0`
Classification: `pass`

The standard repository check ran without `--with-visual`, so frontend visual checks were not invoked. Product source, tests, scripts, configs, lockfiles, runtime services, and unrelated resources were not edited or cleaned up.

### Status Summary

| Surface | Typecheck | Lint | Tests |
| --- | --- | --- | --- |
| common | pass | pass | `36/0/0` |
| backend | pass | pass | `79/0/0` |
| agent | pass | pass | `55/0/0` |
| frontend | pass | pass | `0/0/0` (not run by `scripts/check.sh`; no frontend unit-test script is invoked by root `test:unit`) |

| Check | Status | Evidence |
| --- | --- | --- |
| Common-src artifact guard | pass | `scripts/check.sh` completed past its initial `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print -quit` guard with no artifact reported. |
| Frontend visual | skipped | `bash scripts/check.sh` was run without `--with-visual`; no Playwright report or diff artifacts were produced by this command. |

Lint completed with warnings only and exit `0`; warnings were reported in existing agent, backend, and frontend files. No failing output tail was present.

### Required Check Format

```text
Command: bash scripts/check.sh
Exit code: 0
Backend typecheck: pass
Backend lint:      pass
Backend tests:     79/0/0
Frontend typecheck: pass
Frontend lint:      pass
Frontend tests:     0/0/0 (not run by scripts/check.sh)
Frontend visual:   skipped
  Report path:     packages/frontend/e2e/.html-report/index.html
  Diff artifacts:  none
Failing output (tail):
  none
Status: GREEN
```


## Admin Fixture Setup

Prepared: `2026-06-04T15:23:19.267Z`
Run ID: `murt-20260604t152317z-382edb`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t152317z-382edb`
State manifest: `/root/nyabase/test/runtime/murt/20260604t152317z-382edb/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9 |
| server | gpu | 343488f6-2689-488a-8bf8-8c02caf25989 |
| image | cpu-a | d66f3dac-e5bf-4ef6-837e-2454ee8951d8 |
| image | cpu-b-same-ref | ccd94ba2-28a5-4352-91f1-cd524f7d0be5 |
| image | inactive | 89415b50-97fb-4c6d-8193-993ddd1b2a76 |
| image | gpu-a | e445b333-6cbc-446e-9504-3b53cc356d40 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t152317z-382edb-alpha | 1844c615-f049-4adf-9bb8-f92c8dfa094f | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:500/268435456/67108864/none[] | cpuA:d66f3dac-e5bf-4ef6-837e-2454ee8951d8@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | d66f3dac-e5bf-4ef6-837e-2454ee8951d8 | none |
| beta | murt-20260604t152317z-382edb-beta | 4a0c5aa1-2173-4e26-bd65-c7967f4cb1a7 | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:1000/536870912/134217728/none[] | cpuB:ccd94ba2-28a5-4352-91f1-cd524f7d0be5@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | ccd94ba2-28a5-4352-91f1-cd524f7d0be5 | none |
| gamma | murt-20260604t152317z-382edb-gamma | 05791e9d-4030-4382-83c6-992eb2470980 | 343488f6-2689-488a-8bf8-8c02caf25989:1000/1073741824/268435456/indices[0] | gpuA:e445b333-6cbc-446e-9504-3b53cc356d40@343488f6-2689-488a-8bf8-8c02caf25989 | e445b333-6cbc-446e-9504-3b53cc356d40 | none |
| delta | murt-20260604t152317z-382edb-delta | 2a8d3d31-8d5a-4f3c-94eb-424db72544b4 | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:1500/1073741824/268435456/none[]; 343488f6-2689-488a-8bf8-8c02caf25989:1000/1073741824/268435456/indices[1] | cpuA:d66f3dac-e5bf-4ef6-837e-2454ee8951d8@1b9c08fa-32e1-4943-8dc5-d83772cd52f9, gpuA:e445b333-6cbc-446e-9504-3b53cc356d40@343488f6-2689-488a-8bf8-8c02caf25989 | d66f3dac-e5bf-4ef6-837e-2454ee8951d8, e445b333-6cbc-446e-9504-3b53cc356d40 | none |
| epsilon | murt-20260604t152317z-382edb-epsilon | 2de2c638-a758-4e1c-9081-922c6f9070ce | none | inactive:89415b50-97fb-4c6d-8193-993ddd1b2a76@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 1b9c08fa-32e1-4943-8dc5-d83772cd52f9`; `setup-gap: no remote FS mount assigned to CPU server 1b9c08fa-32e1-4943-8dc5-d83772cd52f9`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t152317z-382edb` and manifest `/root/nyabase/test/runtime/murt/20260604t152317z-382edb/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T15:23:27.656Z`
Run ID: `murt-adminlane-20260604t152325z`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/adminlane-20260604t152325z`
State manifest: `/root/nyabase/test/runtime/murt/adminlane-20260604t152325z/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9 |
| server | gpu | 343488f6-2689-488a-8bf8-8c02caf25989 |
| image | cpu-a | 1108d8a3-dfb0-48fa-8d6a-4411d3040723 |
| image | cpu-b-same-ref | 088e0e01-188e-43f8-8248-15ca1c707ccc |
| image | inactive | cd581249-b745-49f1-8dc6-3f9e8154f2e2 |
| image | gpu-a | 175e174d-ff66-4976-98cf-e442d71472bf |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-adminlane-20260604t152325z-alpha | a93b9b4c-04d9-4a37-9424-b8f6d0f2ba40 | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:500/268435456/67108864/none[] | cpuA:1108d8a3-dfb0-48fa-8d6a-4411d3040723@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | 1108d8a3-dfb0-48fa-8d6a-4411d3040723 | none |
| beta | murt-adminlane-20260604t152325z-beta | c8c5c54c-d90f-4f8b-b148-2a5b936796b0 | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:1000/536870912/134217728/none[] | cpuB:088e0e01-188e-43f8-8248-15ca1c707ccc@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | 088e0e01-188e-43f8-8248-15ca1c707ccc | none |
| gamma | murt-adminlane-20260604t152325z-gamma | 1a522967-1864-415d-8cbc-34c8f21bb35d | 343488f6-2689-488a-8bf8-8c02caf25989:1000/1073741824/268435456/indices[0] | gpuA:175e174d-ff66-4976-98cf-e442d71472bf@343488f6-2689-488a-8bf8-8c02caf25989 | 175e174d-ff66-4976-98cf-e442d71472bf | none |
| delta | murt-adminlane-20260604t152325z-delta | 1b35bc0d-a3f7-4e4d-99fe-645f28127bc2 | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:1500/1073741824/268435456/none[]; 343488f6-2689-488a-8bf8-8c02caf25989:1000/1073741824/268435456/indices[1] | cpuA:1108d8a3-dfb0-48fa-8d6a-4411d3040723@1b9c08fa-32e1-4943-8dc5-d83772cd52f9, gpuA:175e174d-ff66-4976-98cf-e442d71472bf@343488f6-2689-488a-8bf8-8c02caf25989 | 1108d8a3-dfb0-48fa-8d6a-4411d3040723, 175e174d-ff66-4976-98cf-e442d71472bf | none |
| epsilon | murt-adminlane-20260604t152325z-epsilon | d8a22bcc-0b49-4218-b657-cf13e9a55d53 | none | inactive:cd581249-b745-49f1-8dc6-3f9e8154f2e2@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 1b9c08fa-32e1-4943-8dc5-d83772cd52f9`; `setup-gap: no remote FS mount assigned to CPU server 1b9c08fa-32e1-4943-8dc5-d83772cd52f9`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-adminlane-20260604t152325z` and manifest `/root/nyabase/test/runtime/murt/adminlane-20260604t152325z/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T16:41:21.874Z`
Run ID: `murt-20260604t164119z-84c066`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t164119z-84c066`
State manifest: `/root/nyabase/test/runtime/murt/20260604t164119z-84c066/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9 |
| server | gpu | 343488f6-2689-488a-8bf8-8c02caf25989 |
| image | cpu-a | c5ef94e1-3d79-4c0e-b4a9-cee043587cc6 |
| image | cpu-b-same-ref | 3e8a5b92-c79c-44b3-ac1d-9186f1564fd9 |
| image | inactive | 18fe30e4-64ee-4f7d-8423-5511f85f2e2b |
| image | gpu-a | 29f44fd0-4870-44a7-9ade-b0a375898178 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t164119z-84c066-alpha | 5f0ba828-4fea-4a6a-a1dd-5d34512aff13 | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:500/268435456/67108864/none[] | cpuA:c5ef94e1-3d79-4c0e-b4a9-cee043587cc6@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | c5ef94e1-3d79-4c0e-b4a9-cee043587cc6 | none |
| beta | murt-20260604t164119z-84c066-beta | 6c9a1a97-b8ba-4168-a42a-6a85f0dbbc95 | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:1000/536870912/134217728/none[] | cpuB:3e8a5b92-c79c-44b3-ac1d-9186f1564fd9@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | 3e8a5b92-c79c-44b3-ac1d-9186f1564fd9 | none |
| gamma | murt-20260604t164119z-84c066-gamma | f956c24e-678d-4ff7-b7e3-8fba3a0b98b8 | 343488f6-2689-488a-8bf8-8c02caf25989:1000/1073741824/268435456/indices[0] | gpuA:29f44fd0-4870-44a7-9ade-b0a375898178@343488f6-2689-488a-8bf8-8c02caf25989 | 29f44fd0-4870-44a7-9ade-b0a375898178 | none |
| delta | murt-20260604t164119z-84c066-delta | ea5110ad-2f5a-443f-8cb4-3df32668d19a | 1b9c08fa-32e1-4943-8dc5-d83772cd52f9:1500/1073741824/268435456/none[]; 343488f6-2689-488a-8bf8-8c02caf25989:1000/1073741824/268435456/indices[1] | cpuA:c5ef94e1-3d79-4c0e-b4a9-cee043587cc6@1b9c08fa-32e1-4943-8dc5-d83772cd52f9, gpuA:29f44fd0-4870-44a7-9ade-b0a375898178@343488f6-2689-488a-8bf8-8c02caf25989 | c5ef94e1-3d79-4c0e-b4a9-cee043587cc6, 29f44fd0-4870-44a7-9ade-b0a375898178 | none |
| epsilon | murt-20260604t164119z-84c066-epsilon | 8f3840e3-d8a9-4af9-b46e-85bfaafb0f4b | none | inactive:18fe30e4-64ee-4f7d-8423-5511f85f2e2b@1b9c08fa-32e1-4943-8dc5-d83772cd52f9 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 1b9c08fa-32e1-4943-8dc5-d83772cd52f9`; `setup-gap: no remote FS mount assigned to CPU server 1b9c08fa-32e1-4943-8dc5-d83772cd52f9`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t164119z-84c066` and manifest `/root/nyabase/test/runtime/murt/20260604t164119z-84c066/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T16:46:51.953Z`
Run ID: `murt-20260604t164649z-c7d3e4`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t164649z-c7d3e4`
State manifest: `/root/nyabase/test/runtime/murt/20260604t164649z-c7d3e4/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6 |
| server | gpu | 81213a55-be0f-49d5-af31-f9126f30c293 |
| image | cpu-a | 79647e94-5c96-4a6e-ba80-397cd16e27f5 |
| image | cpu-b-same-ref | ade222be-8e26-4954-bb38-c31b417369b2 |
| image | inactive | 94d7637f-34fd-4c71-9ff6-f470e238cf29 |
| image | gpu-a | e61d6ce2-af60-4504-97ac-9b805fda1ce6 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t164649z-c7d3e4-alpha | 82d29c59-5c44-4624-acd2-cba4b8fb2e76 | 6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6:500/268435456/67108864/none[] | cpuA:79647e94-5c96-4a6e-ba80-397cd16e27f5@6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6 | 79647e94-5c96-4a6e-ba80-397cd16e27f5 | none |
| beta | murt-20260604t164649z-c7d3e4-beta | 5f50910f-12fc-40bc-827e-9096a57f06a4 | 6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6:1000/536870912/134217728/none[] | cpuB:ade222be-8e26-4954-bb38-c31b417369b2@6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6 | ade222be-8e26-4954-bb38-c31b417369b2 | none |
| gamma | murt-20260604t164649z-c7d3e4-gamma | 0399a60f-735a-46b2-853c-74e2f938ad4b | 81213a55-be0f-49d5-af31-f9126f30c293:1000/1073741824/268435456/indices[0] | gpuA:e61d6ce2-af60-4504-97ac-9b805fda1ce6@81213a55-be0f-49d5-af31-f9126f30c293 | e61d6ce2-af60-4504-97ac-9b805fda1ce6 | none |
| delta | murt-20260604t164649z-c7d3e4-delta | bb3d97de-63f0-437b-a71b-1010ce58cef9 | 6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6:1500/1073741824/268435456/none[]; 81213a55-be0f-49d5-af31-f9126f30c293:1000/1073741824/268435456/indices[1] | cpuA:79647e94-5c96-4a6e-ba80-397cd16e27f5@6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6, gpuA:e61d6ce2-af60-4504-97ac-9b805fda1ce6@81213a55-be0f-49d5-af31-f9126f30c293 | 79647e94-5c96-4a6e-ba80-397cd16e27f5, e61d6ce2-af60-4504-97ac-9b805fda1ce6 | none |
| epsilon | murt-20260604t164649z-c7d3e4-epsilon | 7ee3a20a-c3c5-42a0-8324-f5ab42f79000 | none | inactive:94d7637f-34fd-4c71-9ff6-f470e238cf29@6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6`; `setup-gap: no remote FS mount assigned to CPU server 6f967b8d-e74a-4cfa-85ea-1d8df69dcbc6`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t164649z-c7d3e4` and manifest `/root/nyabase/test/runtime/murt/20260604t164649z-c7d3e4/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T16:52:41.505Z`
Run ID: `murt-20260604t165239z-bab05b`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t165239z-bab05b`
State manifest: `/root/nyabase/test/runtime/murt/20260604t165239z-bab05b/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 7ad18d53-5322-4bb0-83ea-92714db117e4 |
| server | gpu | 4f54ab69-89ad-4cc1-a343-b046f34f967e |
| image | cpu-a | 9030014a-ac41-446d-83d2-0bd3ed94d4ea |
| image | cpu-b-same-ref | 6baefccd-0623-4053-8332-07879b82e7fe |
| image | inactive | 4288073c-a459-4781-a857-62c4d3cbc980 |
| image | gpu-a | a45b2b9a-b45e-49aa-8eef-5ad67e34075a |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t165239z-bab05b-alpha | 25c853c7-151a-4912-ade5-f9cf29a4404f | 7ad18d53-5322-4bb0-83ea-92714db117e4:500/268435456/67108864/none[] | cpuA:9030014a-ac41-446d-83d2-0bd3ed94d4ea@7ad18d53-5322-4bb0-83ea-92714db117e4 | 9030014a-ac41-446d-83d2-0bd3ed94d4ea | none |
| beta | murt-20260604t165239z-bab05b-beta | 41687109-b71b-4c13-9520-768116d9b688 | 7ad18d53-5322-4bb0-83ea-92714db117e4:1000/536870912/134217728/none[] | cpuB:6baefccd-0623-4053-8332-07879b82e7fe@7ad18d53-5322-4bb0-83ea-92714db117e4 | 6baefccd-0623-4053-8332-07879b82e7fe | none |
| gamma | murt-20260604t165239z-bab05b-gamma | 8bdaf202-505a-47b0-a967-8ff02136594c | 4f54ab69-89ad-4cc1-a343-b046f34f967e:1000/1073741824/268435456/indices[0] | gpuA:a45b2b9a-b45e-49aa-8eef-5ad67e34075a@4f54ab69-89ad-4cc1-a343-b046f34f967e | a45b2b9a-b45e-49aa-8eef-5ad67e34075a | none |
| delta | murt-20260604t165239z-bab05b-delta | 278ed2c9-e5de-4cb9-a73c-71ed8704e11c | 4f54ab69-89ad-4cc1-a343-b046f34f967e:1000/1073741824/268435456/indices[1]; 7ad18d53-5322-4bb0-83ea-92714db117e4:1500/1073741824/268435456/none[] | cpuA:9030014a-ac41-446d-83d2-0bd3ed94d4ea@7ad18d53-5322-4bb0-83ea-92714db117e4, gpuA:a45b2b9a-b45e-49aa-8eef-5ad67e34075a@4f54ab69-89ad-4cc1-a343-b046f34f967e | a45b2b9a-b45e-49aa-8eef-5ad67e34075a, 9030014a-ac41-446d-83d2-0bd3ed94d4ea | none |
| epsilon | murt-20260604t165239z-bab05b-epsilon | f4549bf0-d7be-462f-86a8-38095ab9ae4b | none | inactive:4288073c-a459-4781-a857-62c4d3cbc980@7ad18d53-5322-4bb0-83ea-92714db117e4 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 7ad18d53-5322-4bb0-83ea-92714db117e4`; `setup-gap: no remote FS mount assigned to CPU server 7ad18d53-5322-4bb0-83ea-92714db117e4`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t165239z-bab05b` and manifest `/root/nyabase/test/runtime/murt/20260604t165239z-bab05b/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T17:18:11.410Z`
Run ID: `murt-20260604t171809z-58cdf9`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t171809z-58cdf9`
State manifest: `/root/nyabase/test/runtime/murt/20260604t171809z-58cdf9/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 4179180c-d57d-4791-a428-a6da743f36db |
| server | gpu | 1eaaed90-af67-4adf-818a-d9124887bc96 |
| image | cpu-a | cd9881e1-20c4-4b72-920e-b6a9aac1b5ea |
| image | cpu-b-same-ref | 48116eac-8a7e-471d-a147-2d0fb75814e0 |
| image | inactive | 346532ee-4b87-403a-8c46-d5031c8ed279 |
| image | gpu-a | e4b11411-2721-46cb-acab-3b27b507c0d5 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t171809z-58cdf9-alpha | a086515f-9abe-4808-a85e-4300620021e5 | 4179180c-d57d-4791-a428-a6da743f36db:500/268435456/67108864/none[] | cpuA:cd9881e1-20c4-4b72-920e-b6a9aac1b5ea@4179180c-d57d-4791-a428-a6da743f36db | cd9881e1-20c4-4b72-920e-b6a9aac1b5ea | none |
| beta | murt-20260604t171809z-58cdf9-beta | 335a0264-278b-481a-a843-43a47f3c8253 | 4179180c-d57d-4791-a428-a6da743f36db:1000/536870912/134217728/none[] | cpuB:48116eac-8a7e-471d-a147-2d0fb75814e0@4179180c-d57d-4791-a428-a6da743f36db | 48116eac-8a7e-471d-a147-2d0fb75814e0 | none |
| gamma | murt-20260604t171809z-58cdf9-gamma | 33e7b5f6-f82b-4129-b64b-4d5347461dd0 | 1eaaed90-af67-4adf-818a-d9124887bc96:1000/1073741824/268435456/indices[0] | gpuA:e4b11411-2721-46cb-acab-3b27b507c0d5@1eaaed90-af67-4adf-818a-d9124887bc96 | e4b11411-2721-46cb-acab-3b27b507c0d5 | none |
| delta | murt-20260604t171809z-58cdf9-delta | e0e610c7-dd29-4003-bc73-ec396092150c | 1eaaed90-af67-4adf-818a-d9124887bc96:1000/1073741824/268435456/indices[1]; 4179180c-d57d-4791-a428-a6da743f36db:1500/1073741824/268435456/none[] | cpuA:cd9881e1-20c4-4b72-920e-b6a9aac1b5ea@4179180c-d57d-4791-a428-a6da743f36db, gpuA:e4b11411-2721-46cb-acab-3b27b507c0d5@1eaaed90-af67-4adf-818a-d9124887bc96 | e4b11411-2721-46cb-acab-3b27b507c0d5, cd9881e1-20c4-4b72-920e-b6a9aac1b5ea | none |
| epsilon | murt-20260604t171809z-58cdf9-epsilon | 1f03df0a-521a-4ba8-bee2-c800433e2d9c | none | inactive:346532ee-4b87-403a-8c46-d5031c8ed279@4179180c-d57d-4791-a428-a6da743f36db | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 4179180c-d57d-4791-a428-a6da743f36db`; `setup-gap: no remote FS mount assigned to CPU server 4179180c-d57d-4791-a428-a6da743f36db`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t171809z-58cdf9` and manifest `/root/nyabase/test/runtime/murt/20260604t171809z-58cdf9/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T17:34:26.366Z`
Run ID: `murt-20260604t173424z-af67e0`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t173424z-af67e0`
State manifest: `/root/nyabase/test/runtime/murt/20260604t173424z-af67e0/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | b322425a-c304-454a-8b2f-71018b95a979 |
| server | gpu | 2a47c184-a901-41b7-91f1-e1277240597c |
| image | cpu-a | 29370d7e-7cfa-4089-b9e3-420116663e7c |
| image | cpu-b-same-ref | 810e5807-f166-4ca9-8ea1-2e534a77304c |
| image | inactive | 6f48c8ad-a474-4c09-adc6-ecd5e735ceea |
| image | gpu-a | 6a569f34-efdd-4919-ad55-79fde5ed2fc4 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t173424z-af67e0-alpha | 322dc2b2-d2b4-49aa-a276-084498b320b1 | b322425a-c304-454a-8b2f-71018b95a979:500/268435456/67108864/none[] | cpuA:29370d7e-7cfa-4089-b9e3-420116663e7c@b322425a-c304-454a-8b2f-71018b95a979 | 29370d7e-7cfa-4089-b9e3-420116663e7c | none |
| beta | murt-20260604t173424z-af67e0-beta | 40e0207a-6065-4d8a-9833-40392821a4c9 | b322425a-c304-454a-8b2f-71018b95a979:1000/536870912/134217728/none[] | cpuB:810e5807-f166-4ca9-8ea1-2e534a77304c@b322425a-c304-454a-8b2f-71018b95a979 | 810e5807-f166-4ca9-8ea1-2e534a77304c | none |
| gamma | murt-20260604t173424z-af67e0-gamma | 7929780d-ff65-48f2-a06b-8ab8146438cf | 2a47c184-a901-41b7-91f1-e1277240597c:1000/1073741824/268435456/indices[0] | gpuA:6a569f34-efdd-4919-ad55-79fde5ed2fc4@2a47c184-a901-41b7-91f1-e1277240597c | 6a569f34-efdd-4919-ad55-79fde5ed2fc4 | none |
| delta | murt-20260604t173424z-af67e0-delta | c0367992-0576-4920-8c3e-3da3a470edf7 | 2a47c184-a901-41b7-91f1-e1277240597c:1000/1073741824/268435456/indices[1]; b322425a-c304-454a-8b2f-71018b95a979:1500/1073741824/268435456/none[] | cpuA:29370d7e-7cfa-4089-b9e3-420116663e7c@b322425a-c304-454a-8b2f-71018b95a979, gpuA:6a569f34-efdd-4919-ad55-79fde5ed2fc4@2a47c184-a901-41b7-91f1-e1277240597c | 6a569f34-efdd-4919-ad55-79fde5ed2fc4, 29370d7e-7cfa-4089-b9e3-420116663e7c | none |
| epsilon | murt-20260604t173424z-af67e0-epsilon | 27b192df-1614-4eaa-b75c-3b18a0a12606 | none | inactive:6f48c8ad-a474-4c09-adc6-ecd5e735ceea@b322425a-c304-454a-8b2f-71018b95a979 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server b322425a-c304-454a-8b2f-71018b95a979`; `setup-gap: no remote FS mount assigned to CPU server b322425a-c304-454a-8b2f-71018b95a979`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t173424z-af67e0` and manifest `/root/nyabase/test/runtime/murt/20260604t173424z-af67e0/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T17:37:28.105Z`
Run ID: `murt-20260604t173726z-d76585`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t173726z-d76585`
State manifest: `/root/nyabase/test/runtime/murt/20260604t173726z-d76585/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | d7c6b76e-359f-47bd-81af-ea9f7e2223f2 |
| server | gpu | a8694107-56c4-4a78-93f4-4ea90eddc580 |
| image | cpu-a | dafce0f8-a6d6-4e17-be01-18d0cc0f75b8 |
| image | cpu-b-same-ref | 175cd67e-764c-4a00-a384-ba545a4561d4 |
| image | inactive | 64f8680b-f3ee-4bf7-be16-9e3550def951 |
| image | gpu-a | 1fd0812b-564d-42aa-98f7-de1a49a1dbeb |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t173726z-d76585-alpha | f98394eb-7d70-4784-8586-d848c2f4f9dd | d7c6b76e-359f-47bd-81af-ea9f7e2223f2:500/268435456/67108864/none[] | cpuA:dafce0f8-a6d6-4e17-be01-18d0cc0f75b8@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | dafce0f8-a6d6-4e17-be01-18d0cc0f75b8 | none |
| beta | murt-20260604t173726z-d76585-beta | b4f77b5c-70e8-41da-8120-0a7097364dd2 | d7c6b76e-359f-47bd-81af-ea9f7e2223f2:1000/536870912/134217728/none[] | cpuB:175cd67e-764c-4a00-a384-ba545a4561d4@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | 175cd67e-764c-4a00-a384-ba545a4561d4 | none |
| gamma | murt-20260604t173726z-d76585-gamma | ff65eb7c-d31d-4673-9340-cbba8e6d2d47 | a8694107-56c4-4a78-93f4-4ea90eddc580:1000/1073741824/268435456/indices[0] | gpuA:1fd0812b-564d-42aa-98f7-de1a49a1dbeb@a8694107-56c4-4a78-93f4-4ea90eddc580 | 1fd0812b-564d-42aa-98f7-de1a49a1dbeb | none |
| delta | murt-20260604t173726z-d76585-delta | 0cb2bdde-bc27-42f7-ac1b-6e993eb183cb | a8694107-56c4-4a78-93f4-4ea90eddc580:1000/1073741824/268435456/indices[1]; d7c6b76e-359f-47bd-81af-ea9f7e2223f2:1500/1073741824/268435456/none[] | cpuA:dafce0f8-a6d6-4e17-be01-18d0cc0f75b8@d7c6b76e-359f-47bd-81af-ea9f7e2223f2, gpuA:1fd0812b-564d-42aa-98f7-de1a49a1dbeb@a8694107-56c4-4a78-93f4-4ea90eddc580 | 1fd0812b-564d-42aa-98f7-de1a49a1dbeb, dafce0f8-a6d6-4e17-be01-18d0cc0f75b8 | none |
| epsilon | murt-20260604t173726z-d76585-epsilon | bd0c0509-f0b3-4764-92ad-249154ad4687 | none | inactive:64f8680b-f3ee-4bf7-be16-9e3550def951@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server d7c6b76e-359f-47bd-81af-ea9f7e2223f2`; `setup-gap: no remote FS mount assigned to CPU server d7c6b76e-359f-47bd-81af-ea9f7e2223f2`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t173726z-d76585` and manifest `/root/nyabase/test/runtime/murt/20260604t173726z-d76585/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T17:49:40.040Z`
Run ID: `murt-20260604t174938z-e260e0`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t174938z-e260e0`
State manifest: `/root/nyabase/test/runtime/murt/20260604t174938z-e260e0/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | d7c6b76e-359f-47bd-81af-ea9f7e2223f2 |
| server | gpu | a8694107-56c4-4a78-93f4-4ea90eddc580 |
| image | cpu-a | 5f22d59e-ef33-4840-a347-f793a20dc121 |
| image | cpu-b-same-ref | 6935316d-4e92-4f7c-8630-646fc5252ef6 |
| image | inactive | 818aa12d-1001-40ec-8ae2-dacd8f498a35 |
| image | gpu-a | 79986ad8-81f2-4101-a24b-02dbf985dd25 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t174938z-e260e0-alpha | cf65c51d-0aec-4682-9a3f-12c7ceeb1bbf | d7c6b76e-359f-47bd-81af-ea9f7e2223f2:500/268435456/67108864/none[] | cpuA:5f22d59e-ef33-4840-a347-f793a20dc121@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | 5f22d59e-ef33-4840-a347-f793a20dc121 | none |
| beta | murt-20260604t174938z-e260e0-beta | 73312ccc-048e-47c4-9d3a-37b92be20fc4 | d7c6b76e-359f-47bd-81af-ea9f7e2223f2:1000/536870912/134217728/none[] | cpuB:6935316d-4e92-4f7c-8630-646fc5252ef6@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | 6935316d-4e92-4f7c-8630-646fc5252ef6 | none |
| gamma | murt-20260604t174938z-e260e0-gamma | 09eb2a62-be4a-4024-b175-d757f999277b | a8694107-56c4-4a78-93f4-4ea90eddc580:1000/1073741824/268435456/indices[0] | gpuA:79986ad8-81f2-4101-a24b-02dbf985dd25@a8694107-56c4-4a78-93f4-4ea90eddc580 | 79986ad8-81f2-4101-a24b-02dbf985dd25 | none |
| delta | murt-20260604t174938z-e260e0-delta | 350ca98f-282f-4aaa-9bf6-4358f42ae724 | a8694107-56c4-4a78-93f4-4ea90eddc580:1000/1073741824/268435456/indices[1]; d7c6b76e-359f-47bd-81af-ea9f7e2223f2:1500/1073741824/268435456/none[] | cpuA:5f22d59e-ef33-4840-a347-f793a20dc121@d7c6b76e-359f-47bd-81af-ea9f7e2223f2, gpuA:79986ad8-81f2-4101-a24b-02dbf985dd25@a8694107-56c4-4a78-93f4-4ea90eddc580 | 79986ad8-81f2-4101-a24b-02dbf985dd25, 5f22d59e-ef33-4840-a347-f793a20dc121 | none |
| epsilon | murt-20260604t174938z-e260e0-epsilon | 251ac45b-09a4-40cd-bc52-d71723ecc738 | none | inactive:818aa12d-1001-40ec-8ae2-dacd8f498a35@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server d7c6b76e-359f-47bd-81af-ea9f7e2223f2`; `setup-gap: no remote FS mount assigned to CPU server d7c6b76e-359f-47bd-81af-ea9f7e2223f2`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t174938z-e260e0` and manifest `/root/nyabase/test/runtime/murt/20260604t174938z-e260e0/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-04T18:38:32.589Z`
Run ID: `murt-20260604t183830z-bcdeeb`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260604t183830z-bcdeeb`
State manifest: `/root/nyabase/test/runtime/murt/20260604t183830z-bcdeeb/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | d7c6b76e-359f-47bd-81af-ea9f7e2223f2 |
| server | gpu | a8694107-56c4-4a78-93f4-4ea90eddc580 |
| image | cpu-a | 886337ad-722f-4279-a904-90521c7dd9d1 |
| image | cpu-b-same-ref | 72d08d08-935f-49e4-906a-842e15669941 |
| image | inactive | 603d1f1c-aaec-4247-a113-b4dc8c34c214 |
| image | gpu-a | 63af86dc-efd1-4d9e-8748-148d7e54d3b6 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260604t183830z-bcdeeb-alpha | 2c65d7e2-e53b-466d-a1b5-406c5febc3ab | d7c6b76e-359f-47bd-81af-ea9f7e2223f2:500/268435456/67108864/none[] | cpuA:886337ad-722f-4279-a904-90521c7dd9d1@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | 886337ad-722f-4279-a904-90521c7dd9d1 | none |
| beta | murt-20260604t183830z-bcdeeb-beta | 57163db3-e1ef-4d1b-bafd-39e30dac124f | d7c6b76e-359f-47bd-81af-ea9f7e2223f2:1000/536870912/134217728/none[] | cpuB:72d08d08-935f-49e4-906a-842e15669941@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | 72d08d08-935f-49e4-906a-842e15669941 | none |
| gamma | murt-20260604t183830z-bcdeeb-gamma | d54b5b5c-3609-42b1-a6bd-4f0b9d6276d0 | a8694107-56c4-4a78-93f4-4ea90eddc580:1000/1073741824/268435456/indices[0] | gpuA:63af86dc-efd1-4d9e-8748-148d7e54d3b6@a8694107-56c4-4a78-93f4-4ea90eddc580 | 63af86dc-efd1-4d9e-8748-148d7e54d3b6 | none |
| delta | murt-20260604t183830z-bcdeeb-delta | a109b025-f4b2-4c15-893f-9dd4fecf9303 | a8694107-56c4-4a78-93f4-4ea90eddc580:1000/1073741824/268435456/indices[1]; d7c6b76e-359f-47bd-81af-ea9f7e2223f2:1500/1073741824/268435456/none[] | cpuA:886337ad-722f-4279-a904-90521c7dd9d1@d7c6b76e-359f-47bd-81af-ea9f7e2223f2, gpuA:63af86dc-efd1-4d9e-8748-148d7e54d3b6@a8694107-56c4-4a78-93f4-4ea90eddc580 | 63af86dc-efd1-4d9e-8748-148d7e54d3b6, 886337ad-722f-4279-a904-90521c7dd9d1 | none |
| epsilon | murt-20260604t183830z-bcdeeb-epsilon | 28f73009-52f9-450b-9e3f-89f696e72145 | none | inactive:603d1f1c-aaec-4247-a113-b4dc8c34c214@d7c6b76e-359f-47bd-81af-ea9f7e2223f2 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server d7c6b76e-359f-47bd-81af-ea9f7e2223f2`; `setup-gap: no remote FS mount assigned to CPU server d7c6b76e-359f-47bd-81af-ea9f7e2223f2`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260604t183830z-bcdeeb` and manifest `/root/nyabase/test/runtime/murt/20260604t183830z-bcdeeb/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-05T01:13:51.937Z`
Run ID: `murt-20260605t011349z-d34e47`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260605t011349z-d34e47`
State manifest: `/root/nyabase/test/runtime/murt/20260605t011349z-d34e47/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | c5134298-fda7-4369-ab51-e0c7065d7058 |
| server | gpu | 88ff8efa-2fbd-4e16-b189-2ab949d26ade |
| image | cpu-a | d0c495ba-a54c-4a07-9f2c-e357aec66a38 |
| image | cpu-b-same-ref | 95d8a2b8-45ee-4d84-8b26-8555cdd11852 |
| image | inactive | 59823f2a-948e-47c3-b425-a5897d7fc041 |
| image | gpu-a | cba08763-9dd4-4479-a916-48e074820f56 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260605t011349z-d34e47-alpha | 42410e6a-7b8f-4628-99d7-73ec19100c99 | c5134298-fda7-4369-ab51-e0c7065d7058:500/268435456/67108864/none[] | cpuA:d0c495ba-a54c-4a07-9f2c-e357aec66a38@c5134298-fda7-4369-ab51-e0c7065d7058 | d0c495ba-a54c-4a07-9f2c-e357aec66a38 | none |
| beta | murt-20260605t011349z-d34e47-beta | 4737014c-31ba-4d08-9016-6d6276ada2ba | c5134298-fda7-4369-ab51-e0c7065d7058:1000/536870912/134217728/none[] | cpuB:95d8a2b8-45ee-4d84-8b26-8555cdd11852@c5134298-fda7-4369-ab51-e0c7065d7058 | 95d8a2b8-45ee-4d84-8b26-8555cdd11852 | none |
| gamma | murt-20260605t011349z-d34e47-gamma | 0e5862ca-ae60-43e6-9c9b-3bdb42e78c6b | 88ff8efa-2fbd-4e16-b189-2ab949d26ade:1000/1073741824/268435456/indices[0] | gpuA:cba08763-9dd4-4479-a916-48e074820f56@88ff8efa-2fbd-4e16-b189-2ab949d26ade | cba08763-9dd4-4479-a916-48e074820f56 | none |
| delta | murt-20260605t011349z-d34e47-delta | 786da846-4249-4ac6-a85b-eb9cf9d8c9fa | 88ff8efa-2fbd-4e16-b189-2ab949d26ade:1000/1073741824/268435456/indices[1]; c5134298-fda7-4369-ab51-e0c7065d7058:1500/1073741824/268435456/none[] | cpuA:d0c495ba-a54c-4a07-9f2c-e357aec66a38@c5134298-fda7-4369-ab51-e0c7065d7058, gpuA:cba08763-9dd4-4479-a916-48e074820f56@88ff8efa-2fbd-4e16-b189-2ab949d26ade | cba08763-9dd4-4479-a916-48e074820f56, d0c495ba-a54c-4a07-9f2c-e357aec66a38 | none |
| epsilon | murt-20260605t011349z-d34e47-epsilon | a60845e8-411a-427d-adf8-37ed2cce0f50 | none | inactive:59823f2a-948e-47c3-b425-a5897d7fc041@c5134298-fda7-4369-ab51-e0c7065d7058 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server c5134298-fda7-4369-ab51-e0c7065d7058`; `setup-gap: no remote FS mount assigned to CPU server c5134298-fda7-4369-ab51-e0c7065d7058`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260605t011349z-d34e47` and manifest `/root/nyabase/test/runtime/murt/20260605t011349z-d34e47/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-05T02:58:16.685Z`
Run ID: `murt-20260605t025814z-9d9597`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260605t025814z-9d9597`
State manifest: `/root/nyabase/test/runtime/murt/20260605t025814z-9d9597/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | c5134298-fda7-4369-ab51-e0c7065d7058 |
| server | gpu | 88ff8efa-2fbd-4e16-b189-2ab949d26ade |
| image | cpu-a | 4bd48394-a012-46fa-a2b3-9d55b5bb28c5 |
| image | cpu-b-same-ref | 6ea8857f-4542-40c0-a13d-3bb12ae3d3c3 |
| image | inactive | 21be710b-97ec-493b-9ed7-4692e8f0d377 |
| image | gpu-a | c0b2d71b-8e23-46e7-8295-fce269713b7c |
| source | cpu-local | 3c923b46-dfe3-4d28-937b-b891d46dfe53 |
| source | cpu-remote | ffe107e6-a07d-41d3-ac90-b9fcc0fe5877 |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260605t025814z-9d9597-alpha | a160b9b9-9179-4235-9e7e-b98702ce7e30 | c5134298-fda7-4369-ab51-e0c7065d7058:500/268435456/67108864/none[] | cpuA:4bd48394-a012-46fa-a2b3-9d55b5bb28c5@c5134298-fda7-4369-ab51-e0c7065d7058 | 4bd48394-a012-46fa-a2b3-9d55b5bb28c5 | local:3c923b46-dfe3-4d28-937b-b891d46dfe53 |
| beta | murt-20260605t025814z-9d9597-beta | 1e91288f-4ba5-4ffd-9466-4b4946995dee | c5134298-fda7-4369-ab51-e0c7065d7058:1000/536870912/134217728/none[] | cpuB:6ea8857f-4542-40c0-a13d-3bb12ae3d3c3@c5134298-fda7-4369-ab51-e0c7065d7058 | 6ea8857f-4542-40c0-a13d-3bb12ae3d3c3 | remote:ffe107e6-a07d-41d3-ac90-b9fcc0fe5877 |
| gamma | murt-20260605t025814z-9d9597-gamma | 83ff47cd-956e-482a-825d-5f21f8408e2e | 88ff8efa-2fbd-4e16-b189-2ab949d26ade:1000/1073741824/268435456/indices[0] | gpuA:c0b2d71b-8e23-46e7-8295-fce269713b7c@88ff8efa-2fbd-4e16-b189-2ab949d26ade | c0b2d71b-8e23-46e7-8295-fce269713b7c | none |
| delta | murt-20260605t025814z-9d9597-delta | f46e9ae0-1ca5-4b71-8f61-764adced59f5 | 88ff8efa-2fbd-4e16-b189-2ab949d26ade:1000/1073741824/268435456/indices[1]; c5134298-fda7-4369-ab51-e0c7065d7058:1500/1073741824/268435456/none[] | cpuA:4bd48394-a012-46fa-a2b3-9d55b5bb28c5@c5134298-fda7-4369-ab51-e0c7065d7058, gpuA:c0b2d71b-8e23-46e7-8295-fce269713b7c@88ff8efa-2fbd-4e16-b189-2ab949d26ade | c0b2d71b-8e23-46e7-8295-fce269713b7c, 4bd48394-a012-46fa-a2b3-9d55b5bb28c5 | local:3c923b46-dfe3-4d28-937b-b891d46dfe53, remote:ffe107e6-a07d-41d3-ac90-b9fcc0fe5877 |
| epsilon | murt-20260605t025814z-9d9597-epsilon | f5b9a82e-4900-420c-a2d6-93b2edb10122 | none | inactive:21be710b-97ec-493b-9ed7-4692e8f0d377@c5134298-fda7-4369-ab51-e0c7065d7058 | none | none |

Setup gaps: none.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260605t025814z-9d9597` and manifest `/root/nyabase/test/runtime/murt/20260605t025814z-9d9597/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-05T03:33:01.358Z`
Run ID: `murt-20260605t033259z-f1426d`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260605t033259z-f1426d`
State manifest: `/root/nyabase/test/runtime/murt/20260605t033259z-f1426d/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | c5134298-fda7-4369-ab51-e0c7065d7058 |
| server | gpu | 88ff8efa-2fbd-4e16-b189-2ab949d26ade |
| image | cpu-a | 6abfc04b-2a2a-4abb-a0db-39a00b93910e |
| image | cpu-b-same-ref | 30a320b1-c848-4334-95f7-f9f06efb5825 |
| image | inactive | 20f83548-fe8c-4ace-bcc4-e7c64ebd8451 |
| image | gpu-a | df3a69a2-ec56-4d74-98f2-222891ebc9d6 |
| source | cpu-local | 3c923b46-dfe3-4d28-937b-b891d46dfe53 |
| source | cpu-remote | 21911850-a2cc-499f-82c5-0b3965cd6131 |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260605t033259z-f1426d-alpha | 719de190-0234-4ed0-affe-15babbcba0bf | c5134298-fda7-4369-ab51-e0c7065d7058:500/268435456/67108864/none[] | cpuA:6abfc04b-2a2a-4abb-a0db-39a00b93910e@c5134298-fda7-4369-ab51-e0c7065d7058 | 6abfc04b-2a2a-4abb-a0db-39a00b93910e | local:3c923b46-dfe3-4d28-937b-b891d46dfe53 |
| beta | murt-20260605t033259z-f1426d-beta | 29f27e74-ddd3-40e5-9d9b-2fbcefe7cde9 | c5134298-fda7-4369-ab51-e0c7065d7058:1000/536870912/134217728/none[] | cpuB:30a320b1-c848-4334-95f7-f9f06efb5825@c5134298-fda7-4369-ab51-e0c7065d7058 | 30a320b1-c848-4334-95f7-f9f06efb5825 | remote:21911850-a2cc-499f-82c5-0b3965cd6131 |
| gamma | murt-20260605t033259z-f1426d-gamma | 582908c1-e0e8-43b6-960b-e49ff1c77954 | 88ff8efa-2fbd-4e16-b189-2ab949d26ade:1000/1073741824/268435456/indices[0] | gpuA:df3a69a2-ec56-4d74-98f2-222891ebc9d6@88ff8efa-2fbd-4e16-b189-2ab949d26ade | df3a69a2-ec56-4d74-98f2-222891ebc9d6 | none |
| delta | murt-20260605t033259z-f1426d-delta | 0b6d026a-9909-408a-8bc3-8cb04ed776c0 | 88ff8efa-2fbd-4e16-b189-2ab949d26ade:1000/1073741824/268435456/indices[1]; c5134298-fda7-4369-ab51-e0c7065d7058:1500/1073741824/268435456/none[] | cpuA:6abfc04b-2a2a-4abb-a0db-39a00b93910e@c5134298-fda7-4369-ab51-e0c7065d7058, gpuA:df3a69a2-ec56-4d74-98f2-222891ebc9d6@88ff8efa-2fbd-4e16-b189-2ab949d26ade | df3a69a2-ec56-4d74-98f2-222891ebc9d6, 6abfc04b-2a2a-4abb-a0db-39a00b93910e | local:3c923b46-dfe3-4d28-937b-b891d46dfe53, remote:21911850-a2cc-499f-82c5-0b3965cd6131 |
| epsilon | murt-20260605t033259z-f1426d-epsilon | 31bb419d-fc51-4d04-9871-b66d58aeefb7 | none | inactive:20f83548-fe8c-4ace-bcc4-e7c64ebd8451@c5134298-fda7-4369-ab51-e0c7065d7058 | none | none |

Setup gaps: none.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260605t033259z-f1426d` and manifest `/root/nyabase/test/runtime/murt/20260605t033259z-f1426d/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-05T05:31:17.199Z`
Run ID: `murt-20260605t053115z-42eb8b`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260605t053115z-42eb8b`
State manifest: `/root/nyabase/test/runtime/murt/20260605t053115z-42eb8b/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34 |
| server | gpu | a6de7f5d-f4b4-47da-8799-1d25ff03cf94 |
| image | cpu-a | 20ae4f4f-a5f7-43cf-8b7a-e838e44a03fe |
| image | cpu-b-same-ref | 863b61dd-419a-4fd9-a7c0-d4a23e7bba85 |
| image | inactive | 2ebfae27-1c29-4c94-b25b-cf8002b27af1 |
| image | gpu-a | 862866bb-cb41-492c-8d6c-6a46e481147c |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260605t053115z-42eb8b-alpha | a19626b1-978b-4f3d-91a2-bd6ce516c9a3 | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34:500/268435456/67108864/none[] | cpuA:20ae4f4f-a5f7-43cf-8b7a-e838e44a03fe@9a6401c2-a79b-4cb8-a91b-2f1a61679c34 | 20ae4f4f-a5f7-43cf-8b7a-e838e44a03fe | none |
| beta | murt-20260605t053115z-42eb8b-beta | e0c9d3d2-b4d5-4996-9e27-58452feb313f | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34:1000/536870912/134217728/none[] | cpuB:863b61dd-419a-4fd9-a7c0-d4a23e7bba85@9a6401c2-a79b-4cb8-a91b-2f1a61679c34 | 863b61dd-419a-4fd9-a7c0-d4a23e7bba85 | none |
| gamma | murt-20260605t053115z-42eb8b-gamma | 7f79570d-548e-40a2-bcbc-cdb4c69a3c70 | a6de7f5d-f4b4-47da-8799-1d25ff03cf94:1000/1073741824/268435456/indices[0] | gpuA:862866bb-cb41-492c-8d6c-6a46e481147c@a6de7f5d-f4b4-47da-8799-1d25ff03cf94 | 862866bb-cb41-492c-8d6c-6a46e481147c | none |
| delta | murt-20260605t053115z-42eb8b-delta | 24db5215-4b47-4946-a7f5-6a9a9c1933f9 | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34:1500/1073741824/268435456/none[]; a6de7f5d-f4b4-47da-8799-1d25ff03cf94:1000/1073741824/268435456/indices[1] | cpuA:20ae4f4f-a5f7-43cf-8b7a-e838e44a03fe@9a6401c2-a79b-4cb8-a91b-2f1a61679c34, gpuA:862866bb-cb41-492c-8d6c-6a46e481147c@a6de7f5d-f4b4-47da-8799-1d25ff03cf94 | 20ae4f4f-a5f7-43cf-8b7a-e838e44a03fe, 862866bb-cb41-492c-8d6c-6a46e481147c | none |
| epsilon | murt-20260605t053115z-42eb8b-epsilon | b55b79fc-be99-4aff-a867-fd122fda18c1 | none | inactive:2ebfae27-1c29-4c94-b25b-cf8002b27af1@9a6401c2-a79b-4cb8-a91b-2f1a61679c34 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 9a6401c2-a79b-4cb8-a91b-2f1a61679c34`; `setup-gap: no remote FS mount assigned to CPU server 9a6401c2-a79b-4cb8-a91b-2f1a61679c34`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260605t053115z-42eb8b` and manifest `/root/nyabase/test/runtime/murt/20260605t053115z-42eb8b/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-05T05:33:01.118Z`
Run ID: `murt-20260605t053259z-9c42ff`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260605t053259z-9c42ff`
State manifest: `/root/nyabase/test/runtime/murt/20260605t053259z-9c42ff/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34 |
| server | gpu | a6de7f5d-f4b4-47da-8799-1d25ff03cf94 |
| image | cpu-a | 4d009e43-ab6c-4ce7-9fd5-1f90c23a8a60 |
| image | cpu-b-same-ref | 764e1a20-7516-4b23-8e83-4617a89c4eaa |
| image | inactive | cc89d955-59aa-49e6-b602-dccb20a10902 |
| image | gpu-a | c1ef34f5-f0eb-4424-be3c-eecf3cfa840e |
| source | cpu-local | 16797f72-d033-4d37-85c3-5f08e0a5e507 |
| source | cpu-remote | fe954570-f481-4019-8f36-8b9ba252fc33 |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260605t053259z-9c42ff-alpha | 46be2d10-cfe4-4ee4-bd3e-844365983534 | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34:500/268435456/67108864/none[] | cpuA:4d009e43-ab6c-4ce7-9fd5-1f90c23a8a60@9a6401c2-a79b-4cb8-a91b-2f1a61679c34 | 4d009e43-ab6c-4ce7-9fd5-1f90c23a8a60 | local:16797f72-d033-4d37-85c3-5f08e0a5e507 |
| beta | murt-20260605t053259z-9c42ff-beta | a299fb24-f46a-42c5-bffe-054c4da6d187 | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34:1000/536870912/134217728/none[] | cpuB:764e1a20-7516-4b23-8e83-4617a89c4eaa@9a6401c2-a79b-4cb8-a91b-2f1a61679c34 | 764e1a20-7516-4b23-8e83-4617a89c4eaa | remote:fe954570-f481-4019-8f36-8b9ba252fc33 |
| gamma | murt-20260605t053259z-9c42ff-gamma | efa16ad3-6b0a-4bc9-86fe-bf7bb2cddde9 | a6de7f5d-f4b4-47da-8799-1d25ff03cf94:1000/1073741824/268435456/indices[0] | gpuA:c1ef34f5-f0eb-4424-be3c-eecf3cfa840e@a6de7f5d-f4b4-47da-8799-1d25ff03cf94 | c1ef34f5-f0eb-4424-be3c-eecf3cfa840e | none |
| delta | murt-20260605t053259z-9c42ff-delta | 96177196-801a-4028-85cb-0a1027e39696 | 9a6401c2-a79b-4cb8-a91b-2f1a61679c34:1500/1073741824/268435456/none[]; a6de7f5d-f4b4-47da-8799-1d25ff03cf94:1000/1073741824/268435456/indices[1] | cpuA:4d009e43-ab6c-4ce7-9fd5-1f90c23a8a60@9a6401c2-a79b-4cb8-a91b-2f1a61679c34, gpuA:c1ef34f5-f0eb-4424-be3c-eecf3cfa840e@a6de7f5d-f4b4-47da-8799-1d25ff03cf94 | 4d009e43-ab6c-4ce7-9fd5-1f90c23a8a60, c1ef34f5-f0eb-4424-be3c-eecf3cfa840e | local:16797f72-d033-4d37-85c3-5f08e0a5e507, remote:fe954570-f481-4019-8f36-8b9ba252fc33 |
| epsilon | murt-20260605t053259z-9c42ff-epsilon | 95910cd2-824b-431c-8943-c38e50bfa653 | none | inactive:cc89d955-59aa-49e6-b602-dccb20a10902@9a6401c2-a79b-4cb8-a91b-2f1a61679c34 | none | none |

Setup gaps: none.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260605t053259z-9c42ff` and manifest `/root/nyabase/test/runtime/murt/20260605t053259z-9c42ff/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-05T14:03:10.791Z`
Run ID: `murt-20260605t140308z-c6b544`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260605t140308z-c6b544`
State manifest: `/root/nyabase/test/runtime/murt/20260605t140308z-c6b544/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | d12e8d10-8dda-4cbe-9f57-54c1fe0044c5 |
| server | gpu | 851cc485-e3af-4401-809b-96450457d8ec |
| image | cpu-a | 0a4fe35a-7532-415a-8994-a66ea83270a1 |
| image | cpu-b-same-ref | 977d682b-2696-49b0-a9b0-7a18d69cfbea |
| image | inactive | 14787672-f18f-496d-b981-6ed86956fe43 |
| image | gpu-a | bab0ee6c-b013-4106-9857-b2cf79f3e823 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260605t140308z-c6b544-alpha | bf446a6c-7ec3-42a9-913d-f7b6bfb7ee51 | d12e8d10-8dda-4cbe-9f57-54c1fe0044c5:500/268435456/67108864/none[] | cpuA:0a4fe35a-7532-415a-8994-a66ea83270a1@d12e8d10-8dda-4cbe-9f57-54c1fe0044c5 | 0a4fe35a-7532-415a-8994-a66ea83270a1 | none |
| beta | murt-20260605t140308z-c6b544-beta | d8ffe22a-ca9b-487d-8a6e-633c72cd154d | d12e8d10-8dda-4cbe-9f57-54c1fe0044c5:1000/536870912/134217728/none[] | cpuB:977d682b-2696-49b0-a9b0-7a18d69cfbea@d12e8d10-8dda-4cbe-9f57-54c1fe0044c5 | 977d682b-2696-49b0-a9b0-7a18d69cfbea | none |
| gamma | murt-20260605t140308z-c6b544-gamma | 8de3b195-1db1-46e6-83cc-69c6cf8d3c71 | 851cc485-e3af-4401-809b-96450457d8ec:1000/1073741824/268435456/indices[0] | gpuA:bab0ee6c-b013-4106-9857-b2cf79f3e823@851cc485-e3af-4401-809b-96450457d8ec | bab0ee6c-b013-4106-9857-b2cf79f3e823 | none |
| delta | murt-20260605t140308z-c6b544-delta | 42e05c3b-5e2c-46eb-bf2c-2aed0da99831 | 851cc485-e3af-4401-809b-96450457d8ec:1000/1073741824/268435456/indices[1]; d12e8d10-8dda-4cbe-9f57-54c1fe0044c5:1500/1073741824/268435456/none[] | cpuA:0a4fe35a-7532-415a-8994-a66ea83270a1@d12e8d10-8dda-4cbe-9f57-54c1fe0044c5, gpuA:bab0ee6c-b013-4106-9857-b2cf79f3e823@851cc485-e3af-4401-809b-96450457d8ec | bab0ee6c-b013-4106-9857-b2cf79f3e823, 0a4fe35a-7532-415a-8994-a66ea83270a1 | none |
| epsilon | murt-20260605t140308z-c6b544-epsilon | c572b683-2ceb-4385-a5b2-fa9fb1b466e8 | none | inactive:14787672-f18f-496d-b981-6ed86956fe43@d12e8d10-8dda-4cbe-9f57-54c1fe0044c5 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server d12e8d10-8dda-4cbe-9f57-54c1fe0044c5`; `setup-gap: no remote FS mount assigned to CPU server d12e8d10-8dda-4cbe-9f57-54c1fe0044c5`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260605t140308z-c6b544` and manifest `/root/nyabase/test/runtime/murt/20260605t140308z-c6b544/state.json`; do not perform broad cleanup of unrelated resources.


## Admin Fixture Setup

Prepared: `2026-06-05T14:42:54.712Z`
Run ID: `murt-20260605t144252z-ee0fe2`
Command: `pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts`
Backend URL: `http://localhost:3001`
Temp directory: `/root/nyabase/test/runtime/murt/20260605t144252z-ee0fe2`
State manifest: `/root/nyabase/test/runtime/murt/20260605t144252z-ee0fe2/state.json`
Classification: `pass`

Admin setup logged in with `ADMIN_INIT_PASSWORD` from `test/config/local.env`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | 5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1 |
| server | gpu | ecdb6db1-1d8e-498c-9fc0-7cfeb6413b72 |
| image | cpu-a | c5a54b3f-2b46-437f-b861-84767aa7bee7 |
| image | cpu-b-same-ref | 885c2d79-d79e-40a8-8aaf-ce8c7a597865 |
| image | inactive | 1fce419e-051e-4a85-9dc7-2f45bac6bfff |
| image | gpu-a | 0164d732-d526-4623-be6a-4f3afe107e28 |
| source | cpu-local | setup-gap |
| source | cpu-remote | setup-gap |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
| alpha | murt-20260605t144252z-ee0fe2-alpha | 64b9481f-dbf3-4d40-8787-fb3614b98796 | 5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1:500/268435456/67108864/none[] | cpuA:c5a54b3f-2b46-437f-b861-84767aa7bee7@5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1 | c5a54b3f-2b46-437f-b861-84767aa7bee7 | none |
| beta | murt-20260605t144252z-ee0fe2-beta | 76409e1e-eb53-4039-913d-e7b950219767 | 5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1:1000/536870912/134217728/none[] | cpuB:885c2d79-d79e-40a8-8aaf-ce8c7a597865@5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1 | 885c2d79-d79e-40a8-8aaf-ce8c7a597865 | none |
| gamma | murt-20260605t144252z-ee0fe2-gamma | eba0c0d5-54ef-4414-a1be-311064cce2c4 | ecdb6db1-1d8e-498c-9fc0-7cfeb6413b72:1000/1073741824/268435456/indices[0] | gpuA:0164d732-d526-4623-be6a-4f3afe107e28@ecdb6db1-1d8e-498c-9fc0-7cfeb6413b72 | 0164d732-d526-4623-be6a-4f3afe107e28 | none |
| delta | murt-20260605t144252z-ee0fe2-delta | 27ba0136-c2e9-4d1e-9f22-19ba574a11bf | 5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1:1500/1073741824/268435456/none[]; ecdb6db1-1d8e-498c-9fc0-7cfeb6413b72:1000/1073741824/268435456/indices[1] | cpuA:c5a54b3f-2b46-437f-b861-84767aa7bee7@5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1, gpuA:0164d732-d526-4623-be6a-4f3afe107e28@ecdb6db1-1d8e-498c-9fc0-7cfeb6413b72 | c5a54b3f-2b46-437f-b861-84767aa7bee7, 0164d732-d526-4623-be6a-4f3afe107e28 | none |
| epsilon | murt-20260605t144252z-ee0fe2-epsilon | 5bf0c102-5c39-4d07-8271-87f5aacf2791 | none | inactive:1fce419e-051e-4a85-9dc7-2f45bac6bfff@5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1 | none | none |

Setup gaps: `setup-gap: no local data disk source returned for CPU server 5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1`; `setup-gap: no remote FS mount assigned to CPU server 5e79a4f0-a0bc-4ec4-9f60-a0f227f701e1`; `setup-gap: local source unavailable for alpha`; `setup-gap: remote source unavailable for beta`; `setup-gap: local source unavailable for delta`; `setup-gap: remote source unavailable for delta`.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix `murt-20260605t144252z-ee0fe2` and manifest `/root/nyabase/test/runtime/murt/20260605t144252z-ee0fe2/state.json`; do not perform broad cleanup of unrelated resources.
