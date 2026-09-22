import { useState } from 'react';
import { Play, ShieldCheck } from 'lucide-react';
import { PreflightStatus, type PreflightReport, type StoragePoolDto } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { StatusBadge } from '../layout/status-badge.js';
import { Input } from '../ui/input.js';
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
import { preflightPending as preflightStatusPending } from '../../lib/in-progress.js';

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
            <FormField id="preflight-address" label="探针地址">
              <Input id="preflight-address" value={probeAddress} onChange={(event) => onProbeAddressChange(event.target.value)} placeholder="10.20.0.10" />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                data-testid="server-preflight"
                onClick={() => {
                  onRunPreflight();
                  setOpen(false);
                }}
                disabled={preflightPending || !selectedPoolId || !probeAddress.trim()}
              >
                {preflightPending ? '检查中...' : '运行前置检查'}
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
