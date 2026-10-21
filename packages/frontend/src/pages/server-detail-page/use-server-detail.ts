import { useMutation, type UseMutationResult, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type ConnectServerRequest,
  type IntentAcceptedDto,
  type PatchServerRequest,
  type RunPreflightRequest,
  type ServerDto,
  type StoragePoolDiscoverResult,
  zNodeMetricsPatchConfig,
} from '@nyabase/common';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';

/** What the connect and preflight forms currently hold. */
export interface ServerFormValues {
  trustToken: string;
  expectedFingerprint: string;
  selectedPoolId: string;
  probeAddress: string;
}

/** The server detail page's mutations; each refreshes the server, its pools and its preflight. */
export function useServerActions({
  id,
  server,
  form,
  onConnectSubmitted,
  onSettingsSaved,
  onDeleted,
}: {
  id: string;
  server: ServerDto | undefined;
  form: ServerFormValues;
  onConnectSubmitted: () => void;
  onSettingsSaved: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: '/servers/$id' });

  const invalidateServer = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.pools(id, 'all') });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.preflight(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
  };

  const connect = useMutation({
    mutationFn: () => {
      const body: ConnectServerRequest = {
        trustToken: form.trustToken.trim(),
        expectedServerCertFingerprint: (form.expectedFingerprint || server?.serverCertFingerprint || '').trim(),
      };
      return api.post<IntentAcceptedDto>(`/servers/${id}/connect`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '已开始连接服务器', description: `操作 ${intent.intentId.slice(0, 8)} 正在执行。` });
      onConnectSubmitted();
      invalidateServer();
    },
    onError: (error) => toast({ title: '连接失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const runPreflight = useMutation({
    mutationFn: () => {
      const body: RunPreflightRequest = {
        expectedServerRevision: server?.revision ?? 0,
        poolId: form.selectedPoolId,
        probeAddress: form.probeAddress.trim(),
      };
      return api.post<IntentAcceptedDto>(`/servers/${id}/preflight`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '前置检查已开始', description: `操作 ${intent.intentId.slice(0, 8)} 正在执行。` });
      invalidateServer();
    },
    onError: (error) => toast({ title: '前置检查失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const discoverPools = useMutation({
    mutationFn: () => api.post<StoragePoolDiscoverResult>(`/servers/${id}/storage-pools/discover`),
    onSuccess: (result) => {
      toast({ title: '存储池已刷新', description: `发现 ${result.pools.length} 个本地池。` });
      invalidateServer();
    },
    onError: (error) => {
      toast({ title: '发现存储池失败', description: errorMessage(error), variant: 'destructive' });
    },
  });

  const updateServer = useMutation({
    mutationFn: (body: PatchServerRequest) => api.patch<ServerDto>(`/servers/${id}`, body),
    onSuccess: () => {
      onSettingsSaved();
      toast({ title: '服务器设置已更新' });
      invalidateServer();
    },
    onError: (error) => toast({ title: '更新失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const deleteServer = useMutation({
    mutationFn: () => api.delete<void>(`/servers/${id}?expectedRevision=${server?.revision ?? 0}`),
    onSuccess: () => {
      onDeleted();
      toast({ title: '服务器已从控制面移除' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
      void navigate({ to: '/servers' });
    },
    onError: (error) => toast({ title: '删除服务器失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return { invalidateServer, connect, runPreflight, discoverPools, updateServer, deleteServer };
}

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
