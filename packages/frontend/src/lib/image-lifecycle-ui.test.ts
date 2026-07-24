import { describe, expect, it } from 'vitest';
import { AgentTaskKind, AgentTaskStatus, type AdminImageDto } from '@nyabase/common';
import {
  imageDeleteFeedback,
  imageListPollInterval,
  relevantImageLifecycleTask,
  summarizeImageLifecycle,
} from './image-lifecycle-ui.js';

const deletingImage = { id: 'i1', deleting: true } as AdminImageDto;

describe('admin image lifecycle UI', () => {
  it('reports zero-server deletion as complete and queued cleanup as asynchronous', () => {
    expect(imageDeleteFeedback(0)).toEqual({ title: '镜像已删除' });
    expect(imageDeleteFeedback(2)).toEqual({
      title: '镜像删除已排队',
      description: '已创建 2 个清理任务；全部成功后镜像记录才会移除。',
    });
  });

  it('enables retry only after cleanup failure with no cleanup still pending', () => {
    const failed = { kind: AgentTaskKind.ImageEnsureAbsent, status: AgentTaskStatus.Failed };
    const pending = { kind: AgentTaskKind.ImageEnsureAbsent, status: AgentTaskStatus.Pending };
    expect(summarizeImageLifecycle(true, [failed])).toMatchObject({ canRetryCleanup: true });
    expect(summarizeImageLifecycle(true, [failed, pending])).toMatchObject({ canRetryCleanup: false });
    expect(summarizeImageLifecycle(false, [failed])).toMatchObject({ canRetryCleanup: false });
  });

  it('never presents an old pull task as a deletion-cleanup result', () => {
    const oldPull = { kind: AgentTaskKind.ImageEnsurePresent, status: AgentTaskStatus.Succeeded };
    expect(relevantImageLifecycleTask(true, oldPull)).toBeUndefined();
    expect(summarizeImageLifecycle(true, [oldPull])).toEqual({
      pendingCount: 0,
      failedCount: 0,
      canRetryCleanup: false,
    });
  });

  it('polls the catalog quickly through refresh and final row removal while deleting', () => {
    expect(imageListPollInterval([deletingImage])).toBe(2_000);
    expect(imageListPollInterval([])).toBe(30_000);
  });
});
