import { Play, ShieldCheck } from 'lucide-react';
import { PreflightStatus, type PreflightReport, type StoragePoolDto } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { FormField } from '../layout/form-field.js';
import {
  preflightCheckLabel,
  preflightResultLabel,
  preflightStatusLabel,
} from '../../lib/display-labels.js';

export function PreflightCard({
  pools,
  selectedPoolId,
  probeAddress,
  preflightPending,
  status,
  report,
  onSelectedPoolIdChange,
  onProbeAddressChange,
  onRunPreflight,
}: {
  pools: StoragePoolDto[];
  selectedPoolId: string;
  probeAddress: string;
  preflightPending: boolean;
  status: PreflightStatus;
  report: PreflightReport | null;
  onSelectedPoolIdChange: (value: string) => void;
  onProbeAddressChange: (value: string) => void;
  onRunPreflight: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />前置检查</CardTitle>
        <CardDescription>检查 LAN 网桥、nftables 防伪、探针实例与容器→宿主连通。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="preflight-pool" label="探针存储池">
            <Select
              value={selectedPoolId || undefined}
              onValueChange={onSelectedPoolIdChange}
            >
              <SelectTrigger id="preflight-pool">
                <SelectValue placeholder="选择存储池" />
              </SelectTrigger>
              <SelectContent>
                {pools.filter((pool) => pool.registered).map((pool) => (
                  <SelectItem key={pool.id} value={pool.id}>{pool.displayName ?? pool.incusName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="space-y-1.5">
            <Label htmlFor="preflight-address">探针地址</Label>
            <Input id="preflight-address" value={probeAddress} onChange={(event) => onProbeAddressChange(event.target.value)} placeholder="10.20.0.10" />
          </div>
        </div>
        <Button data-testid="server-preflight" onClick={onRunPreflight} disabled={preflightPending || !selectedPoolId || !probeAddress.trim()}>
          <Play className="h-4 w-4" />{preflightPending ? '检查中...' : '运行前置检查'}
        </Button>
        <PreflightReportView status={status} report={report} />
      </CardContent>
    </Card>
  );
}

function PreflightReportView({ status, report }: { status: PreflightStatus; report: PreflightReport | null }) {
  if (!report) {
    return (
      <p className="text-sm text-muted-foreground">
        尚未运行前置检查（当前状态：{preflightStatusLabel(status)}）。
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">检查状态：{preflightStatusLabel(status)}</span>
        <Badge variant={report.controlReady ? 'success' : 'destructive'}>
          {report.controlReady ? '控制面就绪' : '未就绪'}
        </Badge>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {Object.entries(report.checks).map(([name, result]) => {
          const value = typeof result === 'string' ? result : 'fail';
          return (
            <div key={name} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{preflightCheckLabel(name)}</span>
              <span className={value === 'pass' ? 'text-green-600' : value === 'warn' ? 'text-amber-600' : 'text-destructive'}>
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

