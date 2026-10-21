# Agent Notes

## @nyabase/common：不要在 src/ 下遗留编译产物

**问题**：`packages/common/src/` 中残留了旧的 `tsc` 编译产物（`enums.js`、`utils.js`、`protocol/ws.js` 等）。
Vite 通过 alias 将 `@nyabase/common` 指向 `src/index.ts`，但 `index.ts` 中的 `export * from './enums.js'`
会被 Vite 优先解析为同目录下的真实 `.js` 文件，而非 `enums.ts`。
旧的 `.js` 是 CommonJS 格式的历史版本，缺少新增的枚举值（如 `Capability`），导致前端运行时报
`SyntaxError: does not provide an export named 'Capability'`。

**根因**：`src/` 目录被当作输出目录使用过（`tsc outDir` 指向 `src/`），遗留的 `.js` 污染了源码目录。

**修复**：删除 `packages/common/src/` 下所有 `.js` / `.js.map` / `.d.ts` 编译产物，重启 Vite。

**构建事实（现状）**：
- `common` 只产出一份 CommonJS `dist/`（`tsc -b`，`composite`），`main`/`types` 指向 `dist`；没有 ESM 产物，`exports` 里也没有 `import` 条件。
- backend / node-exporter 通过 TypeScript project references（`references: [{ "path": "../common" }]`）依赖 common，
  `tsc -b` 会自动先构建 `packages/common/dist`；运行时 Node 经 workspace 软链 + `package.json#main` 解析，不使用 tsconfig `paths` 映射，也不需要运行时路径注册钩子。
- 前端与 backend 的 vitest 仍用 Vite alias 直接指向 `packages/common/src`（前端唯一的解析方式）。

**预防**：
- `common` 包的 `tsconfig.json` 的 `outDir` 必须指向 `dist/`，**绝不能**指向 `src/`。
- `packages/common/src` 下不得出现任何编译产物（`.js` / `.js.map` / `.d.ts`），`scripts/check.sh` 对此有断言。
  手动检查：`find packages/common/src -name "*.js" | sort`
- 前端 dev 模式下 Vite alias 直接读取 `.ts` 源文件，`dist/` 对前端无效，无需同步。

## API 表面：每个资源只有一套路由

- 同一资源不再有 `/x` 与 `/admin/x` 两套 controller。`/admin/` 前缀只留给没有用户版本的运维资源
  （groups、ip-pools、catalog、metrics、ssh-proxy、incus-client-certificate、system-settings）；
  `http-api-duplicate-routes.contract.test.ts` 断言不存在同名资源同时挂在两处。
- 鉴权在 service 里：`@CurrentActor()`（`iam/actor.ts`）给出 `{ userId, capabilities, authKind, authVersion }`，
  `CapabilitiesGuard` 每个请求只解析一次 capability。service 方法签名是 `method(actor, ...)`，
  每个 service 只有一个私有的 `assertCanAccess(actor, row)`；不要再写 `ForUser/ForAdmin/ForSystem`
  包装或 `'user' | 'admin'` 参数。内部调用方（授权到期等）用 `systemActor(systemUserId)`（`SYSTEM_ACTOR`）。
- 列表默认 `?scope=mine`；`?scope=all` 需要对应 capability（否则 403），管理员专属过滤参数只在 `scope=all` 下可用。
  DTO 形状不同的详情（servers、images、shared-backends）同样用 `?scope=all` 取管理员视图。
- 只有管理员能做的操作在方法上声明 `@RequireCaps(...)`；`http-api-capabilities.contract.test.ts` 固定这些声明。
- intents 只有 `GET /intents`、`GET /intents/:id`、`POST /intents/:id/retry` 一个 controller；
  某个资源的操作历史用 `?resourceType=&resourceId=`（多个 id 用逗号分隔，例如镜像的所有分配）。

## 后端结构规则（`packages/backend/src`）

`app-module-graph.test.ts`、`scripts/check.sh` 和相关结构测试固定这些规则，改动前先读它们。

1. 不使用 `forwardRef`。出现环时，把双方共享的小块（只读查询或常量）下沉到更低层。
2. `reconcile/` 不 import 任何领域模块。引擎只认识 `ManagedReconciler` 接口：各领域 reconciler 在 `onModuleInit`
   中 `ReconcilerRegistry.register(this)`，资源状态（`needsAttention` / `markSucceeded` / `markFailure`）由 reconciler 自己写，
   worker 在 `onApplicationBootstrap` 启动。服务器清点、健康标记等通过 servers / storage-pools 提供的服务调用。
3. 领域模块只单向依赖 `platform/`、`iam/`、`reconcile/`、`incus/`，领域之间允许单向依赖，不允许环。
   `JwtAuthGuard` + `CapabilitiesGuard` 以 `APP_GUARD` 全局注册，公开路由用 `@Public()`；模块不必为 `@UseGuards` 导入 IAM。
4. 不保留空壳目录：`runtime`、`database`、`storage`、`domain`、`catalog`、`common`、`filters`、
   `server-card-extensions`（以及仓库根 `extensions`、前端 `extensions`）已删除，`scripts/check.sh` 断言它们不会回流。
5. 不为单一实现建 DI Symbol 端口，直接注入类，测试用 `overrideProvider(Class)` 或 `new Class(fake)`。
   保留的 token 只有 `PG_DATABASE` / `PG_POOL` / `PG_OPTIONS` 和 `INCUS_CLIENT_FACTORY`（外部边界）。
6. 生产必需依赖不得 `@Optional()`（当前全仓为 0）。
7. controller 不直接使用 Kysely，调用 service / repository。service 可以直接用 Kysely，
   只有被多个 service 共享的查询才抽成 repository。

GPU 是平台内置功能（`gpu/` 模块、`common/src/gpu/`、node-exporter 的 `gpu-collector`），不存在扩展框架。

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
