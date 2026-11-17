import {
  CONTAINER_SCRIPT_DEFAULT_MAX_ATTEMPTS,
  CONTAINER_SCRIPT_DEFAULT_PAUSE_AFTER_FAILURES,
  CONTAINER_SCRIPT_DEFAULT_TIMEOUT_SECONDS,
  CONTAINER_SCRIPT_FILE_NAME_PATTERN,
  CONTAINER_SCRIPT_MAX_ATTEMPTS_LIMIT,
  CONTAINER_SCRIPT_MAX_FILES,
  CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES,
  CONTAINER_SCRIPT_MAX_SCRIPT_BYTES,
  CONTAINER_SCRIPT_PRIORITY_MAX,
  CONTAINER_SCRIPT_PRIORITY_MIN,
  CONTAINER_SCRIPT_TIMEOUT_MAX_SECONDS,
  CONTAINER_SCRIPT_TIMEOUT_MIN_SECONDS,
  ContainerScriptFileOwner,
  ContainerScriptStoppedPolicy,
  containerScriptPathIssue,
  type ContainerScriptPathIssue,
  formatBytes,
  zCreateContainerScriptRequest,
  zPatchContainerScriptRequest,
  zPublishContainerScriptRequest,
  type ContainerScriptDto,
  type ContainerScriptPreviewDto,
  type ContainerScriptVersionDto,
  type CreateContainerScriptRequest,
  type PatchContainerScriptRequest,
  type PublishContainerScriptRequest,
} from '@nyabase/common';

export const DEFAULT_SCRIPT_BODY = '#!/bin/bash\nset -euo pipefail\n\n';
export const DEFAULT_FILE_MODE = '0644';

/** One file row of the form: uploaded content (by sha256) and where it is installed. */
export interface ScriptFileRow {
  /** Stable React key; never sent. */
  key: string;
  name: string;
  /** null while the upload runs or after it failed. */
  sha256: string | null;
  sizeBytes: number | null;
  uploading: boolean;
  uploadError: string | null;
  /** '' = only copied into the run's files directory, not installed. */
  path: string;
  mode: string;
  owner: ContainerScriptFileOwner;
}

export interface ScriptForm {
  /** Create only: name, description, priority and everyBoot. */
  name: string;
  description: string;
  priority: string;
  everyBoot: boolean;
  applyNow: boolean;
  onNewContainers: boolean;
  stoppedPolicy: ContainerScriptStoppedPolicy;
  scopeAll: boolean;
  serverIds: string[];
  imageIds: string[];
  ownerIds: string[];
  containerIds: string[];
  excludeContainerIds: string[];
  script: string;
  files: ScriptFileRow[];
  timeoutSeconds: string;
  maxAttempts: string;
  maxParallel: string;
  maxParallelPerServer: string;
  canaryCount: string;
  pauseAfterFailures: string;
  note: string;
}

export type ScriptFormField =
  | 'name' | 'description' | 'priority' | 'triggers' | 'scope' | 'script' | 'files'
  | 'timeoutSeconds' | 'maxAttempts' | 'maxParallel' | 'maxParallelPerServer' | 'canaryCount'
  | 'pauseAfterFailures' | 'note' | 'form';

export interface ScriptFormErrors {
  fields: Partial<Record<ScriptFormField, string>>;
  /** Per file row (by key). */
  files: Record<string, string>;
}

let rowSequence = 0;
export function newFileRowKey(): string {
  rowSequence += 1;
  return `file-${rowSequence}`;
}

export function emptyScriptForm(): ScriptForm {
  return {
    name: '',
    description: '',
    priority: '',
    everyBoot: false,
    applyNow: true,
    onNewContainers: true,
    stoppedPolicy: ContainerScriptStoppedPolicy.Wait,
    scopeAll: true,
    serverIds: [],
    imageIds: [],
    ownerIds: [],
    containerIds: [],
    excludeContainerIds: [],
    script: DEFAULT_SCRIPT_BODY,
    files: [],
    timeoutSeconds: String(CONTAINER_SCRIPT_DEFAULT_TIMEOUT_SECONDS),
    maxAttempts: String(CONTAINER_SCRIPT_DEFAULT_MAX_ATTEMPTS),
    maxParallel: '',
    maxParallelPerServer: '',
    canaryCount: '',
    pauseAfterFailures: String(CONTAINER_SCRIPT_DEFAULT_PAUSE_AFTER_FAILURES),
    note: '',
  };
}

const optional = (value: number | null) => (value === null ? '' : String(value));

/** A publish form prefilled from the script's current version; files keep their content (sha256). */
export function scriptFormFromVersion(
  script: Pick<ContainerScriptDto, 'name' | 'description' | 'priority' | 'everyBoot'>,
  version: ContainerScriptVersionDto,
): ScriptForm {
  return {
    name: script.name,
    description: script.description,
    priority: String(script.priority),
    everyBoot: script.everyBoot,
    applyNow: version.applyNow,
    onNewContainers: script.everyBoot || version.onNewContainers,
    stoppedPolicy: version.stoppedPolicy,
    scopeAll: version.scope.all,
    serverIds: [...version.scope.serverIds],
    imageIds: [...version.scope.imageIds],
    ownerIds: [...version.scope.ownerIds],
    containerIds: [...version.scope.containerIds],
    excludeContainerIds: [...version.scope.excludeContainerIds],
    script: version.script,
    files: version.files.map((file) => ({
      key: newFileRowKey(),
      name: file.name,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      uploading: false,
      uploadError: null,
      path: file.destination?.path ?? '',
      mode: file.destination?.mode ?? DEFAULT_FILE_MODE,
      owner: file.destination?.owner ?? ContainerScriptFileOwner.Root,
    })),
    timeoutSeconds: String(version.timeoutSeconds),
    maxAttempts: String(version.maxAttempts),
    maxParallel: optional(version.maxParallel),
    maxParallelPerServer: optional(version.maxParallelPerServer),
    canaryCount: optional(version.canaryCount),
    pauseAfterFailures: optional(version.pauseAfterFailures),
    // A new version says what changed in it.
    note: '',
  };
}

/** A file's name in the version: its basename with anything outside [A-Za-z0-9._-] replaced. */
export function sanitizeFileName(basename: string): string {
  const base = basename.split(/[\\/]/).pop() ?? '';
  let name = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  if (!name) name = 'file';
  name = name.slice(0, 128);
  return CONTAINER_SCRIPT_FILE_NAME_PATTERN.test(name) ? name : 'file';
}

/** `name`, or `name-2.ext`, `name-3.ext`… when it is taken. */
export function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; ; index += 1) {
    const candidate = `${stem.slice(0, 120 - ext.length)}-${index}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Every file row's size that is known (uploaded). */
export function filesTotalBytes(files: readonly ScriptFileRow[]): number {
  return files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
}

/** Effective triggers: 每次开机 always runs on new containers too. */
export function effectiveOnNewContainers(form: Pick<ScriptForm, 'everyBoot' | 'onNewContainers'>): boolean {
  return form.everyBoot || form.onNewContainers;
}

/** The 停机容器 choice only applies to 立即 on a once-script. */
export function stoppedPolicyApplies(form: Pick<ScriptForm, 'everyBoot' | 'applyNow'>): boolean {
  return form.applyNow && !form.everyBoot;
}

export function scriptFormScope(form: ScriptForm) {
  return form.scopeAll
    ? {
      all: true,
      serverIds: [],
      imageIds: [],
      ownerIds: [],
      containerIds: [],
      excludeContainerIds: [...form.excludeContainerIds],
    }
    : {
      all: false,
      serverIds: [...form.serverIds],
      imageIds: [...form.imageIds],
      ownerIds: [...form.ownerIds],
      containerIds: [...form.containerIds],
      excludeContainerIds: [...form.excludeContainerIds],
    };
}

export function scopeHasFilter(form: ScriptForm): boolean {
  return form.serverIds.length + form.imageIds.length + form.ownerIds.length + form.containerIds.length > 0;
}

type IntRule = { min: number; max: number; blank: 'null' | 'required' };

function parseIntField(text: string, rule: IntRule): { value: number | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) {
    return rule.blank === 'null' ? { value: null, error: null } : { value: null, error: '请填写' };
  }
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || value < rule.min || value > rule.max) {
    return { value: null, error: `须为 ${rule.min}–${rule.max} 的整数` };
  }
  return { value, error: null };
}

const PATH_ISSUES: Record<Exclude<ContainerScriptPathIssue['code'], 'forbidden_prefix'>, string> = {
  not_absolute: '须为以 / 开头的绝对路径',
  too_long: '路径过长',
  control_characters: '路径含控制字符',
  directory: '须为文件路径，不能以 / 结尾',
  empty_segment: '路径含空段（//）',
  dot_segment: '路径不能含 . 或 ..',
};

/** Why a file cannot be installed at `path`, in Chinese; null when it can. */
export function installPathProblem(path: string): string | null {
  const issue = containerScriptPathIssue(path);
  if (!issue) return null;
  return issue.code === 'forbidden_prefix' ? `不能安装到 ${issue.prefix} 下` : PATH_ISSUES[issue.code];
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateFiles(files: readonly ScriptFileRow[], errors: ScriptFormErrors): void {
  if (files.length > CONTAINER_SCRIPT_MAX_FILES) errors.fields.files = `最多 ${CONTAINER_SCRIPT_MAX_FILES} 个文件`;
  if (filesTotalBytes(files) > CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES) {
    errors.fields.files = `文件合计不能超过 ${formatBytes(CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES)}`;
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const file of files) {
    let problem: string | null = null;
    const path = file.path.trim();
    if (file.uploading) problem = '文件仍在上传';
    else if (!file.sha256) problem = file.uploadError ?? '请上传文件';
    else if (!CONTAINER_SCRIPT_FILE_NAME_PATTERN.test(file.name)) problem = '名称只能含字母、数字、.、_、-（最多 128 个）';
    else if (names.has(file.name)) problem = `文件名 ${file.name} 重复`;
    else if (path && installPathProblem(path)) problem = installPathProblem(path);
    else if (path && paths.has(path)) problem = `两个文件都安装到 ${path}`;
    else if (path && !/^[0-7]{3,4}$/.test(file.mode.trim())) problem = '权限须为八进制，例如 0644';
    names.add(file.name);
    if (path) paths.add(path);
    if (problem) errors.files[file.key] = problem;
  }
}

/** The version fields (shared by create and publish), or the errors that stop them. */
/**
 * `creating`: a new script needs a trigger. A new version may have none: it
 * then only replaces the old one for containers that have not finished it.
 */
function versionFields(form: ScriptForm, errors: ScriptFormErrors, creating: boolean) {
  const onNewContainers = effectiveOnNewContainers(form);
  if (creating && !form.applyNow && !onNewContainers) errors.fields.triggers = '至少选择一种触发方式';
  if (!form.scopeAll && !scopeHasFilter(form)) errors.fields.scope = '请选择“全部容器”或至少一个筛选条件';
  if (!form.script.startsWith('#!')) errors.fields.script = '脚本须以 #! 行开头（例如 #!/bin/bash）';
  else if (form.script.includes('\u0000')) errors.fields.script = '脚本不能含 NUL 字符';
  else if (utf8Bytes(form.script) > CONTAINER_SCRIPT_MAX_SCRIPT_BYTES) {
    errors.fields.script = `脚本不能超过 ${formatBytes(CONTAINER_SCRIPT_MAX_SCRIPT_BYTES)}`;
  }
  validateFiles(form.files, errors);
  const numbers = {
    timeoutSeconds: parseIntField(form.timeoutSeconds, {
      min: CONTAINER_SCRIPT_TIMEOUT_MIN_SECONDS, max: CONTAINER_SCRIPT_TIMEOUT_MAX_SECONDS, blank: 'required',
    }),
    maxAttempts: parseIntField(form.maxAttempts, { min: 1, max: CONTAINER_SCRIPT_MAX_ATTEMPTS_LIMIT, blank: 'required' }),
    maxParallel: parseIntField(form.maxParallel, { min: 1, max: 1_000, blank: 'null' }),
    maxParallelPerServer: parseIntField(form.maxParallelPerServer, { min: 1, max: 100, blank: 'null' }),
    canaryCount: parseIntField(form.canaryCount, { min: 1, max: 10_000, blank: 'null' }),
    pauseAfterFailures: parseIntField(form.pauseAfterFailures, { min: 1, max: 10_000, blank: 'null' }),
  };
  for (const [key, parsed] of Object.entries(numbers)) {
    if (parsed.error) errors.fields[key as ScriptFormField] = parsed.error;
  }
  return {
    script: form.script,
    files: form.files.map((file) => ({
      name: file.name,
      sha256: file.sha256 ?? '',
      destination: file.path.trim()
        ? { path: file.path.trim(), mode: file.mode.trim() || DEFAULT_FILE_MODE, owner: file.owner }
        : null,
    })),
    scope: scriptFormScope(form),
    onNewContainers,
    applyNow: form.applyNow,
    stoppedPolicy: stoppedPolicyApplies(form) ? form.stoppedPolicy : ContainerScriptStoppedPolicy.Wait,
    timeoutSeconds: numbers.timeoutSeconds.value ?? CONTAINER_SCRIPT_DEFAULT_TIMEOUT_SECONDS,
    maxAttempts: numbers.maxAttempts.value ?? CONTAINER_SCRIPT_DEFAULT_MAX_ATTEMPTS,
    maxParallel: numbers.maxParallel.value,
    maxParallelPerServer: numbers.maxParallelPerServer.value,
    canaryCount: numbers.canaryCount.value,
    pauseAfterFailures: numbers.pauseAfterFailures.value,
    note: form.note.trim(),
  };
}

function noErrors(errors: ScriptFormErrors): boolean {
  return Object.keys(errors.fields).length === 0 && Object.keys(errors.files).length === 0;
}

function emptyErrors(): ScriptFormErrors {
  return { fields: {}, files: {} };
}

export type FormResult<T> = { body: T; errors: null } | { body: null; errors: ScriptFormErrors };

/** The create body (checked against the common schema), or what stops it. */
export function createRequestFromForm(form: ScriptForm): FormResult<CreateContainerScriptRequest> {
  const errors = emptyErrors();
  const name = form.name.trim();
  if (!name) errors.fields.name = '请填写名称';
  else if (name.length > 128) errors.fields.name = '名称最多 128 个字符';
  if (form.description.trim().length > 1_024) errors.fields.description = '说明最多 1024 个字符';
  const priority = parseIntField(form.priority, {
    min: CONTAINER_SCRIPT_PRIORITY_MIN, max: CONTAINER_SCRIPT_PRIORITY_MAX, blank: 'null',
  });
  if (priority.error) errors.fields.priority = priority.error;
  const fields = versionFields(form, errors, true);
  if (!noErrors(errors)) return { body: null, errors };
  const parsed = zCreateContainerScriptRequest.safeParse({
    name,
    description: form.description.trim(),
    ...(priority.value === null ? {} : { priority: priority.value }),
    everyBoot: form.everyBoot,
    ...fields,
  });
  if (!parsed.success) {
    return { body: null, errors: { fields: { form: parsed.error.issues[0]?.message ?? '请检查脚本参数' }, files: {} } };
  }
  return { body: parsed.data, errors: null };
}

/** The publish body for a new version of a script at `expectedRevision`, or what stops it. */
export function publishRequestFromForm(
  form: ScriptForm,
  expectedRevision: number,
): FormResult<PublishContainerScriptRequest> {
  const errors = emptyErrors();
  const fields = versionFields(form, errors, false);
  if (!noErrors(errors)) return { body: null, errors };
  const parsed = zPublishContainerScriptRequest.safeParse({ expectedRevision, ...fields });
  if (!parsed.success) {
    return { body: null, errors: { fields: { form: parsed.error.issues[0]?.message ?? '请检查脚本参数' }, files: {} } };
  }
  return { body: parsed.data, errors: null };
}

/** What 立即 means for this kind of script, under its checkbox. */
export function applyNowHint(everyBoot: boolean): string {
  return everyBoot
    ? '勾上：运行中的容器立即执行此版本；不勾：下次开机生效'
    : '勾上：范围内现有容器都按此版本执行（已成功过旧版本的也重新执行）；不勾：只有新容器和还没成功过的容器使用此版本';
}

/** 编辑: what PATCH may change (the rest is fixed per version). */
export interface ScriptEditForm {
  name: string;
  description: string;
  priority: string;
}

export function scriptEditForm(script: Pick<ContainerScriptDto, 'name' | 'description' | 'priority'>): ScriptEditForm {
  return { name: script.name, description: script.description, priority: String(script.priority) };
}

export type ScriptEditResult =
  | { body: PatchContainerScriptRequest; errors: null }
  /** Nothing changed: no request. */
  | { body: null; errors: null }
  | { body: null; errors: Partial<Record<keyof ScriptEditForm, string>> };

/** Only the fields that differ from `script`, with its revision; null body when nothing changed. */
export function scriptPatchFromEdit(
  script: Pick<ContainerScriptDto, 'name' | 'description' | 'priority' | 'revision'>,
  edit: ScriptEditForm,
): ScriptEditResult {
  const errors: Partial<Record<keyof ScriptEditForm, string>> = {};
  const name = edit.name.trim();
  if (!name) errors.name = '请填写名称';
  else if (name.length > 128) errors.name = '名称最多 128 个字符';
  const description = edit.description.trim();
  if (description.length > 1_024) errors.description = '说明最多 1024 个字符';
  const priority = parseIntField(edit.priority, {
    min: CONTAINER_SCRIPT_PRIORITY_MIN, max: CONTAINER_SCRIPT_PRIORITY_MAX, blank: 'required',
  });
  if (priority.error) errors.priority = priority.error;
  if (Object.keys(errors).length > 0) return { body: null, errors };
  const patch: PatchContainerScriptRequest = { expectedRevision: script.revision };
  if (name !== script.name) patch.name = name;
  if (description !== script.description) patch.description = description;
  if (priority.value !== null && priority.value !== script.priority) patch.priority = priority.value;
  if (Object.keys(patch).length === 1) return { body: null, errors: null };
  const parsed = zPatchContainerScriptRequest.safeParse(patch);
  if (!parsed.success) return { body: null, errors: { name: parsed.error.issues[0]?.message ?? '请检查输入' } };
  return { body: parsed.data, errors: null };
}

/** What the send will do, in words, with the scope's current size. */
export function confirmLines(
  form: Pick<ScriptForm, 'everyBoot' | 'applyNow' | 'onNewContainers' | 'stoppedPolicy' | 'canaryCount'>,
  preview: Pick<ContainerScriptPreviewDto, 'total' | 'running'>,
): string[] {
  const stopped = preview.total - preview.running;
  const lines: string[] = [];
  if (form.everyBoot) {
    lines.push(form.applyNow
      ? `运行中的 ${preview.running} 个容器立即执行此版本；其余 ${stopped} 个下次开机时执行`
      : `现有容器下次开机时执行此版本（不立即执行）`);
    lines.push('之后范围内的容器每次开机都会执行');
  } else {
    if (form.applyNow) {
      const stoppedText = form.stoppedPolicy === ContainerScriptStoppedPolicy.Skip ? '跳过' : '开机后执行';
      lines.push(`范围内现有的 ${preview.total} 个容器都执行此版本：运行中的 ${preview.running} 个立即执行，停机的 ${stopped} 个${stoppedText}`);
    } else {
      lines.push('现有容器不因本次发布重新执行；还没成功执行过的容器改用此版本');
    }
    if (form.onNewContainers) lines.push('之后进入范围的新容器创建后执行一次');
  }
  const canary = form.canaryCount.trim();
  if (canary) lines.push(`灰度：${canary} 个容器执行后自动暂停，确认结果后再恢复`);
  return lines;
}
