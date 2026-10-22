import { useQuery } from '@tanstack/react-query';
import { Role, type UserDto } from '@nyabase/common';
import { api } from './api.js';
import { queryKeys } from './query-keys.js';
import { type UserActionAvailability, userActionAvailability } from './user-administration.js';
import { useAuthStore } from '../store/auth.js';
import { useHasRole } from './use-role.js';

/** Availability of the management buttons for `target`, from the viewer's role and the shared user list. */
export function useUserAvailability(target: UserDto): UserActionAvailability {
  const viewer = useAuthStore((state) => state.user);
  const isAdmin = useHasRole(Role.Admin);
  const users = useQuery({
    queryKey: queryKeys.users.admin,
    queryFn: () => api.get<UserDto[]>('/users'),
    enabled: isAdmin,
  });
  return userActionAvailability(viewer, target, users.data);
}
