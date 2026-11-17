import {
  CONTAINER_SCRIPT_MAX_FILE_BYTES,
  CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES,
  ContainerScriptPauseReason,
  ContainerScriptRunStatus,
  ContainerScriptStatus,
  ContainerScriptStoppedPolicy,
  ContainerScriptTargetState,
  ContainerScriptTrigger,
  FailureCode,
  type ContainerScriptCounts,
  type ContainerScriptDto,
  type ContainerScriptFileOwner,
  type ContainerScriptPersonRef,
  type ContainerScriptScope,
  type ContainerScriptVersionDto,
} from '@nyabase/common';
import { ApiError, apiErrorDetails, errorMessage } from './api-error.js';
import { formatBytes } from './utils.js';

export type ScriptBadgeTone = 'success' | 'secondary' | 'destructive' | 'warning' | 'info';

export type ScriptTriggerKey = 'now' | 'new' | 'boot';

/** The trigger badges of a script: 立即 / 新容器 / 每次开机 (每次开机 already covers new containers). */
export function scriptTriggerBadges(
  script: Pick<ContainerScriptDto, 'everyBoot'>,
  version: Pick<ContainerScriptVersionDto, 'applyNow' | 'onNewContainers'>,
): Array<{ key: ScriptTriggerKey; label: string }> {
  const badges: Array<{ key: ScriptTriggerKey; label: string }> = [];
  if (version.applyNow) badges.push({ key: 'now', label: '立即' });
  if (version.onNewContainers && !script.everyBoot) badges.push({ key: 'new', label: '新容器' });
  if (script.everyBoot) badges.push({ key: 'boot', label: '每次开机' });
  return badges;
}

/** 全部容器, or the non-empty filters (`2 台服务器 · 1 个镜像`), and how many containers are excluded. */
export function scopeSummary(scope: ContainerScriptScope): string {
  const parts: string[] = [];
  if (scope.all) {
    parts.push('全部容器');
  } else {
    if (scope.serverIds.length > 0) parts.push(`${scope.serverIds.length} 台服务器`);
    if (scope.imageIds.length > 0) parts.push(`${scope.imageIds.length} 个镜像`);
    if (scope.ownerIds.length > 0) parts.push(`${scope.ownerIds.length} 个用户`);
    if (scope.containerIds.length > 0) parts.push(`${scope.containerIds.length} 个容器`);
    if (parts.length === 0) parts.push('未选择范围');
  }
  if (scope.excludeContainerIds.length > 0) parts.push(`排除 ${scope.excludeContainerIds.length} 个`);
  return parts.join(' · ');
}

const STATUS: Record<ContainerScriptStatus, { label: string; tone: ScriptBadgeTone }> = {
  [ContainerScriptStatus.Active]: { label: '启用', tone: 'success' },
  [ContainerScriptStatus.Paused]: { label: '已暂停', tone: 'warning' },
  [ContainerScriptStatus.Archived]: { label: '已归档', tone: 'secondary' },
};

const PAUSE_REASON: Record<ContainerScriptPauseReason, { short: string; banner: string }> = {
  [ContainerScriptPauseReason.Manual]: { short: '手动', banner: '已手动暂停。' },
  [ContainerScriptPauseReason.Canary]: { short: '灰度完成', banner: '灰度已完成，确认结果后点“恢复”继续。' },
  [ContainerScriptPauseReason.Failures]: { short: '失败过多', banner: '失败容器达到阈值，已自动暂停。' },
};

/** 启用 / 已暂停（灰度完成） / 已归档. */
export function scriptStatusBadge(
  script: Pick<ContainerScriptDto, 'status' | 'pauseReason'>,
): { label: string; tone: ScriptBadgeTone } {
  const base = STATUS[script.status] ?? { label: script.status, tone: 'secondary' as const };
  if (script.status === ContainerScriptStatus.Paused && script.pauseReason) {
    const reason = PAUSE_REASON[script.pauseReason]?.short ?? script.pauseReason;
    return { label: `${base.label}（${reason}）`, tone: base.tone };
  }
  return base;
}

/** Why the script is paused, for the detail page's banner; null when it is not paused. */
export function pauseBannerText(script: Pick<ContainerScriptDto, 'status' | 'pauseReason'>): string | null {
  if (script.status !== ContainerScriptStatus.Paused) return null;
  if (!script.pauseReason) return '已暂停。';
  return PAUSE_REASON[script.pauseReason]?.banner ?? '已暂停。';
}

const TARGET_STATE: Record<ContainerScriptTargetState, { label: string; tone: ScriptBadgeTone; pending: boolean }> = {
  [ContainerScriptTargetState.Pending]: { label: '待执行', tone: 'warning', pending: false },
  [ContainerScriptTargetState.Waiting]: { label: '等待开机', tone: 'secondary', pending: false },
  [ContainerScriptTargetState.Running]: { label: '执行中', tone: 'info', pending: true },
  [ContainerScriptTargetState.Succeeded]: { label: '成功', tone: 'success', pending: false },
  [ContainerScriptTargetState.Failed]: { label: '失败', tone: 'destructive', pending: false },
  [ContainerScriptTargetState.Skipped]: { label: '已跳过', tone: 'secondary', pending: false },
  [ContainerScriptTargetState.Exempt]: { label: '不执行', tone: 'secondary', pending: false },
};

/** Counts and filters list the states in this order. */
export const TARGET_STATE_ORDER: ContainerScriptTargetState[] = [
  ContainerScriptTargetState.Succeeded,
  ContainerScriptTargetState.Failed,
  ContainerScriptTargetState.Running,
  ContainerScriptTargetState.Pending,
  ContainerScriptTargetState.Waiting,
  ContainerScriptTargetState.Skipped,
  ContainerScriptTargetState.Exempt,
];

export function targetStateBadge(state: ContainerScriptTargetState) {
  return TARGET_STATE[state] ?? { label: state, tone: 'secondary' as const, pending: false };
}

/** What each state means, for hover hints. */
export const TARGET_STATE_HINTS: Record<ContainerScriptTargetState, string> = {
  [ContainerScriptTargetState.Pending]: '已到期，容器运行且有空闲名额时执行',
  [ContainerScriptTargetState.Waiting]: '已到期，等容器开机后执行',
  [ContainerScriptTargetState.Running]: '正在执行',
  [ContainerScriptTargetState.Succeeded]: '已执行成功',
  [ContainerScriptTargetState.Failed]: '尝试次数已用完',
  [ContainerScriptTargetState.Skipped]: '发布时容器已停机，已跳过',
  [ContainerScriptTargetState.Exempt]: '此版本不要求在这个容器上执行',
};

const RUN_STATUS: Record<ContainerScriptRunStatus, { label: string; tone: ScriptBadgeTone; pending: boolean }> = {
  [ContainerScriptRunStatus.Running]: { label: '执行中', tone: 'info', pending: true },
  [ContainerScriptRunStatus.Succeeded]: { label: '成功', tone: 'success', pending: false },
  [ContainerScriptRunStatus.Failed]: { label: '失败', tone: 'destructive', pending: false },
  [ContainerScriptRunStatus.TimedOut]: { label: '超时', tone: 'destructive', pending: false },
  [ContainerScriptRunStatus.Interrupted]: { label: '中断', tone: 'warning', pending: false },
};

export function runStatusBadge(status: ContainerScriptRunStatus) {
  return RUN_STATUS[status] ?? { label: status, tone: 'secondary' as const, pending: false };
}

const TRIGGER: Record<ContainerScriptTrigger, string> = {
  [ContainerScriptTrigger.Now]: '立即',
  [ContainerScriptTrigger.NewContainer]: '新容器',
  [ContainerScriptTrigger.Boot]: '开机',
  [ContainerScriptTrigger.Retry]: '重试',
};

export function scriptTriggerLabel(trigger: ContainerScriptTrigger | null): string {
  if (!trigger) return '—';
  return TRIGGER[trigger] ?? trigger;
}

export function stoppedPolicyLabel(policy: ContainerScriptStoppedPolicy): string {
  return policy === ContainerScriptStoppedPolicy.Skip ? '跳过' : '开机后执行';
}

export function fileOwnerLabel(owner: ContainerScriptFileOwner): string {
  return owner === 'login_user' ? '登录用户' : 'root';
}

/** The non-zero states of `counts`, in display order. */
export function countEntries(counts: ContainerScriptCounts): Array<{ state: ContainerScriptTargetState; count: number }> {
  return TARGET_STATE_ORDER
    .map((state) => ({ state, count: counts[state] ?? 0 }))
    .filter((entry) => entry.count > 0);
}

export function countTotal(counts: ContainerScriptCounts): number {
  return TARGET_STATE_ORDER.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
}

/** Something is still due to run (or running): the page polls until it settles. */
export function scriptInProgress(script: Pick<ContainerScriptDto, 'counts' | 'status'> | undefined): boolean {
  if (!script || script.status === ContainerScriptStatus.Archived) return false;
  return (script.counts.running ?? 0) + (script.counts.pending ?? 0) > 0;
}

/** While any script has work in flight, its list and details refresh this often. */
export const SCRIPT_IN_PROGRESS_POLL_MS = 5_000;

/** Display name for a person ref; 已删除的用户 when the account is gone. */
export function personLabel(person: ContainerScriptPersonRef | null): string {
  if (!person) return '已删除的用户';
  return person.displayName || person.username;
}

/** `11/17 08:05:03`; with the year when it is not this year. */
export function scriptTime(value: string | null, now = new Date()): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}/`}${day} ${clock}`;
}

/** `42 秒`, `3 分 5 秒`, `1 小时 2 分`; an unfinished run counts to now. */
export function runDuration(startedAt: string, finishedAt: string | null, now = Date.now()): string {
  const ms = Math.max(0, (finishedAt ? new Date(finishedAt).getTime() : now) - new Date(startedAt).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
}

/** `600 秒（10 分钟）`. */
export function timeoutLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds % 3600 === 0) return `${seconds} 秒（${seconds / 3600} 小时）`;
  if (seconds % 60 === 0) return `${seconds} 秒（${seconds / 60} 分钟）`;
  return `${seconds} 秒`;
}

/** A nullable limit: the value, or what null means for it. */
export function limitLabel(value: number | null, unlimited: string): string {
  return value === null ? unlimited : String(value);
}

const TOO_LARGE_TEXT = `文件过大：单个文件与同一版本的文件合计都不能超过 ${formatBytes(CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES)}`;

/** Mutation errors in words an admin can act on; unknown codes keep the server's message. */
export function containerScriptErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === FailureCode.ContainerScriptConflict) {
      const field = apiErrorDetails(error)?.field;
      if (field === 'name') return '已有同名脚本，请换一个名称';
      if (field === 'priority') return '该优先级已被其他脚本占用，请换一个';
      return '名称或优先级与已有脚本重复';
    }
    if (error.code === FailureCode.RevisionConflict) return '脚本已被他人修改，请刷新后再操作';
    if (error.code === FailureCode.ContainerScriptArchived) return '脚本已归档，不能再发布或执行';
    if (error.code === FailureCode.ContainerScriptBlobMissing) return '有文件的内容在服务器上不存在，请重新上传该文件';
    if (error.code === FailureCode.ContainerScriptTooLarge || error.status === 413) return TOO_LARGE_TEXT;
  }
  return errorMessage(error, '操作失败');
}

/** The upload limit, for the file picker's hint. */
export const SCRIPT_FILE_LIMIT_TEXT = `单个文件与合计都不超过 ${formatBytes(CONTAINER_SCRIPT_MAX_FILE_BYTES)}`;
