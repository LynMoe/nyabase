# PostgreSQL + Redis + VictoriaMetrics 目标架构

状态：目标架构 / 实施中
决策日期：2026-07-25

## 1. 目标

Nyabase 重构为一个模块化单体代码库和四类运行职责：

```text
Browser / API client
        |
        v
Control API ------------------------------+
        |                                 |
        | SQL                             | MetricsQL
        v                                 v
PostgreSQL                         VictoriaMetrics Single
        ^
        | SQL                         ^
        |                             | remote write
Control Worker                  vmagent + disk queue
        ^                             ^
        | wake / invalidation          | Prometheus import
        |                             |
Redis <------ Agent Gateway ----------+
                  ^
                  |
               Agents / consoles
```

默认交付仍是一个 Backend 镜像，`runtime.role=all` 在单进程中装配 API、Gateway 和 Worker。规模扩大后可用同一镜像选择 `api`、`gateway`、`worker`，不引入内部业务 RPC，也不拆多套代码库。

核心优化不是增加组件，而是让每类数据只有一个明确所有者：

- PostgreSQL：所有控制面真相、事务、工作流、审计；
- Redis：丢失后可从 PostgreSQL 或活跃连接重建的实时优化；
- VictoriaMetrics：指标时序；
- 进程内存：当前 socket、bounded buffer、singleflight 和 LRU，不是集群真相。

## 2. 组件边界

### 2.1 Control API

负责：

- 认证、授权和 capability 校验；
- 用户、组、授权、服务器、镜像、容器、存储、配额和代理用例；
- 在一个 PostgreSQL 事务中写业务聚合、Command、资源声明、Audit、Outbox；
- 从 PostgreSQL 查询业务投影，从 VictoriaMetrics 查询指标；
- 对可缓存的非安全查询使用本机 LRU / Redis 短 TTL 缓存。

不负责：

- 直接持有 Agent WebSocket；
- 等待 Agent 完成物理动作；
- 在数据库事务内调用 Redis、VM 或 Agent；
- 把缓存结果用于危险 mutation 的最终授权。

### 2.2 Agent Gateway

负责：

- Agent / console WebSocket admission、协议校验、背压和本机 socket；
- PostgreSQL session generation fencing；
- 将最新 observation 和 task result 先耐久写入 PostgreSQL；
- 领取本机已连接 Server 的 due Command，提交后发送 frame；
- 将指标批次校验后快速转发给 vmagent；
- 订阅以 durable `gateway_id` 定址的版本化 Redis RPC，并发布可丢 wake。

不负责：

- 修改业务期望态；
- 执行领域 finalizer 或 reconcile；
- 把本机 `Map` 或 Redis Pub/Sub 当权威；
- 在 state-report handler 内串行执行业务收敛。

### 2.3 Control Worker

负责：

- Reconciler：desired 与 observed 比较并幂等地产生 Command；
- Finalizer：将已耐久结果投影到领域聚合并释放资源；
- timeout / retry / retention；
- Outbox relay、缓存失效和 wake；
- `FOR UPDATE SKIP LOCKED` 多实例安全消费。

不负责：

- 持有 WebSocket；
- 通过 Redis 承载任务 payload 或任务状态；
- 绕过 PostgreSQL 唯一约束实现资源互斥。

### 2.4 PostgreSQL

唯一权威：

- IAM、token、授权、权限版本；
- 服务器、Agent admission、quarantine、session generation；
- 镜像、容器、存储、网络、代理、配额的 desired/observed projection；
- Command、attempt、result、resource claim、execution lane；
- reconcile queue、outbox、audit、system settings。

规则：

- 默认隔离级别 `READ COMMITTED`；
- 行锁、CAS、唯一/排除约束维护不变量；
- 高冲突选择使用 `SKIP LOCKED`；
- 仅确有跨行写偏差的短事务使用 `SERIALIZABLE` 和 bounded retry；
- 事务内不做网络 I/O；
- 所有时间使用 `timestamptz`，ID 使用 UUID，版本/序列使用 `bigint`；
- 大 payload/result 与热状态分表，避免热点行 TOAST 放大。

System Settings 的 online-editable 子集保存在
`system.settings` 单例快照中，以绝对 `bigint` revision 和稳定 content token
执行 CAS。部署 YAML/env 只负责首次 bootstrap、secrets、进程角色、连接参数及
restart-required/read-only 字段，运行时 PATCH 不会改写挂载文件。每个角色启动
时从 PostgreSQL 加载，提交后 Redis 只发送可丢的 version wake；固定轮询
PostgreSQL 负责 Redis 停机、清空或漏通知后的最终收敛。设置写入与 audit append
共享调用方授权事务，任何一边失败都整体回滚。

### 2.5 Redis

允许：

- 5–60 秒查询 DTO 缓存；
- cache invalidation / dispatch / reconcile / system-settings wake；
- 登录、token、握手和 mutation 限流；
- 基于 PostgreSQL durable Gateway owner 的定址、版本化跨角色 RPC。

登录限流的 IP/principal 身份先经服务端 HMAC，再作为 TTL window key；成功请求
只释放自身 window reservation。进程内 bounded limiter 始终同时计数，Redis
不可用时继续作为显式 fallback；生产 Redis 使用 `noeviction`，不能因普通 cache
压力静默重置活跃登录窗口。

禁止：

- Command、结果、审计、权限、quarantine 的唯一副本；
- Redis Queue / Streams 作为耐久工作流；
- Redlock 或 Redis lock 维护资源互斥；
- console/log 高吞吐数据转发；
- 无 TTL 的业务 key。

普通 Pub/Sub wake 是 at-most-once 提示，消费者由 PostgreSQL 定时扫描兜底。
拆分 `api`/`gateway` 的定址 RPC 是显式可用性依赖：Redis 故障时 readiness 和
交互 RPC fail closed，但不得造成 canonical 数据、权限或任务结果错误。

### 2.6 VictoriaMetrics 与 vmagent

- VictoriaMetrics Single 是默认时序存储；
- vmagent 接收 Prometheus text import，使用独立持久磁盘队列 remote-write 到 VM；
- Backend 不再维护自制持久重试队列；
- 指标标签只使用稳定低基数 ID：兼容现有查询的 `server`、`container_id`、
  `gpu_index`、`disk_id`、`user_id`；
- 指标名使用共享协议中的封闭 allowlist，每类指标只接受其固定标签集合；
- 不把用户名、容器名、路径、任务 ID、错误文本或动态 IP 放入 label；
- 指标摄入热路径不查 PostgreSQL / Redis；
- VM 不可用不得阻断控制面，查询返回明确 unavailable/stale；
- vmagent 不可用时 bounded buffer 快速失败并计数，不阻塞 Agent socket。

默认使用 VM Single。只有单机纵向扩容后持续越过容量/SLO，或业务明确要求指标存储节点故障不中断，才升级 VM Cluster。Thanos 不作为主方案，因为本项目没有 Prometheus 分片长期存储需要，引入 Sidecar、Store Gateway、Compactor、对象存储和 Query 会显著提高运维面。

## 3. 领域与聚合边界

### 3.1 IAM

聚合：

- User：身份、状态、密码版本、权限版本；
- Group：成员和 grant；
- Credential：refresh token、API token、SSH public key。

不变量：

- 删除/禁用用户后所有 mutation 立即失败；
- 安全操作始终读 PostgreSQL 当前授权快照；
- `policy_epoch` / `authz_version` 与变更同事务提交；
- 缓存失效是性能优化，不参与正确性。
- authorization cache hit 仍从 PostgreSQL 读取单行 `policy_epoch` 后才可
  接受，因此它不是零数据库 I/O 的 hot cache；危险 mutation 的最终鉴权始终
  读取 PostgreSQL 当前授权投影。这是撤权即时生效的安全取舍。

### 3.2 Infrastructure

聚合：

- Server：注册、Agent credential、quarantine、容量；
- Image：镜像元数据和 grant；
- DataDirectory / RemoteFs：存储端点、assignment、grant。

Server 的在线状态分为：

- PostgreSQL `agent_session`：generation 和 ownership 的安全权威；
- Gateway 本机 socket/watchdog：高频 liveness（不跨进程、不作授权依据）；
- PostgreSQL observation：Reconciler 的最新耐久输入。

### 3.3 Container Control

Container 是单一聚合根：

- identity、owner/group、server/image；
- desired spec、desired generation；
- lifecycle / observed generation；
- 配额和网络期望；
- 1:N mount、GPU allocation、SSH route。

原有 Container identity / desired / lifecycle 三张 1:1 表合并，减少读写 join 和跨表不变量。Mount/GPU 保持子表，因为是有界 1:N 集合。

### 3.4 Workflow

核心表：

- `commands`：热状态和调度字段；
- `command_payloads` / `command_results`：大对象；
- `command_attempts`：每次传输尝试；
- `resource_claims`：资源唯一占用；
- `server_execution_lanes`：每 Server 物理动作串行；
- `reconcile_queue`：可恢复收敛工作；
- `outbox_events`：事务后通知；
- `agent_sessions` / `server_observations`：session fence 与最新报告。

状态机：

```text
queued -> dispatching -> sent -> result_received -> finalizing -> terminal
             |             |
             +---- retry <-+
```

传输语义：

```text
PostgreSQL durable command
+ at-least-once WebSocket transport
+ Agent durable idempotency journal
= once-only physical effect
```

幂等键为 `command_id + desired_generation + payload_hash`。相同键重复执行返回已缓存结果；同 command ID 但 generation/hash 不同必须拒绝并 quarantine。

结果先写 PostgreSQL，再向 Agent 返回 `resultAccepted`。Finalizer 在另一个事务中更新业务聚合、终结任务并释放资源，崩溃后可继续。

### 3.5 Proxy 与交互

- SSH/HTTP route、block、lease、snapshot version 的权威在 PostgreSQL；
- Redis 只通知各 Gateway/Proxy 重新加载绝对版本快照；
- 每份 proxy snapshot 有短 lease，丢通知后自动重建；
- exec / console 的精确 session claim 和 authorization snapshot 在 PostgreSQL；
- 字节流只经过拥有 socket 的 Gateway，不进入 Redis。

### 3.6 Audit 与 System

- Audit 与引发它的领域变更在同一事务追加；
- Audit 使用普通 append-only 表、时间索引与 retention 清理；达到实测规模阈值后再评估按月分区；
- System setting 带版本，写入后通过 Outbox 失效缓存；
- 敏感值只保存密文/引用，不进入 audit payload、日志或时序 label。

## 4. PostgreSQL Schema

逻辑 schema：

| Schema | 所有内容 |
|---|---|
| `iam` | users、groups、memberships、grants、tokens、keys、policy epoch |
| `infra` | servers、agent credentials、images、data directories、remote fs |
| `control` | containers、mounts、GPU、quota、network、HTTP/SSH routes |
| `runtime` | agent sessions、observations、faults、console sessions |
| `workflow` | commands、payloads、results、attempts、claims、lanes、queues、outbox |
| `audit` | append-only audit events |
| `system` | settings、migration metadata |

关键约束：

- 资源 natural key 使用唯一索引；
- active claim 使用 partial unique index；
- observation 仅接受更大的 `(session_generation, sequence)`；
- result 的 `command_id` 唯一，相同内容可幂等重放，不同内容冲突；
- reconcile queue 每 Server 一行，用 sequence/generation 单调提升；
- active commands 使用部分索引，历史查询使用 `created_at`/`terminal_at` 索引；
- audit 当前不默认分区，先使用普通 append-only 表、时间索引与有界 retention。
  只有在真实写入量、清理耗时、索引体积或 autovacuum 证据表明单表无法满足
  SLO 时，才通过迁移引入按月分区并先验证分区裁剪、跨分区查询和归档流程，
  避免小规模部署承担无依据的分区运维成本。

## 5. 关键事务

### 控制操作

1. 开启短事务；
2. 锁定 User policy epoch 和目标聚合；
3. 从 PostgreSQL 计算当前授权；
4. 校验 generation、quota、resource uniqueness；
5. 更新 desired state；
6. 插入 Command、claims、Audit、Outbox；
7. 提交；
8. 提交后 best-effort 发布 Redis wake/invalidation。

### Agent admission

1. 校验 server credential / quarantine；
2. 锁定该 Server session row；
3. 递增 generation，写 gateway/session ownership；
4. 提交；
5. 发送 admission ready。

旧 Gateway 因 PostgreSQL generation/lease 条件更新失败而失去写入权，不依赖
Redis presence 或广播通知。

### Observation

1. 校验 session generation 和 sequence；
2. 条件 UPSERT 最新 observation；
3. UPSERT reconcile queue；
4. 插入 Outbox；
5. 提交后 wake Worker。

### Dispatch

1. Gateway 只选择本机 ready session；
2. 锁定 server lane，`SKIP LOCKED` 领取 due command；
3. 写 attempt / deadline / session generation；
4. 提交后发送；
5. send 前后崩溃都由 deadline 重发，Agent 幂等消除重复物理效果。

## 6. 性能设计

- API 列表使用显式 projection，不加载完整 Entity graph；
- 热查询索引由真实 access pattern 决定，并以 `EXPLAIN (ANALYZE, BUFFERS)` 门禁；
- 高频 heartbeat 只刷新 Gateway 本机 liveness；PostgreSQL
  `last_seen_at`/lease 约 30 秒合并写入；
- observation 只保存最新完整 JSONB，不把每次报告写历史；
- metrics 热路径零业务 DB/Redis I/O；
- 每个 Backend 进程使用配置的主业务连接池；每个承载 Gateway 角色的
  进程另保留最多 4 条专用 Agent session advisory-lock 连接，防止长 fence
  占满主业务池；
- PostgreSQL 连接总预算按
  `Σ(database.poolMax) + 4 × Gateway 进程数 + 运维/迁移余量` 计算并小于
  `max_connections`，默认不引入 PgBouncer；
- bounded queue、frame size、pending bytes 和慢消费者限制保留在 Gateway 本机；
- 先纵向扩 VM Single；不提前承担 VM Cluster 和 Thanos 运维成本。

## 7. 失败策略

| 故障 | 必须表现 |
|---|---|
| PostgreSQL 不可用 | 权限敏感读取和控制操作 503/fail-closed；停止领取任务 |
| Redis 不可用 | 正确性不变；all/worker 降级；split api/gateway readiness 与交互 RPC fail closed |
| Redis 被清空 | cache/limit 自动重建；不丢命令、锁、权限、quarantine、route |
| VM 不可用 | 控制面可用；指标查询明确不可用；vmagent 排队 |
| vmagent 不可用 | 指标快速失败/丢弃并计数；控制面与 WS 不阻塞 |
| Gateway 崩溃 | lease 到期重发；新 session generation 接管 |
| Worker 崩溃 | `SKIP LOCKED` 行锁释放，队列由其他 Worker 继续 |
| 旧 Gateway 延迟 close | generation 条件更新不能下线新 session |

## 8. 部署与运维

默认 Compose：

- PostgreSQL：耐久卷、健康检查、独立凭据；
- Redis：内存限制、`noeviction`、ACL、关闭 AOF/RDB、跨主机使用 TLS；
- vmagent：独立持久队列卷；
- VictoriaMetrics Single：显式 retention（默认 30d）、独立卷；
- Backend：默认 `runtime.role=all`；
- 5432、6379、8428、8429 只在内部网络，不公开公网。

备份：

- PostgreSQL：WAL archive + 每日 base backup + `pg_verifybackup` + 定期 PITR 演练；
- VM：snapshot + vmbackup 到异故障域，恢复演练；
- Redis：不备份，因为必须可重建。

演进触发：

- API/Gateway/Worker 只有测得独立扩缩需求才分进程；
- split role 生产 Redis 使用托管 HA 或经过演练的 Sentinel/failover；
- PostgreSQL 优先托管 HA，自建 failover 必须有 fencing；
- VM Single 达到容量/SLO 边界才升级 Cluster。

## 9. 实施顺序

1. 冻结功能等价矩阵和 release E2E 入口；
2. 新 PostgreSQL pool、transaction、SQL migration 基础；
3. 按 IAM → Infra → Container → Workflow → Audit 纵切迁移 Repository；
4. 建 session generation、observation、reconcile queue；
5. 重构 command dispatch/result/finalizer 和 Agent idempotency；
6. 引入 Redis adapter，再逐项加入定址 RPC、wake、cache、limit；
7. 指标写入改到 vmagent，移除 DB 热路径；
8. 增加 role 装配与新 Compose；
9. 删除 TypeORM/SQLite/旧协调器和无用兼容代码；
10. 静态、单元、集成、故障注入和 Release E2E fail/fix 循环；
11. 独立审查和需求对账。

## 10. 架构验收不变量

- 关闭或清空 Redis 不改变任何授权和业务最终结果；
- 删除 VictoriaMetrics 数据不改变控制面事实；
- 每个业务事实只存在于一个 PostgreSQL canonical model；
- 每个物理资源同时最多一个 active claim；
- 每个 Server 同时最多一个 active physical command；
- 旧 session 永远不能覆盖新 generation；
- task result 在 acknowledgement 前已经耐久；
- 审计与其业务变更同事务；
- authorization mutation 不依赖最终一致缓存；
- E2E 所有现有功能场景在新 runtime 上表现等价。
