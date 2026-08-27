import { useQuery } from '@tanstack/react-query';
import type { PublicSettingsDto } from '@nyabase/common';
import { api } from '../lib/api.js';

export const DEFAULT_PUBLIC_SETTINGS: PublicSettingsDto = {
  branding: {
    title: 'nyabase',
    description: '开发容器管理平台',
  },
  sshProxy: null,
};

export function usePublicSettings() {
  const query = useQuery({
    queryKey: ['public-settings'],
    queryFn: async () => {
      try {
        return await api.get<PublicSettingsDto>('/public/settings');
      } catch {
        return DEFAULT_PUBLIC_SETTINGS;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });

  return {
    ...query,
    settings: query.data ?? DEFAULT_PUBLIC_SETTINGS,
  };
}
