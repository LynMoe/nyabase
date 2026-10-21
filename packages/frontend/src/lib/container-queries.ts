import { useQueryClient } from '@tanstack/react-query';
import type { ListScope } from '@nyabase/common';
import { queryKeys } from './query-keys.js';

/** Refresh the container, its lists, its attachments and its operation history. */
export function useInvalidateContainer(scope: ListScope, containerId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.detail(scope, containerId) });
    void queryClient.invalidateQueries({
      queryKey: scope === 'all' ? queryKeys.containers.adminList : queryKeys.containers.userList,
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.attachments(scope, containerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.intents(scope, containerId) });
  };
}
