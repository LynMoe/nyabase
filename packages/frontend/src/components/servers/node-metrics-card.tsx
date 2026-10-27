import { Activity } from 'lucide-react';
import { NodeMetricsStatus, type NodeMetricsHealthDto, type ServerDto } from '@nyabase/common';
import { Field } from '../layout/form-field.js';
import { Badge } from '../ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { nodeMetricsStatusZh } from '../../lib/display-labels.js';
import { relativeTime } from '../../lib/utils.js';

export function nodeMetricsBadgeVariant(status: NodeMetricsHealthDto['status']) {
  if (status === NodeMetricsStatus.Online) return 'success' as const;
  if (status === NodeMetricsStatus.Unreachable) return 'destructive' as const;
  return 'secondary' as const;
}

/** Read-only health of the node metrics the host agent reports over its control connection. */
export function NodeMetricsCard({ server }: { server: ServerDto }) {
  const health = server.metricsHealth;
  return (
    <Card data-testid="server-node-metrics">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />节点指标</CardTitle>
          <Badge variant={nodeMetricsBadgeVariant(health.status)}>{nodeMetricsStatusZh(health.status)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="最近成功"
            value={health.lastSuccessAt ? relativeTime(health.lastSuccessAt) : '暂无成功样本'}
            title={health.lastSuccessAt ? new Date(health.lastSuccessAt).toLocaleString('zh-CN') : undefined}
          />
          <Field
            label="数据中断自"
            value={health.outageSince ? new Date(health.outageSince).toLocaleString('zh-CN') : '—'}
          />
        </div>
        {health.lastError && <p className="break-all text-xs text-destructive">{health.lastError}</p>}
      </CardContent>
    </Card>
  );
}
