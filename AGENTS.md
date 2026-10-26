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
  （groups、ip-pools、catalog、metrics、ssh-proxy、system-settings、agent-rejections）；
  `http-api-duplicate-routes.contract.test.ts` 断言不存在同名资源同时挂在两处。
- 鉴权在 service 里：`@CurrentActor()`（`iam/actor.ts`）给出 `{ userId, role, authKind, authVersion }`，
  `RolesGuard` 用 `JwtAuthGuard` 已加载的用户行（带 `role`）构造，不再额外查询。
  唯一的凭据是浏览器会话的短期 access JWT（经 refresh cookie 续期）：没有 API token / API key，不要再加回来。
  service 方法签名是 `method(actor, ...)`，
  每个 service 只有一个私有的 `assertCanAccess(actor, row)`；不要再写 `ForUser/ForAdmin/ForSystem`
  包装或 `'user' | 'admin'` 参数。内部调用方（授权到期等）用 `SYSTEM_ACTOR`：没有用户行，`userId` 为 `null`，它写的 audit `actor_id` / intent `requested_by` 等归属一律为 NULL（前端显示「系统」）；
  只有真实用户才能做的事用 `requireUserId(actor)`。
- 角色不会隐式放宽对所属资源的访问：容器、本地卷、共享卷（以及 intents 的详情 / 重试）默认只按所有者规则（自己的 → `owner`，含授权 / 配额检查，不论角色；别人的 → 404），
  `?scope=all`（所有读写路由都认，管理后台发送）才是显式管理员覆盖：需要该路由对应的角色（容器 operator，卷 admin，否则 403），走管理员规则（无用户授权限制，自己的资源也一样）。
- 列表默认 `?scope=mine`；`?scope=all` 需要对应最低角色（`assertListScope(actor, scope, minimum)`，否则 403），管理员专属过滤参数只在 `scope=all` 下可用：查询 schema 用 common 的 `onlyWithScopeAll(...)` refinement，`scope=mine` 带上即 400（卷列表的 `serverId`、`/performance/*` 的 `userId`），service 的 mine 路径也不读它们。
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
  `access/access-lapse.processor.ts` 按台账 `control.access_lapses` 走同一条 14 天宽限 → 处置 → 清除流程（租约 `access_lapse`，
  处置/清除复用 `UserServerResourcePurgeService` 的 `SYSTEM_ACTOR` 路径）。处置因资源而异：服务器 = 停止该用户在其上运行的容器
  （含仍在 provisioning 的），期满删容器 + 本地卷；数据盘池 / 共享后端 = 立即把该用户在其上的卷从容器强制卸载
  （`VolumeAttachmentsService.forceDetach`，运行中热拔，容器不停也不删），期满只删这些卷。`lapsed_at` 恒为检测时间（处理器开台账行的那一刻），
  不从原始授权行推断（否则会把撤销倒推到不相干的旧到期时间并立刻清除）。宽限内只要处置被绕过（服务器上又有 `power_intent='running'` 的容器，
  或池 / 后端上的卷又被挂上，例如管理员用 `scope=all`），每轮都会再次处置；`stopped_at` 保留第一次处置时间。
  清除时复核覆盖、标记 `purged_at` 与全部删除 / 销毁 intent 的入队在同一个持有 `lockIamPolicy` 的 **read committed** 事务里
  （`AccessLapseRepository.purgeIfUncovered`）：serializable / repeatable read 的快照取自加锁语句、早于锁等待，会漏掉等锁期间提交的授权。
  池 / 后端清除前的强制卸载是可逆的，在锁外进行。处置（停机 / 卸载）前先无锁重读覆盖，扫描后新提交的授权直接结束宽限。
  没有待处理 intent 的 `detaching` 挂载也算暴露（被搁置容器上 worker 不会运行的 intent——既无 `retryOf` 也无 `despiteAttention`，
  例如 SSH 密钥同步——不算待处理，SQL 用 `reconcile/intent-model.ts` 的 `runsDespiteAttentionSql` 与 worker 保持一致），`forceDetach` 会重新下发卸载，但仅当容器最后一个 intent 结清已超过退避
  （15 分钟起，按该挂载已有的 detach intent 数翻倍，封顶 4 小时；`volumes/detach-redrive.ts` 的 `detachRedriveDue`，扫描与 `forceDetach` 共用）；
  重新下发不清 `needs_attention`，持续失败的容器对运维可见；`forceDetach` 下发的 intent 都带 `despiteAttention: true`
  （`reconcile/intent-model.ts` 的 `runsDespiteAttention`，与用户重试 `retryOf` 同理），worker 对被搁置（busy strikes）的容器也照常处理：
  成功清 attention，失败或因更新的 revision 成为 stale 空操作时保留 / 重新搁置，下一次按退避再下发。清除后（`purged_at` 已设）池 / 后端上仍暴露的挂载（清除时退避未到而跳过的卸载）
  由 `lapseWork` 的 `detach` 继续按退避重新下发，直到挂载消失、卷销毁得以进行；清除本身不重复。清除后覆盖恢复：台账行照常删除，
  但 `deleting` 卷上到期的 `detaching` 挂载（`destroyBlocked`，不依赖台账和覆盖）仍由 `detach` 按退避重新下发，且只卸这些卷，不碰用户重新使用的卷。
  服务器的停机是同一模型（`ContainerControlService.enforceStop`）：停机 intent 带 `despiteAttention: true` 与 `reason: 'access_lapse'`；
  `power_intent='stopped'` 但实例最后观测仍在运行（`container_ssh_routes.instance_status='running'`，例如停机 intent 撞上 busy strikes 把容器搁置、全量扫描又跳过它）
  也算暴露，按同样的退避重新下停机（`containers/container-control.repository.ts` 的 `lapseStopRedriveDue`，按本次 lapse（该服务器台账行 `lapsed_at` 之后）的停机 intent 数翻倍，
  早先 lapse 的停机不计；卸载按该挂载的 detach intent 计，挂载只会进入一次 `detaching`，所以天然只算当前这次卸载；
  与 `detachRedriveDue` 共用 `volumes/detach-redrive.ts` 的 `containerRedriveDue`，扫描与 `enforceStop` 共用）；第一次停机清 attention，重新下发保留。
- 禁用用户 = 失去覆盖，与撤销同一条流程：覆盖只认 `iam.effective_*_access`（active 用户 + 当前授权），禁用后其名下资源按检测时间开宽限、立即停机，
  14 天后清除；宽限内重新启用则删台账行（容器不自动启动）。用户状态变更在 `afterCommit` 里通知 `AccessChangeNotifier`。
- 宽限中（无当前覆盖）的用户不能新建、启动、挂载、扩容；已停机的容器在覆盖恢复后不会自动启动。所有者扩容本地卷要同时有服务器和存储池的当前授权（在缩容预留内重新扩容、不占新额度也一样）。
- 重试耗尽的 40001 / 40P01 返回 409 `TRANSACTION_CONFLICT`（`PgTransactionConflictFilter`），不是 500。
  管理员 `scope=all` 的容器动作与管理员清除跑 read committed（不做配额准入），这样事务内 `assertActorRole` 能看到等锁期间提交的降级。
- intent 重试归属重试者（`requested_by`，system 为 NULL）并记审计 `intent.retry`；重试 `volume.resize` 只能把 `size_bytes` 调小，不会绕过配额重新扩容。
- 会话：refresh token 每次轮换顺延 `auth.refreshTokenExpiresDays`（空闲超时），但不超过登录时间 + `auth.sessionMaxLifetimeDays`（绝对上限）；两者都是 admin-only 在线设置。
  已轮换掉的旧 token 再出现即判为重放，删除整个会话并记审计 `user.refresh_token_reuse`（同一 `requestId` 的丢响应重试、以及 15 s 内紧邻上一枚 token 的并发刷新除外，后者返回 `REFRESH_SUPERSEDED`，前端换新 requestId 重试一次、不登出）；
  退役哈希在 `iam.refresh_token_ancestors`，每会话只留最新 256 条；不得遗忘 min(`auth.jwtExpiresIn`, 60 分钟) + 2 分钟内退役的哈希，即每个这样的窗口最多轮换 256 次
  （超出 429 `AUTH_RATE_LIMITED` + `Retry-After`，保留 cookie；前端在锁外按 Retry-After 退避、最多 3 次，之后只让该请求失败 / 冷加载显示「会话刷新繁忙」，
  不自动登出、不进入「无法验证会话」，但该页与「无法验证会话」一样提供「退出登录」按钮），所以访问令牌有效期 ≤ 60 分钟时，一个有效期（+2 分钟）内退役的 token 必然能被识别为重放；
  更长的有效期窗口仍封顶 62 分钟（否则 24h 有效期下日常使用就会被限流数小时），超出部分的重放识别只是尽力而为；更老的只是无效。登出接受当前或任一保留的退役 token。
- access JWT 带 `sid`（签发它的 refresh 会话 id，`iam.refresh_tokens.id`），没有 `sid` 的 token 一律 401。容器控制台（`/ws/console`）绑定到授权它的浏览器会话：
  登出 / refresh 重放删掉该会话后 `SessionRevocationService.endSession` 立即关闭它（4401，禁用 / 改角色 / 改密等 `revoke(userId)` 关闭该用户全部控制台）；
  控制台的授权只到 min(当前 access token 到期, 会话空闲到期, 登录 + 绝对上限)（`AuthService.browserSessionDeadline`，复核会话行），
  到期前后端发 `reauthenticate`，前端用**同一会话**的新 access token 再发 `auth`（`freshAccessToken`，必要时强制轮换；拿不到——网络抖动、429 退避用尽——时由 `freshAccessTokenWithRetry` 按退避重试，直到拿到、socket 关闭或截止时间必然已过），复核通过才顺延；
  没有新 token 到期即关（4408），换了用户 / 会话或会话已不存在立即关（4401）。其他方式结束的会话（超过 16 个被挤掉、过期）最迟在当前 access token 到期时关闭。
  截止时间已是绝对上限（`renewable: false`）或新 token 没能顺延它时不再发 `reauthenticate`，到点直接关；只有鉴权结论（`UnauthorizedException`、会话不符 / 已不存在）才 4401，
  复核时的其他错误（DB 抖动）保留当前截止时间、按退避重试同一 token。socket 从建立起只有一个消息分发器（`console-bridge.gateway.ts` 的 `ConsoleFrameDispatcher`），
  exec 打开前到达的 `auth` 照常复核，输入 / resize 有界暂存（超出先发 `CONSOLE_INPUT_OVERFLOW` 错误帧再 1009 关闭，前端按错误码 / 关闭码显示原因）后按序转发。
  控制台先按会话登记再读会话行，所以与并发登出不会互相错过。

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
   `executeWithPostCommit`）开启，提交后才触发，回滚/重试丢弃。worker 的周期全量扫描是兜底。
   worker 按资源排队（`reconcile/resource-chains.ts`）：同一资源的 intent 严格按序、绝不并发（claim 按 worker 记，
   同 worker 重入会续租，所以这道进程内互斥不能去掉），不同资源并发（全局 12、每服务器 4），一个慢操作不再拖住整个队列。
   全量扫描先列 Incus 再读库；库里不认识的带本安装标签的实例 / 卷进 `control.orphan_sightings`，实例立即停机，7 天后才删。
   删除服务器：仍有容器 / 本机卷，或它是某个仍有卷的共享后端的最后一台执行器（不论在线与否）时，非 `force` 删除返回 `SERVER_NOT_EMPTY`；
   共享卷绝不因失去 placement 而被丢弃，`force` 只结束最后执行器上已在 `deleting` 的卷（`destroy_executor_gone`），活卷保留到有新执行器。系统设置只用 revision CAS
   （冲突返回 409 + 当前值），没有内容 token 和定时轮询。
9. Backend 不直连 Incus，也不主动连任何主机。每台服务器的 `nyabase-agent`（`packages/agent`）主动 wss 连
   `/ws/agent`（凭据 `nyak.<serverId>.<secret>`，库里只存 sha256），Incus 请求走 `incus.http` RPC、
   WebSocket 由 agent 另开 `/ws/agent/stream` 回连；`IncusClient` 的传输是 `IncusTunnel`
   （`incus/agent-registry.service.ts` 按服务器解析当前连接，重连后 client 照常可用）。接入：建服务器时签发
   一次性令牌 `nyae.…`（24h），agent 用 `POST /api/agent/enroll` 换凭据；`servers/agent-enrollment.service.ts`。
   控制帧按方向定上限（`MAX_AGENT_BACKEND_FRAME_BYTES` / `MAX_AGENT_CONTROL_FRAME_BYTES`）；`AgentConnection.admits`
   在解析前拒绝没有在等回复时的大帧，未请求过的 response id 与过量 status 帧都按协议违规断开。
   认证前的 agent 升级只经 `incus/agent-credentials.ts` 的 `AgentUpgradeAdmissions` 限制在途查库数（满了回 503 + `Retry-After`）；
   不要按客户端地址计失败或封禁：同一 NAT / 未配 `trustedProxies` 时所有 agent 共用一个地址，一台凭据过期的 agent 或一次 PG 故障
   不能把健康 agent 的控制 / stream 连接挡在外面。被拒的凭据只记进给运维看的 `AgentCredentialRejections`，不限流。
   agent 端 `policy.ts` 是安全边界（只许 `nyc-*`/`nyv-*`、配置白名单、禁 raw/特权/宿主路径/profiles、
   必须 idmap.isolated、网卡 `nyh*` + IPv4/MAC 过滤 + `security.port_isolation`，volatile 改回当前值；更新时与 Incus 当前值相同的配置键原样放行，白名单只管新增 / 改值的键，例如池 `volume.*` 默认值复制进卷的 `zfs.*`）；
   backend 生成的规格必须过得了它：`backend/src/agent-policy.contract.test.ts` 用真实的规格构建与 Incus 操作
   （容器、卷、镜像、预检 probe、控制台）经真实 `IncusClient` 送进 agent 的 `policy.ts`（按路径加载 agent 源码，
   backend 不依赖 agent 包）；新增发往 Incus 的请求时把它的流程加进去。客户网卡统一用 `buildGuestNicDevice`；MAC 由 IPv4 地址派生（`deriveGuestHwaddr`，`02:6e` + 四个地址字节），所以回收重用的地址仍是同一个 MAC（对端的邻居 / ARP 缓存远长于地址回收的 drain）。
   IPv6 拦截表 `bridge nyabase_guard` 是 agent 自己执行的不变量：policy 把会接通客户网卡的请求（start / restart /
   unfreeze、`start: true` 创建、给未停止实例新增或改网卡）标为 `needsIpv6Guard`，agent 转发前现场校验（必要时补回），
   不在位返回可重试的 `ipv6_guard_missing`（`AGENT_IPV6_GUARD_MISSING`）；状态经 hello / status 帧上报，
   只在内存里（`AgentConnection.status` → 服务器 DTO `agent.ipv6Guard`），恢复时唤醒该服务器，backend 不轮询它。
   Incus operation 只能 GET / wait 经 policy 的请求创建的那些（agent 内存里的 `OperationLedger`，按 202 响应记），
   其余回 404；不能列出或取消。事件流 agent 自己开 `/1.0/events?type=lifecycle` 并只转发 nyabase 资源的 action/source，
   backend 只把事件当唤醒信号，不要依赖事件内容。
   不要再加 mTLS、trust token 或 Incus 端点字段。
   `AGENT_PROTOCOL_VERSION` 同时约定控制帧格式和 policy 接受什么：两边构建只在协议号相同时通信，
   不同的 hello 被 close 4426 拒绝并写进服务器 `last_error`。改 `policy.ts` / `policy-body.ts` /
   `common/src/protocol/agent.ts` 时 `protocol-freeze.test.ts` 会失败：若另一版本可能因此拒绝对方的请求就递增协议号，
   并在 OPERATIONS.md 写升级顺序，然后重新固定摘要。agent 安装包只用 `pnpm build:agent-bundle`
   （`scripts/build-agent-bundle.sh`，lab e2e 同用）构建，版本 `<package>+g<commit>` 随 hello 上报。

10. 体量上限（`scripts/check-source-size.mjs`，已接入 `scripts/check.sh`）：手写的 backend / frontend / common / agent
    源文件 ≤ 800 行，单个函数 / 方法 ≤ 150 行（`api-types.ts`、`routeTree.gen.ts`、测试文件除外）。确有理由超出时，
    在文件内或函数上方写一行 `// size-exception: <原因>`。
11. 数据访问每个模块只选一种风格，不在同一文件里混用裸 SQL 与 repository 调用同一批表：
    - API service（volumes、storage-pools、containers 控制面、shared-backends、ip-pools、groups 等）通过本模块的
      `*.repository.ts` 访问自己拥有的表；跨模块的只读查询是专门的 read-model 文件里的 Kysely 查询。
    - reconciler 的全部 SQL 放在同目录的私有 `*.store.ts`（由 reconciler 构造函数内部创建，不是 DI provider），
      reconciler 只把 Kysely 句柄交给 store，自身和拆出的步骤函数文件里不写查询。
    - servers、images、http-proxy、users 直接在 service 里使用 Kysely，不设 repository。
    - 跨模块共用的 advisory lock 常量在 `platform/persistence-pg/advisory-locks.ts`（原 `infrastructure/` 已删除，
      servers / images 各自拥有自己的查询）。
12. 大 service 按职责拆成小 service + 纯函数文件（`*-support.ts`、`*-deps.ts` 里的依赖对象、步骤函数），
    例如 volumes 拆为 `local-volumes` / `shared-volumes` / `volume-attachments` 三个 service，http-proxy 拆为
    bindings / domain-pools / snapshot；`IncusClient` 保持单一 facade，按 API 领域分层（transport → server →
    instance → storage → image）。

前端：页面或组件超过体量时拆成与页面同名的目录（`pages/foo-page.tsx` + `pages/foo-page/*`，hooks 用 `use-*.ts`），
读取源码文本的 surface 测试用 `lib/read-source.test-helper.ts` 的 `readSource` / `readSourceDir`。

SSH 代理按公钥认证、按名路由：direct-tcpip 目标是容器 IP 或 `<容器名>[.<ssh.proxyHostSuffix>]`，只在持钥用户自己的容器里解析
（所以容器名按所有者忽略大小写唯一，`containers_owner_name_key`）。快照只下发有可达路由的用户 / 容器。每个用户一个主机证书 CA
（`ssh-host-ca/`，只依赖 platform；`SshKeyCryptoService` 在 `platform/`），reconciler 在 sshd 就绪后签发确定性的主机证书并写 sshd drop-in，
尽力而为、不让 intent 失败；guest 的 `authorized_keys` 只改标记块内的内容。

SSH 连接历史（`tools/ssh-proxy/src/history.rs`、`backend/src/ssh/ssh-history*`、`ssh-sessions*`）：代理是纯跳板，只能看到外层连接与 `direct-tcpip` 通道，
看不到内层会话里的命令和 -A / -L / -R（不要为此做中间人）。认证通过的每条连接、它打开或被拒的每个通道，在打开和关闭时各上报一次**完整记录**，
按（代理实例 `proxyId:instanceId`，序号）幂等 upsert：计数只增、关闭一经记录就保留、真实关闭覆盖 `lost`，所以记录乱序、重复都无妨。
记录在代理的有界发件箱里等 `historyAck`，后端提交后才确认（累计确认，所以存储失败后丢弃后续帧直到代理重发）；字节数由 status 帧每 30 s 落库。
未认证连接只按（窗口、地址、原因）计数。代理消失 10 分钟后其未关闭连接记为 `lost`；超过 `ssh.proxyHistoryRetentionDays` 的明细折叠进
`ssh_proxy_daily_usage` 后删除，统计同时读明细与汇总。`GET /ssh-sessions` 遵循 scope 规则（mine = 自己发起的连接，all = operator）。

代理快照（`tools/`、`http-proxy/`、`ssh/`、`proxy-snapshots/`）：租约（`validUntil`）是撤销的上限，构建失败时什么都不发，
代理在租约到期后 fail closed；**不得**用新租约重发旧路由（会让撤销活过租约），失败只在 error 日志里写明何时 fail closed。
HTTP 代理按路由撤销：每个 hostname 有一个 incarnation，只在连续快照里权限元组不变时延续，交换只在自己的路由被删 / 改权限或租约到期时中断，
绝不因其他站点的变化而全局重置。域名池必须互不嵌套（`http-domain-overlap.ts`），绑定主机名不得是任何池域名或其父域。
控制链路两端都有存活检测（代理 `proxy_common::control_link`，Backend `ProxyControlHeartbeat`）；待握手 / 未认证槽位按来源公平分配并在满时驱逐最重来源（`conn_limit.rs`）。

GPU 是平台内置功能（`gpu/` 模块、`common/src/gpu/`、agent 的 `gpu-collector`），不存在扩展框架。

## Schema 规则（上线冻结）

迁移在 `packages/backend/src/platform/persistence-pg/migrations/`，启动时按 sha256 精确校验已应用的迁移：
已发布的迁移文件改一个字节，线上库就拒绝启动。已发布迁移的校验和固定在
`platform/persistence-pg/migration-freeze.test.ts` 的 `RELEASED_MIGRATION_CHECKSUMS`，**不要改已发布的迁移，也不要改这个常量去迁就**；
schema 变更一律新增 `NNNNNN_name.sql`（只追加），随版本发布时把它的 sha256 加进常量。
`000001_initial.sql` 随上线版本冻结；上线前用旧版 000001 建的库（试运行 / staging）必须重建。

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
  注册 lab 服务器，用 `pnpm build:agent-bundle` 的同一份安装包在每台 lab 主机上起本次运行专属的 agent
  （transient systemd unit，远端经 `ssh -R` 反向隧道回连 loopback Backend，用一次性 enrollment token 接入），写 `state.json`；
  `down` 只删除本次运行创建的东西：带本次 server id 标签的实例、本次库里记录的卷、本次的 agent unit 与目录，然后删库、删运行目录。
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
- 缩容（卷与系统盘）：请求时就写入更小的 `size_bytes` / `root_size_bytes`，但空间要等 reconciler 真正缩完才释放。验证前，
  卷的 `shrink_reserved_bytes`、容器的 `root_shrink_reserved_bytes`保留此前可能仍在 Incus 上的最大尺寸，
  所有配额 / 容量求和都按 `greatest(size, reserved)` 计（`platform/persistence-pg/committed-bytes.ts`，准入差额由
  `volumes/volume-rules.ts` 的 `shrinkReservation` 算，在预留内重新扩容不占额度）。用量阻止的缩容回退
  （`revertImpossibleShrink` / `revertImpossibleRootShrink`）只作用于本轮 reconcile 的 revision，回退尺寸在预留之内，绝不让用户超出授权；
  卷的这次失败若已被更新的 revision 取代，按 stale 结清、不搁置卷；Incus 上的尺寸若超出行的承诺量（预留已释放后才以旧尺寸建出的目录），
  回退不改尺寸、只搁置。卷的预留只按一条规则释放（`committed-bytes.ts` 的 `releaseSettledShrinkReservations`）：没有任何 placement
  未跟上当前 revision。跟上 = `observed_revision` 等于当前 revision（验证了该 revision，或在该 revision 下发现目录不存在：不存在的目录不占尺寸，
  `recordCatalogMissing` 按本轮读到的 `catalog_state` 做 CAS 改回 `ensuring`；CAS 失败说明容器侧刚把它标成 `present`，不算跟上，volume pass 立即重试），
  且共享卷目录未知存在（非 `present`）的 placement 所在服务器上没有该卷的任何挂载行（不论 bind_state：该服务器上容器的 pass 可能正以缩容前读到的尺寸建目录，
  读到挂载的 pass 结束前挂载行不会消失）。容器侧建出目录时 `markCatalogPresent` 清空 `observed_revision`，尺寸已变或仍有预留时立即补一个 resize
  （`requeueResizeAfterCatalogPost`，独立幂等键）；没有 placement 的卷（从未挂载的共享卷）在准入时就不留预留。每个可能让规则成立的转换都调用它：
  缩容准入、`recordVerified`、`markSucceeded`、发现目录缺失、删除服务器丢弃 placement，全量扫描对每个仍持有预留的卷再判一次（兜底挂载消失等转换）；
  全量扫描给仍持有预留而未跟上的 placement 补 resize / ensure（含 dangling 的共享 placement）。
  系统盘在 Incus 已应用配额（无 `volatile.root.apply_quota` 挂起）的观测后释放。
- 进程数 / 网卡带宽 / 磁盘读写是可在线编辑的系统设置 `containers.*`，统一作用于所有容器（CephFS 卷不限 IO）。
- 漂移：平台拥有整份实例文档，只放过 `volatile.*`、`image.*`；未知配置键、多出的设备、设备内多出的键、
  非空 profiles 都算漂移，写回时整份覆盖并记审计 `container.drift_corrected`。
- `power_intent='stopped'` 时 reconciler 先停机再准备挂载，停机绝不等卷就绪；卸载（含强制卸载）同样先于其他挂载的就绪检查：
  detaching 设备单独热拔并立即结清该行；单独热拔若因内容被拒（`AGENT_POLICY_DENIED` / `INCUS_BAD_REQUEST`，例如宿主侧漂移），
  交给本轮完整托管文档写回（同时纠正漂移），此时会等其他挂载就绪。同一 intent 连续 `VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS` 次检查挂载卷都未就绪
  （进程内计数，不含服务器不可达 / 忙重试）才以 `VOLUME_PLACEMENT_FAILED` 失败，不再无限重试。

