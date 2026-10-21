import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { SystemSettingsDto } from '@nyabase/common';
import { api, ApiError, apiErrorCurrent } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { parseSystemSettingDraft } from '../../lib/system-setting-draft.js';
import {
  createRevisionedServerBackedDraft,
  mergeAuthoritativeRevisionedServerBackedDraft,
  mergeRevisionedServerBackedDraft,
  type RevisionedServerBackedDraft,
} from '../../lib/server-backed-draft.js';
import { isSystemSettingsDto } from '../../lib/conflict-snapshots.js';
import { queryKeys } from '../../lib/query-keys.js';
import { editableInputValue } from './settings-sections.js';

type Draft = RevisionedServerBackedDraft<Record<string, string>>;

/** The editable (restart-free) settings as the strings the form inputs hold. */
function editableInputs(settings: SystemSettingsDto): Record<string, string> {
  return Object.fromEntries(
    settings.editable
      .filter((field) => !field.restartRequired)
      .map((field) => [field.key, editableInputValue(field)]),
  );
}

/**
 * The local draft of the system settings. It follows the server's revision:
 * refreshes keep local edits and flag fields the server changed too, and a
 * revision conflict on save merges the authoritative snapshot the same way.
 */
export function useSettingsDraft(settingsQuery: UseQueryResult<SystemSettingsDto>) {
  const qc = useQueryClient();
  const data = settingsQuery.data;
  const [draftState, setDraftState] = useState<Draft | null>(null);
  const editableFields = useMemo(
    () => (data?.editable ?? []).filter((field) => !field.restartRequired),
    [data?.editable],
  );

  useEffect(() => {
    if (!data) return;
    const incoming = Object.fromEntries(editableFields.map((field) => [field.key, editableInputValue(field)]));
    setDraftState((current) => current
      ? mergeRevisionedServerBackedDraft(current, incoming, data.revision)
      : createRevisionedServerBackedDraft(incoming, data.revision));
  }, [data, editableFields]);

  const parsedChanges = useMemo(() => {
    const values: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    if (!data) return { values, errors };
    for (const field of editableFields) {
      if (!draftState?.dirtyFields.has(field.key)) continue;
      const current = draftState.values[field.key];
      if (current === undefined) continue;
      const parsed = parseSystemSettingDraft(field, current);
      if (parsed.success) values[field.key] = parsed.value;
      else errors[field.key] = parsed.error;
    }
    return { values, errors };
  }, [data, draftState, editableFields]);

  const saveSettings = useMutation({
    mutationFn: ({ values, expectedRevision }: {
      values: Record<string, unknown>;
      expectedRevision: number;
    }) => api.patch<SystemSettingsDto>('/admin/system-settings', {
      values,
      expectedRevision,
    }),
    onSuccess: (updated) => {
      qc.setQueryData(queryKeys.systemSettings, updated);
      setDraftState(createRevisionedServerBackedDraft(editableInputs(updated), updated.revision));
      qc.invalidateQueries({ queryKey: queryKeys.publicSettings });
      toast({ title: '系统设置已保存' });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === 'SYSTEM_SETTINGS_REVISION_CONFLICT') {
        const current = apiErrorCurrent(
          error,
          'SYSTEM_SETTINGS_REVISION_CONFLICT',
          isSystemSettingsDto,
        );
        if (current) {
          qc.setQueryData(queryKeys.systemSettings, current);
          const incoming = editableInputs(current);
          setDraftState((draft) => draft
            ? mergeAuthoritativeRevisionedServerBackedDraft(draft, incoming, current.revision)
            : createRevisionedServerBackedDraft(incoming, current.revision));
        } else {
          await qc.refetchQueries({ queryKey: queryKeys.systemSettings, type: 'active' });
        }
      }
      toast({
        title: error instanceof ApiError && error.code === 'SYSTEM_SETTINGS_REVISION_CONFLICT'
          ? '服务器设置已变化'
          : '保存失败',
        description: errorMessage(error, '请检查配置值'),
        variant: 'destructive',
      });
    },
  });

  const hasChanges = Object.keys(parsedChanges.values).length > 0;
  const hasValidationErrors = Object.keys(parsedChanges.errors).length > 0;
  const hasConflicts = (draftState?.conflictFields.size ?? 0) > 0;
  const canSave = hasChanges && !hasValidationErrors && !hasConflicts && !saveSettings.isPending;

  return {
    draftState,
    setDraftState,
    editableFields,
    parsedChanges,
    saveSettings,
    hasConflicts,
    canSave,
    /** Save the changed fields against the revision the draft is based on. */
    submit: () => {
      if (data && draftState && canSave) {
        saveSettings.mutate({
          values: parsedChanges.values,
          expectedRevision: draftState.revision,
        });
      }
    },
  };
}

export type SettingsDraft = ReturnType<typeof useSettingsDraft>;
