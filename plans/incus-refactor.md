# nyabase: Docker → Incus 重构方案（已被取代）

> ⚠️ **本文档已被 `plans/incus-architecture.md` 取代，不作为实施依据。**
>
> 本版的思路是「把现有架构移植到 Incus」：保留 nyabase Agent、保留不可变任务 + WebSocket
> 派发的执行模型、保留 macvlan 网络。后续复审发现三处根本性问题：
>
> 1. **Agent 本身是 Docker 时代的产物** —— 它存在是因为 Docker 的 API 没有认证。
>    Incus 是一个远程管理守护进程（mTLS），控制面可以直连，Agent 整体可删。
> 2. **macvlan 无法承载既定需求** —— Incus 的 `nictype=macvlan` 直接拒绝 `ipv4.address`，
>    且宿主机无法访问自己的容器，也无法做宿主侧 IP/ARP 防伪。
> 3. 大量围绕「后端看不见宿主机」建立的机制（不确定性边界、服务器隔离、会话代次、
>    bootstrap 就绪门）在直连之后失去存在理由。
>
> 保留本文档仅作为「移植路线」的对照参考，以及其中仍然有效的调研结论索引。

状态：**已作废**。原状态为实施指令。本仓库未发布、无存量数据库，本次是 clean cutover。
兼容别名、旧路由、双执行路径、遗留迁移一律禁止 —— 与原任务执行方案的第 1 节同一立场。

本文档是施工级方案：包含完整的新数据库 schema、协议类型、任务收敛语义、删除清单、边界情况矩阵与分阶段交付顺序。

支撑调研（现状测绘 + Incus 源码级能力确认）在
`.codex/skills/harness/docs/incus-refactor/research/`：`storage-domain.md`、`runtime-domain.md`、
`access-domain.md`、`incus-capabilities.md`。本文档里凡是标注「源码级确认」的结论都可以在那里回溯到
Incus 上游的具体函数。

---

## 0. 一句话概括

把「Docker 容器 + 宿主机 XFS project quota 共享池 + bind mount 数据目录」整体换成
「Incus 系统容器 + Incus 存储池 + 固定容量的 root disk + 固定配额的 custom filesystem volume」，
并顺带删除镜像的独立授权体系（镜像跟随服务器）。

**保留不动**的是控制面骨架：后端是任务执行状态的唯一持久所有者，Agent 无状态、只执行幂等的
`ensure`/`verify`，资源锁 + finalizer + 隔离级别 serializable 的终态提交。本次重构换的是
**驱动层和存储领域模型**，不是任务架构。

---

## 1. 目标与非目标

### 1.1 目标

1. 容器运行时从 Docker 换成 Incus 系统容器。
2. 存储领域模型完全改用 Incus 原生的两套数据结构：
   - **系统盘**：容器的 `root` disk device，创建时固定容量，位于服务器指定的「系统盘池」。
   - **数据盘**：Incus custom volume（`content-type: filesystem`），每个卷有独立固定配额，
     支持热挂载/热卸载、扩容、缩容。
3. 删除系统自己管理的本地磁盘、数据卷、数据目录抽象（mount source / DataDir / XFS project quota /
   `/etc/projects` / 远程 FS 挂载器）。
4. 容器支持 nesting（容器内跑 Docker）与 NVIDIA GPU 直通。
5. 删除镜像的独立授权（`iam.image_grants`），镜像跟随服务器。
6. 容量双重约束：用户额度 + 池超分系数。

### 1.2 非目标（本次明确不做）

- 快照 / 备份 / 定时快照。Incus 原生支持，作为后续特性；本次只在容量核算模型里为快照占用预留位置。
- Incus 集群（真正的 `incus cluster`）。本次拓扑仍是 N 台独立 standalone 主机 + 1 个控制面。
- Incus projects 多租户隔离。全部实例跑在 `default` project。
- 虚拟机（`incus launch --vm`）。只做系统容器。
- OCI / Docker 镜像兼容。

---

## 2. 决策记录

下表是与产品负责人逐条确认的结论，作为本方案不可再协商的输入。

| # | 议题 | 决策 |
| --- | --- | --- |
| D1 | 镜像模型 | **只用 Incus 原生系统镜像**。容器内跑 init，像轻量 VM。彻底删除 `entrypoint`/`cmd`/`uid`/`init` 这套 OCI 运行时覆盖语义 |
| D2 | 存储池生命周期 | **仅发现，不管理**。管理员在宿主机手工 `incus storage create`；Agent 发现并上报；后端只做注册登记。nyabase 永不执行池级创建/删除 |
| D3 | 系统盘池 | 每台服务器指定一个。**可以改，但只影响之后新建的容器**；已有容器的系统盘留在原池，容器行记录自己实际所在的池 |
| D4 | 系统盘容量 | 用户创建容器时在授权额度内自选 |
| D5 | 系统盘扩缩容 | 扩容在线；缩容取决于池驱动能力（见 §4） |
| D6 | 容量约束 | 双重：① 用户在该服务器上所有盘（系统盘 + 本地数据盘）之和 ≤ 该用户在该服务器的授权额度；② 单个池上所有已创建盘的声明容量之和 ≤ 池物理容量 × 超分系数，系数由管理员在面板按服务器配置 |
| D7 | 用户配额 | 单一 `disk_bytes`，系统盘与本地数据盘合并计入同一额度 |
| D8 | 数据盘池授权 | **保留**。管理员显式授权用户可在该服务器的哪几个池上建数据卷（不同池介质/性能不同，需要区分） |
| D9 | 远程 FS | **完全移除** NFS/CephFS 挂载器体系。集群/共享存储改由 Incus 原生池承载，运维直接在服务器上配置；表现上与普通数据卷一致，但带「共享」标识 |
| D10 | 共享池容量 | **独立核算，绑定在用户身上，不计入服务器的存储配额** |
| D11 | 共享卷跨服务器 | 允许跨服务器挂载（受 §4.4 的驱动安全性约束） |
| D12 | 数据卷共享 | 一个卷可同时挂到**同一用户**的多个容器 |
| D13 | 数据卷扩缩容 | 扩容在线；缩容取决于池驱动能力（见 §4） |
| D14 | 缩容编排 | **不做成后端任务**。后端只做能力判定与前置条件校验；「停容器 → 缩容 → 启容器」由前端引导用户完成 |
| D15 | 文件系统 | **强制 ext4**（`volume.block.filesystem=ext4`）。xfs 完全不能缩容 |
| D16 | 镜像分发 | **自建 simplestreams 私有镜像源**（纯静态文件 + HTTPS），各服务器添加为 remote 后按需拉取 |
| D17 | Incus projects | 不用，全部在 `default` project |
| D18 | nesting | **所有容器默认开启** `security.nesting=true` |
| D19 | 容器内 Docker | 开启安全集合 `security.syscalls.intercept.mknod` + `.setxattr`；**坚决不开** `.mount.allowed`；容器保持 unprivileged |
| D20 | GPU 启用 | 按授权跟服务器：用户只有 CPU 授权、或服务器无 GPU，则不启用 `nvidia.runtime`；否则启用。**GPU 卡只能在容器停止状态修改** |
| D21 | GPU 选择 | 对用户和 API 暴露 nvidia index；内部映射到 Incus 的 GPU 设备选择器 |
| D22 | 网络 | **保留 macvlan + 后端分配静态 IP**，改用 Incus 的 macvlan NIC 设备实现 |
| D23 | SSH 接入 | **镜像自带 sshd**，nyabase 只注入 `authorized_keys` 并确保服务启动。删除整套 dropbear 嵌入逻辑 |
| D24 | Agent 启动回滚 | **取消**「无条件停掉所有托管容器」。改为启动时做一次权威清单上报，后端对账后只修复真实偏差 |
| D25 | 挂载热插拔 | **全面改为热插拔**，运行中直接加/减数据盘，不重启 |
| D26 | 规格热改 | CPU/内存限额**在线调整**，不断服 |
| D27 | 数据库迁移 | **直接重写** `000001_initial.sql` |
| D28 | Incus 客户端 | **自建瘦客户端**：`openapi-typescript` 从官方 `rest-api.yaml` 生成类型 + Node 原生 unix socket HTTP + 一个 async operation `wait` 助手 |
| D29 | grant-expiry | 已于 `d594a15` 单独提交；本次**保留并适配**（把「清理 datadir」换成「清理 incus 卷」） |
| D30 | e2e | 完整覆盖：宿主机装 incus + 预建 lvm thin 池，`features.yaml` 重写 |

---

## 3. 现状（被替换的东西）

调研全文见 `.codex/skills/harness/docs/incus-refactor/research/`
（`storage-domain.md`、`access-domain.md`、`incus-capabilities.md`、`runtime-domain.md`）。这里只留骨架。

### 3.1 存储四层（全部删除）

| 层 | 现状 | 去向 |
| --- | --- | --- |
| **Mount source** | `local` = Agent `agent.yaml` 里配的 XFS 挂载点（**不入库**，只有 grant 引用它）；`remote` = 后端定义、Agent 挂到 `/mnt/remote-fs/<uuid>` 的 NFS/CephFS | → **Incus 存储池**（入库登记，Agent 发现上报） |
| **DataDir** | `control.data_directories`，物理布局 `<root>/.nyabase/dirs/<resourceId>/data` + JSON identity marker | → **Incus custom volume** |
| **Quota** | XFS project quota，`projectId = numericUserId + 10000`，**一个用户一个 project，容器 overlay 上层目录 + 所有本地 DataDir 共享这一个池** | → **每个卷独立固定配额**（`size=`） |
| **Container mount** | Docker bind mount，`control.container_mounts`，**运行时不可变，改挂载必须重建容器** | → **Incus disk device，热插拔** |

配套删除：`HostStorageIdentityGuard`（要求所有 root 同一 XFS 设备）、`XfsQuotaManager`、
`/etc/projects` 原子交换助手、`PhysicalMutationFence`、DataDir 的 `.creating`/`.deleting`
原子改名协议、pinned-fd 变更保护、远程 helper 子进程、`FsMountDriver`/NFS/CephFS 驱动。

### 3.2 镜像授权（全部删除）

`iam.image_grants` 已经是按 `(image, server)` 建键的。所以「镜像跟随服务器」= 把这张表换成
`infra.image_server_assignments`（哪些镜像应该出现在哪些服务器上），并删掉全部按用户/组的授权维度。

删除面（来自 `access-domain.md` 的清单）：DDL + 5 个索引/约束 + 2 个触发器 + 2 个外键；后端
`groups.service.ts` 约 200 行的 grant CRUD 与批量同步；`access-resolver` 的 `imageGrants` 缓存字段；
`servers.service.ts` / `users.service.ts` 的依赖探测；common 的 2 个 zod schema、1 个 DTO、2 个
`AuditAction`；前端 `UserImageGrantsTab`（约 150 行）与 `GroupImageGrantsTab`。

### 3.3 保留不动

后端 workflow 引擎（`workflow.tasks` / `task_attempts` / `resource_claims` / `outbox` /
`reconcile_queue` / `server_execution_lanes` / `commands` / `agent_sessions` /
`agent_observations` / `agent_runtime_projections`）、审计、IAM 用户/组/能力、SSH 代理、
HTTP 代理与域名池、系统设置、指标。

---

## 4. Incus 能力约束（本方案的物理边界）

全部来自源码级确认，出处见 `incus-capabilities.md`。**这一节是后面所有设计的硬约束，不可绕过。**

### 4.1 扩缩容能力按驱动分成两族

所有驱动都走同一个入口 `SetVolumeQuota(vol, size, ...)`；root disk 和 custom volume 走同一条路。
**扩缩容能力是驱动的属性，不是卷角色的属性。**

| 族 | 驱动 | 机制 | 在线缩容 |
| --- | --- | --- | --- |
| **QUOTA_ONLINE** | `dir`、`btrfs`、`zfs`(dataset)、`cephfs` | 只设一个配额数字（project quota / qgroup / `zfs quota=` / `ceph.quota.max_bytes`） | **可以**，瞬时，无任何挂载检查 |
| **BLOCK_BACKED** | `lvm`(thin/thick)、`lvmcluster`、`ceph`(RBD)、`zfs`(`block_mode=true`) | resize 块设备 + `resize2fs`/`xfs_growfs` | **不可以**，被 `MountInUse()` 拦住 |

**扩容对所有驱动都是在线的**，Incus 自己在宿主机上跑 `resize2fs` / `xfs_growfs` /
`btrfs filesystem resize max`，容器内不需要做任何事。

### 4.2 两个必须由控制面自己实现的规则

Incus 不做这两件事，控制面不做就会出事：

1. **`enforce_usage_floor`** —— QUOTA_ONLINE 族接受「新配额 < 当前已用」，返回 200，
   结果是卷永久超配额，之后每次写入 `EDQUOT`。**控制面必须自己拒绝 `new_size < used`。**
2. **`shrink_defers_root`** —— BLOCK_BACKED 族的 **root disk** 缩容，API 返回 **200 成功**，
   `incus config show` 里新容量也显示了，但实际只写了 `volatile.<dev>.apply_quota=true`，
   真正生效要等下次启动。**这是静默陷阱。** 控制面必须要么直接拒绝，要么建模成 pending 并在
   下次启动后回读 `volatile.<dev>.apply_quota` 确认落地。
   （custom volume 没有这条延迟路径，直接返回 `ErrInUse` 错误，反而更安全。）

### 4.3 完整能力矩阵

**Root disk：**

| 驱动 | 扩容(运行中) | 缩容(运行中) | 缩容(已停止) |
| --- | --- | --- | --- |
| `dir` / `btrfs` / `zfs`(dataset) | 在线 | **在线** | 可以 |
| `lvm` / `lvmcluster` / `ceph` / `zfs`(block_mode) | 在线 | **静默延迟到下次启动** | ext4/btrfs 可以；**xfs 永不可以** |
| `cephfs` | — | — | — （**不能做 root disk**，只支持 custom filesystem 卷） |

**Custom `filesystem` 卷：**

| 驱动 | 扩容(挂载中) | 缩容(挂载中) | 缩容(已卸载) |
| --- | --- | --- | --- |
| `dir` / `btrfs` / `zfs`(dataset) / `cephfs` | 在线 | **在线** | 可以 |
| `lvm` / `lvmcluster` / `ceph` / `zfs`(block_mode) | 在线 | **`ErrInUse` 报错** | ext4/btrfs 可以；**xfs 永不可以** |

`block` content-type 的卷**永远不能缩容**，而且**根本不能挂到容器上** —— 容器的数据盘只能是
`filesystem` content-type（是一个挂载点，不是裸块设备）。

### 4.4 共享池：只有 cephfs 是安全的

这是 D11「共享卷跨服务器挂载」的硬边界。

| 拓扑 | 结论 |
| --- | --- |
| 两个 Incus 安装共用同一个 `ceph` OSD pool | **上游明确不支持**。双方都假设自己「完全控制该 OSD pool」，各自「可能删除」不认识的对象 —— 一台主机会删掉另一台的卷 |
| 同一个 RBD `filesystem` 卷从两台主机读写挂载 | **必然损坏**。RBD 的 filesystem 卷是「在 RBD 镜像上盖一层 ext4/xfs」，两个独立内核各有自己的日志和页缓存 |
| 同一个 `cephfs` 卷从多台主机挂载 | **安全**。CephFS 是真正的分布式 POSIX 文件系统，MDS 做锁仲裁 |

Incus 自己的排他检查是 `dbInst.Node != s.ServerName`，查的是 **Incus 集群数据库**。
两台 standalone 主机数据库互不可见，**这道保险在本项目的拓扑下结构性失效**，不能依赖。

**结论：**
- 共享池**只允许 `cephfs` 驱动**。控制面对 `ceph` / `lvmcluster` / `linstor` / `truenas` 驱动的池
  一律标记为「不可共享」，即使它们的 `Remote` 标志是 true。
- `Remote` 标志（来自 `GET /1.0` → `environment.storage_supported_drivers[].Remote`）**不是**
  「能否共享卷」的判据，它只表示「字节存在别处」。真正的判据是内部的 `VolumeMultiNode &&
  !BlockBacking`，而它**不通过 API 暴露**，只能按驱动硬编码。
- 共享后端身份用 `cephfs:{cephfs.cluster_name}/{source}/{cephfs.path}` 合成。
  注意 `ceph.cluster_name` 只是本地配置文件名（选 `/etc/ceph/<name>.conf`），**不是集群身份**；
  真正的身份是 Ceph FSID，Incus 不暴露，需要运维在注册共享池时带外填入（见 §6.3）。

### 4.5 其它硬约束

| 约束 | 说明 |
| --- | --- |
| root disk 换池 | **禁止**。`"The storage pool of the root disk can only be changed through move"` |
| `block.filesystem` | 创建后**不可改**。所以 D15 的 ext4 必须在池创建时就定好（`volume.block.filesystem=ext4`） |
| `security.shifted` | 卷**使用中不可改**（`"Cannot modify shifting with running instances using the volume"`）。必须**建卷时就设** |
| `nvidia.runtime` | **不可热改**，需重启。与 D20「GPU 卡只能停机改」正好一致 |
| GPU 设备选择器 | `physical` 类型支持 `id`(DRM card)/`pci`/`vendorid`/`productid`，**没有 UUID 选择器**。未设的选择器是通配符，一个 `gpu` 设备可能匹配多张卡 —— **必须钉死** |
| 热卸载语义 | `umount2(MNT_DETACH)` 惰性卸载。**不会 EBUSY**，永远「成功」；容器内路径立刻消失，但持有 fd 的进程仍能继续写入真实存储。**卸载成功不等于没有写者** |
| 池扩容 | `incus storage set <pool> size=` **只对 loop-backed 池有效且只能增大**。真实块设备背书的池要在 Incus 之外用 `pvresize` 等 LVM 工具扩 |
| 池容量查询 | `GET /1.0/storage-pools/{name}/resources` → `{space:{used,total}, inodes:{used,total}}`。注意 `GET /1.0/storage-pools/{name}` **只返回配置，没有用量** |
| root disk 最小容量 | 优化镜像路径上有「不得小于镜像 rootfs 解压体积」的约束 |
| API 异步 | 长操作返回 HTTP 202 + `operation: /1.0/operations/<uuid>`，用 `GET /1.0/operations/{id}/wait` 而不是轮询 |

### 4.6 `security.shifted` 的选择

D12 允许一个卷同时挂到同一用户的多个容器。两种模式：

| 模式 | 机制 | 代价 |
| --- | --- | --- |
| `security.shifted=true` | **内核 VFS idmapped mount** | **≈ 0**。VFS 层按 inode 查找时翻译，无 I/O、无元数据改写、挂载瞬时完成，与卷大小无关 |
| 默认（`false`） | **递归 `chown` 遍历** | **O(文件数)**。百万 inode 的卷要几分钟元数据 I/O，且阻塞挂载；还会弄脏每个 inode（对 CoW/快照空间不利） |

**决策：所有 custom volume 建卷时一律设 `security.shifted=true`。** 它性能更好，且是唯一支持
隔离 idmap 的选项；而且它「使用中不可改」，事后补设意味着要从所有消费者卸载，必须从一开始就设。

**待实机验证**：`cephfs` 上 `CanIdmapMount` 是否成功。若不支持，共享池上的卷会拒绝启动。

---

## 5. 新领域模型

### 5.1 概念表

| 概念 | 定义 | 承载 |
| --- | --- | --- |
| **服务器** | 一台跑 Incus 守护进程和一个 nyabase Agent 的主机 | `infra.servers` |
| **存储池** | 服务器上的一个 Incus storage pool。由运维手工创建，Agent 发现上报，管理员在面板登记 | `infra.storage_pools` |
| **共享后端** | 多台服务器上指向同一个物理后端的一组 `cephfs` 池，合并成一个逻辑对象 | `infra.shared_backends` |
| **系统盘** | 容器的 `root` disk device。创建时固定容量，位于容器创建时服务器的系统盘池 | `control.containers` 的字段 |
| **数据卷** | Incus custom volume（`filesystem`），固定配额，可热挂载到同一用户的多个容器 | `control.volumes` |
| **卷挂载** | 一个数据卷挂到一个容器的一个路径上 | `control.volume_attachments` |
| **池授权** | 管理员授权用户/组可在某个池上创建数据卷 | `iam.storage_pool_grants` |
| **共享后端配额** | 用户在某个共享后端上的独立字节额度，不计入任何服务器配额 | `iam.shared_backend_grants` |
| **镜像** | 一条 simplestreams 别名的登记 | `infra.images` |
| **镜像分配** | 某镜像应该出现在某服务器上（取代 `iam.image_grants`） | `infra.image_server_assignments` |

### 5.2 关系图

```
infra.servers ──< infra.storage_pools >── infra.shared_backends   (仅共享池非空)
                        │
                        ├──< iam.storage_pool_grants >── iam.users / iam.groups
                        │
                        ├──< control.volumes >── iam.users
                        │         │
                        │         └──< control.volume_attachments >── control.containers
                        │
                        └──  control.containers.root_pool_id  (系统盘所在池)

infra.shared_backends ──< iam.shared_backend_grants >── iam.users / iam.groups
infra.images ──< infra.image_server_assignments >── infra.servers
iam.users / iam.groups ──< iam.server_grants >── infra.servers    (CPU/内存/磁盘/GPU/到期)
```

### 5.3 容量核算模型

三条独立的约束，创建/扩容时全部要过。

**约束 A —— 用户在服务器上的额度（D6①、D7）**

```
Σ (该用户在服务器 S 上所有容器的 root_size_bytes)
+ Σ (该用户在服务器 S 上所有【本地池】数据卷的 size_bytes)
≤ server_grants(user, S).disk_bytes        -- 0 表示不限
```

计入范围沿用现有规则：`lifecycle_phase ∈ {failed, deleting}` 的容器不计入
（`shouldCountContainerForQuota`），避免失败的占位容器卡住重试。

**约束 B —— 池的超分（D6②）**

```
Σ (该池上所有 root disk 的 root_size_bytes)
+ Σ (该池上所有数据卷的 size_bytes)
≤ pool.total_bytes × server.storage_overcommit_ratio
```

超分系数是**服务器级参数**（`infra.servers.storage_overcommit_ratio`），默认 `1.00`，
应用于该服务器的所有本地池。`pool.total_bytes` 来自 Agent 上报的
`GET /1.0/storage-pools/{name}/resources` 的 `space.total`。

**约束 C —— 共享后端额度（D10）**

```
Σ (该用户在共享后端 B 上所有卷的 size_bytes)
≤ shared_backend_grants(user, B).limit_bytes
```

共享后端上的卷**不进约束 A，也不进约束 B**。共享后端有自己的超分系数
（`infra.shared_backends.overcommit_ratio`），因为它跨服务器，不能挂在某台服务器的参数下。

**为什么用「声明容量」而不是「实际用量」核算**：LVM thin 允许超分，实际用量是会涨的；用声明容量
核算才能给出「创建时就保证兑现」的语义。实际用量另行上报，只用于展示和告警。

---

## 6. 新数据库 schema

D27：直接重写 `packages/backend/src/persistence-pg/migrations/000001_initial.sql`。
下面只列**新增和改写**的表；未提及的表（workflow.*、audit.*、iam.users/groups/api_tokens/…、
interaction.*、system.settings、control.container_gpu_claims / container_network_claims /
container_ssh_routes）保持现状。

Schema 命名沿用现有四段：`infra`（物理设施）、`control`（受控资源）、`iam`（身份与授权）、
`workflow`（任务执行）、`interaction`（代理）、`audit`、`system`。

### 6.1 删除的表

```
control.data_directories          → control.volumes
control.container_mounts          → control.volume_attachments
control.quota_desired             → 无（配额不再下发到宿主机，改为创建时校验 + 卷自身的 size）
iam.image_grants                  → infra.image_server_assignments（授权维度整体消失）
iam.mount_source_grants           → iam.storage_pool_grants
infra.remote_fs_mounts            → 无（共享存储改由 infra.storage_pools + infra.shared_backends 承载）
infra.remote_fs_server_assignments→ 无
```

连带删除它们的全部索引、CHECK、触发器、外键，以及
`control.sync_data_directory_authorization_dependency` 之类的触发器函数。

### 6.2 `infra.storage_pools` —— 新增

Agent 发现上报、管理员登记的 Incus 存储池。**nyabase 永不创建或删除物理池**（D2）。

```sql
CREATE TABLE infra.storage_pools (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    -- Incus 侧的池名，(server_id, incus_name) 唯一
    incus_name text NOT NULL,
    driver text NOT NULL,
    -- 由 driver 推导的能力族，写入行以便查询与展示；Agent 上报时重算并校验
    resize_family text NOT NULL,
    -- volume.block.filesystem 的有效值；QUOTA_ONLINE 族为 NULL
    block_filesystem text,
    -- 该池是否可承载 root disk（cephfs 不可）
    root_disk_capable boolean NOT NULL,
    -- 该池的 filesystem 卷是否可跨服务器共享；仅 cephfs 为 true
    shareable boolean DEFAULT false NOT NULL,
    shared_backend_id uuid,
    -- Agent 上报的 GET /1.0/storage-pools/<n>/resources
    total_bytes bigint,
    used_bytes bigint,
    -- 池是否真的在生效配额（dir 池在无 project quota 的 fs 上会静默忽略 size=）
    quota_effective boolean,
    display_name text,
    -- 管理员登记后才可被使用；未登记的发现结果只出现在管理页
    registered boolean DEFAULT false NOT NULL,
    -- Agent 最近一次报告见到该池的时间；用于识别被运维手工删除的池
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
    CONSTRAINT storage_pools_block_filesystem_check
        CHECK ((block_filesystem IS NULL)
            OR (block_filesystem = ANY (ARRAY['ext4','btrfs','xfs']))),
    -- 强制 D15：块设备背书的池必须是 ext4，否则永不可缩容
    CONSTRAINT storage_pools_shrinkable_fs_check
        CHECK ((resize_family <> 'block_backed') OR (block_filesystem = 'ext4')),
    -- 只有 cephfs 可共享，且共享池必须归属一个共享后端
    CONSTRAINT storage_pools_shared_shape_check
        CHECK (((NOT shareable) AND (shared_backend_id IS NULL))
            OR (shareable AND (driver = 'cephfs') AND (shared_backend_id IS NOT NULL))),
    -- cephfs 不能做 root disk
    CONSTRAINT storage_pools_root_capable_check
        CHECK ((NOT root_disk_capable) OR (driver <> 'cephfs')),
    CONSTRAINT storage_pools_total_bytes_check CHECK ((total_bytes IS NULL) OR (total_bytes >= 0)),
    CONSTRAINT storage_pools_used_bytes_check CHECK ((used_bytes IS NULL) OR (used_bytes >= 0)),
    CONSTRAINT storage_pools_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY infra.storage_pools ADD CONSTRAINT storage_pools_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX storage_pools_server_name_unique ON infra.storage_pools (server_id, incus_name);
CREATE INDEX storage_pools_shared_backend_idx ON infra.storage_pools (shared_backend_id)
    WHERE shared_backend_id IS NOT NULL;

COMMENT ON TABLE infra.storage_pools IS
    'Registered Incus storage pools discovered by the Agent; nyabase never creates or destroys them';
```

`resize_family` / `root_disk_capable` / `shareable` 是**由 `driver` 推导**的（`zfs` 另需看
`volume.zfs.block_mode`），入库是为了让核算与展示能直接查询。Agent 每次上报都重算，
后端发现不一致就更新 —— 这是运维在池上改了 `volume.zfs.block_mode` 之类的唯一检测手段。

### 6.3 `infra.shared_backends` —— 新增

多台服务器上指向同一物理后端的一组 `cephfs` 池，合并成一个逻辑对象（D9/D10/D11）。

```sql
CREATE TABLE infra.shared_backends (
    id uuid NOT NULL,
    name text NOT NULL,
    display_name text,
    description text,
    -- 由 Agent 上报的池配置合成：cephfs:{cephfs.cluster_name}/{source}/{cephfs.path}
    identity_key text NOT NULL,
    -- Ceph FSID。Incus 不暴露，由管理员登记共享后端时带外填入。
    -- 这是唯一真正可靠的集群身份；identity_key 里的 cluster_name 只是本地配置文件名。
    ceph_fsid text,
    total_bytes bigint,
    used_bytes bigint,
    overcommit_ratio numeric(6,3) DEFAULT 1.000 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT shared_backends_name_check
        CHECK ((name = lower(name)) AND (name ~ '^[a-z0-9][a-z0-9_-]*$')),
    CONSTRAINT shared_backends_identity_key_check CHECK ((length(btrim(identity_key)) > 0)),
    CONSTRAINT shared_backends_ceph_fsid_check
        CHECK ((ceph_fsid IS NULL) OR (ceph_fsid ~ '^[0-9a-f-]{36}$')),
    CONSTRAINT shared_backends_overcommit_ratio_check
        CHECK ((overcommit_ratio >= 1.000) AND (overcommit_ratio <= 100.000)),
    CONSTRAINT shared_backends_total_bytes_check CHECK ((total_bytes IS NULL) OR (total_bytes >= 0)),
    CONSTRAINT shared_backends_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY infra.shared_backends ADD CONSTRAINT shared_backends_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX shared_backends_name_unique ON infra.shared_backends (name);
CREATE UNIQUE INDEX shared_backends_identity_key_unique ON infra.shared_backends (identity_key);

COMMENT ON TABLE infra.shared_backends IS
    'One physical cephfs backend reachable from several servers; the only topology where a volume may cross servers';
```

**合并规则**：Agent 上报某池 `driver=cephfs` 且配置能合成出 `identity_key` 时，后端按
`identity_key` 查找已登记的共享后端；命中就把该池的 `shared_backend_id` 指过去。
`ceph_fsid` 若两边都非空且不相等，**拒绝合并并告警** —— 这是防止两个不同 Ceph 集群
恰好都用默认 `cluster_name=ceph` 而被错误合并的唯一防线（§4.4 的告警项）。

### 6.4 `infra.servers` —— 改写

```sql
ALTER ...   -- 相对现状的净变化：
+   system_pool_id uuid,                  -- 新建容器的系统盘去哪个池（D3）
+   storage_overcommit_ratio numeric(6,3) DEFAULT 1.000 NOT NULL,   -- D6②
+   gpu_runtime_available boolean DEFAULT false NOT NULL,           -- 宿主机是否装了 nvidia-container-toolkit
+   incus_version text,                                             -- Agent 上报，用于能力门控
    -- macvlan_cidr / macvlan_gateway / macvlan_reserved_ips 保留不变（D22）
    -- agent_token_hash / host_fingerprint / status / quarantine_* 保留不变

CONSTRAINT servers_storage_overcommit_ratio_check
    CHECK ((storage_overcommit_ratio >= 1.000) AND (storage_overcommit_ratio <= 100.000))
```

`system_pool_id` 有一个外键指向 `infra.storage_pools(id)`，并由一个 CHECK/触发器保证
它指向的池 `server_id` 等于本行、`registered = true`、`root_disk_capable = true`、
且 `shareable = false`（系统盘不能放共享后端上）。

改 `system_pool_id` **不影响已有容器**（D3）—— 容器行自己记 `root_pool_id`。

### 6.5 `control.containers` —— 改写

```sql
CREATE TABLE control.containers (
    id uuid NOT NULL,
    server_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    image_id uuid NOT NULL,
    created_by uuid NOT NULL,
    name text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    desired_generation integer DEFAULT 1 NOT NULL,

    -- 镜像：Incus 原生。fingerprint 在创建时钉死，别名事后移动不影响已建容器
    image_alias text NOT NULL,
    image_fingerprint text NOT NULL,

    -- 系统盘（D3/D4）
    root_pool_id uuid NOT NULL,
    root_size_bytes bigint NOT NULL,
    -- BLOCK_BACKED 池上 root disk 缩容会静默延迟到下次启动（§4.2）。
    -- 一旦下发缩容就写入这里，直到 Agent 观测到 volatile.root.apply_quota 为空才清掉。
    root_size_pending_bytes bigint,

    -- 规格（D26：CPU/内存热改）
    cpu_millis integer DEFAULT 0 NOT NULL,
    mem_bytes bigint DEFAULT 0 NOT NULL,

    -- GPU（D20/D21）：nvidia_runtime 不可热改，卡只能停机改
    nvidia_runtime boolean DEFAULT false NOT NULL,
    gpu_mode text DEFAULT 'none'::text NOT NULL,
    gpu_indices integer[] DEFAULT '{}'::integer[] NOT NULL,

    -- 安全开关（D18/D19）。当前全局恒为 true，落库是为了将来可按容器降级而不必改 schema
    nesting boolean DEFAULT true NOT NULL,
    syscall_intercept boolean DEFAULT true NOT NULL,

    power_intent text DEFAULT 'running'::text NOT NULL,
    lifecycle_phase text DEFAULT 'provisioning'::text NOT NULL,
    observed_generation integer,
    -- Incus 实例名（我们用容器 uuid 派生），取代 bound_runtime_id 的 Docker 容器 ID
    bound_instance_name text,
    active_task_id uuid,
    last_transition_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    failure_reason text,
    failure_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT containers_name_check
        CHECK ((length(name) BETWEEN 1 AND 63) AND (name ~ '^[A-Za-z0-9][A-Za-z0-9-]*$')),
    CONSTRAINT containers_image_fingerprint_check CHECK ((image_fingerprint ~ '^[0-9a-f]{64}$')),
    CONSTRAINT containers_root_size_bytes_check CHECK ((root_size_bytes > 0)),
    CONSTRAINT containers_root_size_pending_check
        CHECK ((root_size_pending_bytes IS NULL) OR (root_size_pending_bytes > 0)),
    CONSTRAINT containers_cpu_millis_check CHECK ((cpu_millis >= 0)),
    CONSTRAINT containers_mem_bytes_check CHECK ((mem_bytes >= 0)),
    CONSTRAINT containers_gpu_mode_check CHECK ((gpu_mode = ANY (ARRAY['none','indices','all']))),
    CONSTRAINT containers_gpu_shape_check
        CHECK (((gpu_mode = 'none') AND (cardinality(gpu_indices) = 0))
            OR (gpu_mode = 'all')
            OR ((gpu_mode = 'indices') AND (cardinality(gpu_indices) > 0))),
    -- D20：有卡就必须有 runtime；没 runtime 就不能有卡
    CONSTRAINT containers_gpu_runtime_shape_check
        CHECK ((gpu_mode = 'none') OR nvidia_runtime),
    CONSTRAINT containers_power_intent_check CHECK ((power_intent = ANY (ARRAY['running','stopped']))),
    CONSTRAINT containers_lifecycle_phase_check
        CHECK ((lifecycle_phase = ANY (ARRAY['provisioning','active','updating','deleting','failed']))),
    CONSTRAINT containers_desired_generation_check CHECK ((desired_generation > 0)),
    CONSTRAINT containers_revision_check CHECK ((revision > 0)),
    CONSTRAINT containers_bound_instance_name_check
        CHECK ((bound_instance_name IS NULL) OR (bound_instance_name ~ '^nyc-[0-9a-f]{32}$'))
);

CREATE UNIQUE INDEX containers_server_name_unique ON control.containers (server_id, name);
```

相对现状的**删除**：`image_ref`、`image_default_uid`、`image_runtime_overrides`、`disk_bytes`、
`mounts_json`、`quota_paths`、`bound_runtime_id`、`runtime_spec_hash`（§8.1）。

`mounts_json` 被删掉是因为 D25：挂载不再是「创建时固定、写死在容器行里的快照」，而是
`control.volume_attachments` 里可独立增删的行。

容器名从 Docker 的 `^[A-Za-z0-9][A-Za-z0-9._-]*$`(≤64) 收紧到 Incus 实例名规则
`^[A-Za-z0-9][A-Za-z0-9-]*$`(≤63) —— Incus 实例名要能做 DNS 标签，不允许 `.` 和 `_`。

### 6.6 `control.volumes` —— 新增（取代 `control.data_directories`）

```sql
CREATE TABLE control.volumes (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    pool_id uuid NOT NULL,
    -- 本地池等于池所在服务器；共享池为 NULL（卷不属于任何一台服务器）
    server_id uuid,
    shared_backend_id uuid,
    -- 用户可见名，(owner, 作用域) 内唯一
    name text NOT NULL,
    -- Incus 侧的卷名，由 id 派生，永不复用
    incus_name text NOT NULL,
    size_bytes bigint NOT NULL,
    -- Agent 上报的实际用量，仅用于展示/告警/缩容下限校验
    used_bytes bigint,
    desired_state text DEFAULT 'creating'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    last_task_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT volumes_name_check
        CHECK ((length(btrim(name)) BETWEEN 1 AND 64) AND (name !~ '[\000\r\n/]')),
    CONSTRAINT volumes_incus_name_check CHECK ((incus_name ~ '^nyv-[0-9a-f]{32}$')),
    CONSTRAINT volumes_size_bytes_check CHECK ((size_bytes > 0)),
    CONSTRAINT volumes_used_bytes_check CHECK ((used_bytes IS NULL) OR (used_bytes >= 0)),
    -- 没有 'resizing'：扩缩容不是独立状态，只是 size_bytes 变了、generation 前进一格，
    -- 由 volume.ensure 收敛到期望 size（§7.4）
    CONSTRAINT volumes_desired_state_check
        CHECK ((desired_state = ANY (ARRAY['creating','active','removing','failed']))),
    CONSTRAINT volumes_generation_check CHECK ((generation > 0)),
    -- 本地卷绑服务器；共享卷绑共享后端。二选一
    CONSTRAINT volumes_scope_check
        CHECK (((server_id IS NOT NULL) AND (shared_backend_id IS NULL))
            OR ((server_id IS NULL) AND (shared_backend_id IS NOT NULL)))
);

ALTER TABLE ONLY control.volumes ADD CONSTRAINT volumes_pkey PRIMARY KEY (id);
-- 名字唯一性按作用域分开：本地卷同一用户同一服务器内唯一，共享卷同一用户同一后端内唯一
CREATE UNIQUE INDEX volumes_local_name_unique ON control.volumes (owner_id, server_id, name)
    WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX volumes_shared_name_unique ON control.volumes (owner_id, shared_backend_id, name)
    WHERE shared_backend_id IS NOT NULL;
CREATE UNIQUE INDEX volumes_incus_name_unique ON control.volumes (pool_id, incus_name);
CREATE INDEX volumes_pool_idx ON control.volumes (pool_id, desired_state);
CREATE INDEX volumes_owner_idx ON control.volumes (owner_id);

COMMENT ON TABLE control.volumes IS
    'Durable reservation of one Incus custom filesystem volume with a fixed quota';
```

`incus_name` 用 `nyv-<uuid去掉横线>` 而不是用户给的名字：Incus 卷名有字符限制，且用户改名
不应该导致物理改名。**永不复用** —— 删除后新建同名卷会拿到新的 uuid。

### 6.7 `control.volume_attachments` —— 新增（取代 `control.container_mounts`）

```sql
CREATE TABLE control.volume_attachments (
    id uuid NOT NULL,
    container_id uuid NOT NULL,
    volume_id uuid NOT NULL,
    -- 冗余用于查询与约束，由触发器保持与 containers/volumes 一致
    server_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    -- Incus disk device 名，由 id 派生
    device_name text NOT NULL,
    container_path text NOT NULL,
    read_only boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,

    CONSTRAINT volume_attachments_container_path_check
        CHECK ((container_path ~~ '/%') AND (container_path <> '/')
            AND (container_path !~ '[\000\r\n]')),
    CONSTRAINT volume_attachments_device_name_check CHECK ((device_name ~ '^nyd-[0-9a-f]{32}$'))
);

ALTER TABLE ONLY control.volume_attachments ADD CONSTRAINT volume_attachments_pkey PRIMARY KEY (id);
-- 同一容器内路径不冲突
CREATE UNIQUE INDEX volume_attachments_path_unique
    ON control.volume_attachments (container_id, container_path);
-- 同一个卷不重复挂到同一个容器
CREATE UNIQUE INDEX volume_attachments_pair_unique
    ON control.volume_attachments (container_id, volume_id);
CREATE INDEX volume_attachments_volume_idx ON control.volume_attachments (volume_id);

COMMENT ON TABLE control.volume_attachments IS
    'Desired disk devices binding custom volumes into a container; converged as part of the instance device set';
```

**注意这张表没有 `desired_state` / `generation` / `last_task_id`。** 这是刻意的：
挂载不是一个有独立生命周期的资源，它是**容器期望设备集合的一部分**，由
`container.config.apply` 整体收敛（§7.4），归属容器的 `desired_generation`。
给每一行配一套自己的状态机，是在为一个不存在的独立收敛过程建模。

**D12 的所有权约束**（卷只能挂到同一用户的容器）由一条 `CHECK (owner_id = ...)` 无法表达，
用一个 BEFORE INSERT/UPDATE 触发器强制：`volumes.owner_id = containers.owner_id`。
同时校验共享卷所挂容器所在的服务器**能看到**该共享后端（即该服务器上存在
`storage_pools.shared_backend_id = volumes.shared_backend_id` 且 `registered`）。

### 6.8 `iam.storage_pool_grants` —— 新增（取代 `iam.mount_source_grants`）

D8：管理员显式授权用户/组可在哪些池上建数据卷。

```sql
CREATE TABLE iam.storage_pool_grants (
    id uuid NOT NULL,
    user_id uuid,
    group_id uuid,
    pool_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT storage_pool_grants_scope_check
        CHECK ((((user_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) = 1)
);

CREATE UNIQUE INDEX storage_pool_grants_user_unique ON iam.storage_pool_grants (user_id, pool_id)
    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX storage_pool_grants_group_unique ON iam.storage_pool_grants (group_id, pool_id)
    WHERE group_id IS NOT NULL;
```

比旧的 `mount_source_grants` 简单得多：不再需要 `source_kind` / `source_identity` 分支，
因为「物理身份防换盘」这件事现在由 Incus 自己的池身份负责，池被运维删掉后
`last_observed_at` 会停止更新，后端据此把池标记为 missing 而不是悄悄换绑。

### 6.9 `iam.shared_backend_grants` —— 新增

D10：共享后端上的额度是独立的、绑用户的、不计入服务器配额。

```sql
CREATE TABLE iam.shared_backend_grants (
    id uuid NOT NULL,
    user_id uuid,
    group_id uuid,
    shared_backend_id uuid NOT NULL,
    limit_bytes bigint DEFAULT 0 NOT NULL,     -- 0 = 不限
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT shared_backend_grants_scope_check
        CHECK ((((user_id IS NOT NULL))::integer + ((group_id IS NOT NULL))::integer) = 1),
    CONSTRAINT shared_backend_grants_limit_bytes_check CHECK ((limit_bytes >= 0))
);

CREATE UNIQUE INDEX shared_backend_grants_user_unique
    ON iam.shared_backend_grants (user_id, shared_backend_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX shared_backend_grants_group_unique
    ON iam.shared_backend_grants (group_id, shared_backend_id) WHERE group_id IS NOT NULL;
```

带 `expires_at` 是为了和 `d594a15` 引入的 grant 到期体系一致（D29）：解析时同样走
`classifyGrantExpiry` 的 live / grace / lost 三态与 `selectWinningGrantCandidate` 的
「直接授权 > 组授权、更晚到期优先、组优先级降序」胜者通吃规则。

### 6.10 `infra.images` + `infra.image_server_assignments` —— 改写

```sql
CREATE TABLE infra.images (
    id uuid NOT NULL,
    name text NOT NULL,
    -- simplestreams 私有源上的别名（D16）
    alias text NOT NULL,
    -- 别名当前指向的 fingerprint，由 Agent 上报刷新；容器创建时钉死这个值
    fingerprint text,
    description text,
    -- 容器默认登录用户（镜像自带 sshd，authorized_keys 注入到这个用户的家目录，D23）
    login_user text DEFAULT 'root'::text NOT NULL,
    -- root disk 最小容量：不得小于镜像 rootfs 解压体积（§4.5）
    min_root_size_bytes bigint,
    is_active boolean DEFAULT true NOT NULL,
    deleting boolean DEFAULT false NOT NULL,
    cleanup_generation integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT images_alias_check CHECK ((length(btrim(alias)) > 0) AND (alias !~ '[\000\r\n\s]')),
    CONSTRAINT images_fingerprint_check
        CHECK ((fingerprint IS NULL) OR (fingerprint ~ '^[0-9a-f]{64}$')),
    CONSTRAINT images_login_user_check CHECK ((login_user ~ '^[a-z_][a-z0-9_-]{0,31}$')),
    CONSTRAINT images_min_root_size_check
        CHECK ((min_root_size_bytes IS NULL) OR (min_root_size_bytes > 0)),
    CONSTRAINT images_deleting_shape_check CHECK ((NOT deleting) OR (NOT is_active)),
    CONSTRAINT images_revision_check CHECK ((revision > 0))
);

-- 取代 iam.image_grants：镜像跟随服务器，没有用户/组维度
CREATE TABLE infra.image_server_assignments (
    id uuid NOT NULL,
    image_id uuid NOT NULL,
    server_id uuid NOT NULL,
    desired_state text DEFAULT 'ensuring'::text NOT NULL,
    -- Agent 上报的该服务器上实际存在的 fingerprint
    observed_fingerprint text,
    generation integer DEFAULT 1 NOT NULL,
    last_task_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT image_server_assignments_desired_state_check
        CHECK ((desired_state = ANY (ARRAY['ensuring','present','removing','failed']))),
    CONSTRAINT image_server_assignments_observed_fingerprint_check
        CHECK ((observed_fingerprint IS NULL) OR (observed_fingerprint ~ '^[0-9a-f]{64}$'))
);

CREATE UNIQUE INDEX image_server_assignments_unique
    ON infra.image_server_assignments (image_id, server_id);
```

删除的字段：`docker_image`、`runtime_overrides`（cmd/uid/init/entrypoint）、`disable_ssh`。
`disable_ssh` 不再需要 —— SSH 由镜像自己带（D23），不带 sshd 的镜像自然就没有 SSH。

**授权语义**：用户能用某镜像 ⟺ 用户对某服务器有有效 server grant ∧ 该镜像在该服务器上
`desired_state = 'present'` ∧ `images.is_active`。没有第三张表。

### 6.11 `control.authorization_dependencies` —— 改写

撤销守卫用的依赖投影。旧的 `(source_kind, source_id, source_identity)` 三元组换成池/后端引用。

```sql
CREATE TABLE control.authorization_dependencies (
    id uuid NOT NULL,
    dependency_kind text NOT NULL,
    dependency_id text NOT NULL,
    user_id uuid NOT NULL,
    -- 共享卷依赖没有 server_id
    server_id text,
    pool_id uuid,
    shared_backend_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT authorization_dependencies_dependency_kind_check
        CHECK ((dependency_kind = ANY (ARRAY['container','volume','volume_attachment']))),
    -- container 依赖只绑服务器；volume 依赖必带池，且池的作用域决定绑服务器还是绑共享后端
    CONSTRAINT authorization_dependencies_shape_check
        CHECK (((dependency_kind = 'container')
                  AND (server_id IS NOT NULL) AND (pool_id IS NULL) AND (shared_backend_id IS NULL))
            OR ((dependency_kind <> 'container') AND (pool_id IS NOT NULL)
                  AND (((server_id IS NOT NULL) AND (shared_backend_id IS NULL))
                    OR ((server_id IS NULL) AND (shared_backend_id IS NOT NULL)))))
);

ALTER TABLE ONLY control.authorization_dependencies
    ADD CONSTRAINT authorization_dependencies_dependency_kind_dependency_id_us_key
    UNIQUE (dependency_kind, dependency_id, user_id);
```

对应地，`AccessRevocationGuardService` 的两个查询要改：
- `assertServerAccessRevocationSafe`：拦截条件从
  `dependency_kind='container' OR (dependency_kind='data_directory' AND source_kind='local')`
  改为 `dependency_kind='container' OR (dependency_kind='volume' AND server_id IS NOT NULL)`。
  语义不变 —— 共享卷不绑服务器，所以不该拦住服务器授权的撤销。
- `assertMountSourcesRevocationSafe` → `assertStoragePoolRevocationSafe`，按 `pool_id` 匹配。
- 新增 `assertSharedBackendRevocationSafe`，按 `shared_backend_id` 匹配。


## 7. Agent 侧：Incus 客户端与任务收敛

### 7.1 客户端（D28）

新建 `packages/agent/src/incus/`，整体取代 `packages/agent/src/docker/`。

```
packages/agent/src/incus/
  api-types.ts          # openapi-typescript 从官方 rest-api.yaml 生成，纳入版本管理
  incus-client.ts       # unix socket HTTP + 异步 operation 处理
  operation.ts          # GET /1.0/operations/{id}/wait 封装
  instance-spec.ts      # 容器规格 → Incus 实例配置的纯函数 + 规格哈希
  events.ts             # GET /1.0/events websocket 订阅
  errors.ts             # Incus 错误 → 三态错误契约的映射
```

**为什么自建**：没有可用的官方或成熟 TS 客户端 —— `@canonical/lxd` 在 npm 上根本不存在，
社区包（`incus-ts`、`@containernerds/incus-client`、`lxdjs`）都是个人玩具级或已废弃。
官方只有 Go 绑定。生成类型 + 一层薄封装，可控、可测、没有供应链风险。

**关键实现约定**：

- 传输：`/var/lib/incus/unix.socket`，用 Node 原生 `http.request({ socketPath })`。
- 异步操作：长操作返回 HTTP 202 + `operation: /1.0/operations/<uuid>`。
  **一律用 `GET /1.0/operations/{id}/wait?timeout=<秒>`，不轮询。**
- 读操作**全部带 AbortSignal 物理超时** —— 沿用现有 Docker 读取契约：
  list / info / state / resources 超时即 abort 底层
  socket，避免周期性上报累积在途请求。
- 变更操作**不使用可中断读助手**。缺少确定 HTTP 响应时 fail-stop，绝不把调用方超时当作
  「已取消」或「可安全重放」。这条与现有 Docker mutation 契约完全一致。
- 每次可能出错的变更之后**必须重新读取实际状态**。目标后置条件已成立时，即使调用超时也算成功。

### 7.2 身份与栅栏：从 Docker label 换成 Incus `user.*` 配置键

现有模型靠 5 个 Docker label 做身份栅栏。Incus 的等价物是实例的 `user.*` 配置键
（Incus 对 `user.` 前缀的键不做解释，专供外部工具存元数据）。

| 旧 Docker label | 新 Incus 配置键 | 保留理由 |
| --- | --- | --- |
| `nyabase.managed` | `user.nyabase.managed` | 区分 nyabase 实例与运维手建实例。**不可省** |
| `nyabase.container_id` | `user.nyabase.container_id` | **改名检测器**：实例名由容器 UUID 确定性派生，理论上冗余，但运维手工 `incus rename` 之后，仅靠名字查找会把它误判成孤儿并触发清理 —— 删掉用户的容器。这个键让重命名可被识别 |
| `nyabase.server_id` | `user.nyabase.server_id` | `runtime.absent` 的跨服务器栅栏，成本极低 |
| `nyabase.spec_generation` | `user.nyabase.generation` | 检测「后端期望第 N 代、实例是第 M 代」 |
| `nyabase.runtime_spec_hash` | **删除** | 见 §8.1 —— 这是纯 Docker 包袱 |

规则：`container.create` 重入时按派生实例名定址；存在则校验 `managed` / `container_id` /
`server_id` / `generation`，**并逐字段比对实际配置与期望配置**（不是比对哈希）；
不存在则创建；身份键不符 → managed failure，绝不采纳一个无关实例。

**一个实质性简化**：Docker 时代要靠扫 label 找容器（`resolveRuntimeId` 做全量 list + 过滤，
重复匹配要报 `container_identity_duplicate`）。Incus 的实例名在主机上天然唯一，我们用
`bound_instance_name = 'nyc-' + containerId.replace(/-/g,'')` 派生，直接
`GET /1.0/instances/<name>` 定址即可。label 扫描降级为**只在清单上报时**使用。
`bound_instance_name` 因此不再是「Docker 随机 ID」，而是确定性派生值 —— 但仍然入库，
因为它是「后端认为自己绑定了哪个实例」的权威记录。

### 7.3 容器规格 → Incus 实例配置

`instance-spec.ts` 是纯函数：给定任务载荷，产出**完整的期望配置文档**（config + devices）。
它同时是「创建时 POST 什么」和「收敛时比对什么」的唯一来源 —— 不再有单独的规格哈希（§8.1）。

```
POST /1.0/instances
{
  name: "nyc-<uuid32>",
  type: "container",
  source: { type: "image", fingerprint: "<钉死的 fingerprint>", server: "<私有源>", protocol: "simplestreams" },
  config: {
    "limits.cpu":            "<cpuMillis/1000, 小数>",       // 热改
    "limits.memory":         "<memBytes>",                   // 热改
    "security.nesting":      "true",                          // D18，热改
    "security.syscalls.intercept.mknod":   "true",            // D19
    "security.syscalls.intercept.setxattr":"true",            // D19
    "nvidia.runtime":        "<true|false>",                  // D20，不可热改
    "user.nyabase.managed":       "true",
    "user.nyabase.container_id":  "<uuid>",
    "user.nyabase.server_id":     "<uuid>",
    "user.nyabase.generation":    "<n>"
  },
  devices: {
    root: { type: "disk", path: "/", pool: "<系统盘池 incus_name>", size: "<rootSizeBytes>" },
    // ⚠️ 网络设备形态待定，见 §14 验证项 1 —— nictype=macvlan 很可能不接受 ipv4.address
    eth0: { type: "nic",  nictype: "<macvlan|ipvlan|routed>", parent: "<宿主机父网卡>",
            "ipv4.address": "<后端分配的静态 IP>" },
    // GPU：每张卡一个设备，按 pci 钉死（见下）
    "gpu0": { type: "gpu", gputype: "physical", pci: "0000:41:00.0" },
    // 数据盘：每个挂载一个设备，热插拔
    "nyd-<uuid32>": { type: "disk", pool: "<池>", source: "<卷 incus_name>", path: "/data/foo" }
  }
}
```

**GPU 的 index → 设备选择器映射（D21）**：Incus 的 `physical` GPU 没有 UUID 选择器，
且**未设的选择器是通配符，一个 `gpu` 设备可能匹配多张卡**。所以：

1. Agent 在状态上报里带上 `gpus[]`，每项含 `{ index, pciAddress, name, uuid }`
   （index/uuid 来自 `nvidia-smi`，pciAddress 是两者的连接点）。
2. 后端存 index（用户可见、与授权一致），下发任务时把 index 翻译成 **pci 地址**放进载荷。
3. Agent 用 `pci=` 钉死设备，**永不使用通配符**。
4. Agent 在 `verify` 里回读实例设备，确认每个 GPU 设备的 `pci` 与载荷完全一致。

PCI 地址在重启后稳定，而 nvidia index 会随驱动枚举顺序变化 —— 这是必须做这层翻译的原因。
若上报的 index↔pci 映射与任务载荷不一致（说明机器换过卡或重排过），任务返回
managed failure 而不是挑一张卡。

### 7.4 新的 `AgentTaskKind`

```ts
export enum AgentTaskKind {
  // 容器
  ContainerCreate        = 'container.create',
  ContainerConfigApply   = 'container.config.apply',   // 收敛整份 config + devices
  ContainerStart         = 'container.start',
  ContainerStop          = 'container.stop',
  ContainerRestart       = 'container.restart',
  ContainerDelete        = 'container.delete',
  ContainerRuntimeAbsent = 'container.runtime.absent',
  ContainerSshEnsure     = 'container.ssh.ensure',

  // 数据卷
  VolumeEnsure           = 'volume.ensure',            // 存在且大小恰好为 X（含扩缩容）
  VolumeAbsent           = 'volume.absent',

  // 镜像
  ImageEnsurePresent     = 'image.ensure_present',
  ImageEnsureAbsent      = 'image.ensure_absent',
}
```

**12 种，比现状的 14 种还少。** 删除 `DataDirEnsure`/`DataDirAbsent`/`RemoteFsEnsure`/
`RemoteFsAbsent`/`QuotaEnsure`，且**没有**为「热改规格 / 扩缩容 / 挂卸载 / 改 GPU」引入
5 个新种类 —— 它们全部是 `container.config.apply` 的同一件事。

**为什么是一个任务而不是五个。** Docker 容器的配置**不可变**，所以每种变更天然是一次独立的、
不可逆的容器操作，任务种类必然按操作切分。Incus 实例的配置是一份**可变文档**，
`PUT /1.0/instances/<n>` 的语义就是「收敛到这份文档」，热插拔是 PUT 的副作用而不是独立动作。
按操作切任务是把 Docker 的思维强加在一个声明式接口上。

因此 `container.config.apply` 的载荷是**完整的期望 config + devices**（由 §7.3 的
`instance-spec.ts` 产出），收敛规则是「读实际 → 比对 → PUT 差异 → 回读验证」。
改 CPU、扩系统盘、加数据盘、换 GPU 走的是同一条码路。

`quota.ensure` 的消失是最大的化简：配额不再是「下发到宿主机、按用户聚合、需要收敛的期望状态」，
而是**每个卷自己的 `size=` 属性**。`control.quota_desired` 整张表、`quotaGeneration` 载荷字段、
`numericOwnerId`、`/etc/projects` 管理、`MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION` 一起消失。

`volume.resize` 也不单独存在：`volume.ensure` 的语义是「存在且大小恰好为 X」，创建与扩缩容
是同一个收敛动作。

**为什么仍然保留任务模型，而不是做成纯 reconcile loop。** 既然 Incus 自己持久化期望态，
一个诱人的想法是让 Agent 周期性对账、去掉任务表。不要这么做：现有架构最有价值的性质是
**每一次变更都有一个持久的、有身份的、带锁的所有者** —— 失败是可见的终态，模糊结果可以隔离，
用户能看到「这次操作为什么没成」。纯 reconciler 的失败形态是「它一直在重试」，不可见也不可问责。
正确的调整是把任务的**粒度**从「一个命令」改成「一次收敛」，而不是取消任务。

### 7.5 收敛语义表

沿用原任务处理器契约：先校验完整载荷 → 探测实际状态 →
条件变更 → 变更后重新读取 → `verify` 必须读实际状态。

| 任务 | 无状态收敛规则 |
| --- | --- |
| `container.create` | 按派生实例名定址；不存在则用完整期望文档创建；存在则校验 4 个身份键后走与 `config.apply` 相同的比对收敛；确保运行；注入 SSH 公钥；verify |
| `container.config.apply` | 读 `GET /1.0/instances/<n>`；把实际 config + devices 与期望文档逐字段比对；有差异则 PUT；回读验证每个字段。**这一条覆盖改 CPU/内存、扩缩系统盘、加减数据盘、改 GPU**。附加规则见 §7.6（扩缩容）与下方（停机要求） |
| `container.start` | 仅在已停止时启动；verify 运行中。**同时回读 `volatile.root.apply_quota`** —— 为空则清掉 `root_size_pending_bytes`（§4.2 的延迟缩容落地证明） |
| `container.stop` | 仅在运行中时停止；verify 已停止 |
| `container.restart` | 见 §7.6.1 —— **重启证明机制待定**，Incus 可能没有 Docker `State.StartedAt` 的等价物 |
| `container.delete` | 存在则删除；verify 不存在。**不再需要 quotaPaths 擦除** |
| `container.runtime.absent` | 按精确实例名定址；变更前校验 4 个身份键全部匹配；停止并删除；verify 不存在。**不再需要遍历全主机证明路径无引用** |
| `container.ssh.ensure` | 通过 `POST /1.0/instances/<n>/files` 写入 `~<login_user>/.ssh/authorized_keys`（0600，属主正确）；确保 sshd 服务已启用；回读文件内容哈希确认 |
| `volume.ensure` | 不存在则 `POST .../volumes` 建卷（`size=`、`security.shifted=true`）；存在但 size 不符则按 §7.6 收敛到期望 size；verify 读回 |
| `volume.absent` | 存在则删除；verify 不存在 |
| `image.ensure_present` | 先查；不存在则从私有 simplestreams remote 拉；再查并校验 fingerprint |
| `image.ensure_absent` | 存在则删除；verify 不存在 |

**`container.config.apply` 的停机门控**：`nvidia.runtime` 与 GPU 设备只能在停止态改（D20）。
后端在入队前判定期望文档与当前记录的差异是否触及这些字段，触及则要求容器已停止，
否则返回 `GPU_CHANGE_REQUIRES_STOP`。Agent 在执行前**再次**确认实例已停止 —— 因为
「PUT 一个非热改键到运行中实例」的行为待验证（§14 验证项 3），不能靠 Incus 报错来兜底。

**PUT 的破坏性风险**：`PUT /1.0/instances/<n>` 若语义是「整体替换 config 映射」，
一个只包含期望键的 PUT 会**抹掉 Incus 自己维护的 `volatile.*`**，后果严重。
在 §14 验证项 3 给出确定结论前，实现必须采取保守形态：
读回实际 config → 在其副本上应用差异（保留所有非 nyabase 管理的键）→ 带 `If-Match` 的 ETag 写回。

### 7.6 扩缩容的收敛语义（D5/D13/D14 + §4.2）

这是全篇最容易出错的地方，单独展开。后端在下发任务前就要按池的 `resize_family` 分流。

**扩容（所有驱动，在线）**

```
root disk（container.config.apply 里 devices.root.size）/ 数据卷（volume.ensure）  且 new > old
  → 直接写入新 size；回读确认；结束
```

**缩容 —— QUOTA_ONLINE 池（`dir`/`btrfs`/`zfs`dataset/`cephfs`）**

```
  → 后端先校验 new_size >= 当前 used_bytes        ← §4.2 规则 1，Incus 不做这个检查
  → 直接 PATCH size=；回读确认；结束（在线，无需停机）
```

**缩容 —— BLOCK_BACKED 池（`lvm` 等）**

后端**拒绝**下发，返回结构化的前置条件错误，由前端引导用户（D14）：

```
数据卷缩容：
  前置条件 = 该卷的所有 volume_attachments 均已移除
  不满足 → 400 { code: 'VOLUME_SHRINK_REQUIRES_DETACH', attachments: [...] }

系统盘缩容：
  前置条件 = 容器已停止（power_intent = stopped 且实际观测为已停止）
  不满足 → 400 { code: 'ROOT_SHRINK_REQUIRES_STOP' }
```

**绝不允许把缩容请求直接透传给运行中的 BLOCK_BACKED root disk。** Incus 会返回 200
并静默延迟，用户会以为缩容成功了。这是 §4.2 规则 2。

如果由于竞态（后端判定时容器已停，Agent 执行时已被启动）任务仍然撞上了延迟路径，
`container.config.apply` 的 `verify` 必须读 `volatile.root.apply_quota`：
- 为空 → 真正落地，成功。
- 非空 → 把容器行的 `root_size_pending_bytes` 置为目标值，任务成功但状态标为 pending，
  由下一次 `container.start` 的回读来收尾（见 §7.5 的 start 规则）。

`root_size_pending_bytes` 非空期间，该容器的系统盘容量在容量核算（§5.3 约束 A/B）里
**按较大的那个值计**，避免「账面已释放、物理未释放」造成超卖。这是竞态兜底路径，不是正常路径。

### 7.6.1 重启证明机制 ⚠️ 待定

现状的 `container.restart` 靠一个 Docker 专有技巧：后端在入队前同步探测容器的
`State.StartedAt` 存进不可变载荷作为基线，Agent 每次投递都比对实际值 —— 相同则执行重启，
不同且运行中则视为已满足。这样一次重启在无状态 Agent 上是可重放的。

**Incus 可能没有 `State.StartedAt` 的等价物。** `GET /1.0/instances/<n>/state` 返回的是
`status`/`pid`/`processes`/`network`/`memory`/`disk`/`cpu`，没有明显的启动时间字段。
在 §14 验证项 2 给出结论前，候选方案按优先级：

1. **容器 PID**（`state.pid`）。重启必然换 PID，且它是单调不复用的（在 PID 回绕之前）。
   作为基线比 `StartedAt` 更强 —— 它同时证明了「这是一个新的 init 进程」。
2. **`last_used_at`**（实例对象上）。需确认它到底由什么更新。
3. **Incus 操作 ID**。`PUT /1.0/instances/<n>/state {action:restart}` 返回一个异步操作，
   Agent 把操作 ID 作为 `incomplete` 证据回传，后端存进不可变证据，重投时带回给 Agent，
   Agent 用 `GET /1.0/operations/{id}` 重新挂接而不是重猜。**这是三者中语义最强的** ——
   它把「我这次重启到底发生了没有」从推断变成查询。代价是任务载荷要多一个可选字段，
   且依赖 Incus 的操作保留窗口（同样待验证）。

方案倾向 1（PID 基线，改动最小、与现有机制同构），若验证发现 PID 不可靠则退到 3。

### 7.7 Agent 启动行为（D24）

**删除**现有的「新进程无条件停掉所有托管容器」回滚。理由：

- Incus 守护进程是系统级的，不像 dockerd 那样由 Agent 专管。现有回滚的前提
  （「停掉专属 dockerd 并证明其 service cgroup 为空」）在 Incus 下不成立。
- Agent 升级会打断全机器用户负载，代价与收益不匹配。

**新的启动序列：**

1. 获取宿主机全局的抽象 Unix 监听锁（保留现状，防止两个 Agent 进程）。
2. 探测 Incus 守护进程可达性与版本（`GET /1.0`），读 `environment.storage_supported_drivers`。
3. 枚举存储池（`GET /1.0/storage-pools?recursion=1` + 每池 `/resources`）。
4. 枚举托管实例（按 `user.nyabase.managed=true` 过滤）、卷、镜像、GPU。
5. 打开 WebSocket，hello，提交第一次**权威全量上报**（bootstrap 这一跳已删除，见 §8.7）。
6. 后端对账，只对真实偏差下发任务。

现有的**互斥栅栏**与 **exec 会话清理**保留：新进程启动时关闭并 join 所有旧的 exec 会话，
确保没有旧进程的交互会话跨越新的准入。这部分与容器电源状态无关，不受 D24 影响。

**代价与缓解**：取消强制回滚意味着「Agent 崩溃期间被外部改动的实例」不再被无条件归零。
缓解手段是首次权威上报的**身份栅栏更严**：任何 `user.nyabase.*` 键缺失或被篡改的实例，
都不被采纳为 canonical runtime，而是走 `container.runtime.absent` 清理路径。
配置层面的漂移则由 `compareManagedFields`（§8.1）识别，走 `container.config.apply` 收敛回来 ——
配置不符是**要修复的偏差**，不是身份问题，不该导致删除。这把「无条件停机」换成了
「精确识别 + 定向清理 + 定向收敛」。

### 7.8 删除的 Agent 模块

```
packages/agent/src/docker/            整个目录 → packages/agent/src/incus/
packages/agent/src/dropbear/          整个目录（D23：镜像自带 sshd）
packages/agent/assets/dropbear/       嵌入的二进制
packages/agent/assets/sftp/           嵌入的 SFTP 二进制（改用 Incus 原生 /1.0/instances/<n>/sftp）
packages/agent/src/quota/             XFS project quota + /etc/projects 助手
packages/agent/src/fs/                FsMountDriver / NFS / CephFS / 挂载表观测 / 精确卸载助手
packages/agent/src/datadirs/          DataDir 物理核心（1783 行）+ 远程 helper 子进程
packages/agent/src/host-storage.ts    单 XFS 设备拓扑证明与热换盘 fence
packages/agent/src/physical-mutation-fence.ts   跨进程物理变更栅栏（只服务于 /etc/projects）
packages/agent/src/tasks/handlers/data-dir-task.handler.ts
packages/agent/src/tasks/handlers/quota-task.handler.ts
packages/agent/src/tasks/handlers/remote-fs-task.handler.ts
packages/agent/src/tasks/handlers/container-mount-reconciler.ts   → 被设备集合收敛取代
packages/agent/src/fs/isolated-command.ts   变更子进程模型（§16.2）
（docker-client.ts 里的 hashContainerRuntimeSpec 随目录一起消失，§8.1）
```

`packages/agent/src/gpu/gpu-monitor.ts` **保留但改造**：仍然用 `nvidia-smi` 采集指标，
但新增 index↔PCI 地址映射的上报（§7.3）。

保留不动：`ws/client.ts`、`tasks/task-runner.ts`、`tasks/task-router.ts`、`coalesced-job.ts`、
`process-guard.ts`、`host-identity.ts`、`config.ts`（大幅瘦身）、`metrics/host-metrics.ts`。

### 7.9 Agent 配置瘦身

`agent.yaml` 删除：`dockerRoot`、`localDataSources[]`、`stateDir` 相关残留、
`/mnt/remote-fs` 相关路径约束、XFS 布局断言。

新增：`incusSocketPath`（默认 `/var/lib/incus/unix.socket`）、
`macvlanParent`（宿主机父网卡名，macvlan NIC 设备需要）。

保留：`macvlanCidr` / `macvlanGateway` / `reservedIps`（D22）、服务器身份与 token。

**`config.ts` 里那套「禁止 dockerRoot / /mnt/remote-fs / 各 localDataSource 相互重叠、
拒绝受保护系统根目录」的校验整体删除** —— 它保护的是 nyabase 自己管理的物理布局，
而现在物理布局归 Incus 管。

### 7.10 Exec 驱动契约

交互式 exec 的**栅栏语义全部保留**，只换驱动。现有实现里 Docker 耦合只有 `DockerClient.exec`
和 `completeInteractiveExecFailClosed` 两处，其余（双向 fence、close 屏障、授权复检）都是通用的。

新增 `packages/agent/src/incus/exec-driver.ts`，必须提供与现状**完全相同的三条契约**：

1. **句柄契约** `{ resize(cols, rows), kill(), write(data) }`。
2. **「传输错误不构成未启动的反证」** —— 连接断开不能被当作「exec 从未启动」。自然退出必须有
   新鲜的 `Running=false` + 整数退出码作为证据；否则停止并重新证明目标容器的状态，或 fail-stop。
3. **`onClosing(completion)` 屏障钩子** —— 关闭一个 exec 可能故意停掉整个容器作为回滚屏障，
   这个完成信号必须能被生命周期任务等待。

**Incus 侧的实现差异**（都是实现细节，不改变上述契约）：

| 关注点 | Docker | Incus |
| --- | --- | --- |
| 建立 | `POST /containers/<id>/exec` + `/start` | `POST /1.0/instances/<n>/exec` → 返回 **websocket 类操作**，`metadata.fds` 里是 `0`/`1`/`2`（交互式只有 `0`）加 `control` 的一次性 secret；再逐个连 `GET /1.0/operations/{id}/websocket?secret=<s>` |
| 改窗口大小 | 独立的 `POST /exec/<id>/resize` | 走 **`control` websocket 发 JSON 消息**，不是单独的 HTTP 调用 |
| 退出码 | `GET /exec/<id>/json` 的 `ExitCode` | 操作完成后 `GET /1.0/operations/{id}` 的 `metadata.return` |
| 用户/工作目录 | 读容器内 `/etc/passwd` | **Incus 刻意不读容器内的 `/etc/passwd`/`/etc/group`/`nsswitch.conf`**（"不信任实例内部数据"的既定策略），所以**必须传绝对 UID/GID/cwd**。要以真实用户身份登录需 `-- su --login <user>` |
| 非交互模式 | 默认分离流 | 必须显式 `--force-noninteractive` / `mode=non-interactive` 才能拿到分离的 stdin/stdout/stderr |

`execClose` **仍然是唯一不被 `assertPhysicalEnvironment()` 拦截的消息**。这条必须原样保留：
否则宿主身份漂移时会遗留一个所有者已被吊销的特权 shell。

大文件传输改用 Incus 原生的 `GET/POST /1.0/instances/<n>/files` 与 `/1.0/instances/<n>/sftp`，
取代现有的「exec + tar 进容器」。这也是 §7.8 里可以删掉嵌入 SFTP 二进制的原因。


## 8. 协议变更（`packages/common`）

### 8.1 删除 `runtime_spec_hash`，改为直接比对配置

**`runtime_spec_hash` 是纯 Docker 包袱，整体删除。**

它之所以存在，是因为 Docker 容器的配置**创建后不可变、且 inspect 输出无法干净地回推创建规格**。
你唯一能做的就是在创建时把规格哈希写进 label，事后拿它判断「这个运行时是不是我想要的那个规格
建出来的」。这是一个在信息缺失下的补偿手段。

Incus 没有这个缺失：实例配置是**可变的**，而且 `GET /1.0/instances/<n>` 返回的就是你写进去的
config + devices。所以直接**逐字段比对实际配置与期望文档**，严格优于哈希：

| | 规格哈希 | 直接比对 |
| --- | --- | --- |
| 能回答「是否一致」 | 能 | 能 |
| 能回答「哪里不一致」 | **不能** | 能 |
| 能直接驱动收敛 | 不能（只能重建） | **能**（差异即是要 PUT 的内容） |
| 需要额外的不可变元数据 | 需要（一个 label） | 不需要 |
| 改一个可热改字段的后果 | **实例身份失效** | 无 |

最后一行是关键。我在上一版方案里为了让「在线改 CPU」不破坏容器身份，设计了一套
「把哈希输入拆成不可变身份类和可变规格类」的规则 —— 那是在**给一个本不该存在的机制打补丁**。
删掉哈希，这个问题连同它的规则表一起消失。

**保留 `user.nyabase.generation`。** 它和哈希不是一回事：generation 解决的是「后端已经推进到
第 N 代期望态，而这个实例还停在第 M 代」，用于让过期任务被 supersede、让漂移可被识别。
这是控制面自己的版本号，Incus 无法提供，必须保留。

**收敛与验证的统一形式：**

```
desired  = instanceSpec(payload)            // 纯函数，§7.3
actual   = GET /1.0/instances/<name>
diff     = compareManagedFields(actual, desired)
if diff.nonEmpty:  PUT (带 If-Match ETag)
verify:  重新 GET，要求 compareManagedFields 为空
```

`compareManagedFields` 只比对 **nyabase 管理的键**（`limits.*`、`security.*`、`nvidia.*`、
`user.nyabase.*`，以及 devices 里的 `root` / `eth0` / `gpu*` / `nyd-*`），
忽略 `volatile.*` 和运维手工加的其它键。这一点很重要：它让「运维在实例上加了一个无关设备」
不会被误判成漂移并被抹掉。

⚠️ 比对的前提是 Incus 的 config 能**忠实回显**写进去的值。若 Incus 会归一化
（例如 `limits.memory: "1GiB"` → 字节数），比对必须在归一化后的值域上做。
见 §14 验证项 4。

### 8.2 Agent → Backend 状态上报

`zStateReportPayload` 改写。注意所有对象都是 `.strict()`，增删字段是**破坏性协议变更**，
必须 Agent 与后端协同发布 —— 本次是 clean cutover，不存在滚动升级问题。

```
zStateReportPayload
  serverId, sequence, observedAt, reconcileProofNonce?     ← 不变
  containers[]     ≤ MAX_MANAGED_CONTAINERS_PER_AGENT      ← 改写，见下
  storagePools[]   ≤ MAX_AGENT_STORAGE_POOLS (新, 建议 64) ← 新增
  volumes[]        ≤ MAX_AGENT_VOLUMES (新, 建议 4096)     ← 新增
  images[]         ≤ MAX_AGENT_IMAGES (新, 建议 512)       ← 改写
  gpus[]           ≤ MAX_AGENT_GPU_DEVICES                 ← 改写，加 pciAddress
  -- 删除：dataDirs[]、xfsProjects[]、disks[]、remoteFsMounts[]
```

**`zContainerSnapshot` 改写：**

```
runtime:
  instanceName    string                  ← 取代 runtimeId（Docker 容器 ID）
  ip              canonical IPv4
  pid             int | null              ← 新增：重启证明基线的首选（§7.6.1）
  rootQuotaPending boolean                ← 新增：volatile.root.apply_quota 是否非空（§7.6）
  managedConfig   Record<string,string>   ← 新增：nyabase 管理的 config 键的【实际值】
  managedDevices  Record<string,Record<string,string>>  ← 新增：nyabase 管理的 devices 的【实际值】
  -- 删除：runtimeId、quotaPaths、runtimeSpecHash
status:    IncusInstanceStatus            ← 改写：直接用 Incus 的状态集合，不再是 Docker 的
sshServer: zContainerSshServerState       ← 改写，见 §8.4
identity:  zContainerIdentityKeys         ← 取代 labels，4 个 user.nyabase.* 键，仍 .strict()
```

`managedConfig` / `managedDevices` 取代了上一版里 `rootPoolName` / `rootSizeBytes` /
`cpuMillis` / `memBytes` / `gpuPciAddresses` / `devices[]` 那一串**逐字段展开的镜像字段**。
理由：后端的对账逻辑就是 §8.1 的 `compareManagedFields(actual, desired)`，它需要的是
**实际配置文档本身**，而不是一份手工挑选、逐个映射、每加一个 Incus 配置键就要改一次协议的投影。
上报这两个映射，后端拿它和期望文档直接比，新增一个受管键时协议零改动。

**`ContainerStatus` 枚举整体替换。** 现有的
`creating|running|exited|paused|restarting|dead|unknown` 是 Docker 的状态机 ——
`exited`、`dead`、`paused` 都是 Docker 的词。应直接采用 Incus 的实例状态集合
（`Running`/`Stopped`/`Frozen`/`Starting`/`Stopping`/`Error`/…，完整集合见 §14 验证项 6），
不做一层无谓的翻译。做翻译的唯一后果是引入一个双方都不认识的中间词汇表。

**新增 `zStoragePoolInfo`：**

```
incusName, driver, blockFilesystem?, totalBytes?, usedBytes?,
quotaEffective (bool), rootDiskCapable (bool),
sharedIdentityKey?    ← cephfs 池才有：cephfs:{cluster_name}/{source}/{path}
config: { 只上报做能力推导必需的键，如 volume.zfs.block_mode }
```

**新增 `zVolumeInfo`：** `poolName, incusName, sizeBytes, usedBytes?, shifted (bool)`

**`zLocalImageInfo` 改写：** 从 Docker 的 `{id, repoTags[], size, createdAt}` 改成
Incus 的 `{fingerprint, aliases[], size, createdAt}`。

### 8.3 后端准入门（`validStateReportInventory`）改写

这是 fail-closed 硬门，任何违反都会让服务器进入 inventory 隔离。Docker 相关的检查全部替换：

| 删除的检查 | 替换为 |
| --- | --- |
| `stateCache.dockerRoot` 必须是规范绝对路径 | 无（`dockerRoot` 概念消失） |
| 每个 `quotaPaths` 必须规范且以 `dockerRoot/` 开头 | 无 |
| 每个 runtime 恰好 2 个唯一 quota path | 无 |
| labels 五键校验 | `identity` **四**键校验（同规则，少了 spec hash） |
| `runtime.ip` 必须是服务器 CIDR 内的可用主机 | **保留不变**（D22） |
| 已绑定容器必须有 active 网络声明 | **保留不变** |
| — | **新增**：`managedDevices.root.pool` 必须对应一个已登记的 `infra.storage_pools` 行 |
| — | **新增**：每个 `nyd-*` 设备的 `(pool, source)` 必须对应一个已登记的卷 |
| — | **新增**：`storagePools[]` 里 driver 与推导出的 `resize_family` 必须与登记值一致 |

`DockerDaemonState` 枚举、`zDockerDaemonStatus`、`dockerDaemonStatus` 消息、
`publishAgentDockerDaemonProjection` 整体删除。Incus 守护进程是系统级的，不由 Agent 拥有，
它的健康状态通过「Agent 能否连上 socket」间接体现，不需要独立的状态机。

### 8.4 SSH 状态模型（D23）

`zContainerSshServerState` 从「dropbear 进程状态」改成「authorized_keys 注入状态」：

```
删除：pid、hostKeyFingerprint（宿主机不再生成/持有主机密钥）
保留：enabled、status、port、appliedKeyGeneration、keyHash、lastReconciledAt、lastError
改写：user: 'root' → loginUser: string（来自 infra.images.login_user）
新增：sshdPresent: boolean（镜像里是否真的有 sshd）
status 枚举：disabled | container_stopped | running | key_applied_sshd_missing | error | unknown
```

`key_applied_sshd_missing` 是新增的显式状态：镜像不带 sshd 时，公钥注入成功但用户连不上。
这必须是一个**可见状态**而不是静默失败 —— 否则用户会以为是网络问题。

主机密钥现在由容器内的 sshd 自己在首次启动时生成，nyabase 不再管理。这意味着
SSH 代理层看到的主机密钥指纹会在容器重建后变化，前端需要相应提示（见 §9）。

### 8.5 REST API 变更

**删除的端点组**（连同其 zod schema 与 DTO）：

```
/mount-sources, /admin/mount-sources
/data-dirs, /admin/data-dirs
/admin/remote-fs-mounts (+ 服务器分配子路由)
/users/:id/image-grants, /groups/:id/image-grants   ← 镜像授权整体消失
/servers/:id/quota  (UserServerQuotaDto)            ← XFS project quota 概念消失
```

**新增的端点组**：

```
GET    /servers/:id/storage-pools              # 用户视角：我能用的池
GET    /admin/servers/:id/storage-pools        # 管理员视角：含未登记的发现结果
PATCH  /admin/storage-pools/:id                # 登记（registered）、改显示名
PATCH  /admin/servers/:id                      # 新增 systemPoolId、storageOvercommitRatio
                                               # 超分系数是服务器级参数，作用于该服务器的所有本地池

GET    /admin/shared-backends
POST   /admin/shared-backends                  # 登记（含带外填入的 cephFsid）
PATCH  /admin/shared-backends/:id
DELETE /admin/shared-backends/:id

GET    /volumes                                # 当前用户的数据卷
POST   /volumes                                # { poolId, name, sizeBytes }
PATCH  /volumes/:id                            # 改名 / 改 sizeBytes（扩缩容）
DELETE /volumes/:id
GET    /admin/volumes

POST   /containers/:id/volumes                 # 热挂载 { volumeId, containerPath, readOnly? }
DELETE /containers/:id/volumes/:attachmentId   # 热卸载
PATCH  /containers/:id/limits                  # 在线改 { cpuMillis, memBytes }
PATCH  /containers/:id/root-size               # 扩缩系统盘
PATCH  /containers/:id/gpu                     # 改 GPU（要求已停止）

GET    /users/:id/storage-pool-grants          # 取代 mount-source-grants
GET    /users/:id/shared-backend-grants
（组的对应端点同构）
```

**容量预检端点**（前端在提交前调用，避免用户填完表单才被拒）：

```
GET /servers/:id/storage-capacity
→ {
    grantLimitBytes,            # server_grants.disk_bytes，0 = 不限
    usedByRootDisksBytes,       # 该用户在本服务器所有容器的 root_size 之和
    usedByLocalVolumesBytes,    # 该用户在本服务器本地池上所有卷的 size 之和
    availableBytes,             # 约束 A 的剩余
    pools: [{
      poolId, displayName, driver, shareable,
      totalBytes, overcommitRatio,
      committedBytes,           # 该池上所有已声明容量之和
      availableBytes,           # 约束 B 的剩余
      capability: {             # §4.3 的能力矩阵，前端据此渲染扩缩容 UI
        growOnline: true,
        shrinkOnline: bool,     # resize_family === 'quota_online'
        shrinkRequiresStop: bool,
        shrinkNever: bool,      # block_backed 且 block_filesystem === 'xfs'
        enforceUsageFloor: bool # quota_online：前端也要拦 new < used
      }
    }]
  }
```

**能力必须由后端下发给前端，而不是前端硬编码驱动表** —— 池的驱动是运维在宿主机上定的，
前端不该知道 `lvm` 和 `dir` 的区别，它只需要知道「这个池能不能在线缩」。

**上面五个改容器的端点内部产生的是同一种任务：`container.config.apply`。**
端点保持细分是为了让用户意图明确、审计记录精确、权限与前置条件可以分别校验；
但它们做的事都是「改期望文档的某几个字段，然后收敛」。不要因为 REST 分了五个动词，
就在 Agent 侧也分五种任务 —— 那是把 API 的表达粒度错当成执行粒度（§7.4）。

### 8.6 结构化错误码

缩容与容量是本次最容易让用户困惑的地方，错误必须结构化而非纯文本（D14 要求前端做编排引导）。

```
STORAGE_GRANT_EXCEEDED        { requestedBytes, availableBytes, grantLimitBytes }
STORAGE_POOL_EXHAUSTED        { poolId, requestedBytes, availableBytes, overcommitRatio }
SHARED_BACKEND_QUOTA_EXCEEDED { sharedBackendId, requestedBytes, availableBytes }
VOLUME_SHRINK_BELOW_USAGE     { volumeId, requestedBytes, usedBytes }
VOLUME_SHRINK_REQUIRES_DETACH { volumeId, attachments: [{ containerId, containerName, path }] }
VOLUME_SHRINK_UNSUPPORTED     { volumeId, poolId, reason: 'xfs_cannot_shrink' }
ROOT_SHRINK_BELOW_USAGE       { containerId, requestedBytes, usedBytes }
ROOT_SHRINK_REQUIRES_STOP     { containerId }
ROOT_SHRINK_UNSUPPORTED       { containerId, poolId, reason: 'xfs_cannot_shrink' }
ROOT_SIZE_BELOW_IMAGE_MINIMUM { imageId, requestedBytes, minimumBytes }
VOLUME_CROSS_SERVER_DENIED    { volumeId, serverId, reason: 'backend_not_reachable' }
GPU_CHANGE_REQUIRES_STOP      { containerId }
GPU_RUNTIME_NOT_ENABLED       { containerId }   # 容器建时未开 nvidia.runtime，需重建
```

### 8.7 握手与传输层

**整个信封层、会话栅栏、序列号接受、ack/RPC 关联、心跳与退避、日志分片、`task.execute/accepted/result`
保持不变。** 下面只列变更点。

**`agent.bootstrap.v1` 整体删除。** 这个 RPC 存在的唯一理由是把 RemoteFS 挂载集重新灌进
无状态 Agent 的 RemoteFS bootstrap 方案，而 D9 已经把 RemoteFS 删掉了。
Agent 侧对应的 `ensurePhysicalBootstrap` 做的四件事也全部消失：

| 原 bootstrap 动作 | 去向 |
| --- | --- |
| quiesce Docker 守护进程 | 无 —— Incus 守护进程是系统级的，不归 Agent 管 |
| reconcile 专属 dockerd 单元 | 无 |
| quiesce 所有托管容器 | **D24 已取消** |
| `ensureMacvlanNetwork`（预建 Docker network） | 无 —— Incus 的 macvlan NIC 设备直接指定 `parent`，不需要预建网络对象 |
| 下发 RemoteFS 挂载集 | 无 —— Incus 自己持久化卷，不需要 rehydrate |

因此会话状态机从 `admitted → bootstrapReady → ready` 简化为 **`admitted → ready`**，
`workflow.agent_sessions` 的 bootstrap 状态位与 `assertBootstrapReady` / `markBootstrapReady`
一并删除。

**就绪门保留**：首份权威全量报告仍然是 `admitted → ready` 的唯一触发条件，
`AGENT_INITIAL_STATE_REPORT_TIMEOUT_MS`（5 分钟）与 `quarantineIncompleteInitialization`
原样保留。少了 bootstrap 这一跳，握手反而更难出现「连上但永远不就绪」的中间态。

**`hello` 载荷变更：**

```
删除：dockerRoot
改写：disks[]  → storagePools[]      （池发现结果，见 §8.2）
改写：gpus[]   → 每项增加 pciAddress （§7.3 的 index↔PCI 映射）
保留：localImages: []  ← 这个「刻意为空」的设计保留。
      在被准入之前不去碰 Incus，是一条好性质，不要因为换驱动就丢掉
保留：serverId / hostFingerprint / configFingerprint / hostname / kernelVersion /
      cpuCores / totalMemBytes / macvlanCidr / macvlanGateway / macvlanReservedIps /
      macvlanIface / agentVersion
新增：incusVersion、gpuRuntimeAvailable（宿主机是否有 nvidia-container-cli 与 LXC nvidia hook）
```

`bindAgentIdentity` 在 `onHello` 里持久绑定不可变网络身份的逻辑**完全不变**（§10.5 依赖它）。

**消息种类变更：**

```
删除：dockerDaemonStatus（Agent→Backend）及其 30s 定时器
      —— Incus 守护进程不由 Agent 拥有，健康度由「能否连上 socket」间接体现，
         不需要独立状态机。DockerDaemonState 枚举一并删除
改写：inspectContainer 的响应去掉 graphPaths；保留 startedAt / running
      （restart 基线探测仍然需要它们，§7.5）
改写：selfCheck 的检查项集合：删除 Docker / XFS / 挂载表相关项，
      新增 Incus socket 可达、存储池可枚举、nvidia hook 存在性
```

**节奏保持不变**：心跳 5s、状态报告 15s、WS ping 30s、退避仅在收到 `admission.ready` 后
重置为 1s（TCP 打开不算控制面成功）。状态报告的事件驱动触发源从
`diskChanged` / `dataDirChanged` 改为 Incus 的 `/1.0/events` 生命周期事件
（`instance-started` / `instance-stopped` / `storage-volume-*`）—— 这比现在的轮询更及时，
是换驱动顺带拿到的收益。

**代理层完全不动**：SSH 代理（`packages/backend/src/ssh/`）与 HTTP 代理
（`packages/backend/src/http-proxy/`）只消费 `macvlan_ip` / `runtimeId` / `runtimeStatus`
三个字段，与运行时无关。`proxy-snapshots/` 的 epoch 机制（`blockServer` 分配新 epoch，
`unblockServerIfEpoch` 只在 epoch 未变时解封）原样保留。唯一的连带改动是
`runtimeId` 的取值从 Docker 容器 ID 变成派生的 Incus 实例名（§7.2）。

---

## 9. 前端变更

### 9.1 删除

| 位置 | 内容 |
| --- | --- |
| `pages/users-page.tsx` | `UserImageGrantsTab`（镜像×服务器开关矩阵 + 孤儿清理，约 150 行）；`EffectiveTab` 里的 `allowedImages` |
| `pages/group-detail-page.tsx` | `GroupImageGrantsTab`；tab 列表里的 `image-grants` |
| 数据目录页面 / mount source 选择器 | 整体 |
| 远程 FS 管理页 | 整体 |
| 容器创建对话框 | 镜像的 entrypoint/cmd/uid 相关展示（若有） |

`UserGrantsDialog` 的 tab 从
`effective | groups | overrides | image-grants | mount-source-grants | ssh | password`
变成
`effective | groups | overrides | storage-pools | shared-backends | ssh | password`。

### 9.2 新增

**存储池管理（管理员）**
服务器详情页新增「存储」标签：列出 Agent 发现的所有池，含驱动、容量、已提交容量、
超分后的可用量、能力标记（可否在线缩容 / 可否做系统盘 / 是否共享）。未登记的池以灰色列出，
带「登记」按钮。系统盘池用单选标记，切换时明确提示「只影响之后新建的容器」（D3）。

**共享后端管理（管理员）**
独立页面。列出所有共享后端、它们被哪些服务器看到、总容量与已提交容量、各用户的额度。
登记时要求填 Ceph FSID，并在两台服务器上报的 `identity_key` 相同但 FSID 不同时**红色告警**
（§4.4 的误合并防线）。

**数据卷页面（用户）**
取代数据目录页。每个卷显示：名称、所在池、大小、已用量、共享标记、挂载到哪些容器。
操作：新建、改名、扩容、缩容、删除。

**容器详情页新增「存储」区**
系统盘：所在池、容量、已用量、扩缩容按钮。
数据盘：已挂载的卷列表 + 挂载路径，支持**运行中直接加/减**（D25），不提示重启。

**容器详情页新增「规格」区**
CPU / 内存滑块，**在线生效**，不提示重启（D26）。
GPU 选择器，**要求容器已停止**才可编辑；未开 `nvidia.runtime` 的容器显示
「该容器创建时未启用 GPU，需重建后才能使用」。

### 9.3 缩容的前端编排（D14）

后端只做能力判定与前置条件校验，**编排在前端**。三条路径：

```
capability.shrinkOnline == true          （dir / btrfs / zfs / cephfs 池）
  → 直接改，唯一的前端校验是 new >= used（后端也校验，双保险）
  → 无任何停机提示

capability.shrinkRequiresStop == true    （lvm / ceph 池）
  → 数据卷：弹窗列出所有挂载点，「需要先从这 N 个容器卸载」，提供一键卸载
           卸载完成后自动重试缩容，成功后询问是否挂回
  → 系统盘：弹窗「需要先停止容器」，提供停止按钮
           停止确认后执行缩容，成功后询问是否启动
  → 全程不隐藏步骤，用户清楚知道自己在停什么

capability.shrinkNever == true           （block_backed + xfs）
  → 缩容按钮禁用，tooltip 说明「该池使用 XFS，文件系统不支持缩小」
  → 提示「可以新建一个更小的卷并迁移数据」
```

「一键卸载 / 停止」本质是前端连续调用已有的原子端点，**不是后端的复合事务**。
中途失败时用户看到的是「卸载成功 3 个，第 4 个失败」这样的真实状态，而不是一个含糊的
「操作失败」—— 这正是 D14 选择前端编排而非后端任务的原因。


## 10. 边界情况矩阵

沿用原方案的恢复矩阵格式。**未在此列出的通用故障
（execute 丢失、结果丢失、后端重启、finalizer 失败、任务过期与隔离）语义完全不变**，
因为任务架构没动。下面只列本次重构引入或改变的情况。

### 10.1 存储容量与配额

| 情况 | 行为 |
| --- | --- |
| 用户创建容器，系统盘容量超出剩余授权额度 | 事务内拒绝，`STORAGE_GRANT_EXCEEDED`，不创建任何行 |
| 用户创建容器，池的超分余量不足 | 事务内拒绝，`STORAGE_POOL_EXHAUSTED` |
| 两个用户并发创建，各自单独看都够、加起来超了 | 容量校验在**同一个 serializable 事务**内，对 `infra.storage_pools` 行取 `FOR UPDATE`。后提交者回滚重试并看到新的已提交量 |
| 管理员调低服务器超分系数，导致已有容量超标 | **允许调低**，不回溯撤销已有资源。系统进入「超配」状态并在管理页显式标红；新的创建/扩容一律被拒直到降下来 |
| 管理员调低用户 `disk_bytes`，低于其已用 | 同上：允许，标红，只拦新增 |
| 池的物理容量因运维扩容而变大 | Agent 下次上报刷新 `total_bytes`，余量自动变大，无需任何操作 |
| 池的物理容量因运维缩容而变小 | 同上，可能立即进入超配状态并标红 |
| 容器处于 `failed` 或 `deleting` | **不计入容量核算**（沿用 `shouldCountContainerForQuota`），失败的占位不阻塞重试 |
| `root_size_pending_bytes` 非空（延迟缩容未落地） | 容量核算取 `max(root_size_bytes, root_size_pending_bytes)`，避免账面已释放、物理未释放的超卖 |
| `dir` 池所在文件系统没开 project quota | Agent 上报 `quotaEffective: false`；后端**拒绝在该池上创建任何卷**并在管理页标红。否则 `size=` 会被 Incus 静默忽略，形成无限容量的假象 |

### 10.2 扩缩容

| 情况 | 行为 |
| --- | --- |
| 在线扩容（任何驱动） | 直接生效，Incus 自己在宿主机跑 `resize2fs`，容器内无感 |
| QUOTA_ONLINE 池缩容到低于已用量 | **后端拒绝**（Incus 不拒绝，会返回 200 并让卷永久超配额、之后每次写 `EDQUOT`） |
| BLOCK_BACKED 池缩容，卷仍挂载在运行中容器 | 后端拒绝，`VOLUME_SHRINK_REQUIRES_DETACH` 并列出全部挂载点 |
| BLOCK_BACKED 池缩容，卷挂在**两个**容器上，只卸载了一个 | 仍然拒绝。宿主机侧引用计数未归零，Incus 会返回 `ErrInUse` |
| BLOCK_BACKED 池的 root disk 缩容，容器运行中 | 后端拒绝，`ROOT_SHRINK_REQUIRES_STOP`。**绝不透传** —— 会静默延迟 |
| 竞态：后端判定时已停，Agent 执行时已被启动 | Agent `verify` 读 `volatile.root.apply_quota`；非空则写 `root_size_pending_bytes`，任务成功但标 pending，由下次 `container.start` 收尾 |
| xfs 池上请求缩容 | 前端按钮就是禁用的；后端仍然二次拒绝 `*_SHRINK_UNSUPPORTED` |
| 缩容任务下发后、Agent 执行前，用户又写满了卷 | Incus 的 `resize2fs` 会失败（不能缩到低于实际数据）。返回 managed failure，卷保持原容量，用户看到明确原因 |
| 扩容时池的物理空间实际已耗尽（thin 超分兑现失败） | Incus 返回错误 → managed failure。这是超分系数 > 1 时的**固有风险**，方案通过「默认系数 1.0」把它变成显式选择 |

### 10.3 共享后端

| 情况 | 行为 |
| --- | --- |
| 两台服务器上报相同 `identity_key` | 合并为同一个共享后端；两台服务器都能挂它上面的卷 |
| 两台服务器 `identity_key` 相同但登记的 Ceph FSID 不同 | **拒绝合并 + 告警**。这是「两个不同 Ceph 集群都用默认 `cluster_name=ceph`」的唯一防线 |
| 运维在服务器上配了 `ceph`(RBD) 而非 `cephfs` 的共享池 | 该池 `shareable = false`，只能当本地池用。**不允许跨服务器挂载** —— RBD 的 filesystem 卷跨主机读写必然损坏（§4.4） |
| 共享卷挂到一台看不到该后端的服务器上的容器 | 事务内拒绝，`VOLUME_CROSS_SERVER_DENIED` |
| 共享卷同时挂在两台服务器的两个容器上 | **允许**（仅 cephfs）。CephFS 有 MDS 仲裁，这是安全的 |
| 某台服务器上的共享池被运维删除 | 该服务器的 `storage_pools` 行 `last_observed_at` 停止更新 → 标记 missing；该服务器上对该后端卷的挂载进入 failed；**共享后端本身和卷都不删**，因为其它服务器还看得到 |
| 所有服务器都看不到某共享后端了 | 后端与卷保留（数据可能还在 Ceph 上），标记为不可达。删除需要管理员显式操作 |
| 共享后端的额度用完 | `SHARED_BACKEND_QUOTA_EXCEEDED`。**不影响**用户在任何服务器上的本地额度（D10） |

### 10.4 卷挂载与热插拔

| 情况 | 行为 |
| --- | --- |
| 运行中热挂载 | 直接生效，容器内立刻出现挂载点 |
| 运行中热卸载，容器内有进程正在写 | **不会 EBUSY**。`umount2(MNT_DETACH)` 惰性卸载：路径立刻从容器命名空间消失，但持有 fd 的进程**仍能继续写入真实存储**。所以：卸载成功 ≠ 没有写者 |
| 卸载后立刻把卷挂到另一个容器 | **危险**。旧写者可能还在写。后端在设备移除成功与「该卷可被重新挂载」之间加一个**排空窗口**（复用现有 `networkClaimReuseDeadline` 的模式），窗口内拒绝重新挂载 |
| 缩容前的卸载 | 排空窗口同样适用，且 BLOCK_BACKED 驱动本身会用 `MountInUse()` 拒绝，形成第二道防线 |
| 挂载路径与已有挂载冲突 | DB 唯一索引 `(container_id, container_path)` 拒绝 |
| 同一个卷重复挂到同一容器 | DB 唯一索引 `(container_id, volume_id)` 拒绝 |
| 卷的属主与容器属主不同 | 触发器拒绝（D12：只能挂到同一用户的容器） |
| 删除卷时仍有挂载 | 后端拒绝；用户须先全部卸载 |
| 删除容器时仍有挂载 | 挂载行随容器级联删除；**卷本身保留**（数据不随容器消失，这是数据盘的意义） |

### 10.5 容器与运行时

| 情况 | 行为 |
| --- | --- |
| Agent 重启 | **不再停容器**（D24）。做一次权威清单上报，后端只修复真实偏差 |
| 实例的 `user.nyabase.*` 键缺失或被篡改 | 不被采纳为 canonical runtime，走 `container.runtime.absent` 定向清理 |
| 实例的受管配置与后端期望不符 | **不是身份问题**，不走清理。`compareManagedFields` 识别出差异后走 `container.config.apply` 收敛回来（§8.1） |
| 实例上有运维手工加的无关设备或配置键 | `compareManagedFields` 只比对受管键，**忽略它、不判漂移、不抹掉** |
| 用户在线改 CPU/内存 | `container.config.apply`，不重启，`verify` 回读 `config` 确认 |
| 用户改 GPU，容器运行中 | 拒绝，`GPU_CHANGE_REQUIRES_STOP` |
| 用户想给一个建时未开 `nvidia.runtime` 的容器加卡 | 拒绝，`GPU_RUNTIME_NOT_ENABLED`，提示需重建（§8.1 里这是可讨论项） |
| 服务器没装 nvidia-container-toolkit，但容器开了 `nvidia.runtime` | **容器根本启动不了**。所以创建时用 `infra.servers.gpu_runtime_available`（Agent 探测上报）做门控，不满足就不允许开 |
| 用户创建容器时的系统盘容量小于镜像 rootfs 解压体积 | 后端用 `infra.images.min_root_size_bytes` 预校验，`ROOT_SIZE_BELOW_IMAGE_MINIMUM` |
| 管理员改了服务器的系统盘池 | 只影响之后新建的容器；已有容器的 `root_pool_id` 不变（D3）。**root disk 换池被 Incus 禁止**，只能通过 `incus move`，本次不做 |
| 镜像别名被移到新版本 | 已有容器钉的是 `image_fingerprint`，不受影响。新建容器用新 fingerprint |
| 镜像在某服务器上还没拉下来 | `container.create` 前置条件不满足，拒绝创建（沿用现有 `resolveImageDockerId` 必须命中的逻辑，换成 fingerprint 匹配） |
| 镜像不带 sshd | 公钥注入仍然成功，SSH 状态为 `key_applied_sshd_missing`，前端显式提示。**不是静默失败** |
| 容器重建后 SSH 主机密钥变了 | 主机密钥现在由容器内 sshd 自己生成（D23）。SSH 代理层与前端需提示指纹已变化 |

### 10.6 存储池发现与登记

| 情况 | 行为 |
| --- | --- |
| Agent 发现一个未登记的池 | 出现在管理页的「已发现」列表，**用户完全看不到**，不能在上面建任何东西 |
| 运维删除了一个已登记且已有卷的池 | `last_observed_at` 停更 → 标记 missing；池上的卷与容器进入 failed；**不自动删除任何 DB 行**（沿用「失败不等于回滚」的原则） |
| 运维改了池的 `volume.block.filesystem` | 对已有卷无效（创建后不可改），只影响新卷。Agent 上报的值变化会更新登记行并可能改变能力标记 |
| 运维给池开了 `volume.zfs.block_mode` | `resize_family` 从 `quota_online` 变成 `block_backed`，在线缩容能力消失。Agent 上报时后端更新登记行，前端能力标记随之变化 |
| 已登记为 `block_backed` 的池其 `block_filesystem` 是 xfs | DDL 的 `storage_pools_shrinkable_fs_check` 直接拒绝登记（D15）。运维必须重建池 |
| 服务器长期离线 | 池行保留，`last_observed_at` 陈旧。容量核算仍用最后已知值 —— 不能因为看不到就假定容量为零 |

### 10.7 授权

| 情况 | 行为 |
| --- | --- |
| 撤销服务器授权，用户在该服务器上还有容器或本地卷 | 拒绝，`ACCESS_REVOKE_HAS_RESOURCES`（沿用现状） |
| 撤销服务器授权，用户只有**共享卷** | **允许**。共享卷不绑服务器（§6.11 的守卫改写） |
| 撤销池授权，用户在该池上还有卷 | 拒绝，`assertStoragePoolRevocationSafe` |
| 撤销共享后端授权，用户在该后端上还有卷 | 拒绝，`assertSharedBackendRevocationSafe` |
| server grant 到期 | 沿用 `d594a15` 的 grace 期 + 到期后停容器 + 清理资源（D29），把「清理 datadir」换成「清理 incus 卷」 |
| shared backend grant 到期 | 同构处理 |
| 用户对某镜像没有授权 | **这个概念不存在了**。有服务器授权 + 镜像在该服务器上 present + 镜像 is_active，就能用 |

---

## 11. 删除清单

一次性清点，作为「clean cutover 是否真的干净」的验收依据。

### 11.1 数据库

```
control.data_directories, control.container_mounts, control.quota_desired
iam.image_grants, iam.mount_source_grants
infra.remote_fs_mounts, infra.remote_fs_server_assignments
+ 它们的全部索引、CHECK、外键、触发器
+ 触发器函数 control.sync_container_mount_authorization_dependency（改写）
+ iam.policy_state.next_numeric_user_id（XFS project id 分配器，不再需要）
+ control.containers 的 image_ref / image_default_uid / image_runtime_overrides
                      / disk_bytes / mounts_json / quota_paths / bound_runtime_id
```

### 11.2 Agent

见 §7.8。总量约 **10,000+ 行生产代码 + 测试**（`docker/` 5,596、`dropbear/` 1,646、
`datadirs/` ~2,500、`fs/` ~1,500、`quota/` ~800、`host-storage.ts` ~200）。

### 11.3 Backend

```
src/datadirs/            整个目录
src/mount-sources/       整个目录
src/remote-fs/           整个目录
src/nfs/                 空目录，删掉
src/quota/               整个目录（quota-dispatch / quota-workflow-finalizer）
src/storage/             重写为 incus 存储仓储（保留目录名）
groups.service.ts        约 200 行镜像授权 CRUD + 批量同步
access-resolver.service.ts   UserCache.imageGrants 字段与其解析
servers.service.ts       image_grants 依赖探测
users.service.ts         组镜像授权的提权探测
runtime-drift-reconciler.service.ts  canonicalQuotaPaths / startRecoveryPayload 的 quotaPaths 前置条件
agent-gateway.ts         validStateReportInventory 的 dockerRoot / quotaPaths 校验；
                         dockerDaemonStatus 消息与 publishAgentDockerDaemonProjection；
                         agent.bootstrap.v1 RPC、assertBootstrapReady、markBootstrapReady
                         及 workflow.agent_sessions 的 bootstrap 状态位（§8.7）
state-cache.ts           dockerRoot / resolveImageDockerId / dockerDaemonState
agent-task-result-validator.ts  validateContainerQuotaPaths 及 dockerRef 相等校验
```

### 11.4 Common

```
enums.ts        DockerDaemonState；AgentTaskKind 的 DataDir*/RemoteFs*/Quota* 成员；
                RemoteFsType；AuditAction 的 UpsertImageGrant/DeleteImageGrant/
                CreateDataDir/DeleteDataDir/CreateRemoteFsMount/.../UpsertMountSourceGrant/...
constants.ts    LABEL.*（改为 Incus user.* 键名）；NYABASE_NETWORK；XFS_PROJECT_ID_OFFSET；
                MAX_AGENT_LOCAL_DATA_SOURCES；MAX_AGENT_REMOTE_FS_MOUNTS；MAX_AGENT_XFS_PROJECTS；
                MAX_MANAGED_DATA_DIRS_PER_AGENT；MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE；
                MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION
utils.ts        normalizeDockerImageRef
protocol/       zDataDirEntry, zXfsProjectUsage, zDiskInfo, zRemoteFsMountStatus,
                zImageRuntimeOverrides, zCanonicalDockerRoot, zContainerQuotaPaths,
                zDockerDaemonStatus, zDockerResourceLimitStatus, zLocalImageInfo(重写),
                MountSourceDto, DataDirDto, UserDataDirDto, DataDirIssueDto,
                ImageGrantDto, MountSourceGrantDto, UserServerQuotaDto
```

**注意 `AGENTS.md` 的不变式**：删除 common 的东西之后必须跑
`find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print`
确认 `src/` 下没有残留编译产物 —— Vite 会优先解析同名 `.js` 而不是 `.ts`。

### 11.5 前端

见 §9.1。

---

## 12. 分阶段交付

每个阶段结束时仓库必须是**可 typecheck、可测、语义自洽**的。不允许出现「中间态双路径」。

**阶段 1 —— 冻结契约**
1. 本文档评审通过，特别是 §4 的物理约束与 §10 的边界矩阵。
2. 在一台真实装了 Incus 的机器上验证 §14 的待验证项。**这一步不能跳过** ——
   `security.shifted` 在 cephfs 上是否可用、延迟缩容的实际表现，都会影响设计。

**阶段 2 —— common 协议层**
3. 重写 `enums.ts`（`AgentTaskKind`、删 `DockerDaemonState`/`RemoteFsType`、改 `AuditAction`）。
4. 重写 `constants.ts`、`protocol/agent-messages.ts`、`protocol/rest.ts`、`protocol/rest-schema.ts`。
5. 此时后端和 Agent 会大面积编译失败 —— 这是预期的，作为后续阶段的工作清单。

**阶段 3 —— 数据库**
6. 重写 `000001_initial.sql`。
7. 重写 Kysely 类型（`*-database.types.ts`）。
8. `pnpm check:backend-bootstrap` 必须过（全新库能起来）。

**阶段 4 —— Agent 驱动层**
9. 生成 `incus/api-types.ts`，实现 `incus-client.ts` + `operation.ts` + `errors.ts`。
10. 实现 `instance-spec.ts`（纯函数，先写单测）。
11. 删除 `docker/`、`dropbear/`、`quota/`、`fs/`、`datadirs/`、`host-storage.ts`、
    `physical-mutation-fence.ts`。
12. 重写任务处理器：容器 7 种 + 卷 5 种 + 镜像 2 种。
13. 重写状态上报采集。
14. Agent 单测全绿。

**阶段 5 —— 后端控制面**
15. 新建 `storage-pools`、`shared-backends`、`volumes` 模块；删除 `datadirs`、
    `mount-sources`、`remote-fs`、`nfs`、`quota`。
16. 重写 `container-control.service.ts` 的创建准入（容量三约束、镜像 fingerprint 解析、
    GPU index→pci 翻译前的 index 校验）。
17. 重写 `runtime-drift-reconciler`（去掉 quotaPaths 依赖）。
18. 重写 `agent-gateway` 的准入门。
19. 重写撤销守卫与访问解析（删镜像授权、加池/共享后端授权）。
20. 新增 `container.config.apply` 与 `volume.*` 的服务与 finalizer；
    五个改容器的 REST 端点全部落到同一个任务上（§8.5）。
21. 后端单测 + pg 测试全绿。

**阶段 6 —— 前端**
22. 删镜像授权 UI、数据目录 UI、远程 FS UI。
23. 新增存储池管理、共享后端管理、数据卷页面。
24. 容器详情页的存储区与规格区，含 §9.3 的缩容编排。
25. 前端单测全绿。

**阶段 7 —— e2e 与验收**
26. e2e 环境改造（§13）。
27. `features.yaml` 重写。
28. 全量 e2e 通过。
29. `pnpm check` 全绿 + common `src/` 洁净检查 + 独立 Agent 二进制构建。

**阶段 2–6 建议按 lane 并行**：common 协议先行且是唯一的串行瓶颈；之后
「Agent 驱动」「后端控制面」「前端」可以三条线并行，各自对着已冻结的协议开发。

---

## 13. 测试策略

### 13.1 必须存在的测试（沿用原方案 §15 的形式）

**任务幂等性** —— 每种任务对同一实际状态执行两次都必须安全：

```
container.create        崩溃窗口不产生两个带同一 container_id 的实例
container.config.apply  · 已收敛时执行是 no-op，不产生任何 PUT
                        · 重复执行不累积缩容；BLOCK_BACKED 的延迟路径被正确识别
                        · 加设备 + 减设备在同一次收敛里都生效
                        · 【关键】PUT 之后 volatile.* 仍在，运维手工加的键仍在
                        · 触及非热改键且实例运行中 → 拒绝执行，不静默延迟
volume.ensure           · 不存在则建；已存在且 size 相符则 no-op
                        · 已存在但 size 不符 → 按 §7.6 收敛到期望 size（不是 managed failure）
volume.absent           对已不存在的卷执行是成功（收敛语义），不是失败
image.ensure_present    重复拉取不重复下载；fingerprint 不符是 managed failure
```

`container.config.apply` 的第四条是**回归防线**：一个天真的「PUT 期望文档」实现会抹掉
`volatile.*`（毁掉实例）和运维手工加的配置（毁掉信任）。这条测试必须存在。

**容量核算**（PostgreSQL 测试，最容易出并发 bug 的地方）：

```
并发创建两个容器，各自看余量都够、合计超出 → 恰好一个成功
并发扩容两个卷，合计超出池超分余量        → 恰好一个成功
超分系数调低到已有容量之下                → 已有资源不动，新增被拒
root_size_pending_bytes 非空时按较大值核算
共享池上的卷不进服务器核算，也不进池核算
```

**缩容能力矩阵**（对每种 `resize_family` × 每种前置状态各一条）：

```
quota_online  + 运行中 + new >= used   → 成功，在线
quota_online  + 运行中 + new <  used   → 后端拒绝（Incus 不会拒绝，这条测的是我们自己的守卫）
block_backed  + 运行中 + 数据卷        → VOLUME_SHRINK_REQUIRES_DETACH
block_backed  + 运行中 + 系统盘        → ROOT_SHRINK_REQUIRES_STOP，且【绝不】发出 Incus 请求
block_backed  + 已停止 + ext4          → 成功
block_backed  + xfs                    → *_SHRINK_UNSUPPORTED（且该池根本登记不进来）
延迟落地竞态：verify 观测到 apply_quota 非空 → 写 pending，下次 start 收尾
```

**授权撤销边界**：

```
有本地卷      → 拒绝撤销服务器授权
只有共享卷    → 允许撤销服务器授权          ← 这条是本次改动的核心语义
有卷          → 拒绝撤销池授权
有共享卷      → 拒绝撤销共享后端授权
```

**共享后端合并**：

```
两台服务器同 identity_key 同 FSID    → 合并
两台服务器同 identity_key 异 FSID    → 拒绝合并 + 告警
ceph(RBD) 池                         → shareable=false，跨服务器挂载被拒
```

**身份栅栏**：

```
user.nyabase.* 缺失或被篡改           → 不采纳为 canonical，走 runtime.absent
运维手工 incus rename 一个托管实例    → 靠 user.nyabase.container_id 识别为「改名」而非孤儿，
                                        绝不因此删除用户容器          ← §7.2 的核心防线
运维在实例上手工加一个无关设备        → compareManagedFields 忽略它，不判漂移、不抹掉  ← §8.1
在线改 CPU/内存后再上报               → 实例仍被认为是 canonical（不再有 spec hash 会失效）
```

### 13.2 e2e 环境改造（D30）

现有 e2e 是「宿主机跑 Docker 起一套 CPU 环境」。新环境需要：

```
1. 宿主机安装 incus（Debian trixie 的 6.0.4 LTS，或 Zabbly 源的较新版）
2. 预建两个 LVM thin 池，覆盖两种能力族：
     e2e-lvm   driver=lvm,  volume.block.filesystem=ext4   → block_backed（缩容需停机）
     e2e-dir   driver=dir,  底层 fs 开 project quota        → quota_online（在线缩容）
   两个池是必须的 —— §13.1 的能力矩阵测试要求两族都能跑
3. 一个私有 simplestreams 镜像源（静态文件 + 自签 HTTPS，e2e 的 CA 已经有了）
   放一个带 sshd 的最小系统镜像
4. macvlan 父网卡（e2e 里用 dummy 网卡 + macvlan 子接口）
5. 无 GPU：GPU 相关用例走「服务器无 GPU → nvidia_runtime 不启用」的分支
```

`e2e/coverage/features.yaml`（5193 行）需要按新的领域模型重写：
删除数据目录、mount source、远程 FS、镜像授权的全部条目；
新增存储池、共享后端、数据卷、热插拔、扩缩容能力矩阵、在线改规格的条目。

**共享后端（cephfs）在 e2e 里跑不起来** —— 需要真实 Ceph 集群。方案：
- e2e 覆盖到「登记共享后端 → 授权 → 校验拒绝跨服务器挂载不可达后端」这些**控制面逻辑**，
  用一个伪造的 cephfs 池上报（Agent 侧注入）。
- 真正的「两台服务器挂同一个 cephfs 卷」放进**人工验收清单**，在有 Ceph 的环境里做一次。
  这是明确的覆盖缺口，不假装它被自动化了。

---

## 14. 待实机验证项

**这些必须在阶段 1 完成，它们会反向影响设计。** 每一项都标注了「如果结论是否定的会怎样」。

**这些必须在阶段 1 完成，它们会反向影响设计。** 每一项都标注了「如果结论是否定的会怎样」。
前四项是**架构级阻塞项**，其余是实现级。

| # | 验证内容 | 若为否 |
| --- | --- | --- |
| **1** | **网络模型。** `nictype=macvlan` 是否接受 `ipv4.address`？若不接受，静态 IP 怎么给（cloud-init？镜像内配置？）。`ipvlan` / `routed` 是否接受，它们在扁平 L2 网段上的实际行为（能否被同网段其它主机访问、ARP 是否正常、宿主机能否访问自己的子接口）。NIC 设备能否热插拔/改地址 | **D22 整体重做**。SSH 代理、HTTP 代理、IP 分配与回收、`container_network_claims`、准入门的 CIDR 校验全部跟着改。这是全篇风险最高的一项 |
| **2** | **重启证明。** `GET /1.0/instances/<n>/state` 的完整字段集，有没有启动时间；`state.pid` 是否可靠；`last_used_at` 由什么更新；已完成的操作能保留多久可查（`GET /1.0/operations/{id}`） | §7.6.1 的三个候选依次降级；若三个都不成立，`container.restart` 只能退化为「stop 然后 start 两个任务」 |
| **3** | **PUT 语义。** `PUT /1.0/instances/<n>` 是否整体替换 config 映射？`volatile.*` 在 PUT 后是否保留？ETag 覆盖范围？一次 PUT 同时增删 disk 设备是否都能正确热插拔？把非热改键 PUT 到运行中实例会怎样（报错还是静默延迟到下次启动） | §7.4 的「一个收敛任务」形态不变，但实现必须走「读回→改副本→带 ETag 写回」的保守路径；若热插拔有部分失败语义，需要在 verify 里逐设备确认 |
| **4** | **配置回显保真度。** `config` 是否忠实回显写入值，还是会归一化（`limits.memory: "1GiB"` → 字节数）？`config` 与 `expanded_config` 的区别；Incus 会往 `config` 里注入哪些自己的键 | §8.1 的 `compareManagedFields` 必须在归一化后的值域上比对，否则每次对账都报假漂移 |
| 5 | `security.shifted=true` 在 **cephfs** 池上 `CanIdmapMount` 是否成功 | 共享池上的卷会拒绝启动 → 共享卷必须退回递归 chown，且不能用隔离 idmap |
| 6 | `security.shifted=true` 在 **lvm+ext4** 上是否成功 | 所有数据卷退回递归 chown，百万 inode 的卷挂载会很慢，需要在 UI 上提示 |
| 7 | Incus 实例状态的完整枚举集合与 `status_code` | §8.2 的状态映射照此定稿 |
| 8 | root disk 延迟缩容：对运行中容器设更小的 `size`，确认 API 返回 200 且 `volatile.root.apply_quota=true` | §7.6 的 pending 机制没有必要，可以简化 |
| 9 | `dir` 池缩容到低于已用量：确认 API 返回 200、后续写入 `EDQUOT`、读取仍正常 | §4.2 规则 1 的守卫可以放宽 |
| 10 | `dir` 池所在 fs 没有 project quota 时：确认 `size=` 被静默忽略，且 `GET .../volumes/<t>/<v>/state` 的 `usage` 为 null | `quota_effective` 的探测方式要换 |
| 11 | GPU 热插拔 + `nvidia.runtime`：对一个建时开了 `nvidia.runtime` 但没带卡的运行中容器热加一张卡，容器内 `nvidia-smi` 是否立刻可用 | D20「卡只能停机改」的限制是对的；若可用则可放宽 |
| 12 | `nvidia.runtime=true` 但宿主机没装 nvidia-container-toolkit：确认容器启动失败的具体错误 | `gpu_runtime_available` 的门控方式要调整 |
| 13 | 热卸载 while busy：容器内持有打开的 fd 和 cwd，卸载后确认 (a) API 成功 (b) 容器内路径消失 (c) 通过旧 fd 的写入仍落到卷上 | §10.4 的排空窗口可以取消 |
| 14 | 真实块设备背书的 LVM 池扩容流程：`pvresize` 之后 Incus 是否自动感知，还是需要 `incus storage set size=` | 运维手册要写清楚 |
| 15 | `volatile.rootfs.size` 是否可靠填充，与实际 rootfs 体积的关系 | `min_root_size_bytes` 要改用别的来源，或让管理员手填 |
| 16 | `POST /1.0/instances/<n>/files` 写 authorized_keys 的 uid/gid/mode 语义，非 root 登录用户的家目录处理；以及 `cloud-init.ssh-keys.<name>` 是否可用、是否只在首次启动生效 | D23 的注入方式要换成 `incus exec`；若 cloud-init 键可用且支持热更新，SSH 注入可以并入 `container.config.apply`，再减一个任务种类 |
| 17 | `incus --version` 与 `GET /1.0` 的 `api_extensions`，与本方案引用的 `docs/main` 键做差集 | 缺失的键需要降级方案；Debian trixie 是 6.0.4 LTS，文档是 main |
| 18 | `GET /1.0/events` 的投递保证（是否会因消费者慢而丢事件）；能否按资源过滤 `GET /1.0/operations` | 状态上报退回纯 15s 轮询，不做事件驱动 |

**第 1 项是唯一可能推翻既定决策的。** 建议阶段 1 第一天就验它，其余可以并行。

---

## 15. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 一次性重构面过大（~10k 行删除 + 全新存储域） | 中途卡住无法回退 | 分阶段交付（§12），每阶段保持仓库自洽；common 协议冻结后三条 lane 并行 |
| 自建 Incus 客户端的成熟度 | 边缘错误处理不完备 | 类型从官方 yaml 生成；只封装用到的端点；错误映射写单测；变更操作坚持「重读实际状态」而非信任返回值 |
| 系统容器语义与用户预期的落差 | 用户按 Docker 习惯用会困惑 | 镜像自带 init 与 sshd，体验更接近轻量 VM；文档与 UI 要明确说明 |
| 缩容 UX 复杂（三条路径） | 用户困惑或误操作 | 能力由后端下发，前端只渲染；每条路径的提示文案在 §9.3 已定死 |
| cephfs 共享后端无法在 e2e 覆盖 | 该路径首次上线才被真正验证 | 明确列为人工验收项（§13.2），不假装已覆盖 |
| 取消 Agent 启动强制回滚（D24） | 外部改动的实例不再被无条件归零 | 身份栅栏更严 + 定向 `runtime.absent` 清理（§7.7） |
| LVM thin 超分兑现失败 | 扩容或写入时物理空间真的用尽 | 默认超分系数 1.0，超分是管理员的显式选择；池实际用量持续上报并告警 |

---

## 16. 架构审查：刻意不带过来的 Docker 包袱

本节记录一次专门针对「历史包袱」的复审结论。现有架构里有大量机制是**在 Docker 的信息缺失下
被迫发明的补偿手段**，它们在 Incus 下没有存在理由。原样搬过来会让新架构从第一天就带着
一个更强接口不需要的复杂度。

判据统一为一句话：**这个机制是在解决领域问题，还是在补偿 Docker 的缺陷？**

### 16.1 删掉的补偿机制

| 机制 | 它补偿的 Docker 缺陷 | Incus 下为什么不需要 |
| --- | --- | --- |
| **`runtime_spec_hash`** | 容器配置创建后不可变，且 inspect 输出无法回推创建规格 | 配置可变且忠实回显，直接比对（§8.1）。顺带消灭了「哈希输入要不要拆成可变/不可变两类」这个我上一版自己制造的问题 |
| **按操作切分的 5 个变更任务** | 每次配置变更都是一次不可逆的独立容器操作 | 配置是一份可变文档，`PUT` 的语义就是收敛。合并为一个 `container.config.apply`（§7.4） |
| **`volume.resize` 独立任务** | 同上 | `volume.ensure` 的语义是「存在且大小恰好为 X」，创建与扩缩容是同一个收敛动作 |
| **`volume_attachments` 的 per-row 状态机** | bind mount 创建后不可变，改挂载=重建容器，所以挂载像一个独立资源 | 挂载是容器设备集合的一部分，归容器的 generation（§6.7） |
| **`quota_paths`（两个 overlay 目录）+ XFS project quota + `/etc/projects`** | Docker 不做磁盘配额，必须自己在宿主机文件系统层实现 | 每个卷自带 `size=`。整条链路（`quota.ensure` 任务、`quota_desired` 表、`numericOwnerId`、原子交换助手、跨进程变更栅栏）一起消失 |
| **`dockerRoot` + 单 XFS 设备拓扑证明 + 热换盘 fence** | 配额实现依赖「所有数据都在同一个开了 pquota 的 XFS 上」 | 物理布局归 Incus 管，控制面不再有物理路径概念 |
| **DataDir 的 `.creating`/`.deleting` 原子改名协议、identity marker、pinned-fd 变更** | Agent 直接操作裸目录，崩溃可能留下不可判定的中间态 | 卷的创建/删除是 incusd 的一次原子操作 |
| **RemoteFS 挂载器 + `agent.bootstrap.v1` 会话内 rehydrate** | 无状态 Agent 重启后丢失挂载表，需要后端重新灌入 | Incus 自己持久化卷；共享存储由 Incus 池承载。**整个 bootstrap 握手跳被删除**（§8.7） |
| **`DockerDaemonState` 状态机 + 专属 dockerd systemd 单元 + 宿主机 cgroup 预算** | Agent 需要独占一个 Docker 守护进程 | incusd 是系统级服务，不归 Agent 管 |
| **启动时无条件停掉所有托管容器** | 无法可靠区分「我管的」和「外面改的」，只能全部归零 | 身份键 + 精确定址 + 定向 `runtime.absent`（D24 / §7.7） |
| **`ContainerStatus` 的 `exited`/`dead`/`paused`** | Docker 的状态词汇 | 直接用 Incus 的状态集合，不做中间翻译表（§8.2） |
| **状态上报里逐字段展开的规格镜像** | Docker inspect 的结构与创建规格不同构，只能手工挑字段映射 | 上报 `managedConfig` / `managedDevices` 两个映射，后端与期望文档直接比。新增受管键时协议零改动（§8.2） |
| **`normalizeDockerImageRef`（补 `library/`、补 `:latest`、拒绝 digest）** | Docker 镜像引用是有歧义的字符串语法 | 镜像是 alias + SHA256 fingerprint，创建时钉死 fingerprint |
| **镜像的独立授权体系** | 与运行时无关，是产品决策（D）| 镜像跟随服务器 |

### 16.2 大量 fail-stop 可以降级

现有 Agent 有相当多的 `SIGKILL 自己` 路径（变更子进程超时、存储身份漂移、模糊的 Docker 变更）。
它们存在的根本原因是：**Agent 直接执行物理变更，一次结果模糊的变更之上如果后端重放，
可能造成不可逆的破坏**（例如在一次进行中的递归删除之上再删一次）。

Incus 下，所有物理变更都由 incusd 串行化并带操作 ID，Agent 退化成一个 HTTP 客户端。
「变更结果模糊」的正确表达是 `incomplete`（保留锁、由后端按不确定性边界收敛或隔离），
而不是杀死进程。

因此：**保留 fail-stop 的场合应大幅收窄**，只留下真正无法用 `incomplete` 表达的情况
（例如宿主机身份指纹在运行中改变）。`physical-mutation-fence.ts` 整体删除，
`isolated-command.ts` / 60 秒硬超时自杀 / 变更子进程模型一并删除。

这不是放松安全性，而是把安全性从「进程自杀」换成 Incus 已经提供的「操作串行化 + 操作 ID」。

### 16.3 刻意保留的东西，以及为什么

复审同样要防止另一个方向的错误：因为 Incus 更强，就把控制面自己的核心机制也一起删掉。

| 保留 | 为什么不能靠 Incus |
| --- | --- |
| **持久任务模型**（`workflow.tasks` + 资源锁 + finalizer） | Incus 有操作但没有**跨主机的、有身份的、可问责的变更所有权**。删掉它就退化成一个 reconcile loop —— 失败形态变成「它一直在重试」，用户看不到「这次为什么没成」。正确的调整是改任务的**粒度**（一个命令 → 一次收敛），不是取消任务 |
| **`desired_generation` / `observed_generation`** | 这是控制面自己的版本号，用于 supersede 过期任务、识别漂移。Incus 不可能提供 |
| **`user.nyabase.container_id`** | 严格说与派生实例名冗余。保留它是为了识别**运维手工 `incus rename`** —— 否则仅靠名字查找会把改名后的实例判成孤儿并删掉用户的容器 |
| **后端自己的容量核算**（§5.3 三条约束） | Incus 的 `limits.disk.pool.<POOL>` 只在启用 projects 时可用，而 D17 决定不用。而且跨服务器的用户额度与共享后端额度本来就超出单台 Incus 的视野 |
| **后端分配 IP + `container_network_claims`** | macvlan 挂在非托管的物理父网卡上，Incus 没有 IPAM。排空窗口（`reusableAt`）也是代理租约的要求，Incus 不知道代理的存在 |
| **`compareManagedFields` 只比对受管键** | 必须容忍运维在实例上手工加东西。一个「期望文档即全部真相」的天真实现会把它们抹掉 |
| **能力矩阵由后端下发** | 池的驱动能力（能否在线缩容）Incus **不通过 API 暴露**（`BlockBacking`/`VolumeMultiNode` 都是内部标志），只能按驱动名硬编码在一处，再下发 |

### 16.4 复审带来的净变化

```
AgentTaskKind          18 种  →  12 种   （现状 14 种）
容器身份键              5 个  →   4 个
containers 表           删除 runtime_spec_hash
volume_attachments 表   删除 desired_state / generation / last_task_id
volumes 表              删除 desired_state='resizing'
状态上报                 6 个逐字段镜像 → 2 个映射
握手                    删除 agent.bootstrap.v1 整跳，会话状态机少一态
§8.1                    从「拆分哈希输入的规则表」变成「删掉哈希」
```

### 16.5 仍然待定、且会进一步简化的两处

- **验证项 16**：若 `cloud-init.ssh-keys.<name>` 可用且支持热更新，`container.ssh.ensure`
  可以并入 `container.config.apply`，任务种类再减一，SSH 注入从「往容器里写文件」变成
  「改一个配置键」。这会是又一处从命令式回到声明式的收敛。
- **验证项 2**：若 Incus 的操作保留窗口足够长且可按资源查询，`container.restart` 的
  「基线 + 比对」可以换成「操作 ID + 重新挂接」，把「这次重启到底发生了没有」
  从推断变成查询。

