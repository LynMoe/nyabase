import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroupMemberDto } from '@nyabase/common';
import { api } from './api.js';
import { queryKeys } from './query-keys.js';

export type CatalogUser = {
  id: string;
  username: string;
  displayName: string;
  status: string;
};

/** Members of one group (needs the 管理用户组 capability). */
export function useGroupMembers(groupId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.groups.detail(groupId), 'members'] as const,
    queryFn: () => api.get<GroupMemberDto[]>(`/admin/groups/${groupId}/members`),
    enabled,
  });
}

/** Users that can be added to a group. */
export function useCatalogUsers(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.catalog.users,
    queryFn: () => api.get<CatalogUser[]>('/admin/catalog/users'),
    enabled,
  });
}

/** Refresh the group, the group list and the user list after a change. */
export function useInvalidateGroup(groupId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(groupId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
  };
}
