import type {
  GrantBundleDto,
  GrantBundleField,
  GrantBundleQuotas,
  PreviewGrantBundleRequest,
  ServerGrantOverrides,
} from '@nyabase/common';
import { cpuCoresLabel } from './cpu-set.js';
import { formatGpuCount, formatGrantBytes } from './grant-quota.js';
import { GIB, formatGibInput } from './utils.js';

/** The four server quotas a bundle defines and a user's grant may override, in display order. */
export const GRANT_BUNDLE_FIELDS: readonly GrantBundleField[] = ['cpuCores', 'memBytes', 'rootDiskBytes', 'gpuCount'];

export const GRANT_FIELD_LABELS: Record<GrantBundleField, string> = {
  cpuCores: 'CPU',
  memBytes: '内存',
  rootDiskBytes: '系统盘',
  gpuCount: 'GPU',
};

/** Input labels: the unit and what an empty input means. */
export const GRANT_FIELD_INPUT_LABELS: Record<GrantBundleField, string> = {
  cpuCores: 'CPU（整核，留空为不限）',
  memBytes: '内存（GiB，留空为不限）',
  rootDiskBytes: '系统盘（GiB，留空为不限，不含数据盘）',
  gpuCount: 'GPU（张，留空为全部，0 为无）',
};

const FIELD_ERRORS: Record<GrantBundleField, string> = {
  cpuCores: '请输入不小于 1 的整数',
  memBytes: '请输入大于 0 的数值',
  rootDiskBytes: '请输入大于 0 的数值',
  gpuCount: '请输入不小于 0 的整数',
};

export type QuotaTexts = Record<GrantBundleField, string>;

function isByteField(field: GrantBundleField): boolean {
  return field === 'memBytes' || field === 'rootDiskBytes';
}

/** A quota as the text of its input: whole cores / GiB / cards; '' = 不限 (全部 for GPUs). */
export function quotaToText(field: GrantBundleField, value: number | null): string {
  if (value === null) return '';
  return isByteField(field) ? formatGibInput(value) : String(value);
}

/**
 * The text of a quota input: '' → null (不限); a valid amount → the value
 * (bytes for memory and system disk); anything else → undefined (invalid).
 */
export function parseQuotaText(field: GrantBundleField, text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  if (isByteField(field)) {
    const bytes = Math.round(value * GIB);
    return bytes > 0 ? bytes : undefined;
  }
  const minimum = field === 'gpuCount' ? 0 : 1;
  return Number.isInteger(value) && value >= minimum ? value : undefined;
}

/**
 * Like `parseQuotaText`, but a text that still reads as one of `known` (the
 * stored value it was filled from) keeps that exact value: GiB inputs show at
 * most 3 decimals, so re-parsing would turn an untouched field into a change.
 */
export function parseQuotaTextKeeping(
  field: GrantBundleField,
  text: string,
  ...known: Array<number | null | undefined>
): number | null | undefined {
  const trimmed = text.trim();
  for (const value of known) {
    if (value !== undefined && trimmed === quotaToText(field, value)) return value;
  }
  return parseQuotaText(field, text);
}

/** Why a quota text is invalid, or null when it parses. */
export function quotaTextError(field: GrantBundleField, text: string): string | null {
  return parseQuotaText(field, text) === undefined ? FIELD_ERRORS[field] : null;
}

/**
 * A quota for display: 4 核 / 16 GiB / 不限 / 2 张 GPU / 全部 GPU / 无. On a
 * server without GPU passthrough (`gpuEnabled: false`) every GPU count is 无.
 */
export function formatQuotaValue(
  field: GrantBundleField,
  value: number | null,
  server: { gpuEnabled?: boolean } = {},
): string {
  if (field === 'cpuCores') return cpuCoresLabel(value);
  if (field === 'gpuCount') return server.gpuEnabled === false ? '无' : formatGpuCount(value);
  return formatGrantBytes(value);
}

export function quotasToTexts(quotas: GrantBundleQuotas): QuotaTexts {
  return {
    cpuCores: quotaToText('cpuCores', quotas.cpuCores),
    memBytes: quotaToText('memBytes', quotas.memBytes),
    rootDiskBytes: quotaToText('rootDiskBytes', quotas.rootDiskBytes),
    gpuCount: quotaToText('gpuCount', quotas.gpuCount),
  };
}

export const EMPTY_QUOTA_TEXTS: QuotaTexts = { cpuCores: '', memBytes: '', rootDiskBytes: '', gpuCount: '' };

/** A new bundle starts unlimited except GPUs: none until the administrator asks for some. */
export const NEW_BUNDLE_QUOTA_TEXTS: QuotaTexts = { ...EMPTY_QUOTA_TEXTS, gpuCount: '0' };

/** All four quotas, or undefined while any input is invalid; untouched texts keep `base`'s exact value. */
export function parseQuotaTexts(texts: QuotaTexts, base?: GrantBundleQuotas): GrantBundleQuotas | undefined {
  const quotas: Partial<Record<GrantBundleField, number | null>> = {};
  for (const field of GRANT_BUNDLE_FIELDS) {
    const value = parseQuotaTextKeeping(field, texts[field], base?.[field]);
    if (value === undefined) return undefined;
    quotas[field] = value;
  }
  return quotas as GrantBundleQuotas;
}

/**
 * The bundle fields that differ between the stored bundle and the edited
 * draft (what PATCH / preview send), or undefined while an input is invalid.
 */
export function bundleChanges(
  base: Pick<GrantBundleDto, 'name' | GrantBundleField>,
  name: string,
  texts: QuotaTexts,
): PreviewGrantBundleRequest | undefined {
  const quotas = parseQuotaTexts(texts, base);
  if (!quotas) return undefined;
  const changes: PreviewGrantBundleRequest = {};
  const trimmed = name.trim();
  if (trimmed !== base.name) changes.name = trimmed;
  for (const field of GRANT_BUNDLE_FIELDS) {
    if (quotas[field] !== base[field]) changes[field] = quotas[field];
  }
  return changes;
}

/**
 * Move an edit onto a newer revision of the bundle (after a revision
 * conflict): what the administrator had not touched takes the new value,
 * what they had changed keeps their edit.
 */
export function rebaseBundleDraft(
  oldBase: Pick<GrantBundleDto, 'name' | GrantBundleField>,
  newBase: Pick<GrantBundleDto, 'name' | GrantBundleField>,
  name: string,
  texts: QuotaTexts,
): { name: string; texts: QuotaTexts } {
  const rebased = { ...texts };
  for (const field of GRANT_BUNDLE_FIELDS) {
    if (texts[field].trim() === quotaToText(field, oldBase[field])) rebased[field] = quotaToText(field, newBase[field]);
  }
  return { name: name.trim() === oldBase.name ? newBase.name : name, texts: rebased };
}

/** Bundle values as far as they are known; undefined = not known (yet). */
export type KnownQuotas = { [K in GrantBundleField]?: number | null };

/** A user's grant form: which fields override the bundle and the text of each. */
export interface OverrideDraft {
  overridden: Record<GrantBundleField, boolean>;
  texts: QuotaTexts;
}

/** Fields the grant overrides; an absent key follows the bundle. */
export function overriddenFields(overrides: ServerGrantOverrides): GrantBundleField[] {
  return GRANT_BUNDLE_FIELDS.filter((field) => Object.hasOwn(overrides, field));
}

/** Start a grant form from its current overrides (none for a new grant). */
export function overrideDraftFrom(overrides: ServerGrantOverrides = {}): OverrideDraft {
  const overridden = { cpuCores: false, memBytes: false, rootDiskBytes: false, gpuCount: false };
  const texts = { ...EMPTY_QUOTA_TEXTS };
  for (const field of overriddenFields(overrides)) {
    overridden[field] = true;
    texts[field] = quotaToText(field, overrides[field] ?? null);
  }
  return { overridden, texts };
}

/** Tick or untick 修改 on one field; ticking starts from the bundle's value. */
export function toggleOverride(
  draft: OverrideDraft,
  field: GrantBundleField,
  on: boolean,
  bundle: KnownQuotas,
): OverrideDraft {
  const known = bundle[field];
  const text = on && !draft.overridden[field] && known !== undefined ? quotaToText(field, known) : draft.texts[field];
  return {
    overridden: { ...draft.overridden, [field]: on },
    texts: { ...draft.texts, [field]: text },
  };
}

/**
 * The complete override set of a grant form, or undefined while an overridden
 * input is invalid. A text still reading as the grant's stored override (or
 * the bundle value it was pre-filled from) keeps that exact value.
 */
export function parseOverrideDraft(
  draft: OverrideDraft,
  known: { overrides?: ServerGrantOverrides; bundle?: KnownQuotas } = {},
): ServerGrantOverrides | undefined {
  const overrides: ServerGrantOverrides = {};
  for (const field of GRANT_BUNDLE_FIELDS) {
    if (!draft.overridden[field]) continue;
    const stored = known.overrides && Object.hasOwn(known.overrides, field) ? known.overrides[field] ?? null : undefined;
    const value = parseQuotaTextKeeping(field, draft.texts[field], stored, known.bundle?.[field]);
    if (value === undefined) return undefined;
    overrides[field] = value;
  }
  return overrides;
}

/** "bundle 名 · 服务器名", how a bundle is named wherever it is picked. */
export function bundleOptionLabel(bundle: Pick<GrantBundleDto, 'name'>, serverName: string): string {
  return `${bundle.name} · ${serverName}`;
}

function nullableCount(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

/** Shape check of the `current` bundle a 409 REVISION_CONFLICT carries. */
export function isGrantBundleDto(value: unknown): value is GrantBundleDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string'
    && typeof row.serverId === 'string'
    && typeof row.name === 'string'
    && Number.isSafeInteger(row.revision)
    && Number.isSafeInteger(row.grantCount)
    && GRANT_BUNDLE_FIELDS.every((field) => nullableCount(row[field]));
}

/** The users a 409 GRANT_BUNDLE_IN_USE names (details.users), or [] when absent. */
export function bundleInUseUsers(details: Record<string, unknown> | null): Array<{ userId: string; username: string }> {
  const users = details?.users;
  if (!Array.isArray(users)) return [];
  return users.filter((user): user is { userId: string; username: string } => (
    Boolean(user) && typeof user === 'object'
    && typeof (user as Record<string, unknown>).userId === 'string'
    && typeof (user as Record<string, unknown>).username === 'string'
  ));
}
