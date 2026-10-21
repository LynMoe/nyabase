import { type ContainerPhase, type ContainerStatus, FailureCode, type ServerStatus } from '@nyabase/common';

type ContainerSshStatus =
  | 'disabled'
  | 'container_stopped'
  | 'running'
  | 'error'
  | 'unknown'
  | 'key_applied_sshd_missing';

const CONTAINER_STATUS_ZH: Record<string, string> = {
  creating: '创建中',
  running: '运行中',
  stopped: '已停止',
  frozen: '已冻结',
  error: '错误',
  unknown: '未知',
};

const LIFECYCLE_PHASE_ZH: Record<string, string> = {
  provisioning: '创建中',
  active: '正常',
  deleting: '删除中',
  failed: '失败',
};

const SSH_STATUS_ZH: Record<string, string> = {
  disabled: '未启用',
  container_stopped: '容器已停止',
  running: '可登录',
  error: '异常',
  unknown: '未知',
  key_applied_sshd_missing: '密钥已下发，sshd 未就绪',
};

const SERVER_STATUS_ZH: Record<string, string> = {
  online: '在线',
  unreachable: '不可达',
  unknown: '未知',
};

const FAILURE_CODE_ZH: Partial<Record<string, string>> = {
  [FailureCode.RevisionConflict]: '版本冲突，请刷新后重试',
  [FailureCode.StorageGrantExceeded]: '存储授权不足',
  [FailureCode.StoragePoolExhausted]: '存储池容量不足',
  [FailureCode.StoragePoolQuotaIneffective]: '存储池配额无效',
  [FailureCode.StoragePoolInUse]: '存储池仍在使用中',
  [FailureCode.SharedBackendQuotaExceeded]: '共享后端配额不足',
  [FailureCode.SharedBackendInUse]: '共享后端仍在使用中',
  [FailureCode.SharedBackendIdentityConflict]: '共享后端 FSID 冲突',
  [FailureCode.VolumeShrinkBelowUsage]: '目标容量小于已用量',
  [FailureCode.VolumeShrinkRequiresDetach]: '缩容前需先卸载挂载',
  [FailureCode.VolumeShrinkUnsupported]: '该池不支持缩容',
  [FailureCode.VolumeUsageUnknown]: '已用量未知，无法缩容',
  [FailureCode.VolumeRequiresUnbind]: '请先从容器卸载该卷',
  [FailureCode.VolumeDeleteBackendUnreachable]: '没有在线服务器可以访问该共享存储，请联系管理员',
  [FailureCode.VolumeDetachRequiresStop]: '请先停止容器',
  [FailureCode.VolumeCrossServerDenied]: '不允许跨服务器挂载该卷',
  [FailureCode.RootShrinkBelowUsage]: '系统盘目标小于已用量',
  [FailureCode.RootUsageUnknown]: '系统盘已用量未知，无法缩容',
  [FailureCode.RootShrinkRequiresStop]: '缩容前需先停止容器',
  [FailureCode.RootQuotaPending]: '系统盘容量调整尚未生效',
  [FailureCode.RootSizeBelowImageMinimum]: '小于镜像要求的最小系统盘',
  [FailureCode.GpuNotEnabled]: '服务器未启用 GPU',
  [FailureCode.GpuOccupied]: 'GPU 仍被容器占用',
  [FailureCode.GpuDeviceClaimed]: 'GPU 已被占用',
  [FailureCode.GpuMutationRequiresStop]: '变更 GPU 前需先停止容器',
  [FailureCode.GpuGrantNotApplicable]: 'GPU 授权不适用于此服务器',
  [FailureCode.GpuRuntimeUnavailable]: 'GPU 运行时不可用',
  [FailureCode.GpuInvalidPci]: 'PCI 地址无效',
  [FailureCode.GpuWildcardForbidden]: '禁止使用通配符 PCI 选择器',
  [FailureCode.GpuDuplicatePci]: 'PCI 地址重复',
  [FailureCode.VolumeCatalogAdoptFailed]: '共享卷未能登记到本机 Incus',
  [FailureCode.VolumePlacementFailed]: '卷尚未在目标服务器就绪',
  [FailureCode.ImageManagesOwnNetwork]: '镜像自行管理网络',
  [FailureCode.ImageNotAvailable]: '镜像不可用',
  [FailureCode.ImageAssignmentFingerprintMismatch]: '镜像指纹不一致',
  [FailureCode.ImageInUse]: '镜像仍在使用中',
  [FailureCode.ServerUnreachable]: '服务器不可达',
  [FailureCode.ServerAlreadyConnected]: '服务器已连接',
  [FailureCode.TrustTokenExpired]: '信任令牌已过期',
  [FailureCode.InstanceBusy]: '实例忙碌，请稍后重试',
  [FailureCode.PreflightCleanupFailed]: '预检清理失败',
  [FailureCode.PreflightFailed]: '预检失败',
  [FailureCode.PermissionDenied]: '权限不足',
  [FailureCode.NotFound]: '资源不存在',
  [FailureCode.InvalidInput]: '参数无效',
  [FailureCode.InternalError]: '内部错误',
};

function labelOrRaw(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

/** Chinese label for container actual status; keep raw value for title/tooltip. */
export function containerStatusLabel(status: ContainerStatus | string): string {
  return labelOrRaw(CONTAINER_STATUS_ZH, status);
}

export function lifecyclePhaseLabel(phase: ContainerPhase | string): string {
  return labelOrRaw(LIFECYCLE_PHASE_ZH, phase);
}

/** Alias for volume / resource lifecycle badges (same phase vocabulary). */
export function volumeLifecycleLabel(phase: string): string {
  return lifecyclePhaseLabel(phase);
}

export function sshStatusLabel(status: ContainerSshStatus | string): string {
  return labelOrRaw(SSH_STATUS_ZH, status);
}

export function serverStatusLabel(status: ServerStatus | string): string {
  return labelOrRaw(SERVER_STATUS_ZH, status);
}

export function failureCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return FAILURE_CODE_ZH[code] ?? code;
}

export function volumeAttentionHint(failureCode: string | null | undefined): string {
  if (failureCode === FailureCode.VolumeShrinkBelowUsage) {
    return '缩容失败：目标容量小于已用量。目标容量已恢复为当前容量，不会自动重试。请查看操作历史。';
  }
  if (failureCode === FailureCode.VolumeUsageUnknown) {
    return '缩容失败：已用量未知。目标容量已恢复为当前容量，不会自动重试。请查看操作历史。';
  }
  const codeHint = failureCodeLabel(failureCode);
  if (codeHint && codeHint !== failureCode) {
    return `操作失败：${codeHint}。可重试或联系管理员。`;
  }
  if (failureCode) {
    return `操作失败（${failureCode}）。可重试或联系管理员。`;
  }
  return '操作失败，请查看操作记录后重试，或联系管理员。';
}

export function containerActionSubmittedTitle(
  action: 'start' | 'stop' | 'restart' | 'delete' | 'create',
): string {
  const labels = {
    start: '启动',
    stop: '停止',
    restart: '重启',
    delete: '删除',
    create: '创建',
  } as const;
  return `已提交${labels[action]}，正在生效`;
}

const INTENT_STATUS_ZH: Record<string, string> = {
  pending: '进行中',
  succeeded: '已完成',
  failed: '失败',
};

const INTENT_KIND_ZH: Record<string, string> = {
  'container.create': '创建容器',
  'container.update': '更新容器',
  'container.power': '电源操作',
  'container.delete': '删除容器',
  'volume.ensure': '确保数据卷',
  'volume.resize': '调整数据卷',
  'volume.destroy': '销毁数据卷',
  'image_assignment.ensure': '分配镜像',
  'image_assignment.delete': '取消镜像分配',
  'server.connect': '连接服务器',
  'server.preflight': '服务器预检',
};

const INTENT_RESOURCE_TYPE_ZH: Record<string, string> = {
  container: '容器',
  volume: '数据卷',
  image_assignment: '镜像分配',
  server: '服务器',
};

export function intentStatusLabel(status: string): string {
  return labelOrRaw(INTENT_STATUS_ZH, status);
}

export function intentKindLabel(kind: string): string {
  return labelOrRaw(INTENT_KIND_ZH, kind);
}

export function intentResourceTypeLabel(resourceType: string): string {
  return labelOrRaw(INTENT_RESOURCE_TYPE_ZH, resourceType);
}
