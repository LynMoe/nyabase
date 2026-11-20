import {
  FailureCode,
  StoragePoolResizeFamily,
  type StoragePoolDto,
  type VolumeAttachmentDto,
  type VolumeDto,
  zStorageMountPath,
} from '@nyabase/common';
import { ApiError, apiErrorDetails, errorMessage } from './api-error.js';
import { volumeInProgress } from './in-progress.js';
import { volumeAttentionHint } from './status-labels.js';

/** A pool's name as people know it: the administrators' remark, else the Incus name. */
export function poolDisplayName(pool: Pick<StoragePoolDto, 'displayName' | 'incusName'>): string {
  return pool.displayName ?? pool.incusName;
}

/** Local pools of the server that can be listed as data disks, plus the ones the list already holds. */
export function grantablePools(
  pools: readonly StoragePoolDto[],
  serverId: string,
  held: readonly string[] = [],
): StoragePoolDto[] {
  return pools.filter((pool) => pool.serverId === serverId
    && !pool.shareable
    && (pool.registered || held.includes(pool.id)));
}

/** Why a local pool cannot be enabled as a data disk; null when it can. */
export function mountUnsupportedReason(
  pool: Pick<StoragePoolDto, 'registered' | 'resizeFamily' | 'quotaEffective'>,
): string | null {
  if (!pool.registered) return '存储池尚未登记，登记后才能作为数据盘。';
  if (pool.resizeFamily !== StoragePoolResizeFamily.QuotaOnline) {
    return '块设备存储池不能作为数据盘：卷挂在运行中的容器里时无法在线调整配额，也不能同时挂进多个容器。';
  }
  if (pool.quotaEffective !== true) return '存储池的配额未生效（或未知），不能作为数据盘。';
  return null;
}

/** A typed mount path: '' = not a data disk (null); a valid path, normalized; else the problem. */
export function parseMountPathInput(text: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  const parsed = zStorageMountPath.safeParse(trimmed);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0]?.message ?? '';
  if (/system directory/.test(issue)) return { ok: false, error: '不能挂载在系统目录（如 /etc、/usr、/var、/root、/home、/tmp）上' };
  if (/proc, \/sys or \/dev/.test(issue)) return { ok: false, error: '不能挂载在 /proc、/sys、/dev 下' };
  return { ok: false, error: '请输入以 / 开头的绝对路径（不能是 /，不能含 . 或 .. 段）' };
}

/** The status of a mount in a container, for the storage panel. */
export function mountStatus(attachment: Pick<VolumeAttachmentDto, 'bindState' | 'maintenance'>): {
  label: string;
  hint: string | null;
  tone: 'ok' | 'pending' | 'warning';
} {
  if (attachment.bindState === 'detaching') return { label: '卸载中', hint: null, tone: 'pending' };
  if (attachment.maintenance) return { label: '维护中', hint: '盘维护中，暂未挂载', tone: 'warning' };
  if (attachment.bindState === 'blocked') {
    return { label: '未挂载', hint: '挂载点在容器里已有文件：清空或移走后重启容器即可挂载', tone: 'warning' };
  }
  if (attachment.bindState === 'attaching') return { label: '挂载中', hint: null, tone: 'pending' };
  return { label: '已挂载', hint: null, tone: 'ok' };
}

/** How one of the user's disks stands, from the disk's settings and the user's volume on it. */
export function userDiskState(
  disk: { mountPath: string | null; maintenance: boolean } | undefined,
  volume: Pick<VolumeDto, 'needsAttention' | 'lifecyclePhase' | 'observedRevision' | 'revision' | 'failureCode'> | undefined,
): { label: string; variant: 'success' | 'secondary' | 'destructive' | 'warning'; pending: boolean; hint: string | null } {
  if (volume?.needsAttention) {
    return { label: '需要关注', variant: 'destructive', pending: false, hint: volumeAttentionHint(volume.failureCode) };
  }
  if (volume?.lifecyclePhase === 'deleting') return { label: '删除中', variant: 'secondary', pending: true, hint: null };
  if (disk && disk.mountPath === null) {
    return { label: '未启用', variant: 'secondary', pending: false, hint: '管理员尚未启用这块盘，暂不挂载' };
  }
  if (disk?.maintenance) return { label: '维护中', variant: 'warning', pending: false, hint: '盘维护中，暂未挂载到容器' };
  if (!volume || volume.lifecyclePhase === 'provisioning') {
    return { label: '准备中', variant: 'secondary', pending: true, hint: '正在创建数据卷，完成后自动挂载' };
  }
  return { label: '可用', variant: 'success', pending: volumeInProgress(volume), hint: null };
}

/** Storage mutation errors in words an administrator can act on; unknown codes keep the server's message. */
export function storageErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case FailureCode.StorageMountPathConflict: {
        const path = apiErrorDetails(error)?.mountPath;
        return `挂载点${typeof path === 'string' ? ` ${path} ` : ''}与其他盘的挂载点相同或互相嵌套（同一台服务器的本地盘与所有共享存储不能重叠）。`;
      }
      case FailureCode.StorageMountUnsupported:
        return '该存储池不能作为数据盘：需已登记、支持在线配额且配额生效。';
      case FailureCode.VolumeStillGranted:
        return '仍有授权覆盖该盘，请先撤销授权。';
      case FailureCode.VolumeRequiresUnbind:
        return '卷仍挂载在容器里。撤销授权后会很快自动卸载，请稍后再删除。';
      case FailureCode.VolumeDeleteBackendUnreachable:
        return '没有在线服务器能访问该共享存储，暂时无法删除。';
      case FailureCode.RevisionConflict:
        return '已被他人修改，请刷新后重试。';
      default:
        break;
    }
  }
  return errorMessage(error, '操作失败');
}
