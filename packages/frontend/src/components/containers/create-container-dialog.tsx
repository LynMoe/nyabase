import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ContainerPowerIntent,
  zCreateContainerRequest,
  type CreateContainerRequest,
  type EffectiveAccessDto,
  type ImageDto,
  type IntentAcceptedDto,
  type StorageCapacityDto,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { FormField } from '../layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import {
  approxGibHint,
  formatBytes,
  formatCpu,
  gibToBytes,
  grantAvailableLabel,
  resourceVal,
  vcpuToMillis,
} from '../../lib/utils.js';
import { actionProgressHint, containerActionSubmittedTitle } from '../../lib/status-labels.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  GpuPicker,
  type GpuPickerMode,
  permittedGpus,
  resolveGpuPciAddresses,
  useServerGpus,
} from './gpu-picker.js';

type FormState = {
  serverId: string;
  imageId: string;
  name: string;
  rootSizeGib: string;
  cpuVcpus: string;
  memGib: string;
  gpuMode: GpuPickerMode;
  gpuPciAddresses: string[];
  powerIntent: ContainerPowerIntent;
};

const emptyForm: FormState = {
  serverId: '',
  imageId: '',
  name: '',
  rootSizeGib: '20',
  cpuVcpus: '1',
  memGib: '2',
  gpuMode: 'none',
  gpuPciAddresses: [],
  powerIntent: ContainerPowerIntent.Running,
};

export function CreateContainerDialog({
  open,
  onOpenChange,
  defaultServerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultServerId?: string;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const serversQuery = useQuery({ queryKey: queryKeys.servers.user, queryFn: () => api.get<UserServerDto[]>('/servers'), enabled: open });
  const imagesQuery = useQuery({ queryKey: queryKeys.images.userActive, queryFn: () => api.get<ImageDto[]>('/images?activeOnly=true'), enabled: open });
  const accessQuery = useQuery({ queryKey: queryKeys.meAccess, queryFn: () => api.get<EffectiveAccessDto>('/me/access'), enabled: open });
  const capacityQuery = useQuery({
    queryKey: queryKeys.storageCapacity(form.serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${form.serverId}/storage-capacity`),
    enabled: open && form.serverId.length > 0,
  });
  const gpusQuery = useServerGpus(form.serverId, false, open && form.serverId.length > 0);

  useEffect(() => {
    if (!open) {
      setForm(emptyForm);
      setError(null);
    } else if (defaultServerId) {
      setForm((current) => ({ ...current, serverId: defaultServerId, imageId: '', gpuMode: 'none', gpuPciAddresses: [] }));
    }
  }, [defaultServerId, open]);

  const liveServerIds = useMemo(() => new Set(
    (accessQuery.data?.servers ?? []).filter((server) => server.accessPhase === 'live').map((server) => server.serverId),
  ), [accessQuery.data]);
  const servers = (serversQuery.data ?? []).filter((server) => server.status === 'online' && liveServerIds.has(server.id));
  const serversLoading = open && (serversQuery.isLoading || accessQuery.isLoading);
  const selectedAccess = accessQuery.data?.servers.find((server) => server.serverId === form.serverId);
  const allowedImages = new Set(selectedAccess?.allowedImageIds ?? []);
  const images = (imagesQuery.data ?? []).filter((image) => allowedImages.has(image.id));
  const availableGpus = useMemo(
    () => permittedGpus(gpusQuery.data?.items ?? [], selectedAccess?.gpu, false),
    [gpusQuery.data?.items, selectedAccess?.gpu],
  );

  const rootSizeBytes = Number.isFinite(Number(form.rootSizeGib)) ? gibToBytes(Number(form.rootSizeGib)) : NaN;
  const cpuMillis = Number.isFinite(Number(form.cpuVcpus)) ? vcpuToMillis(Number(form.cpuVcpus)) : NaN;
  const memBytes = Number.isFinite(Number(form.memGib)) ? gibToBytes(Number(form.memGib)) : NaN;
  const capacityEnough = !capacityQuery.data
    || !Number.isFinite(rootSizeBytes)
    || capacityQuery.data.availableBytes === null
    || rootSizeBytes <= capacityQuery.data.availableBytes;
  const noImagesForServer = Boolean(form.serverId) && !imagesQuery.isLoading && images.length === 0;

  const create = useMutation({
    mutationFn: (body: CreateContainerRequest) => api.post<IntentAcceptedDto>('/containers', body),
    onSuccess: () => {
      toast({
        title: containerActionSubmittedTitle('create'),
        description: actionProgressHint('list'),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers.userList });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : '容器创建失败'),
  });

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const submit = () => {
    const input = {
      serverId: form.serverId,
      imageId: form.imageId,
      name: form.name.trim(),
      rootSizeBytes,
      cpuMillis,
      memBytes,
      gpuPciAddresses: resolveGpuPciAddresses(form.gpuMode, form.gpuPciAddresses, availableGpus),
      powerIntent: form.powerIntent,
    };
    const parsed = zCreateContainerRequest.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查容器规格');
      return;
    }
    create.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="container-create-canonical">
        <DialogHeader>
          <DialogTitle>新建容器</DialogTitle>
          <DialogDescription>镜像与规格创建后固定，提交前会再次校验容量。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="container-server" label="服务器">
              <Select
                value={form.serverId || undefined}
                onValueChange={(value) => {
                  update('serverId', value);
                  update('imageId', '');
                  update('gpuMode', 'none');
                  update('gpuPciAddresses', []);
                }}
                disabled={serversLoading || servers.length === 0}
              >
                <SelectTrigger id="container-server">
                  <SelectValue
                    placeholder={
                      serversLoading
                        ? '加载可用服务器…'
                        : servers.length === 0
                          ? '暂无可用服务器'
                          : '选择服务器'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((server) => (
                    <SelectItem key={server.id} value={server.id}>{server.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {serversLoading ? (
                <p className="text-xs text-muted-foreground">加载可用服务器…</p>
              ) : servers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  当前没有可创建容器的服务器（需有效授权且服务器在线）
                </p>
              ) : null}
            </FormField>
            <SelectField
              key={form.serverId || 'no-server'}
              id="container-image"
              label="镜像"
              value={form.imageId}
              onChange={(value) => update('imageId', value)}
              options={images.map((image) => [image.id, `${image.name} · ${image.fingerprint ?? '等待指纹'}`])}
              placeholder={
                !form.serverId
                  ? '先选择服务器'
                  : noImagesForServer
                    ? '该服务器没有可用镜像，请联系管理员分配'
                    : '选择镜像'
              }
              disabled={!form.serverId}
            />
          </div>
          {noImagesForServer && (
            <p className="text-xs text-muted-foreground">该服务器没有可用镜像，请联系管理员分配</p>
          )}
          <FormField id="container-name" label="容器名称">
            <Input id="container-name" value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="dev-ubuntu" />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-3">
            <UnitField
              id="container-root-size"
              label="系统盘 (GiB)"
              value={form.rootSizeGib}
              onChange={(value) => update('rootSizeGib', value)}
              hint={Number.isFinite(rootSizeBytes) ? approxGibHint(rootSizeBytes) : undefined}
            />
            <UnitField
              id="container-cpu"
              label="CPU (核)"
              value={form.cpuVcpus}
              onChange={(value) => update('cpuVcpus', value)}
              step="0.1"
            />
            <UnitField
              id="container-memory"
              label="内存 (GiB)"
              value={form.memGib}
              onChange={(value) => update('memGib', value)}
              hint={Number.isFinite(memBytes) ? approxGibHint(memBytes) : undefined}
            />
          </div>
          {selectedAccess && (
            <p className="text-xs text-muted-foreground">
              授权额度：CPU {resourceVal(selectedAccess.cpuMillis, formatCpu)}
              {' · '}
              内存 {resourceVal(selectedAccess.memBytes, formatBytes)}
              {' · '}
              磁盘 {resourceVal(selectedAccess.diskBytes, formatBytes)}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <GpuPicker
              serverId={form.serverId}
              mode={form.gpuMode}
              onModeChange={(mode) => update('gpuMode', mode)}
              value={form.gpuPciAddresses}
              onChange={(pciAddresses) => update('gpuPciAddresses', pciAddresses)}
              grant={selectedAccess?.gpu}
              idPrefix="container-gpu"
            />
            <SelectField id="container-power-intent" label="期望电源状态" value={form.powerIntent} onChange={(value) => update('powerIntent', value as ContainerPowerIntent)} options={[[ContainerPowerIntent.Running, '运行'], [ContainerPowerIntent.Stopped, '停止']]} />
          </div>
          {capacityQuery.data && Number.isFinite(rootSizeBytes) && <CapacityNotice capacity={capacityQuery.data} requested={rootSizeBytes} />}
          {capacityQuery.isError && <p className="text-sm text-destructive">容量预检暂时不可用，提交时后端仍会校验。</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={submit}
            disabled={create.isPending || serversLoading || !form.serverId || !form.imageId || !capacityEnough || noImagesForServer}
          >
            {create.isPending ? '提交中...' : '创建容器'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <FormField id={id} label={label}>
      <Select key={value || 'empty'} value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder ?? '请选择'} />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

function UnitField({
  id,
  label,
  value,
  onChange,
  hint,
  step = '1',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  step?: string;
}) {
  return (
    <FormField id={id} label={label} hint={hint}>
      <Input id={id} type="number" min="0" step={step} value={value} onChange={(event) => onChange(event.target.value)} />
    </FormField>
  );
}

function CapacityNotice({ capacity, requested }: { capacity: StorageCapacityDto; requested: number }) {
  const available = capacity.availableBytes;
  const enough = available === null || requested <= available;
  const availableLabel = grantAvailableLabel(available, capacity.grantLimitBytes);
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${enough ? 'border-green-200 bg-green-50 text-green-800' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
      <div className="flex justify-between gap-2">
        <span>容量预检</span>
        <span>{enough ? '可提交' : '超出可用容量'}</span>
      </div>
      <div className="mt-1">
        额度 {resourceVal(capacity.grantLimitBytes, approxGibHint)}
        {' · '}
        已用系统盘 {approxGibHint(capacity.usedByRootDisksBytes)}
        {' · '}
        可用 {availableLabel === '不限' || availableLabel === '未知' ? availableLabel : approxGibHint(available!)}
      </div>
    </div>
  );
}
