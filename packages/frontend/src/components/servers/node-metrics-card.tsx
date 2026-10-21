import { useEffect, useState } from 'react';
import { Activity, Pencil } from 'lucide-react';
import { NodeMetricsStatus, type ServerDto, zNodeMetricsPatchConfig } from '@nyabase/common';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { Field, FormField } from '../layout/form-field.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { nodeMetricsStatusZh } from '../../lib/display-labels.js';
import { relativeTime } from '../../lib/utils.js';
import { useUpdateServer } from '../../lib/server-queries.js';
import { toast } from '../../hooks/use-toast.js';
import { TechnicalId } from '../refs/technical-id.js';

export function NodeMetricsCard({ server }: { server: ServerDto }) {
  const [open, setOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [certFingerprint, setCertFingerprint] = useState('');
  const [token, setToken] = useState('');
  const update = useUpdateServer(server.id, () => setClearOpen(false));

  // The fields follow the server record (and reset the token) whenever it changes.
  useEffect(() => {
    setEndpoint(server.nodeMetrics.endpoint ?? '');
    setCertFingerprint(server.nodeMetrics.serverCertFingerprint ?? '');
    setToken('');
  }, [server.id, server.revision]);

  const fail = (title: string, description: string) => toast({ title, description, variant: 'destructive' });
  const save = () => {
    const trimmedToken = token.trim();
    if (!endpoint.trim() || !certFingerprint.trim()) {
      return fail('node-exporter 配置不完整', 'endpoint 和证书 pin 都是必填项。');
    }
    if (!server.nodeMetrics.tokenFingerprint && trimmedToken.length === 0) {
      return fail('需要首次配置 token', '首次配置必须输入 token；已配置时留空可保持原 token。');
    }
    const parsed = zNodeMetricsPatchConfig.safeParse({
      endpoint: endpoint.trim(),
      serverCertFingerprint: certFingerprint.trim(),
      ...(trimmedToken.length > 0 ? { token: trimmedToken } : {}),
    });
    if (!parsed.success) {
      return fail('node-exporter 配置无效', parsed.error.issues[0]?.message ?? '请检查 endpoint、证书 pin 和 token。');
    }
    update.mutate({ expectedRevision: server.revision, nodeMetrics: parsed.data });
  };
  const updatePending = update.isPending;
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
          <Field
            label="指标 endpoint"
            value={server.nodeMetrics.endpoint
              ? <TechnicalId label="指标 endpoint" value={server.nodeMetrics.endpoint} kind="text" />
              : '未配置'}
          />
          <Field
            label="证书 pin"
            value={server.nodeMetrics.serverCertFingerprint
              ? <TechnicalId label="证书 pin" value={server.nodeMetrics.serverCertFingerprint} kind="fingerprint" />
              : '未配置'}
          />
          <Field
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
          onClick={() => setClearOpen(true)}
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
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </FormField>
            <FormField id="node-metrics-cert-fingerprint" label="证书 pin（SHA-256）">
              <Input
                id="node-metrics-cert-fingerprint"
                value={certFingerprint}
                placeholder="64 位十六进制指纹"
                className="font-mono"
                onChange={(event) => setCertFingerprint(event.target.value)}
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
                onChange={(event) => setToken(event.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                onClick={() => {
                  save();
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
        onOpenChange={setClearOpen}
        title="清除指标配置？"
        description="将移除该服务器的 node-exporter 指标采集配置（endpoint、证书 pin 与 token）。确认后需重新填写才能恢复监控。"
        confirmLabel="确认清除"
        pendingLabel="确认清除"
        pending={updatePending}
        onConfirm={() => update.mutate({ expectedRevision: server.revision, nodeMetrics: null })}
      />
    </Card>
  );
}

function NodeMetricsHealthView({ health }: { health: ServerDto['nodeMetrics']['health'] }) {
  const statusLabel = nodeMetricsStatusZh(health.status);
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
