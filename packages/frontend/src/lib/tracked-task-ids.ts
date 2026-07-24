export function addTrackedTaskIds(
  current: readonly string[],
  incoming: readonly (string | null | undefined)[],
): string[] {
  return [...new Set([...current, ...incoming.filter((taskId): taskId is string => Boolean(taskId))])];
}

export function retireTrackedTaskIds(
  current: readonly string[],
  settled: readonly string[],
): string[] {
  const settledSet = new Set(settled);
  return current.filter((taskId) => !settledSet.has(taskId));
}
