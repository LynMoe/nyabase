import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChartLine, Copy, FileCode, KeyRound, Pencil } from 'lucide-react';
import {
  formatSshProxyJumpLogin,
  type ContainerDto,
  type GpuGrant,
  type ListScope,
  type PerformanceSelfResponse,
  type PatchContainerLimitsRequest,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Hint } from '../ui/hint.js';
import { SectionCard } from '../layout/section-card.js';
import { Field, FieldGrid } from '../layout/field.js';
import { StatusBadge } from '../layout/status-badge.js';
import { TechnicalId } from '../refs/technical-id.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { formatBytesCompact, formatCpu, formatRate } from '../../lib/utils.js';
import { sshStatusLabel } from '../../lib/status-labels.js';
import { useAuthStore } from '../../store/auth.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { SshKeyNotice } from '../ssh/ssh-key-notice.js';
import { ContainerOverviewGpu } from '../gpu/gpu-sections.js';
import { LimitsDialog } from './spec-panel.js';

export function OverviewPanel({
  container,
  scope,
  gpuEnabled,
  gpuGrant,
  onRepairSsh,
  repairPending,
  onLimits,
  limitsPending,
  onGpuSubmit,
  gpuPending,
  occupancy,
  occupancyDenied,
}: {
  container: ContainerDto;
  scope: ListScope;
  gpuEnabled: boolean;
  gpuGrant: GpuGrant | null;
  onRepairSsh: () => void;
  repairPending: boolean;
  onLimits: (body: PatchContainerLimitsRequest) => Promise<unknown>;
  limitsPending: boolean;
  onGpuSubmit: (pciAddresses: string[]) => Promise<unknown>;
  gpuPending: boolean;
  occupancy?: PerformanceSelfResponse;
  occupancyDenied?: boolean;
}) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const { settings } = usePublicSettings();
  const authUser = useAuthStore((state) => state.user);
  const admin = scope === 'all';
  const ownContainer = !admin || (authUser !== null && container.ownerId === authUser.id);
  const sshKeys = useMySshKeys(ownContainer);
  const username = container.ownerName ?? authUser?.username ?? '<username>';
  const jumpLogin = formatSshProxyJumpLogin({
    username,
    containerName: container.name,
  });
  const proxyHostValue = container.ssh.proxyHost?.trim()
    || settings.sshProxy?.host
    || null;
  const proxyPortValue = container.ssh.proxyPort
    ?? settings.sshProxy?.port
    ?? null;
  const proxyHost = proxyHostValue
    ? (proxyPortValue && proxyPortValue !== 22
      ? `${proxyHostValue}:${proxyPortValue}`
      : proxyHostValue)
    : null;
  const routedIp = container.routedIp;
  const loginUser = container.ssh.loginUser || 'root';
  const jumpCommand = proxyHost && routedIp
    ? `ssh -J ${jumpLogin}@${proxyHost} ${loginUser}@${routedIp}`
    : null;
  const configSnippet = proxyHost && routedIp
    ? [
      `Host ${container.name}`,
      `  HostName ${routedIp}`,
      `  User ${loginUser}`,
      `  ProxyJump ${jumpLogin}@${proxyHost}`,
    ].join('\n')
    : null;
  const copyText = async (value: string, title: string) => {
    const ok = await copyOneTimeSecret(value);
    toast({
      title: ok ? title : '复制失败',
      description: ok ? undefined : '请手动选中后复制',
      variant: ok ? 'default' : 'destructive',
    });
  };
  const sshReady = container.ssh.ready;
  const repairDisabled = repairPending || container.lifecyclePhase !== 'active';

  const usage = occupancy?.container;
  const gpuUsed = usage?.gpu.usedBytes ?? null;
  const gpuText = usage && (usage.gpu.pciAddresses.length > 0 || gpuUsed !== null) && gpuUsed !== null
    ? formatBytesCompact(gpuUsed)
    : null;
  const usagePath = admin ? '/manage/containers/$containerId/usage' : '/containers/$containerId/usage';

  return (
    <div className="space-y-4" data-testid="container-overview">
      <SectionCard
        title="SSH 登录"
        testId="ssh-routed-instance-identity"
        actions={(
          <StatusBadge
            label={sshStatusLabel(container.ssh.status)}
            raw={container.ssh.status}
            pending={false}
            variant={sshReady ? 'success' : container.ssh.status === 'error' ? 'destructive' : 'secondary'}
          />
        )}
      >
        <div className="space-y-4">
          {ownContainer && sshKeys.missing ? <SshKeyNotice variant="inline" /> : null}
          {jumpCommand ? (
            <div className="flex items-stretch gap-2">
              <pre
                className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm"
                data-testid="ssh-jump-command"
              >
                {jumpCommand}
              </pre>
              <Button
                variant="outline"
                className="h-auto shrink-0"
                onClick={() => { void copyText(jumpCommand, '登录命令已复制'); }}
                data-testid="open-ssh-login"
              >
                <Copy className="h-4 w-4" />复制
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {!proxyHost ? '管理员尚未配置 SSH 代理的公网地址，暂时无法生成登录命令。' : '容器还没有分配 IP，启动后即可登录。'}
            </p>
          )}
          <FieldGrid>
            <Field label="容器 IP（内网，经跳板机访问）" value={routedIp} mono />
            <Field label="登录用户" value={container.ssh.loginUser} mono />
          </FieldGrid>
          {container.ssh.lastError ? <p className="break-all text-xs text-destructive">{container.ssh.lastError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={!configSnippet} onClick={() => setConfigOpen(true)}>
              <FileCode className="h-4 w-4" />~/.ssh/config 片段
            </Button>
            <Hint
              content={repairDisabled && !repairPending ? '容器处于创建或删除过程中，暂时无法修复。' : '重新下发你的 SSH 公钥并检查 sshd，适用于登录被拒绝时。'}
              disabled={repairDisabled}
            >
              <Button size="sm" variant="ghost" onClick={onRepairSsh} disabled={repairDisabled} data-testid="repair-ssh">
                <KeyRound className="h-4 w-4" />{repairPending ? '修复中…' : '修复 SSH'}
              </Button>
            </Hint>
          </div>
        </div>
      </SectionCard>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SectionCard
          title="规格"
          actions={(
            <Button size="sm" variant="outline" onClick={() => setLimitsOpen(true)} data-testid="edit-container-spec">
              <Pencil className="h-4 w-4" />编辑
            </Button>
          )}
        >
          <FieldGrid>
            <Field
              label="镜像"
              value={container.imageFingerprint
                ? (
                  <TechnicalId
                    label="镜像"
                    kind="fingerprint"
                    alias={container.imageName}
                    value={container.imageFingerprint}
                    visible={container.imageName?.trim() || undefined}
                  />
                )
                : (container.imageName ?? '同步中')}
            />
            <Field label="CPU" value={formatCpu(container.cpuMillis)} />
            <Field label="内存" value={formatBytesCompact(container.memBytes)} />
            <Field label="系统盘" value={formatBytesCompact(container.rootSizeBytes)} />
            <Field label="实例名" value={container.instanceName ?? '创建中'} mono />
            <ContainerOverviewGpu gpu={container.gpu} serverId={container.serverId} scope={scope} />
          </FieldGrid>
        </SectionCard>

        <SectionCard
          title="实时占用"
          description={occupancy?.stale ? '数据可能已过时' : undefined}
          actions={(
            <Button asChild variant="ghost" size="sm">
              <Link to={usagePath} params={{ containerId: container.id }}>
                <ChartLine className="h-4 w-4" />图表
              </Link>
            </Button>
          )}
        >
          {occupancyDenied ? <p className="text-sm text-muted-foreground">没有查看指标的权限</p> : (
            <FieldGrid>
              <Field label="CPU" value={usage?.cpu.usageCores == null ? null : `${usage.cpu.usageCores.toFixed(1)} 核`} />
              <Field label="内存" value={usage?.memory.usedBytes == null ? null : formatBytesCompact(usage.memory.usedBytes)} />
              <Field label="磁盘" value={usage?.disk.usedBytes == null ? null : formatBytesCompact(usage.disk.usedBytes)} />
              <Field label="网络 ↓ / ↑" value={usage ? `${rate(usage.network.rxBytesPerSec)} / ${rate(usage.network.txBytesPerSec)}` : null} />
              {gpuText ? <Field label="显存" value={gpuText} /> : null}
            </FieldGrid>
          )}
        </SectionCard>
      </div>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>~/.ssh/config 片段</DialogTitle>
            <DialogDescription>加入本机 SSH 配置后，可以直接 <code className="font-mono">ssh {container.name}</code>。</DialogDescription>
          </DialogHeader>
          {configSnippet ? (
            <div className="space-y-3">
              <pre className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs" data-testid="ssh-jump-config">{configSnippet}</pre>
              <Button variant="outline" onClick={() => { void copyText(configSnippet, 'SSH 配置已复制'); }}>
                <Copy className="h-4 w-4" />复制
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      {limitsOpen ? (
        <LimitsDialog
          container={container}
          scope={scope}
          gpuEnabled={gpuEnabled}
          gpuGrant={gpuGrant}
          pending={limitsPending}
          gpuPending={gpuPending}
          onLimits={onLimits}
          onGpuSubmit={onGpuSubmit}
          onOpenChange={(open) => { if (!open) setLimitsOpen(false); }}
        />
      ) : null}
    </div>
  );
}

function rate(value: number | null): string {
  return value === null ? '—' : formatRate(value);
}
