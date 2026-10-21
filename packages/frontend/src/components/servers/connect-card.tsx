import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import {
  Capability,
  type ConnectServerRequest,
  type IncusClientIdentityDto,
  type IntentAcceptedDto,
  type ServerDto,
} from '@nyabase/common';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { TechnicalId } from '../refs/technical-id.js';
import { Field } from '../layout/form-field.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { useInvalidateServer } from '../../lib/server-queries.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useAuthStore } from '../../store/auth.js';
import { QueryView } from '../layout/query-view.js';

export function ConnectCard({ server }: { server: ServerDto }) {
  const [trustToken, setTrustToken] = useState('');
  const [expectedFingerprint, setExpectedFingerprint] = useState('');
  const invalidate = useInvalidateServer(server.id);
  const connect = useMutation({
    mutationFn: () => {
      const body: ConnectServerRequest = {
        trustToken: trustToken.trim(),
        expectedServerCertFingerprint: (expectedFingerprint || server.serverCertFingerprint || '').trim(),
      };
      return api.post<IntentAcceptedDto>(`/servers/${server.id}/connect`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '已开始连接服务器', description: `操作 ${intent.intentId.slice(0, 8)} 正在执行。` });
      setTrustToken('');
      invalidate();
    },
    onError: (error) => toast({ title: '连接失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />连接与互信</CardTitle>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="server-connect-open">
          连接服务器
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field
          label="已观测指纹"
          value={server.serverCertFingerprint
            ? <TechnicalId label="已观测指纹" value={server.serverCertFingerprint} kind="fingerprint" />
            : '尚未观测'}
        />
        <Field label="Incus 版本" value={server.incusVersion ?? '尚未连接'} />
        {server.lastError && <p className="break-all text-xs text-destructive">{server.lastError}</p>}
      </CardContent>
      {open ? (
        <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>连接服务器</DialogTitle>
            </DialogHeader>
            <FormField id="server-trust-token" label="Trust token">
              <Input
                id="server-trust-token"
                value={trustToken}
                onChange={(event) => setTrustToken(event.target.value)}
                placeholder="粘贴 Incus trust token"
              />
            </FormField>
            <FormField id="server-cert-fingerprint" label="服务端证书指纹（用于校验）">
              <Input
                id="server-cert-fingerprint"
                className="font-mono"
                value={expectedFingerprint || server.serverCertFingerprint || ''}
                onChange={(event) => setExpectedFingerprint(event.target.value)}
                placeholder="SHA256 fingerprint"
              />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                data-testid="server-connect"
                onClick={() => {
                  connect.mutate();
                  setOpen(false);
                }}
                disabled={connect.isPending || !trustToken.trim() || !(expectedFingerprint || server.serverCertFingerprint)}
              >
                {connect.isPending ? '提交中...' : '连接服务器'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

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
