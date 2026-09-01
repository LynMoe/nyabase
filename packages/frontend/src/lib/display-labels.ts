import { Capability, ResourceLifecyclePhase, ServerStatus, UserStatus } from '@nyabase/common';

export function userStatusLabel(status: string): string {
  switch (status) {
    case UserStatus.Active:
    case 'active':
      return '正常';
    case UserStatus.Disabled:
    case 'disabled':
      return '已停用';
    case UserStatus.Deleting:
    case 'deleting':
      return '删除中';
    case UserStatus.Deleted:
    case 'deleted':
      return '已删除';
    default:
      return status;
  }
}

export function serverStatusLabel(status: string): string {
  switch (status) {
    case ServerStatus.Online:
    case 'online':
      return '在线';
    case ServerStatus.Unreachable:
    case 'unreachable':
      return '不可达';
    case ServerStatus.Unknown:
    case 'unknown':
      return '未知';
    default:
      return status;
  }
}

export function capabilityLabel(capability: string): string {
  switch (capability) {
    case Capability.ManageUsers:
      return '管理用户';
    case Capability.ManageGroups:
      return '管理用户组';
    case Capability.ManageServers:
      return '管理服务器';
    case Capability.ManageImages:
      return '管理镜像';
    case Capability.ManageStoragePools:
      return '管理存储池';
    case Capability.ManageIpPools:
      return '管理 IP 池';
    case Capability.ManageSharedBackends:
      return '管理共享存储';
    case Capability.ManageVolumes:
      return '管理本地数据卷';
    case Capability.ManageSharedVolumes:
      return '管理共享卷';
    case Capability.ManageGrants:
      return '管理授权';
    case Capability.ManageContainersAny:
      return '管理全部容器';
    case Capability.ManagePreflight:
      return '管理前置检查';
    case Capability.ManageCertificates:
      return '管理证书';
    case Capability.ViewAudit:
      return '查看审计';
    case Capability.ViewMetricsAll:
      return '查看全部指标';
    case Capability.ManageSystemSettings:
      return '管理系统设置';
    default:
      return capability;
  }
}

export function lifecyclePhaseLabel(phase: string): string {
  switch (phase) {
    case ResourceLifecyclePhase.Provisioning:
    case 'provisioning':
      return '配置中';
    case ResourceLifecyclePhase.Active:
    case 'active':
      return '已生效';
    case ResourceLifecyclePhase.Deleting:
    case 'deleting':
      return '删除中';
    case ResourceLifecyclePhase.Failed:
    case 'failed':
      return '失败';
    default:
      return phase;
  }
}

export function preflightStatusLabel(status: string): string {
  switch (status) {
    case 'not_run':
      return '未运行';
    case 'running':
      return '检查中';
    case 'passed':
      return '已通过';
    case 'failed':
      return '未通过';
    default:
      return status;
  }
}

export function preflightCheckLabel(name: string): string {
  const labels: Record<string, string> = {
    api: 'API 连通',
    parentInterface: 'LAN 网桥 (vmbr)',
    gpuRuntime: 'GPU 运行时',
    nftables: 'nftables',
    ipv4Filtering: 'IPv4 防伪',
    guestCanReachHost: '容器可达宿主',
    networkPrerequisites: '网络前置条件',
    storagePool: '存储池',
    simplestreamsImage: '镜像源',
    guestAddress: '容器 IP',
    egress: '出站网络',
    nodeMetrics: '节点指标',
  };
  return labels[name] ?? name;
}

export function preflightResultLabel(result: string): string {
  switch (result) {
    case 'pass':
      return '通过';
    case 'warn':
      return '警告';
    case 'fail':
      return '失败';
    case 'not_applicable':
      return '不适用';
    default:
      return result;
  }
}

export function grantExpiryPhaseLabel(phase: string): string {
  switch (phase) {
    case 'live':
      return '有效';
    case 'grace':
      return '宽限中';
    case 'lost':
      return '已失效';
    default:
      return phase;
  }
}

export function nodeMetricsStatusZh(status: string): string {
  switch (status) {
    case 'online':
      return '在线';
    case 'unreachable':
      return '不可达';
    case 'unknown':
      return '未知';
    case 'unconfigured':
      return '未配置';
    default:
      return status;
  }
}
