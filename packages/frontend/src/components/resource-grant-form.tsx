import { GpuGrantMode } from '@nyabase/common';
import type { GpuGrantMode as GpuGrantModeT } from '@nyabase/common';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';

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

export function formToGrantPayload(v: ResourceFormValue) {
  return {
    cpuMillis: v.cpuCores ? Math.round(parseFloat(v.cpuCores) * 1000) : null,
    memBytes: v.memGb ? Math.round(parseFloat(v.memGb) * 1024 ** 3) : null,
    diskBytes: v.diskGb ? Math.round(parseFloat(v.diskGb) * 1024 ** 3) : null,
    gpuMode: v.gpuMode || null,
    gpuIndices: v.gpuIndices ? v.gpuIndices.split(',').map(Number) : null,
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
      <p className="text-xs text-muted-foreground/70">CPU / 内存 / 磁盘填空或 0 表示不限制；GPU 留空表示全部 GPU</p>
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
    </div>
  );
}
