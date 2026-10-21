import { useEffect, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { zNodeMetricsPatchConfig, type PatchServerRequest, type ServerDto } from '@nyabase/common';
import { toast } from '../../hooks/use-toast.js';

/**
 * The node-exporter settings form of a server. The fields follow the server
 * record (and reset the token) whenever the server changes.
 */
export function useNodeMetricsForm(
  server: ServerDto | undefined,
  updateServer: UseMutationResult<ServerDto, Error, PatchServerRequest>,
) {
  const [endpoint, setEndpoint] = useState('');
  const [certFingerprint, setCertFingerprint] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!server) return;
    setEndpoint(server.nodeMetrics.endpoint ?? '');
    setCertFingerprint(server.nodeMetrics.serverCertFingerprint ?? '');
    setToken('');
  }, [server?.id, server?.revision]);

  const save = () => {
    if (!server) return;
    const trimmedToken = token.trim();
    if (!endpoint.trim() || !certFingerprint.trim()) {
      toast({
        title: 'node-exporter 配置不完整',
        description: 'endpoint 和证书 pin 都是必填项。',
        variant: 'destructive',
      });
      return;
    }
    if (!server.nodeMetrics.tokenFingerprint && trimmedToken.length === 0) {
      toast({
        title: '需要首次配置 token',
        description: '首次配置必须输入 token；已配置时留空可保持原 token。',
        variant: 'destructive',
      });
      return;
    }
    const parsed = zNodeMetricsPatchConfig.safeParse({
      endpoint: endpoint.trim(),
      serverCertFingerprint: certFingerprint.trim(),
      ...(trimmedToken.length > 0 ? { token: trimmedToken } : {}),
    });
    if (!parsed.success) {
      toast({
        title: 'node-exporter 配置无效',
        description: parsed.error.issues[0]?.message ?? '请检查 endpoint、证书 pin 和 token。',
        variant: 'destructive',
      });
      return;
    }
    updateServer.mutate({
      expectedRevision: server.revision,
      nodeMetrics: parsed.data,
    });
  };

  const clear = () => {
    if (!server) return;
    updateServer.mutate({
      expectedRevision: server.revision,
      nodeMetrics: null,
    });
  };

  return {
    endpoint,
    certFingerprint,
    token,
    setEndpoint,
    setCertFingerprint,
    setToken,
    save,
    clear,
  };
}
