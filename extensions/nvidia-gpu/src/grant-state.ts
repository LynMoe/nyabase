import { GpuGrantMode, type NvidiaGpuGrant } from './schema.js';

export type { NvidiaGpuGrant };

export type GpuPickerMode = 'none' | 'all' | 'specific';

export type NvidiaGpuGrantPickerEvent =
  | { readonly type: 'mode'; readonly mode: GpuPickerMode }
  | { readonly type: 'pci'; readonly pciAddresses: readonly string[] };

export function parseGrant(value: unknown): NvidiaGpuGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const mode = record.mode === 'none'
    ? GpuGrantMode.None
    : record.mode === 'all'
      ? GpuGrantMode.All
      : record.mode === 'pci'
        ? GpuGrantMode.Pci
        : null;
  if (mode === null) return null;
  const pciAddresses = Array.isArray(record.pciAddresses)
    ? record.pciAddresses.filter((item): item is string => typeof item === 'string')
    : [];
  return { mode, pciAddresses };
}

/** GpuPicker fires onModeChange then onChange; PCI writes must not flip mode. */
export function reduceNvidiaGpuGrant(
  current: NvidiaGpuGrant,
  event: NvidiaGpuGrantPickerEvent,
): NvidiaGpuGrant {
  if (event.type === 'mode') {
    if (event.mode === 'none') return { mode: GpuGrantMode.None, pciAddresses: [] };
    if (event.mode === 'all') return { mode: GpuGrantMode.All, pciAddresses: [] };
    return {
      mode: GpuGrantMode.Pci,
      pciAddresses: current.mode === GpuGrantMode.Pci ? current.pciAddresses : [],
    };
  }
  if (current.mode !== GpuGrantMode.Pci) return current;
  return { mode: GpuGrantMode.Pci, pciAddresses: [...event.pciAddresses] };
}
