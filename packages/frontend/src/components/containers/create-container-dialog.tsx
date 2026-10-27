import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTAINER_NAME_MAX_LENGTH,
  CONTAINER_NAME_RE,
  type ContainerDto,
  ContainerPowerIntent,
  type CreateContainerRequest,
  type EffectiveAccessDto,
  type ImageDto,
  type IntentAcceptedDto,
  type LiveServerAccessDto,
  type PerformanceUsageResponse,
  type StorageCapacityDto,
  type UserServerDto,
  zCreateContainerRequest,
} from '@nyabase/common';
import { Lock } from 'lucide-react';
import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField, SelectField } from '../layout/form-field.js';
import { useOpenSession } from '../../hooks/use-dom-state.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { SshKeyNotice } from '../ssh/ssh-key-notice.js';
import { Checkbox } from '../ui/checkbox.js';
import { ContainerCreateGpu } from '../gpu/gpu-sections.js';
import { GIB, gibToBytes } from '../../lib/utils.js';
import { SizeField, parsePositiveGib } from '../ui/size-slider.js';
import { QuotaLine, type QuotaLineQuota, quotaFrom } from '../quota/quota-line.js';
import { sizeScale } from '../../lib/size-ladder.js';
import { useFittedDefaultSize } from '../../hooks/use-fitted-default-size.js';
import { cpuGrantLabel } from '../../lib/cpu-set.js';
import { defaultResourceName } from '../../lib/default-names.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { containerActionSubmittedTitle } from '../../lib/status-labels.js';
import { formatConsumedQuotaParts, runningMemBytes } from '../../lib/grant-quota.js';
import { liveServerAccess } from '../../lib/effective-access.js';

interface CreateContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultServerId?: string;
}

export function CreateContainerDialog(props: CreateContainerDialogProps) {
  return <CreateContainerBody key={useOpenSession(props.open)} {...props} />;
}

function CreateContainerBody({ open, onOpenChange, defaultServerId }: CreateContainerDialogProps) {
  const form = useCreateContainerForm({ open, onOpenChange, defaultServerId });
  const sshKeys = useMySshKeys(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="container-create-canonical">
        <DialogHeader>
          <DialogTitle>新建容器</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            form.submit();
          }}
        >
          <FormField id="container-name" label="名称" error={form.errors.name} hint={`字母、数字、连字符，最多 ${CONTAINER_NAME_MAX_LENGTH} 个字符`}>
            <Input
              id="container-name"
              value={form.name}
              autoFocus
              autoComplete="off"
              onChange={(event) => form.setName(event.target.value)}
              placeholder={form.defaultName}
            />
          </FormField>
          <PlacementFields form={form} />
          <SpecFields form={form} />
          <GpuAndStartFields form={form} />
          {sshKeys.missing ? <SshKeyNotice variant="inline" onNavigate={() => onOpenChange(false)} /> : null}
          {form.submitError ? <p className="text-sm text-destructive" role="alert">{form.submitError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={form.pending || form.data.serversLoading || form.overQuota}>
              {form.pending ? '提交中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Server and image pickers. */
function PlacementFields({ form }: { form: CreateContainerForm }) {
  const { servers, images, serversLoading, imagesLoading } = form.data;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField
        id="container-server"
        label="服务器"
        value={form.form.serverId}
        onChange={(value) => {
          form.update('serverId', value);
          form.update('imageId', '');
          form.setGpuPciAddresses(undefined);
        }}
        options={servers.map((server) => [server.id, server.name])}
        placeholder="选择服务器"
        loading={serversLoading}
        emptyText="没有可用的服务器"
        error={form.errors.serverId}
      />
      <SelectField
        key={form.form.serverId || 'no-server'}
        id="container-image"
        label="镜像"
        value={form.form.imageId}
        onChange={(value) => form.update('imageId', value)}
        options={images.map((image) => [image.id, image.alias])}
        placeholder={form.form.serverId ? '选择镜像' : '先选择服务器'}
        disabled={!form.form.serverId}
        loading={Boolean(form.form.serverId) && imagesLoading}
        emptyText={form.form.serverId ? '没有可用的镜像' : undefined}
        error={form.errors.imageId}
      />
    </div>
  );
}

/** The CPU the grant pins on the chosen server: shown, never chosen. */
function CpuField({ access }: { access: LiveServerAccessDto | undefined }) {
  const text = access ? cpuGrantLabel(access) : '—';
  return (
    <FormField id="container-cpu" label="CPU">
      <div className="relative sm:w-1/2">
        <Input
          id="container-cpu"
          readOnly
          value={text}
          data-testid="create-cpu"
          className="cursor-not-allowed border-dashed bg-muted/50 pr-9 tabular-nums text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <Lock className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </div>
    </FormField>
  );
}

/** Locked CPU, then memory and root disk sliders, each with the quota left on the chosen server. */
function SpecFields({ form }: { form: CreateContainerForm }) {
  const { memLeft, diskLeft, memOver, diskOver } = form;
  const { selectedAccess } = form.data;
  const starting = form.form.startAfterCreate;
  return (
    <>
      <CpuField access={selectedAccess} />
      <SizeField
        id="container-memory"
        label="内存"
        value={form.form.memGib}
        onChange={(value) => form.update('memGib', value)}
        scale={form.limits.memScale}
        availableGib={starting && memLeft !== null ? memLeft / GIB : null}
        invalid={memOver}
        error={form.errors.memGib ?? (memOver && memLeft !== null ? `超出剩余额度 ${bytesText(memLeft)}` : undefined)}
      >
        {selectedAccess ? (
          <QuotaLine
            quota={form.limits.memQuota}
            over={memOver}
            inactiveHint={starting ? undefined : '启动时检查'}
            testId="create-remaining-memory"
          />
        ) : null}
      </SizeField>
      <SizeField
        id="container-root-size"
        label="系统盘"
        value={form.form.rootSizeGib}
        onChange={(value) => form.update('rootSizeGib', value)}
        scale={form.limits.diskScale}
        availableGib={diskLeft === null ? null : diskLeft / GIB}
        invalid={diskOver}
        error={form.errors.rootSizeGib ?? (diskOver && diskLeft !== null ? `超出剩余容量 ${bytesText(diskLeft)}` : undefined)}
      >
        {selectedAccess ? (
          <QuotaLine quota={form.limits.diskQuota} over={diskOver} testId="create-remaining-disk" />
        ) : null}
      </SizeField>
    </>
  );
}

function GpuAndStartFields({ form }: { form: CreateContainerForm }) {
  return (
    <>
      <ContainerCreateGpu
        serverId={form.form.serverId}
        gpuEnabled={form.selected?.gpuEnabled === true}
        grantedAddresses={form.data.selectedAccess?.gpuPciAddresses ?? null}
        value={form.gpuPciAddresses ?? []}
        onChange={form.setGpuPciAddresses}
      />
      <FormField id="container-start" label="创建后立即启动" orientation="inline">
        <Checkbox
          id="container-start"
          checked={form.form.startAfterCreate}
          onCheckedChange={(checked) => form.update('startAfterCreate', checked === true)}
        />
      </FormField>
    </>
  );
}

/** State, defaults, quota checks and submission of the create-container form. */
function useCreateContainerForm({
  open,
  onOpenChange,
  defaultServerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultServerId?: string;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>({ ...emptyForm, serverId: defaultServerId ?? '' });
  const [gpuPciAddresses, setGpuPciAddresses] = useState<string[] | undefined>(undefined);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const data = useCreateContainerData(open, form.serverId);
  const { servers, images, selectedAccess } = data;
  const selected = servers.find((server) => server.id === form.serverId);
  // Names are unique per owner, ignoring case: skip every name the user already has.
  const defaultName = useMemo(
    () => defaultResourceName('ins', (data.containersQuery.data ?? []).map((container) => container.name)),
    [data.containersQuery.data],
  );
  const name = nameTouched ? form.name : defaultName;

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

  const memNumber = parsePositiveGib(form.memGib);
  const rootNumber = parsePositiveGib(form.rootSizeGib);
  const memBytes = memNumber === null ? null : gibToBytes(memNumber);
  const rootSizeBytes = rootNumber === null ? null : gibToBytes(rootNumber);

  const containersQuery = data.containersQuery;
  const onServer = containersQuery.isSuccess
    ? (containersQuery.data ?? []).filter((container) => container.serverId === form.serverId)
    : null;
  const memLeft = selectedAccess && onServer
    ? remaining(selectedAccess.memBytes, runningMemBytes(onServer))
    : null;
  const diskLeft = data.capacityQuery.data?.availableBytes ?? null;

  // A stopped create needs no memory headroom; it is checked when the container starts.
  const memOver = form.startAfterCreate && memLeft !== null && memBytes !== null && memBytes > memLeft;
  const diskOver = diskLeft !== null && rootSizeBytes !== null && rootSizeBytes > diskLeft;
  const overQuota = memOver || diskOver;
  const limits = specLimits(data, memLeft);

  // Until the user moves a slider, its default shrinks to fit what is left.
  const setMemText = useCallback((memGib: string) => {
    setForm((current) => (current.memGib === memGib ? current : { ...current, memGib }));
  }, []);
  const setRootText = useCallback((rootSizeGib: string) => {
    setForm((current) => (current.rootSizeGib === rootSizeGib ? current : { ...current, rootSizeGib }));
  }, []);
  const memDefault = useFittedDefaultSize({
    enabled: open,
    defaultGib: Number(emptyForm.memGib),
    stops: limits.memScale.stops,
    availableGib: form.startAfterCreate && memLeft !== null ? memLeft / GIB : null,
    setText: setMemText,
  });
  const rootDefault = useFittedDefaultSize({
    enabled: open,
    defaultGib: Number(emptyForm.rootSizeGib),
    stops: limits.diskScale.stops,
    availableGib: diskLeft === null ? null : diskLeft / GIB,
    setText: setRootText,
  });

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
    if (key === 'memGib') memDefault.markTouched();
    if (key === 'rootSizeGib') rootDefault.markTouched();
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setSubmitError(null);
  };

  const setName = (value: string) => {
    setNameTouched(true);
    update('name', value);
  };

  const submit = () => {
    const fieldErrors = validateForm({ ...form, name });
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0 || overQuota) return;
    const parsed = zCreateContainerRequest.safeParse({
      serverId: form.serverId,
      imageId: form.imageId,
      name: name.trim(),
      rootSizeBytes,
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

  return {
    form,
    errors,
    submitError,
    data,
    selected,
    name,
    defaultName,
    setName,
    limits,
    memLeft,
    diskLeft,
    memOver,
    diskOver,
    overQuota,
    gpuPciAddresses,
    setGpuPciAddresses,
    pending: create.isPending,
    update,
    submit,
  };
}

type CreateContainerForm = ReturnType<typeof useCreateContainerForm>;

/**
 * What the create form can choose from: servers the user currently has access
 * to, the images allowed on the chosen server, and the quota left there.
 */
function useCreateContainerData(open: boolean, serverId: string) {
  const serversQuery = useQuery({ queryKey: queryKeys.servers.user, queryFn: () => api.get<UserServerDto[]>('/servers'), enabled: open });
  const imagesQuery = useQuery({ queryKey: queryKeys.images.userActive, queryFn: () => api.get<ImageDto[]>('/images?activeOnly=true'), enabled: open });
  const accessQuery = useQuery({ queryKey: queryKeys.meAccess, queryFn: () => api.get<EffectiveAccessDto>('/me/access'), enabled: open });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: open,
  });
  const capacityQuery = useQuery({
    queryKey: queryKeys.storageCapacity(serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${serverId}/storage-capacity`),
    enabled: open && serverId.length > 0,
  });
  const liveAccess = liveServerAccess(accessQuery.data?.servers);
  const selectedAccess = liveAccess.find((server) => server.serverId === serverId);
  // Without a memory limit the slider runs up to the host's memory.
  const memUnlimited = selectedAccess !== undefined && !selectedAccess.memBytes;
  const usageQuery = useQuery({
    queryKey: queryKeys.performance.servers('mine'),
    queryFn: () => api.get<PerformanceUsageResponse>('/performance/usage'),
    enabled: open && memUnlimited,
  });
  const hostMemBytes = usageQuery.data?.servers.find((server) => server.serverId === serverId)?.host.memory.limitBytes ?? null;

  const liveServerIds = useMemo(() => new Set(
    liveServerAccess(accessQuery.data?.servers).map((server) => server.serverId),
  ), [accessQuery.data]);
  const servers = useMemo(
    () => (serversQuery.data ?? []).filter((server) => server.status === 'online' && liveServerIds.has(server.id)),
    [serversQuery.data, liveServerIds],
  );
  const images = useMemo(() => {
    const allowed = new Set(selectedAccess?.allowedImageIds ?? []);
    return (imagesQuery.data ?? []).filter((image) => allowed.has(image.id));
  }, [imagesQuery.data, selectedAccess]);

  return {
    imagesQuery,
    containersQuery,
    capacityQuery,
    servers,
    images,
    selectedAccess,
    hostMemBytes,
    serversLoading: open && (serversQuery.isLoading || accessQuery.isLoading),
    imagesLoading: imagesQuery.isLoading || accessQuery.isLoading,
  };
}

type CreateContainerData = ReturnType<typeof useCreateContainerData>;

/**
 * Slider ranges and quota lines of the chosen server. Memory runs to the grant
 * limit, or the host's memory when unlimited; the root disk to the disk grant,
 * or the 4 TiB ladder when unlimited (its pool is not exposed to users).
 */
function specLimits(data: CreateContainerData, memLeft: number | null): {
  memScale: ReturnType<typeof sizeScale>;
  diskScale: ReturnType<typeof sizeScale>;
  memQuota: QuotaLineQuota;
  diskQuota: QuotaLineQuota;
} {
  const { selectedAccess, capacityQuery, containersQuery } = data;
  const memLimit = selectedAccess?.memBytes || null;
  const memMaxBytes = memLimit ?? data.hostMemBytes;
  const capacity = capacityQuery.data;
  const diskLimit = capacity?.grantLimitBytes || null;
  return {
    memScale: sizeScale('memory', memMaxBytes === null ? null : memMaxBytes / GIB),
    diskScale: sizeScale('disk', diskLimit === null ? null : diskLimit / GIB),
    memQuota: containersQuery.isError && memLimit !== null
      ? { kind: 'unknown' }
      : quotaFrom(selectedAccess ? memLimit : undefined, memLeft),
    diskQuota: capacityQuery.isError
      ? { kind: 'unknown' }
      : quotaFrom(capacity ? capacity.grantLimitBytes : undefined, capacity?.availableBytes),
  };
}

type FormState = {
  serverId: string;
  imageId: string;
  name: string;
  rootSizeGib: string;
  memGib: string;
  startAfterCreate: boolean;
};

type FieldErrors = Partial<Record<'name' | 'serverId' | 'imageId' | 'rootSizeGib' | 'memGib', string>>;

const emptyForm: FormState = {
  serverId: '',
  imageId: '',
  name: '',
  rootSizeGib: '20',
  memGib: '2',
  startAfterCreate: true,
};

/** Remaining room under a grant; null when the grant does not limit it. */
function remaining(limit: number | null, used: number): number | null {
  if (limit === null || limit === 0) return null;
  return Math.max(0, limit - used);
}

function bytesText(bytes: number): string {
  return formatConsumedQuotaParts({ cpuCores: null, memBytes: bytes, diskBytes: null })[0] ?? '';
}

/** Field-level problems of the form; empty when it can be submitted. */
function validateForm(form: FormState): FieldErrors {
  const next: FieldErrors = {};
  const name = form.name.trim();
  if (!name) next.name = '请输入容器名称';
  else if (name.length > CONTAINER_NAME_MAX_LENGTH) next.name = `名称最长 ${CONTAINER_NAME_MAX_LENGTH} 个字符`;
  else if (!CONTAINER_NAME_RE.test(name)) next.name = '只能使用字母、数字和连字符，且不能以连字符开头';
  if (!form.serverId) next.serverId = '请选择服务器';
  if (!form.imageId) next.imageId = '请选择镜像';
  if (parsePositiveGib(form.rootSizeGib) === null) next.rootSizeGib = '请输入大于 0 的容量';
  if (parsePositiveGib(form.memGib) === null) next.memGib = '请输入大于 0 的内存';
  return next;
}
