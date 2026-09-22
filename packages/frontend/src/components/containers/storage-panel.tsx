import { useState } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import type {
  AttachVolumeRequest,
  ContainerDto,
  SharedVolumeDto,
  StoragePoolCapabilityDto,
  VolumeAttachmentDto,
  VolumeDto,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Input } from '../ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';
import { FormField } from '../layout/form-field.js';
import { SectionCard } from '../layout/section-card.js';
import { Progress } from '../ui/progress.js';
import { bindInProgress } from '../../lib/in-progress.js';
import { approxGibHint } from '../../lib/utils.js';
import { observedRootUsedBytes } from '../../lib/storage-shrink.js';
import { TechnicalId } from '../refs/technical-id.js';
import { RootSizeDialog } from './spec-panel.js';

const BIND_STATE_LABEL = {
  attaching: '挂载中',
  attached: '已挂载',
  detaching: '卸载中',
} as const;

type AttachableVolume = Pick<VolumeDto, 'id' | 'name' | 'sizeBytes'>
  | Pick<SharedVolumeDto, 'id' | 'name' | 'sizeBytes'>;

type MountDisk = {
  id: string;
  name: string;
  kind: 'local' | 'shared';
  sizeBytes: number;
};

type VolumeUsage = {
  id: string;
  sizeBytes: number;
  usedBytes: number | null;
};

export function StoragePanel({
  container,
  rootCapability,
  attachments,
  localVolumes,
  sharedVolumes,
  onAttachLocal,
  onAttachShared,
  onDetachRequest,
  usages = [],
  onRootApply,
  onRootRequiresStop,
  pending,
  rootPending,
  canMutateLocal,
  canMutateShared,
  localAttachBlockedReason,
  sharedAttachBlockedReason,
  running,
}: {
  container: ContainerDto;
  rootCapability: StoragePoolCapabilityDto;
  attachments: VolumeAttachmentDto[];
  localVolumes: AttachableVolume[];
  sharedVolumes: AttachableVolume[];
  onAttachLocal: (body: AttachVolumeRequest) => Promise<unknown>;
  onAttachShared: (body: AttachVolumeRequest) => Promise<unknown>;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
  usages?: readonly VolumeUsage[];
  onRootApply: (sizeBytes: number) => Promise<unknown>;
  onRootRequiresStop: (sizeBytes: number) => void;
  pending: boolean;
  rootPending: boolean;
  canMutateLocal: boolean;
  canMutateShared: boolean;
  localAttachBlockedReason: string | null;
  sharedAttachBlockedReason: string | null;
  running: boolean;
}) {
  const [rootOpen, setRootOpen] = useState(false);
  const [mountOpen, setMountOpen] = useState(false);
  const disks: MountDisk[] = [
    ...(canMutateLocal ? localVolumes.map((volume) => ({ ...volume, kind: 'local' as const })) : []),
    ...(canMutateShared ? sharedVolumes.map((volume) => ({ ...volume, kind: 'shared' as const })) : []),
  ];
  const canMount = canMutateLocal || canMutateShared;
  const usageById = new Map(usages.map((usage) => [usage.id, usage]));
  const rows = [
    ...attachments.filter((attachment) => attachment.kind === 'local'),
    ...attachments.filter((attachment) => attachment.kind === 'shared'),
  ];

  return (
    <div data-testid="container-storage">
      <SectionCard
        title="存储"
        flush
        actions={canMount ? (
          <Button size="sm" onClick={() => setMountOpen(true)} data-testid="attach-volume-open">
            <Plus className="h-4 w-4" />挂载
          </Button>
        ) : undefined}
      >
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>挂载点</TableHead>
              <TableHead>容量</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>系统盘</TableCell>
              <TableCell>系统盘</TableCell>
              <TableCell>/</TableCell>
              <TableCell>
                <UsageMeter used={observedRootUsedBytes(container)} total={container.rootSizeBytes} />
              </TableCell>
              <TableCell>已挂载</TableCell>
              <TableCell className="text-right">
                <Button size="sm" variant="outline" onClick={() => setRootOpen(true)} data-testid="edit-root-size">
                  <Pencil className="h-3.5 w-3.5" />调整容量
                </Button>
              </TableCell>
            </TableRow>
            {rows.map((attachment) => (
              <AttachmentRow
                key={attachment.id}
                attachment={attachment}
                running={running}
                pending={pending}
                canMutate={attachment.kind === 'shared' ? canMutateShared : canMutateLocal}
                usage={usageById.get(attachment.volumeId)}
                onDetachRequest={onDetachRequest}
              />
            ))}
          </TableBody>
        </Table>
        {(localAttachBlockedReason || sharedAttachBlockedReason) && (
          <div className="space-y-1 border-t px-6 py-3 text-sm text-muted-foreground">
            {localAttachBlockedReason ? <p data-testid="attach-capability-hint">{localAttachBlockedReason}</p> : null}
            {sharedAttachBlockedReason ? <p>{sharedAttachBlockedReason}</p> : null}
          </div>
        )}
      </SectionCard>
      {rootOpen ? (
        <RootSizeDialog
          container={container}
          rootCapability={rootCapability}
          pending={rootPending}
          onApply={onRootApply}
          onRequiresStop={onRootRequiresStop}
          onOpenChange={(open) => { if (!open) setRootOpen(false); }}
        />
      ) : null}
      {mountOpen ? (
        <MountDialog
          disks={disks}
          pending={pending}
          onAttachLocal={onAttachLocal}
          onAttachShared={onAttachShared}
          onOpenChange={(open) => { if (!open) setMountOpen(false); }}
        />
      ) : null}
    </div>
  );
}

function MountDialog({
  disks,
  pending,
  onAttachLocal,
  onAttachShared,
  onOpenChange,
}: {
  disks: MountDisk[];
  pending: boolean;
  onAttachLocal: (body: AttachVolumeRequest) => Promise<unknown>;
  onAttachShared: (body: AttachVolumeRequest) => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
}) {
  const [selectedKey, setSelectedKey] = useState('');
  const [containerPath, setContainerPath] = useState('/data');
  const [readOnly, setReadOnly] = useState(false);
  const selected = disks.find((disk) => diskKey(disk) === selectedKey);
  const canSubmit = Boolean(selected) && containerPath.startsWith('/') && containerPath.length > 1;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>挂载</DialogTitle>
        </DialogHeader>
        {disks.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无可挂载的盘。</p>
        ) : (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">磁盘</legend>
              <div className="max-h-64 space-y-1 overflow-y-auto" role="radiogroup" aria-label="可挂载的盘">
                {disks.map((disk) => {
                  const key = diskKey(disk);
                  return (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm ${selectedKey === key ? 'border-primary bg-accent' : ''}`}
                    >
                      <input
                        type="radio"
                        name="mount-disk"
                        className="h-4 w-4"
                        checked={selectedKey === key}
                        disabled={pending}
                        onChange={() => setSelectedKey(key)}
                      />
                      <span className="min-w-0 flex-1 truncate">{disk.name}</span>
                      <span className="text-muted-foreground">{disk.kind === 'shared' ? '共享卷' : '数据卷'}</span>
                      <span className="text-muted-foreground">{gibLabel(disk.sizeBytes)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <FormField id="attach-volume-path" label="挂载点">
              <Input
                id="attach-volume-path"
                value={containerPath}
                onChange={(event) => setContainerPath(event.target.value)}
                disabled={pending}
              />
            </FormField>
            <FormField id="attach-volume-readonly" label="只读" orientation="inline">
              <Checkbox
                id="attach-volume-readonly"
                checked={readOnly}
                onCheckedChange={(checked) => setReadOnly(checked === true)}
                disabled={pending}
              />
            </FormField>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{disks.length > 0 ? '取消' : '关闭'}</Button>
          {disks.length > 0 ? (
            <Button
              disabled={pending || !canSubmit}
              onClick={() => {
                if (!selected) return;
                const body = { volumeId: selected.id, containerPath, readOnly };
                const submit = selected.kind === 'shared' ? onAttachShared(body) : onAttachLocal(body);
                void submit.then(() => onOpenChange(false), () => undefined);
              }}
            >
              {pending ? '提交中...' : '挂载'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AttachmentRow({
  attachment,
  running,
  pending,
  canMutate,
  usage,
  onDetachRequest,
}: {
  attachment: VolumeAttachmentDto;
  running: boolean;
  pending: boolean;
  canMutate: boolean;
  usage?: VolumeUsage;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
}) {
  const cancel = attachment.onlineCancelAllowed;
  const stopRequired = running && !cancel;
  const label = cancel ? '取消挂载' : '卸载';
  return (
    <TableRow>
      <TableCell>{attachment.volumeName}</TableCell>
      <TableCell>{attachment.kind === 'shared' ? '共享卷' : '数据卷'}</TableCell>
      <TableCell>{mountIdentifier('挂载点', attachment.containerPath)}</TableCell>
      <TableCell>
        {usage ? <UsageMeter used={usage.usedBytes} total={usage.sizeBytes} /> : '—'}
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1">
          {bindInProgress(attachment.bindState) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {BIND_STATE_LABEL[attachment.bindState]}
          {attachment.readOnly ? ' · 只读' : ''}
        </span>
      </TableCell>
      <TableCell className="text-right">
        {canMutate ? (
          stopRequired ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      size="sm"
                      variant="outline"
                      className="pointer-events-none"
                      disabled
                      tabIndex={-1}
                    >
                      {label}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>先停止容器</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDetachRequest(attachment)}
              disabled={pending}
            >
              {label}
            </Button>
          )
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function diskKey(disk: MountDisk): string {
  return `${disk.kind}:${disk.id}`;
}

function mountIdentifier(label: string, value: string) {
  if (value.length <= 32) {
    return <span className="font-mono text-xs">{value}</span>;
  }
  return <TechnicalId label={label} value={value} kind="opaque" />;
}

function gibLabel(bytes: number): string {
  return approxGibHint(bytes).replace(/^约 /, '');
}

function UsageMeter({ used, total }: { used: number | null; total: number }) {
  if (!Number.isFinite(total) || total <= 0) return <span>—</span>;
  if (used === null || !Number.isFinite(used)) return <span>{gibLabel(total)}</span>;
  const pct = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return (
    <div className="w-44 space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span>{gibLabel(used)} / {gibLabel(total)}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <Progress value={pct} className="h-1.5" aria-label={`已用 ${gibLabel(used)}，共 ${gibLabel(total)}，${pct}%`} />
    </div>
  );
}
