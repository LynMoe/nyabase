import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import { nvidiaGpuFormatError } from '../errors.js';
import { createNvidiaGpuWebSlots } from './slots.js';
import type { FrontendExtensionHost, ServerCardWebExtension } from './types.js';

export { nvidiaGpuFormatError } from '../errors.js';
export {
  formatGpuSelectionLabel,
  GpuPicker,
  gpuDisplayLabel,
  gpuModeFromPciList,
  permittedGpus,
  resolveGpuPciAddresses,
} from './gpu-picker.js';
export type { GpuPickerMode } from './gpu-picker.js';
export type { FrontendExtensionHost, ServerCardWebExtension } from './types.js';

export function createNvidiaGpuWebExtension(
  _host: FrontendExtensionHost,
): ServerCardWebExtension {
  return {
    id: NVIDIA_GPU_EXTENSION_ID,
    slots: createNvidiaGpuWebSlots(),
    formatError: nvidiaGpuFormatError,
  };
}
