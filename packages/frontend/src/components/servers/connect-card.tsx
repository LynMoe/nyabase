import { useState, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import type { ServerDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { TechnicalId } from '../refs/technical-id.js';

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
        <InfoRow
          label="已观测指纹"
          value={server.serverCertFingerprint
            ? <TechnicalId label="已观测指纹" value={server.serverCertFingerprint} />
            : '尚未观测'}
        />
        <InfoRow label="Incus 版本" value={server.incusVersion ?? '尚未连接'} />
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
                onChange={(event) => onTrustTokenChange(event.target.value)}
                placeholder="粘贴 Incus trust token"
              />
            </FormField>
            <FormField id="server-cert-fingerprint" label="期望服务端证书指纹">
              <Input
                id="server-cert-fingerprint"
                className="font-mono"
                value={expectedFingerprint || server.serverCertFingerprint || ''}
                onChange={(event) => onExpectedFingerprintChange(event.target.value)}
                placeholder="SHA256 fingerprint"
              />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                data-testid="server-connect"
                onClick={() => {
                  onConnect();
                  setOpen(false);
                }}
                disabled={connectPending || !trustToken.trim() || !(expectedFingerprint || server.serverCertFingerprint)}
              >
                {connectPending ? '提交中...' : '连接服务器'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      {typeof value === 'string' ? <p className="break-all text-sm">{value}</p> : <div className="mt-1">{value}</div>}
    </div>
  );
}
