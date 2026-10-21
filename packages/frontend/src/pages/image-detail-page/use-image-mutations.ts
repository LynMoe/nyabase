import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ImageAssignmentDto, IntentAcceptedDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';

type AssignmentResponse = {
  assignment: ImageAssignmentDto;
  intent?: IntentAcceptedDto;
};

/** Assign, unassign, repull and delete for one image; each refreshes the image and its intents. */
export function useImageMutations({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const navigate = useNavigate({ from: '/images/$id' });
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.images.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
    void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
  };

  const assign = useMutation({
    mutationFn: ({ serverId, expectedRevision }: { serverId: string; expectedRevision?: number }) =>
      api.put<AssignmentResponse>(`/images/${id}/assignments/${serverId}`, expectedRevision ? { expectedRevision } : {}),
    onSuccess: (result) => {
      toast({ title: '已开始分配镜像', description: result.intent ? `操作 ${result.intent.intentId.slice(0, 8)}` : undefined });
      invalidate();
    },
    onError: (error) => toast({ title: '镜像分配失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const unassign = useMutation({
    mutationFn: ({ serverId, revision }: { serverId: string; revision: number }) =>
      api.delete<AssignmentResponse>(`/images/${id}/assignments/${serverId}?expectedRevision=${revision}`),
    onSuccess: () => {
      toast({ title: '已开始取消分配镜像' });
      invalidate();
    },
    onError: (error) => toast({ title: '取消分配失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const repullImage = useMutation({
    mutationFn: () => api.post<unknown>(`/images/${id}/repull`),
    onSuccess: () => {
      toast({ title: '已从镜像源重新拉取' });
      invalidate();
    },
    onError: (error) => toast({ title: '重新拉取失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const deleteImage = useMutation({
    mutationFn: () => api.delete<unknown>(`/images/${id}`),
    onSuccess: () => {
      toast({ title: '已开始移除镜像' });
      onDeleted();
      invalidate();
      void navigate({ to: '/images' });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return { assign, unassign, repullImage, deleteImage };
}

export type ImageMutations = ReturnType<typeof useImageMutations>;
