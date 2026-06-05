# 用户端 live-test 报告

## 概要

- 测试角色：用户端测试子代理（report-only，未修改产品代码）。
- 测试时间：2026-06-04 23:22-23:28 CST。
- 固定实例：Frontend `http://localhost:5173`；Backend API `http://localhost:3001/api`；SQLite `test/runtime/db/nyabase-test.db`；VictoriaMetrics `http://127.0.0.1:8428`。
- 会话记录目录：`.codex/skills/harness/docs/live-test-user/20260604-232219/`。

## 运行时预检

- 后端监听：`:3001`，PID `2934288`，命令 `node -r tsconfig-paths/register dist/main.js`。
- 前端监听：`:5173`，PID `2934387`，Vite dev server。
- VictoriaMetrics：`:8428`，`/health` 返回 `200 OK`。
- DB：`test/runtime/db/nyabase-test.db`，sha256 `fc21a4efac9f120242d860e213aea37ee282a56079ab96b688318898c0ab3447`。
- Agent 配置：`test/config/agents.json`，CPU server `root@10.8.96.91`，GPU server `lyn@10.8.1.12`。
- `packages/common/src` 编译产物守卫：无 `.js/.js.map/.d.ts/.d.ts.map` 残留。
- 注意：`GET /api/health` 返回 404；项目未暴露该 health route，不能作为服务不可用判断。

证据：`logs/05-runtime-preflight.log`。

## API 用户端生命周期流程

执行命令：

```bash
node .codex/skills/harness/docs/live-test-user/20260604-232219/artifacts/user-live-test.mjs
```

关键资源：

| 类型 | ID / 值 |
| --- | --- |
| Admin | `admin` / `ffc82de9-1e90-4a3c-9a9c-b4e259bb983f` |
| 普通用户 | `ult-20260604152403-902297-user` / `067b4dd3-3d10-42b0-86f0-0dd289e16811` |
| Server | `nyabase-test-cpu` / `1b9c08fa-32e1-4943-8dc5-d83772cd52f9` |
| Image | `murt-20260604t152317z-382edb-cpu-a` / `d66f3dac-e5bf-4ef6-837e-2454ee8951d8` |
| Container | `ult-20260604152403-902297-ctr` / `8b016495-e7b5-48ef-b18e-939d72da93a8` |
| Docker ID | `bdd47339cc5651abec9f850540c489042ff8076fbbfada1d30aa9156de66776e`（创建后回填） |
| Create op | `4b12af89-f334-4ea2-a1ab-db9780f84ba8` |
| Start op | `a477a9b5-8488-4d1e-af0b-14e201ca5816` |
| Restart op | `9469e7df-25d7-40b6-8032-a366ee0f29fc` |

结果：

- Admin 创建普通用户：`POST /users` -> 201。
- 授权 server：`POST /users/:id/server-grants/:serverId` -> 201。
- 授权 image：`POST /users/:id/image-grants` -> 201（需要 `imageId + serverId`）。
- 普通用户登录：`POST /auth/login` -> 200；`capabilities: []`。
- 普通用户查看自身访问：`GET /me/access` -> 200，包含 server grant 和 image grant。
- 普通用户查看 server/image：`GET /servers` -> 200 count=1；`GET /images` -> 200 count=1。
- 普通用户创建容器：`POST /containers` -> 201 queued；容器在 own list 中可见。
- 容器详情：`GET /containers/:serverId/:containerId` -> 200。
- 停止：第一次在 Docker ID 尚未绑定时 `POST .../stop` -> 409 `Container has not been bound to Docker yet`。
- 启动：`POST .../start` -> 201 queued。
- 重启：`POST .../restart` -> 201 queued。
- 删除：紧接 restart 后 `DELETE ...` -> 409 `Another operation is already in progress for this resource`；等待 120s 后仍可 GET 到该容器，owner 视角 residualCount=1。
- 清理：脚本最后使用 admin 强制删除同一容器 -> 200；删除普通用户 -> 204。DB 残留验证：测试用户 0；该容器保留软删除行 `lifecyclePhase=deleted`。

失败/异常点：

1. 首次脚本（fixture 错误）调用 `POST /users/:id/image-grants` 未带 `serverId`，返回 400；随后重跑已修正。分类：`test-bug:invalid-fixture`。
2. 用户端在容器 create 刚入队/未绑定 Docker 时能立即看到容器，但 stop 操作返回 409。若前端此时允许用户点“停止”，属于 UX/操作状态一致性问题；需由前端禁用或后端返回更清晰 pending 状态。初步分类：`product-bug:lifecycle-state-gating`。
3. restart 后立即 delete 返回 409；轮询 120s 容器仍对用户可见，说明 pending operation/状态收敛慢或测试未等待正确 operation completion endpoint。由于 preflight 中 agent online、后续 admin delete succeeded，暂定：`product-bug or test-gap:lifecycle-convergence`，需要架构/开发进一步查操作队列与状态 API。

证据：`logs/08-user-live-test-rerun.log`、`artifacts/user-live-test-report.json`、`logs/09-post-api-logs.log`、`logs/10-db-inspect.log`、`logs/21-cleanup-leftover-user.log`。

## 前端用户端探针

执行命令（Playwright 依赖只在 frontend 包可解析，因此临时脚本复制到 `packages/frontend` 执行，执行后删除，未留下产品文件）：

```bash
cd packages/frontend
OUT_DIR="../../.codex/skills/harness/docs/live-test-user/20260604-232219/artifacts" node user-frontend-probe.tmp.mjs
```

关键资源：

- 普通用户：`ultui-20260604152738-147a4b-user` / `5850917c-0536-4633-91a4-74767bc727fd`，测试后删除 204。

结果：

- Login 页面可打开并截图：`artifacts/frontend-login.png`。
- 脚本尝试填写用户名/密码并点击登录后，页面仍停留在 `/login`。
- Console/request evidence：`http://localhost:5173/api/auth/login` request failed `net::ERR_ABORTED`，随后若直接访问 `/containers` 仍回到登录页，多条 401。
- 初步判断：测试脚本可能在表单选择器或等待上不够稳，或 Vite proxy/API base 在浏览器路径上需要进一步确认；API 同账号登录已证明后端认证可用。分类：`test-gap:frontend-probe-selector-or-proxy`，不能据此判定产品登录失败。

证据：`artifacts/user-frontend-probe.json`、`artifacts/frontend-login.png`、`artifacts/frontend-containers.png`、`logs/17-frontend-probe-json.log`。

## Cleanup ledger

- Run prefixes：`ult-20260604152346-*`、`ult-20260604152403-*`、`ultui-20260604152738-*`。
- 清理动作：
  - 删除遗留首次失败用户 `d356ab08-4104-4e1e-a0e4-a0733ffca9d3` -> 204。
  - 删除主流程用户 `067b4dd3-3d10-42b0-86f0-0dd289e16811` -> 204。
  - 删除前端探针用户 `5850917c-0536-4633-91a4-74767bc727fd` -> 204。
  - Admin 删除主流程容器 `8b016495-e7b5-48ef-b18e-939d72da93a8` -> 200。
- 精确前缀证明：users 表无 `ult-%`/`ultui-%`；containers 表仅有软删除行 `ult-20260604152403-902297-ctr`，`lifecyclePhase=deleted`，`deletedAt=2026-06-04 15:26:27.917`。

## 需要修复/继续调查的问题清单

| 优先级 | 分类 | 问题 | 建议下一步 |
| --- | --- | --- | --- |
| P1 | `product-bug:lifecycle-state-gating` | 容器创建刚可见但 Docker ID 尚未绑定时，用户停止操作返回 409。 | 前端根据 operation/lifecycle phase 禁用 stop/start/restart/delete；后端 DTO 暴露明确 `pending/create/binding` 状态。 |
| P1 | `product-bug or test-gap:lifecycle-convergence` | restart 后 delete 被 409，120s 后用户视角仍可见。 | 开发检查 operation state machine：restart 是否完成/卡住、是否有 operation summary endpoint 可供 UI/test 等待、delete gating 是否合理。 |
| P2 | `test-gap:frontend-probe-selector-or-proxy` | 前端自动登录探针停留 `/login`，请求显示 `/api/auth/login` abort/401；API 认证正常。 | 用现有 Playwright login helper 或补充稳定 e2e：真实后端登录、跳转、containers 页面截图；确认 Vite proxy 到 `localhost:3001`。 |
| P3 | `test-bug:invalid-fixture` | image grant 必须带 `serverId`，首次脚本漏传导致 400/403。 | 测试夹具统一复用 live specs 中的 grant helper。 |
| P3 | `env/runbook-gap` | `/api/health` 不存在，预检只能用端口和 auth/API 端点。 | 若需要标准 live preflight，增加健康端点或更新 runbook 不使用 `/api/health`。 |
