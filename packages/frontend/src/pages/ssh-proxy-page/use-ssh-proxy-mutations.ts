import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SshProxyHostKeySummaryDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';

interface DisconnectAllResult {
  requestId: string;
  requested: number;
  disconnected: number;
}

export function useSshProxyMutations({
  onDisconnected,
  onRotated,
  onAuthoritiesReset,
}: {
  onDisconnected: () => void;
  onRotated: () => void;
  onAuthoritiesReset: () => void;
}) {
  const qc = useQueryClient();
  const disconnectAll = useMutation({
    mutationFn: () => api.post<DisconnectAllResult>('/admin/ssh-proxy/disconnect-all'),
    onSuccess: (result) => {
      onDisconnected();
      qc.invalidateQueries({ queryKey: queryKeys.sshProxy.status });
      toast({
        title: '已发送断开命令',
        description: `已断开 ${result.disconnected} 个会话，目标代理 ${result.requested} 个。`,
      });
    },
    onError: (error) => toast({
      title: '断开失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  const rotateHostKey = useMutation({
    mutationFn: () => api.post<SshProxyHostKeySummaryDto>('/admin/ssh-proxy/host-key/rotate'),
    onSuccess: (updated) => {
      onRotated();
      qc.setQueryData(queryKeys.sshProxy.hostKey, updated);
      qc.invalidateQueries({ queryKey: queryKeys.sshProxy.status });
      toast({ title: 'SSH 主机密钥已轮换' });
    },
    onError: (error) => toast({
      title: '轮换失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  const resetHostAuthorities = useMutation({
    mutationFn: () => api.post<{ reset: number }>('/admin/ssh-proxy/host-authorities/reset'),
    onSuccess: (result) => {
      onAuthoritiesReset();
      toast({
        title: '容器证书 CA 已重置',
        description: `重置了 ${result.reset} 个用户的 CA，所有容器正在后台重新签发证书。`,
      });
    },
    onError: (error) => toast({
      title: '重置失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  return { disconnectAll, rotateHostKey, resetHostAuthorities };
}
