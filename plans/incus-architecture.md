# nyabase on Incus —— Final 架构方案

状态：**实施指令**。本仓库未发布、无存量数据库，本次是 clean cutover。
兼容别名、旧路由、双执行路径、遗留迁移一律禁止。

本文档取代 `plans/incus-refactor.md`（那一版是「把现有架构移植到 Incus」；本版是
「按 Incus 的实际形态重新设计」）。差别不是修辞——最大的改动是**删除 nyabase Agent**，
详见 §4。

支撑调研全部在 `.codex/skills/harness/docs/incus-refactor/research/`：
`storage-domain.md`、`runtime-domain.md`、`access-domain.md`（现状测绘），
`incus-capabilities.md`、`incus-api-verification.md`、`agentless-feasibility.md`、
`bridged-nic.md`（Incus 能力，含大量源码级确认）。本文里标注「已确认」的结论都能在那里
回溯到 Incus 上游的具体函数。

---

## 1. 目标与非目标

### 1.1 目标

1. 运行时从 Docker 换成 Incus **系统容器**。
2. 存储完全改用 Incus 原生两套结构：**系统盘**（实例的 `root` disk device，创建时固定容量）
   与**数据盘**（custom volume，`content-type: filesystem`，固定配额、热插拔、可扩缩）。
3. 删除 nyabase 自己实现的本地磁盘 / 数据目录 / XFS project quota / 远程 FS 挂载体系。
4. 容器支持 nesting（容器内跑 Docker）与 NVIDIA GPU 直通。
5. 删除镜像的独立授权，镜像跟随服务器。
6. 容量双重约束：用户额度 + 池超分系数。
7. 容器在物理局域网拿到真实可路由 IP：`nictype=bridged` on 未托管 `vmbr`，控制面分配地址，worker 写入容器。**不使用 `nictype=routed`。**
8. **删除 Agent**；不为 Docker 保留任务派发。`ipv4.address` 是 nft 过滤身份；客户机地址由 guest exec 写入。

### 1.2 非目标

- 快照 / 备份 / 定时快照（Incus 原生支持，作为后续特性；容量模型为其预留位置）。
- Incus 集群（`incus cluster`）。拓扑仍是 N 台独立 standalone 主机 + 1 个控制面。
- Incus projects 多租户隔离。全部实例跑在 `default` project。
- 虚拟机。只做系统容器。
- OCI / Docker 镜像兼容。

---

## 2. 决策记录

与产品负责人逐条确认的结论，作为本方案不可再协商的输入。

### 2.1 架构

| # | 议题 | 决策 |
| --- | --- | --- |
| A1 | 部署拓扑 | 后端与服务器在同一可路由网络，**后端可直连每台服务器的 Incus HTTPS API** |
| A2 | nyabase Agent | **删除**。控制面直接调用各服务器的 Incus API（§4） |
| A3 | 宿主机采集器 | 保留一个**极小的只读采集器**，只上报 Incus 不提供的指标（GPU 使用率、宿主机负载）。**无控制权、无物理变更能力** |
| A4 | 收敛模型 | 后端持有期望态，worker 直接读实际态并收敛；保留**持久意图记录**以保证失败可见、可归因（§7） |
| A5 | 数据库迁移 | 直接重写 `000001_initial.sql` |
| A6 | Incus 客户端 | 自建瘦客户端：`openapi-typescript` 从官方 `rest-api.yaml` 生成类型 + Node HTTPS/TLS 客户端 + 操作 `wait` 助手（无可用的成熟 TS 客户端，官方只有 Go 绑定） |

### 2.2 网络

| # | 议题 | 决策 |
| --- | --- | --- |
| N1 | NIC 类型 | **`nictype=bridged`**，parent 是运维自建的**未托管** Linux 网桥（`vmbr0` / `vmbr100`）。产品**不**创建网桥、**不** `incus network create`、**不**使用 `nictype=routed` 或 macvlan。两种合法宿主布局见 §9.6。 |
| N2 | 地址 | Bridged **接受** `ipv4.address` 作为 **nft 过滤身份**（不是客户机配置）。控制面分配 IP（N4），worker 对运行中的实例 `exec` 写入 `ip addr`。DTO 字段 `routedIp` 是历史命名，表示已分配的局域网地址，**不是** routed NIC。 |
| N3 | 防伪 | nft `bridge` family：ARP sender / IPv4 saddr / MAC 绑定。claims + 排空窗口仍是集群级 IPAM 唯一性。**宿主机可以访问自己的客户机。** 宿主 IPv4 证明是任一宿主 iface 的 inet/global ∈ 绑定池 `cidr`（`preflight_host_ip_not_in_pool`），不要求地址必须在 `vmbr0` 上。Rogue DHCP 仍是已知缺口。 |
| N4 | IP 分配 | 控制面分配，沿用现有的 `container_network_claims` + 排空窗口 |
| N5 | 二层能力 | 容器是局域网上一等 L2 对等体（独立 MAC、ARP、广播）。**不因此打开容器内 DHCP。** 镜像必须 `network_managed_externally=true`；地址由控制面 `exec` 写入。禁止容器内 DHCP 客户端 / NetworkManager 冲掉该地址。 |
| N6 | 改 IP | **本版 UI 不提供。** Bridged 的过滤身份 `ipv4.address` **是**热更新字段；客户机仍需 `exec`。见 §9.8。 |

### 2.3 存储

| # | 议题 | 决策 |
| --- | --- | --- |
| S1 | 存储池生命周期 | **仅发现，不管理**。运维手工 `incus storage create`；控制面发现、登记、使用。nyabase 永不执行池级创建/删除 |
| S2 | 系统盘池 | 每台服务器指定一个。可以改，**只影响之后新建的容器**；已有容器记录自己实际所在的池 |
| S3 | 系统盘容量 | 用户创建容器时在授权额度内自选 |
| S4 | 容量约束 | 双重：① 用户在该服务器上所有盘（系统盘 + 本地数据盘）之和 ≤ 授权额度；② 单池上所有已声明容量之和 ≤ 池物理容量 × 超分系数（服务器级参数，管理员可调，默认 1.00） |
| S5 | 用户配额 | 单一 `disk_bytes`，系统盘与本地数据盘合并计入 |
| S6 | 数据盘池授权 | **保留**。管理员显式授权用户可在哪几个池上建卷（不同池介质/性能不同） |
| S7 | 远程 FS | **完全移除** NFS/CephFS 挂载器。共享存储由 Incus 原生池承载，运维直接在服务器上配置，带「共享」标识 |
| S8 | 共享池容量 | **独立核算、绑定用户、不计入服务器配额** |
| S9 | 共享卷跨服务器 | 允许，但**仅限 `cephfs` 驱动**（§3.4 是硬约束，不是偏好） |
| S10 | 卷共享 | 一个卷可同时挂到**同一用户**的多个容器 |
| S11 | 文件系统 | 块设备背书的池强制 **ext4**（xfs 完全不能缩容） |
| S12 | 扩缩容 | 扩容全在线；缩容能力按池驱动分族，由后端下发能力描述符，前端据此编排（§10.3） |
| S13 | 缩容编排 | **不做成后端复合事务**。后端只做能力判定与前置条件校验，「停容器 → 缩容 → 启容器」由前端引导 |

### 2.4 容器

| # | 议题 | 决策 |
| --- | --- | --- |
| C1 | 镜像模型 | **只用 Incus 原生系统镜像**。容器内跑 init，像轻量 VM。彻底删除 entrypoint/cmd/uid/init 这套 OCI 运行时覆盖语义 |
| C2 | 镜像分发 | 自建 **simplestreams 私有源**（纯静态文件 + HTTPS），各服务器添加为 remote 后按需拉取 |
| C3 | 镜像授权 | **删除**。有服务器授权 + 镜像在该服务器上 present + 镜像 active ⟹ 可用 |
| C4 | nesting | 所有容器默认 `security.nesting=true` |
| C5 | 容器内 Docker | 开启 `security.syscalls.intercept.mknod` + `.setxattr`；**坚决不开** `.mount.allowed`；容器保持 unprivileged |
| C6 | GPU 启用 | 按授权跟服务器：用户只有 CPU 授权、或服务器无 GPU，则不启用 `nvidia.runtime`；否则启用 |
| C7 | GPU 修改 | 卡只能在**停止状态**修改（`nvidia.runtime` 本身也不可热改） |
| C8 | GPU 选择 | 对用户暴露 nvidia index；内部一律翻译成 **PCI 地址**钉死（Incus 无 UUID 选择器，未设的选择器是通配符） |
| C9 | SSH 接入 | **镜像自带 sshd**，nyabase 只注入 `authorized_keys`。删除整套 dropbear 嵌入逻辑 |
| C10 | 规格热改 | CPU/内存**在线调整**，不断服 |
| C11 | 挂载热插拔 | 运行中直接加/减数据盘，不重启 |

### 2.5 工程

| # | 议题 | 决策 |
| --- | --- | --- |
| E1 | grant-expiry | 已于 `d594a15` 单独提交；本次保留并适配（「清理 datadir」→「清理 incus 卷」） |
| E2 | e2e | 完整覆盖：宿主机装 incus + 预建两种能力族的池 + unmanaged `vmbr`（布局 A/B）+ 私有镜像源；`features.yaml` 重写 |

---

## 3. Incus 物理约束

**这一节是所有设计的硬边界，不可绕过。** 全部来自源码级确认，出处见
`incus-capabilities.md` 与 `incus-api-verification.md`。

### 3.1 扩缩容按驱动分两族

所有驱动共用入口 `SetVolumeQuota(vol, size, ...)`；root disk 与 custom volume 走同一条路。
**扩缩容能力是驱动的属性，不是卷角色的属性。**

| 族 | 驱动 | 机制 | 在线缩容 |
| --- | --- | --- | --- |
| **QUOTA_ONLINE** | `dir`、`btrfs`、`zfs`(dataset)、`cephfs` | 只设一个配额数字（project quota / qgroup / `zfs quota=` / `ceph.quota.max_bytes`） | **可以**，瞬时，无任何挂载检查 |
| **BLOCK_BACKED** | `lvm`(thin/thick)、`lvmcluster`、`ceph`(RBD)、`zfs`(`block_mode=true`) | resize 块设备 + `resize2fs` | **不可以**，被 `MountInUse()` 拦住 |

**扩容对所有驱动都在线**，Incus 自己在宿主机跑 `resize2fs` / `xfs_growfs` /
`btrfs filesystem resize max`，容器内不需要做任何事。

### 3.2 两条必须由控制面自己实现的规则

Incus 不做这两件事，不做就会出事：

1. **配额下限** —— QUOTA_ONLINE 族接受「新配额 < 当前已用」，返回 200，
   结果是卷永久超配额、之后每次写入 `EDQUOT`。**控制面必须自己拒绝 `new < used`。**
2. **root disk 缩容的静默延迟** —— BLOCK_BACKED 族的 **root disk** 缩容，API 返回 **200**，
   `incus config show` 里新容量也显示了，实际只写了 `volatile.<dev>.apply_quota=true`，
   真正生效要等下次启动。**这是静默陷阱。** custom volume 没有这条延迟路径，
   直接返回 `ErrInUse`，反而更安全。

### 3.3 完整能力矩阵

**Root disk：**

| 驱动 | 扩容(运行中) | 缩容(运行中) | 缩容(已停止) |
| --- | --- | --- | --- |
| `dir` / `btrfs` / `zfs`(dataset) | 在线 | **在线** | 可以 |
| `lvm` / `lvmcluster` / `ceph` / `zfs`(block_mode) | 在线 | **静默延迟到下次启动** | ext4/btrfs 可以；**xfs 永不可以** |
| `cephfs` | — | — | — （**不能做 root disk**） |

**Custom `filesystem` 卷：**

| 驱动 | 扩容(挂载中) | 缩容(挂载中) | 缩容(已卸载) |
| --- | --- | --- | --- |
| `dir` / `btrfs` / `zfs`(dataset) / `cephfs` | 在线 | **在线** | 可以 |
| `lvm` / `lvmcluster` / `ceph` / `zfs`(block_mode) | 在线 | **`ErrInUse` 报错** | ext4/btrfs 可以；**xfs 永不可以** |

`block` content-type 的卷**永远不能缩容**，且**根本不能挂到容器上** —— 容器数据盘只能是
`filesystem` content-type。

### 3.4 共享池只有 cephfs 安全

| 拓扑 | 结论 |
| --- | --- |
| 两个 Incus 安装共用同一个 `ceph` OSD pool | **上游明确不支持**。双方都假设「完全控制该 OSD pool」，各自「可能删除」不认识的对象 |
| 同一 RBD `filesystem` 卷从两台主机读写挂载 | **必然损坏**。RBD 的 filesystem 卷是在 RBD 镜像上盖一层 ext4/xfs |
| 同一 `cephfs` 卷从多台主机挂载 | **安全**。CephFS 是真正的分布式 POSIX 文件系统，MDS 做锁仲裁 |

Incus 自己的排他检查是 `dbInst.Node != s.ServerName`，查的是 **Incus 集群数据库**。
两台 standalone 主机数据库互不可见，**这道保险在本拓扑下结构性失效**，不能依赖。
控制面必须自己把 `shareable` 硬限制为只有 `cephfs`；`Remote` 标志（来自
`environment.storage_supported_drivers[].Remote`）**不是**判据，它只表示「字节存在别处」。

### 3.5 配置与收敛

| 事实 | 后果 |
| --- | --- |
| **`PUT /1.0/instances/<n>` 是真替换**，跨 `config`/`devices`/`profiles`/`ephemeral`/`architecture`/`description` | 一个只含期望键的 PUT 会**摧毁 `volatile.*`** —— 光丢掉 `volatile.<nic>.hwaddr` 就会把每个容器的 MAC 悄悄换掉。**必须走「读回 → 改副本 → 带 `If-Match` 写回」**，或者用 `PATCH`（不需要删键时的安全默认） |
| `config` 的值**逐字节忠实回显**，但 map 本身不是（Incus 会注入自己的键） | 直接比对可行，但必须是**子集比对**，排除 `volatile.*` 与 `image.*` |
| **一次成功的 PUT 不等于生效**。非热改键被静默延迟到下次启动，API 里**没有 "restart required" 信号** | 触及非热改键前必须自己确认实例已停止，不能靠 Incus 报错兜底 |
| `limits.cpu` / `limits.memory` / `limits.processes` / `security.nesting` 等**几乎整个资源限额面都可热改** | C10 成立 |
| `security.privileged` / `nvidia.runtime` / `limits.memory.hugepages` **不可热改** | C7 成立 |
| `state.started_at` **存在** | 重启证明可用（§7.4） |
| Incus 操作只保留 **5 秒** | 「用操作 ID 重新挂接」不可行。崩溃恢复只能靠重读实际状态 |
| `GET /1.0/events` **尽力而为、无序、无重放**，消费者慢会被断开 | 事件只能当**唤醒提示**，绝不能当真相来源。必须配周期性全量对账 |

### 3.6 其它硬约束

| 约束 | 说明 |
| --- | --- |
| root disk 换池 | **禁止**。只能通过 `incus move` |
| `block.filesystem` | 创建后**不可改**，必须在池创建时定好（`volume.block.filesystem=ext4`） |
| `security.shifted` | 卷**使用中不可改**，必须**建卷时就设** |
| GPU 设备选择器 | `physical` 支持 `id`(DRM card)/`pci`/`vendorid`/`productid`，**没有 UUID 选择器**。未设的选择器是通配符，一个 `gpu` 设备可能匹配多张卡 —— **必须钉死** |
| 热卸载语义 | `umount2(MNT_DETACH)` 惰性卸载。**不会 EBUSY**，永远「成功」；容器内路径立刻消失，但持有 fd 的进程仍能继续写。**卸载成功 ≠ 没有写者** |
| 池扩容 | `incus storage set <pool> size=` **只对 loop-backed 池有效且只能增大**。真实块设备背书的池要在 Incus 之外用 `pvresize` 扩 |
| 池容量查询 | `GET /1.0/storage-pools/{name}/resources` → `{space:{used,total}, inodes:{used,total}}`。`GET /1.0/storage-pools/{name}` **只返回配置，没有用量** |
| API 异步 | 长操作返回 202 + `operation`，用 `GET /1.0/operations/{id}/wait` 而不是轮询 |

### 3.7 `security.shifted` 的选择

S10 允许一个卷同时挂到同一用户的多个容器。两种模式：

| 模式 | 机制 | 代价 |
| --- | --- | --- |
| `security.shifted=true` | **内核 VFS idmapped mount** | **≈ 0**。VFS 层按 inode 查找时翻译，无 I/O、无元数据改写、挂载瞬时完成，与卷大小无关 |
| 默认（`false`） | **递归 `chown` 遍历** | **O(文件数)**。百万 inode 的卷要几分钟元数据 I/O，且阻塞挂载 |

**决策：所有 custom volume 建卷时一律设 `security.shifted=true`。** 它性能更好，是唯一支持
隔离 idmap 的选项，而且「使用中不可改」意味着事后补设要从所有消费者卸载 —— 必须一开始就设。

---

## 4. 架构：删除 Agent，控制面直连

### 4.1 为什么可以删

Agent 存在的根本理由是 **Docker 的 API 没有认证**：它默认只在 unix socket 上，暴露到 TCP
等于把 root 交出去。所以每台宿主机上**必须**有一个受信任的东西。除此之外，Agent 还承担了
Docker 做不了的宿主机级工作：XFS project quota、`/etc/projects`、挂载表管理、dropbear 注入。

这两条理由在 Incus 下都不成立：

1. **Incus 本来就是一个远程管理守护进程。** HTTPS + TLS 客户端证书认证是它的一等公民形态，
   `incus remote add` 就是干这个的。exec、文件读写、事件流、硬件清单、存储池管理、
   镜像拉取全部可远程调用，与本地 unix socket 完全等价（已逐项源码确认）。
2. **那些宿主机级工作全部消失了** —— 配额是卷的 `size=` 属性，挂载是 disk device，
   SSH 密钥通过 `POST /1.0/instances/<n>/files` 注入。

已确认的两个关键点：
- **exec 的 websocket fd secret 在远程端点上同样可用**，交互式控制台不需要本地访问。
- **镜像由服务器自己从 simplestreams 源拉取**，不经过客户端代理字节。所以私有镜像源的
  分发模型（C2）在无 Agent 下原样成立。

### 4.2 拓扑

```
                        ┌─────────────────────────────────────┐
                        │  nyabase Backend (N 个同构副本)      │
                        │   API 角色    ─ REST / WS(前端)      │
                        │   Worker 角色 ─ 收敛引擎             │
                        │   PostgreSQL  ─ 期望态 + 意图 + 声明 │
                        └───┬──────────────────┬──────────────┘
              HTTPS + mTLS  │                  │  scrape
              GET /1.0/events (唤醒提示)        │
        ┌─────────────────┬─┴────────┐         │
        ▼                 ▼          ▼         ▼
   ┌─────────┐       ┌─────────┐  ┌─────────┐  ┌──────────────────┐
   │ incusd  │       │ incusd  │  │ incusd  │  │ nyabase-node     │
   │ :8443   │       │ :8443   │  │ :8443   │  │ (每台一个，极小)  │
   └─────────┘       └─────────┘  └─────────┘  └──────────────────┘
      服务器 1          服务器 2      服务器 3      只读指标，无控制权
```

SSH 代理与 HTTP 代理仍是独立进程，从后端拿快照 —— **完全不变**。

### 4.3 `nyabase-node`：残留的极小采集器

Incus 远程 API 覆盖不到的只剩两类东西：**宿主机 OS 的可观测性**，和**装机时的一次性配置**。
后者由运维/自动化装机流程负责，不需要常驻进程。前者需要一个采集器。

**它只做三件事，全是只读：**

| 采集项 | 为什么 Incus 给不了 |
| --- | --- |
| GPU 使用率、显存、温度、功耗，以及**按容器归属的显存占用** | Incus **完全没有任何 GPU 指标**（`MetricNames` 里没有一个 `gpu`）。`/1.0/resources` 只有静态硬件清单 |
| 宿主机 CPU 逐核利用率、PSI | `/1.0/resources` 只给 1/5/10 分钟负载均值与活动进程数，不区分 iowait/steal，也不按核数归一 |
| 磁盘 SMART / 设备级 I/O 延迟 | `/1.0/resources` 的磁盘信息只有型号/容量/WWN，没有健康度 |

**它明确不做的事**（这是设计约束，写进代码结构里）：

- 不接收任何任务，不持有任何期望态。
- 不调用 Incus 的任何变更端点 —— 它连 Incus socket 都不需要碰。
- 不管理容器、卷、挂载、配额、SSH。
- 出于最小权限，它不需要 root（`nvidia-smi` 与 `/proc` 只读即可）。

**它宕了会怎样**：图表缺一段数据。**不影响任何控制面功能** —— 容器照常创建、启停、
扩缩容。这是它与旧 Agent 最本质的区别：旧 Agent 是控制路径上的单点，`nyabase-node` 不是。

宿主机内存用量**不需要它** —— `/1.0/resources` 的 `memory.used`/`memory.total`（含 per-NUMA）
是可用的，直接从 Incus 读。

### 4.4 GPU 清单与指标的连接

`GET /1.0/resources` 给出每张卡的 **PCI 地址 ↔ GPU UUID ↔ nvidia device minor ↔ DRM card id**。

⚠️ **`nvidia-smi` 的枚举 index 不是其中任何一个。** `nvidia.card_name` 是
`/dev/nvidiaN` 的 device minor，不保证等于 nvidia-smi/CUDA 的序号（序号受枚举顺序和
`CUDA_DEVICE_ORDER` 影响）。因此：

- **控制面内部一律用 PCI 地址**作为 GPU 的主键。分配、授权、`gpu` 设备的 `pci=` 选择器全用它。
- 面向用户展示的「index」由 `nyabase-node` 上报的 `nvidia-smi` 输出提供
  （它同时给出 index、UUID、pci.bus_id），仅作展示与选择的人类可读标签。
- 指标按 **PCI 地址或 UUID** 与硬件清单 join，**绝不按 index join**。

⚠️ **另一个装机依赖**：`/1.0/resources` 的 GPU UUID / 驱动版本 / CUDA 版本字段依赖宿主机装了
`nvidia-container-cli`。没装则退化到只解析 `/proc`，丢失 UUID 与版本（PCI 地址与 DRM id
仍在，来自 sysfs）。而 `nvidia.runtime=true` 本来就硬依赖这个工具，所以「有 GPU 的服务器
必须装 NVIDIA container toolkit」是一条统一的装机前置条件，不是两条。

### 4.5 信任引导

一次性的服务器接入流程，取代现有的 agent token + host fingerprint 绑定：

```
运维在服务器上：
  1. incus config set core.https_address :8443      ← 必须先监听，否则无法签发 token
  2. incus config trust add --name nyabase          ← 输出一个一次性 token

管理员在 nyabase 面板：
  3. 新建服务器，粘贴 token 与地址
  4. 后端用自己的客户端证书 + token 调 POST /1.0/certificates 完成互信
  5. 后端立即 GET /1.0 验证连通与版本，GET /1.0/resources 拉硬件清单
```

**证书策略：一个客户端证书被所有服务器信任。** 不做 per-host 证书 —— 后端是单一信任主体，
per-host 证书只增加轮换复杂度而不增加安全性（任何一台被攻破，攻击者拿到的都只是那台的访问权，
而那台本来就已经沦陷）。证书与私钥存在后端的加密配置里，复用现有的 `system.settings` 加密机制。

⚠️ **证书过期是运维事故级风险**：客户端证书过期后，后端对所有服务器的访问同时失效，
而恢复需要**在每台服务器上本地 root 操作**。因此：
- 证书有效期设为 10 年。
- 后端在到期前 90 天开始在管理页持续告警。
- 轮换流程（新证书先被信任、再切换、再撤销旧证书）写进运维手册并做成面板向导。

### 4.6 与旧架构的对照

| 旧（Docker + Agent） | 新（Incus 直连） |
| --- | --- |
| 后端 ─WS→ Agent ─unix socket→ dockerd | 后端 ─HTTPS/mTLS→ incusd |
| Agent 无状态，后端投递不可变任务载荷 | 后端直接读实际态并收敛 |
| 至少一次投递 + 幂等 ensure + `task.accepted.v1` 排序屏障 | 不需要 —— 没有不可靠的任务投递环节 |
| agent session / generation / bootstrap / 就绪门 | 不需要 —— 没有会话概念 |
| 后端看不到宿主机，只能靠 Agent 上报；沉默即不确定 | **后端随时可以直接读** —— 不确定性大幅收窄 |
| 不确定性边界耗尽 → 隔离服务器 | 调用超时就重读一次实际状态 |
| 清单上报故障 → inventory 隔离 | 读到什么就是什么，读不到就是服务器不可达 |
| Agent 崩溃 = 该服务器全部操作停摆 | `nyabase-node` 崩溃 = 图表缺数据 |

**被删除的整套机制**：WebSocket 协议与信封、agent 准入/hello/bootstrap/就绪门、
会话代次栅栏、任务派发循环与准入等级、`task.execute/accepted/result`、
不可变载荷加解密、agent 侧任务去重与结果缓存、
`workflow.agent_sessions` / `agent_observations` / `agent_runtime_projections`、
inventory 隔离，以及旧 Agent 任务文档描述的整套故障模型。

### 4.7 这个架构的新风险，以及应对

诚实记录代价，不粉饰。

| 风险 | 应对 |
| --- | --- |
| **后端必须能入站访问每台服务器**（A1 已确认成立）。Incus **没有任何**让宿主机主动外连控制面的模式 | 这是架构前提，写进部署文档。若将来出现 NAT 后的服务器，只能上 VPN/隧道，不能靠改架构解决 |
| Incus API 暴露在网络上 | 只监听内网地址；mTLS 双向认证；防火墙限制源 IP 到后端网段 |
| 后端持有的证书等价于所有服务器的 root | 与旧 Agent token 同级的风险，不是新增。加密存储 + 审计所有变更调用 |
| 多个后端副本可能并发操作同一实例 | 双保险：① 后端自己的 per-resource 声明锁（PostgreSQL）；② Incus 自带 **per-instance 操作锁**（`internal/server/instance/operationlock`，覆盖 create/start/stop/restart/update/delete/migrate） |
| ⚠️ Incus 的锁冲突返回 **HTTP 500 而不是 409**，错误文本是 `Instance is busy running a "<action>" operation` | 客户端必须**按错误文本匹配**而不是按状态码，并且要检查**异步操作的 error 字段**而不只是 POST 的响应码 |
| ⚠️ Incus 的 per-instance 锁**没有超时**（源码里 `TimeoutDefault` 只存在于两句过期注释中，没有该常量也没有定时器）。一个卡住的操作会无限期持有实例锁 | 所有调用传入有界 context；观察到「实例长期 busy」时把该实例标为需要人工介入，不无限重试 |
| 每台服务器一条常驻事件 websocket | 事件只是唤醒提示（§3.5），断了不影响正确性，周期性全量对账是真相来源 |

---

## 5. 收敛引擎

取代旧的「不可变任务 + WebSocket 派发 + 无状态 Agent 执行 + finalizer」。

### 5.1 为什么不是纯 reconcile loop

既然后端能直接读 Incus，一个诱人的想法是只留一个周期性对账循环，删掉所有任务记录。
**不要这么做。** 旧架构最值钱的性质是「每一次变更都有一个持久的、有身份的、可问责的所有者」：
失败是可见的终态，用户能看到「我这次操作为什么没成」。纯 reconciler 的失败形态是
「它一直在重试」，既不可见也不可归因。

正确的做法是把**持久意图**保留下来，把**任务投递机制**删掉。前者是产品语义，后者是
Docker 时代的传输补偿。

### 5.2 三层结构

```
┌── 期望态 ──────────────────────────────────────────────┐
│  control.containers / volumes / volume_attachments     │
│  infra.image_server_assignments                        │
│  每个聚合根带 generation                                │
└────────────────────────────────────────────────────────┘
            ▲ 用户/管理员的写操作（一个事务内改期望态 + 建意图 + 唤醒）
            │
┌── 意图 ────────────────────────────────────────────────┐
│  control.intents                                       │
│  一行 = 一次可归因的用户请求                             │
│  pending → succeeded | failed，带结构化错误              │
└────────────────────────────────────────────────────────┘
            ▲ 收敛结果回写
            │
┌── 收敛 ────────────────────────────────────────────────┐
│  control.reconcile_claims  （租约式资源锁）              │
│  Worker：读期望 → 读实际 → 比对 → 施加 → 复验 → 结算      │
└────────────────────────────────────────────────────────┘
```

### 5.3 意图表

```sql
CREATE TABLE control.intents (
    id uuid NOT NULL,
    kind text NOT NULL,
    resource_type text NOT NULL,        -- container | volume | image_assignment
    resource_id uuid NOT NULL,
    server_id uuid,                     -- 共享卷为 NULL
    requested_by uuid,                  -- NULL = 系统发起（漂移修复、到期清理）
    request_json jsonb,                 -- 面向用户展示的请求摘要，非执行输入
    -- 执行输入取自期望态，不在这里快照。generation 用于识别已被更新意图取代的旧意图
    target_generation integer NOT NULL,
    -- restart 是唯一的事件式动作，需要一个基线（§7.4）
    baseline_json jsonb,
    status text DEFAULT 'pending' NOT NULL,   -- pending | succeeded | failed
    failure_code text,
    failure_json jsonb,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT intents_status_check CHECK (status = ANY (ARRAY['pending','succeeded','failed'])),
    CONSTRAINT intents_settled_shape_check
        CHECK (((status = 'pending') AND (settled_at IS NULL))
            OR ((status <> 'pending') AND (settled_at IS NOT NULL))),
    CONSTRAINT intents_failure_shape_check
        CHECK ((status <> 'failed') OR (failure_code IS NOT NULL))
);

CREATE INDEX intents_pending_idx ON control.intents (resource_type, resource_id)
    WHERE status = 'pending';
CREATE INDEX intents_retention_idx ON control.intents (created_at) WHERE status <> 'pending';
```

**与旧 `workflow.tasks` 的关键差别：执行输入不在意图里快照。**
旧设计必须把完整载荷冻结进任务，因为 Agent 拿不到别的东西。现在 worker 直接读期望态表，
所以意图只需要记住「谁、什么时候、要什么、结果如何」。这消除了一整类
「任务载荷与当前期望态不一致」的问题。

**同一资源上的多个 pending 意图**：允许存在（用户连点两次），但收敛是**面向期望态**的 ——
一次收敛会把该资源上所有 `target_generation <= 当前 generation` 的 pending 意图一起结算。
用户看到的是「两次请求都成功了」，而不是排队执行两遍。

### 5.4 声明（锁）

```sql
CREATE TABLE control.reconcile_claims (
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    placement_server_id uuid NOT NULL,
    server_id uuid,
    worker_id text NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (resource_type, resource_id, placement_server_id)
);
CREATE INDEX reconcile_claims_lease_idx ON control.reconcile_claims (lease_expires_at);
```

**按 (资源, placement 服务器) 声明。** 同一逻辑共享卷的两台 Incus catalog 可以并行收敛。
同一服务器上的多个容器并行仍安全 —— Incus 自己有 per-instance 操作锁做第二道保险。
只加一个**每服务器并发上限**（建议 8，按 `reconcile_claims.server_id` 计数），避免一台服务器被
后端打满。证书轮转使用哨兵 `placement_server_id` 且不计入上限。

**租约而不是永久锁。** 旧设计的锁没有租约、只由终态事务释放，因为 Agent 可能在执行中失联，
释放锁等于允许重叠的物理变更。现在 worker 死了，后端只要重读实际状态就知道发生了什么，
所以租约到期回收是安全的。租约 60 秒，worker 在长操作期间续租。

⚠️ 一个例外：**Incus 的 per-instance 锁没有超时**（已确认，源码里 `TimeoutDefault`
只存在于两句过期注释中）。一个卡在 incusd 里的操作会无限期持有实例锁。所以 worker 观察到
`Instance is busy running a "<action>" operation` 连续 N 次后，不再重试，而是把该容器标记为
`needs_attention` 并在管理页暴露 —— 这是需要人看的状况，不是可以退避重试的。

### 5.5 收敛循环

**触发源三种，优先级递减：**

| 触发 | 用途 |
| --- | --- |
| 意图创建（同事务内 NOTIFY / 内存唤醒） | 用户操作立即响应 |
| Incus 事件（`GET /1.0/events` per server） | 外部变化的快速感知。**只是唤醒提示** —— 事件尽力而为、无序、无重放，绝不作为真相来源 |
| 周期性全量扫描（每服务器，建议 60s） | **唯一的真相来源**。补齐丢失的事件、发现漂移、发现孤儿 |

**单个资源的收敛（以容器为例）：**

```
1. 取得声明（租约 60s）
2. desired = 读 control.containers + volume_attachments，构造完整期望文档
3. actual  = GET /1.0/instances/<name>            （一次调用拿到 config + devices + state）
4. 身份校验：user.nyabase.{managed,container_id,server_id} 必须匹配
              不匹配 → 不是我们的实例，走孤儿路径，绝不修改
5. diff = compareManagedFields(actual, desired)   （子集比对，排除 volatile.* / image.*）
6. 若 diff 非空：
     - 触及非热改键（nvidia.runtime / GPU 设备）且实例运行中 → 结算为 failed，
       结构化错误 GPU_CHANGE_REQUIRES_STOP。【不能靠 Incus 报错兜底：它会静默延迟到下次启动】
     - 否则：读回 actual 的完整 config → 在副本上应用 diff → 带 If-Match 的 PUT
       【绝不构造一个只含期望键的 PUT —— 那会摧毁 volatile.*，光丢 volatile.<nic>.hwaddr
         就会把每个容器的 MAC 悄悄换掉】
7. 电源状态：desired.power_intent vs actual.status，必要时 PUT .../state
8. verify：重新 GET，要求 compareManagedFields 为空、状态符合期望
9. 写回 observed_generation、observed 快照；结算所有 target_generation <= generation 的意图
10. 释放声明
```

**周期性全量扫描（每服务器一次）：**

```
GET /1.0/instances?recursion=2      → 所有实例的 config + devices + state，一次拿完
GET /1.0/storage-pools?recursion=1  + 每池 /resources
GET /1.0/storage-pools/<p>/volumes?recursion=1
GET /1.0/images?recursion=1
GET /1.0/resources                  → 硬件清单（CPU/内存/磁盘/GPU/网卡）

对账：
  期望有、实际无        → 建（或标记 failed，取决于生命周期阶段）
  期望无、实际有且 managed → 孤儿，删除
  期望无、实际有非 managed → 忽略（运维手建的，不归我们管）
  两边都有但配置不符      → 收敛
  存储池 / 硬件清单       → 更新登记行
```

`recursion=2` 让一台服务器的全部实例状态用**一次 HTTP 调用**拿到。这也是旧架构里
「权威全量上报」的替代物 —— 但它不再需要一个远端进程去采集、编码、通过一条可能中断的
websocket 送回来，也就不再需要「上报格式非法就隔离服务器」这类防御。

### 5.6 三态结果契约

保留现有的三态语义，它是好设计：

| 结果 | 含义 | 处理 |
| --- | --- | --- |
| **succeeded** | 复验通过，实际状态符合期望 | 结算意图，释放声明 |
| **failed（managed）** | 一次新鲜的探测证明了一个有类型、可寻址、可展示的失败状态 | 结算意图为 failed 并附结构化错误码，释放声明。**不自动回滚** —— 删除一个半成品会毁掉证据 |
| **retry** | 结果不明或是暂态（网络抖动、Incus 忙） | 保留声明租约，指数退避重试 |

**「结果不明」的场景比旧架构少得多。** 旧架构里 Agent 沉默 = 物理效果未知，只能等不确定性
边界耗尽再隔离服务器。现在调用超时只是「这次没读到」，**下一步就是再读一次**。
真正的 retry 只剩下：服务器不可达、Incus 忙、以及 Incus 返回了非确定性的 5xx。

有界退避后仍不收敛的资源标记 `needs_attention`，在管理页可见，不再自动重试。
**不再有「隔离整台服务器」这个动作** —— 一个容器卡住不该让同服务器的其他用户停摆。
服务器级只保留 `unreachable`（连不上）这一个状态，它是事实而不是惩罚。

### 5.7 崩溃恢复

| 切点 | 恢复 |
| --- | --- |
| worker 在读实际态前死 | 租约过期，另一个 worker 重新收敛。无副作用 |
| worker 在 PUT 之后、verify 之前死 | 租约过期，重新收敛：读实际态发现已符合期望，直接结算成功 |
| worker 在 PUT 发出、响应未回时死 | 同上。**这是关键改进** —— 旧架构此时物理效果未知，现在下一个 worker 直接读一次就知道了 |
| 后端整体重启 | 所有租约过期，扫描重新开始。期望态在 PostgreSQL 里，没有丢失 |
| 服务器重启 | 事件流断开、扫描发现实例状态变化；`power_intent=running` 的容器被重新启动 |
| Incus 升级/重启 | 同上。**不再有「Agent 启动时停掉所有容器」这种动作** |

**不再需要**：`task.accepted.v1` 排序屏障、agent 侧结果缓存、会话代次、不确定性边界、
inventory 隔离、bootstrap 就绪门。这些全部是「后端看不见宿主机」的补偿。

---

## 6. 领域模型

### 6.1 概念

| 概念 | 定义 | 承载 |
| --- | --- | --- |
| **服务器** | 一台跑 Incus 的主机，后端通过 mTLS 直连它的 API | `infra.servers` |
| **存储池** | 服务器上的一个 Incus storage pool。运维手工创建，后端发现 + 登记 | `infra.storage_pools` |
| **共享后端** | 多台服务器上指向同一物理后端的一组 `cephfs` 池，合并成一个逻辑对象 | `infra.shared_backends` |
| **系统盘** | 实例的 `root` disk device，创建时固定容量 | `control.containers` 的字段 |
| **数据卷** | Incus custom volume（`filesystem`），固定配额，可挂到同一用户的多个容器 | `control.volumes` |
| **卷挂载** | 一个卷挂到一个容器的一个路径 | `control.volume_attachments` |
| **池授权** | 管理员授权用户/组可在某池上创建卷 | `iam.storage_pool_grants` |
| **共享后端配额** | 用户在某共享后端上的独立字节额度，不计入任何服务器配额 | `iam.shared_backend_grants` |
| **镜像** | 一条 simplestreams 别名的登记 | `infra.images` |
| **镜像分配** | 某镜像应出现在某服务器上（取代镜像授权） | `infra.image_server_assignments` |
| **意图** | 一次可归因的用户请求 | `control.intents` |

### 6.2 关系

```
infra.servers ──< infra.storage_pools >── infra.shared_backends   (仅共享池非空)
                        ├──< iam.storage_pool_grants >── iam.users / iam.groups
                        ├──< control.volumes >── iam.users
                        │        └──< control.volume_attachments >── control.containers
                        └──  control.containers.root_pool_id

infra.shared_backends ──< iam.shared_backend_grants >── iam.users / iam.groups
infra.images ──< infra.image_server_assignments >── infra.servers
iam.users / iam.groups ──< iam.server_grants >── infra.servers   (CPU/内存/磁盘/GPU/到期)
```

### 6.3 容量核算

三条独立约束，创建与扩容时全部要过。

**A —— 用户在服务器上的额度（S4①、S5）**

```
Σ (该用户在服务器 S 上所有容器的 root_size_bytes)
+ Σ (该用户在服务器 S 上所有【本地池】卷的 size_bytes)
≤ server_grants(user, S).disk_bytes        -- 0 = 不限
```

`lifecycle_phase ∈ {failed, deleting}` 的容器不计入 —— 失败的占位不阻塞重试。

**B —— 池的超分（S4②）**

```
Σ (该池上所有 root disk 的 root_size_bytes)
+ Σ (该池上所有卷的 size_bytes)
≤ pool.total_bytes × server.storage_overcommit_ratio
```

超分系数是**服务器级参数**，默认 `1.00`，作用于该服务器所有本地池。
`pool.total_bytes` 来自 `GET /1.0/storage-pools/<n>/resources` 的 `space.total`。

**C —— 共享后端额度（S8）**

```
Σ (该用户在共享后端 B 上所有卷的 size_bytes)
≤ shared_backend_grants(user, B).limit_bytes
```

共享后端上的卷**不进 A、也不进 B**。共享后端有自己的超分系数，因为它跨服务器。

**用声明容量而非实际用量核算**：LVM thin 允许超分，实际用量会涨；用声明容量才能给出
「创建时就保证兑现」的语义。实际用量另行采集，只用于展示与告警。

---

## 7. 数据库 schema

重写 `packages/backend/src/persistence-pg/migrations/000001_initial.sql`。
下面只列新增与改写；未提及的表（`audit.*`、`iam.users/groups/api_tokens/...`、
`interaction.*`、`system.settings`、`control.container_network_claims`、
`control.container_gpu_claims`、`control.container_ssh_routes`）保持现状。

### 7.1 删除的表

```
control.data_directories             → control.volumes
control.container_mounts             → control.volume_attachments
control.quota_desired                → 无（配额是卷自己的 size 属性）
iam.image_grants                     → infra.image_server_assignments
iam.mount_source_grants              → iam.storage_pool_grants
infra.remote_fs_mounts               → 无
infra.remote_fs_server_assignments   → 无
workflow.tasks / task_attempts       → control.intents
workflow.resource_claims             → control.reconcile_claims
workflow.agent_sessions              → 无（没有 agent，没有会话）
workflow.agent_observations          → 无
workflow.agent_runtime_projections   → 无
workflow.commands                    → 无（没有 WS 命令通道）
workflow.outbox                      → 无
workflow.server_execution_lanes      → 无（按资源声明，不按服务器排队）
workflow.reconcile_queue             → 无（周期扫描 + 事件唤醒取代队列）
iam.policy_state.next_numeric_user_id→ 无（XFS project id 分配器，不再需要）
```

`workflow` schema 整体消失。

### 7.2 `infra.servers` —— 改写

```sql
CREATE TABLE infra.servers (
    id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,

    -- 连接：取代 agent_token_hash + host_fingerprint
    api_endpoint text NOT NULL,                 -- https://host:8443
    server_cert_fingerprint text,               -- 首次连接时钉住，之后不变（TOFU）
    incus_version text,
    api_extensions text[],                      -- GET /1.0 的 api_extensions，用于能力门控

    -- 存储
    system_pool_id uuid,                        -- 新建容器的系统盘去哪个池（S2）
    storage_overcommit_ratio numeric(6,3) DEFAULT 1.000 NOT NULL,

    -- 网络（N1）
    parent_interface text,                      -- 宿主机物理网卡名，如 eno1（routed 的 parent）
    lan_cidr cidr,
    lan_gateway inet,
    lan_reserved_ips jsonb DEFAULT '[]'::jsonb NOT NULL,

    -- 能力（Agent 与 /1.0/resources 共同上报）
    gpu_runtime_available boolean DEFAULT false NOT NULL,   -- 宿主机有 nvidia-container-cli

    status text DEFAULT 'unknown'::text NOT NULL,   -- online | unreachable | unknown
    last_seen_at timestamp with time zone,
    last_error text,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT servers_slug_check CHECK ((slug = lower(slug)) AND (slug ~ '^[a-z0-9][a-z0-9_-]*$')),
    CONSTRAINT servers_status_check CHECK (status = ANY (ARRAY['online','unreachable','unknown'])),
    CONSTRAINT servers_overcommit_check
        CHECK ((storage_overcommit_ratio >= 1.000) AND (storage_overcommit_ratio <= 100.000)),
    CONSTRAINT servers_revision_check CHECK (revision > 0)
);
```

**删除**：`agent_token_hash`、`agent_config_fingerprint`、`quarantine_code`、
`quarantine_message`、`macvlan_*`（改名为 `lan_*`）。

**服务器不再有「隔离」状态。** 旧的 `agent_quarantined` 是「Agent 行为不可信，冻结整台机器」；
现在没有 Agent，服务器只有「连得上 / 连不上」。个别资源卡住用资源级的 `needs_attention`
表达，不牵连同服务器的其他用户。

`server_cert_fingerprint` 是 TOFU（首次使用即信任）：首次连接记下 Incus 的服务端证书指纹，
之后不匹配则拒绝连接并告警 —— 防止中间人替换服务器。

### 7.3 `infra.storage_pools` —— 新增

```sql
CREATE TABLE infra.storage_pools (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    incus_name text NOT NULL,
    driver text NOT NULL,
    -- 【缓存列】以下三个由 driver（+ zfs 的 volume.zfs.block_mode）推导。
    -- 唯一权威是代码里的能力表；这里落库只为查询与展示。每次扫描重算并纠正。
    resize_family text NOT NULL,          -- quota_online | block_backed
    root_disk_capable boolean NOT NULL,
    shareable boolean DEFAULT false NOT NULL,
    block_filesystem text,                -- quota_online 族为 NULL
    shared_backend_id uuid,
    total_bytes bigint,
    used_bytes bigint,
    quota_effective boolean,              -- dir 池在无 project quota 的 fs 上会静默忽略 size=
    display_name text,
    registered boolean DEFAULT false NOT NULL,
    last_observed_at timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT storage_pools_incus_name_check
        CHECK ((length(btrim(incus_name)) > 0) AND (incus_name !~ '[\000\r\n/]')),
    CONSTRAINT storage_pools_driver_check
        CHECK (driver = ANY (ARRAY['dir','btrfs','zfs','lvm','lvmcluster','ceph','cephfs'])),
    CONSTRAINT storage_pools_resize_family_check
        CHECK (resize_family = ANY (ARRAY['quota_online','block_backed'])),
    -- 强制 S11：块设备背书的池必须 ext4，否则永不可缩容
    CONSTRAINT storage_pools_shrinkable_fs_check
        CHECK ((resize_family <> 'block_backed') OR (block_filesystem = 'ext4')),
    -- 只有 cephfs 可共享（§3.4 是硬约束）
    CONSTRAINT storage_pools_shared_shape_check
        CHECK (((NOT shareable) AND (shared_backend_id IS NULL))
            OR (shareable AND (driver = 'cephfs') AND (shared_backend_id IS NOT NULL))),
    CONSTRAINT storage_pools_root_capable_check
        CHECK ((NOT root_disk_capable) OR (driver <> 'cephfs'))
);

CREATE UNIQUE INDEX storage_pools_server_name_unique ON infra.storage_pools (server_id, incus_name);
```

### 7.4 `infra.shared_backends` —— 新增

```sql
CREATE TABLE infra.shared_backends (
    id uuid NOT NULL,
    name text NOT NULL,
    display_name text,
    -- 由池配置合成：cephfs:{cephfs.cluster_name}/{source}/{cephfs.path}
    identity_key text NOT NULL,
    -- Ceph FSID。Incus 不暴露，由管理员登记时带外填入。
    -- 这是唯一可靠的集群身份；identity_key 里的 cluster_name 只是本地配置文件名
    ceph_fsid text,
    total_bytes bigint,
    used_bytes bigint,
    overcommit_ratio numeric(6,3) DEFAULT 1.000 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT shared_backends_ceph_fsid_check
        CHECK ((ceph_fsid IS NULL) OR (ceph_fsid ~ '^[0-9a-f-]{36}$'))
);
CREATE UNIQUE INDEX shared_backends_identity_key_unique ON infra.shared_backends (identity_key);
```

**合并规则**：扫描发现 `driver=cephfs` 且能合成 `identity_key` 的池时，按 `identity_key`
查找已登记的共享后端并挂上去。`ceph_fsid` 若两边都非空且不等，**拒绝合并并告警** ——
这是防止两个不同 Ceph 集群都用默认 `cluster_name=ceph` 而被错误合并的唯一防线。

### 7.5 `control.containers` —— 改写

```sql
CREATE TABLE control.containers (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    image_id uuid NOT NULL,
    created_by uuid NOT NULL,
    name text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    observed_generation integer,

    -- 镜像：创建时钉死 fingerprint，别名事后移动不影响已建容器
    image_alias text NOT NULL,
    image_fingerprint text NOT NULL,

    -- 系统盘
    root_pool_id uuid NOT NULL,
    root_size_bytes bigint NOT NULL,
    -- BLOCK_BACKED 池上 root disk 缩容会静默延迟到下次启动（§3.2）。
    -- 竞态兜底：一旦下发缩容就写这里，直到观测到 volatile.root.apply_quota 为空才清掉
    root_size_pending_bytes bigint,

    -- 规格（可热改）
    cpu_millis integer DEFAULT 0 NOT NULL,
    mem_bytes bigint DEFAULT 0 NOT NULL,

    -- GPU：nvidia_runtime 不可热改，卡只能停机改
    nvidia_runtime boolean DEFAULT false NOT NULL,
    gpu_pci_addresses text[] DEFAULT '{}'::text[] NOT NULL,

    -- 安全开关（当前全局恒为 true，落库为将来可按容器降级留位）
    nesting boolean DEFAULT true NOT NULL,
    syscall_intercept boolean DEFAULT true NOT NULL,

    power_intent text DEFAULT 'running'::text NOT NULL,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    -- 由容器 uuid 确定性派生；入库是「后端认为自己绑定了哪个实例」的权威记录
    instance_name text,
    needs_attention boolean DEFAULT false NOT NULL,
    failure_code text,
    failure_reason text,
    last_transition_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    -- Incus 实例名规则：要能做 DNS 标签，不允许 . 和 _
    CONSTRAINT containers_name_check
        CHECK ((length(name) BETWEEN 1 AND 63) AND (name ~ '^[A-Za-z0-9][A-Za-z0-9-]*$')),
    CONSTRAINT containers_image_fingerprint_check CHECK (image_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT containers_root_size_check CHECK (root_size_bytes > 0),
    CONSTRAINT containers_cpu_millis_check CHECK (cpu_millis >= 0),
    CONSTRAINT containers_mem_bytes_check CHECK (mem_bytes >= 0),
    -- GPU 一律用 PCI 地址（§4.4）
    CONSTRAINT containers_gpu_pci_check
        CHECK (array_position(gpu_pci_addresses, NULL::text) IS NULL),
    -- 有卡就必须有 runtime
    CONSTRAINT containers_gpu_runtime_shape_check
        CHECK ((cardinality(gpu_pci_addresses) = 0) OR nvidia_runtime),
    CONSTRAINT containers_power_intent_check CHECK (power_intent = ANY (ARRAY['running','stopped'])),
    CONSTRAINT containers_lifecycle_phase_check
        CHECK (lifecycle_phase = ANY (ARRAY['provisioning','active','deleting','failed'])),
    CONSTRAINT containers_instance_name_check
        CHECK ((instance_name IS NULL) OR (instance_name ~ '^nyc-[0-9a-f]{32}$'))
);

CREATE UNIQUE INDEX containers_server_name_unique ON control.containers (server_id, name);
```

**相对现状删除**：`image_ref`、`image_default_uid`、`image_runtime_overrides`、`disk_bytes`、
`mounts_json`、`quota_paths`、`bound_runtime_id`、`runtime_spec_hash`、`active_task_id`、
`desired_generation`/`observed_generation` 的旧语义、`gpu_mode`/`gpu_indices`。

`lifecycle_phase` 少了 `updating` —— 收敛是持续的，没有「正在更新」这个稳态；
进行中的工作由 `control.reconcile_claims` 里有没有声明来表达。

**没有 `runtime_spec_hash`。** 它是纯 Docker 补偿：Docker 容器配置不可变、inspect 输出无法
回推创建规格，只能靠哈希判断「是不是我要的那个规格建出来的」。Incus 的配置可变且忠实回显，
直接子集比对严格更强 —— 哈希只说「不一致」，比对说「哪不一致」，而差异本身就是要写回的内容。

### 7.6 `control.volumes` / `control.volume_attachments`

```sql
CREATE TABLE control.volumes (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    pool_id uuid NOT NULL,
    server_id uuid,                  -- 本地卷；共享卷为 NULL
    shared_backend_id uuid,          -- 共享卷；本地卷为 NULL
    name text NOT NULL,              -- 用户可见名
    incus_name text NOT NULL,        -- nyv-<uuid32>，由 id 派生，永不复用
    size_bytes bigint NOT NULL,
    used_bytes bigint,               -- 扫描上报，用于展示与缩容下限校验
    generation integer DEFAULT 1 NOT NULL,
    observed_generation integer,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    needs_attention boolean DEFAULT false NOT NULL,
    failure_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT volumes_incus_name_check CHECK (incus_name ~ '^nyv-[0-9a-f]{32}$'),
    CONSTRAINT volumes_size_check CHECK (size_bytes > 0),
    CONSTRAINT volumes_lifecycle_check
        CHECK (lifecycle_phase = ANY (ARRAY['provisioning','active','deleting','failed'])),
    CONSTRAINT volumes_scope_check
        CHECK (((server_id IS NOT NULL) AND (shared_backend_id IS NULL))
            OR ((server_id IS NULL) AND (shared_backend_id IS NOT NULL)))
);

CREATE UNIQUE INDEX volumes_local_name_unique ON control.volumes (owner_id, server_id, name)
    WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX volumes_shared_name_unique
    ON control.volumes (owner_id, shared_backend_id, name) WHERE shared_backend_id IS NOT NULL;
CREATE UNIQUE INDEX volumes_incus_name_unique ON control.volumes (pool_id, incus_name);
```

`control.volume_placements.desired_present` is the only scan/reconcile authority for which Incus
catalogs must exist. Shared CephFS catalogs are grow-only until logical delete: scan extras must
**not** Incus-DELETE a `nyv-*` that still has a `control.volumes` row. Home (`volumes.pool_id`'s
server) is the only placement that may `RemoveAll` the directory, and only after every tracked
catalog reports empty `used_by`.

```sql
-- 挂载没有自己的状态机：它是容器期望设备集合的一部分，归容器的 generation
CREATE TABLE control.volume_attachments (
    id uuid NOT NULL,
    container_id uuid NOT NULL,
    volume_id uuid NOT NULL,
    device_name text NOT NULL,       -- nyd-<uuid32>，由 id 派生
    container_path text NOT NULL,
    read_only boolean DEFAULT false NOT NULL,
    -- 卸载后的排空窗口：在此之前拒绝把该卷挂到别处（§3.6 惰性卸载）
    detach_drained_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT volume_attachments_path_check
        CHECK ((container_path ~~ '/%') AND (container_path <> '/')
            AND (container_path !~ '[\000\r\n]')),
    CONSTRAINT volume_attachments_device_name_check CHECK (device_name ~ '^nyd-[0-9a-f]{32}$')
);

CREATE UNIQUE INDEX volume_attachments_path_unique
    ON control.volume_attachments (container_id, container_path);
CREATE UNIQUE INDEX volume_attachments_pair_unique
    ON control.volume_attachments (container_id, volume_id);
```

**所有权约束**（S10：卷只能挂到同一用户的容器）由 BEFORE INSERT/UPDATE 触发器强制：
`volumes.owner_id = containers.owner_id`；共享卷还要校验目标容器所在服务器**能看到**
该共享后端。

### 7.7 授权表

```sql
CREATE TABLE iam.storage_pool_grants (        -- 取代 iam.mount_source_grants
    id uuid NOT NULL,
    user_id uuid, group_id uuid,
    pool_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT storage_pool_grants_scope_check
        CHECK ((((user_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) = 1)
);

CREATE TABLE iam.shared_backend_grants (      -- 新增（S8）
    id uuid NOT NULL,
    user_id uuid, group_id uuid,
    shared_backend_id uuid NOT NULL,
    limit_bytes bigint DEFAULT 0 NOT NULL,    -- 0 = 不限
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT shared_backend_grants_scope_check
        CHECK ((((user_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) = 1),
    CONSTRAINT shared_backend_grants_limit_check CHECK (limit_bytes >= 0)
);
```

`shared_backend_grants` 带 `expires_at`，与 `d594a15` 的 grant 到期体系同构：
同样走 `classifyGrantExpiry` 的 live/grace/lost 三态与 `selectWinningGrantCandidate` 的
胜者通吃规则。

比旧 `mount_source_grants` 简单得多：不再需要 `source_kind` / `source_identity` 分支，
「防换盘」由 Incus 自己的池身份负责，池被运维删掉后 `last_observed_at` 停更即可识别。

### 7.8 镜像

```sql
CREATE TABLE infra.images (
    id uuid NOT NULL,
    name text NOT NULL,
    alias text NOT NULL,                    -- simplestreams 私有源上的别名
    fingerprint text,                       -- 别名当前指向的 fingerprint，扫描刷新
    description text,
    login_user text DEFAULT 'root'::text NOT NULL,   -- authorized_keys 注入到谁的家目录
    min_root_size_bytes bigint,             -- root disk 不得小于镜像 rootfs 解压体积
    -- routed 由 Incus 直接写入地址，镜像内若跑 DHCP 客户端/NetworkManager 会把它冲掉。
    -- 登记时校验并落库，创建容器时门控（§9.5）
    network_managed_externally boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    deleting boolean DEFAULT false NOT NULL,
    cleanup_generation integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT images_fingerprint_check
        CHECK ((fingerprint IS NULL) OR (fingerprint ~ '^[0-9a-f]{64}$')),
    CONSTRAINT images_login_user_check CHECK (login_user ~ '^[a-z_][a-z0-9_-]{0,31}$')
);

-- 取代 iam.image_grants：镜像跟随服务器，没有用户/组维度
CREATE TABLE infra.image_server_assignments (
    id uuid NOT NULL,
    image_id uuid NOT NULL,
    server_id uuid NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    observed_fingerprint text,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    needs_attention boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE UNIQUE INDEX image_server_assignments_unique
    ON infra.image_server_assignments (image_id, server_id);
```

**删除的字段**：`docker_image`、`runtime_overrides`（cmd/uid/init/entrypoint）、`disable_ssh`。
`disable_ssh` 不再需要 —— SSH 由镜像自带，不带 sshd 的镜像自然没有 SSH。

**授权语义**：用户能用某镜像 ⟺ 对某服务器有有效 server grant ∧ 该镜像在该服务器上
`lifecycle_phase = 'active'` ∧ `images.is_active`。没有第三张表。

`cleanup_generation` 保留：它解决「在 N 台服务器上删镜像，全部成功才能删 DB 行」，
与运行时无关。

### 7.9 `control.authorization_dependencies` —— 改写

撤销守卫用的依赖投影。旧的 `(source_kind, source_id, source_identity)` 换成池/后端引用。

```sql
CREATE TABLE control.authorization_dependencies (
    id uuid NOT NULL,
    dependency_kind text NOT NULL,       -- container | volume | volume_attachment
    dependency_id text NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid,                      -- 共享卷依赖为 NULL
    pool_id uuid,
    shared_backend_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT authorization_dependencies_shape_check
        CHECK (((dependency_kind = 'container')
                  AND (server_id IS NOT NULL) AND (pool_id IS NULL) AND (shared_backend_id IS NULL))
            OR ((dependency_kind <> 'container') AND (pool_id IS NOT NULL)
                  AND (((server_id IS NOT NULL) AND (shared_backend_id IS NULL))
                    OR ((server_id IS NULL) AND (shared_backend_id IS NOT NULL)))))
);
```

对应改写 `AccessRevocationGuardService`：
- 服务器授权撤销的拦截条件改为 `container` 或 `volume AND server_id IS NOT NULL`。
  **共享卷不绑服务器，所以不该拦住服务器授权的撤销** —— 这是有意的语义。
- `assertMountSourcesRevocationSafe` → `assertStoragePoolRevocationSafe`，按 `pool_id` 匹配。
- 新增 `assertSharedBackendRevocationSafe`。

---

## 8. 实例规格与身份

### 8.1 身份键

Incus 的 `user.*` 配置键（Incus 对该前缀不做解释，专供外部工具存元数据）取代 Docker label：

| 键 | 作用 |
| --- | --- |
| `user.nyabase.managed` | 区分 nyabase 实例与运维手建实例。**扫描时的孤儿判定完全依赖它** |
| `user.nyabase.container_id` | **改名检测器**。实例名由容器 UUID 确定性派生，理论上冗余；但运维手工 `incus rename` 之后，仅靠名字查找会把它判成孤儿并删掉用户的容器 |
| `user.nyabase.server_id` | 跨服务器栅栏，成本极低 |
| `user.nyabase.generation` | 检测「后端已推进到第 N 代，实例还在第 M 代」 |

**没有 spec hash**（§7.5）。

实例名 `nyc-<uuid去横线>`，卷名 `nyv-<uuid>`，设备名 `nyd-<uuid>`。确定性派生，永不复用，
36 字符，在 Incus 的 63 字符限制内。

### 8.2 期望文档

`instance-spec.ts` 是纯函数：给定容器行 + 挂载行 + 服务器行，产出完整期望文档。
它同时是「创建时 POST 什么」和「收敛时比对什么」的唯一来源。

```
POST /1.0/instances
{
  name: "nyc-<uuid32>",
  type: "container",
  source: { type: "image", fingerprint: "<钉死>", server: "<私有源>", protocol: "simplestreams" },
  config: {
    "limits.cpu":     "<cpuMillis/1000>",         // 热改
    "limits.memory":  "<memBytes>",               // 热改
    "security.nesting": "true",                    // C4，热改
    "security.syscalls.intercept.mknod":    "true", // C5
    "security.syscalls.intercept.setxattr": "true", // C5
    "nvidia.runtime": "<true|false>",              // C6，【不可热改】
    "user.nyabase.managed":      "true",
    "user.nyabase.container_id": "<uuid>",
    "user.nyabase.server_id":    "<uuid>",
    "user.nyabase.generation":   "<n>"
  },
  devices: {
    root: { type: "disk", path: "/", pool: "<系统盘池>", size: "<rootSizeBytes>" },
    eth0: { type: "nic", nictype: "bridged", parent: "<未托管 Linux 网桥，如 vmbr0>",
            name: "eth0",
            hwaddr: "<由容器 UUID 派生>",
            "ipv4.address": "<控制面分配的 IP，nft 过滤身份>",
            "security.ipv4_filtering": "true",
            "security.mac_filtering": "true" },    // §9.2
    "gpu0": { type: "gpu", gputype: "physical", pci: "0000:41:00.0" },
    "nyd-<uuid32>": { type: "disk", pool: "<池>", source: "<卷 incus_name>", path: "/data/foo" }
  }
}
```

### 8.3 比对规则

`compareManagedFields(actual, desired)` 只比对 **nyabase 管理的键**：
`limits.*`、`security.*`、`nvidia.*`、`user.nyabase.*`，
以及 devices 里的 `root` / `eth0` / `gpu*` / `nyd-*`。

**忽略 `volatile.*`、`image.*`，以及运维手工加的其它键与设备。**
这一条不是宽容，是必需：一个「期望文档即全部真相」的天真实现会抹掉运维加的东西，
并在每次对账时因为 Incus 注入的键而报假漂移。

⚠️ 比对必须在**归一化后的值域**上做。`config` 的值逐字节忠实回显，但要确认 Incus 是否会
把 `limits.memory: "1GiB"` 归一成字节数（§14 验证项）。

### 8.4 电源与重启

| 动作 | 实现 |
| --- | --- |
| start / stop | `PUT /1.0/instances/<n>/state {action}`；仅在状态不符时调用；复验 |
| **restart** | `state.started_at` **存在**（已确认），沿用现有的基线机制：意图创建时同步读一次 `started_at` 存进 `intents.baseline_json`；收敛时比对，相同则重启，不同且运行中则视为已满足；复验要求 `started_at` 已变且运行中 |

⚠️ **不能用「操作 ID 重新挂接」**：Incus 的操作只保留 **5 秒**，且不持久化结果。
基线机制是唯一可靠的重启证明。

### 8.5 GPU

- 控制面内部一律用 **PCI 地址**（§4.4）。`gpu` 设备用 `pci=` 钉死，**永不使用通配符**
  —— 未设的选择器是通配符，一个 `gpu` 设备可能匹配多张卡。
- 面向用户展示的 index 由 `nyabase-node` 的 `nvidia-smi` 输出提供，仅作人类可读标签。
- `nvidia.runtime` **不可热改**，GPU 设备变更**要求实例已停止**（C7）。
  收敛前必须自己确认已停止 —— **不能靠 Incus 报错兜底，它会静默延迟到下次启动**。
- 服务器无 `nvidia-container-cli` 时，开了 `nvidia.runtime` 的容器**根本起不来**。
  创建时用 `servers.gpu_runtime_available` 门控。

---

## 9. 网络

### 9.1 产品决策：未托管 bridged `vmbr`

**现行决策是 `nictype=bridged`，parent 为运维自建的未托管 Linux 网桥（PVE `vmbr0` 形态）。不使用 `nictype=macvlan` 或 `nictype=routed`。不 `incus network create`。**

`ipv4.address` 在 bridged 上是 **nft 过滤身份**，不配置系统容器的客户机地址。地址仍由控制面分配，
reconciler `exec` 写入容器。SSH/HTTP 代理可以跑在 Incus 宿主机上并 TCP 到客户机。

对照（选型调研，现行实施是 bridged 列）：

| 需求 | macvlan | ipvlan | **bridged（现行）** | routed |
| --- | --- | --- | --- | --- |
| 控制面指定静态 IP | ✗ 拒绝该选项 | ✓ | 仅作过滤身份；guest `exec` 写地址 | 真正写进容器 |
| 局域网其它主机可访问 | ✓ | ✓ | **✓** | ✓ proxy ARP |
| 宿主机能访问自己的容器 | ✗ | ✗ | **✓** | ✓ |
| 宿主侧防伪 | ✗ | ✗ | **✓ nft ARP/IPv4/MAC** | 结构性 + rp_filter + FIB |
| 需要 cloud-init 才有地址 | 需要 | 需要 | guest `exec`（不依赖 cloud-init） | 不需要 |
| 真 L2（广播、独立 MAC） | ✓ | 共享父 MAC | **✓** | ✗ |

**不使用 routed。** 用户要的是 PVE `vmbr` 的真 L2，不是 host proxy-ARP。

### 9.2 现行设备形态（bridged）

```
eth0: {
  type: "nic",
  nictype: "bridged",
  parent: "<未托管 Linux 网桥，如 vmbr0>",
  name: "eth0",
  hwaddr: "<由容器 UUID 确定性派生>",
  "ipv4.address": "<控制面分配的 IP>",
  "security.ipv4_filtering": "true",
  "security.mac_filtering": "true"
}
```

`ipv4.address` 是 nft allowlist 身份。控制面把地址记在 `container_network_claims` / DTO `routedIp`（历史字段名）。
容器 Running 后，reconciler `exec`：

```
ip link set eth0 up
ip addr replace <addr>/<prefix> dev eth0
ip route replace default via <gateway> dev eth0
```

**显式钉住 `hwaddr`**，不依赖 `volatile.<nic>.hwaddr`。`validateEth0` 对实际非 bridged NIC fail-close，不写 Incus（无转换器）。

### 9.3 防伪（现行）

nft `bridge` family 表 `incus`：`arp saddr ip`、`ip saddr`、`ether saddr` 绑定 claim IPv4 + 钉死的 MAC。
IPAM 唯一性仍靠控制面 claims + 排空窗口（N4）。宿主机可以访问自己的客户机。
Rogue DHCP 不被 `security.ipv4_filtering` 拦截，是已知缺口。
`nft` 缺失时 Incus 只打日志，过滤静默失效 —— 前置检查必须实证 `bridge_filter_address{address}`。


### 9.4 SSH 密钥注入（C9）

没有 cloud-init 之后，密钥注入只有一条路径，反而更简单：

```
创建 → 启动 → POST /1.0/instances/<n>/files 写 ~<login_user>/.ssh/authorized_keys（0600，属主正确）
     → 回读文件内容哈希确认
```

轮换走同一条路径。这是容器收敛里唯一一处「期望态不完全在 Incus 配置里」的地方，单独处理：
收敛不能只靠比对 config，还要读回文件哈希。

镜像不带 sshd 时，公钥注入成功但用户连不上。这必须是**可见状态**
（`key_applied_sshd_missing`）而不是静默失败。

### 9.5 DNS 与容器内网络配置

⚠️ **bridged 的 `ipv4.address` 只是过滤身份，不管 DNS。** 没有 cloud-init 也就没有人写
`/etc/resolv.conf`。两条路径：

| 方案 | 说明 |
| --- | --- |
| **镜像内置默认解析器**（推荐） | 私有镜像源里的镜像预置一个可用的内网 DNS。最简单，零运行时工作 |
| 创建后用 files API 写 `/etc/resolv.conf` | 与 SSH 密钥同一机制，服务器级可配置 DNS 地址。灵活但多一步 |

方案取**镜像内置 + 服务器级可覆盖**：`infra.servers` 增加可选的 `dns_servers`，
非空时在容器首次启动后连同 authorized_keys 一起写进去。

同样需要确认容器内的网络栈**不会覆盖控制面写入的地址**：若镜像里跑着 DHCP 客户端或
NetworkManager，它可能把 `exec` 配好的地址冲掉。私有镜像源里的镜像必须**禁用 DHCP 客户端**，
这是镜像的准入条件（`infra.images` 用一个 `network_managed_externally` 标记，登记时校验）。

### 9.6 运维前置

服务器接入前必须完成（与存储池同属「发现而非管理」的同一原则）。**网桥是运维前置，产品不创建。**

```
1. 原子创建未托管 Linux 网桥 vmbr0，二选一（见 deploy/OPERATIONS.md）：
   (A) PVE 经典：上联 slave 无 IPv4，宿主 IPv4 / 默认路由 / DNS 落在 vmbr0。
   (B) 专用容器 NIC：e1000/eth1 等上联挂在 vmbr0；桥和 slave 均无全局 IPv4；
       宿主 IPv4 留在非 slave 管理口（如 virtio eth0）。
   布局 A 必须在带外通道下把管理地址迁到桥上。布局 B 不要动管理口。
2. 确认 nft 可用（nft 在 PATH；node-exporter 需 CAP_NET_ADMIN 才能 list bridge 表）
3. 有 GPU 的机器：装 NVIDIA driver + nvidia-container-toolkit
4. incus config set core.https_address :8443
5. incus config trust add --name nyabase
6. 删除遗留 nyc-* / nyabase-preflight-* 再启动 worker（无 macvlan→bridged 转换器）
```

后端在服务器登记时**实证校验，永不改宿主机网络**：
- 读 `/1.0`、`/1.0/resources` 确认连通与硬件。
- `GET /1.0/networks/{parent}`：`type=bridge` 且 `managed=false`。
- 宿主 IPv4：任一宿主 iface 的 inet/global ∈ 绑定池 `cidr`（`preflight_host_ip_not_in_pool`）。
  不要求地址在 `vmbr0` 上。slave 上无全局 IPv4。
- **创建一个探针实例**（bridged + filtering），guest exec 写地址，guest ping 宿主，
  第二次 OpenMetrics pull 上 `bridge_filter_address{address=probe}`=1，然后删除。

不满足则在管理页明确指出缺哪一项和对应的宿主机命令，而不是让用户在创建容器时才撞墙。
产品**绝不**执行 `ip link` / netplan / `incus network create`。

### 9.7 IP 分配与回收

沿用现有机制（claims 表名保持不变）：

- `control.container_network_claims`：`UNIQUE (network_key, address)`，一个地址一个所有者。
- 分配：在创建事务内持 `pg_advisory_xact_lock('container-network:<cidr>')`，
  从「已声明 ∪ 实际观测到的 IP」的并集里取最低可用地址，跳过网关与保留地址。
  Incus 的 `ipv4.neighbor_probe` 是第二道保险，不是替代品 —— 它只在启动瞬间探测。
- 回收两阶段：删除时置 `releasing` + `reusable_at`（当前 360 秒 = SSH 代理快照陈旧上限 +
  时钟偏移 + 排空余量），到期后 GC。**这个排空窗口是代理租约的要求，Incus 不知道代理的存在**，
  必须保留。

### 9.8 IP 的可变性

Bridged 的过滤身份 `ipv4.address` **在 Incus `UpdatableFields` 里**，可以热更新 allowlist
而不 remove/add 设备。客户机地址仍然需要 `exec`；顺序风险仍在（旧地址会立刻从过滤集里消失）。
**本版 UI 不提供「改 IP」。** N6 不变。

理由不是技术上做不到，而是：
- 改 IP 会打断该容器上所有 SSH 会话与 HTTP 代理路由。
- 与旧架构一致（旧的 `assignedIp` 进 spec hash，改了就要重建）。
- 需要换网段的场景罕见，重建容器是可接受的答案。

数据模型上把它留成**可以后续放开**的形态：`container_network_claims` 支持一个容器换绑地址，
只是没有暴露入口。

## 10. 存储操作

### 10.1 池的发现与登记

后端扫描每台服务器时读 `GET /1.0/storage-pools?recursion=1` 与每池的 `/resources`，
推导能力，写进 `infra.storage_pools`。**未登记的池用户完全看不到**，不能在上面建任何东西。

推导规则（唯一权威在代码，落库只是缓存）：

```
resize_family      = driver ∈ {dir, btrfs, cephfs} ? quota_online
                   : driver == 'zfs' ? (volume.zfs.block_mode ? block_backed : quota_online)
                   : block_backed
root_disk_capable  = driver != 'cephfs'
shareable          = driver == 'cephfs'          ← 硬约束，见 §3.4，不是偏好
```

`dir` 池要额外探测 `quota_effective`：底层文件系统没开 project quota 时 Incus 会
**静默忽略 `size=`**，形成「无限容量」的假象。探测方式是读一个卷的
`GET .../volumes/<t>/<v>/state`，`usage` 为 null 即无效。**无效的 dir 池拒绝建卷并标红。**

### 10.2 卷的收敛

`volume.ensure` 的语义是「存在且大小恰好为 X」—— 创建与扩缩容是同一个收敛动作，
不需要单独的 resize 概念。

```
actual = GET /1.0/storage-pools/<p>/volumes/custom/<n>
不存在 → POST 建卷（size=、security.shifted=true）
存在且 size 相符 → no-op
存在且 size 不符 → 按 §10.3 收敛
```

**所有卷建卷时一律 `security.shifted=true`**（§3.7）。它「使用中不可改」，
事后补设要从所有消费者卸载 —— 必须一开始就设。

### 10.3 扩缩容

**扩容（所有驱动，在线）**：直接写新 size，回读确认。

**缩容 —— QUOTA_ONLINE 池**：
```
后端先校验 new_size >= 当前 used_bytes     ← §3.2 规则 1，Incus 不做这个检查
直接写新 size；回读确认；在线，无需停机
```

**缩容 —— BLOCK_BACKED 池**：后端**拒绝**下发，返回结构化前置条件错误，由前端引导（S13）。
```
数据卷：前置 = 该卷所有挂载均已移除
        不满足 → 400 VOLUME_SHRINK_REQUIRES_DETACH（附全部挂载点）
系统盘：前置 = 容器已停止（power_intent=stopped 且实际观测为已停止）
        不满足 → 400 ROOT_SHRINK_REQUIRES_STOP
```

**绝不把缩容请求透传给运行中的 BLOCK_BACKED root disk。** Incus 会返回 200 并静默延迟，
用户会以为成功了（§3.2 规则 2）。

**竞态兜底**：若后端判定时已停、收敛执行时已被启动，收敛的复验必须读
`volatile.root.apply_quota`：为空 = 真正落地；非空 = 写 `root_size_pending_bytes`，
由下一次启动收尾。`root_size_pending_bytes` 非空期间，容量核算（§6.3 约束 A/B）
**按较大值计**，避免账面已释放、物理未释放造成超卖。

### 10.4 能力下发

后端把每个池的能力描述符下发给前端，**前端不硬编码驱动表**：

```
capability: {
  growOnline: true,                                   // 所有驱动
  shrinkOnline:       resize_family == 'quota_online',
  shrinkRequiresStop: resize_family == 'block_backed' && block_filesystem in {ext4, btrfs},
  shrinkNever:        resize_family == 'block_backed' && block_filesystem == 'xfs',
  enforceUsageFloor:  resize_family == 'quota_online'  // Incus 不检查，我们检查
}
```

池的驱动是运维在宿主机上定的，前端不该知道 `lvm` 和 `dir` 的区别，
它只需要知道「这个池能不能在线缩」。

### 10.5 缩容的前端编排（S13）

后端只做能力判定与前置条件校验，编排在前端。三条路径：

```
shrinkOnline        → 直接改，唯一校验 new >= used（前后端双保险），无停机提示

shrinkRequiresStop  → 数据卷：弹窗列出所有挂载点，「需要先从这 N 个容器卸载」，提供一键卸载
                             完成后自动重试缩容，成功后询问是否挂回
                     系统盘：弹窗「需要先停止容器」，提供停止按钮
                             停止确认后执行缩容，成功后询问是否启动

shrinkNever         → 按钮禁用，tooltip 说明「该池使用 XFS，文件系统不支持缩小」
                     提示「可以新建更小的卷并迁移数据」
```

「一键卸载/停止」本质是前端连续调用已有的原子端点，**不是后端复合事务**。
中途失败时用户看到「卸载成功 3 个，第 4 个失败」这样的真实状态，而不是含糊的「操作失败」
—— 这正是选择前端编排的理由。

---

## 11. API 与前端

### 11.1 删除的端点

```
/mount-sources, /admin/mount-sources
/data-dirs, /admin/data-dirs
/admin/remote-fs-mounts (+ 服务器分配子路由)
/users/:id/image-grants, /groups/:id/image-grants     ← 镜像授权整体消失
/servers/:id/quota  (UserServerQuotaDto)              ← XFS project quota 概念消失
/agent-tasks, /admin/agent-tasks                      ← 没有 agent，没有 agent task
/admin/servers/:id/agent-token/rotate                 ← 没有 agent token
/admin/servers/:id/agent-quarantine/retry             ← 没有服务器隔离
```

### 11.2 新增的端点

```
GET    /servers/:id/storage-pools              # 用户视角：我能用的池
GET    /admin/servers/:id/storage-pools        # 管理员视角：含未登记的发现结果
PATCH  /admin/storage-pools/:id                # 登记 / 改显示名
PATCH  /admin/servers/:id                      # systemPoolId、storageOvercommitRatio、parentInterface
POST   /admin/servers/:id/connect              # 粘贴 trust token 完成互信（§4.5）
GET    /admin/servers/:id/preflight            # 前置检查：LAN 网桥/nftables 防伪/GPU toolkit/池/探针实例

GET    /admin/shared-backends                  # + POST / PATCH / DELETE
GET    /volumes                                # + POST / PATCH / DELETE
GET    /admin/volumes

POST   /containers/:id/volumes                 # 热挂载
DELETE /containers/:id/volumes/:attachmentId   # 热卸载
PATCH  /containers/:id/limits                  # 在线改 CPU/内存
PATCH  /containers/:id/root-size               # 扩缩系统盘
PATCH  /containers/:id/gpu                     # 改 GPU（要求已停止）

GET    /users/:id/storage-pool-grants          # 取代 mount-source-grants
GET    /users/:id/shared-backend-grants
GET    /containers/:id/intents                 # 该容器上的意图历史（取代任务历史）
```

**这五个改容器的端点内部都只改期望态 + 建一个意图。** 端点保持细分是为了让用户意图明确、
审计精确、前置条件可分别校验；但执行侧只有一条「收敛这个容器」的码路（§5.5）。
不要因为 REST 分了五个动词，就在收敛侧也分五种流程 ——
那是把 API 的表达粒度错当成执行粒度。

### 11.3 容量预检端点

前端提交前调用，避免用户填完表单才被拒：

```
GET /servers/:id/storage-capacity
→ { grantLimitBytes, usedByRootDisksBytes, usedByLocalVolumesBytes, availableBytes,
    pools: [{ poolId, displayName, driver, shareable, totalBytes, overcommitRatio,
              committedBytes, availableBytes, quotaEffective, capability: {...} }] }
```

### 11.4 结构化错误码

```
STORAGE_GRANT_EXCEEDED        { requestedBytes, availableBytes, grantLimitBytes }
STORAGE_POOL_EXHAUSTED        { poolId, requestedBytes, availableBytes, overcommitRatio }
STORAGE_POOL_QUOTA_INEFFECTIVE{ poolId }              # dir 池底层没开 project quota
SHARED_BACKEND_QUOTA_EXCEEDED { sharedBackendId, requestedBytes, availableBytes }
VOLUME_SHRINK_BELOW_USAGE     { volumeId, requestedBytes, usedBytes }
VOLUME_SHRINK_REQUIRES_DETACH { volumeId, attachments: [...] }
VOLUME_SHRINK_UNSUPPORTED     { volumeId, poolId, reason: 'xfs_cannot_shrink' }
VOLUME_DETACH_DRAINING        { volumeId, drainedAt }  # 排空窗口未过
ROOT_SHRINK_BELOW_USAGE       { containerId, requestedBytes, usedBytes }
ROOT_SHRINK_REQUIRES_STOP     { containerId }
ROOT_SIZE_BELOW_IMAGE_MINIMUM { imageId, requestedBytes, minimumBytes }
VOLUME_CROSS_SERVER_DENIED    { volumeId, serverId, reason: 'backend_not_reachable' }
GPU_CHANGE_REQUIRES_STOP      { containerId }
GPU_RUNTIME_NOT_ENABLED       { containerId }          # 建时未开，需重建
GPU_RUNTIME_UNAVAILABLE       { serverId }             # 宿主机没装 toolkit
IMAGE_MANAGES_OWN_NETWORK     { imageId }              # 镜像内跑 DHCP 客户端，会冲掉地址
SERVER_UNREACHABLE            { serverId, lastError }
INSTANCE_BUSY                 { containerId }          # Incus 实例锁冲突，需人工介入
```

### 11.5 前端

**删除**：`UserImageGrantsTab`（镜像×服务器矩阵，约 150 行）、`GroupImageGrantsTab`、
数据目录页、远程 FS 管理页、mount source 选择器、Agent 任务历史页、服务器隔离重试 UI。

`UserGrantsDialog` 的 tab 从
`effective | groups | overrides | image-grants | mount-source-grants | ssh | password`
变成
`effective | groups | overrides | storage-pools | shared-backends | ssh | password`。

**新增**：
- **服务器接入向导**：粘贴 token → 连通性检查 → 前置检查（LAN 网桥 / nftables 防伪 / GPU toolkit / 探针实例）
  → 池发现与登记 → 指定系统盘池。每一步的失败都给出具体的宿主机命令。
- **存储池管理**（服务器详情页新标签）：驱动、容量、已提交、超分后可用、能力标记
  （可否在线缩 / 可否做系统盘 / 是否共享 / 配额是否生效）。未登记的池灰色列出带「登记」按钮。
- **共享后端管理**：列出后端、被哪些服务器看到、容量、各用户额度。
  登记时要求填 Ceph FSID，两台服务器 `identity_key` 相同但 FSID 不同时**红色告警**。
- **数据卷页**：名称、所在池、大小、已用、共享标记、挂到哪些容器。新建/改名/扩容/缩容/删除。
- **容器详情页「存储」区**：系统盘（池、容量、已用、扩缩）；数据盘（已挂载列表 + 路径，
  **运行中直接加减，不提示重启**）。
- **容器详情页「规格」区**：CPU/内存滑块**在线生效不提示重启**；
  GPU 选择器**要求已停止**才可编辑；未开 `nvidia.runtime` 的容器提示需重建。
- **意图历史**：取代任务历史。每条显示发起人、时间、请求内容、结果、结构化错误。

---

## 12. 边界情况矩阵

### 12.1 收敛与故障

| 情况 | 行为 |
| --- | --- |
| worker 在调用 Incus 时超时 | **重读一次实际状态**。这是新架构最大的收益 —— 旧架构此时物理效果未知，只能等不确定性边界耗尽 |
| worker 在 PUT 之后、复验之前崩溃 | 租约到期，另一个 worker 重新收敛：读实际态发现已符合期望，直接结算成功 |
| 后端整体重启 | 所有租约到期，扫描重新开始。期望态在 PostgreSQL 里没有丢失 |
| 服务器不可达 | `servers.status = unreachable`，该服务器上的意图保持 pending 并退避重试。**不隔离、不失败** —— 连不上是事实不是惩罚 |
| Incus 返回 `Instance is busy running a "<action>" operation` | ⚠️ **HTTP 状态是 500 不是 409**，必须按错误文本匹配。退避重试；连续 N 次后标 `needs_attention` 并停止重试 —— Incus 的实例锁**没有超时**，卡住的操作会无限期持有 |
| Incus 事件流断开 | 无影响。事件只是唤醒提示，周期扫描是真相来源 |
| 事件丢失（消费者慢被断开） | 无影响。同上 |
| 服务器重启 | 扫描发现实例都停了；`power_intent=running` 的被重新启动 |
| Incus 升级/重启 | 同上。**不再有「Agent 启动时停掉所有容器」** |
| `nyabase-node` 宕掉 | 图表缺一段数据。**所有控制面功能正常** |
| 后端多副本并发操作同一容器 | 双保险：`reconcile_claims` 行级声明 + Incus 的 per-instance 操作锁 |

### 12.2 身份与漂移

| 情况 | 行为 |
| --- | --- |
| 实例缺 `user.nyabase.managed` | 不是我们的，**扫描完全忽略**，绝不修改 |
| 有 `managed` 但 `container_id` 在库里没有对应行 | 孤儿，删除 |
| 有 `managed` 但 `server_id` 不匹配 | 拒绝操作并告警。这是数据被跨主机复制的信号 |
| 运维手工 `incus rename` 一个托管实例 | 靠 `container_id` 识别为改名而非孤儿，**绝不因此删除用户容器**；收敛时改回期望名 |
| 运维在实例上手工加了无关设备或配置键 | `compareManagedFields` 忽略，**不判漂移、不抹掉** |
| 受管配置与期望不符 | **不是身份问题，不走清理**，走收敛改回来 |
| 用户在容器内改了网络配置 | 宿主侧过滤规则会让它完全不通（fail-closed）。这是正确方向 |

### 12.3 容量与配额

| 情况 | 行为 |
| --- | --- |
| 创建时超出用户额度 / 池超分余量 | 事务内拒绝，不创建任何行 |
| 并发创建，各自看够、合计超 | 容量校验在同一 serializable 事务内，对 `storage_pools` 行取 `FOR UPDATE`。后提交者回滚重试并看到新的已提交量 |
| 管理员调低超分系数或用户额度，导致已有容量超标 | **允许调低**，不回溯撤销。系统进入「超配」状态并在管理页标红；新增一律被拒直到降下来 |
| 池物理容量变化（运维扩/缩） | 下次扫描刷新 `total_bytes`，余量自动变化，可能立即进入超配 |
| 容器处于 `failed` / `deleting` | 不计入容量核算，失败的占位不阻塞重试 |
| `root_size_pending_bytes` 非空 | 容量核算取 `max(root_size_bytes, root_size_pending_bytes)` |
| `dir` 池底层没开 project quota | `quota_effective=false`，**拒绝在该池上建卷**并标红。否则 `size=` 被静默忽略 |

### 12.4 扩缩容

| 情况 | 行为 |
| --- | --- |
| 在线扩容（任何驱动） | 直接生效，Incus 自己在宿主机跑 `resize2fs`，容器内无感 |
| QUOTA_ONLINE 缩容到低于已用量 | **后端拒绝**（Incus 不拒绝，会让卷永久超配额、之后每次写 `EDQUOT`） |
| BLOCK_BACKED 缩容，卷仍挂在运行中容器 | 拒绝，列出全部挂载点 |
| 卷挂在两个容器上，只卸载了一个 | 仍然拒绝。宿主侧引用计数未归零，Incus 会返回 `ErrInUse` |
| BLOCK_BACKED root disk 缩容，容器运行中 | 拒绝。**绝不透传** —— 会静默延迟 |
| 竞态：判定时已停、执行时已启动 | 复验读 `volatile.root.apply_quota`；非空则写 pending，下次启动收尾 |
| xfs 池上请求缩容 | 前端按钮禁用；后端二次拒绝 |
| 缩容下发后用户又写满了卷 | Incus 的 `resize2fs` 失败 → managed failure，卷保持原容量，用户看到明确原因 |
| 扩容时 thin 池物理空间真的耗尽 | Incus 报错 → managed failure。这是超分 > 1 的固有风险，默认系数 1.0 把它变成显式选择 |

### 12.5 共享后端

| 情况 | 行为 |
| --- | --- |
| 两台服务器同 `identity_key` 同 FSID | 合并为同一共享后端，两台都能挂它上面的卷 |
| 同 `identity_key` 异 FSID | **拒绝合并 + 告警**。这是「两个不同 Ceph 集群都用默认 cluster_name」的唯一防线 |
| 运维配了 `ceph`(RBD) 而非 `cephfs` 的共享池 | `shareable=false`，只能当本地池。**不允许跨服务器挂载** —— RBD 的 filesystem 卷跨主机读写必然损坏（§3.4） |
| 共享卷挂到看不到该后端的服务器 | 事务内拒绝 |
| 共享卷同时挂在两台服务器的容器上 | **允许**（仅 cephfs）。CephFS 有 MDS 仲裁 |
| 某服务器上的共享池被运维删除 | 该服务器的池行标记 missing；该服务器上对该后端卷的挂载失败；**后端与卷都不删**（其它服务器还看得到） |
| 所有服务器都看不到某共享后端 | 保留并标记不可达。删除需管理员显式操作 |
| 共享后端额度用完 | 不影响用户在任何服务器上的本地额度（S8） |

### 12.6 卷挂载

| 情况 | 行为 |
| --- | --- |
| 运行中热挂载 | 直接生效，容器内立刻出现挂载点 |
| 运行中热卸载，容器内有进程正在写 | **不会 EBUSY**。`MNT_DETACH` 惰性卸载：路径立刻消失，但持有 fd 的进程**仍能继续写入真实存储**。**卸载成功 ≠ 没有写者** |
| 卸载后立刻挂到另一个容器 | **拒绝**，`VOLUME_DETACH_DRAINING`。`detach_drained_at` 排空窗口内不允许重新挂载 |
| 挂载路径冲突 / 重复挂同一卷 | DB 唯一索引拒绝 |
| 卷属主与容器属主不同 | 触发器拒绝 |
| 删除卷时仍有挂载 | 拒绝，须先全部卸载 |
| 删除容器时仍有挂载 | 挂载行级联删除；**卷本身保留**（数据不随容器消失，这是数据盘的意义） |

### 12.7 容器与镜像

| 情况 | 行为 |
| --- | --- |
| 镜像内跑着 DHCP 客户端或 NetworkManager | 会把 Incus 写入的地址冲掉。登记时校验 `network_managed_externally`，创建时拒绝 `IMAGE_MANAGES_OWN_NETWORK` |
| 系统盘小于镜像 rootfs 体积 | 用 `min_root_size_bytes` 预校验 |
| 管理员改服务器系统盘池 | 只影响之后新建的容器；已有容器 `root_pool_id` 不变。**Incus 禁止 root disk 换池** |
| 镜像别名被移到新版本 | 已有容器钉的是 fingerprint，不受影响；新建容器用新 fingerprint |
| 镜像在某服务器上还没拉下来 | 创建前置条件不满足，拒绝 |
| 镜像不带 sshd | 公钥注入成功，SSH 状态 `key_applied_sshd_missing`，前端显式提示。**不是静默失败** |
| 容器重建后 SSH 主机密钥变化 | 主机密钥由容器内 sshd 自己生成，SSH 代理层与前端需提示指纹已变 |
| 用户想给建时未开 `nvidia.runtime` 的容器加卡 | 拒绝，`GPU_RUNTIME_NOT_ENABLED`，提示需重建 |
| 服务器没装 nvidia-container-toolkit 但容器要开 `nvidia.runtime` | 创建时用 `gpu_runtime_available` 门控拒绝。否则容器根本起不来 |
| 用户想改容器 IP | **不提供**。IP 是不可变属性（§9.3），需换网段就重建 |

### 12.8 网络安全

| 情况 | 行为 |
| --- | --- |
| 容器伪造源 IP 发包 | 宿主侧 nftables 丢弃 |
| 容器 ARP 声称别人的 IP | 宿主侧丢弃（匹配 ARP sender protocol address，请求应答都覆盖） |
| 容器伪造 MAC | 宿主侧丢弃 |
| 容器发 Q-in-Q / 非 IP L2 帧 | 宿主侧丢弃 |
| **容器内起流氓 DHCP 服务器** | **不是问题**。routed 没有共享 L2 域，容器发的 DHCP 响应到不了任何别的容器 |
| 某个 NIC 漏设 `ipv4.address` | **等于完全不过滤**（`allowedIPNets` 返回 nil 放行一切）。没有中间态 —— 收敛必须保证每个 NIC 都设，并在扫描时校验 |

### 12.9 授权

| 情况 | 行为 |
| --- | --- |
| 撤销服务器授权，用户还有容器或本地卷 | 拒绝 |
| 撤销服务器授权，用户只有**共享卷** | **允许**。共享卷不绑服务器 |
| 撤销池授权 / 共享后端授权，用户还有卷 | 拒绝 |
| server grant / shared backend grant 到期 | 沿用 `d594a15` 的 grace 期 + 停容器 + 清理资源，「清理 datadir」换成「清理 incus 卷」 |
| 用户对某镜像没有授权 | **这个概念不存在了** |

---

## 13. 删除清单

### 13.1 整个 Agent 包

`packages/agent/` **整体删除**（约 15k 行含测试），替换为一个新的极小包
`packages/node-exporter/`（只读指标采集，§4.3，预计 <1k 行）。

### 13.2 数据库

```
control.data_directories, container_mounts, quota_desired
iam.image_grants, iam.mount_source_grants
infra.remote_fs_mounts, remote_fs_server_assignments
workflow.*                                    ← 整个 schema
iam.policy_state.next_numeric_user_id
control.containers 的 image_ref / image_default_uid / image_runtime_overrides /
                      disk_bytes / mounts_json / quota_paths / bound_runtime_id /
                      runtime_spec_hash / active_task_id / gpu_mode / gpu_indices
infra.servers 的 agent_token_hash / agent_config_fingerprint / quarantine_*
```

### 13.3 Backend

```
src/agent-tasks/         整个目录（派发、准入、finalizer 注册表、载荷编解码）
src/gateway/             整个目录（agent WS 网关，约 4000 行）
src/datadirs/            整个目录
src/mount-sources/       整个目录
src/remote-fs/           整个目录
src/nfs/                 空目录
src/quota/               整个目录
src/runtime/             重写为收敛引擎
src/storage/             重写为 Incus 存储仓储
groups.service.ts        约 200 行镜像授权 CRUD + 批量同步
access-resolver.service.ts   UserCache.imageGrants
servers.service.ts       image_grants 依赖探测、agent token 轮换、隔离重试
catalog/admin-catalog.controller.ts  GET /admin/catalog/grant-images
```

### 13.4 Common

```
protocol/agent-messages.ts   整个文件（agent WS 协议不存在了）
protocol/ws.ts               agent 部分（前端 WS 保留）
enums.ts        AgentTaskKind、AgentTaskStatus、RuntimeDriftKind、DockerDaemonState、
                RemoteFsType、ServerStatus 的 agent_* 值；
                AuditAction 的 UpsertImageGrant/DeleteImageGrant/CreateDataDir/DeleteDataDir/
                CreateRemoteFsMount/.../UpsertMountSourceGrant/RotateServerAgentToken/
                RetryAgentQuarantine/AddDataDisk/RemoveDataDisk
constants.ts    LABEL.*、NYABASE_NETWORK、XFS_PROJECT_ID_OFFSET、
                MAX_AGENT_LOCAL_DATA_SOURCES、MAX_AGENT_REMOTE_FS_MOUNTS、
                MAX_AGENT_XFS_PROJECTS、MAX_MANAGED_DATA_DIRS_PER_AGENT、
                MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE、MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION、
                以及全部 agent 任务准入/队列上限常量
utils.ts        normalizeDockerImageRef
protocol/rest*  MountSourceDto、DataDirDto、UserDataDirDto、DataDirIssueDto、
                ImageGrantDto、MountSourceGrantDto、UserServerQuotaDto、AgentTaskDto
```

⚠️ 删完 common 的东西后必须跑：
```bash
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```
Vite 会优先解析同名 `.js` 而不是 `.ts`，残留编译产物会造成难以诊断的运行时错误。

### 13.5 文档

旧 Agent task execution 文档**整体作废并删除**。它描述的是「无状态 Agent + 至少一次投递」的
故障模型，新架构里这个模型不存在。收敛语义以本文 §5 为唯一依据，本次不新增单独替代文档。

---

## 14. 分阶段交付

每阶段结束时仓库必须可 typecheck、可测、语义自洽。不允许中间态双路径。

**阶段 0 —— 实机验证（不可跳过）**
0. 在一台装了 Incus 的真机上跑完 §15 的验证清单。**第 1、2 项是架构级阻塞项。**

**阶段 1 —— common 协议层**
1. 重写 `enums.ts`、`constants.ts`；删除 `protocol/agent-messages.ts`。
2. 重写 `protocol/rest.ts` / `rest-schema.ts`。
3. 此时后端与 agent 大面积编译失败 —— 这是预期的，作为后续阶段的工作清单。

**阶段 2 —— 数据库**
4. 重写 `000001_initial.sql`（含 `workflow` schema 的整体移除）。
5. 重写 Kysely 类型。`pnpm check:backend-bootstrap` 必须过。

**阶段 3 —— Incus 客户端**
6. `openapi-typescript` 生成 `api-types.ts`（纳入版本管理）。
7. 实现 HTTPS/mTLS 客户端、操作 `wait` 助手、错误映射（含 `Instance is busy` 的文本匹配）、
   事件订阅。**全部写单测，用录制的响应做 fixture。**
8. 实现 `instance-spec.ts`（纯函数）与 `compareManagedFields`。这两个是收敛的核心，先测后用。

**阶段 4 —— 收敛引擎**
9. `control.intents` / `reconcile_claims` 的仓储与租约管理。
10. 容器 / 卷 / 镜像分配三个收敛器。
11. 周期扫描 + 事件唤醒。
12. 服务器接入与前置检查。

**阶段 5 —— 领域服务**
13. 新建 `storage-pools`、`shared-backends`、`volumes` 模块；删除 `datadirs`、`mount-sources`、
    `remote-fs`、`nfs`、`quota`、`agent-tasks`、`gateway`。
14. 重写容器创建准入（容量三约束、镜像 fingerprint、镜像网络门控、GPU 门控、IP 分配）。
15. 重写撤销守卫与访问解析。

**阶段 6 —— 前端**
16. 删除镜像授权 UI、数据目录 UI、远程 FS UI、Agent 任务页。
17. 新增服务器接入向导、存储池管理、共享后端管理、数据卷页、容器存储/规格区、意图历史。

**阶段 7 —— node-exporter 与 e2e**
18. `packages/node-exporter/`。
19. e2e 环境改造 + `features.yaml` 重写。
20. `pnpm check` 全绿 + common `src/` 洁净检查。

**阶段 3–6 可并行**：common 协议冻结后，「Incus 客户端 + 收敛引擎」「领域服务」「前端」
三条线各自对着已冻结的协议开发。阶段 1–2 是唯一的串行瓶颈。

---

## 15. 测试策略

### 15.1 收敛的核心测试

`compareManagedFields` 与 `instance-spec` 是纯函数，**必须有详尽的单测**，它们是全系统的枢纽：

```
compareManagedFields:
  · 完全一致 → 空 diff
  · volatile.* 不同 → 空 diff（必须忽略）
  · image.* 不同 → 空 diff
  · 运维手工加的键/设备 → 空 diff（不判漂移，不抹掉）
  · 受管键不同 → 精确 diff
  · 归一化：limits.memory "1GiB" vs "1073741824" → 空 diff
```

收敛器的幂等性（对同一实际状态执行两次都安全）：

```
容器收敛  · 已收敛时不发出任何 PUT
          · 【关键】PUT 之后 volatile.* 仍在、运维手工加的键仍在
          · 触及非热改键且实例运行中 → 结算 failed，不静默延迟
          · 加设备 + 减设备在同一次收敛里都生效
          · 崩溃窗口不产生两个带同一 container_id 的实例
          · 每个 NIC 都带 ipv4.address（漏设 = 完全不过滤）
卷收敛    · 不存在则建；size 相符则 no-op；不符则收敛到期望
          · 重复缩容不累积；BLOCK_BACKED 的延迟路径被识别
镜像收敛  · 重复拉取不重复下载；fingerprint 不符是 managed failure
```

`volatile.*` 那条是**回归防线**：一个天真的「PUT 期望文档」实现会摧毁它，
光丢掉 `volatile.<nic>.hwaddr` 就会把每个容器的 MAC 悄悄换掉。

### 15.2 容量核算（PostgreSQL 测试）

```
并发创建两个容器，各自看够、合计超       → 恰好一个成功
并发扩容两个卷，合计超池超分余量          → 恰好一个成功
超分系数调低到已有容量之下                → 已有资源不动，新增被拒
root_size_pending_bytes 非空时按较大值核算
共享池上的卷不进服务器核算，也不进池核算
```

### 15.3 能力矩阵

对每种 `resize_family` × 每种前置状态各一条：

```
quota_online + 运行中 + new >= used  → 成功，在线
quota_online + 运行中 + new <  used  → 后端拒绝（Incus 不拒绝，这条测的是我们自己的守卫）
block_backed + 运行中 + 数据卷       → VOLUME_SHRINK_REQUIRES_DETACH
block_backed + 运行中 + 系统盘       → ROOT_SHRINK_REQUIRES_STOP，且【绝不】发出 Incus 请求
block_backed + 已停止 + ext4         → 成功
block_backed + xfs                   → 该池根本登记不进来
```

### 15.4 授权与共享后端

```
有本地卷    → 拒绝撤销服务器授权
只有共享卷  → 允许撤销服务器授权          ← 本次改动的核心语义
两台服务器同 identity_key 同 FSID   → 合并
两台服务器同 identity_key 异 FSID   → 拒绝合并 + 告警
ceph(RBD) 池                        → shareable=false，跨服务器挂载被拒
```

### 15.5 e2e 环境

```
1. 宿主机装 incus（Debian trixie 的 6.0.4 LTS，或 Zabbly 源较新版）
2. 预建两个池覆盖两种能力族：
     e2e-lvm  driver=lvm, volume.block.filesystem=ext4  → block_backed（缩容需停机）
     e2e-dir  driver=dir, 底层 fs 开 project quota       → quota_online（在线缩容）
   两个都必须有 —— §15.3 的能力矩阵要求两族都能跑
3. 运维自建未托管 `vmbr0`（布局 A：host IP 在网桥上；布局 B：专用上联 NIC，
   host IP 留在管理口）；验证 parent 是 linux bridge 且有 slave；
   验证 nft `bridge incus` 过滤、host↔guest ping、guest→gateway ping
4. 私有 simplestreams 源（静态文件 + 自签 HTTPS，e2e 的 CA 已有），
   放一个带 sshd、且不跑 DHCP 客户端的最小系统镜像
5. 无 GPU：GPU 用例走「服务器无 GPU → nvidia_runtime 不启用」分支
6. Incus 的 HTTPS API + trust token 流程，验证服务器接入向导
```

**覆盖缺口，明确记录不假装已覆盖：**
- **cephfs 共享后端**需要真实 Ceph 集群。e2e 只覆盖控制面逻辑（用注入的伪 cephfs 池），
  「两台服务器挂同一个 cephfs 卷」进**人工验收清单**。
- **多服务器并发**：e2e 环境只有一台宿主机，跨服务器的容量核算与共享卷语义靠单测覆盖。

### 15.6 网络验证（bridged vmbr）

产品 NIC 是 unmanaged bridged。e2e 验证 parent 是 linux bridge、实例 nictype=bridged、
guest 地址仍由 reconciler 写入、**宿主机能 ping 客户机**、nft `bridge_filter_address`
含 claim（及第二地址被丢弃）。前置检查的 L2 是 guest→host，不能替代 host→guest。


---

## 16. 待实机验证

**阶段 0 必须完成。** 前两项是架构级阻塞项。

| # | 验证内容 | 若为否 |
| --- | --- | --- |
| **1** | **bridged 全链路**：parent 是未托管 linux bridge；容器 eth0 为 bridged + filtering；guest exec 写入 claim；宿主机能 ping 客户机；nft 含 claim | 网桥或过滤未实证则不能上线该服务器 |
| **2** | 镜像内的网络栈会不会冲掉 guest 写入的地址 | `network_managed_externally` 门控是必须实现的；reconciler 周期性重写地址 |
| 3 | `PUT` 后 `volatile.*` 是否保留（用读回-改副本-写回的方式）；ETag/`If-Match` 的覆盖范围 | 收敛必须改用 `PATCH` 并放弃删键能力 |
| 4 | 配置回显保真度：`limits.memory: "1GiB"` 会不会被归一成字节；Incus 往 `config` 注入哪些自己的键 | `compareManagedFields` 的归一化规则照此定稿 |
| 5 | `security.shifted=true` 在 **cephfs** 与 **lvm+ext4** 上是否成功 | 共享卷/所有卷退回递归 chown，百万 inode 的卷挂载会很慢，需在 UI 提示 |
| 6 | root disk 延迟缩容：对运行中容器设更小 size，确认返回 200 且 `volatile.root.apply_quota=true` | §10.3 的 pending 机制可简化 |
| 7 | `dir` 池缩容到低于已用量：确认返回 200、后续写入 `EDQUOT`、读取仍正常 | §3.2 规则 1 的守卫可放宽 |
| 8 | `dir` 池无 project quota 时 `size=` 被静默忽略，`volumes/<t>/<v>/state` 的 `usage` 为 null | `quota_effective` 探测方式要换 |
| 9 | `nvidia.runtime=true` 但宿主机没装 toolkit：确认容器启动失败的具体错误 | `gpu_runtime_available` 门控方式要调整 |
| 10 | GPU 热插拔：对建时开了 runtime 但没带卡的运行中容器热加一张卡，容器内 `nvidia-smi` 是否立刻可用 | C7「卡只能停机改」的限制是对的；若可用则可放宽 |
| 11 | 热卸载 while busy：持有 fd 和 cwd，卸载后确认 (a) API 成功 (b) 容器内路径消失 (c) 旧 fd 的写入仍落到卷上 | §12.6 的排空窗口可取消 |
| 12 | 真实块设备 LVM 池扩容：`pvresize` 之后 Incus 是否自动感知 | 运维手册要写清楚 |
| 13 | `min_root_size_bytes` 的可靠来源（`volatile.rootfs.size`？镜像元数据？） | 改用管理员手填 |
| 14 | `POST /1.0/instances/<n>/files` 写 authorized_keys 的 uid/gid/mode 语义，非 root 登录用户的家目录 | 改用 `incus exec` |
| 15 | trust token 流程端到端；一个客户端证书被 N 台信任；证书过期的实际表现 | §4.5 的接入向导照此调整 |
| 16 | `incus --version` 与 `GET /1.0` 的 `api_extensions`，与本方案引用的 `docs/main` 键做差集 | Debian trixie 是 6.0.4 LTS，文档是 main；缺失的键需降级方案 |
| 17 | N 条常驻事件 websocket 的资源开销与断线重连表现 | 退回纯周期扫描（正确性不受影响，只是感知变慢） |

---

## 17. 风险登记

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| **后端必须能入站访问每台服务器**。Incus **没有任何**让宿主机主动外连的模式 | NAT 后的服务器无法接入 | 架构前提，写进部署文档。将来若出现，只能上 VPN/隧道 |
| 客户端证书过期 | 后端对**所有服务器**同时失效，恢复需在每台机器上本地 root 操作 | 10 年有效期；到期前 90 天持续告警；轮换向导 |
| Incus API 暴露在网络 | 攻击面 | 只监听内网；mTLS；防火墙限源 IP；服务端证书 TOFU 钉住 |
| Incus 实例锁**无超时**，卡住的操作无限期持有 | 单个容器永久不可操作 | 有界 context + N 次后标 `needs_attention` 停止重试，交给人 |
| 锁冲突返回 **500 而非 409** | 误判为服务器故障 | 按错误文本匹配；检查异步操作的 error 字段而非只看 POST 响应码 |
| 镜像内的网络栈可能冲掉 Incus 写入的地址 | 容器失去网络 | 私有镜像源里的镜像必须禁用 DHCP 客户端；`network_managed_externally` 登记校验 + 创建门控 |
| ⚠️ `nft` 缺失导致 bridged 过滤静默失效 | 客户机可 ARP/IPv4 欺骗 | 前置检查实证 `nft` + `bridge_filter_address{address=probe}`；exporter `CAP_NET_ADMIN` |
| Rogue DHCP 从容器发出 | 局域网 DHCP 被劫持 | 已知缺口；不在本切中关闭。后续 `security.acls` 或运维 nft |
| **IP 不可变（UI）** | 用户不能改容器 IP | N6：UI 不提供该操作；过滤身份 technically 可热更新 |
| 一次性重构面极大（删除整个 agent 包 + workflow schema + 全新存储域与收敛引擎） | 中途卡住 | 分阶段交付，每阶段仓库自洽；协议冻结后三条 lane 并行 |
| 自建 Incus 客户端的成熟度 | 边缘错误处理不完备 | 类型从官方 yaml 生成；只封装用到的端点；错误映射写单测；变更后坚持重读实际状态 |
| 系统容器语义与用户预期的落差 | 用户按 Docker 习惯用会困惑 | 镜像自带 init 与 sshd，体验接近轻量 VM；文档与 UI 明确说明 |
| cephfs 共享后端无法在 e2e 覆盖 | 首次上线才被真正验证 | 明确列为人工验收项，不假装已覆盖 |
| LVM thin 超分兑现失败 | 扩容或写入时物理空间真的用尽 | 默认系数 1.0，超分是管理员的显式选择；实际用量持续采集并告警 |

---

## 18. 与上一版方案的差异

`plans/incus-refactor.md` 是「把现有架构移植到 Incus」。本版是「按 Incus 的形态重新设计」。
主要差异：

| | 上一版 | 本版 |
| --- | --- | --- |
| Agent | 保留，重写驱动层 | **整体删除**，控制面直连 Incus API |
| 执行模型 | 不可变任务 + WS 派发 + 无状态 Agent + finalizer | 期望态 + 持久意图 + 后端直接收敛 |
| 任务种类 | 12 种 | 无「任务种类」概念，只有资源收敛器 3 个 |
| 网络 | 保留 macvlan + 静态 IP | **bridged on unmanaged vmbr + 控制面分配 + guest exec 写地址**（`ipv4.address` 为过滤身份；宿主布局 A/B，见 §9.6；`routedIp` 仅为地址字段名；不使用 routed） |
| 不确定性处理 | 不确定性边界 → 隔离服务器 | 调用超时就重读实际状态；无服务器隔离 |
| 故障隔离粒度 | 服务器级（一个容器出问题冻结整台） | 资源级 `needs_attention` |
| 删除量 | ~10k 行 | ~25k 行（含整个 agent 包与 workflow schema） |

上一版文档保留作为「移植路线」的对照参考，**不作为实施依据**。
