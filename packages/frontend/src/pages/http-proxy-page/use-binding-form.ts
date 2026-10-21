import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  httpProxyWildcardSuffix,
  zCreateHttpProxyBindingRequest,
  type ContainerDto,
  type HttpDomainPoolPublicDto,
  type HttpProxyBindingDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import {
  composeHttpProxyHostname,
  httpProxyErrorMessage,
  isHttpProxyPrefixLabel,
  splitHttpProxyHostname,
} from '../../lib/http-proxy.js';

type BindingBody = { hostname: string; containerId: string; targetPort: number };

/** State, validation and submission of the create / edit HTTP binding form. */
export function useBindingForm({
  binding,
  pools,
  open,
  onOpenChange,
}: {
  binding?: HttpProxyBindingDto;
  pools: HttpDomainPoolPublicDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState('');
  const [poolId, setPoolId] = useState('');
  const [containerId, setContainerId] = useState(binding?.containerId ?? '');
  const [targetPort, setTargetPort] = useState(binding ? String(binding.targetPort) : '80');
  const [error, setError] = useState<string | null>(null);
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: open,
  });
  const saved = (title: string) => {
    toast({ title });
    void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.bindings });
    onOpenChange(false);
  };
  const create = useMutation({
    mutationFn: (body: BindingBody) => api.post<HttpProxyBindingDto>('/http-proxy/bindings', body),
    onSuccess: () => saved('发布已创建'),
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: BindingBody) =>
      api.patch<HttpProxyBindingDto>(`/http-proxy/bindings/${binding?.id ?? ''}`, body),
    onSuccess: () => saved('发布已更新'),
    onError: (mutationError) => setError(httpProxyErrorMessage(mutationError)),
  });
  useEffect(() => {
    if (!open) return;
    const split = binding ? splitHttpProxyHostname(binding.hostname, pools) : null;
    setPrefix(split?.prefix ?? '');
    setPoolId(split?.poolId ?? pools[0]?.id ?? '');
    setContainerId(binding?.containerId ?? '');
    setTargetPort(binding ? String(binding.targetPort) : '80');
    setError(null);
  }, [binding, open, pools]);

  const selectedPool = pools.find((pool) => pool.id === poolId) ?? pools[0];
  const suffix = selectedPool ? httpProxyWildcardSuffix(selectedPool.wildcardDomain) : '';
  let hostnamePreview: string | undefined;
  try {
    if (selectedPool && isHttpProxyPrefixLabel(prefix)) {
      hostnamePreview = composeHttpProxyHostname(prefix, selectedPool.wildcardDomain);
    }
  } catch {
    hostnamePreview = undefined;
  }

  const submit = () => {
    setError(null);
    const port = Number(targetPort);
    if (!selectedPool) {
      setError('管理员尚未配置通配域名');
      return;
    }
    if (!isHttpProxyPrefixLabel(prefix)) {
      setError('请填写单节主机前缀，例如 app');
      return;
    }
    if (!containerId) {
      setError('请选择容器');
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('目标端口必须是 1 到 65535 的整数');
      return;
    }
    let hostname: string;
    try {
      hostname = composeHttpProxyHostname(prefix, selectedPool.wildcardDomain);
    } catch {
      setError('前缀与域名根无法组成有效主机名');
      return;
    }
    const parsed = zCreateHttpProxyBindingRequest.safeParse({
      hostname,
      containerId,
      targetPort: port,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查发布参数');
      return;
    }
    if (binding) patch.mutate(parsed.data);
    else create.mutate(parsed.data);
  };

  return {
    prefix,
    containerId,
    targetPort,
    error,
    containersQuery,
    selectedPool,
    suffix,
    hostnamePreview,
    pending: create.isPending || patch.isPending,
    setPrefix: (value: string) => { setPrefix(value); setError(null); },
    setPoolId: (value: string) => { setPoolId(value); setError(null); },
    setContainerId: (value: string) => { setContainerId(value); setError(null); },
    setTargetPort: (value: string) => { setTargetPort(value); setError(null); },
    submit,
  };
}
