import { Link } from '@tanstack/react-router';
import type {
  ContainerDto,
  SharedVolumeDto,
  StoragePoolCapabilityDto,
  VolumeAttachmentDto,
  VolumeDto,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Checkbox } from '../ui/checkbox.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { approxGibHint, formatBytes } from '../../lib/utils.js';
import { observedRootUsedBytes, shrinkNeverTooltip } from '../../lib/storage-shrink.js';
import { Info } from './overview-panel.js';

const BIND_STATE_LABEL = {
  attaching: '挂载中',
  attached: '已挂载',
  detaching: '卸载中',
} as const;

type AttachableVolume = Pick<VolumeDto, 'id' | 'name' | 'sizeBytes' | 'capability'>
  | Pick<SharedVolumeDto, 'id' | 'name' | 'sizeBytes' | 'capability'>;

export function StoragePanel({
  container,
  rootCapability,
  attachments,
  localVolumes,
  sharedVolumes,
  localVolumeId,
  sharedVolumeId,
  localPath,
  sharedPath,
  localReadOnly,
  sharedReadOnly,
  onLocalVolumeId,
  onSharedVolumeId,
  onLocalPath,
  onSharedPath,
  onLocalReadOnly,
  onSharedReadOnly,
  onAttachLocal,
  onAttachShared,
  onDetachRequest,
  pending,
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
  localVolumeId: string;
  sharedVolumeId: string;
  localPath: string;
  sharedPath: string;
  localReadOnly: boolean;
  sharedReadOnly: boolean;
  onLocalVolumeId: (value: string) => void;
  onSharedVolumeId: (value: string) => void;
  onLocalPath: (value: string) => void;
  onSharedPath: (value: string) => void;
  onLocalReadOnly: (value: boolean) => void;
  onSharedReadOnly: (value: boolean) => void;
  onAttachLocal: () => void;
  onAttachShared: () => void;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
  pending: boolean;
  canMutateLocal: boolean;
  canMutateShared: boolean;
  localAttachBlockedReason: string | null;
  sharedAttachBlockedReason: string | null;
  running: boolean;
}) {
  const shrinkHint = rootCapability.shrinkNever
    ? shrinkNeverTooltip()
    : rootCapability.shrinkRequiresStop
      ? '缩容需先停止容器'
      : rootCapability.shrinkOnline
        ? '可在线缩容'
        : '缩容受用量约束';
  const localAttachments = attachments.filter((attachment) => attachment.kind === 'local');
  const sharedAttachments = attachments.filter((attachment) => attachment.kind === 'shared');
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="container-storage">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">系统盘</CardTitle>
          <CardDescription>系统盘所在池由容器创建时固定；扩缩路径由池能力决定。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info
            label="存储池"
            value={container.rootPoolName}
            mono={container.rootPoolName === container.rootPoolId}
          />
          <Info label="容量" value={gibLabel(container.rootSizeBytes)} />
          <Info label="已用" value={observedRootUsedLabel(container)} />
          <Info
            label="待应用"
            value={container.rootSizePendingBytes === null ? '无' : gibLabel(container.rootSizePendingBytes)}
          />
          <Info label="缩容能力" value={shrinkHint} />
        </CardContent>
      </Card>
      <VolumeSection
        title="本地数据卷"
        description={running ? '运行中可以挂载。卸载需先停止容器。' : '挂载这台服务器上的本地盘。'}
        emptyHint="暂无本地数据卷挂载。"
        volumes={localVolumes}
        volumeId={localVolumeId}
        containerPath={localPath}
        readOnly={localReadOnly}
        onVolumeId={onLocalVolumeId}
        onContainerPath={onLocalPath}
        onReadOnly={onLocalReadOnly}
        onAttach={onAttachLocal}
        selectId="attach-local-volume"
        pathId="attach-local-path"
        createTo="/volumes"
        createLabel="去创建本地数据卷"
        attachments={localAttachments}
        onDetachRequest={onDetachRequest}
        pending={pending}
        canMutate={canMutateLocal}
        attachBlockedReason={localAttachBlockedReason}
        running={running}
      />
      <VolumeSection
        title="共享卷"
        description={running ? '运行中可以挂载。卸载需先停止容器。' : '挂载该容器所在服务器能看见的共享卷。'}
        emptyHint="暂无共享卷挂载。"
        volumes={sharedVolumes}
        volumeId={sharedVolumeId}
        containerPath={sharedPath}
        readOnly={sharedReadOnly}
        onVolumeId={onSharedVolumeId}
        onContainerPath={onSharedPath}
        onReadOnly={onSharedReadOnly}
        onAttach={onAttachShared}
        selectId="attach-shared-volume"
        pathId="attach-shared-path"
        createTo="/shared-volumes"
        createLabel="去创建共享卷"
        attachments={sharedAttachments}
        onDetachRequest={onDetachRequest}
        pending={pending}
        canMutate={canMutateShared}
        attachBlockedReason={sharedAttachBlockedReason}
        running={running}
      />
    </div>
  );
}

function VolumeSection({
  title,
  description,
  emptyHint,
  volumes,
  volumeId,
  containerPath,
  readOnly,
  onVolumeId,
  onContainerPath,
  onReadOnly,
  onAttach,
  selectId,
  pathId,
  createTo,
  createLabel,
  attachments,
  onDetachRequest,
  pending,
  canMutate,
  attachBlockedReason,
  running,
}: {
  title: string;
  description: string;
  emptyHint: string;
  volumes: AttachableVolume[];
  volumeId: string;
  containerPath: string;
  readOnly: boolean;
  onVolumeId: (value: string) => void;
  onContainerPath: (value: string) => void;
  onReadOnly: (value: boolean) => void;
  onAttach: () => void;
  selectId: string;
  pathId: string;
  createTo: '/volumes' | '/shared-volumes';
  createLabel: string;
  attachments: VolumeAttachmentDto[];
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
  pending: boolean;
  canMutate: boolean;
  attachBlockedReason: string | null;
  running: boolean;
}) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={selectId}>{title}</Label>
          <Select
            value={volumeId || undefined}
            onValueChange={onVolumeId}
            disabled={!canMutate}
          >
            <SelectTrigger id={selectId}>
              <SelectValue placeholder={`选择${title}`} />
            </SelectTrigger>
            <SelectContent>
              {volumes.map((volume) => (
                <SelectItem key={volume.id} value={volume.id}>
                  {volume.name} · {formatBytes(volume.sizeBytes)}
                  {volume.capability.shrinkNever ? ' · 不可缩容' : volume.capability.shrinkRequiresStop ? ' · 缩容需卸载' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {attachBlockedReason && (
            <p className="text-xs text-muted-foreground" data-testid="attach-capability-hint">{attachBlockedReason}</p>
          )}
          {canMutate && volumes.length === 0 && (
            <p className="text-xs text-muted-foreground">
              暂无可用{title}。
              <Link to={createTo} className="ml-1 underline">{createLabel}</Link>
            </p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor={pathId}>容器路径</Label>
            <Input id={pathId} value={containerPath} onChange={(event) => onContainerPath(event.target.value)} />
          </div>
          <label className="flex h-10 items-center gap-2 text-sm">
            <Checkbox
              id={`${pathId}-readonly`}
              checked={readOnly}
              onCheckedChange={(checked) => onReadOnly(checked === true)}
            />
            <span>只读</span>
          </label>
        </div>
        <Button onClick={onAttach} disabled={pending || !canMutate || !volumeId || !containerPath.startsWith('/')}>
          {pending ? '提交中...' : '挂载'}
        </Button>
        {attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          <div className="divide-y rounded-md border">
            {attachments.map((attachment) => (
              <AttachmentRow
                key={attachment.id}
                attachment={attachment}
                running={running}
                pending={pending}
                canMutate={canMutate}
                onDetachRequest={onDetachRequest}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AttachmentRow({
  attachment,
  running,
  pending,
  canMutate,
  onDetachRequest,
}: {
  attachment: VolumeAttachmentDto;
  running: boolean;
  pending: boolean;
  canMutate: boolean;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
}) {
  const cancel = attachment.onlineCancelAllowed;
  const stopRequired = running && !cancel;
  const label = cancel ? '取消挂载' : '卸载';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm">
      <div>
        <p className="font-mono text-xs">{attachment.containerPath}</p>
        <p className="text-xs text-muted-foreground">
          卷 {attachment.volumeName} · 设备 {attachment.deviceName} · {attachment.readOnly ? '只读' : '读写'}
          {' · '}
          {BIND_STATE_LABEL[attachment.bindState]}
        </p>
      </div>
      <span className="inline-flex items-center gap-2" title={stopRequired ? '先停止容器' : undefined}>
        {stopRequired && (
          <span className="text-xs text-muted-foreground">先停止容器</span>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onDetachRequest(attachment)}
          disabled={pending || !canMutate || stopRequired}
          title={stopRequired ? '先停止容器' : undefined}
        >
          {label}
        </Button>
      </span>
    </div>
  );
}

function gibLabel(bytes: number): string {
  return approxGibHint(bytes).replace(/^约 /, '');
}

function observedRootUsedLabel(container: ContainerDto): string {
  const used = observedRootUsedBytes(container);
  return used === null ? '未知' : gibLabel(used);
}
