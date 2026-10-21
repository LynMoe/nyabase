import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IntentResourceType,
  type CreateSharedVolumeRequest,
  type EffectiveAccessDto,
  type IntentAcceptedDto,
  type PatchVolumeRequest,
  type SharedBackendDto,
  type SharedVolumeDto,
} from '@nyabase/common';
import { api } from '../../../lib/api.js';
import { errorMessage } from '../../../lib/api-error.js';
import { queryKeys } from '../../../lib/query-keys.js';
import { toast } from '../../../hooks/use-toast.js';
import { isIntentAccepted, resourceIntentsPath, waitForResourceIntent } from '../../../lib/intent-visibility.js';

/** The queries and mutations behind the shared volume form. */
export function useSharedVolumeData({
  open,
  sharedVolume,
  onSaved,
  onError,
}: {
  open: boolean;
  sharedVolume: SharedVolumeDto | undefined;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const editing = sharedVolume;
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: open && !editing,
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    enabled: open,
  });
  const createShared = useMutation({
    mutationFn: (body: CreateSharedVolumeRequest) => api.post<unknown>('/shared-volumes', body),
    onSuccess: () => {
      toast({ title: '已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      onSaved();
    },
    onError: (mutationError) => onError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: async (body: PatchVolumeRequest) => {
      const volumeId = sharedVolume?.id ?? '';
      const accepted = await api.patch<IntentAcceptedDto | SharedVolumeDto>(
        `/shared-volumes/${volumeId}`,
        body,
      );
      if (isIntentAccepted(accepted)) {
        await waitForResourceIntent(
          resourceIntentsPath('mine', IntentResourceType.Volume, volumeId),
          accepted.intentId,
        );
      }
    },
    onSuccess: () => {
      toast({ title: '已保存' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
      onSaved();
    },
    onError: (mutationError) => {
      onError(errorMessage(mutationError));
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
    },
  });
  return { backendsQuery, accessQuery, createShared, patch };
}
