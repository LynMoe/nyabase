import { z } from 'zod';
import {
  NVIDIA_GPU_DUPLICATE_PCI,
  NVIDIA_GPU_INVALID_PCI,
  NVIDIA_GPU_WILDCARD_FORBIDDEN,
  PackageHttpError,
} from './errors.js';
import {
  MAX_GPU_DEVICES,
  canonicalPciAddress,
  isWildcardPciAddress,
} from './pci.js';

export const zPciAddress = z.string()
  .superRefine((value, context) => {
    if (isWildcardPciAddress(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: NVIDIA_GPU_WILDCARD_FORBIDDEN,
      });
      return;
    }
    if (canonicalPciAddress(value) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: NVIDIA_GPU_INVALID_PCI,
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
        message: NVIDIA_GPU_DUPLICATE_PCI,
      });
    }
  });

export const zNvidiaGpuContainerState = z.object({
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

export const zNvidiaGpuCreatePayload = z.object({
  pciAddresses: zGpuPciAddresses.optional(),
}).strict();

export const zNvidiaGpuMutatePayload = z.object({
  pciAddresses: zGpuPciAddresses,
}).strict();

export const zNvidiaGpuGrant = z.object({
  pciAddresses: zGpuPciAddresses,
}).strict();

export type NvidiaGpuContainerState = z.infer<typeof zNvidiaGpuContainerState>;
export type NvidiaGpuCreatePayload = z.infer<typeof zNvidiaGpuCreatePayload>;
export type NvidiaGpuMutatePayload = z.infer<typeof zNvidiaGpuMutatePayload>;
export type NvidiaGpuGrant = z.infer<typeof zNvidiaGpuGrant>;

export interface NvidiaGpuDeviceDto {
  index: number | null;
  pciAddress: string;
  model: string;
}

export function parsePciAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PackageHttpError(400, NVIDIA_GPU_INVALID_PCI, 'GPU PCI addresses are invalid');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new PackageHttpError(400, NVIDIA_GPU_INVALID_PCI, 'GPU PCI address is invalid');
    }
    if (isWildcardPciAddress(item)) {
      throw new PackageHttpError(
        400,
        NVIDIA_GPU_WILDCARD_FORBIDDEN,
        'Wildcard PCI selectors are forbidden',
        { pciAddress: item },
      );
    }
    const canonical = canonicalPciAddress(item);
    if (!canonical) {
      throw new PackageHttpError(
        400,
        NVIDIA_GPU_INVALID_PCI,
        'GPU PCI address is invalid',
        { pciAddress: item },
      );
    }
    if (seen.has(canonical)) {
      throw new PackageHttpError(
        400,
        NVIDIA_GPU_DUPLICATE_PCI,
        'GPU PCI addresses must be unique',
        { pciAddress: canonical },
      );
    }
    seen.add(canonical);
    result.push(canonical);
  }
  if (result.length > MAX_GPU_DEVICES) {
    throw new PackageHttpError(400, NVIDIA_GPU_INVALID_PCI, 'Too many GPU PCI addresses');
  }
  return result;
}

export function parseContainerState(state: unknown): NvidiaGpuContainerState | null {
  if (state === undefined || state === null) return null;
  if (typeof state !== 'object' || Array.isArray(state)) return null;
  if (Object.keys(state as object).length === 0) return null;
  const parsed = zNvidiaGpuContainerState.safeParse(state);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCreatePciAddresses(payload: unknown): string[] {
  if (payload === undefined) return [];
  const parsed = zNvidiaGpuCreatePayload.safeParse(payload);
  if (parsed.success) return parsed.data.pciAddresses ?? [];
  if (isRecord(payload) && 'pciAddresses' in payload) {
    parsePciAddressList(payload.pciAddresses);
  }
  throw new PackageHttpError(400, 'INVALID_INPUT', 'nvidia-gpu payload is invalid');
}

export function parseMutatePciAddresses(payload: unknown): string[] {
  const parsed = zNvidiaGpuMutatePayload.safeParse(payload);
  if (parsed.success) return parsed.data.pciAddresses;
  if (isRecord(payload) && 'pciAddresses' in payload) {
    parsePciAddressList(payload.pciAddresses);
  }
  throw new PackageHttpError(400, 'INVALID_INPUT', 'nvidia-gpu payload is invalid');
}
