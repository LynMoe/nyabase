export {
  NVIDIA_GPU_DISPLAY_NAME,
  NVIDIA_GPU_EXTENSION_ID,
  NVIDIA_GPU_CONFIG_PREFIXES,
  NVIDIA_GPU_DEVICE_PREFIXES,
} from './id.js';
export {
  MAX_GPU_DEVICES,
  canonicalPciAddress,
  isWildcardPciAddress,
  toIncusPciAddress,
} from './pci.js';
export {
  NVIDIA_GPU_DUPLICATE_PCI,
  NVIDIA_GPU_INVALID_PCI,
  NVIDIA_GPU_RUNTIME_UNAVAILABLE,
  NVIDIA_GPU_WILDCARD_FORBIDDEN,
  nvidiaGpuFormatError,
  PackageHttpError,
} from './errors.js';
export {
  GpuGrantMode,
  parseContainerState,
  parseCreatePciAddresses,
  parseMutatePciAddresses,
  parsePciAddressList,
  zGpuPciAddresses,
  zNvidiaGpuContainerState,
  zNvidiaGpuCreatePayload,
  zNvidiaGpuGrant,
  zNvidiaGpuMutatePayload,
  zPciAddress,
} from './schema.js';
export type {
  NvidiaGpuContainerState,
  NvidiaGpuCreatePayload,
  NvidiaGpuDeviceDto,
  NvidiaGpuGrant,
  NvidiaGpuMutatePayload,
} from './schema.js';
export {
  NVIDIA_GPU_LABEL_VALIDATORS,
  NVIDIA_GPU_METRIC_DEFINITIONS,
  NVIDIA_GPU_SMI_INDEX_METRIC,
  validateNvidiaGpuLabels,
} from './metrics.js';
export { createNvidiaGpuExtension } from './backend/extension.js';
export { contributeNvidiaGpuInstanceSpec, nvidiaGpuRequiresStop } from './backend/instance-spec.js';
export {
  applyNvidiaSmiIndexes,
  filterGpuInventoryByGrant,
  listNvidiaGpuDevices,
  nvidiaGpuInventoryFromResources,
  nvidiaSmiIndexByPciFromSamples,
} from './backend/inventory.js';
export {
  collectNvidiaGpuMetrics,
  joinGpuProcesses,
  parseGpuStats,
} from './agent/collector.js';
export type {
  GpuMetricRecord,
  GpuProcessMetricRecord,
  NvidiaGpuCollectorOptions,
  ReadOnlyCommand,
  ReadOnlyNodeFileSystem,
} from './agent/collector.js';
export type { ServerCardExtension } from './types.js';
