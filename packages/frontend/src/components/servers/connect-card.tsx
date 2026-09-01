import { KeyRound } from 'lucide-react';
import type { ServerDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

export function ConnectCard({
  server,
  trustToken,
  expectedFingerprint,
  connectPending,
  onTrustTokenChange,
  onExpectedFingerprintChange,
  onConnect,
}: {
  server: ServerDto;
  trustToken: string;
  expectedFingerprint: string;
  connectPending: boolean;
  onTrustTokenChange: (value: string) => void;
  onExpectedFingerprintChange: (value: string) => void;
  onConnect: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />连接与互信</CardTitle>
        <CardDescription>trust token 只用于创建连接意图；服务端证书指纹用于身份校验。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="server-trust-token">Trust token</Label>
          <Input id="server-trust-token" value={trustToken} onChange={(event) => onTrustTokenChange(event.target.value)} placeholder="粘贴 Incus trust token" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="server-cert-fingerprint">期望服务端证书指纹</Label>
          <Input id="server-cert-fingerprint" className="font-mono" value={expectedFingerprint || server.serverCertFingerprint || ''} onChange={(event) => onExpectedFingerprintChange(event.target.value)} placeholder="SHA256 fingerprint" />
        </div>
        <Button data-testid="server-connect" onClick={onConnect} disabled={connectPending || !trustToken.trim() || !(expectedFingerprint || server.serverCertFingerprint)}>
          {connectPending ? '提交中...' : '连接服务器'}
        </Button>
        <InfoRow label="已观测指纹" value={server.serverCertFingerprint ?? '尚未观测'} mono />
        <InfoRow label="Incus 版本" value={server.incusVersion ?? '尚未连接'} />
        {server.lastError && <p className="break-all text-xs text-destructive">{server.lastError}</p>}
      </CardContent>
    </Card>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'}>{value}</p></div>;
}
