export type GpuSupportCheckStatus = 'pass' | 'fail' | 'unknown';

export interface GpuSupportCheckDto {
  readonly id: string;
  readonly label: string;
  readonly status: GpuSupportCheckStatus;
  readonly detail?: string;
}

/**
 * Host prerequisite probe for GPU passthrough.
 * Independent of admin enablement and of persisted operational health.
 * `supported` is true when every check passed, false when any failed,
 * and null when none failed but at least one check is unknown.
 */
export interface GpuSupportDto {
  readonly supported: boolean | null;
  readonly checks: readonly GpuSupportCheckDto[];
}

export function summarizeGpuSupport(
  checks: readonly GpuSupportCheckDto[],
): GpuSupportDto {
  let sawUnknown = false;
  for (const check of checks) {
    if (check.status === 'fail') return { supported: false, checks };
    if (check.status === 'unknown') sawUnknown = true;
  }
  return { supported: sawUnknown ? null : true, checks };
}
