import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '../ui/card.js';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        {Icon && <Icon className="h-10 w-10 text-muted-foreground/40" />}
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {action}
      </CardContent>
    </Card>
  );
}
