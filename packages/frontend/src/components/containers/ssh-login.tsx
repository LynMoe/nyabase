import { Copy, FileCode, KeyRound } from 'lucide-react';
import { type ContainerDto, formatSshProxyJumpLogin } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';
import { SectionCard } from '../layout/section-card.js';
import { Field, FieldGrid } from '../layout/form-field.js';
import { StatusBadge } from '../layout/status-badge.js';
import { sshStatusLabel } from '../../lib/status-labels.js';
import { SshKeyNotice } from '../ssh/ssh-key-notice.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { useAuthStore } from '../../store/auth.js';

/** How to log in over the jump host, the SSH state and the repair action. */
export function SshLoginCard({
  container,
  login,
  showKeyNotice,
  repairPending,
  onRepairSsh,
  onShowConfig,
}: {
  container: ContainerDto;
  login: SshLogin;
  showKeyNotice: boolean;
  repairPending: boolean;
  onRepairSsh: () => void;
  onShowConfig: () => void;
}) {
  const { proxyHost, jumpCommand, configSnippet, copyText } = login;
  const sshReady = container.ssh.ready;
  const repairDisabled = repairPending || container.lifecyclePhase !== 'active';
  return (
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
        {showKeyNotice ? <SshKeyNotice variant="inline" /> : null}
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
          <Field label="容器 IP（内网，经跳板机访问）" value={container.routedIp} mono />
          <Field label="登录用户" value={container.ssh.loginUser} mono />
        </FieldGrid>
        {container.ssh.lastError ? <p className="break-all text-xs text-destructive">{container.ssh.lastError}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={!configSnippet} onClick={onShowConfig}>
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
  );
}

export function SshConfigDialog({
  open,
  onOpenChange,
  containerName,
  login,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  containerName: string;
  login: SshLogin;
}) {
  const { configSnippet, copyText } = login;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>~/.ssh/config 片段</DialogTitle>
          <DialogDescription>加入本机 SSH 配置后，可以直接 <code className="font-mono">ssh {containerName}</code>。</DialogDescription>
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
  );
}

/**
 * The ways to reach a container over the SSH jump host: the one-line command
 * and an `~/.ssh/config` snippet. Both are null until the proxy address and the
 * container's IP are known.
 */
export function useSshLogin(container: ContainerDto) {
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
  return { proxyHost, jumpCommand, configSnippet, copyText };
}

export type SshLogin = ReturnType<typeof useSshLogin>;
