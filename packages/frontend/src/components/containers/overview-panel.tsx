import { useState, type ReactNode } from 'react';
import { Copy, Info as InfoIcon, KeyRound, Pencil, Terminal } from 'lucide-react';
import {
  formatSshProxyJumpLogin,
  type ContainerDto,
  type OpaqueExtensionMap,
  type PatchContainerLimitsRequest,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';
import { Separator } from '../ui/separator.js';
import { SectionCard } from '../layout/section-card.js';
import { TechnicalId } from '../refs/technical-id.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { approxGibHint, formatCpu } from '../../lib/utils.js';
import { powerIntentLabel } from '../../lib/status-labels.js';
import { useAuthStore } from '../../store/auth.js';
import { ExtensionSlots } from '../../extensions/slots.js';
import { LimitsDialog } from './spec-panel.js';

export function OverviewPanel({
  container,
  admin,
  enabledExtensions,
  grant,
  onRepairSsh,
  repairPending,
  onLimits,
  limitsPending,
  onExtensionSubmit,
  extensionPending,
}: {
  container: ContainerDto;
  admin: boolean;
  enabledExtensions: string[];
  grant: OpaqueExtensionMap | null;
  onRepairSsh: () => void;
  repairPending: boolean;
  onLimits: (body: PatchContainerLimitsRequest) => Promise<unknown>;
  limitsPending: boolean;
  onExtensionSubmit: (extensionId: string, payload: unknown) => Promise<unknown>;
  extensionPending: boolean;
}) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const { settings } = usePublicSettings();
  const authUser = useAuthStore((state) => state.user);
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

  return (
    <div data-testid="container-overview">
      <SectionCard title="容器信息" testId="ssh-routed-instance-identity">
        <div className="space-y-4">
          <InfoCategory
            title="规格"
            actions={
              <CategoryButton onClick={() => setLimitsOpen(true)} testId="edit-container-spec">
                <Pencil />编辑
              </CategoryButton>
            }
          >
            <Info
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
                : (container.imageName ?? '尚未收敛')}
            />
            <Info label="CPU" value={formatCpu(container.cpuMillis)} />
            <Info label="内存" value={approxGibHint(container.memBytes).replace(/^约 /, '')} />
            <Info label="期望电源" value={powerIntentLabel(container.powerIntent)} title={container.powerIntent} />
            <ExtensionSlots
              area="container.overview"
              ctx={{ value: container.extensions, serverId: container.serverId, admin }}
            />
          </InfoCategory>
          <Separator />
          <InfoCategory
            title="登录"
            actions={
              <>
                <CategoryButton onClick={() => setSshOpen(true)} testId="open-ssh-login">
                  <Terminal />登录命令
                </CategoryButton>
                <CategoryButton
                  onClick={onRepairSsh}
                  disabled={repairPending || container.lifecyclePhase !== 'active'}
                  testId="repair-ssh"
                >
                  <KeyRound />
                  {repairPending ? '修复中…' : '修复'}
                </CategoryButton>
              </>
            }
          >
            <Info
              label="容器 IP"
              value={
                <span className="inline-flex items-center gap-1">
                  <span className="font-mono">{container.routedIp ?? '等待容器 IP'}</span>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-4 items-center justify-center p-0 leading-none text-muted-foreground"
                          aria-label="内网 IP 说明"
                        >
                          <InfoIcon className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>这是内网 IP，需要通过跳板机连接。</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </span>
              }
            />
            <Info label="登录用户" value={container.ssh.loginUser} mono />
          </InfoCategory>
          {container.ssh.lastError ? <p className="break-all text-xs text-destructive">{container.ssh.lastError}</p> : null}
        </div>
      </SectionCard>
      <Dialog open={sshOpen} onOpenChange={setSshOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>SSH 登录</DialogTitle>
          </DialogHeader>
          {!proxyHost ? (
            <p className="text-sm text-muted-foreground">管理员尚未配置 SSH 代理公网地址</p>
          ) : !routedIp ? (
            <p className="text-sm text-muted-foreground">等待容器地址</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Jump 命令</p>
                  <Button size="sm" variant="outline" onClick={() => { void copyText(jumpCommand!, 'Jump 命令已复制'); }}>
                    <Copy className="h-3.5 w-3.5" />复制
                  </Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="ssh-jump-command">{jumpCommand}</pre>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">~/.ssh/config 片段</p>
                  <Button size="sm" variant="outline" onClick={() => { void copyText(configSnippet!, 'SSH 配置已复制'); }}>
                    <Copy className="h-3.5 w-3.5" />复制
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="ssh-jump-config">{configSnippet}</pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {limitsOpen ? (
        <LimitsDialog
          container={container}
          admin={admin}
          enabledExtensions={enabledExtensions}
          grant={grant}
          pending={limitsPending}
          extensionPending={extensionPending}
          onLimits={onLimits}
          onExtensionSubmit={onExtensionSubmit}
          onOpenChange={(open) => { if (!open) setLimitsOpen(false); }}
        />
      ) : null}
    </div>
  );
}

function InfoCategory({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <h4 className="mr-1 text-sm font-medium">{title}</h4>
        {actions}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3">{children}</div>
    </section>
  );
}

function CategoryButton({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-xs text-muted-foreground [&_svg]:size-3"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </Button>
  );
}

export function Info({
  label,
  value,
  mono = false,
  title,
  className,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <div className={className ? `shrink-0 ${className}` : 'shrink-0'}>
      <p className="text-xs leading-4 text-muted-foreground">{label}</p>
      <div className="flex h-5 items-center gap-1 text-sm leading-5" title={title}>
        {typeof value === 'string' ? (
          <span className={mono ? 'font-mono' : undefined}>{value}</span>
        ) : value}
      </div>
    </div>
  );
}
