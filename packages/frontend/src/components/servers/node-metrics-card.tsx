import { useState, type ReactNode } from 'react';
import { Activity, Pencil } from 'lucide-react';
import { NodeMetricsStatus, type ServerDto } from '@nyabase/common';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { FormField } from '../layout/form-field.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { nodeMetricsStatusZh } from '../../lib/display-labels.js';
import { relativeTime } from '../../lib/utils.js';
import { TechnicalId } from '../refs/technical-id.js';

export function NodeMetricsCard({
  server,
  endpoint,
  certFingerprint,
  token,
  updatePending,
  clearOpen,
  onEndpointChange,
  onCertFingerprintChange,
  onTokenChange,
  onSave,
  onClear,
  onClearOpenChange,
}: {
  server: ServerDto;
  endpoint: string;
  certFingerprint: string;
  token: string;
  updatePending: boolean;
  clearOpen: boolean;
  onEndpointChange: (value: string) => void;
  onCertFingerprintChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
  onClearOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card data-testid="server-node-metrics">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />node-exporter 指标</CardTitle>
            <CardDescription>token 只写入服务端，永不回显。</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <NodeMetricsHealthView health={server.nodeMetrics.health} />
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <Pencil className="h-3.5 w-3.5" />编辑
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoRow
            label="指标 endpoint"
            value={server.nodeMetrics.endpoint
              ? <TechnicalId label="指标 endpoint" value={server.nodeMetrics.endpoint} />
              : '未配置'}
          />
          <InfoRow
            label="证书 pin"
            value={server.nodeMetrics.serverCertFingerprint
              ? <TechnicalId label="证书 pin" value={server.nodeMetrics.serverCertFingerprint} />
              : '未配置'}
          />
          <InfoRow
            label="token fingerprint"
            value={server.nodeMetrics.tokenFingerprint
              ? <TechnicalId label="token fingerprint" value={server.nodeMetrics.tokenFingerprint} />
              : '未配置'}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={updatePending || server.nodeMetrics.health.status === NodeMetricsStatus.Unconfigured}
          onClick={() => onClearOpenChange(true)}
        >
          清除指标配置
        </Button>
      </CardContent>
      {open ? (
        <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑指标配置</DialogTitle>
              <DialogDescription>endpoint 与证书 pin 必填。已配置时 token 留空可保持原值。</DialogDescription>
            </DialogHeader>
            <FormField id="node-metrics-endpoint" label="指标 endpoint">
              <Input
                id="node-metrics-endpoint"
                value={endpoint}
                placeholder="https://node.example:9100/metrics"
                className="font-mono"
                onChange={(event) => onEndpointChange(event.target.value)}
              />
            </FormField>
            <FormField id="node-metrics-cert-fingerprint" label="证书 pin（SHA-256）">
              <Input
                id="node-metrics-cert-fingerprint"
                value={certFingerprint}
                placeholder="64 位十六进制指纹"
                className="font-mono"
                onChange={(event) => onCertFingerprintChange(event.target.value)}
              />
            </FormField>
            <FormField
              id="node-metrics-token"
              label="Bearer token"
              hint={server.nodeMetrics.tokenFingerprint
                ? `token fingerprint：${server.nodeMetrics.tokenFingerprint}`
                : undefined}
            >
              <Input
                id="node-metrics-token"
                type="password"
                autoComplete="new-password"
                value={token}
                placeholder={server.nodeMetrics.tokenFingerprint ? '已配置；留空保持原 token' : '首次配置请输入 token'}
                onChange={(event) => onTokenChange(event.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                onClick={() => {
                  onSave();
                  setOpen(false);
                }}
                disabled={updatePending}
              >
                {updatePending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={onClearOpenChange}
        title="清除指标配置？"
        description="将移除该服务器的 node-exporter 指标采集配置（endpoint、证书 pin 与 token）。确认后需重新填写才能恢复监控。"
        confirmLabel="确认清除"
        pendingLabel="确认清除"
        pending={updatePending}
        onConfirm={onClear}
      />
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      {typeof value === 'string' ? <p className="text-sm">{value}</p> : <div className="mt-1">{value}</div>}
    </div>
  );
}

function NodeMetricsHealthView({ health }: { health: ServerDto['nodeMetrics']['health'] }) {
  const statusLabel = nodeMetricsStatusLabel(health.status);
  return (
    <div className="space-y-1 text-right">
      <Badge variant={health.status === NodeMetricsStatus.Online ? 'success' : health.status === NodeMetricsStatus.Unreachable ? 'destructive' : 'secondary'}>
        {statusLabel}
      </Badge>
      {health.outageSince ? (
        <p className="text-xs text-destructive">数据中断自 {new Date(health.outageSince).toLocaleString()}</p>
      ) : health.status === NodeMetricsStatus.Unknown ? (
        <p className="text-xs text-muted-foreground">暂无成功样本</p>
      ) : null}
      {health.lastSuccessAt && (
        <p className="text-xs text-muted-foreground">最近成功 {relativeTime(health.lastSuccessAt)}</p>
      )}
      {health.lastError && <p className="max-w-[24rem] break-all text-xs text-destructive">{health.lastError}</p>}
    </div>
  );
}

function nodeMetricsStatusLabel(status: NodeMetricsStatus): string {
  return nodeMetricsStatusZh(status);
}
