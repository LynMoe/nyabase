import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { UserStatus, type UpdateUserRequest, type UserDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';

/** Update and delete mutations of the user detail page; the callbacks close the dialog that started them. */
export function useUserMutations({
  id,
  onDisabled,
  onIdentitySaved,
  onDeleted,
}: {
  id: string;
  onDisabled: () => void;
  onIdentitySaved: () => void;
  onDeleted: () => void;
}) {
  const navigate = useNavigate({ from: '/users/$id' });
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
  };

  const patchUser = useMutation({
    mutationFn: (body: UpdateUserRequest) => api.patch<UserDto>(`/users/${id}`, body),
    onSuccess: (_user, body) => {
      invalidate();
      if (body.status === UserStatus.Disabled) {
        toast({ title: '用户已停用' });
        onDisabled();
      } else if (body.status === UserStatus.Active) {
        toast({ title: '用户已启用' });
      } else if (body.displayName) {
        toast({ title: '用户已更新' });
        onIdentitySaved();
      }
    },
    onError: (error) => toast({ title: '更新用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete<unknown>(`/users/${id}`),
    onSuccess: () => {
      toast({ title: '用户已删除' });
      onDeleted();
      invalidate();
      void navigate({ to: '/users' });
    },
    onError: (error) => toast({ title: '删除用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return { patchUser, remove };
}
