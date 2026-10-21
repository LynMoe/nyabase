import type { GpuSupportDto } from './support.js';

export interface GpuDeviceDto {
  index: number | null;
  pciAddress: string;
  model: string;
}

/** Operational GPU health persisted on the server row; empty until first refresh. */
export interface GpuHealthDto {
  runtimeReady?: boolean | null;
  nvidiaCardCount?: number;
  exporterGpuSamples?: boolean;
}

/** Per-container GPU state stored on `control.containers.gpu_state`. */
export interface GpuContainerState {
  nvidiaRuntime: boolean;
  pciAddresses: string[];
}

/** The GPUs a server grant allows; an empty list means no GPU access. */
export interface GpuGrant {
  pciAddresses: string[];
}

/** `GET/PATCH /admin/servers/:serverId/gpu`. */
export interface ServerGpuDto {
  enabled: boolean;
  health: GpuHealthDto;
  occupiedDeviceCount: number;
  support: GpuSupportDto;
}

/** `GET /servers/:serverId/gpus` and `GET /admin/servers/:serverId/gpus`. */
export interface GpuDevicesResponseDto {
  items: GpuDeviceDto[];
  enabled: boolean;
}
