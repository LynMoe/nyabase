// These values are emitted by Backend-owned reconciliation branches. Agent
// task failures may persist an arbitrary protocol error code in the lifecycle
// row, so syntax/length checks are not a purpose-safe projection boundary: a
// controlled Agent could encode private host data in an otherwise valid code.
const REQUESTER_SAFE_FAILURE_CODES = new Set([
  'runtime_desired_missing',
  'runtime_lifecycle_owner_missing',
  'runtime_missing',
  'runtime_power_recovery_precondition_missing',
  'runtime_power_state_unsupported',
]);

export function requesterSafeContainerFailure(
  failureCode: string | null | undefined,
  failureReason: string | null | undefined,
): { failureCode: string | null; failureReason: string | null } {
  if (!failureCode && !failureReason) return { failureCode: null, failureReason: null };
  return {
    failureCode: failureCode && REQUESTER_SAFE_FAILURE_CODES.has(failureCode)
      ? failureCode
      : 'container_failed',
    failureReason: 'The container operation failed; retry it or contact an administrator',
  };
}

export function requesterSafeSshError(error: string | null | undefined): string | undefined {
  return error ? 'Container SSH synchronization failed' : undefined;
}
