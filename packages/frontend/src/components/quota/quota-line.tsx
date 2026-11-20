import type * as React from 'react';
import { cn, formatBytes } from '../../lib/utils.js';

/** What a create form knows about one byte quota on the chosen target. */
export type QuotaLineQuota =
  | { kind: 'loading' }
  /** The capacity lookup failed. */
  | { kind: 'unknown' }
  | { kind: 'unlimited' }
  | { kind: 'limited'; remainingBytes: number; limitBytes: number };

/**
 * Quota from a grant limit and what is left under it: a null (or 0, which a
 * grant never stores) limit is unlimited; a limit without a known remainder is
 * still loading.
 */
export function quotaFrom(limitBytes: number | null | undefined, remainingBytes: number | null | undefined): QuotaLineQuota {
  if (limitBytes === undefined) return { kind: 'loading' };
  if (limitBytes === null || limitBytes === 0) return { kind: 'unlimited' };
  if (remainingBytes === null || remainingBytes === undefined) return { kind: 'loading' };
  return { kind: 'limited', remainingBytes: Math.max(0, remainingBytes), limitBytes };
}

function quotaText(quota: QuotaLineQuota): string {
  switch (quota.kind) {
    case 'loading':
      return '剩余 …';
    case 'unknown':
      return '剩余 暂不可知';
    case 'unlimited':
      return '额度 不限';
    case 'limited':
      return `剩余 ${formatBytes(quota.remainingBytes)} · 额度 ${formatBytes(quota.limitBytes)}`;
  }
}

/**
 * One line under a size slider: "剩余 12 GiB · 额度 16 GiB" / "额度 不限" /
 * "剩余 暂不可知". Destructive when the selection exceeds what is left; greyed
 * with `inactiveHint` when the quota does not apply to this request.
 */
export function QuotaLine({
  quota,
  over = false,
  inactiveHint,
  testId,
}: {
  quota: QuotaLineQuota;
  over?: boolean;
  inactiveHint?: React.ReactNode;
  testId?: string;
}) {
  const inactive = inactiveHint !== undefined && inactiveHint !== null;
  return (
    <p
      className={cn(
        'text-xs tabular-nums',
        inactive ? 'text-muted-foreground/70' : 'text-muted-foreground',
        over && !inactive && 'font-medium text-destructive',
      )}
      data-testid={testId}
      data-over={over && !inactive ? 'true' : undefined}
    >
      {quotaText(quota)}
      {inactive ? <span>（{inactiveHint}）</span> : null}
    </p>
  );
}
