import type {
  GrantBundleDto,
  GrantBundleField,
  GrantBundleQuotas,
  GrantBundleScalarField,
  GrantDataDisk,
  PreviewGrantBundleRequest,
  ServerGrantOverrides,
} from '@nyabase/common';
import { cpuCoresLabel } from './cpu-set.js';
import {
  type DataDiskDraft,
  dataDiskDraftFrom,
  parseDataDiskDraft,
  sameDataDisks,
} from './grant-data-disks.js';
import { formatGpuCount, formatGrantBytes } from './grant-quota.js';
import { GIB, formatBytes, formatGibInput } from './utils.js';

export { dataDiskSummary } from './grant-data-disks.js';

/**
 * The quotas holding one number that a bundle defines and a user's grant may
 * override, in display order. The data-disk list (`dataDisks`) is the other
 * bundle field: see `DataDiskDraft`.
 */
export const GRANT_BUNDLE_FIELDS: readonly GrantBundleScalarField[] = [
  'cpuCores', 'memBytes', 'diskBytes', 'rootDiskBytes', 'gpuCount',
];

export const GRANT_FIELD_LABELS: Record<GrantBundleField, string> = {
  cpuCores: 'CPU',
  memBytes: '内存',
  diskBytes: '磁盘',
  rootDiskBytes: '系统盘上限',
  gpuCount: 'GPU',
  dataDisks: '数据盘',
};

/** Input labels: the unit and what an empty input means. */
export const GRANT_FIELD_INPUT_LABELS: Record<GrantBundleScalarField, string> = {
  cpuCores: 'CPU（整核，留空为不限）',
  memBytes: '内存（GiB，留空为不限）',
  diskBytes: '磁盘总额（GiB，系统盘与数据盘共用）',
  rootDiskBytes: '系统盘上限（GiB，留空为只受总额限制）',
  gpuCount: 'GPU（张，留空为全部，0 为无）',
};

const FIELD_ERRORS: Record<GrantBundleScalarField, string> = {
  cpuCores: '请输入不小于 1 的整数',
  memBytes: '请输入大于 0 的数值',
  diskBytes: '必填：请输入大于 0 的数值',
  rootDiskBytes: '请输入大于 0 的数值',
  gpuCount: '请输入不小于 0 的整数',
};

export type QuotaTexts = Record<GrantBundleScalarField, string>;

/** A bundle's quotas without the data-disk list. */
export type ScalarQuotas = Pick<GrantBundleQuotas, GrantBundleScalarField>;

export function isByteField(field: GrantBundleScalarField): boolean {
  return field === 'memBytes' || field === 'diskBytes' || field === 'rootDiskBytes';
}

/** What an empty input means for a field; the disk total has no empty value. */
export function emptyQuotaLabel(field: GrantBundleScalarField): string {
  if (field === 'gpuCount') return '全部';
  if (field === 'rootDiskBytes') return '只受总额限制';
  if (field === 'diskBytes') return '必填';
  return '不限';
}

/** A quota as the text of its input: whole cores / GiB / cards; '' = 不限 (全部 for GPUs). */
export function quotaToText(field: GrantBundleScalarField, value: number | null): string {
  if (value === null) return '';
  return isByteField(field) ? formatGibInput(value) : String(value);
}

/**
 * The text of a quota input: '' → null (不限; the disk total has no such
 * value, so it is invalid there); a valid amount → the value (bytes for the
 * byte fields); anything else → undefined (invalid).
 */
export function parseQuotaText(field: GrantBundleScalarField, text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return field === 'diskBytes' ? undefined : null;
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
  field: GrantBundleScalarField,
  text: string,
  ...known: Array<number | null | undefined>
): number | null | undefined {
  const trimmed = text.trim();
  for (const value of known) {
    if (value !== undefined && (value !== null || field !== 'diskBytes') && trimmed === quotaToText(field, value)) {
      return value;
    }
  }
  return parseQuotaText(field, text);
}

/** Why a quota text is invalid, or null when it parses. */
export function quotaTextError(field: GrantBundleScalarField, text: string): string | null {
  return parseQuotaText(field, text) === undefined ? FIELD_ERRORS[field] : null;
}

/**
 * A quota for display: 4 核 / 16 GiB / 不限 / 2 张 GPU / 全部 GPU / 无. On a
 * server without GPU passthrough (`gpuEnabled: false`) every GPU count is 无.
 * A system-disk ceiling of null reads 只受总额限制, not 不限.
 */
export function formatQuotaValue(
  field: GrantBundleScalarField,
  value: number | null,
  server: { gpuEnabled?: boolean } = {},
): string {
  if (field === 'cpuCores') return cpuCoresLabel(value);
  if (field === 'gpuCount') return server.gpuEnabled === false ? '无' : formatGpuCount(value);
  if (field === 'rootDiskBytes' && value === null) return '只受总额限制';
  return formatGrantBytes(value);
}

/** 「2 TiB」, or 「2 TiB（系统盘 ≤ 800 GiB）」 when the system disks have their own ceiling. */
export function formatDiskQuota(quotas: Pick<GrantBundleQuotas, 'diskBytes' | 'rootDiskBytes'>): string {
  const total = formatBytes(quotas.diskBytes);
  return quotas.rootDiskBytes === null ? total : `${total}（系统盘 ≤ ${formatBytes(quotas.rootDiskBytes)}）`;
}

/**
 * The quotas of a grant on one line's worth of parts, each named:
 * CPU 16 核 / 内存 32 GiB / 磁盘 2 TiB（系统盘 ≤ 800 GiB）/ 2 张 GPU.
 */
export function quotaSummaryParts(
  quotas: ScalarQuotas,
  server: { gpuEnabled?: boolean } = {},
): string[] {
  const gpu = formatQuotaValue('gpuCount', quotas.gpuCount, server);
  return [
    `CPU ${formatQuotaValue('cpuCores', quotas.cpuCores)}`,
    `内存 ${formatQuotaValue('memBytes', quotas.memBytes)}`,
    `磁盘 ${formatDiskQuota(quotas)}`,
    gpu === '无' ? '无 GPU' : gpu,
  ];
}

export function quotasToTexts(quotas: ScalarQuotas): QuotaTexts {
  const texts = { ...EMPTY_QUOTA_TEXTS };
  for (const field of GRANT_BUNDLE_FIELDS) texts[field] = quotaToText(field, quotas[field]);
  return texts;
}

export const EMPTY_QUOTA_TEXTS: QuotaTexts = { cpuCores: '', memBytes: '', diskBytes: '', rootDiskBytes: '', gpuCount: '' };

/** A new bundle starts unlimited except GPUs (none until asked for) and the disk total, which must be filled in. */
export const NEW_BUNDLE_QUOTA_TEXTS: QuotaTexts = { ...EMPTY_QUOTA_TEXTS, gpuCount: '0' };

/** All scalar quotas, or undefined while any input is invalid; untouched texts keep `base`'s exact value. */
export function parseQuotaTexts(texts: QuotaTexts, base?: ScalarQuotas): ScalarQuotas | undefined {
  const quotas: Partial<Record<GrantBundleScalarField, number | null>> = {};
  for (const field of GRANT_BUNDLE_FIELDS) {
    const value = parseQuotaTextKeeping(field, texts[field], base?.[field]);
    if (value === undefined) return undefined;
    quotas[field] = value;
  }
  return quotas as ScalarQuotas;
}

type BundleBase = Pick<GrantBundleDto, 'name' | GrantBundleField>;

/**
 * The bundle fields that differ between the stored bundle and the edited
 * draft (what PATCH / preview send), or undefined while an input is invalid.
 * The data-disk list goes only when it really changed (order does not count).
 */
export function bundleChanges(
  base: BundleBase,
  name: string,
  texts: QuotaTexts,
  disks: DataDiskDraft = dataDiskDraftFrom(base.dataDisks),
): PreviewGrantBundleRequest | undefined {
  const quotas = parseQuotaTexts(texts, base);
  const dataDisks = parseDataDiskDraft(disks, base.dataDisks);
  if (!quotas || !dataDisks) return undefined;
  const changes: PreviewGrantBundleRequest = {};
  const trimmed = name.trim();
  if (trimmed !== base.name) changes.name = trimmed;
  for (const field of GRANT_BUNDLE_FIELDS) {
    if (quotas[field] !== base[field]) (changes as Record<string, number | null>)[field] = quotas[field];
  }
  if (!sameDataDisks(dataDisks, base.dataDisks)) changes.dataDisks = dataDisks;
  return changes;
}

/**
 * Move an edit onto a newer revision of the bundle (after a revision
 * conflict): what the administrator had not touched takes the new value,
 * what they had changed keeps their edit.
 */
export function rebaseBundleDraft(
  oldBase: BundleBase,
  newBase: BundleBase,
  name: string,
  texts: QuotaTexts,
  disks: DataDiskDraft = dataDiskDraftFrom(oldBase.dataDisks),
): { name: string; texts: QuotaTexts; disks: DataDiskDraft } {
  const rebased = { ...texts };
  for (const field of GRANT_BUNDLE_FIELDS) {
    if (texts[field].trim() === quotaToText(field, oldBase[field])) rebased[field] = quotaToText(field, newBase[field]);
  }
  const parsed = parseDataDiskDraft(disks, oldBase.dataDisks);
  const untouched = parsed !== undefined && sameDataDisks(parsed, oldBase.dataDisks);
  return {
    name: name.trim() === oldBase.name ? newBase.name : name,
    texts: rebased,
    disks: untouched ? dataDiskDraftFrom(newBase.dataDisks) : disks,
  };
}

/** Bundle values as far as they are known; undefined = not known (yet). */
export type KnownQuotas = { [K in GrantBundleScalarField]?: number | null } & { dataDisks?: GrantDataDisk[] };

/** A user's grant form: which fields override the bundle, the text of each, and its own data-disk list. */
export interface OverrideDraft {
  overridden: Record<GrantBundleField, boolean>;
  texts: QuotaTexts;
  disks: DataDiskDraft;
}

/** Fields the grant overrides (`dataDisks` included); an absent key follows the bundle. */
export function overriddenFields(overrides: ServerGrantOverrides): GrantBundleField[] {
  const fields: GrantBundleField[] = GRANT_BUNDLE_FIELDS.filter((field) => Object.hasOwn(overrides, field));
  if (Object.hasOwn(overrides, 'dataDisks')) fields.push('dataDisks');
  return fields;
}

/** Start a grant form from its current overrides (none for a new grant). */
export function overrideDraftFrom(overrides: ServerGrantOverrides = {}): OverrideDraft {
  const overridden: Record<GrantBundleField, boolean> = {
    cpuCores: false, memBytes: false, diskBytes: false, rootDiskBytes: false, gpuCount: false, dataDisks: false,
  };
  const texts = { ...EMPTY_QUOTA_TEXTS };
  for (const field of GRANT_BUNDLE_FIELDS) {
    if (!Object.hasOwn(overrides, field)) continue;
    overridden[field] = true;
    texts[field] = quotaToText(field, overrides[field] ?? null);
  }
  overridden.dataDisks = Object.hasOwn(overrides, 'dataDisks');
  return { overridden, texts, disks: dataDiskDraftFrom(overrides.dataDisks ?? []) };
}

/** Tick or untick 修改 on one field; ticking starts from the bundle's value (its list, for data disks). */
export function toggleOverride(
  draft: OverrideDraft,
  field: GrantBundleField,
  on: boolean,
  bundle: KnownQuotas,
): OverrideDraft {
  const starting = on && !draft.overridden[field];
  if (field === 'dataDisks') {
    const disks = starting && bundle.dataDisks !== undefined ? dataDiskDraftFrom(bundle.dataDisks) : draft.disks;
    return { ...draft, overridden: { ...draft.overridden, dataDisks: on }, disks };
  }
  const known = bundle[field];
  const text = starting && known !== undefined ? quotaToText(field, known) : draft.texts[field];
  return {
    ...draft,
    overridden: { ...draft.overridden, [field]: on },
    texts: { ...draft.texts, [field]: text },
  };
}

/**
 * The complete override set of a grant form, or undefined while an overridden
 * input is invalid. A text still reading as the grant's stored override (or
 * the bundle value it was pre-filled from) keeps that exact value. An
 * overridden data-disk list is sent whole, `[]` included.
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
    (overrides as Record<string, number | null>)[field] = value;
  }
  if (draft.overridden.dataDisks) {
    const disks = parseDataDiskDraft(draft.disks, known.overrides?.dataDisks, known.bundle?.dataDisks);
    if (!disks) return undefined;
    overrides.dataDisks = disks;
  }
  return overrides;
}

/** Bundles to pick from, under their server's name; servers and bundles in name order. */
export function bundleOptionGroups(
  bundles: ReadonlyArray<Pick<GrantBundleDto, 'id' | 'name' | 'serverId'>>,
  nameOfServer: (serverId: string) => string,
): Array<{ key: string; label: string; options: Array<[string, string]> }> {
  const groups = new Map<string, { key: string; label: string; options: Array<[string, string]> }>();
  for (const bundle of bundles) {
    const group = groups.get(bundle.serverId)
      ?? { key: bundle.serverId, label: nameOfServer(bundle.serverId), options: [] };
    group.options.push([bundle.id, bundle.name]);
    groups.set(bundle.serverId, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  for (const group of ordered) group.options.sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  return ordered;
}

function nullableCount(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isDataDiskList(value: unknown): value is GrantDataDisk[] {
  return Array.isArray(value) && value.every((disk) => Boolean(disk) && typeof disk === 'object'
    && typeof (disk as Record<string, unknown>).poolId === 'string'
    && nullableCount((disk as Record<string, unknown>).capBytes));
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
    && Number.isSafeInteger(row.diskBytes) && (row.diskBytes as number) > 0
    && GRANT_BUNDLE_FIELDS.every((field) => nullableCount(row[field]))
    && isDataDiskList(row.dataDisks);
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
