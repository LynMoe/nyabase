import { GpuGrantMode } from '@nyabase/common';
import type { GpuGrantMode as GpuGrantModeT } from '@nyabase/common';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { formatBytes, formatCpu } from '../lib/utils.js';

export interface ResourceFormValue {
  cpuCores: string;
  memGb: string;
  diskGb: string;
  gpuMode: GpuGrantModeT | '';
  gpuIndices: string;
}

export const EMPTY_RESOURCE_FORM: ResourceFormValue = {
  cpuCores: '',
  memGb: '',
  diskGb: '',
  gpuMode: '',
  gpuIndices: '',
};

export function grantToForm(g: {
  cpuMillis?: number | null;
  memBytes?: number | null;
  diskBytes?: number | null;
  gpuMode?: GpuGrantModeT | null;
  gpuIndices?: number[] | null;
}): ResourceFormValue {
  return {
    cpuCores: g.cpuMillis != null ? String(+(g.cpuMillis / 1000).toFixed(2)) : '',
    memGb: g.memBytes != null ? String(+(g.memBytes / 1024 ** 3).toFixed(2)) : '',
    diskGb: g.diskBytes != null ? String(+(g.diskBytes / 1024 ** 3).toFixed(2)) : '',
    gpuMode: g.gpuMode ?? '',
    gpuIndices: g.gpuIndices ? g.gpuIndices.join(',') : '',
  };
}

export function serverDefaultsToForm(s: {
  defaultCpuMillis?: number;
  defaultMemBytes?: number;
  defaultDiskBytes?: number;
  defaultGpuMode?: GpuGrantModeT;
  defaultGpuIndices?: number[];
}): ResourceFormValue {
  return {
    cpuCores: s.defaultCpuMillis != null ? String(+(s.defaultCpuMillis / 1000).toFixed(2)) : '',
    memGb: s.defaultMemBytes != null ? String(+(s.defaultMemBytes / 1024 ** 3).toFixed(2)) : '',
    diskGb: s.defaultDiskBytes != null ? String(+(s.defaultDiskBytes / 1024 ** 3).toFixed(2)) : '',
    gpuMode: s.defaultGpuMode ?? GpuGrantMode.None,
    gpuIndices: s.defaultGpuIndices?.join(',') ?? '',
  };
}

export function formToGrantPayload(v: ResourceFormValue) {
  return {
    cpuMillis: v.cpuCores ? Math.round(parseFloat(v.cpuCores) * 1000) : null,
    memBytes: v.memGb ? Math.round(parseFloat(v.memGb) * 1024 ** 3) : null,
    diskBytes: v.diskGb ? Math.round(parseFloat(v.diskGb) * 1024 ** 3) : null,
    gpuMode: v.gpuMode || null,
    gpuIndices: v.gpuIndices ? v.gpuIndices.split(',').map(Number) : null,
  };
}

export function formToServerDefaultsPayload(v: ResourceFormValue) {
  return {
    defaultCpuMillis: v.cpuCores ? Math.round(parseFloat(v.cpuCores) * 1000) : undefined,
    defaultMemBytes: v.memGb ? Math.round(parseFloat(v.memGb) * 1024 ** 3) : undefined,
    defaultDiskBytes: v.diskGb ? Math.round(parseFloat(v.diskGb) * 1024 ** 3) : undefined,
    defaultGpuMode: v.gpuMode || GpuGrantMode.None,
    defaultGpuIndices: v.gpuIndices ? v.gpuIndices.split(',').map(Number) : undefined,
  };
}

interface Props {
  value: ResourceFormValue;
  onChange: (v: ResourceFormValue) => void;
  emptyHint?: string;
  showDisk?: boolean;
  showGpu?: boolean;
  /** When provided, shows server-level defaults as a reference line below the inputs */
  serverDefaults?: { cpuMillis: number; memBytes: number; diskBytes: number };
}

export function ResourceGrantForm({ value, onChange, emptyHint, showDisk = true, showGpu = true, serverDefaults }: Props) {
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
      <p className="text-xs text-muted-foreground/70">填 0 表示不限制</p>
      {serverDefaults && (
        <p className="text-xs text-muted-foreground/70">
          服务器默认：
          {serverDefaults.cpuMillis === 0 ? '不限' : formatCpu(serverDefaults.cpuMillis)} CPU
          {' / '}{serverDefaults.memBytes === 0 ? '不限' : formatBytes(serverDefaults.memBytes)} 内存
          {showDisk && <>{' / '}{serverDefaults.diskBytes === 0 ? '不限' : formatBytes(serverDefaults.diskBytes)} 磁盘</>}
        </p>
      )}
      {showGpu && (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">GPU 模式</Label>
            <select
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs mt-1"
              value={value.gpuMode}
              onChange={(e) => set('gpuMode', e.target.value)}
            >
              <option value="">服务器默认</option>
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
    </div>
  );
}
