import { Copy, KeyRound } from 'lucide-react';
import { formatSshProxyJumpLogin, type ContainerDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { approxGibHint, formatCpu, relativeTime } from '../../lib/utils.js';
import {
  containerStatusLabel,
  powerIntentLabel,
  sshStatusLabel,
} from '../../lib/status-labels.js';
import { useAuthStore } from '../../store/auth.js';
import { ExtensionSlots } from '../../extensions/slots.js';

export function OverviewPanel({
  container,
  onRepairSsh,
  repairPending,
}: {
  container: ContainerDto;
  onRepairSsh: () => void;
  repairPending: boolean;
}) {
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
    <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="container-overview">
      <Card>
        <CardHeader><CardTitle className="text-base">容器信息</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info label="镜像指纹" value={container.imageFingerprint} mono />
          <Info label="实例名" value={container.instanceName ?? '等待收敛'} mono />
          <Info label="容器 IP" value={container.routedIp ?? '等待容器 IP'} mono />
          <Info label="期望电源" value={powerIntentLabel(container.powerIntent)} title={container.powerIntent} />
          <Info label="实际状态" value={containerStatusLabel(container.actual.status)} title={container.actual.status} />
          <Info label="观测时间" value={relativeTime(container.actual.observedAt)} />
        </CardContent>
      </Card>
      <Card data-testid="ssh-routed-instance-identity">
        <CardHeader>
          <CardTitle className="text-base">SSH 登录信息</CardTitle>
          <CardDescription className="break-keep">
            通过 SSH 代理 Jump 到容器：第一跳校验平台公钥与路由，第二跳由客户端与容器 sshd 端到端验钥。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Info label="登录用户" value={container.ssh.loginUser} mono />
          <Info label="SSH 状态" value={sshStatusLabel(container.ssh.status)} title={container.ssh.status} />
          <Info label="容器主机密钥指纹" value={container.ssh.hostKeyFingerprint ?? '尚未观测'} mono />
          {!proxyHost ? (
            <p className="text-sm text-muted-foreground">管理员尚未配置 SSH 代理公网地址</p>
          ) : !routedIp ? (
            <p className="text-sm text-muted-foreground">等待容器地址</p>
          ) : (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">Jump 命令</p>
                  <Button size="sm" variant="outline" onClick={() => { void copyText(jumpCommand!, 'Jump 命令已复制'); }}>
                    <Copy className="h-3.5 w-3.5" />复制
                  </Button>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="ssh-jump-command">{jumpCommand}</pre>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">~/.ssh/config 片段</p>
                  <Button size="sm" variant="outline" onClick={() => { void copyText(configSnippet!, 'SSH 配置已复制'); }}>
                    <Copy className="h-3.5 w-3.5" />复制
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="ssh-jump-config">{configSnippet}</pre>
              </div>
            </>
          )}
          {container.ssh.lastError && <p className="break-all text-xs text-destructive">{container.ssh.lastError}</p>}
          <Button
            size="sm"
            variant="outline"
            disabled={repairPending || container.lifecyclePhase !== 'active'}
            onClick={onRepairSsh}
            data-testid="repair-ssh"
          >
            <KeyRound className="h-4 w-4" />
            {repairPending ? '修复中…' : '修复 SSH'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">资源</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info label="CPU" value={formatCpu(container.cpuMillis)} />
          <Info label="内存" value={approxGibHint(container.memBytes).replace(/^约 /, '')} />
          <ExtensionSlots
            area="container.overview"
            ctx={{ value: container.extensions, serverId: container.serverId }}
          />
          <Info
            label="系统盘"
            value={`${approxGibHint(container.rootSizeBytes).replace(/^约 /, '')}${container.rootSizePendingBytes === null ? '' : `（待应用 ${approxGibHint(container.rootSizePendingBytes).replace(/^约 /, '')}）`}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export function Info({ label, value, mono = false, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'} title={title}>{value}</p>
    </div>
  );
}
