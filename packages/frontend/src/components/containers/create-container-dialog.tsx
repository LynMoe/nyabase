import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { SshKeyNotice } from '../ssh/ssh-key-notice.js';
import {
  type CreateContainerForm,
  useCreateContainerForm,
} from './use-create-container-form.js';
import { Checkbox } from '../ui/checkbox.js';
import { SelectField } from '../layout/form-field.js';
import { ContainerCreateGpu } from '../gpu/gpu-sections.js';
import { cn } from '../../lib/utils.js';
import { bytesText, cpuText } from './use-create-container-form.js';

export function CreateContainerDialog({
  open,
  onOpenChange,
  defaultServerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultServerId?: string;
}) {
  const form = useCreateContainerForm({ open, onOpenChange, defaultServerId });
  const sshKeys = useMySshKeys(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="container-create-canonical">
        <DialogHeader>
          <DialogTitle>新建容器</DialogTitle>
          <DialogDescription>创建后可通过 SSH 跳板机登录，规格之后也能调整。</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            form.submit();
          }}
        >
          <FormField id="container-name" label="名称" error={form.errors.name} hint="字母、数字和连字符，例如 dev-ubuntu">
            <Input
              id="container-name"
              value={form.form.name}
              autoFocus
              autoComplete="off"
              onChange={(event) => form.update('name', event.target.value)}
              placeholder="dev-ubuntu"
            />
          </FormField>
          <PlacementFields form={form} />
          <SpecFields form={form} />
          <GpuAndStartFields form={form} />
          {sshKeys.missing ? <SshKeyNotice variant="inline" onNavigate={() => onOpenChange(false)} /> : null}
          {form.submitError ? <p className="text-sm text-destructive" role="alert">{form.submitError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={form.pending || form.data.serversLoading || form.overQuota}>
              {form.pending ? '提交中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemainingPart({ label, value, over }: { label: string; value: string; over: boolean }) {
  return (
    <span className={cn(over && 'font-medium text-destructive')}>
      {label} {value}
    </span>
  );
}

function UnitField({
  id,
  label,
  value,
  onChange,
  error,
  step = '1',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  step?: string;
}) {
  return (
    <FormField id={id} label={label} error={error}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step={step}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

/** Server and image pickers. */
export function PlacementFields({ form }: { form: CreateContainerForm }) {
  const { servers, images, serversLoading } = form.data;
  const serverPlaceholder = serversLoading
    ? '加载中…'
    : servers.length === 0
      ? '暂无可用服务器'
      : '选择服务器';
  const imagePlaceholder = !form.form.serverId
    ? '先选择服务器'
    : form.noImagesForServer
      ? '没有可用镜像'
      : '选择镜像';
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField
        id="container-server"
        label="服务器"
        value={form.form.serverId}
        onChange={(value) => {
          form.update('serverId', value);
          form.update('imageId', '');
          form.setGpuPciAddresses(undefined);
        }}
        options={servers.map((server) => [server.id, server.name])}
        placeholder={serverPlaceholder}
        disabled={serversLoading || servers.length === 0}
        error={form.errors.serverId}
        hint={!serversLoading && servers.length === 0 ? '没有你可以使用的在线服务器，请联系管理员分配。' : undefined}
      />
      <SelectField
        key={form.form.serverId || 'no-server'}
        id="container-image"
        label="镜像"
        value={form.form.imageId}
        onChange={(value) => form.update('imageId', value)}
        options={images.map((image) => [image.id, image.alias])}
        placeholder={imagePlaceholder}
        disabled={!form.form.serverId || form.noImagesForServer}
        error={form.errors.imageId}
        hint={form.noImagesForServer ? '这台服务器还没有分配给你的镜像，请联系管理员。' : undefined}
      />
    </div>
  );
}

/** CPU / memory / root disk inputs and the quota left on the chosen server. */
export function SpecFields({ form }: { form: CreateContainerForm }) {
  const { cpuLeft, memLeft, diskLeft, cpuOver, memOver, diskOver, onServer } = form;
  const { selectedAccess, capacityQuery } = form.data;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <UnitField
          id="container-cpu"
          label="CPU（核）"
          value={form.form.cpuVcpus}
          onChange={(value) => form.update('cpuVcpus', value)}
          step="0.5"
          error={form.errors.cpuVcpus ?? (cpuOver && cpuLeft !== null ? `超出剩余额度 ${cpuText(cpuLeft)}` : undefined)}
        />
        <UnitField
          id="container-memory"
          label="内存（GiB）"
          value={form.form.memGib}
          onChange={(value) => form.update('memGib', value)}
          error={form.errors.memGib ?? (memOver && memLeft !== null ? `超出剩余额度 ${bytesText(memLeft)}` : undefined)}
        />
        <UnitField
          id="container-root-size"
          label="系统盘（GiB）"
          value={form.form.rootSizeGib}
          onChange={(value) => form.update('rootSizeGib', value)}
          error={form.errors.rootSizeGib ?? (diskOver && diskLeft !== null ? `超出剩余容量 ${bytesText(diskLeft)}` : undefined)}
        />
      </div>
      {selectedAccess ? (
        <p className="text-xs text-muted-foreground" data-testid="create-remaining">
          这台服务器上你还剩：
          <RemainingPart label="CPU" value={cpuLeft === null ? (onServer ? '不限' : '…') : cpuText(cpuLeft)} over={cpuOver} />
          {' · '}
          <RemainingPart label="内存" value={memLeft === null ? (onServer ? '不限' : '…') : bytesText(memLeft)} over={memOver} />
          {' · '}
          <RemainingPart
            label="磁盘"
            value={capacityQuery.isError ? '暂不可知' : diskLeft === null ? (capacityQuery.data ? '不限' : '…') : bytesText(diskLeft)}
            over={diskOver}
          />
        </p>
      ) : null}
    </>
  );
}

export function GpuAndStartFields({ form }: { form: CreateContainerForm }) {
  return (
    <>
      <ContainerCreateGpu
        serverId={form.form.serverId}
        gpuEnabled={form.selected?.gpuEnabled === true}
        grantedAddresses={form.data.selectedAccess?.gpuPciAddresses ?? null}
        value={form.gpuPciAddresses ?? []}
        onChange={form.setGpuPciAddresses}
      />
      <FormField id="container-start" label="创建后立即启动" orientation="inline">
        <Checkbox
          id="container-start"
          checked={form.form.startAfterCreate}
          onCheckedChange={(checked) => form.update('startAfterCreate', checked === true)}
        />
      </FormField>
    </>
  );
}
