import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../ui/button.js';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb.js';

type Crumb = {
  label: string;
  to?: string;
  params?: Record<string, string>;
};

type BackTo = {
  to: string;
  params?: Record<string, string>;
  label: string;
};

type RouteLinkProps = Pick<React.ComponentProps<typeof Link>, 'to' | 'params'>;

function routeLinkProps(to: string, params?: Record<string, string>): RouteLinkProps {
  return {
    to: to as RouteLinkProps['to'],
    params: params as RouteLinkProps['params'],
  };
}

export function PageHeader({
  title,
  description,
  crumbs,
  actions,
  backTo,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  backTo?: BackTo;
}) {
  if (crumbs && backTo) {
    throw new Error('PageHeader: pass crumbs or backTo, not both');
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-2">
        {crumbs && crumbs.length > 0 && (
          <Breadcrumb>
            <BreadcrumbList>
              {crumbs.map((crumb, index) => {
                const isLast = index === crumbs.length - 1;
                return (
                  <React.Fragment key={`${crumb.label}:${crumb.to ?? index}`}>
                    {index > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem>
                      {isLast || !crumb.to ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link {...routeLinkProps(crumb.to, crumb.params)}>{crumb.label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </React.Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        )}
        <div className="flex items-start gap-3">
          {backTo && (
            <Link {...routeLinkProps(backTo.to, backTo.params)}>
              <Button variant="outline" size="icon" aria-label={backTo.label}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
          )}
          <div className="min-w-0 space-y-1">
            <h1 className="break-words text-2xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="break-keep text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
