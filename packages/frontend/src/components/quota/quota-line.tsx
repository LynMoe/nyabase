import type * as React from 'react';
import { GIB, cn } from '../../lib/utils.js';
import { formatCompactBytes } from '../../lib/grant-quota.js';
import { type SizeScale, type SizeScaleKind, sizeScale } from '../../lib/size-ladder.js';

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

/**
 * Slider range for a byte quota: a limited quota runs to its limit and stops at
 * what is left (`over` when the selection exceeds it); otherwise the range is
 * `unlimitedMaxBytes` (e.g. the pool's free space) or the kind's default ladder.
 */
export function quotaSliderLimits(
  kind: SizeScaleKind,
  quota: QuotaLineQuota,
  unlimitedMaxBytes: number | null,
  selectedBytes: number | null,
): { scale: SizeScale; availableGib: number | null; over: boolean } {
  if (quota.kind === 'limited') {
    return {
      scale: sizeScale(kind, quota.limitBytes / GIB),
      availableGib: quota.remainingBytes / GIB,
      over: selectedBytes !== null && selectedBytes > quota.remainingBytes,
    };
  }
  return {
    scale: sizeScale(kind, unlimitedMaxBytes === null ? null : unlimitedMaxBytes / GIB),
    availableGib: null,
    over: false,
  };
}

/** Field error for a selection above what is left: "超出剩余额度 12 GiB". */
export function overQuotaMessage(quota: QuotaLineQuota): string {
  return quota.kind === 'limited' ? `超出剩余额度 ${formatCompactBytes(quota.remainingBytes)}` : '超出剩余额度';
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
      return `剩余 ${formatCompactBytes(quota.remainingBytes)} · 额度 ${formatCompactBytes(quota.limitBytes)}`;
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
