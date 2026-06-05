# Requirements

## Original user objective

根据 `TEST_DEPLOY.md` 文档，在本地部署服务器，在一个 CPU 和一个 GPU 服务器上安装 agent 并连接到本服务器。确保以下功能正常：

- Agent:
  - 基础上报
  - 容器创建 / 删除
  - 强制删除
  - shell
  - 本地挂载：XFS 配额、同用户跨容器
  - 远程挂载：可在本地安装 NFS 服务器用于测试
  - GPU 信息上报：占用、温度、频率等基础信息
  - GPU 占用上报：显存细化到每个容器占用大小
- Backend:
  - 用户管理
  - 权限：容器、配额（含 GPU）、镜像、服务器
  - 镜像管理
  - 服务器管理
  - 资源指标存储及显示
  - 存储管理
  - 容器管理
- 建立完整测试清单，逐个测试并更新状态。
- 测试批次结束后进行修复。
- 不同职责需启动多个 subagent。
- 运行中不要询问用户信息，自闭环完成任务。
- Bug 修复需使用完整的架构设计、开发、测试逻辑。

## Scope

Included:

- Use `TEST_DEPLOY.md` as the authoritative deployment runbook.
- Deploy local VictoriaMetrics, backend, and frontend for the test environment.
- Build and deploy agent binary to the documented CPU host `root@10.8.96.91`.
- Build and deploy agent binary to the documented GPU host `lyn@10.8.1.12` with sudo.
- Register or configure CPU/GPU agent servers against the local backend using available app/API flows.
- Create and maintain a requirement-level test checklist covering every requested Agent and Backend capability.
- Execute verification batches, record current status/evidence, and route failures to the correct role.
- Fix product bugs found during verification through design -> implementation -> test -> review loops.

Excluded unless required by the requested verification:

- Production hardening beyond test deployment.
- Permanently changing unrelated host services outside the documented test paths.
- Rewriting the product architecture unrelated to failing acceptance criteria.

## Constraints and Context

- Workspace root: `/root/nyabase`.
- Current date/time source for this session: UTC session id `20260601T162323Z`.
- Local project is not currently a Git worktree (`git status` fails), so evidence must come from file state, command output, runtime behavior, and harness records rather than Git diff.
- Project invariant: no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` under `packages/common/src/**`.
- User explicitly requested self-contained execution without asking questions; this session treats the provided objective as the confirmed requirement baseline and records any unresolved environment facts as test evidence instead of stopping for clarification.

## Acceptance Criteria

1. Local VictoriaMetrics is running and accepts queries on `127.0.0.1:8428`.
2. Local backend starts from the test environment and `/api/auth/me` returns `401` unauthenticated.
3. Local frontend starts and serves HTML.
4. CPU agent is installed on `10.8.96.91`, connects to the backend, and reports baseline server metrics.
5. GPU agent is installed on `10.8.1.12`, connects to the backend, and reports GPU inventory plus utilization, memory, temperature, power/frequency metrics where supported by `nvidia-smi`.
6. Agent container create/delete/force-delete flows work on at least one CPU server and one GPU server where applicable.
7. Agent shell attachment works for a created container.
8. Local mount flows work, including XFS quota enforcement and same-user cross-container access semantics.
9. Remote mount flow works using an NFS server installed/configured locally or otherwise available in the test environment.
10. GPU container accounting reports per-container GPU memory usage with container-level attribution.
11. Backend user management works for create/list/update/delete or equivalent supported lifecycle.
12. Backend permission enforcement works for containers, quota including GPU quota, images, and servers.
13. Backend image management works for list/create/update/delete or equivalent supported lifecycle.
14. Backend server management works for register/list/update/delete and agent-token lifecycle.
15. Backend resource metrics are stored and displayed/retrievable through product APIs/UI.
16. Backend storage management works for local and remote storage definitions and lifecycle.
17. Backend container management works for create/list/detail/update/delete/force-delete/shell flows.
18. A complete test checklist exists and every item has a status, evidence, and next action.
19. Every failing product issue found in a completed batch is either fixed and retested, or remains recorded with current blocker evidence if external infrastructure prevents completion after repeated attempts.
20. `bash scripts/check.sh` passes after code changes, and visual checks run when rendered frontend output is changed.

## Execution Notes

- Interactive harness confirmation gates are intentionally not used for this continuation because the active user objective explicitly says not to ask for user information and to complete the task self-contained.
- Subagents are required and will be used for architecture, implementation, testing, devops, review, and focused read-only code inventory.
