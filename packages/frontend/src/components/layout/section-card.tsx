import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';

export function SectionCard({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
