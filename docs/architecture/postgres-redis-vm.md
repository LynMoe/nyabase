# PostgreSQL + Redis + VictoriaMetrics

状态：当前产品架构  
对齐：`deploy/OPERATIONS.md`

## 1. 数据所有权

- **PostgreSQL** 是控制面唯一真相：IAM、授权、服务器、镜像、容器、存储池、卷、IP 池、共享后端、intent、reconcile claim、审计、系统设置。PostgreSQL 不可用时，控制变更与收敛必须停止，不能回退到 Redis。
- **Redis** 是可选加速：可丢的 wake、短 TTL 缓存、登录限流窗口。键可从 PostgreSQL 或活跃连接重建。默认 `runtime.role=all` 在 PostgreSQL 健康后即可启动；Redis 丢失不得改变授权或 intent 结果。生产 Redis 关闭持久化、使用 `noeviction`。
- **VictoriaMetrics** 是指标时序。vmagent 用有界磁盘队列 remote-write。VictoriaMetrics 或 vmagent 故障不得阻断控制面或 Incus 收敛。

默认交付是一个 Backend 进程，`runtime.role=all` 同时提供 HTTP API、SSH/HTTP proxy WebSocket 和 Worker。规模扩大后同一镜像可拆成 `api` 与 `worker`。`node-exporter`、`ssh-proxy`、`http-proxy` 是独立二进制，不是 Nest 进程角色。

## 2. 运行边界

```text
Browser / API client
        |
        v
Backend (api / worker / all)
        |                 | HTTPS + mTLS              | scrape (read-only)
        | SQL             v                           v
        +--------> Incus servers              node-exporter
        |
        +--------> PostgreSQL
        +--------> Redis (optional acceleration)
        +--------> vmagent -> VictoriaMetrics
```

Backend 直接用 HTTPS 互信证书调用每台 Incus。node-exporter 只提供只读节点指标，没有 Incus 变更能力。期望态、intent 和 reconcile claim 只写在 PostgreSQL。

Worker 比较 desired 与 observed，经 Incus API 幂等收敛。API 进程拥有 `/ws/ssh-proxy`、`/ws/http-proxy` 和 `/ws/console`。拆分 `api` 角色时 Redis 是就绪依赖；`all` / `worker` 把 Redis 当加速。

## 3. 失败表现

| 故障 | 必须表现 |
|---|---|
| PostgreSQL 不可用 | 控制变更与 reconcile fail-closed；`/api/health/ready` 失败 |
| Redis 不可用 | 正确性不变；`all`/`worker` 继续；仅拆分 `api` 的就绪检查要求 Redis |
| Redis 被清空 | cache/limit 重建；不丢 intent、授权、路由 |
| VictoriaMetrics 不可用 | 控制面可用；指标查询降级；vmagent 排队 |
| vmagent 不可用 | 指标有界丢弃并计数；控制面与 Incus 不阻塞 |

## 4. 部署要点

Compose 默认：PostgreSQL、Redis、vmagent、VictoriaMetrics Single、Backend（`runtime.role=all`）。应用端口 `3001`；VictoriaMetrics 仅回环 `127.0.0.1:8428`。PostgreSQL、Redis、vmagent 不向主机公开端口。

备份 PostgreSQL（WAL + base backup）和 VictoriaMetrics；Redis 不备份。
