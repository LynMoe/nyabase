import { FailureCode } from '@nyabase/common';
import { gpuConflict } from './gpu-errors.js';
import type { GpuClaimsPort } from './types.js';

export function gpuOccupiedError() {
  return gpuConflict(FailureCode.GpuOccupied, 'The server still has GPU claims');
}

/** GPU cannot be switched off while any container holds a card. */
export async function assertGpuCanDisable(claims: Pick<GpuClaimsPort, 'count'>): Promise<void> {
  if (await claims.count() > 0) throw gpuOccupiedError();
}

/** Postgres raises P0001 with this HINT when the disable trigger fires. */
export function isGpuOccupiedSqlError(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; hint?: unknown; cause?: unknown };
    if (record.code === 'P0001' && String(record.hint ?? '') === FailureCode.GpuOccupied) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
