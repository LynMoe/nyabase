import {
  NVIDIA_GPU_WILDCARD_FORBIDDEN,
  PackageHttpError,
} from '../errors.js';
import { canonicalPciAddress, isWildcardPciAddress, toIncusPciAddress } from '../pci.js';
import { parseContainerState } from '../schema.js';
import type { InstanceSpecContribution } from '../types.js';

const EMPTY_CONTRIBUTION: InstanceSpecContribution = { config: {}, devices: {} };

export function contributeNvidiaGpuInstanceSpec(state: unknown): InstanceSpecContribution {
  const parsed = parseContainerState(state);
  if (!parsed) return EMPTY_CONTRIBUTION;

  const config: Record<string, string> = {
    'nvidia.runtime': String(parsed.nvidiaRuntime),
  };
  const devices: Record<string, Record<string, string>> = {};
  const seen = new Set<string>();
  parsed.pciAddresses.forEach((address, index) => {
    if (isWildcardPciAddress(address)) {
      throw new PackageHttpError(
        400,
        NVIDIA_GPU_WILDCARD_FORBIDDEN,
        'Wildcard PCI selectors are forbidden',
        { pciAddress: address },
      );
    }
    const normalized = canonicalPciAddress(address);
    if (!normalized) {
      throw new PackageHttpError(
        400,
        NVIDIA_GPU_WILDCARD_FORBIDDEN,
        'Wildcard PCI selectors are forbidden',
        { pciAddress: address },
      );
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    devices[`gpu${index}`] = {
      type: 'gpu',
      gputype: 'physical',
      pci: toIncusPciAddress(normalized),
    };
  });
  return { config, devices };
}

export function nvidiaGpuRequiresStop(diff: {
  readonly config: Readonly<Record<string, unknown>>;
  readonly devices: Readonly<Record<string, unknown>>;
}): boolean {
  if (Object.keys(diff.config).some((key) => key.startsWith('nvidia.'))) return true;
  return Object.keys(diff.devices).some((name) => name.startsWith('gpu'));
}
