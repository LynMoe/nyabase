import { AgentTaskKind, zQuotaEnsureTaskPayload } from '@nyabase/common';
import { normalizeXfsQuotaBytes, type QuotaUsage, type XfsQuotaManager } from '../../quota/xfs-quota.js';
import { IncompleteTaskError, ManagedTaskError, type AgentTaskHandler } from '../task-handler.js';

type QuotaTaskResult = { numericUserId: number; hardLimitBytes: number };

export class QuotaTaskHandler implements AgentTaskHandler<QuotaTaskResult> {
  readonly kinds = [AgentTaskKind.QuotaEnsure] as const;

  constructor(private readonly quota: XfsQuotaManager) {}

  async ensure(_kind: AgentTaskKind, payload: unknown): Promise<QuotaTaskResult> {
    const parsed = zQuotaEnsureTaskPayload.parse(payload);
    const expected = normalizeXfsQuotaBytes(parsed.diskBytes);
    try {
      await this.quota.setLimit(parsed.numericUserId, parsed.diskBytes);
    } catch (error) {
      let usage;
      try {
        usage = await this.quota.getUsageForUser(parsed.numericUserId);
      } catch (observationError) {
        throw new IncompleteTaskError({
          code: 'quota_observation_unavailable',
          message: `Cannot observe XFS quota after applying it for user ${parsed.numericUserId}`,
          details: {
            expectedHardLimitBytes: expected,
            applyError: this.errorMessage(error),
            observationError: this.errorMessage(observationError),
          },
        });
      }
      if (!usage || usage.hardLimitBytes !== expected) {
        throw new ManagedTaskError({
          code: 'quota_apply_failed',
          message: `Failed to apply XFS quota for user ${parsed.numericUserId}`,
          details: {
            expectedHardLimitBytes: expected,
            observed: usage ? { ...usage } : null,
            cause: this.errorMessage(error),
          },
        }, usage
          ? { numericUserId: parsed.numericUserId, hardLimitBytes: usage.hardLimitBytes }
          : { numericUserId: parsed.numericUserId, present: false });
      }
    }
    return {
      numericUserId: parsed.numericUserId,
      hardLimitBytes: expected,
    };
  }

  async verify(_kind: AgentTaskKind, payload: unknown, _result: QuotaTaskResult): Promise<void> {
    const parsed = zQuotaEnsureTaskPayload.parse(payload);
    const expected = normalizeXfsQuotaBytes(parsed.diskBytes);
    const usage = await this.quota.getUsageForUser(parsed.numericUserId);
    if (!usage || usage.hardLimitBytes !== expected) {
      this.notConverged(parsed.numericUserId, expected, usage);
    }
  }

  private notConverged(numericUserId: number, expected: number, usage: QuotaUsage | null): never {
    throw new ManagedTaskError({
      code: 'quota_not_converged',
      message: `XFS quota for user ${numericUserId} did not converge`,
      details: { expectedHardLimitBytes: expected, observed: usage ? { ...usage } : null },
    }, usage
      ? { numericUserId, hardLimitBytes: usage.hardLimitBytes }
      : { numericUserId, present: false });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
