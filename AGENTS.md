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
  （grant-bundles、ip-pools、firewall-rules、container-scripts、catalog、metrics、ssh-proxy、system-settings、agent-rejections）；
  `http-api-duplicate-routes.contract.test.ts` 断言不存在同名资源同时挂在两处。
- 鉴权在 service 里：`@CurrentActor()`（`iam/actor.ts`）给出 `{ userId, role, authKind, authVersion }`，
  `RolesGuard` 用 `JwtAuthGuard` 已加载的用户行（带 `role`）构造，不再额外查询。
  唯一的凭据是浏览器会话的短期 access JWT（经 refresh cookie 续期）：没有 API token / API key，不要再加回来。
  service 方法签名是 `method(actor, ...)`，
  每个 service 只有一个私有的 `assertCanAccess(actor, row)`；不要再写 `ForUser/ForAdmin/ForSystem`
  包装或 `'user' | 'admin'` 参数。内部调用方（授权到期等）用 `SYSTEM_ACTOR`：没有用户行，`userId` 为 `null`，它写的 audit `actor_id` / intent `requested_by` 等归属一律为 NULL（前端显示「系统」）；
  只有真实用户才能做的事用 `requireUserId(actor)`。
- 角色不会隐式放宽对所属资源的访问：容器、本地卷、共享卷（以及 intents 的详情 / 重试）默认只按所有者规则（自己的 → `owner`，含授权 / 配额检查，不论角色；别人的 → 404），
  `?scope=all`（所有读写路由都认，管理后台发送）才是显式管理员覆盖：需要该路由对应的角色（容器、卷都是 user_admin，否则 403），走管理员规则（无用户授权限制，自己的资源也一样）。
- 列表默认 `?scope=mine`；`?scope=all` 需要对应最低角色（`assertListScope(actor, scope, minimum)`，否则 403），管理员专属过滤参数只在 `scope=all` 下可用：查询 schema 用 common 的 `onlyWithScopeAll(...)` refinement，`scope=mine` 带上即 400（卷列表的 `serverId`、`/performance/*` 的 `userId`），service 的 mine 路径也不读它们。
  DTO 形状不同的详情（servers、images、shared-backends）同样用 `?scope=all` 取管理员视图。
  servers（列表与详情）、服务器存储池、shared-backends（列表）的 `scope=all` user_admin 也能读（发授权、看容器所在服务器），
  但对非 admin 只返回用户形状的 DTO（不含设置）；images 与 shared-backends 详情的 `scope=all` 仅 admin。
- 只有用户管理员 / 超级管理员能做的操作在方法（或类）上声明 `@RequireRole(Role.UserAdmin | Role.Admin)`，方法级覆盖类级；
  `http-api-roles.contract.test.ts` 固定每条路由的最低角色。`/admin/*` 路由没有声明时 `RolesGuard` 返回 403。
  角色严格嵌套（admin ⊇ user_admin ⊇ user）；service 里用 `hasRole(actor, min)`（system actor 恒为 true）。
  事务内复核用 `iam/administration.ts` 的 `assertActorRole(transaction, actorId, min)`。
- 代操作（impersonation）：admin 的请求带 `X-Nyabase-Act-As: <userId>`（common `ACT_AS_HEADER`）即以该用户身份执行，仍用 admin 自己的 access JWT，不是新凭据。
  `JwtAuthGuard` 经 `iam/guards.ts` 的 `resolveImpersonation` 把 `request.user` 换成目标，actor 是目标用户（角色、所有权、授权、配额都按他）加 `impersonatorId`；
  只有 admin 能代操作，目标只能是 active 的 `user` 角色（否则 403 `IMPERSONATION_DENIED`，头格式不对 400），每个请求都重新校验，`@Public()` 路由忽略此头。
  作用于本人凭据 / 浏览器会话的路由标 `@RefuseImpersonation()`（改资料 / 密码、增删 SSH 公钥、控制台 exec session），`http-api-impersonation.contract.test.ts` 固定这份清单。
  审计归属：`ImpersonationInterceptor` 让处理器跑在 `platform/request-context.ts` 的 AsyncLocalStorage 里，`AuditService` 只给 `actorId` 等于目标的行写 `impersonator_*`（000005）；
  请求结束即失效（`active`），`ReconcileWakeService.wake` 在上下文之外调用监听器，所以被请求唤醒的 worker 与请求留下的定时器都不会继承它。`GET /audit?actorId=` 同时匹配 `impersonator_id`。intent 的 `requested_by` 仍是目标用户，所以 worker 执行这些 intent 时写的行（`incus.mutate`、`container.drift_corrected`）只记目标用户，代操作者看请求本身的那一行（如 `container.create`）。
- `GET /server-grants?scope=all`（user_admin，没有 `scope=mine`）列出所有未删除用户的服务器授权，供用户列表显示授权服务器 badge；增删改仍走 `/users/:userId/server-grants`。
- 用户备注（`iam.users.note`）是管理员对用户的备注：`UserDto.note` 只在 user_admin 及以上请求的 `GET /users`、`GET` / `PATCH` / `POST /users[/:id]` 里出现，
  登录 / 会话里的 `UserDto` 不带；自助路径不能改备注（user_admin 改不了自己的，admin 走管理员路径）。
- 最后登录（`iam.users.last_login_at`，000010）：只记密码登录（refresh 和代操作不算），`UserDto.lastLoginAt` 与备注一样只在 user_admin 及以上的视图里出现；从审计回填，审计有保留期，所以 NULL = 未知（前端显示「—」），不是从未登录。
- 强制改密（`iam.users.must_change_password`，000006）：管理员新建用户、或重置别人的密码时置位（启动补救的 `admin`、管理员改自己的密码不置位），用户自助改密时清除。
  只在会话里的 `UserDto.mustChangePassword`（login / refresh / `GET /auth/me`）出现；前端 `AppLayout` 据此弹出不可关闭的改密对话框（只能改密或退出登录）。后端不据此拦截其他 API。
- intents 只有 `GET /intents`、`GET /intents/:id`、`POST /intents/:id/retry` 一个 controller；
  某个资源的操作历史用 `?resourceType=&resourceId=`（多个 id 用逗号分隔，例如镜像的所有分配）。

## 授权模型（`iam/`、`grants/`、`access/`）

- 角色（`user` / `user_admin` / `admin`）存在 `iam.users.role`（没有 operator，旧库里的 operator 已降成 user），每个请求从库里读，改角色立即生效（不 bump `auth_version`）。
  没有用户组（000003 已删除，连同旧授权一起清空，不做转换）。不存在系统用户。`users/iam-bootstrap.service.ts` 启动时只在**没有任何 active admin** 时补救：创建保留账号 `admin`，
  或把已存在的 active `admin` 提升为 admin（审计归属 NULL）；已有 active admin 时什么都不做（不会撤销降级），`admin` 被禁用且无其他 admin 则报 `ADMIN_BOOTSTRAP_UNAVAILABLE`。
  资源授权只授给用户，每个（用户, 资源）至多一条：
  - **授权模板（bundle，`iam.grant_bundles`）** 绑定一台服务器，定义 CPU 核数、内存、**磁盘总额**（`disk_bytes`，必填，没有"不限"）、**系统盘上限**（`root_disk_bytes`，NULL = 只受总额限制）、GPU 张数，
    以及**数据盘列表**（`iam.grant_bundle_disks`，000014：该服务器的本地池，每块可带自己的上限 `cap_bytes`，NULL = 只受总额限制）；一台服务器可有多个 bundle。
    磁盘总额由该用户在此服务器上的系统盘（所有容器，跨所有系统盘池，按承诺量）与数据盘（列表里各盘上他的卷，按**已有数据**）共用，规则见下文「磁盘总额」。
  - **服务器授权（`iam.server_grants`）** = 用户在一台服务器上的唯一 bundle（复合外键保证 bundle 属于该服务器）+ 可选 override（`overridden` 列出覆盖的字段，值在同名列，NULL = 不限；未覆盖的列恒为 NULL，CHECK 保证；
    `disk` 没有不限，所以 `disk_bytes` 恰在覆盖 `disk` 时非空）+ 到期。数据盘列表整体覆盖（token `data_disks`，API 键 `dataDisks`，`[]` 是真实的"无数据盘"覆盖）：
    覆盖时该授权自己的列表在 `iam.storage_pool_grants`（每（用户, 池）至多一行，复合外键保证池属于该服务器），视图只在覆盖时读它，取消覆盖时同一事务删掉这些行。
    未覆盖的字段**实时跟随** bundle：改 bundle 立即作用于所有未覆盖该字段的授权（视图读 bundle，没有同步写入），批量改数据盘就是改模板：列表加盘，跟随者由平衡器建卷挂载；
    去掉一块盘，跟随者在其上的卷走失效流程。`POST /admin/grant-bundles/:id/preview` 先列出会变的用户、被 override 挡住的用户和用量警告
    （系统盘超上限、系统盘 + 数据超总额、要失效的卷、数据超新上限：`grants/grant-preview.ts`），`PATCH` 带 `expectedRevision`。
    同一服务器已有授权时再分配（任何 bundle，含同一个）返回 409 `SERVER_GRANT_EXISTS`，带 `replace: true` 才在原行上替换：bundle、override 与到期都取自本次请求（未给即无 override、永久），
    数据盘随之跟随新 bundle 的列表（两个 bundle 都有的盘覆盖不中断，只在旧列表里的盘失效）。仍被授权引用的 bundle 不能删（409 `GRANT_BUNDLE_IN_USE`）；仍在某个 bundle / 授权列表里的池不能取消登记。
    数据盘没有自己的到期：随服务器授权生效、到期、删除（级联）。没有数据盘授权这一层（000014 删除了 `iam.data_disk_grants`、`/users/:userId/data-disk-grants`、`movePools`）。
  - **共享后端授权** 独立，不属于任何 bundle，额度必填。共享后端自带 `mount_path`（启用后每个被授权用户的共享卷挂载在此，NULL = 未启用）、`maintenance` 与 `note`（显示在用户的共享卷旁）。
  - GPU 不由管理员挑卡：视图按 `md5(用户 id, PCI 地址)` 从服务器最近观测到的卡（`infra.servers.observed_gpu_pci_addresses`，agent 连接与全量扫描时由 Incus resources 刷新）里取前 N 张（NULL = 全部）。
    结果只取决于用户和卡列表：张数增加保留已有的卡，减少去掉排名最低的；卡消失只影响排到它的用户。`grants/grant-fields.ts` 的 `pickGrantGpus` 是预览用的同一规则（pg 测试固定两者一致）。
  `iam.effective_*_access` 只含**当前有效**（未过期）的授权，且只含 active 用户；bundle 配额 NULL = 不限，**0 不是"不限"**（DB CHECK 要求 `> 0`，GPU 张数 0 = 无卡）；
  磁盘总额与共享后端额度没有 NULL（000012 / 000014 遇到 NULL 拒绝迁移）。`effective_server_access.disk_bytes` 是总额，`root_disk_bytes` 是系统盘上限；
  `effective_pool_access` 每（用户, 池）一行（bundle 的列表或授权自己的），带该盘的上限 `cap_bytes`、`server_id` 与 `server_grant_id`。
  所有授权判断只读这些视图（`iam/effective-access.ts` 每类资源一个解析函数）；没有授权缓存、epoch 或 `authz_version`。
- 用户管理员（user_admin）管人和人的资源：用户、授权模板、所有授权（含给自己）、所有容器（含控制台）与数据卷、清除；
  能看审计、容器 / 卷的 intents、全平台用量、SSH 连接历史；HTTP 绑定的 `scope=all`（列出 / 删除他人的绑定）也是 user_admin，但只经 API（HTTP 代理页仅 admin）。
  user_admin 改自己的记录一律走自助路径（改密码要当前密码），只有 admin 能以管理员身份改自己。服务器、镜像、共享后端、存储池、IP 池、防火墙、代理运维与系统设置（整页）仅 admin。
- 管理规则只在 `iam/administration.ts`：用户 / 授权模板 / 授权的增删改 user_admin；改角色（`PATCH /users/:id` 的 `role`、`POST /users` 带非 user 角色）仅 admin；
  管理（改资料 / 重置密码 / 停用 / 删除 / 删 SSH 公钥）某个 admin 只能是 admin（`assertCanAdministerUser`，`ADMINISTRATOR_PROTECTED`）；
  "最后一个活跃管理员"保护（降级 / 禁用 / 删除 `role='admin' AND status='active'` 的最后一人被拒，`LAST_ACTIVE_ADMINISTRATOR`）。
  所有 IAM 写操作用 `lockIamPolicy`（advisory lock）串行化。
- 撤销 = 立即到期：删除服务器授权（连带其数据盘）/ 从授权的有效数据盘列表里去掉一块盘（改 bundle 或 override）/ 删除共享后端授权都不会被拒绝，IAM 写操作在 `afterCommit` 里通知 `AccessChangeNotifier`，
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
- 存储超分（服务器 `storage_overcommit_ratio` 作用于其本地池，共享后端 `overcommit_ratio`）只在用户之间生效：池 / 后端上所有承诺量合计 ≤ 物理总量 × 比例，
  单个用户在其上的承诺量（本地池 = 他的系统盘 + 本地卷，共享后端 = 他的共享卷）≤ 物理总量，不论授权是否不限、是否管理员 `scope=all` 操作
  （`volumes/volume-rules.ts` 的 `overcommitAvailableBytes`，准入与 `scope=mine` 容量报告共用；前端 `sharedBackendAvailableBytes` 带上用户已用量算同一规则）。
- 宽限中（无当前覆盖）的用户不能新建、启动容器；已停机的容器在覆盖恢复后不会自动启动，但卷会被平台重新挂上（见下节）。
- **磁盘总额**（`platform/persistence-pg/disk-charge.ts` 的 `loadServerDiskCharge` + common 的 `systemDiskRoom`，准入、DTO、预览共用）：服务器授权的总额由系统盘（固定，按承诺量）
  与数据盘（弹性，按 `control.volumes.used_bytes`，未知按 0）共用。建容器 / 扩系统盘在 `lockOwnerServerQuota` 下准入：
  `Δ ≤ min(系统盘上限 − Σ系统盘, 总额 − Σ系统盘 − Σ数据)`，否则 409 `STORAGE_GRANT_EXCEEDED`（`details` 带两者的占用）；数据卷的弹性额度 L = 总额 − Σ系统盘（见下节）。
  系统盘先占、数据盘填剩下的：准入后数据卷由下一轮平衡器（≤ 30 s）缩回；平衡器的扩容在同一把锁下复核系统盘没有在快照之后变多（否则跳过、下一轮重算），
  所以 Incus 上超出总额只可能是"刚准入的系统盘 + 尚未缩回的数据卷配额"这一轮。总额调到系统盘以下时系统盘不动（同"授权缩小不停容器"），数据卷降到下限。共享卷只计入共享后端额度。
- 重试耗尽的 40001 / 40P01 返回 409 `TRANSACTION_CONFLICT`（`PgTransactionConflictFilter`），不是 500。
  管理员 `scope=all` 的容器动作与管理员清除跑 read committed（不做配额准入），这样事务内 `assertActorRole` 能看到等锁期间提交的降级。
- intent 重试归属重试者（`requested_by`，system 为 NULL）并记审计 `intent.retry`；重试 `volume.resize` 只能把 `size_bytes` 调小，不会绕过配额重新扩容。
- 会话：refresh token 每次轮换顺延 `auth.refreshTokenExpiresDays`（空闲超时），但不超过登录时间 + `auth.sessionMaxLifetimeDays`（绝对上限）；两者都是 admin-only 在线设置。
  已轮换掉的旧 token 再出现即判为重放，删除整个会话并记审计 `user.refresh_token_reuse`（同一 `requestId` 的丢响应重试、以及 15 s 内紧邻上一枚 token 的并发刷新除外，后者返回 `REFRESH_SUPERSEDED`，前端换新 requestId 重试一次、不登出）；
  退役哈希在 `iam.refresh_token_ancestors`，每会话只留最新 256 条；不得遗忘 min(`auth.jwtExpiresIn`, 60 分钟) + 2 分钟内退役的哈希，即每个这样的窗口最多轮换 256 次
  （超出 429 `AUTH_RATE_LIMITED` + `Retry-After`，保留 cookie；前端在锁外按 Retry-After 退避、最多 3 次，之后只让该请求失败 / 冷加载显示「会话刷新繁忙」，
  不自动登出、不进入「无法验证会话」，但该页与「无法验证会话」一样提供「退出登录」按钮），所以访问令牌有效期 ≤ 60 分钟时，一个有效期（+2 分钟）内退役的 token 必然能被识别为重放；
  更长的有效期窗口仍封顶 62 分钟（否则 24h 有效期下日常使用就会被限流数小时），超出部分的重放识别只是尽力而为；更老的只是无效。登出接受当前或任一保留的退役 token。
- access JWT 带 `sid`（签发它的 refresh 会话 id，`iam.refresh_tokens.id`），没有 `sid` 的 token 一律 401；每个请求都复核该会话仍 live（`findSessionUser`），所以登出 / 重放 / 被挤掉 / 过期后该会话的 access token 立即失效，不等 `exp`。只认 HS256（`accessJwtOptions`）。容器控制台（`/ws/console`）绑定到授权它的浏览器会话：
  登出 / refresh 重放删掉该会话后 `SessionRevocationService.endSession` 立即关闭它（4401，禁用 / 改角色 / 改密等 `revoke(userId)` 关闭该用户全部控制台）；
  控制台的授权只到 min(当前 access token 到期, 会话空闲到期, 登录 + 绝对上限)（`AuthService.browserSessionDeadline`，复核会话行），
  到期前后端发 `reauthenticate`，前端用**同一会话**的新 access token 再发 `auth`（`freshAccessToken`，必要时强制轮换；拿不到——网络抖动、429 退避用尽——时由 `freshAccessTokenWithRetry` 按退避重试，直到拿到、socket 关闭或截止时间必然已过），复核通过才顺延；
  没有新 token 到期即关（4408），换了用户 / 会话或会话已不存在立即关（4401）。其他方式结束的会话（超过 16 个被挤掉、过期）最迟在当前 access token 到期时关闭。
  截止时间已是绝对上限（`renewable: false`）或新 token 没能顺延它时不再发 `reauthenticate`，到点直接关；只有鉴权结论（`UnauthorizedException`、会话不符 / 已不存在）才 4401，
  复核时的其他错误（DB 抖动）保留当前截止时间、按退避重试同一 token。socket 从建立起只有一个消息分发器（`console-bridge.gateway.ts` 的 `ConsoleFrameDispatcher`），
  exec 打开前到达的 `auth` 照常复核，输入 / resize 有界暂存（超出先发 `CONSOLE_INPUT_OVERFLOW` 错误帧再 1009 关闭，前端按错误码 / 关闭码显示原因）后按序转发。
  控制台先按会话登记再读会话行，所以与并发登出不会互相错过。

## 数据盘与共享盘（单例卷，`volumes/`，000012）

用户不建卷、不删卷、不挂载、不改大小：每个（用户, 盘）至多一个卷（部分唯一索引，不含 `deleting`），由平台创建、挂载并按额度定大小。
- **盘** = 本地数据池（`infra.storage_pools.mount_path`）或共享后端（`infra.shared_backends.mount_path`）。有挂载路径即启用，NULL 未启用（000012 把共享后端的旧建议路径清空，须显式启用）。
  只有已登记、本地、`quota_online` 且 `quota_effective` 的池能启用（否则 409 `STORAGE_MOUNT_UNSUPPORTED`）；同一容器可能看到的盘（同服务器的本地池 + 所有共享后端）路径不得相同或嵌套（409 `STORAGE_MOUNT_PATH_CONFLICT`），
  系统目录由 common `zStorageMountPath` 拒绝（`isSystemMountPath`）。`maintenance` 的盘不出现在任何容器的实例文档里（`ContainerReconcileStore.readAttachments` 跳过），容器照常启动；
  翻转维护时 `VolumeProvisioner.rewriteContainersOnDisk` 给挂了它的容器排更新（`storage_maintenance`）。启用前可预览：`POST .../storage-pools/:id/mount-preview`、`POST /shared-backends/:id/mount-preview`（admin）。
  盘的路径 / 维护变化经 `storage-pools/disk-mounts.ts` 的 `DiskChangeNotifier`（`afterCommit`）通知。停用（路径置 NULL）只停止新建卷与新增挂载，已有的卷和挂载保留；
  改路径只影响之后的挂载，已在容器里的挂载保留原路径（规划按（容器, 卷）判断已挂，不按路径重挂）。
- **规划**（`volume-provisioning.ts`，纯函数，读 `storage-provisioning.read-model.ts` 的快照）：授权覆盖的已启用、非维护的盘上没有卷就建（本地卷 `provisioning` + `volume.ensure`；共享卷直接 `active`，目录在第一次挂载时建）；
  用户每个 `active` 容器都挂上他能到达的 `active` 卷（本地卷在本服务器；共享卷经该后端在本服务器上唯一的已登记执行池），路径为盘的挂载路径；容器在该路径已挂了别的卷则跳过（`pathConflicts`）。
  `failed` 的卷不动也不替换；没有授权覆盖的盘上的卷归失效流程（宽限内覆盖恢复则被重新挂上）。新建容器在创建事务里由 `VolumeProvisioner.bindNewContainer` 挂上已有的卷（请求里没有 `volumes` 字段）。
- **弹性额度**（`allocateQuotas`）：一个服务器授权的数据卷共用 L = 总额 − 该用户在此服务器的系统盘承诺量（≥ 0；共享后端授权自成一组，L = 其额度）。
  `R = L − Σ已用`；`R > 0` 时每卷配额 = 已用 + R/n（按盘的物理余量与该盘的上限 `cap_bytes` 封顶，余下的分给其他盘）；`R ≤ 0` 时按已用量等比缩到 L。
  上限调低到已有数据以下与额度低于数据同样处理（下一句），且到达上限的一步是精确的。
  能把配额设到已用量以下的文件系统（dir + 项目配额、CephFS，Incus 7.6 实测：之后只能读和删）直接设到目标；其他（ZFS 拒绝低于 used）走棘轮：配额降到已用量并跟着删除往下走，从不回升。
  每卷最低 1 GiB（0 在 Incus / XFS 里是不限；不超过该盘上限）。单卷组配额就是 min(L, 上限)；多卷组用量未知（服务器不可达）时本轮只执行调低的上限。先缩后扩：缩小保留预留（`shrinkReservation`），扩大只用 L 减去各卷承诺量后的余量。
  服务器授权的数据卷每轮都读用量（准入要用），共享卷只在棘轮时读。
  `decideVolumeResize` 的 `belowUsage`（`quotaBelowUsage`）让这类缩容不受用量下限阻拦。
- **执行**：`StorageBalancer` 每 30 s 一轮（另由 `AccessChangeNotifier`、`DiskChangeNotifier` 唤醒，单飞）：经 agent 读需要的用量（`volumesNeedingUsage`），交给 `VolumeProvisioner.run`；
  每个动作单独事务并复核（覆盖、盘仍启用、卷 revision），快照过时只损失一轮。系统写入，审计 actor 为 NULL；平衡器的缩放（intent `request.source = 'quota_balancer'`）不写 `volume.resize` 审计，其 Incus 写入也不逐条记 `incus.mutate`。
  Backend 停着时配额停在原值，Σ 配额 ≤ L 仍成立。
- **挂载路径检查**（`container-reconcile-steps.ts` 的 `checkPendingMountPaths`）：实例上还没有的挂载，先经 Incus 文件 API 看路径；是文件或非空目录则挂载行置 `blocked`（不进实例文档），
  之后该容器每次 pass（启动、重启、任何更新）复查，路径空了或没了再挂；建容器时实例不存在，不查；查询本身出错则照常挂载（只遮盖、不删除）。
- **删除**：用户只读（`GET /volumes`、`/shared-volumes`、容器的挂载列表、容量）。user_admin 可 `DELETE /volumes/:id`、`/shared-volumes/:id`，仅当没有授权覆盖该盘（否则 409 `VOLUME_STILL_GRANTED`，会被马上重建）且已卸载（409 `VOLUME_REQUIRES_UNBIND`）。

## 存储池用途与系统盘分配（`storage-pools/root-placement.ts`，000013）

- 本地池有两个独立用途，可同时开：**系统盘**（`infra.storage_pools.system_disk` + 参数 `system_weight` 1–100、`system_max_used_percent` 水位 1–100 / NULL）与**数据盘**（`mount_path`，见上节）。
  系统盘要求已登记、`root_disk_capable`、非共享执行池（CHECK）；关闭时参数复位（CHECK），已有系统盘照常运行、扩容仍按所在池准入，只是不再接收新容器。
  开着系统盘的池不能取消登记（`STORAGE_POOL_IN_USE`，同一 PATCH 里一起关掉可以）。没有 `servers.system_pool_id` 了。
- 服务器 `root_placement`：`single`（至多一个系统盘池，约束触发器 `servers_root_placement_single` 兜底）或 `random`（按权重随机）；`root_placement_sticky` 只在 random 下可为 true。
  single 下 `PATCH .../storage-pools/:id` 给另一个池开系统盘 = 在同一事务里把角色搬过来（原池关闭、revision +1，审计 `systemDiskMovedTo`）；random → single 时多于一个系统盘池返回 409 `SYSTEM_DISK_NOT_SINGLE`。
  池的系统盘改动与服务器 PATCH 都持服务器行锁。改策略 / 开关只影响之后新建的容器，平台不在池之间搬系统盘。
- 建容器选池（`chooseRootPool`，服务器行 → 系统盘池按 id `FOR UPDATE`）：先查磁盘总额与系统盘上限（每服务器跨池合计，见授权模型的「磁盘总额」），再排除配额未生效、实际用量（`used_bytes`，全量扫描 / agent 连接时刷新）达到水位、超分准入放不下的池；
  都被排除时全为配额原因返回 `STORAGE_POOL_QUOTA_INEFFECTIVE`，否则 `STORAGE_POOL_EXHAUSTED`（`details.pools` 逐池给原因）。sticky：该用户在本服务器 live 容器（非 failed / deleting）系统盘承诺量最大的池仍可用就用它（不单独记录，同一用户同服务器的创建由 `lockOwnerServerQuota` 串行，所以无竞态），否则照常随机。
  水位只管新系统盘的落点：超分比看承诺量，水位看盘实际有多满（盘上有平台账外的数据时两者差很远）。
- 预检要求至少一个系统盘池且每个都在 Incus 里；探针默认跑在按名排第一的系统盘池上。管理员的池 DTO 带 `rootDisks`（该池 live 系统盘数与承诺量），用户视图为 null。

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
   库里认识、但本服务器没有 placement 的共享卷 catalog（执行器经 `incus admin recover` 接入共享后端会导入已有目录：无标签、无 size、无 `security.shifted`）
   由扫描补一条 `ensuring` placement（`adoptListedCatalog`）并排卷校正（没有 size 按承诺尺寸、含缩容预留计，`catalogSize`），删除时随其他 catalog 一起清掉；
   容器只挂 `security.shifted=true` 的共享 catalog，遇到未 shift 的先排卷 ensure 再重试（`ensureSharedCatalogOnServer` 的 `unshifted`）。
   卷校正改写 `security.shifted` 只看 Incus `used_by`，不看库里的挂载行（等 catalog 的挂载不算在用）。
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
   不能把健康 agent 的控制 / stream 连接挡在外面。被拒的凭据只记进给运维看的 `AgentCredentialRejections`，不限流（每个来源 IPv4 地址 / IPv6 /48 至多 16 条，超出的新 id 直接丢弃、不记日志，已列出的照常计数）。
   agent 端 `policy.ts` 是安全边界（只许 `nyc-*`/`nyv-*`、配置白名单、禁 raw/特权/宿主路径/profiles、
   必须 idmap.isolated、网卡 `nyh*` + IPv4/MAC 过滤，volatile 改回当前值；更新时与 Incus 当前值相同的配置键原样放行，白名单只管新增 / 改值的键，例如池 `volume.*` 默认值复制进卷的 `zfs.*`）；
   backend 生成的规格必须过得了它：`backend/src/agent-policy.contract.test.ts` 用真实的规格构建与 Incus 操作
   （容器、卷、镜像、预检 probe、控制台）经真实 `IncusClient` 送进 agent 的 `policy.ts`（按路径加载 agent 源码，
   backend 不依赖 agent 包）；新增发往 Incus 的请求时把它的流程加进去。客户网卡统一用 `buildGuestNicDevice`（不带 `security.port_isolation`：同机容器默认互通，能去哪由出站防火墙决定；policy 仍允许该键为 true/false，漂移纠正会去掉旧值）；MAC 由 IPv4 地址派生（`deriveGuestHwaddr`，`02:6e` + 四个地址字节），所以回收重用的地址仍是同一个 MAC（对端的邻居 / ARP 缓存远长于地址回收的 drain）。
   IPv6 拦截表 `bridge nyabase_guard` 与出站防火墙表 `bridge nyabase_firewall` 是 agent 自己执行的不变量：policy 把会接通客户网卡的请求（start / restart /
   unfreeze、`start: true` 创建、给未停止实例新增或改网卡）标为 `bringsUpGuestNic`，agent 转发前现场校验两张表（必要时补回），
   不在位返回可重试的 `ipv6_guard_missing` / `firewall_missing`（`AGENT_IPV6_GUARD_MISSING` / `AGENT_FIREWALL_MISSING`，intent 退避重试不失败）；状态经 hello / status 帧上报，
   只在内存里（`AgentConnection.status` → 服务器 DTO `agent.ipv6Guard` / `agent.firewall`），两者都在位时唤醒该服务器（`agent-presence.service.ts`），backend 不轮询它。
   开机无窗口：unit 的 `ExecStartPre` 是 `guest-guards`（别名 `ipv6-guard`），在 Incus 启动前补回 IPv6 guard，并按 `<stateDir>/firewall.json`
   恢复 `bridge nyabase_firewall`（没有文档 / 文档损坏时用 fail-closed 表，容器出站全断，直到 Backend 下发）。
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
    - API service（volumes、storage-pools、containers 控制面、shared-backends、ip-pools 等）通过本模块的
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

前端的字节显示只走 common 的 `formatBytes` / `scaleBytes`（B → PiB 自动进位，不写死 GiB），图表等紧凑处用 `formatBytesCompact`，速率用 `formatRate`；尺寸输入框仍以 GiB 为单位，下方提示用 `approxSizeHint` 显示换算结果。

前端：页面或组件超过体量时拆成与页面同名的目录（`pages/foo-page.tsx` + `pages/foo-page/*`，hooks 用 `use-*.ts`），
读取源码文本的 surface 测试用 `lib/read-source.test-helper.ts` 的 `readSource` / `readSourceDir`。

SSH 代理按公钥认证、按名路由：direct-tcpip 目标是容器 IP 或 `<容器名>[.<ssh.proxyHostSuffix>]`，只在持钥用户自己的容器里解析
（所以容器名按所有者忽略大小写唯一，`containers_owner_name_key`）。代理的公网地址是有序的「线路」（`interaction.ssh_proxy_lines`，admin 在 SSH 代理 → 线路 / `/admin/ssh-proxy/lines` 管理，名称 + host:port + 可选提示），
不是系统设置（`ssh.proxyPublicHost/Port` 已由 000002 迁成第一条线路 `默认`）；用户经 `ssh-client-config` 读到全部线路，known_hosts 覆盖每条线路的地址。
容器 SSH 卡片 = 「快速连接」tab（`ssh <名>.<后缀>`，旁边是一次性配置说明，ProxyJump 经用户选的线路，默认第一条）+ 每条线路一个 `ssh -J` tab（提示显示在命令下）。快照只下发有可达路由的用户 / 容器。每个用户一个主机证书 CA
（`ssh-host-ca/`，只依赖 platform；`SshKeyCryptoService` 在 `platform/`），reconciler 在 sshd 就绪后签发确定性的主机证书并写 sshd drop-in，
尽力而为、不让 intent 失败；guest 的 `authorized_keys` 只改标记块内的内容。

SSH 连接历史（`tools/ssh-proxy/src/history.rs`、`backend/src/ssh/ssh-history*`、`ssh-sessions*`）：代理是纯跳板，只能看到外层连接与 `direct-tcpip` 通道，
看不到内层会话里的命令和 -A / -L / -R（不要为此做中间人）。认证通过的每条连接、它打开或被拒的每个通道，在打开和关闭时各上报一次**完整记录**，
按（代理实例 `proxyId:instanceId`，序号）幂等 upsert：计数只增、关闭一经记录就保留、真实关闭覆盖 `lost`，所以记录乱序、重复都无妨。
记录在代理的有界发件箱里等 `historyAck`，后端提交后才确认（累计确认，所以存储失败后丢弃后续帧直到代理重发）；字节数由 status 帧每 30 s 落库。
未认证连接只按（窗口、地址、原因）计数。来源地址是 TCP 对端；只有 `NYABASE_SSH_PROXY_PROTOCOL_TRUSTED`（地址 / CIDR）里的对端才读 PROXY v1/v2 头并以头里的地址为准（可不带头），读头在限流之前、在 accept 循环之外（`proxy_protocol.rs`），所以单地址限额按真实客户端算。容器里 sshd 看到的永远是代理机地址。代理消失 10 分钟后其未关闭连接记为 `lost`；超过 `ssh.proxyHistoryRetentionDays` 的明细折叠进
`ssh_proxy_daily_usage` 后删除，统计同时读明细与汇总。`GET /ssh-sessions` 遵循 scope 规则（mine = 自己发起的连接，all = user_admin）。

代理快照（`tools/`、`http-proxy/`、`ssh/`、`proxy-snapshots/`）：租约（`validUntil`）是撤销的上限，构建失败时什么都不发，
代理在租约到期后 fail closed；**不得**用新租约重发旧路由（会让撤销活过租约），失败只在 error 日志里写明何时 fail closed。
HTTP 代理按路由撤销：每个 hostname 有一个 incarnation，只在连续快照里权限元组不变时延续，交换只在自己的路由被删 / 改权限或租约到期时中断，
绝不因其他站点的变化而全局重置。域名池必须互不嵌套（`http-domain-overlap.ts`），绑定主机名不得是任何池域名或其父域。
控制链路两端都有存活检测（代理 `proxy_common::control_link`，Backend `ProxyControlHeartbeat`）；待握手 / 未认证槽位按来源公平分配并在满时驱逐最重来源（`conn_limit.rs`）。

出站防火墙（`firewall/`、`common/src/protocol/firewall.ts`、agent 的 `firewall*`）：只管容器出站（`nyh*` 进桥的帧）、无状态，
规则（名称、全局唯一优先级、`accept | drop | reject`、`all | tcp | udp` + 端口、IPv4 网段、0..n 台关联服务器）在每台服务器上按优先级第一条命中生效，
都不命中放行，不自动放行任何地址。管理员规则之前有 agent 写死的二层防护（`firewall-render.ts` 的 `GUARD_RULES`，不可配置、规则放行不了）：
广播只放行 ARP（每网卡限速）、其他广播与全部组播丢弃、DHCP（UDP 67/68）丢弃、发往未学到 MAC 的单播每网卡限速（防未知单播泛洪；
MAC 在 forward / output 钩子、Incus MAC 过滤之后从发往 `nyh*` 的帧学到，5 分钟）；
限速状态在表内动态集合里，所以 agent 校验表用 `nft -t list`（不列集合元素），改这里时 `firewall-nft.test.ts` 用真实网桥发帧验证。规则只有 admin 能改（`/admin/firewall-rules`，`expectedRevision` CAS，写操作持 `lockFirewallPolicy`，
关联服务器行 `FOR KEY SHARE` 防止与删除服务器竞态；名称 / 优先级冲突 409 `FIREWALL_RULE_CONFLICT`，每台服务器 ≤ 256 条规则、网段合计 ≤ 4096，
超出 400 `FIREWALL_TOO_LARGE`）；网段 / 端口在 common 规范化后存储。`firewall-sync.service.ts` 按服务器生成文档（按优先级排序，摘要 =
`sha256(firewallDigestInput(rules))`，只在 Backend 计算；没有规则也有空文档，用来解除 agent 的 fail-closed 表），经 `firewall.apply` 下发：
规则变更在 `afterCommit` 后同步改前 ∪ 改后的服务器；agent 每次 `connected` **无条件**下发一次（agent 的防火墙只在当前连接上被确认过才算在位，
离线期间新增的拒绝规则不会被旧文档放过）；status 帧的摘要与期望不同且无在途同步时再下发。每台服务器单飞 + 脏位；传输 / agent 内部错误按 5 s 起翻倍、
封顶 5 分钟重试，`bad_request`（agent 拒收文档）记为 `failed` 不自动重试（等规则变化或重连）；断开即丢弃该服务器的在途 / 重试状态。
同步状态只在内存（`GET /admin/firewall-rules/status`：`offline | synced | pending | failed`，服务器 DTO `agent.firewall`），不轮询。
`firewall/` 只依赖 platform / iam / incus，servers → firewall 单向（`FirewallSyncService.agentStatuses`）。预检不再检查「容器可达宿主」与出站网络。

GPU 是平台内置功能（`gpu/` 模块、`common/src/gpu/`、agent 的 `gpu-collector`），不存在扩展框架。卡与 CPU 一样共享：同一张卡可同时绑定到多个容器，只按授权准入（授权的卡由 GPU 张数按用户 hash 选出，见授权模型），`control.container_gpu_claims` 不按（服务器, 卡）唯一。

容器脚本（`container-scripts/`、`common/src/protocol/container-scripts.ts`、迁移 000011）：管理员的脚本 + 文件，以 root 在容器内执行，仅 admin（`/admin/container-scripts`）。
脚本 = 范围（全部，或服务器 / 镜像 / 所有者 / 指定容器，每个非空列表都要命中，排除列表永不命中；只用容器终身不变的属性，所以容器不会移进移出范围；SQL 版 `container-script-scope.ts` 与 common 的 `containerScriptScopeMatches` 由 pg 测试固定一致）
+ 触发：立即（`applyNow`，每次发布单独选）/ 新容器（`onNewContainers`）/ 每次开机（`everyBoot`，创建后不可改，隐含新容器）+ 全局唯一优先级（未归档的脚本之间唯一，数字小先跑）。
内容、范围与执行参数按版本存（`container_script_versions`，发布后不可改；文件内容按 sha256 去重存在 `container_script_blobs`，经 `POST …/blobs` 原始字节上传，≤ 16 MiB，反代要放行）。
每个（脚本，容器）一行 `container_script_targets`，持 `lockContainerScripts` 改写：
- 执行一次：`target_version` 比成功过的新就待执行。发布带立即 → 范围内现有容器（含 provisioning）都按新版本待执行（停机的按 `stoppedPolicy` 等开机或 `skipped`），正在跑的置 `rerun`，跑完再来一次；
  不带立即 → 未完成的（pending / running / failed）改用新版本，成功过的不动，范围内其余现有容器记 `exempt`（provisioning 的不记，算新容器）。「新容器」= 范围内没有目标行的容器（以行为界，不以时间戳：竞态时宁可多跑）。
- 每次开机：开机标识是 Incus 实例的 `last_used_at`（start、restart、guest 内 reboot 都变，exec / 推文件 / 读状态 / 冻结解冻不变；`listInstances(1)` 就有），记在 `container_boot_observations`；
  行记着它处理过的 `boot_id`，观测到别的开机就重置为待执行（`applyBoots`）。不带立即发布时，现有容器记 `exempt` + 当前观测到的开机；从未观测到的记 `boot_after`（发布时间），不晚于它开始的开机视为发布时那次。
调度（`ContainerScriptScheduler`，单进程、不进 reconcile 槽位）：唤醒（脚本写操作、容器 intent、Incus 事件经 `ReconcileWakeService`、跑完的执行）+ 30 s 兜底；每分钟观测全部在线服务器。
候选 = 待执行、到了重试时间、容器 active + `power_intent=running` + 观测 running、没有在跑的脚本、没有 reconcile claim，且同一容器上没有优先级更小的就绪行（每容器至多一个候选，严格按优先级；
失败不阻塞后面的脚本）。上限：全局 / 每服务器（系统设置 `containerScripts.maxConcurrent` / `maxConcurrentPerServer`）、每脚本（`maxParallel` / `maxParallelPerServer`）、灰度（`canaryCount`：已开始的容器数到了就不再开新容器）。
`container_script_runs` 上 `(container_id) WHERE status='running'` 唯一索引兜底同一容器不并发。
执行（`container-script-runner.ts`，只用 exec（无 WebSocket、`record-output=false`）和文件 API，与 authorized_keys 同步同一批请求，agent 协议不变，流程在 `agent-policy.contract.test.ts`）：
先读实例（不在运行 / 开机变了 → `abandonRun`，不计次数、30 s 后再试），把脚本、文件和 wrapper 分块（≤ 768 KiB，`X-Incus-write: append`）推到 rootfs 上的 `/var/lib/nyabase/script-runs/<run id>/`（不放 `/run`：开机早期 tmpfs 会遮住），
exec wrapper 并等 operation；wrapper（`container-script-wrapper.ts`，有真实 shell 测试）持 `flock`、等 `systemctl is-system-running --wait`（≤ 120 s）、
`install` 到 `<路径>.nyabase-tmp` 再 `mv` 原子替换、`timeout -k 30` 杀整个进程组、只留合并输出最后 64 KiB，最后写 `output` → `timed_out` → `rc`（`rc` 在即结果完整）。
从 exec 发出起每次执行都有结果：operation 丢了就轮询 `rc`；Backend 重启后 running 的执行按 `rc` 恢复（`watchRun`），开机变了或过了 `deadline_at` 记 `interrupted`。脚本须幂等（失败、超时、中断都计一次尝试，1 / 5 / 15 分钟退避，用完 `failed`，人工重试）。
跑完按 `container-script-rules.ts` 的 `targetAfterRun` 更新目标行；本版本失败（failed / timed_out，不含 interrupted）的容器数达 `pauseAfterFailures`，或灰度跑够且没有在跑的，脚本自动暂停（审计 `container_script.auto_pause`，actor NULL）；
发布新版本解除自动暂停，手动暂停要手动恢复，恢复时清灰度。暂停 / 归档不撤销已做的事；归档让出名称与优先级。
执行记录每（脚本，容器）留最近 20 条；不进审计（只审计管理员操作）。所有者经 `GET /containers/:id/maintenance`（scope 规则同其他容器子资源）只看到脚本名、状态与时间，看不到脚本和输出。
JSON 请求体上限是 256 KiB（`main.ts`），因为 64 KiB 的脚本转义后可能翻倍。

## Schema 规则（上线冻结）

迁移在 `packages/backend/src/platform/persistence-pg/migrations/`，启动时按 sha256 精确校验已应用的迁移：
已发布的迁移文件改一个字节，线上库就拒绝启动。已发布迁移的校验和固定在
`platform/persistence-pg/migration-freeze.test.ts` 的 `RELEASED_MIGRATION_CHECKSUMS`，**不要改已发布的迁移，也不要改这个常量去迁就**；
schema 变更一律新增 `NNNNNN_name.sql`（只追加），随版本发布时把它的 sha256 加进常量。
`000001_initial.sql` 随上线版本冻结；上线前用旧版 000001 建的库（试运行 / staging）必须重建。
2026-10-26 把 000001–000007 压缩成了新的 `000001_initial.sql`（与旧的 7 个迁移依次应用后的 schema 逐字节相同，`pg_dump --schema-only` 比对过），
正式库的 `system.schema_migrations` 已手工改写成只剩这一行；之后的 schema 变更照旧从 `000002_*.sql` 起只追加。
`000014_disk-quota.sql` 把数据盘授权并进服务器授权（总额 + 数据盘列表进 bundle），转换不缩小任何人的空间、不开失效（迁移内校验有效覆盖不变），遇到不限的系统盘配额拒绝迁移；步骤见 OPERATIONS.md。
`000003_grant-bundles.sql` 删除用户组并**清空**服务器 / 数据盘授权（不转换；共享后端授权保留，经组获得的展开给各成员并按旧规则合并）：上线后所有用户失去服务器与数据盘覆盖、进入 14 天宽限（立即停机、卸载卷），管理员须在宽限内按 bundle 重新分配。

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
- guest 提示符：实例规格带 `user.nyabase.display.container` / `user.nyabase.display.server`（容器名、服务器显示名），
  镜像的 `/usr/lib/nyabase/prompt.sh`（nyabase-images 仓库）每次开交互 shell 经 `/dev/incus` 读取，显示 `root@<容器名> [<服务器名>] ~#`；
  实例名与 guest 主机名保持 `nyc-<id>`。改服务器名唤醒全量扫描改写这两个键（被搁置 / failed 的容器扫描跳过，等下一个 intent），不记 `container.drift_corrected`（`isDisplayConfigKey`）。
  控制台默认命令是 `bash -l`（没有 bash 才 `sh -l`）：dash 登录 shell 不读 `~/.bashrc`，提示符只在 bash 里生效。
  容器名只许 `[a-z0-9-]`（SSH 按名路由，000007 把旧名转成了小写）、≤ 48 个字符，默认 `<用户名>-<服务器名>`（前端 `defaultContainerName`），可改名（`PATCH /containers/:id/name`：实例名不变，下发 intent 改写提示符标签与主机证书，代理快照立即失效）；服务器名任意可见字符与空格、≤ 32 列（中文 2 列，common 的 `displayWidth`）。
- 镜像版本（`infra.image_versions`、`images/image-versions.service.ts`）：`version` 是 catalog 版本（`20261027_nb01`，`created_at` 只是首次拉取时间），`imageLabel` 显示为 `ubuntu/24.04(2026/10/27)`，容器显示自己 `image_fingerprint` 对应的版本。repull 只切镜像的当前指纹，已有容器保持创建时的
  `image_fingerprint`，ensure 绝不删除旧版副本（容器重建只从本机按指纹找镜像，catalog 只留最新版），`recordEnsured` 也不改写已有的当前指纹。
  旧版只能由 admin 删除，且只在不是当前版本、没有任何容器（不分阶段）引用时；删除只写 `deleted_at`，副本由镜像 reconciler 的全量扫描
  按库里状态移除（`listUnneededCopies` / `removeCopyIfUnneeded`），只碰 `infra.image_copies` 里记录为本服务器拉取的副本
  （aya-1 等主机不专用，宿主机自己的同指纹镜像不能删），记录不随镜像行级联删除。没有一次性的删除 intent——它会被同资源的 settle 吞掉。
- 进程数 / 网卡带宽 / 磁盘读写是可在线编辑的系统设置 `containers.*`，统一作用于所有容器。磁盘读写只设在系统盘 `root` 上（按块设备生效，同盘的本地卷共享这个限额）；卷设备一律不带 `limits.*`：Incus 为自定义卷解析块设备时会落到 tmpfs 暂存目录，挂着带限速的卷时每次重算限速都失败（`Invalid block device "tmpfs"`）。CephFS 卷不限 IO。
- 漂移：平台拥有整份实例文档，只放过 `volatile.*`、`image.*`；未知配置键、多出的设备、设备内多出的键、
  非空 profiles 都算漂移，写回时整份覆盖并记审计 `container.drift_corrected`。
- `power_intent='stopped'` 时 reconciler 先停机再准备挂载，停机绝不等卷就绪；卸载（含强制卸载）同样先于其他挂载的就绪检查：
  detaching 设备单独热拔并立即结清该行；单独热拔若因内容被拒（`AGENT_POLICY_DENIED` / `INCUS_BAD_REQUEST`，例如宿主侧漂移），
  交给本轮完整托管文档写回（同时纠正漂移），此时会等其他挂载就绪。同一 intent 连续 `VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS` 次检查挂载卷都未就绪
  （进程内计数，不含服务器不可达 / 忙重试）才以 `VOLUME_PLACEMENT_FAILED` 失败，不再无限重试。

