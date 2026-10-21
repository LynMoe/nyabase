import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ContainerPowerIntent,
  zCreateContainerRequest,
  type ContainerDto,
  type CreateContainerRequest,
  type EffectiveAccessDto,
  type ImageDto,
  type IntentAcceptedDto,
  type StorageCapacityDto,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { SelectField } from '../layout/select-field.js';
import { toast } from '../../hooks/use-toast.js';
import { gibToBytes, vcpuToMillis } from '../../lib/utils.js';
import { formatConsumedQuotaParts } from '../../lib/grant-quota.js';
import { ContainerCreateGpu } from '../gpu/gpu-sections.js';
import { containerActionSubmittedTitle } from '../../lib/status-labels.js';
import { cn } from '../../lib/utils.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { SshKeyNotice } from '../ssh/ssh-key-notice.js';

type FormState = {
  serverId: string;
  imageId: string;
  name: string;
  rootSizeGib: string;
  cpuVcpus: string;
  memGib: string;
  startAfterCreate: boolean;
};

type FieldErrors = Partial<Record<'name' | 'serverId' | 'imageId' | 'rootSizeGib' | 'cpuVcpus' | 'memGib', string>>;

const emptyForm: FormState = {
  serverId: '',
  imageId: '',
  name: '',
  rootSizeGib: '20',
  cpuVcpus: '1',
  memGib: '2',
  startAfterCreate: true,
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Remaining room under a grant; null when the grant does not limit it. */
function remaining(limit: number | null, used: number): number | null {
  if (limit === null || limit === 0) return null;
  return Math.max(0, limit - used);
}

function cpuText(millis: number): string {
  return formatConsumedQuotaParts({ cpuMillis: millis, memBytes: null, diskBytes: null })[0] ?? '';
}

function bytesText(bytes: number): string {
  return formatConsumedQuotaParts({ cpuMillis: null, memBytes: bytes, diskBytes: null })[0] ?? '';
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

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
  const [gpuPciAddresses, setGpuPciAddresses] = useState<string[] | undefined>(undefined);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sshKeys = useMySshKeys(open);
  const serversQuery = useQuery({ queryKey: queryKeys.servers.user, queryFn: () => api.get<UserServerDto[]>('/servers'), enabled: open });
  const imagesQuery = useQuery({ queryKey: queryKeys.images.userActive, queryFn: () => api.get<ImageDto[]>('/images?activeOnly=true'), enabled: open });
  const accessQuery = useQuery({ queryKey: queryKeys.meAccess, queryFn: () => api.get<EffectiveAccessDto>('/me/access'), enabled: open });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: open,
  });
  const capacityQuery = useQuery({
    queryKey: queryKeys.storageCapacity(form.serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${form.serverId}/storage-capacity`),
    enabled: open && form.serverId.length > 0,
  });

  const liveServerIds = useMemo(() => new Set(
    (accessQuery.data?.servers ?? []).filter((server) => server.accessPhase === 'live').map((server) => server.serverId),
  ), [accessQuery.data]);
  const servers = useMemo(
    () => (serversQuery.data ?? []).filter((server) => server.status === 'online' && liveServerIds.has(server.id)),
    [serversQuery.data, liveServerIds],
  );
  const serversLoading = open && (serversQuery.isLoading || accessQuery.isLoading);
  const selectedAccess = accessQuery.data?.servers.find((server) => server.serverId === form.serverId);
  const images = useMemo(() => {
    const allowed = new Set(selectedAccess?.allowedImageIds ?? []);
    return (imagesQuery.data ?? []).filter((image) => allowed.has(image.id));
  }, [imagesQuery.data, selectedAccess]);
  const selected = servers.find((server) => server.id === form.serverId);
  const noImagesForServer = Boolean(form.serverId) && !imagesQuery.isLoading && images.length === 0;

  useEffect(() => {
    if (!open) {
      setForm(emptyForm);
      setGpuPciAddresses(undefined);
      setErrors({});
      setSubmitError(null);
    } else if (defaultServerId) {
      setForm((current) => ({ ...current, serverId: defaultServerId, imageId: '' }));
      setGpuPciAddresses(undefined);
    }
  }, [defaultServerId, open]);

  // The common case is one server and one image: pick them instead of asking.
  useEffect(() => {
    if (open && !form.serverId && servers.length === 1 && servers[0]) {
      setForm((current) => ({ ...current, serverId: servers[0]!.id, imageId: '' }));
    }
  }, [open, form.serverId, servers]);
  useEffect(() => {
    if (open && form.serverId && !form.imageId && images.length === 1 && images[0]) {
      setForm((current) => ({ ...current, imageId: images[0]!.id }));
    }
  }, [open, form.serverId, form.imageId, images]);

  const cpuNumber = positiveNumber(form.cpuVcpus);
  const memNumber = positiveNumber(form.memGib);
  const rootNumber = positiveNumber(form.rootSizeGib);
  const cpuMillis = cpuNumber === null ? null : vcpuToMillis(cpuNumber);
  const memBytes = memNumber === null ? null : gibToBytes(memNumber);
  const rootSizeBytes = rootNumber === null ? null : gibToBytes(rootNumber);

  const onServer = containersQuery.isSuccess
    ? (containersQuery.data ?? []).filter((container) => container.serverId === form.serverId)
    : null;
  const cpuLeft = selectedAccess && onServer
    ? remaining(selectedAccess.cpuMillis, onServer.reduce((sum, item) => sum + item.cpuMillis, 0))
    : null;
  const memLeft = selectedAccess && onServer
    ? remaining(selectedAccess.memBytes, onServer.reduce((sum, item) => sum + item.memBytes, 0))
    : null;
  const diskLeft = capacityQuery.data?.availableBytes ?? null;

  const cpuOver = cpuLeft !== null && cpuMillis !== null && cpuMillis > cpuLeft;
  const memOver = memLeft !== null && memBytes !== null && memBytes > memLeft;
  const diskOver = diskLeft !== null && rootSizeBytes !== null && rootSizeBytes > diskLeft;
  const overQuota = cpuOver || memOver || diskOver;

  const create = useMutation({
    mutationFn: (body: CreateContainerRequest) => api.post<IntentAcceptedDto>('/containers', body),
    onSuccess: () => {
      toast({ title: containerActionSubmittedTitle('create') });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers.userList });
      onOpenChange(false);
    },
    onError: (mutationError) => setSubmitError(errorMessage(mutationError)),
  });

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setSubmitError(null);
  };

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    const name = form.name.trim();
    if (!name) next.name = '请输入容器名称';
    else if (name.length > 63) next.name = '名称最长 63 个字符';
    else if (!NAME_RE.test(name)) next.name = '只能使用字母、数字和连字符，且不能以连字符开头';
    if (!form.serverId) next.serverId = '请选择服务器';
    if (!form.imageId) next.imageId = '请选择镜像';
    if (rootNumber === null) next.rootSizeGib = '请输入大于 0 的容量';
    if (cpuNumber === null) next.cpuVcpus = '请输入大于 0 的核数';
    if (memNumber === null) next.memGib = '请输入大于 0 的内存';
    return next;
  };

  const submit = () => {
    const fieldErrors = validate();
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0 || overQuota) return;
    const parsed = zCreateContainerRequest.safeParse({
      serverId: form.serverId,
      imageId: form.imageId,
      name: form.name.trim(),
      rootSizeBytes,
      cpuMillis,
      memBytes,
      gpuPciAddresses: selected?.gpuEnabled ? gpuPciAddresses : undefined,
      powerIntent: form.startAfterCreate ? ContainerPowerIntent.Running : ContainerPowerIntent.Stopped,
    });
    if (!parsed.success) {
      setSubmitError('请检查容器规格');
      return;
    }
    create.mutate(parsed.data);
  };

  const serverPlaceholder = serversLoading
    ? '加载中…'
    : servers.length === 0
      ? '暂无可用服务器'
      : '选择服务器';
  const imagePlaceholder = !form.serverId
    ? '先选择服务器'
    : noImagesForServer
      ? '没有可用镜像'
      : '选择镜像';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="container-create-canonical">
        <DialogHeader>
          <DialogTitle>新建容器</DialogTitle>
          <DialogDescription>创建后可通过 SSH 跳板机登录，规格之后也能调整。</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField id="container-name" label="名称" error={errors.name} hint="字母、数字和连字符，例如 dev-ubuntu">
            <Input
              id="container-name"
              value={form.name}
              autoFocus
              autoComplete="off"
              onChange={(event) => update('name', event.target.value)}
              placeholder="dev-ubuntu"
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="container-server"
              label="服务器"
              value={form.serverId}
              onChange={(value) => {
                update('serverId', value);
                update('imageId', '');
                setGpuPciAddresses(undefined);
              }}
              options={servers.map((server) => [server.id, server.name])}
              placeholder={serverPlaceholder}
              disabled={serversLoading || servers.length === 0}
              error={errors.serverId}
              hint={!serversLoading && servers.length === 0 ? '没有你可以使用的在线服务器，请联系管理员分配。' : undefined}
            />
            <SelectField
              key={form.serverId || 'no-server'}
              id="container-image"
              label="镜像"
              value={form.imageId}
              onChange={(value) => update('imageId', value)}
              options={images.map((image) => [image.id, image.alias])}
              placeholder={imagePlaceholder}
              disabled={!form.serverId || noImagesForServer}
              error={errors.imageId}
              hint={noImagesForServer ? '这台服务器还没有分配给你的镜像，请联系管理员。' : undefined}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <UnitField
              id="container-cpu"
              label="CPU（核）"
              value={form.cpuVcpus}
              onChange={(value) => update('cpuVcpus', value)}
              step="0.5"
              error={errors.cpuVcpus ?? (cpuOver && cpuLeft !== null ? `超出剩余额度 ${cpuText(cpuLeft)}` : undefined)}
            />
            <UnitField
              id="container-memory"
              label="内存（GiB）"
              value={form.memGib}
              onChange={(value) => update('memGib', value)}
              error={errors.memGib ?? (memOver && memLeft !== null ? `超出剩余额度 ${bytesText(memLeft)}` : undefined)}
            />
            <UnitField
              id="container-root-size"
              label="系统盘（GiB）"
              value={form.rootSizeGib}
              onChange={(value) => update('rootSizeGib', value)}
              error={errors.rootSizeGib ?? (diskOver && diskLeft !== null ? `超出剩余容量 ${bytesText(diskLeft)}` : undefined)}
            />
          </div>
          {selectedAccess ? (
            <p className="text-xs text-muted-foreground" data-testid="create-remaining">
              这台服务器上你还剩：
              <RemainingPart label="CPU" value={cpuLeft === null ? (onServer ? '不限' : '…') : cpuText(cpuLeft)} over={cpuOver} />
              {' · '}
              <RemainingPart label="内存" value={memLeft === null ? (onServer ? '不限' : '…') : bytesText(memLeft)} over={memOver} />
              {' · '}
              <RemainingPart
                label="磁盘"
                value={capacityQuery.isError ? '暂不可知' : diskLeft === null ? (capacityQuery.data ? '不限' : '…') : bytesText(diskLeft)}
                over={diskOver}
              />
            </p>
          ) : null}
          <ContainerCreateGpu
            serverId={form.serverId}
            gpuEnabled={selected?.gpuEnabled === true}
            grantedAddresses={selectedAccess?.gpuPciAddresses ?? null}
            value={gpuPciAddresses ?? []}
            onChange={setGpuPciAddresses}
          />
          <FormField id="container-start" label="创建后立即启动" orientation="inline">
            <Checkbox
              id="container-start"
              checked={form.startAfterCreate}
              onCheckedChange={(checked) => update('startAfterCreate', checked === true)}
            />
          </FormField>
          {sshKeys.missing ? <SshKeyNotice variant="inline" onNavigate={() => onOpenChange(false)} /> : null}
          {submitError ? <p className="text-sm text-destructive" role="alert">{submitError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={create.isPending || serversLoading || overQuota}>
              {create.isPending ? '提交中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemainingPart({ label, value, over }: { label: string; value: string; over: boolean }) {
  return (
    <span className={cn(over && 'font-medium text-destructive')}>
      {label} {value}
    </span>
  );
}

function UnitField({
  id,
  label,
  value,
  onChange,
  error,
  step = '1',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  step?: string;
}) {
  return (
    <FormField id={id} label={label} error={error}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step={step}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}
