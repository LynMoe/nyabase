import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { Capability, type IncusClientIdentityDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useAuthStore } from '../../store/auth.js';
import { Field } from '../layout/field.js';
import { QueryView } from '../layout/query-view.js';
import { TechnicalId } from '../refs/technical-id.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';

/**
 * Read-only view of the control plane's Incus client certificate. One
 * certificate is generated on first start and shared by every server; its
 * fingerprint is what an operator finds in Incus's trust list.
 */
export function ClientIdentityCard() {
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canView = capabilities.includes(Capability.ManageServers)
    || capabilities.includes(Capability.ManageSystemSettings);
  const identityQuery = useQuery({
    queryKey: queryKeys.clientIdentity,
    queryFn: () => api.get<IncusClientIdentityDto>('/admin/system-settings/incus-client-identity'),
    enabled: canView,
    staleTime: 60_000,
  });
  if (!canView) return null;

  return (
    <Card id="client-identity" className="scroll-mt-6" data-testid="client-identity">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />Incus 客户端证书
        </CardTitle>
        <CardDescription>
          首次启动时自动生成，所有服务器共用；连接服务器时通过一次性信任令牌加入 Incus 信任列表。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryView
          query={identityQuery}
          resourceName="Incus 客户端证书"
          loadingLabel="加载证书..."
          showEmpty={!identityQuery.data}
          empty={<p className="text-sm text-muted-foreground">暂无客户端证书。</p>}
        >
          {(identity) => (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="指纹" value={<TechnicalId label="指纹" value={identity.fingerprint} kind="fingerprint" />} />
              <Field label="生成时间" value={new Date(identity.createdAt).toLocaleString()} />
              <Field label="过期时间" value={new Date(identity.notAfter).toLocaleString()} />
            </div>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}
