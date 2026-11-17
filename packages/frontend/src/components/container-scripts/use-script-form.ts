import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CONTAINER_SCRIPT_BLOB_UPLOAD_PATH,
  CONTAINER_SCRIPT_MAX_FILE_BYTES,
  CONTAINER_SCRIPT_MAX_FILES,
  ContainerScriptFileOwner,
  FailureCode,
  formatBytes,
  type ContainerScriptBlobDto,
  type ContainerScriptDto,
  type ContainerScriptPreviewDto,
  type ContainerScriptScope,
  type CreateContainerScriptRequest,
  type PublishContainerScriptRequest,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { ApiError } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { containerScriptErrorMessage } from '../../lib/container-scripts.js';
import {
  createRequestFromForm,
  DEFAULT_FILE_MODE,
  emptyScriptForm,
  newFileRowKey,
  publishRequestFromForm,
  sanitizeFileName,
  scriptFormFromVersion,
  scriptFormScope,
  uniqueFileName,
  type ScriptFileRow,
  type ScriptForm,
  type ScriptFormErrors,
} from '../../lib/container-script-form.js';

/** Create a script, or publish a new version of `script`. */
export type ScriptFormTarget = { kind: 'create' } | { kind: 'publish'; script: ContainerScriptDto };

export interface ScriptFormArgs {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ScriptFormTarget;
  /** After a create: the new script (the list page opens it). */
  onCreated?: (script: ContainerScriptDto) => void;
}

function initialForm(target: ScriptFormTarget): ScriptForm {
  return target.kind === 'create' ? emptyScriptForm() : scriptFormFromVersion(target.script, target.script.current);
}

const NO_ERRORS: ScriptFormErrors = { fields: {}, files: {} };

/** A preview of one scope; it no longer applies once the scope changes. */
interface ScopePreview {
  scopeKey: string;
  data: ContainerScriptPreviewDto;
}

function useScriptMutations(args: ScriptFormArgs, onFailed: (error: unknown) => void) {
  const queryClient = useQueryClient();
  const preview = useMutation({
    mutationFn: (scope: ContainerScriptScope) =>
      api.post<ContainerScriptPreviewDto>('/admin/container-scripts/preview', { scope }),
  });
  const create = useMutation({
    mutationFn: (body: CreateContainerScriptRequest) => api.post<ContainerScriptDto>('/admin/container-scripts', body),
    onSuccess: (created) => {
      toast({ title: '容器脚本已创建', description: `${created.name} v${created.current.version}` });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containerScripts.all });
      args.onOpenChange(false);
      args.onCreated?.(created);
    },
    onError: onFailed,
  });
  const publish = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PublishContainerScriptRequest }) =>
      api.post<ContainerScriptDto>(`/admin/container-scripts/${id}/versions`, body),
    onSuccess: (updated) => {
      toast({ title: `已发布 v${updated.current.version}` });
      queryClient.setQueryData(queryKeys.containerScripts.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.containerScripts.all });
      args.onOpenChange(false);
    },
    onError: onFailed,
  });
  return { preview, create, publish };
}

function useFileUploads(setForm: (update: (form: ScriptForm) => ScriptForm) => void) {
  const patchRow = (key: string, changes: Partial<ScriptFileRow>) => {
    setForm((form) => ({ ...form, files: form.files.map((row) => (row.key === key ? { ...row, ...changes } : row)) }));
  };
  const upload = (key: string, file: File) => {
    if (file.size > CONTAINER_SCRIPT_MAX_FILE_BYTES) {
      patchRow(key, { uploading: false, uploadError: `文件超过 ${formatBytes(CONTAINER_SCRIPT_MAX_FILE_BYTES)}`, sha256: null });
      return;
    }
    patchRow(key, { uploading: true, uploadError: null, sha256: null, sizeBytes: file.size });
    api.upload<ContainerScriptBlobDto>(CONTAINER_SCRIPT_BLOB_UPLOAD_PATH, file)
      .then((blob) => patchRow(key, { uploading: false, sha256: blob.sha256, sizeBytes: blob.sizeBytes }))
      .catch((error: unknown) => patchRow(key, { uploading: false, uploadError: containerScriptErrorMessage(error) }));
  };
  /** New rows for picked files (named after them), each uploading at once. */
  const addFiles = (files: readonly File[], current: ScriptForm) => {
    const room = CONTAINER_SCRIPT_MAX_FILES - current.files.length;
    if (files.length > room) {
      toast({ title: `最多 ${CONTAINER_SCRIPT_MAX_FILES} 个文件`, description: `只添加了前 ${Math.max(0, room)} 个`, variant: 'destructive' });
    }
    const taken = new Set(current.files.map((row) => row.name));
    const rows = files.slice(0, Math.max(0, room)).map((file) => {
      const name = uniqueFileName(sanitizeFileName(file.name), taken);
      taken.add(name);
      return {
        file,
        row: {
          key: newFileRowKey(),
          name,
          sha256: null,
          sizeBytes: file.size,
          uploading: true,
          uploadError: null,
          path: '',
          mode: DEFAULT_FILE_MODE,
          owner: ContainerScriptFileOwner.Root,
        } satisfies ScriptFileRow,
      };
    });
    setForm((form) => ({ ...form, files: [...form.files, ...rows.map((entry) => entry.row)] }));
    for (const entry of rows) upload(entry.row.key, entry.file);
  };
  return { patchRow, upload, addFiles };
}

/** State and actions of the create / publish dialog: edit, preview the scope, confirm, send. */
export function useScriptForm(args: ScriptFormArgs) {
  const { open, target } = args;
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ScriptForm>(() => initialForm(target));
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ContainerScriptPreviewDto | null>(null);
  const [scopePreview, setScopePreview] = useState<ScopePreview | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialForm(target));
    setAttempted(false);
    setServerError(null);
    setConfirming(null);
    setScopePreview(null);
    // Read when the dialog opens; a refreshed script must not reset the draft.
  }, [open]);

  const onFailed = (error: unknown) => {
    if (error instanceof ApiError && error.code === FailureCode.RevisionConflict && target.kind === 'publish') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.containerScripts.detail(target.script.id) });
    }
    setConfirming(null);
    setServerError(containerScriptErrorMessage(error));
  };
  const { preview, create, publish } = useScriptMutations(args, onFailed);
  const files = useFileUploads(setForm);

  const result = useMemo(
    () => (target.kind === 'create' ? createRequestFromForm(form) : publishRequestFromForm(form, target.script.revision)),
    [form, target],
  );
  const scope = useMemo(() => scriptFormScope(form), [form]);
  const scopeKey = JSON.stringify(scope);
  // Upload problems show at once; the rest after the first submit.
  const errors: ScriptFormErrors = attempted
    ? (result.errors ?? NO_ERRORS)
    : { fields: {}, files: Object.fromEntries(form.files.filter((row) => row.uploadError).map((row) => [row.key, row.uploadError ?? ''])) };

  const update = (changes: Partial<ScriptForm>) => {
    setForm((current) => {
      const next = { ...current, ...changes };
      // 每次开机 implies 新容器.
      if (next.everyBoot) next.onNewContainers = true;
      return next;
    });
    setServerError(null);
  };

  const runPreview = (then?: (data: ContainerScriptPreviewDto) => void) => {
    const key = scopeKey;
    preview.mutate(scope as ContainerScriptScope, {
      onSuccess: (data) => {
        setScopePreview({ scopeKey: key, data });
        then?.(data);
      },
      onError: (error) => setServerError(containerScriptErrorMessage(error)),
    });
  };

  /** Check the form, then show how many containers the scope covers before sending. */
  const submit = () => {
    setAttempted(true);
    if (!result.body) return;
    runPreview((data) => setConfirming(data));
  };
  const confirm = () => {
    if (!result.body) return;
    if (target.kind === 'create') create.mutate(result.body as CreateContainerScriptRequest);
    else publish.mutate({ id: target.script.id, body: result.body as PublishContainerScriptRequest });
  };

  return {
    form,
    update,
    setForm,
    files,
    errors,
    serverError,
    scopePreview: scopePreview?.scopeKey === scopeKey ? scopePreview.data : null,
    previewPending: preview.isPending,
    runPreview: () => runPreview(),
    confirming,
    cancelConfirm: () => setConfirming(null),
    submit,
    confirm,
    sending: create.isPending || publish.isPending,
    uploading: form.files.some((row) => row.uploading),
  };
}

export type ScriptFormState = ReturnType<typeof useScriptForm>;
