import { GpuGrantMode, MAX_RESOURCE_BYTES, MAX_RESOURCE_CPU_MILLIS } from '@nyabase/common';
import type { GpuGrantMode as GpuGrantModeT } from '@nyabase/common';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';

const CPU_MILLIS_PER_CORE = 1_000;
const BYTES_PER_GIB = 1024 ** 3;
export const MAX_CPU_MILLIS = MAX_RESOURCE_CPU_MILLIS;
export const MAX_GRANT_BYTES = MAX_RESOURCE_BYTES;

export interface ResourceFormValue {
  cpuCores: string;
  memGb: string;
  diskGb: string;
  gpuMode: GpuGrantModeT | '';
  gpuIndices: string;
  /** Local datetime string for `<input type="datetime-local">`; empty = never expires. */
  expiresAtLocal: string;
}

export const EMPTY_RESOURCE_FORM: ResourceFormValue = {
  cpuCores: '',
  memGb: '',
  diskGb: '',
  gpuMode: '',
  gpuIndices: '',
  expiresAtLocal: '',
};

/** Convert an ISO timestamp to a value accepted by datetime-local inputs (with seconds). */
export function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Convert a datetime-local value to an ISO string, or null when empty. */
export function datetimeLocalToIso(local: string): string | null {
  const trimmed = local.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error('到期时间无效');
  return date.toISOString();
}

export function grantToForm(g: {
  cpuMillis?: number | null;
  memBytes?: number | null;
  diskBytes?: number | null;
  gpuMode?: GpuGrantModeT | null;
  gpuIndices?: number[] | null;
  expiresAt?: string | null;
}): ResourceFormValue {
  return {
    // These divisions are exact for the stored integer units. Avoid display
    // rounding here: opening and saving an otherwise unchanged grant must not
    // silently rewrite small or non-round resource limits.
    cpuCores: g.cpuMillis != null ? String(g.cpuMillis / CPU_MILLIS_PER_CORE) : '',
    memGb: g.memBytes != null ? String(g.memBytes / BYTES_PER_GIB) : '',
    diskGb: g.diskBytes != null ? String(g.diskBytes / BYTES_PER_GIB) : '',
    gpuMode: g.gpuMode ?? '',
    gpuIndices: g.gpuIndices ? g.gpuIndices.join(',') : '',
    expiresAtLocal: isoToDatetimeLocal(g.expiresAt),
  };
}

export interface ResourceGrantPayloadOptions {
  /** When provided, indices are checked against the current server inventory. */
  availableGpuIndices?: readonly number[];
}

function parseScaledLimit(value: string, multiplier: number, maximum: number, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}必须是有限的非负数`);
  const scaled = Math.round(parsed * multiplier);
  if (!Number.isSafeInteger(scaled) || scaled > maximum) throw new Error(`${label}超出安全范围`);
  if (parsed > 0 && scaled === 0) throw new Error(`${label}过小，换算后不能为 0`);
  return scaled;
}

function parseGpuIndices(value: string, availableGpuIndices?: readonly number[]): number[] {
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => !/^\d+$/.test(token))) {
    throw new Error('GPU 指定索引必须是非空的逗号分隔整数列表');
  }
  const indices = tokens.map(Number);
  if (indices.some((index) => !Number.isSafeInteger(index) || index < 0)) {
    throw new Error('GPU 索引必须是非负安全整数');
  }
  if (new Set(indices).size !== indices.length) throw new Error('GPU 索引不能重复');
  if (availableGpuIndices) {
    const available = new Set(availableGpuIndices);
    const unknown = indices.find((index) => !available.has(index));
    if (unknown !== undefined) throw new Error(`GPU 索引 ${unknown} 不在当前服务器清单中`);
  }
  return [...indices].sort((left, right) => left - right);
}

export function formToGrantPayload(v: ResourceFormValue, options: ResourceGrantPayloadOptions = {}) {
  const availableGpuIndices = options.availableGpuIndices;
  const serverHasNoGpu = availableGpuIndices?.length === 0;
  const gpuMode = serverHasNoGpu ? GpuGrantMode.None : (v.gpuMode || GpuGrantMode.All);
  const gpuIndices = gpuMode === GpuGrantMode.Indices
    ? parseGpuIndices(v.gpuIndices, availableGpuIndices)
    : [];
  return {
    cpuMillis: parseScaledLimit(v.cpuCores, CPU_MILLIS_PER_CORE, MAX_CPU_MILLIS, 'CPU'),
    memBytes: parseScaledLimit(v.memGb, BYTES_PER_GIB, MAX_GRANT_BYTES, '内存'),
    diskBytes: parseScaledLimit(v.diskGb, BYTES_PER_GIB, MAX_GRANT_BYTES, '磁盘'),
    gpuMode,
    gpuIndices,
    expiresAt: datetimeLocalToIso(v.expiresAtLocal),
  };
}

interface Props {
  value: ResourceFormValue;
  onChange: (v: ResourceFormValue) => void;
  emptyHint?: string;
  showDisk?: boolean;
  showGpu?: boolean;
}

export function ResourceGrantForm({ value, onChange, emptyHint, showDisk = true, showGpu = true }: Props) {
  const set = (k: keyof ResourceFormValue, v: string) => onChange({ ...value, [k]: v });

  const fields = [
    { key: 'cpuCores' as const, label: 'CPU (核)' },
    { key: 'memGb' as const, label: '内存 (G)' },
    ...(showDisk ? [{ key: 'diskGb' as const, label: '磁盘 (G)' }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${showDisk ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {fields.map(({ key, label }) => (
          <div key={key}>
            <Label className="text-xs text-muted-foreground">
              {label}
              {emptyHint && <span className="text-muted-foreground/70 ml-1">{emptyHint}</span>}
            </Label>
            <Input
              size={1} type="number" min="0" step="any"
              className="h-8 text-xs mt-1"
              value={value[key]}
              onChange={(e) => set(key, e.target.value)}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground/70">CPU / 内存 / 磁盘填空或 0 表示不限制；GPU 留空表示全部 GPU；无 GPU 的服务器会明确保存为“无”</p>
      {showGpu && (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">GPU 模式</Label>
            <select
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs mt-1"
              value={value.gpuMode}
              onChange={(e) => set('gpuMode', e.target.value)}
            >
              <option value="">全部</option>
              <option value={GpuGrantMode.None}>无</option>
              <option value={GpuGrantMode.Indices}>指定索引</option>
              <option value={GpuGrantMode.All}>全部</option>
            </select>
          </div>
          {value.gpuMode === GpuGrantMode.Indices && (
            <div className="col-span-2">
              <Label className="text-xs text-muted-foreground">GPU 索引（逗号分隔）</Label>
              <Input
                size={1} placeholder="0,1,2" className="h-8 text-xs mt-1"
                value={value.gpuIndices}
                onChange={(e) => set('gpuIndices', e.target.value)}
              />
            </div>
          )}
        </div>
      )}
      <div>
        <Label className="text-xs text-muted-foreground">到期时间（清空表示永不过期）</Label>
        <Input
          size={1}
          type="datetime-local"
          step={1}
          className="h-8 text-xs mt-1"
          value={value.expiresAtLocal}
          onChange={(e) => set('expiresAtLocal', e.target.value)}
        />
      </div>
    </div>
  );
}
