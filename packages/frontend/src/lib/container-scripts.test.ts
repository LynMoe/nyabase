import { describe, expect, it } from 'vitest';
import {
  ContainerScriptPauseReason,
  ContainerScriptRunStatus,
  ContainerScriptStatus,
  ContainerScriptTargetState,
  ContainerScriptTrigger,
  FailureCode,
  type ContainerScriptCounts,
  type ContainerScriptScope,
} from '@nyabase/common';
import { ApiError } from './api-error.js';
import {
  containerScriptErrorMessage,
  countEntries,
  countTotal,
  limitLabel,
  pauseBannerText,
  personLabel,
  runDuration,
  runStatusBadge,
  scopeSummary,
  scriptInProgress,
  scriptStatusBadge,
  scriptTriggerBadges,
  scriptTriggerLabel,
  targetStateBadge,
  timeoutLabel,
} from './container-scripts.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function scope(overrides: Partial<ContainerScriptScope> = {}): ContainerScriptScope {
  return {
    all: false,
    serverIds: [],
    imageIds: [],
    ownerIds: [],
    containerIds: [],
    excludeContainerIds: [],
    ...overrides,
  };
}

function counts(overrides: Partial<ContainerScriptCounts> = {}): ContainerScriptCounts {
  return {
    pending: 0,
    waiting: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    exempt: 0,
    ...overrides,
  };
}

describe('container script triggers', () => {
  it('shows 立即 and 新容器 for a once-script', () => {
    expect(scriptTriggerBadges({ everyBoot: false }, { applyNow: true, onNewContainers: true }).map((b) => b.label))
      .toEqual(['立即', '新容器']);
    expect(scriptTriggerBadges({ everyBoot: false }, { applyNow: false, onNewContainers: true }).map((b) => b.label))
      .toEqual(['新容器']);
  });

  it('folds 新容器 into 每次开机', () => {
    expect(scriptTriggerBadges({ everyBoot: true }, { applyNow: false, onNewContainers: true }).map((b) => b.label))
      .toEqual(['每次开机']);
    expect(scriptTriggerBadges({ everyBoot: true }, { applyNow: true, onNewContainers: true }).map((b) => b.label))
      .toEqual(['立即', '每次开机']);
  });

  it('names run triggers', () => {
    expect(scriptTriggerLabel(ContainerScriptTrigger.Now)).toBe('立即');
    expect(scriptTriggerLabel(ContainerScriptTrigger.NewContainer)).toBe('新容器');
    expect(scriptTriggerLabel(ContainerScriptTrigger.Boot)).toBe('开机');
    expect(scriptTriggerLabel(ContainerScriptTrigger.Retry)).toBe('重试');
    expect(scriptTriggerLabel(null)).toBe('—');
  });
});

describe('scopeSummary', () => {
  it('reads 全部容器 with the exclusions', () => {
    expect(scopeSummary(scope({ all: true }))).toBe('全部容器');
    expect(scopeSummary(scope({ all: true, excludeContainerIds: [A, B] }))).toBe('全部容器 · 排除 2 个');
  });

  it('lists every non-empty filter', () => {
    expect(scopeSummary(scope({ serverIds: [A, B], imageIds: [A] }))).toBe('2 台服务器 · 1 个镜像');
    expect(scopeSummary(scope({ ownerIds: [A], containerIds: [A, B], excludeContainerIds: [B] })))
      .toBe('1 个用户 · 2 个容器 · 排除 1 个');
  });
});

describe('script status', () => {
  it('labels status with the pause reason', () => {
    expect(scriptStatusBadge({ status: ContainerScriptStatus.Active, pauseReason: null }))
      .toEqual({ label: '启用', tone: 'success' });
    expect(scriptStatusBadge({ status: ContainerScriptStatus.Paused, pauseReason: ContainerScriptPauseReason.Canary }).label)
      .toBe('已暂停（灰度完成）');
    expect(scriptStatusBadge({ status: ContainerScriptStatus.Archived, pauseReason: null }).label).toBe('已归档');
  });

  it('explains each pause reason in the banner, and nothing when not paused', () => {
    expect(pauseBannerText({ status: ContainerScriptStatus.Paused, pauseReason: ContainerScriptPauseReason.Manual }))
      .toBe('已手动暂停。');
    expect(pauseBannerText({ status: ContainerScriptStatus.Paused, pauseReason: ContainerScriptPauseReason.Canary }))
      .toContain('灰度已完成，确认结果后点“恢复”继续');
    expect(pauseBannerText({ status: ContainerScriptStatus.Paused, pauseReason: ContainerScriptPauseReason.Failures }))
      .toContain('失败容器达到阈值，已自动暂停');
    expect(pauseBannerText({ status: ContainerScriptStatus.Active, pauseReason: null })).toBeNull();
  });

  it('labels every target state and run status', () => {
    expect(targetStateBadge(ContainerScriptTargetState.Running)).toMatchObject({ label: '执行中', pending: true });
    expect(targetStateBadge(ContainerScriptTargetState.Waiting).label).toBe('等待开机');
    expect(targetStateBadge(ContainerScriptTargetState.Exempt).label).toBe('不执行');
    expect(runStatusBadge(ContainerScriptRunStatus.TimedOut)).toMatchObject({ label: '超时', tone: 'destructive' });
    expect(runStatusBadge(ContainerScriptRunStatus.Interrupted).label).toBe('中断');
  });
});

describe('counts', () => {
  it('lists the non-zero states in display order and totals them', () => {
    const value = counts({ running: 2, succeeded: 5, failed: 1 });
    expect(countEntries(value)).toEqual([
      { state: 'succeeded', count: 5 },
      { state: 'failed', count: 1 },
      { state: 'running', count: 2 },
    ]);
    expect(countTotal(value)).toBe(8);
  });

  it('polls while something is running or pending, never for an archived script', () => {
    expect(scriptInProgress({ status: ContainerScriptStatus.Active, counts: counts({ pending: 1 }) })).toBe(true);
    expect(scriptInProgress({ status: ContainerScriptStatus.Paused, counts: counts({ running: 1 }) })).toBe(true);
    expect(scriptInProgress({ status: ContainerScriptStatus.Active, counts: counts({ waiting: 3, failed: 2 }) })).toBe(false);
    expect(scriptInProgress({ status: ContainerScriptStatus.Archived, counts: counts({ running: 1 }) })).toBe(false);
    expect(scriptInProgress(undefined)).toBe(false);
  });
});

describe('formatting', () => {
  it('formats durations, timeouts, limits and people', () => {
    expect(runDuration('2026-11-17T00:00:00Z', '2026-11-17T00:00:42Z')).toBe('42 秒');
    expect(runDuration('2026-11-17T00:00:00Z', '2026-11-17T00:03:05Z')).toBe('3 分 5 秒');
    expect(runDuration('2026-11-17T00:00:00Z', '2026-11-17T01:02:00Z')).toBe('1 小时 2 分');
    expect(runDuration('2026-11-17T00:00:00Z', null, Date.parse('2026-11-17T00:00:10Z'))).toBe('10 秒');
    expect(timeoutLabel(600)).toBe('600 秒（10 分钟）');
    expect(timeoutLabel(7200)).toBe('7200 秒（2 小时）');
    expect(timeoutLabel(45)).toBe('45 秒');
    expect(limitLabel(null, '不灰度')).toBe('不灰度');
    expect(limitLabel(5, '不灰度')).toBe('5');
    expect(personLabel(null)).toBe('已删除的用户');
    expect(personLabel({ id: A, username: 'alice', displayName: '' })).toBe('alice');
  });
});

describe('containerScriptErrorMessage', () => {
  it('names the conflicting field', () => {
    const conflict = (field?: string) => new ApiError(409, FailureCode.ContainerScriptConflict, 'conflict', {
      code: FailureCode.ContainerScriptConflict,
      details: field ? { field } : undefined,
    });
    expect(containerScriptErrorMessage(conflict('name'))).toContain('同名');
    expect(containerScriptErrorMessage(conflict('priority'))).toContain('优先级');
    expect(containerScriptErrorMessage(conflict())).toContain('名称或优先级');
  });

  it('explains revision, archive, missing blob and size errors', () => {
    expect(containerScriptErrorMessage(new ApiError(409, FailureCode.RevisionConflict, 'x'))).toContain('已被他人修改');
    expect(containerScriptErrorMessage(new ApiError(409, FailureCode.ContainerScriptArchived, 'x'))).toContain('已归档');
    expect(containerScriptErrorMessage(new ApiError(400, FailureCode.ContainerScriptBlobMissing, 'x'))).toContain('重新上传');
    expect(containerScriptErrorMessage(new ApiError(413, 'UNKNOWN', 'Payload Too Large'))).toContain('16 MiB');
    expect(containerScriptErrorMessage(new ApiError(400, FailureCode.ContainerScriptTooLarge, 'x'))).toContain('文件过大');
    expect(containerScriptErrorMessage(new ApiError(400, 'OTHER', '原样'))).toBe('原样');
  });
});
