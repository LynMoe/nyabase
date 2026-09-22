import {
  NVIDIA_GPU_CONFIG_PREFIXES,
  NVIDIA_GPU_DEVICE_PREFIXES,
  NVIDIA_GPU_DISPLAY_NAME,
  NVIDIA_GPU_EXTENSION_ID,
} from '../id.js';
import { nvidiaGpuFormatError, PackageHttpError } from '../errors.js';
import {
  NVIDIA_GPU_LABEL_VALIDATORS,
  NVIDIA_GPU_METRIC_DEFINITIONS,
} from '../metrics.js';
import { type NvidiaGpuGrant } from '../schema.js';
import type { ServerCardExtension } from '../types.js';
import {
  admitNvidiaGpuCreate,
  mutateNvidiaGpuContainer,
  parseNvidiaGpuGrant,
} from './admit.js';
import { contributeNvidiaGpuInstanceSpec, nvidiaGpuRequiresStop } from './instance-spec.js';
import { filterGpuInventoryByGrant, listNvidiaGpuDevices } from './inventory.js';
import { contributeNvidiaGpuPreflight, refreshNvidiaGpuHealth } from './preflight.js';
import { probeNvidiaGpuSupport } from './support.js';

export function createNvidiaGpuExtension(): ServerCardExtension {
  return {
    id: NVIDIA_GPU_EXTENSION_ID,
    displayName: NVIDIA_GPU_DISPLAY_NAME,
    ownedIncusConfigKeyPrefixes: NVIDIA_GPU_CONFIG_PREFIXES,
    ownedIncusDeviceNamePrefixes: NVIDIA_GPU_DEVICE_PREFIXES,
    errorFormatter: nvidiaGpuFormatError,
    metricCatalog: {
      definitions: NVIDIA_GPU_METRIC_DEFINITIONS,
      validators: NVIDIA_GPU_LABEL_VALIDATORS,
    },

    admitCreate: admitNvidiaGpuCreate,
    mutateContainer: mutateNvidiaGpuContainer,
    requiresStop: nvidiaGpuRequiresStop,
    contributeInstanceSpec: (input) => contributeNvidiaGpuInstanceSpec(input.state),

    contributePreflight: async (input) => contributeNvidiaGpuPreflight(input),
    probeSupport: async (input) => probeNvidiaGpuSupport(input),
    refreshHealth: refreshNvidiaGpuHealth,

    parseGrantPayload: parseNvidiaGpuGrant,
    effectiveGrantDevices: (grantPayload, inventory) => {
      const grant = parseNvidiaGpuGrant(grantPayload);
      const items = inventory.filter((item): item is { pciAddress: string; index: number | null; model: string } => (
        typeof item === 'object'
        && item !== null
        && 'pciAddress' in item
        && typeof (item as { pciAddress: unknown }).pciAddress === 'string'
      ));
      return filterGpuInventoryByGrant(items, grant);
    },

    listDevices: async (input) => {
      let grant: NvidiaGpuGrant | null = null;
      if (input.grantPayload != null) {
        grant = parseNvidiaGpuGrant(input.grantPayload);
      } else if (!input.admin) {
        grant = { pciAddresses: [] };
      }
      return {
        items: listNvidiaGpuDevices({
          resources: input.resources,
          metricSamples: input.metricSamples,
          grant,
          admin: input.admin,
        }),
      };
    },

    assertCanDisable: async (ctx) => {
      if (await ctx.claims.count() > 0) {
        throw new PackageHttpError(
          409,
          'EXTENSION_OCCUPIED',
          'The nvidia-gpu extension still has device claims',
        );
      }
    },

    purgeServer: async (ctx) => {
      await ctx.claims.replace([]);
    },
  };
}

export { grantFromView } from './admit.js';
