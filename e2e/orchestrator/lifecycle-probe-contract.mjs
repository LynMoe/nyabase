export const lifecycleProbeKinds = Object.freeze([
  'container.create',
  'container.stop',
  'container.start',
  'container.restart',
  'container.delete',
]);

export function lifecycleHistoryPath(containerId) {
  if (typeof containerId !== 'string' || containerId.length === 0) {
    throw new Error('dedicated lifecycle history requires a container identity');
  }
  return `/admin/agent-tasks?resourceType=container&resourceId=${encodeURIComponent(containerId)}&limit=100`;
}

export function validateDedicatedLifecycleHistory(tasks, containerId) {
  if (!Array.isArray(tasks)) throw new Error('container task history is not an array');
  if (tasks.some((task) => task?.resourceId !== containerId)) {
    throw new Error('dedicated lifecycle history contains another resource identity');
  }
  return lifecycleProbeKinds.map((kind) => {
    const matches = tasks.filter((task) => task.kind === kind && task.status === 'succeeded');
    if (matches.length !== 1) {
      throw new Error(
        `dedicated lifecycle history does not contain exactly one successful ${kind}`,
      );
    }
    return matches[0];
  });
}
