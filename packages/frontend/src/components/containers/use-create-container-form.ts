import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ContainerDto,
  ContainerPowerIntent,
  type CreateContainerRequest,
  type EffectiveAccessDto,
  type ImageDto,
  type IntentAcceptedDto,
  type StorageCapacityDto,
  type UserServerDto,
  zCreateContainerRequest,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { gibToBytes, vcpuToMillis } from '../../lib/utils.js';
import { containerActionSubmittedTitle } from '../../lib/status-labels.js';
import { formatConsumedQuotaParts } from '../../lib/grant-quota.js';

/** State, defaults, quota checks and submission of the create-container form. */
export function useCreateContainerForm({
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
  const data = useCreateContainerData(open, form.serverId);
  const { servers, images, selectedAccess } = data;
  const selected = servers.find((server) => server.id === form.serverId);
  const noImagesForServer = Boolean(form.serverId) && !data.imagesQuery.isLoading && images.length === 0;

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

  const containersQuery = data.containersQuery;
  const onServer = containersQuery.isSuccess
    ? (containersQuery.data ?? []).filter((container) => container.serverId === form.serverId)
    : null;
  const cpuLeft = selectedAccess && onServer
    ? remaining(selectedAccess.cpuMillis, onServer.reduce((sum, item) => sum + item.cpuMillis, 0))
    : null;
  const memLeft = selectedAccess && onServer
    ? remaining(selectedAccess.memBytes, onServer.reduce((sum, item) => sum + item.memBytes, 0))
    : null;
  const diskLeft = data.capacityQuery.data?.availableBytes ?? null;

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

  const submit = () => {
    const fieldErrors = validateForm(form);
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

  return {
    form,
    errors,
    submitError,
    data,
    selected,
    noImagesForServer,
    onServer,
    cpuLeft,
    memLeft,
    diskLeft,
    cpuOver,
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

export type CreateContainerForm = ReturnType<typeof useCreateContainerForm>;

/**
 * What the create form can choose from: servers the user currently has access
 * to, the images allowed on the chosen server, and the quota left there.
 */
export function useCreateContainerData(open: boolean, serverId: string) {
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

  const liveServerIds = useMemo(() => new Set(
    (accessQuery.data?.servers ?? []).filter((server) => server.accessPhase === 'live').map((server) => server.serverId),
  ), [accessQuery.data]);
  const servers = useMemo(
    () => (serversQuery.data ?? []).filter((server) => server.status === 'online' && liveServerIds.has(server.id)),
    [serversQuery.data, liveServerIds],
  );
  const selectedAccess = accessQuery.data?.servers.find((server) => server.serverId === serverId);
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
    serversLoading: open && (serversQuery.isLoading || accessQuery.isLoading),
  };
}

export type FormState = {
  serverId: string;
  imageId: string;
  name: string;
  rootSizeGib: string;
  cpuVcpus: string;
  memGib: string;
  startAfterCreate: boolean;
};

export type FieldErrors = Partial<Record<'name' | 'serverId' | 'imageId' | 'rootSizeGib' | 'cpuVcpus' | 'memGib', string>>;

export const emptyForm: FormState = {
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
export function remaining(limit: number | null, used: number): number | null {
  if (limit === null || limit === 0) return null;
  return Math.max(0, limit - used);
}

export function cpuText(millis: number): string {
  return formatConsumedQuotaParts({ cpuMillis: millis, memBytes: null, diskBytes: null })[0] ?? '';
}

export function bytesText(bytes: number): string {
  return formatConsumedQuotaParts({ cpuMillis: null, memBytes: bytes, diskBytes: null })[0] ?? '';
}

export function positiveNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Field-level problems of the form; empty when it can be submitted. */
export function validateForm(form: FormState): FieldErrors {
  const next: FieldErrors = {};
  const name = form.name.trim();
  if (!name) next.name = '请输入容器名称';
  else if (name.length > 63) next.name = '名称最长 63 个字符';
  else if (!NAME_RE.test(name)) next.name = '只能使用字母、数字和连字符，且不能以连字符开头';
  if (!form.serverId) next.serverId = '请选择服务器';
  if (!form.imageId) next.imageId = '请选择镜像';
  if (positiveNumber(form.rootSizeGib) === null) next.rootSizeGib = '请输入大于 0 的容量';
  if (positiveNumber(form.cpuVcpus) === null) next.cpuVcpus = '请输入大于 0 的核数';
  if (positiveNumber(form.memGib) === null) next.memGib = '请输入大于 0 的内存';
  return next;
}
