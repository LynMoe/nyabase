import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OperationStatus, type OperationSummaryDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';

const TERMINAL = new Set<OperationStatus>([
  OperationStatus.Succeeded,
  OperationStatus.Failed,
  OperationStatus.Cancelled,
]);

export function useOperationTracker(
  operationId: string | null | undefined,
  options: { admin?: boolean } = {},
) {
  const qc = useQueryClient();
  const basePath = options.admin === true ? '/admin/operations' : '/operations';
  const query = useQuery({
    queryKey: ['operation', options.admin === true ? 'admin' : 'user', operationId],
    queryFn: () => api.get<OperationSummaryDto>(`${basePath}/${operationId}`),
    enabled: Boolean(operationId),
    refetchInterval: (state) => {
      const status = state.state.data?.status;
      return status && TERMINAL.has(status) ? false : 1000;
    },
  });

  useEffect(() => {
    if (query.data?.status && TERMINAL.has(query.data.status)) {
      void qc.invalidateQueries({
        queryKey: options.admin === true ? queryKeys.containers.adminList : queryKeys.containers.userList,
      });
      void qc.invalidateQueries({ queryKey: ['container', options.admin === true ? 'admin' : 'user'] });
    }
  }, [query.data?.status, qc, options.admin]);

  return query;
}
