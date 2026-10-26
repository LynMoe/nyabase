import { useState } from 'react';
import { Play, ShieldCheck } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  PreflightStatus,
  type IntentAcceptedDto,
  type PreflightReport,
  type RunPreflightRequest,
  type ServerDto,
  type ServerPreflightDto,
} from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { StatusBadge } from '../layout/status-badge.js';
import { Input } from '../ui/input.js';
import { FormField, SelectField } from '../layout/form-field.js';
import {
  knownPreflightChecks,
  preflightCheckLabel,
  preflightResultLabel,
  preflightStatusLabel,
} from '../../lib/display-labels.js';
import { preflightPending as preflightStatusPending } from '../../lib/in-progress.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import { useInvalidateServer, useServerPools } from '../../lib/server-queries.js';
import { toast } from '../../hooks/use-toast.js';

export function PreflightCard({ server }: { server: ServerDto }) {
  const serverId = server.id;
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const [probeAddress, setProbeAddress] = useState('');
  const poolsQuery = useServerPools(serverId);
  const pools = poolsQuery.data ?? [];
  const invalidate = useInvalidateServer(serverId);
  const preflightQuery = useQuery({
    queryKey: queryKeys.servers.preflight(serverId),
    queryFn: () => api.get<ServerPreflightDto>(`/servers/${serverId}/preflight`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (report) => !preflightStatusPending(report.status),
    }),
  });
  const status = preflightQuery.data?.status ?? server.preflightStatus;
  const report = preflightQuery.data?.report ?? server.preflightReport;
  const runPreflight = useMutation({
    mutationFn: () => {
      const body: RunPreflightRequest = {
        expectedServerRevision: server.revision,
        poolId: selectedPoolId,
        probeAddress: probeAddress.trim(),
      };
      return api.post<IntentAcceptedDto>(`/servers/${serverId}/preflight`, body);
    },
    onSuccess: (intent) => {
      toast({ title: '前置检查已开始', description: `操作 ${intent.intentId.slice(0, 8)} 正在执行。` });
      invalidate();
    },
    onError: (error) => toast({ title: '前置检查失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />前置检查</CardTitle>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="server-preflight-open">
          <Play className="h-4 w-4" />运行前置检查
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <PreflightReportView status={status} report={report} />
      </CardContent>
      {open ? (
        <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>运行前置检查</DialogTitle>
            </DialogHeader>
            <SelectField
              id="preflight-pool"
              label="探针存储池"
              value={selectedPoolId}
              onChange={setSelectedPoolId}
              options={pools.filter((pool) => pool.registered).map((pool): [string, string] => [pool.id, pool.displayName ?? pool.incusName])}
              placeholder="选择存储池"
              loading={poolsQuery.isLoading}
              emptyText="没有已登记的存储池"
              emptyHint="先在「存储」中登记一个存储池，再运行前置检查。"
            />
            <FormField id="preflight-address" label="探针地址">
              <Input id="preflight-address" value={probeAddress} onChange={(event) => setProbeAddress(event.target.value)} placeholder="10.20.0.10" />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                data-testid="server-preflight"
                onClick={() => {
                  runPreflight.mutate();
                  setOpen(false);
                }}
                disabled={runPreflight.isPending || !selectedPoolId || !probeAddress.trim()}
              >
                {runPreflight.isPending ? '检查中...' : '运行前置检查'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

function preflightBadgeVariant(status: string): 'success' | 'secondary' | 'destructive' | 'warning' {
  if (status === PreflightStatus.Passed) return 'success';
  if (status === PreflightStatus.Failed) return 'destructive';
  if (status === PreflightStatus.Running) return 'warning';
  return 'secondary';
}

function PreflightReportView({ status, report }: { status: PreflightStatus; report: PreflightReport | null }) {
  if (!report) {
    return (
      <p className="inline-flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <span>尚未运行前置检查（当前状态：</span>
        <StatusBadge
          label={preflightStatusLabel(status)}
          pending={preflightStatusPending(status)}
          variant={preflightBadgeVariant(status)}
        />
        <span>）。</span>
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          检查状态：
          <StatusBadge
            label={preflightStatusLabel(status)}
            pending={preflightStatusPending(status)}
            variant={preflightBadgeVariant(status)}
          />
        </span>
        <Badge variant={report.controlReady ? 'success' : 'destructive'}>
          {report.controlReady ? '控制面就绪' : '未就绪'}
        </Badge>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {knownPreflightChecks(report.checks).map(([name, result]) => {
          const value = typeof result === 'string' ? result : 'fail';
          return (
            <div key={name} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{preflightCheckLabel(name)}</span>
              <span className={value === 'pass' ? 'text-success' : value === 'warn' ? 'text-warning' : 'text-destructive'}>
                {preflightResultLabel(value)}
              </span>
            </div>
          );
        })}
      </div>
      {report.failureCode && <p className="text-xs text-destructive">{report.failureCode}</p>}
    </div>
  );
}
