# 状态观测、前端与 GPU 共享语义修复设计

## 目标

1. GPU 是可复用/共享设备，后端只做权限校验与索引选择，不做独占容量租约。
2. 修复 Docker daemon 状态观测：agent 上报后要可持久化、可从 `/servers` 与 `/servers/:id` 读回，重新协调后立即反映。
3. 修复前端 V2 路由/API 漂移和 SSH/GPU 状态展示，使 visual suite 重新可作为回归门禁。

## 非目标

- 不用 GPU 独占锁来解释或规避 live persona 的 GPU 失败；该失败是 macvlan/IPAM 地址冲突。
- 本设计不要求重做容器生命周期状态机。

## 现状证据

- `ContainerRuntimeObservationWriter.persistDockerDaemonStatus()` 是 no-op。
- `ServersController.get()` 明确返回 `dockerDaemon: null`。
- 前端 detail 路由已是 `/containers/$containerId` + `/api/v2/containers/:containerId`，但若干 e2e 仍 mock 旧 `/containers/:serverId/:containerId` 与旧 DTO。
- `ContainerControlService.create()` 用 `allocatedGpuIndices()` 过滤已用 GPU，等价于独占 GPU。

## 设计 A：GPU 共享/复用

### 语义

- `GpuGrantMode` 表示“允许访问哪些 GPU”，不是资源独占租约。
- `gpuIndices` 是容器可见 GPU 列表，可以被多个 active 容器重复使用。
- `gpuCount` 是“从允许集合中选择 N 个 GPU 索引”；只要求允许集合大小 >= N，不要求这些 GPU 当前无人使用。
- 自动选择时按当前使用计数做负载均衡：优先选择容器数最少、索引小的 GPU。

### 后端改动

- 文件：`packages/backend/src/containers/resource-quota.policy.ts`
  - 将注释中的 `free/available` 改成 `permitted/selectable`。
  - `resolveGpuIndices(grant, req, selectableGpuIndices)` 不再把入参解释为“空闲 GPU”。
  - `All + gpuCount`：从 selectable 中取前 N 个；不足才报错。
  - `Indices + gpuCount`：从 grant 允许集合与 selectable 交集取前 N 个；不足才报错。
  - 显式 `gpuIndices`：仍校验重复、仍校验 grant 允许；建议同时校验索引存在于已知集合（inventory 或 server default）。

- 文件：`packages/backend/src/containers/container-control.service.ts`
  - `GpuAllocationEntity` 保留为“GPU assignment 记录”，不要用于排除已用 GPU。
  - 用当前 assignment/lifecycle 计算 `gpuLoadMap: Map<index, activeContainerCount>`。
  - `knownGpuIndices = inventory + server.defaultGpuIndices + historical assigned indices` 去重排序。
  - 自动选择前，将 `knownGpuIndices` 按 `gpuLoadMap` 排序作为 selectable。
  - 创建容器仍保存 `gpu_allocations`，用于展示、负载均衡和删除/失败清理；不要新增每 GPU 唯一约束。

### 必改测试

- `resource-quota.policy.test.ts`
  - 把 “free permitted indices” 改为 “permitted/selectable indices”。
  - 新增：同一个 index 已被使用不影响 `resolveGpuIndices` 成功。
- `container-control-create-v2.test.ts`
  - 保留“两块 GPU 并发创建时倾向 [0]/[1]”的负载均衡测试。
  - 新增“一块 GPU + 两个并发 gpuCount=1 创建均成功，二者均为 [0]”。
  - 新增“显式请求已被其他容器使用的 [0] 仍成功”。

## 设计 B：Docker daemon 状态观测持久化/read model

### 数据模型

新增 latest-only 实体，避免 30 秒一次上报造成无界历史表：

- 文件：`packages/backend/src/entities/docker-daemon-runtime-observation.entity.ts`
- 表：`docker_daemon_runtime_observations`
- 主键：`server_id`
- 字段：
  - `state`, `unit_file_in_sync`, `enabled`, `active`, `pid`
  - `docker_root`, `socket_path`, `server_version`, `storage_driver`, `last_error`
  - `checked_at`（agent 检查时间，Date，由 payload.checkedAt ms 转换）
  - `observed_at`（backend 接收时间）

新增迁移：`packages/backend/src/database/migrations/<timestamp>-AddDockerDaemonRuntimeObservations.ts`。同时加入 `DB_ENTITIES` 与相关 `TypeOrmModule.forFeature`。

### 写入路径

- 文件：`packages/backend/src/gateway/agent-gateway.ts`
  - 在 `dockerDaemonStatus` case 中校验 `payload.serverId === server.id`；不匹配则 warn 并忽略。
  - 校验通过后更新 `stateCache`，再持久化。

- 文件：`packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
  - 实现 `persistDockerDaemonStatus(serverId, status)`：upsert latest row。
  - 写入时以连接态 `serverId` 为准，payload.serverId 仅用于校验；DB 中不信任 agent 自报 serverId。

- 文件：`packages/backend/src/servers/servers.controller.ts`
  - `reconcileDockerDaemon()` 的 RPC 返回值要 parse 为 `zDockerDaemonStatus`，校验 serverId 后立即更新 cache + DB，再返回。不要等下一次 30s 上报。

### 读取路径

- 文件：`packages/backend/src/servers/servers.service.ts`
  - 新增 `toDto(server)` / `findAllDtos()` / `findDtoById()`。
  - DTO 合并优先级：stateCache 最新值 > DB latest observation > null。
  - `gpus` 从 `RuntimeGpuInventoryEntity`，`disks` 从 latest disk observations，`dockerDaemon` 从新增表。

- 文件：`packages/backend/src/servers/servers.controller.ts`
  - `list()` 返回 enriched `ServerDto[]`，不是裸 `ServerEntity[]`。
  - `get()` 删除硬编码 `dockerDaemon: null`，返回 enriched `ServerDto`。

### 离线/陈旧语义

- Agent 离线时保留最后一次 daemon 状态；UI 用 `server.status !== online` 和 `checkedAt` 显示“可能过期”。
- 不要因为离线把 `dockerDaemon` 清空，否则会再次造成观测丢失。

### 必改测试

- Gateway：有效 `dockerDaemonStatus` 会调用 persist；serverId mismatch 不写入。
- Writer/service：persist 后 `/servers/:id` 能读回完整 DockerDaemonStatus。
- Reconcile：RPC 返回后立即持久化并返回同一状态。
- 迁移：新增实体在 sqlite 测试库可 synchronize；生产迁移包含 up/down。

## 设计 C：前端 V2 修复

### 路由/API 统一

- canonical route：`/containers/:containerId`。
- canonical API：
  - list：`GET /api/v2/containers?ownOnly=true` 或 `GET /api/v2/containers`
  - detail：`GET /api/v2/containers/:containerId`
  - stats：`GET /api/v2/containers/:containerId/stats`
  - actions：`POST /api/v2/containers/:containerId/actions/<kebab-action>`
- 删除/更新 e2e 与 `ROUTES.md` 中旧 `/containers/:serverId/:containerId`。

### ContainerView fixture

所有前端测试 mock 必须使用 `ContainerView`：`id/name/serverId/serverName/ownerId/phase/powerIntent/runtime/resources/ssh/mounts/actions/activeOperation`。不要再使用旧 `{ spec, status, sshServer }`。

### Detail UI 补齐

文件：`packages/frontend/src/pages/container-detail-page.tsx`

- SSH 卡片：
  - enabled + running + ip：显示 `ssh root@<ip>`、中文状态“可用”、`Dropbear 正在监听 22 端口`、修复按钮。
  - disabled：显示“未启用”、说明“启用后使用 root 和用户中心公钥连接。”，只显示启用按钮，不显示修复/禁用按钮。
  - 不再出现旧 `lab@`、SSH UID 等文案。
- Console tab：至少显示当前容器 IP；如果 exec 仍未接好，保留 V2 占位说明，但测试不要期待旧 Shell 组件，除非开发顺手恢复授权后的 exec session。
- GPU stats：调用 `/v2/containers/:containerId/stats`，当 `stats.gpuMemUsedMiB` 有正数时显示“GPU 显存”行；过滤 0/NaN/非有限数。
  - 后端当前 stats endpoint 返回 null；开发需同时从 `RuntimeContainerStatEntity` 或最新 observation.stats 读回数据，否则前端只能显示空态。

### Visual 测试修复

- `packages/frontend/e2e/gpu-metrics.spec.ts`
  - URL 改 `/containers/ctr-cuda-notebook`。
  - Mock `/api/v2/containers/ctr-cuda-notebook` 与 `/api/v2/containers/ctr-cuda-notebook/stats`。
  - Server fixture 的 `dockerDaemon` 使用真实 `DockerDaemonStatus`：`state: 'active'` 等字段。
- `packages/frontend/e2e/ssh-ux.spec.ts`
  - URL/API 全部改 V2 containerId。
  - Fixture 改 `ContainerView.ssh/runtime/actions`。
- `packages/frontend/e2e/management-routes.spec.ts`
  - `/api/containers` 改 `/api/v2/containers?ownOnly=true`；fixture 改 `ContainerView`。
  - Dashboard 容器维度失败主要是 mock 字段用 `dockerId`，而 DTO 是 `containerId`；改为 `containerId`。
  - `data-dirs-overview.png` 的 343px diff：先人工打开 actual/diff；若只是正确 UI 的稳定漂移，更新 baseline。
- `packages/frontend/e2e/ROUTES.md`
  - 同步 canonical route 与截图说明。

## 验证清单

1. Focused backend：
   - `pnpm --filter @nyabase/backend test -- resource-quota.policy.test.ts container-control-create-v2.test.ts`
   - Docker daemon observation 相关新增测试。
2. Focused frontend：
   - `pnpm --filter @nyabase/frontend exec playwright test e2e/gpu-metrics.spec.ts e2e/ssh-ux.spec.ts e2e/management-routes.spec.ts --project=chromium`
   - 对新增/更新截图做人工视觉检查后再更新 baseline。
3. Full non-live：
   - `bash scripts/check.sh`
   - `pnpm build:frontend`
   - `bash scripts/check.sh --with-visual`
4. Live smoke：
   - 重启 backend/frontend/agent 后确认 `/api/servers/:gpuServerId` 的 `dockerDaemon` 非 null。
   - 单 GPU 或指定同一 GPU 上创建两个容器，期望都成功且 `resources.gpuIndices` 可相同。

## 开发注意事项

- 不要在 `packages/common/src/**` 留下 `.js/.js.map/.d.ts/.d.ts.map`。
- 完成前运行：
  `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
- 如果仍出现 `Address already in use`，按 IPAM/macvlan 残留资源处理，不要回退为 GPU 独占。
