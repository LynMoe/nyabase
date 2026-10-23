# Agent Notes

## @nyabase/common：不要在 src/ 下遗留编译产物

**问题**：`packages/common/src/` 中残留了旧的 `tsc` 编译产物（`enums.js`、`utils.js`、`protocol/ws.js` 等）。
Vite 通过 alias 将 `@nyabase/common` 指向 `src/index.ts`，但 `index.ts` 中的 `export * from './enums.js'`
会被 Vite 优先解析为同目录下的真实 `.js` 文件，而非 `enums.ts`。
旧的 `.js` 是 CommonJS 格式的历史版本，缺少新增的枚举值（如 `Role`），导致前端运行时报
`SyntaxError: does not provide an export named 'Role'`。

**根因**：`src/` 目录被当作输出目录使用过（`tsc outDir` 指向 `src/`），遗留的 `.js` 污染了源码目录。

**修复**：删除 `packages/common/src/` 下所有 `.js` / `.js.map` / `.d.ts` 编译产物，重启 Vite。

**构建事实（现状）**：
- `common` 只产出一份 CommonJS `dist/`（`tsc -b`，`composite`），`main`/`types` 指向 `dist`；没有 ESM 产物，`exports` 里也没有 `import` 条件。
- backend / agent 通过 TypeScript project references（`references: [{ "path": "../common" }]`）依赖 common，
  `tsc -b` 会自动先构建 `packages/common/dist`；运行时 Node 经 workspace 软链 + `package.json#main` 解析，不使用 tsconfig `paths` 映射，也不需要运行时路径注册钩子。
- 前端与 backend 的 vitest 仍用 Vite alias 直接指向 `packages/common/src`（前端唯一的解析方式）。

**预防**：
- `common` 包的 `tsconfig.json` 的 `outDir` 必须指向 `dist/`，**绝不能**指向 `src/`。
- `packages/common/src` 下不得出现任何编译产物（`.js` / `.js.map` / `.d.ts`），`scripts/check.sh` 对此有断言。
  手动检查：`find packages/common/src -name "*.js" | sort`
- 前端 dev 模式下 Vite alias 直接读取 `.ts` 源文件，`dist/` 对前端无效，无需同步。

## API 表面：每个资源只有一套路由

- 同一资源不再有 `/x` 与 `/admin/x` 两套 controller。`/admin/` 前缀只留给没有用户版本的运维资源
  （groups、ip-pools、catalog、metrics、ssh-proxy、system-settings）；
  `http-api-duplicate-routes.contract.test.ts` 断言不存在同名资源同时挂在两处。
- 鉴权在 service 里：`@CurrentActor()`（`iam/actor.ts`）给出 `{ userId, role, authKind, authVersion }`，
  `RolesGuard` 用 `JwtAuthGuard` 已加载的用户行（JWT 与 API token 两条路径都带 `role`）构造，不再额外查询。
  service 方法签名是 `method(actor, ...)`，
  每个 service 只有一个私有的 `assertCanAccess(actor, row)`；不要再写 `ForUser/ForAdmin/ForSystem`
  包装或 `'user' | 'admin'` 参数。内部调用方（授权到期等）用 `SYSTEM_ACTOR`：没有用户行，`userId` 为 `null`，它写的 audit `actor_id` / intent `requested_by` 等归属一律为 NULL（前端显示「系统」）；
  只有真实用户才能做的事用 `requireUserId(actor)`。
- 角色不会隐式放宽对所属资源的访问：容器、本地卷、共享卷（以及 intents 的详情 / 重试）默认只按所有者规则（自己的 → `owner`，含授权 / 配额检查，不论角色；别人的 → 404），
  `?scope=all`（所有读写路由都认，管理后台发送）才是显式管理员覆盖：需要该路由对应的角色（容器 operator，卷 admin，否则 403），走管理员规则（无用户授权限制，自己的资源也一样）。
- 列表默认 `?scope=mine`；`?scope=all` 需要对应最低角色（`assertListScope(actor, scope, minimum)`，否则 403），管理员专属过滤参数只在 `scope=all` 下可用。
  DTO 形状不同的详情（servers、images、shared-backends）同样用 `?scope=all` 取管理员视图。
- 只有运维 / 管理员能做的操作在方法（或类）上声明 `@RequireRole(Role.Operator | Role.Admin)`，方法级覆盖类级；
  `http-api-roles.contract.test.ts` 固定每条路由的最低角色。`/admin/*` 路由没有声明时 `RolesGuard` 返回 403。
  角色严格嵌套（admin ⊇ operator ⊇ user）；service 里用 `hasRole(actor, min)`（system actor 恒为 true）。
  事务内复核用 `iam/administration.ts` 的 `assertActorRole(transaction, actorId, min)`。
- intents 只有 `GET /intents`、`GET /intents/:id`、`POST /intents/:id/retry` 一个 controller；
  某个资源的操作历史用 `?resourceType=&resourceId=`（多个 id 用逗号分隔，例如镜像的所有分配）。

## 授权模型（`iam/`、`groups/`、`access/`）

- 角色（`user` / `operator` / `admin`）存在 `iam.users.role`，每个请求从库里读，改角色立即生效（不 bump `auth_version`）。
  没有系统组：组只用于批量发放资源授权。不存在系统用户。`users/iam-bootstrap.service.ts` 启动时只在**没有任何 active admin** 时补救：创建保留账号 `admin`，
  或把已存在的 active `admin` 提升为 admin（审计归属 NULL）；已有 active admin 时什么都不做（不会撤销降级），`admin` 被禁用且无其他 admin 则报 `ADMIN_BOOTSTRAP_UNAVAILABLE`。资源授权（服务器、数据盘池、共享后端）可授给用户或组，
  同一用户对同一资源可有多条；`iam.effective_*_access` 只合并**当前有效**（未过期）的授权，且只含 active 用户：
  配额逐项取最大（NULL = 不限，**0 不是"不限"**，DB CHECK 要求 `> 0`）、GPU 并集、到期取最晚。
  所有授权判断只读这些视图（`iam/effective-access.ts` 每类资源一个解析函数）；没有授权缓存、epoch 或 `authz_version`。
- 管理规则只在 `iam/administration.ts`：用户 / 组的管理与改角色（`POST /users`、`PATCH /users/:id` 的 `role`）仅 admin，授权的增删改 operator；
  "最后一个活跃管理员"保护（降级 / 禁用 / 删除 `role='admin' AND status='active'` 的最后一人被拒，`LAST_ACTIVE_ADMINISTRATOR`）。
  所有 IAM 写操作用 `lockIamPolicy`（advisory lock）串行化。
- 撤销 = 立即到期：删除授权 / 移出组 / 删除组都不会被拒绝，IAM 写操作在 `afterCommit` 里通知 `AccessChangeNotifier`，
  `access/access-lapse.processor.ts` 按台账 `control.access_lapses` 走同一条 14 天宽限 → 停机 → 清除流程（租约 `access_lapse`，
  停机/清除复用 `UserServerResourcePurgeService` 的 `SYSTEM_ACTOR` 路径）。`lapsed_at` 恒为检测时间（处理器开台账行的那一刻），
  不从原始授权行推断（否则会把撤销倒推到不相干的旧到期时间并立刻清除）。宽限内只要该 (用户, 资源) 后面还有 `power_intent='running'` 的容器
  （例如管理员用 `scope=all` 又启动了它），每轮都会再次停机；`stopped_at` 保留第一次停机时间。
- 禁用用户 = 失去覆盖，与撤销同一条流程：覆盖只认 `iam.effective_*_access`（active 用户 + 当前授权），禁用后其名下资源按检测时间开宽限、立即停机，
  14 天后清除；宽限内重新启用则删台账行（容器不自动启动）。用户状态变更在 `afterCommit` 里通知 `AccessChangeNotifier`。
- 宽限中（无当前覆盖）的用户不能新建、启动、挂载；已停机的容器在覆盖恢复后不会自动启动。

## 后端结构规则（`packages/backend/src`）

`app-module-graph.test.ts`、`scripts/check.sh` 和相关结构测试固定这些规则，改动前先读它们。

1. 不使用 `forwardRef`。出现环时，把双方共享的小块（只读查询或常量）下沉到更低层。
2. `reconcile/` 不 import 任何领域模块。引擎只认识 `ManagedReconciler` 接口：各领域 reconciler 在 `onModuleInit`
   中 `ReconcilerRegistry.register(this)`，资源状态（`needsAttention` / `markSucceeded` / `markFailure`）由 reconciler 自己写，
   worker 在 `onApplicationBootstrap` 启动。服务器清点、健康标记等通过 servers / storage-pools 提供的服务调用。
3. 领域模块只单向依赖 `platform/`、`iam/`、`reconcile/`、`incus/`，领域之间允许单向依赖，不允许环。
   `JwtAuthGuard` + `RolesGuard` 以 `APP_GUARD` 全局注册，公开路由用 `@Public()`；模块不必为 `@UseGuards` 导入 IAM。
4. 不保留空壳目录：`runtime`、`database`、`storage`、`domain`、`catalog`、`common`、`filters`、`infrastructure`、
   `server-card-extensions`（以及仓库根 `extensions`、前端 `extensions`）已删除，`scripts/check.sh` 断言它们不会回流。
5. 不为单一实现建 DI Symbol 端口，直接注入类，测试用 `overrideProvider(Class)` 或 `new Class(fake)`。
   保留的 token 只有 `PG_DATABASE` / `PG_POOL` / `PG_OPTIONS` 和 `INCUS_CLIENT_FACTORY`（外部边界）。
6. 生产必需依赖不得 `@Optional()`（当前全仓为 0）。
7. controller 不直接使用 Kysely，调用 service / repository。service 可以直接用 Kysely，
   只有被多个 service 共享的查询才抽成 repository。

8. 单进程：不使用 `LISTEN/NOTIFY` 或轮询来同步状态。reconcile 唤醒走进程内 `ReconcileWakeService`；在事务里创建 intent
   时用 `platform/post-commit.ts` 的 `afterCommit(executor, …)` 登记唤醒，事务必须经 `PgTransactionManager.run`（或
   `executeWithPostCommit`）开启，提交后才触发，回滚/重试丢弃。worker 的周期全量扫描是兜底。系统设置只用 revision CAS
   （冲突返回 409 + 当前值），没有内容 token 和定时轮询。
9. Backend 不直连 Incus，也不主动连任何主机。每台服务器的 `nyabase-agent`（`packages/agent`）主动 wss 连
   `/ws/agent`（凭据 `nyak.<serverId>.<secret>`，库里只存 sha256），Incus 请求走 `incus.http` RPC、
   WebSocket 由 agent 另开 `/ws/agent/stream` 回连；`IncusClient` 的传输是 `IncusTunnel`
   （`incus/agent-registry.service.ts` 按服务器解析当前连接，重连后 client 照常可用）。接入：建服务器时签发
   一次性令牌 `nyae.…`（24h），agent 用 `POST /api/agent/enroll` 换凭据；`servers/agent-enrollment.service.ts`。
   agent 端 `policy.ts` 是安全边界（只许 `nyc-*`/`nyv-*`、配置白名单、禁 raw/特权/宿主路径/profiles、
   必须 idmap.isolated、网卡 `nyh*` + 过滤，volatile 改回当前值）；backend 生成的规格必须过得了它。
   不要再加 mTLS、trust token 或 Incus 端点字段。

8. 体量上限（`scripts/check-source-size.mjs`，已接入 `scripts/check.sh`）：手写的 backend / frontend / common / agent
   源文件 ≤ 800 行，单个函数 / 方法 ≤ 150 行（`api-types.ts`、`routeTree.gen.ts`、测试文件除外）。确有理由超出时，
   在文件内或函数上方写一行 `// size-exception: <原因>`。
9. 数据访问每个模块只选一种风格，不在同一文件里混用裸 SQL 与 repository 调用同一批表：
   - API service（volumes、storage-pools、containers 控制面、shared-backends、ip-pools、groups 等）通过本模块的
     `*.repository.ts` 访问自己拥有的表；跨模块的只读查询是专门的 read-model 文件里的 Kysely 查询。
   - reconciler 的全部 SQL 放在同目录的私有 `*.store.ts`（由 reconciler 构造函数内部创建，不是 DI provider），
     reconciler 只把 Kysely 句柄交给 store，自身和拆出的步骤函数文件里不写查询。
   - servers、images、http-proxy、users 直接在 service 里使用 Kysely，不设 repository。
   - 跨模块共用的 advisory lock 常量在 `platform/persistence-pg/advisory-locks.ts`（原 `infrastructure/` 已删除，
     servers / images 各自拥有自己的查询）。
10. 大 service 按职责拆成小 service + 纯函数文件（`*-support.ts`、`*-deps.ts` 里的依赖对象、步骤函数），
    例如 volumes 拆为 `local-volumes` / `shared-volumes` / `volume-attachments` 三个 service，http-proxy 拆为
    bindings / domain-pools / snapshot；`IncusClient` 保持单一 facade，按 API 领域分层（transport → server →
    instance → storage → image）。

前端：页面或组件超过体量时拆成与页面同名的目录（`pages/foo-page.tsx` + `pages/foo-page/*`，hooks 用 `use-*.ts`），
读取源码文本的 surface 测试用 `lib/read-source.test-helper.ts` 的 `readSource` / `readSourceDir`。

SSH 代理按公钥认证、按名路由：direct-tcpip 目标是容器 IP 或 `<容器名>[.<ssh.proxyHostSuffix>]`，只在持钥用户自己的容器里解析
（所以容器名按所有者忽略大小写唯一，`containers_owner_name_key`）。快照只下发有可达路由的用户 / 容器。每个用户一个主机证书 CA
（`ssh-host-ca/`，只依赖 platform；`SshKeyCryptoService` 在 `platform/`），reconciler 在 sshd 就绪后签发确定性的主机证书并写 sshd drop-in，
尽力而为、不让 intent 失败；guest 的 `authorized_keys` 只改标记块内的内容。

GPU 是平台内置功能（`gpu/` 模块、`common/src/gpu/`、agent 的 `gpu-collector`），不存在扩展框架。

## Schema 规则（上线前）

只有一个迁移 `packages/backend/src/platform/persistence-pg/migrations/000001_initial.sql`。
产品尚未上线，改 schema 时**直接编辑它**，不要新增增量迁移，也不要写兼容旧数据的代码；
启动时会精确校验迁移清单。上线之后才改为只追加迁移。

## 本地开发后端

```bash
pnpm --filter @nyabase/backend dev
```

`packages/backend/scripts/dev.mjs` 运行 `tsc -b --watch`（含 `common` 的 project reference），首次编译完成后启动
`node --watch dist/main.js`，并把 SQL 迁移同步到 `dist/`。不要改回 `tsx watch`：esbuild 不产出
`emitDecoratorMetadata`，Nest 的构造函数按类型注入会得到 `undefined dependency`（在 `c24b801` 上已复现）。
配置仍走环境变量 / YAML，至少需要 `DATABASE_URL`、`JWT_SECRET`、`SSH_KEY_ENCRYPTION_SECRET`、
`SSH_PROXY_TOKEN`、`HTTP_PROXY_TOKEN`；端口用 `PORT`，仅本机监听用 `LISTEN_ADDRESS=127.0.0.1`。
`NODE_ENV` 未设置即按 `production` 处理（开发回退密钥/`admin123` 只在显式 `development` / `test` 下生效）；`dev.mjs` 在未设置时给子进程补 `NODE_ENV=development`。

## Live e2e（`tests/e2e/`）

lab 场景 API 测试，不在 CI 里跑；CI 只跑 `pnpm e2e:check`（e2e 包 `tsc --noEmit`、所有 `.sh` 的 `bash -n`、
`node --test --test-name-pattern=__none__` 只加载场景文件不执行）。入口 `pnpm e2e:up | e2e:run [word...] | e2e:down`，
即 `tests/e2e/e2e.sh up|run|down`；输入见 `tests/e2e/lab.env.example`（复制为被忽略的 `tests/e2e/lab.env`），说明见 `tests/e2e/README.md`。

- `up` 在独立运行目录里建新 PG 库、生成 secrets，启动单进程 Backend（`dist`）和两个 Rust 代理，
  经 trust token 注册 lab 服务器，写 `state.json`；`down` 只删除本次运行创建的东西：带本次 server id 标签的实例、
  本次库里记录的卷、以本次 Incus 客户端证书指纹匹配的 trust 条目，然后删库、删运行目录。
- 场景是 `scenarios/*.test.ts`（`node --test` + `tsx`），用 `client/` 里很薄的类型化 API 客户端，请求/响应类型来自
  `@nyabase/common`；每个场景自建自清。过期/清除通过把 `control.access_lapses.lapsed_at` 写成过去时间来驱动，
  **不得**为测试加生产开关。改了路由或 DTO，先让 `pnpm e2e:check` 的类型检查通过。

## 容器资源与漂移

- CPU：授权只有整数 `cpu_cores`（NULL = 不限）。`cpu/cpu-sets.service.ts` 在每服务器 advisory lock 下为
  （服务器, 用户）分配 `control.user_cpu_sets`（尽量不重叠、超线程成对、保持原有核），该用户在此服务器的
  所有容器 `limits.cpu` = 这整组核（`formatCpuSet` 只输出范围，`5-5` 而不是 `5`）；不限核/无授权的管理员
  绑全部未预留核；授权被撤销时保留原组。`infra.servers.reserved_cpus` 永不分配。授权或预留核变化经
  `ReconcileWakeService.wake({ reason: 'scan' })` 触发全量扫描在线改绑；容器不再有 CPU 字段。
- 内存（每个容器 `mem_bytes` > 0）按用户在该服务器上期望运行（`power_intent='running'`，除 deleting 外，failed 也算：intent 重试可能让它回来）的容器之和准入；只在会增加运行内存的操作上、
  `lockOwnerServerQuota` 下检查（`sumRunningMemBytes`）：start、把 `power_intent` 从非 running 改回 running 的 restart（`admitStart`）、running 创建、running 容器的 PATCH limits 增大；stopped 创建/PATCH、减小、期望已是 running 的 restart、
  管理员/system 操作与 reconciler 恢复期望状态都不检查。授权缩小不会停掉运行中的容器，只是不能再启动。start（及上述 restart）时容器持有的 GPU claim 必须 ⊆ 当前授权（`GPU_NOT_GRANTED`），不自动释放。
- 进程数 / 网卡带宽 / 磁盘读写是可在线编辑的系统设置 `containers.*`，统一作用于所有容器（CephFS 卷不限 IO）。
- 漂移：平台拥有整份实例文档，只放过 `volatile.*`、`image.*`；未知配置键、多出的设备、设备内多出的键、
  非空 profiles 都算漂移，写回时整份覆盖并记审计 `container.drift_corrected`。

