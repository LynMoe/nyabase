import { MAX_GROUP_PRIORITY } from '@nyabase/common';

export { MAX_GROUP_PRIORITY };

export function parseGroupPriority(value: string, defaultWhenBlank?: number): number {
  const trimmed = value.trim();
  if (!trimmed) {
    if (defaultWhenBlank !== undefined) return defaultWhenBlank;
    throw new Error('请输入优先级');
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_GROUP_PRIORITY) {
    throw new Error(`优先级必须是 0 到 ${MAX_GROUP_PRIORITY} 之间的整数`);
  }
  return parsed;
}
