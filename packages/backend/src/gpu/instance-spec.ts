import { parseContainerState, toIncusPciAddress } from '@nyabase/common';
import type { InstanceSpecContribution } from '../incus/instance-spec.js';

/** Incus config key prefix and device-name prefix owned by the GPU feature. */
export const GPU_CONFIG_PREFIXES = ['nvidia.'] as const;
export const GPU_DEVICE_PREFIXES = ['gpu'] as const;

const EMPTY_CONTRIBUTION: InstanceSpecContribution = { config: {}, devices: {} };

/**
 * Pure projection of `control.containers.gpu_state`. Missing or empty state
 * yields nothing; create-time defaults are applied at admission, not here.
 */
export function gpuInstanceSpec(state: unknown): InstanceSpecContribution {
  const parsed = parseContainerState(state);
  if (!parsed) return EMPTY_CONTRIBUTION;

  const config: Record<string, string> = {
    'nvidia.runtime': String(parsed.nvidiaRuntime),
  };
  // Stored addresses are canonical, unique and wildcard-free (zod-validated).
  const devices: Record<string, Record<string, string>> = {};
  parsed.pciAddresses.forEach((address, index) => {
    devices[`gpu${index}`] = {
      type: 'gpu',
      gputype: 'physical',
      pci: toIncusPciAddress(address),
    };
  });
  return { config, devices };
}

/** A running instance cannot change its GPU runtime or devices. */
export function gpuRequiresStop(diff: {
  readonly config: Readonly<Record<string, unknown>>;
  readonly devices: Readonly<Record<string, unknown>>;
}): boolean {
  if (Object.keys(diff.config).some((key) => GPU_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix)))) {
    return true;
  }
  return Object.keys(diff.devices).some((name) => GPU_DEVICE_PREFIXES.some((prefix) => name.startsWith(prefix)));
}
