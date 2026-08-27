import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ShieldOff } from 'lucide-react';
import { Capability } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import { capabilityLabel } from '../lib/display-labels.js';
import { Button } from './ui/button.js';

export function AccessDenied({ requiredLabels }: { requiredLabels?: string[] }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 p-6 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ShieldOff className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">无权访问</h1>
        <p className="text-sm text-muted-foreground">
          当前账号没有访问该页面的权限
          {requiredLabels && requiredLabels.length > 0
            ? `（需要：${requiredLabels.join(' 或 ')}）`
            : ''}
          。如需开通，请联系管理员。
        </p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={() => window.history.back()}>返回上一页</Button>
          <Button asChild><Link to="/">返回首页</Link></Button>
        </div>
      </div>
    </div>
  );
}

export function RequireCapability({
  capability,
  children,
}: {
  capability: Capability;
  children: ReactNode;
}) {
  const user = useAuthStore((state) => state.user);
  const canAccess = user?.capabilities.includes(capability) ?? false;

  if (!canAccess) return <AccessDenied requiredLabels={[capabilityLabel(capability)]} />;
  return <>{children}</>;
}

export function RequireAnyCapability({
  capabilities,
  children,
}: {
  capabilities: readonly Capability[];
  children: ReactNode;
}) {
  const user = useAuthStore((state) => state.user);
  const canAccess = capabilities.some((capability) => user?.capabilities.includes(capability));

  if (!canAccess) {
    return <AccessDenied requiredLabels={capabilities.map((capability) => capabilityLabel(capability))} />;
  }
  return <>{children}</>;
}
