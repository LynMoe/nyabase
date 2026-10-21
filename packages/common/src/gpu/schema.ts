import { z } from 'zod';
import { FailureCode } from '../enums.js';
import {
  MAX_GPU_DEVICES,
  canonicalPciAddress,
  isWildcardPciAddress,
} from './pci.js';
import type { GpuContainerState } from './dto.js';

export const zPciAddress = z.string()
  .superRefine((value, context) => {
    if (isWildcardPciAddress(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: FailureCode.GpuWildcardForbidden,
      });
      return;
    }
    if (canonicalPciAddress(value) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: FailureCode.GpuInvalidPci,
      });
    }
  })
  .transform((value) => canonicalPciAddress(value)!);

export const zGpuPciAddresses = z.array(zPciAddress)
  .max(MAX_GPU_DEVICES)
  .superRefine((addresses, context) => {
    if (new Set(addresses).size !== addresses.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: FailureCode.GpuDuplicatePci,
      });
    }
  });

export const zGpuContainerState = z.object({
  nvidiaRuntime: z.boolean(),
  pciAddresses: zGpuPciAddresses,
}).strict().superRefine((value, context) => {
  if (value.pciAddresses.length > 0 && value.nvidiaRuntime !== true) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nvidiaRuntime'],
      message: 'PCI assignments require nvidiaRuntime',
    });
  }
});

/** Body of `PATCH /containers/:id/gpus`. */
export const zPatchContainerGpusRequest = z.object({
  pciAddresses: zGpuPciAddresses,
}).strict();

/** Body of `PATCH /admin/servers/:serverId/gpu`. */
export const zPatchServerGpuRequest = z.object({
  enabled: z.boolean(),
}).strict();

export function parseContainerState(state: unknown): GpuContainerState | null {
  if (state === undefined || state === null) return null;
  if (typeof state !== 'object' || Array.isArray(state)) return null;
  if (Object.keys(state as object).length === 0) return null;
  const parsed = zGpuContainerState.safeParse(state);
  return parsed.success ? parsed.data : null;
}
