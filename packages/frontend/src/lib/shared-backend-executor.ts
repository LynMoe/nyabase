import type { SharedBackendDto } from '@nyabase/common';

export function backendLacksOnlineExecutor(
  backend: Pick<SharedBackendDto, 'hasOnlineExecutor'>,
): boolean {
  return backend.hasOnlineExecutor !== true;
}
