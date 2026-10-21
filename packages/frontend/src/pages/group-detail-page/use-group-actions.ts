import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';

/** Member and group mutations of the group detail page. */
export function useGroupActions({
  id,
  onMemberAdded,
  onMemberRemoved,
  onGroupDeleted,
}: {
  id: string;
  onMemberAdded: () => void;
  onMemberRemoved: () => void;
  onGroupDeleted: () => void;
}) {
  const navigate = useNavigate({ from: '/groups/$id' });
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
  };

  const addMember = useMutation({
    mutationFn: (userId: string) => api.post<{ changed: boolean }>(`/admin/groups/${id}/members`, { userId }),
    onSuccess: () => {
      toast({ title: '已添加成员' });
      onMemberAdded();
      invalidate();
    },
    onError: (error) => toast({
      title: '添加成员失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/admin/groups/${id}/members/${userId}`),
    onSuccess: () => {
      toast({ title: '已移除成员' });
      onMemberRemoved();
      invalidate();
    },
    onError: (error) => toast({
      title: '移除成员失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });
  const removeGroup = useMutation({
    mutationFn: () => api.delete<unknown>(`/admin/groups/${id}`),
    onSuccess: () => {
      toast({ title: '用户组已删除' });
      onGroupDeleted();
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      void navigate({ to: '/groups' });
    },
    onError: (error) => toast({ title: '删除用户组失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return { invalidate, addMember, removeMember, removeGroup };
}
