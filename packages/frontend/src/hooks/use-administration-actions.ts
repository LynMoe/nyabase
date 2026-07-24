import { useQuery } from '@tanstack/react-query';
import type { AdministrationActionsDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { adminCatalogPaths } from '../lib/admin-catalog.js';

export function useAdministrationActions(enabled: boolean) {
  return useQuery({
    queryKey: ['admin-catalog', 'administration-actions'],
    queryFn: () => api.get<AdministrationActionsDto>(adminCatalogPaths.administrationActions),
    enabled,
  });
}
