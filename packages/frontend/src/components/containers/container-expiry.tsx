import type { ContainerAccessDto } from '@nyabase/common';
import { cn } from '../../lib/utils.js';
import { expiryLabel, remainingLabel } from '../grants/use-grant-panel-data.js';
import { Hint } from '../ui/hint.js';

const DAY_MS = 86_400_000;

/** List cell: the time left, with the absolute time on hover. */
export function ContainerRemaining({ access }: { access: ContainerAccessDto }) {
  if (access.phase === 'none') return <span className="text-muted-foreground">—</span>;
  if (access.phase === 'grace') {
    const remaining = remainingLabel(access.purgeAt);
    return (
      <Hint content={containerExpiryText(access)}>
        <span tabIndex={0} className="whitespace-nowrap tabular-nums text-destructive">
          {remaining ? `${remaining}后清除` : '待清除'}
        </span>
      </Hint>
    );
  }
  if (access.expiresAt === null) return <span className="text-muted-foreground">永久</span>;
  const left = new Date(access.expiresAt).getTime() - Date.now();
  return (
    <Hint content={`${expiryLabel(access.expiresAt)} 到期`}>
      <span
        tabIndex={0}
        className={cn('whitespace-nowrap tabular-nums', left < 7 * DAY_MS && 'text-warning')}
      >
        {remainingLabel(access.expiresAt) ?? '已到期'}
      </span>
    </Hint>
  );
}

/** The same fact spelled out, for the detail page and the grace hover. */
export function containerExpiryText(access: ContainerAccessDto): string {
  if (access.phase === 'none') return '—';
  if (access.phase === 'grace') return `授权已失效，${expiryLabel(access.purgeAt)} 清除`;
  if (access.expiresAt === null) return '永久';
  const remaining = remainingLabel(access.expiresAt);
  return `${expiryLabel(access.expiresAt)}（${remaining ? `剩余 ${remaining}` : '已到期'}）`;
}
