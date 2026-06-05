# Personas Live Suite Report

## Scope

- Role: persona functional tester subagent.
- Workspace: `/root/nyabase`.
- Shared live instance: reused existing backend/frontend/agents.
- Admin fixture: `test/runtime/murt/current.env`.
- Product files edited: none.
- Suite executed exactly once:
  - `bash test/scripts/run-live-suite.sh personas`

## Result

Overall result: failed.

The suite ran 6 live spec files. 5 passed and 1 failed.

| Spec | Result | Duration | Behavior |
| --- | --- | ---: | --- |
| `multi-user-redteam-alpha.spec.ts` | pass | 35474ms | CPU container lifecycle, stats, stop/start/restart/delete, GPU denial |
| `multi-user-redteam-beta.spec.ts` | pass | 29306ms | CPU container lifecycle with serialized mutations and delete |
| `multi-user-redteam-gamma.spec.ts` | pass | 10234ms | GPU container lifecycle and metrics non-leak status |
| `multi-user-redteam-delta.spec.ts` | pass | 14255ms | CPU plus GPU container create/delete |
| `multi-user-redteam-gamma-delta-attack.spec.ts` | pass | 6443ms | Delta denied access to gamma container by container-id routes |
| `multi-user-redteam-epsilon.spec.ts` | fail | 182ms | `/users` returned 404, expected exactly 403 |

Failure:

```text
AssertionError: expected 404 to be 403
test/specs/live/multi-user-redteam-epsilon.spec.ts:12:74
```

The same epsilon test accepted 403 or 404 for unauthorized container creation, but required exactly 403 for `GET /users`. Runtime returned 404.

## Fixture

- Run prefix: `murt-20260605t053259z-9c42ff`
- CPU server: `nyabase-test-cpu`, `9a6401c2-a79b-4cb8-a91b-2f1a61679c34`, online
- GPU server: `nyabase-test-gpu`, `a6de7f5d-f4b4-47da-8799-1d25ff03cf94`, online
- CPU image A: `4d009e43-ab6c-4ce7-9fd5-1f90c23a8a60`
- CPU image B: `764e1a20-7516-4b23-8e83-4617a89c4eaa`
- GPU image A: `c1ef34f5-f0eb-4424-be3c-eecf3cfa840e`

Users:

| Persona | User ID | Username |
| --- | --- | --- |
| alpha | `46be2d10-cfe4-4ee4-bd3e-844365983534` | `murt-20260605t053259z-9c42ff-alpha` |
| beta | `a299fb24-f46a-42c5-bffe-054c4da6d187` | `murt-20260605t053259z-9c42ff-beta` |
| gamma | `efa16ad3-6b0a-4bc9-86fe-bf7bb2cddde9` | `murt-20260605t053259z-9c42ff-gamma` |
| delta | `96177196-801a-4028-85cb-0a1027e39696` | `murt-20260605t053259z-9c42ff-delta` |
| epsilon | `95910cd2-824b-431c-8943-c38e50bfa653` | `murt-20260605t053259z-9c42ff-epsilon` |

## Containers And Operations

Containers created during this suite:

| Persona | Container ID | Name | Server | Deleted |
| --- | --- | --- | --- | --- |
| delta | `35599a84-1ca7-4169-a23d-1ebb1c889d90` | `murt-20260605t053259z-9c42ff-delta-cpu-v2` | CPU | yes |
| beta | `3b808b41-afe6-440c-a66a-5e1d90414796` | `murt-20260605t053259z-9c42ff-beta-v2` | CPU | yes |
| gamma | `7d48ca05-dcdd-4fab-a4a7-5b48332b0271` | `murt-20260605t053259z-9c42ff-gamma-v2` | GPU | yes |
| alpha | `cdc2bb92-f0c1-4a0b-a909-1874b3caa694` | `murt-20260605t053259z-9c42ff-alpha-v2` | CPU | yes |
| gamma attack target | `5ca12eab-797f-4fa2-aa15-1ee7f1ad30c3` | `murt-20260605t053259z-9c42ff-gamma-target-v2` | GPU | yes |
| delta | `bcb7732f-e124-470c-8788-0ad6b159c758` | `murt-20260605t053259z-9c42ff-delta-gpu-v2` | GPU | yes |

Operation summary for those containers:

- `operations`: 17 succeeded, 0 queued/running/failed.
- `agent_command_outbox`: 17 succeeded, 0 pending/running/failed.
- Operation kinds observed: `container.create`, `container.delete`, `container.stop`, `container.start`, `container.restart`.

## Cleanup Status

- Database cleanup proof: `containers` with prefix `murt-20260605t053259z-9c42ff` and `deleted_at is null` returned `0`.
- Outbox cleanup proof: all 17 matching commands are `succeeded`.
- Remote service status: `nyabase-docker.service` active on CPU and GPU hosts.
- Remote Docker residual check: direct prefix scan produced no matching residual output. CPU host system `docker` unit reported `failed`, while `nyabase-docker.service` was active; GPU host direct docker access required sudo and reported services active.
- `packages/common/src/**` compiled-artifact guard: clean.

## Artifacts

- Suite log: `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/personas.log`
- This report: `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/personas-report.md`
- MURT env: `test/runtime/murt/current.env`
- MURT state: `test/runtime/murt/20260605t053259z-9c42ff/state.json`
- Backend log: `test/runtime/logs/backend.log`
- Frontend log: `test/runtime/logs/frontend.log`

## Commands

```bash
sed -n '1,220p' /root/nyabase/.codex/skills/harness/SKILL.md
sed -n '1,260p' /root/nyabase/.codex/skills/harness/workflow.md
sed -n '1,220p' /root/nyabase/.codex/skills/harness/roles/pm.md
sed -n '1,260p' test/scripts/run-live-suite.sh
bash test/scripts/run-live-suite.sh personas 2>&1 | tee .codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/personas.log
cat test/runtime/murt/current.env
find test/runtime/murt -maxdepth 3 -type f | sort
sqlite3 test/runtime/db/nyabase-test.db '.tables'
sqlite3 test/runtime/db/nyabase-test.db '.schema containers'
sqlite3 test/runtime/db/nyabase-test.db '.schema operations'
sqlite3 test/runtime/db/nyabase-test.db '.schema agent_command_outbox'
sqlite3 -header -column test/runtime/db/nyabase-test.db "select id,name,owner_id,server_id,image_id,deleted_at,created_at from containers where name like 'murt-20260605t053259z-9c42ff%' order by created_at;"
sqlite3 -header -column test/runtime/db/nyabase-test.db "select id,kind,status,resourceType,resourceId,serverId,requestedBy,lastError,createdAt,completedAt from operations where resourceId in (select id from containers where name like 'murt-20260605t053259z-9c42ff%') or requestedBy in ('46be2d10-cfe4-4ee4-bd3e-844365983534','a299fb24-f46a-42c5-bffe-054c4da6d187','efa16ad3-6b0a-4bc9-86fe-bf7bb2cddde9','96177196-801a-4028-85cb-0a1027e39696','95910cd2-824b-431c-8943-c38e50bfa653') order by createdAt;"
sqlite3 -header -column test/runtime/db/nyabase-test.db "select id,operationId,status,serverId,resourceKey,commandKind,attempts,lastError,createdAt,completedAt from agent_command_outbox where operationId in (select id from operations where resourceId in (select id from containers where name like 'murt-20260605t053259z-9c42ff%')) order by createdAt;"
sqlite3 -header -column test/runtime/db/nyabase-test.db "select count(*) as active_count from containers where name like 'murt-20260605t053259z-9c42ff%' and deleted_at is null;"
ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 "systemctl is-active nyabase-docker.service; systemctl is-active docker 2>/dev/null || true; sudo -n docker ps -a --format '{{.ID}} {{.Names}} {{.Status}}' 2>&1 | grep 'murt-20260605t053259z-9c42ff' || true"
ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 "systemctl is-active nyabase-docker.service; sudo -n systemctl is-active docker 2>/dev/null || true; sudo -n docker ps -a --format '{{.ID}} {{.Names}} {{.Status}}' 2>&1 | grep 'murt-20260605t053259z-9c42ff' || true"
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```
