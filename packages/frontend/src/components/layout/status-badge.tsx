import { Loader2 } from 'lucide-react';
import { Badge } from '../ui/badge.js';

export function StatusBadge({
  label,
  raw,
  pending,
  variant,
}: {
  label: string;
  raw?: string;
  pending: boolean;
  variant: 'success' | 'secondary' | 'destructive' | 'warning';
}) {
  return (
    <Badge variant={variant} title={raw} aria-busy={pending}>
      {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
      <span>{label}</span>
    </Badge>
  );
}
