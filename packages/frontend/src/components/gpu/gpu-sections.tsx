import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canonicalPciAddress,
  formatGpuSelectionLabel,
  type GpuContainerState,
  type GpuDeviceDto,
  type GpuGrant,
  type ListScope,
  type ServerGpuDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { Button } from '../ui/button.js';
import { Switch } from '../ui/switch.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { TechnicalId } from '../refs/technical-id.js';
import { GpuPicker, ServerGpuSupport, useGpuDevices } from './gpu-picker.js';

/** GPU picker inside the create-container dialog; hidden while the server has GPU off. */
export function ContainerCreateGpu({
  serverId,
  gpuEnabled,
  grantedAddresses,
  value,
  onChange,
}: {
  serverId: string;
  gpuEnabled: boolean;
  /** Cards the server grant allows; null when the grant is not loaded. */
  grantedAddresses: readonly string[] | null;
  value: string[];
  onChange: (pciAddresses: string[]) => void;
}) {
  if (!gpuEnabled) return null;
  return (
    <GpuPicker
      serverId={serverId}
      defaultAll
      value={value}
      onChange={onChange}
      grant={grantedAddresses ? { pciAddresses: [...grantedAddresses] } : null}
      idPrefix="container-create-gpu"
    />
  );
}

/** GPU assignment inside the edit-spec dialog; changes apply only to a stopped container. */
export function ContainerSpecGpu({
  serverId,
  gpuEnabled,
  scope,
  observedStatus,
  grant,
  value,
  onChange,
  onSubmit,
  pending,
}: {
  serverId: string;
  gpuEnabled: boolean;
  scope: ListScope;
  observedStatus: string;
  grant: GpuGrant | null;
  value: string[];
  onChange: (pciAddresses: string[]) => void;
  onSubmit: (pciAddresses: string[]) => void;
  pending: boolean;
}) {
  if (!gpuEnabled) return null;
  const canEdit = observedStatus === 'stopped';
  return (
    <div className="space-y-3 border-t pt-4">
      <GpuPicker
        serverId={serverId}
        scope={scope}
        grant={grant}
        value={value}
        onChange={onChange}
        disabled={!canEdit}
        idPrefix="container-detail-gpu"
      />
      <Button
        onClick={() => onSubmit(value)}
        disabled={pending || !canEdit}
        title={canEdit ? undefined : '容器未停止'}
      >
        {pending ? '提交中...' : '应用 GPU'}
      </Button>
    </div>
  );
}

/** Read-only GPU field on the container overview, grouped by card model. */
export function ContainerOverviewGpu({
  gpu,
  serverId,
  scope,
}: {
  gpu: GpuContainerState | null;
  serverId: string;
  scope: ListScope;
}) {
  const current = gpu?.pciAddresses ?? [];
  const query = useGpuDevices(serverId, scope, current.length > 0);
  if (!gpu) return null;
  const inventory = Array.isArray(query.data?.items) ? query.data.items : [];
  const groups = query.data ? gpuModelGroups(current, inventory) : [];
  return (
    <div>
      <p className="text-xs text-muted-foreground">GPU</p>
      {current.length === 0 ? (
        <p className="text-sm">{formatGpuSelectionLabel(current, [])}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm">
          <TechnicalId label="GPU" value={current.join(', ')} visible={`${current.length} 张`} />
        </p>
      ) : (
        <p className="flex flex-wrap gap-x-3 text-sm">
          {groups.map((group) => (
            <TechnicalId
              key={group.model}
              label="GPU"
              value={group.addresses.join(', ')}
              visible={group.label}
            />
          ))}
        </p>
      )}
    </div>
  );
}

export function gpuModelGroups(
  addresses: readonly string[],
  inventory: readonly GpuDeviceDto[],
): { model: string; label: string; addresses: string[] }[] {
  const models = new Map(inventory.map((device) => [pciKey(device.pciAddress), device.model.trim() || '未知型号']));
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const address of addresses) {
    const model = models.get(pciKey(address)) ?? '未知型号';
    const list = grouped.get(model);
    if (list) list.push(address);
    else {
      grouped.set(model, [address]);
      order.push(model);
    }
  }
  return order.map((model) => {
    const group = grouped.get(model) ?? [];
    return {
      model,
      addresses: group,
      label: `${group.length} × ${model}`,
    };
  });
}

function pciKey(value: string): string {
  return canonicalPciAddress(value) ?? value.trim().toLowerCase();
}

/** Server grant editor: which cards the grantee may claim. */
export function ServerGrantGpu({
  serverId,
  gpuEnabled,
  value,
  onChange,
}: {
  serverId: string;
  gpuEnabled: boolean;
  value: string[];
  onChange: (pciAddresses: string[]) => void;
}) {
  if (!gpuEnabled) return null;
  return (
    <GpuPicker
      serverId={serverId}
      scope="all"
      value={value}
      onChange={onChange}
      idPrefix="grant-gpu"
      label="NVIDIA GPU 授权"
    />
  );
}

function runtimeLabel(ready: boolean | null | undefined): string {
  return ready === true ? '就绪' : ready === false ? '未就绪' : '未知';
}

/** Admin switch, host prerequisites, and health for GPU passthrough on one server. */
export function ServerGpuCard({ serverId, active }: { serverId: string; active: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.gpu.server(serverId),
    queryFn: () => api.get<ServerGpuDto>(`/servers/${serverId}/gpu`),
    enabled: active,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch<ServerGpuDto>(`/servers/${serverId}/gpu`, { enabled }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gpu.server(serverId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) });
      if (result.enabled && result.support.supported === false) {
        toast({
          title: 'GPU 已启用',
          description: '本机检测未通过，启用后仍可能无法把 GPU 分配给容器。',
        });
      }
    },
    onError: (error) => toast({ title: 'GPU 设置失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const gpu = query.data;

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">加载 GPU...</p>;
  }
  if (!gpu) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GPU</CardTitle>
          <CardDescription>无法读取此服务器的 GPU 状态</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="text-base">GPU</CardTitle>
          <CardDescription>
            启用后才允许把 GPU 分配给容器。占用中的 GPU 不能关闭。本机检测只反映驱动与前置条件，不阻止启用。
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => { void query.refetch(); }}
        >
          重新检测
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">NVIDIA GPU</p>
              {gpu.occupiedDeviceCount > 0 ? (
                <p className="text-xs text-muted-foreground">{gpu.occupiedDeviceCount} 占用</p>
              ) : null}
            </div>
            <Switch
              checked={gpu.enabled}
              disabled={toggle.isPending || (gpu.enabled && gpu.occupiedDeviceCount > 0)}
              onCheckedChange={(enabled) => toggle.mutate(enabled)}
            />
          </div>
          <ServerGpuSupport support={gpu.support} />
          <p className="text-xs text-muted-foreground">占用设备：{gpu.occupiedDeviceCount}</p>
          <p className="text-xs text-muted-foreground">NVIDIA runtime：{runtimeLabel(gpu.health.runtimeReady)}</p>
        </div>
      </CardContent>
    </Card>
  );
}
