import { useEffect, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { zPatchSharedBackendRequest, type SharedBackendDto } from '@nyabase/common';
import { toast } from '../../hooks/use-toast.js';

type PatchBackend = UseMutationResult<
  SharedBackendDto,
  Error,
  { expectedRevision: number; displayName?: string | null; overcommitRatio?: number }
>;

/** The identity edit form of a shared backend; its fields follow the loaded backend. */
export function useBackendEditForm(
  backend: SharedBackendDto | undefined,
  patchBackend: PatchBackend,
) {
  const [displayName, setDisplayName] = useState('');
  const [overcommitRatio, setOvercommitRatio] = useState('');

  const reset = (from: SharedBackendDto) => {
    setDisplayName(from.displayName ?? '');
    setOvercommitRatio(String(from.overcommitRatio));
  };

  useEffect(() => {
    if (backend) reset(backend);
  }, [backend]);

  const save = () => {
    if (!backend) return;
    const parsed = zPatchSharedBackendRequest.safeParse({
      expectedRevision: backend.revision,
      displayName: displayName.trim() || null,
      overcommitRatio: Number(overcommitRatio),
    });
    if (!parsed.success) {
      toast({
        title: '请检查参数',
        description: parsed.error.issues[0]?.message ?? '显示名称或超分比例无效',
        variant: 'destructive',
      });
      return;
    }
    patchBackend.mutate(parsed.data);
  };

  return { displayName, overcommitRatio, setDisplayName, setOvercommitRatio, reset, save };
}
