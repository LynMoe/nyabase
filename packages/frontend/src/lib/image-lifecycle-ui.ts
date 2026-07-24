import { AgentTaskKind, AgentTaskStatus, type AgentTaskDto, type AdminImageDto } from '@nyabase/common';

type LifecycleTask = Pick<AgentTaskDto, 'kind' | 'status'>;

export function relevantImageLifecycleTask<T extends LifecycleTask>(
  deleting: boolean,
  task: T | null | undefined,
): T | undefined {
  const expectedKind = deleting ? AgentTaskKind.ImageEnsureAbsent : AgentTaskKind.ImageEnsurePresent;
  return task?.kind === expectedKind ? task : undefined;
}

export function summarizeImageLifecycle(
  deleting: boolean,
  tasks: Array<LifecycleTask | null | undefined>,
): { pendingCount: number; failedCount: number; canRetryCleanup: boolean } {
  const relevant = tasks
    .map((task) => relevantImageLifecycleTask(deleting, task))
    .filter((task): task is LifecycleTask => Boolean(task));
  const pendingCount = relevant.filter((task) => task.status === AgentTaskStatus.Pending).length;
  const failedCount = relevant.filter((task) => task.status === AgentTaskStatus.Failed).length;
  return {
    pendingCount,
    failedCount,
    canRetryCleanup: deleting && failedCount > 0 && pendingCount === 0,
  };
}

export function imageDeleteFeedback(taskCount: number): { title: string; description?: string } {
  if (taskCount === 0) return { title: '镜像已删除' };
  return {
    title: '镜像删除已排队',
    description: `已创建 ${taskCount} 个清理任务；全部成功后镜像记录才会移除。`,
  };
}

export function imageListPollInterval(images: AdminImageDto[] | undefined): number {
  return images?.some((image) => image.deleting) ? 2_000 : 30_000;
}
