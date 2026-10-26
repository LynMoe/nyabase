import type { LucideIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Card, CardContent } from '../ui/card.js';
import { cn } from '../../lib/utils.js';

export function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  to,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  /** Where the number can be acted on; the whole card becomes the link. */
  to?: string;
  tone?: 'default' | 'warning';
}) {
  const body = (
    <Card className={cn('h-full transition-colors', to && 'hover:border-foreground/20 hover:bg-accent/40')}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-sm">{label}</span>
          <Icon className={cn('h-4 w-4', tone === 'warning' && 'text-warning')} />
        </div>
        <p className={cn('mt-2 text-2xl font-semibold tabular-nums', tone === 'warning' && 'text-warning')}>{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
  if (!to) return body;
  return (
    <Link to={to} className="block rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  );
}
