import { Activity } from 'lucide-react';
import { NodeMetricsStatus, type ServerDto } from '@nyabase/common';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { nodeMetricsStatusZh } from '../../lib/display-labels.js';
import { relativeTime } from '../../lib/utils.js';

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
  return (
    <Card data-testid="server-node-metrics">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />node-exporter 指标</CardTitle>
            <CardDescription>使用固定 HTTPS /metrics endpoint、证书 pin 和 bearer token；token 只写入服务端，永不回显。</CardDescription>
          </div>
          <NodeMetricsHealthView health={server.nodeMetrics.health} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="node-metrics-endpoint">指标 endpoint</Label>
            <Input
              id="node-metrics-endpoint"
              value={endpoint}
              placeholder="https://node.example:9100/metrics"
              className="font-mono"
              onChange={(event) => onEndpointChange(event.target.value)}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="node-metrics-cert-fingerprint">证书 pin（SHA-256）</Label>
            <Input
              id="node-metrics-cert-fingerprint"
              value={certFingerprint}
              placeholder="64 位十六进制指纹"
              className="font-mono"
              onChange={(event) => onCertFingerprintChange(event.target.value)}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="node-metrics-token">Bearer token</Label>
            <Input
              id="node-metrics-token"
              type="password"
              autoComplete="new-password"
              value={token}
              placeholder={server.nodeMetrics.tokenFingerprint ? '已配置；留空保持原 token' : '首次配置请输入 token'}
              onChange={(event) => onTokenChange(event.target.value)}
            />
            {server.nodeMetrics.tokenFingerprint && (
              <p className="break-all font-mono text-xs text-muted-foreground">
                token fingerprint：{server.nodeMetrics.tokenFingerprint}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onSave} disabled={updatePending}>
            {updatePending ? '保存中...' : '保存指标配置'}
          </Button>
          <Button
            variant="outline"
            disabled={updatePending || server.nodeMetrics.health.status === NodeMetricsStatus.Unconfigured}
            onClick={() => onClearOpenChange(true)}
          >
            清除指标配置
          </Button>
        </div>
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
      </CardContent>
    </Card>
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
