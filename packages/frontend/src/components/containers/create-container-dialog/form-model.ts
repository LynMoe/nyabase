import { formatConsumedQuotaParts } from '../../../lib/grant-quota.js';

export type FormState = {
  serverId: string;
  imageId: string;
  name: string;
  rootSizeGib: string;
  cpuVcpus: string;
  memGib: string;
  startAfterCreate: boolean;
};

export type FieldErrors = Partial<Record<'name' | 'serverId' | 'imageId' | 'rootSizeGib' | 'cpuVcpus' | 'memGib', string>>;

export const emptyForm: FormState = {
  serverId: '',
  imageId: '',
  name: '',
  rootSizeGib: '20',
  cpuVcpus: '1',
  memGib: '2',
  startAfterCreate: true,
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Remaining room under a grant; null when the grant does not limit it. */
export function remaining(limit: number | null, used: number): number | null {
  if (limit === null || limit === 0) return null;
  return Math.max(0, limit - used);
}

export function cpuText(millis: number): string {
  return formatConsumedQuotaParts({ cpuMillis: millis, memBytes: null, diskBytes: null })[0] ?? '';
}

export function bytesText(bytes: number): string {
  return formatConsumedQuotaParts({ cpuMillis: null, memBytes: bytes, diskBytes: null })[0] ?? '';
}

export function positiveNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Field-level problems of the form; empty when it can be submitted. */
export function validateForm(form: FormState): FieldErrors {
  const next: FieldErrors = {};
  const name = form.name.trim();
  if (!name) next.name = '请输入容器名称';
  else if (name.length > 63) next.name = '名称最长 63 个字符';
  else if (!NAME_RE.test(name)) next.name = '只能使用字母、数字和连字符，且不能以连字符开头';
  if (!form.serverId) next.serverId = '请选择服务器';
  if (!form.imageId) next.imageId = '请选择镜像';
  if (positiveNumber(form.rootSizeGib) === null) next.rootSizeGib = '请输入大于 0 的容量';
  if (positiveNumber(form.cpuVcpus) === null) next.cpuVcpus = '请输入大于 0 的核数';
  if (positiveNumber(form.memGib) === null) next.memGib = '请输入大于 0 的内存';
  return next;
}
