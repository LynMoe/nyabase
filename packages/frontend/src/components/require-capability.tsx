import type { ReactNode } from 'react';
import { ShieldOff } from 'lucide-react';
import { Capability } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';

export function AccessDenied() {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md p-6 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ShieldOff className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">无权访问</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          当前账号没有访问该页面的权限。
        </p>
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

  if (!canAccess) return <AccessDenied />;
  return <>{children}</>;
}
