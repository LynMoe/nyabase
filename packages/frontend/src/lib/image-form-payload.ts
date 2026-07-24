import {
  zCreateImageRequest,
  zUpdateImageRequest,
  type CreateImageRequest,
  type ImageRuntimeOverrides,
  type UpdateImageRequest,
} from '@nyabase/common';

export function normalizeImageRuntimeOverridesForUi(value: unknown): ImageRuntimeOverrides {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const args = (candidate: unknown): string[] | null => Array.isArray(candidate)
    && candidate.every((item) => typeof item === 'string')
    ? candidate
    : null;
  return {
    uid: Number.isInteger(record.uid) && (record.uid as number) >= 0
      && (record.uid as number) <= 0xffff_fffe
      ? record.uid as number
      : 0,
    entrypoint: args(record.entrypoint),
    cmd: args(record.cmd),
    init: typeof record.init === 'boolean' ? record.init : false,
  };
}

export interface ImageFormPayloadInput {
  name: string;
  dockerImage: string;
  uid: string;
  entrypoint: string;
  cmd: string;
  init: boolean;
  disableSsh: boolean;
  description: string;
}

function argsFromLines(value: string): string[] | null {
  const args = value.split('\n').map((line) => line.trim()).filter(Boolean);
  return args.length > 0 ? args : null;
}

function decimalUid(value: string): number {
  const trimmed = value.trim();
  return /^(0|[1-9]\d*)$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

export function parseImageFormPayload(
  mode: 'create',
  form: ImageFormPayloadInput,
): ReturnType<typeof zCreateImageRequest.safeParse>;
export function parseImageFormPayload(
  mode: 'edit',
  form: ImageFormPayloadInput,
): ReturnType<typeof zUpdateImageRequest.safeParse>;
export function parseImageFormPayload(
  mode: 'create' | 'edit',
  form: ImageFormPayloadInput,
) {
  const runtimeOverrides = {
    uid: decimalUid(form.uid),
    entrypoint: argsFromLines(form.entrypoint),
    cmd: argsFromLines(form.cmd),
    init: form.init,
  };
  if (mode === 'create') {
    return zCreateImageRequest.safeParse({
      name: form.name,
      dockerImage: form.dockerImage,
      runtimeOverrides,
      description: form.description.trim() || undefined,
      disableSsh: form.disableSsh,
    }) as ReturnType<typeof zCreateImageRequest.safeParse>;
  }
  return zUpdateImageRequest.safeParse({
    name: form.name,
    runtimeOverrides,
    description: form.description.trim() || null,
    disableSsh: form.disableSsh,
  }) as ReturnType<typeof zUpdateImageRequest.safeParse>;
}

export type ParsedCreateImagePayload = CreateImageRequest;
export type ParsedUpdateImagePayload = UpdateImageRequest;

export function minimalImageEditPayload(
  parsed: UpdateImageRequest,
  dirtyFields: ReadonlySet<keyof ImageFormPayloadInput>,
): UpdateImageRequest {
  const payload: UpdateImageRequest = {};
  if (dirtyFields.has('name')) payload.name = parsed.name;
  if (dirtyFields.has('description')) payload.description = parsed.description;
  if (dirtyFields.has('disableSsh')) payload.disableSsh = parsed.disableSsh;
  if (['uid', 'entrypoint', 'cmd', 'init']
    .some((field) => dirtyFields.has(field as keyof ImageFormPayloadInput))) {
    payload.runtimeOverrides = parsed.runtimeOverrides;
  }
  return payload;
}
