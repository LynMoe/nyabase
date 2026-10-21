import {
  FailureCode,
  MAX_GPU_DEVICES,
  canonicalPciAddress,
  isWildcardPciAddress,
  zPatchContainerGpusRequest,
} from '@nyabase/common';
import { gpuBadRequest } from './gpu-errors.js';

/**
 * Validate a client-supplied PCI list and return canonical, unique addresses.
 * Throws 400 with a GPU_* code that tells the caller what was wrong.
 */
export function parsePciAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw gpuBadRequest(FailureCode.GpuInvalidPci, 'GPU PCI addresses are invalid');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw gpuBadRequest(FailureCode.GpuInvalidPci, 'GPU PCI address is invalid');
    }
    if (isWildcardPciAddress(item)) {
      throw gpuBadRequest(
        FailureCode.GpuWildcardForbidden,
        'Wildcard PCI selectors are forbidden',
        { pciAddress: item },
      );
    }
    const canonical = canonicalPciAddress(item);
    if (!canonical) {
      throw gpuBadRequest(FailureCode.GpuInvalidPci, 'GPU PCI address is invalid', { pciAddress: item });
    }
    if (seen.has(canonical)) {
      throw gpuBadRequest(
        FailureCode.GpuDuplicatePci,
        'GPU PCI addresses must be unique',
        { pciAddress: canonical },
      );
    }
    seen.add(canonical);
    result.push(canonical);
  }
  if (result.length > MAX_GPU_DEVICES) {
    throw gpuBadRequest(FailureCode.GpuInvalidPci, 'Too many GPU PCI addresses');
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the body of `PATCH /containers/:id/gpus`. */
export function parseMutatePciAddresses(body: unknown): string[] {
  const parsed = zPatchContainerGpusRequest.safeParse(body);
  if (parsed.success) return parsed.data.pciAddresses;
  if (isRecord(body) && 'pciAddresses' in body) {
    parsePciAddressList(body.pciAddresses);
  }
  throw gpuBadRequest(FailureCode.InvalidInput, 'GPU request body is invalid');
}
