import { useQuery } from '@tanstack/react-query';
import type { SshPublicKeyDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { useAuthStore } from '../store/auth.js';

/**
 * Whether the signed-in user has registered an SSH public key. `missing` is
 * only true once the list has loaded empty, so a slow or failed request never
 * flashes a "no key" warning.
 */
export function useMySshKeys(enabled = true) {
  const userId = useAuthStore((state) => state.user?.id);
  const query = useQuery({
    queryKey: queryKeys.sshKeys(userId ?? ''),
    queryFn: () => api.get<SshPublicKeyDto[]>(`/users/${userId}/ssh-keys`),
    enabled: enabled && Boolean(userId),
    staleTime: 30_000,
  });
  return {
    ...query,
    missing: query.isSuccess && query.data.length === 0,
  };
}
