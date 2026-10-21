import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ContainerPowerIntent,
  zCreateContainerRequest,
  type CreateContainerRequest,
  type IntentAcceptedDto,
} from '@nyabase/common';
import { api } from '../../../lib/api.js';
import { errorMessage } from '../../../lib/api-error.js';
import { queryKeys } from '../../../lib/query-keys.js';
import { toast } from '../../../hooks/use-toast.js';
import { gibToBytes, vcpuToMillis } from '../../../lib/utils.js';
import { containerActionSubmittedTitle } from '../../../lib/status-labels.js';
import {
  emptyForm,
  positiveNumber,
  remaining,
  validateForm,
  type FieldErrors,
  type FormState,
} from './form-model.js';
import { useCreateContainerData } from './use-create-container-data.js';

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
