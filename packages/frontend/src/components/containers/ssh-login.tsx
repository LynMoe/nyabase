import { useState } from 'react';
import { Copy, FileCode, KeyRound } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { type ContainerDto, type ListScope, formatSshClientConfig, formatSshProxyJump } from '@nyabase/common';
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
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { api } from '../../lib/api.js';
import { useInvalidateContainer } from '../../lib/container-queries.js';
import { scopedPath } from '../../lib/scoped-paths.js';

/** How to log in over the jump host, the SSH state and the repair action. */
export function SshLoginCard({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const [configOpen, setConfigOpen] = useState(false);
  const authUser = useAuthStore((state) => state.user);
  const ownContainer = scope !== 'all' || (authUser !== null && container.ownerId === authUser.id);
  const sshKeys = useMySshKeys(ownContainer);
  const login = useSshLogin(container);
  const invalidate = useInvalidateContainer(scope, container.id);
  const repairSsh = useActionMutation({
    mutationFn: () => api.post<{ woken: boolean }>(scopedPath(`/containers/${container.id}/actions/repair-ssh`, scope)),
    successTitle: '已提交 SSH 修复',
    errorTitle: 'SSH 修复失败',
    onSuccess: invalidate,
  });
  const repairPending = repairSsh.isPending;
  const { proxyHost, jumpCommand, configSnippet, copyText } = login;
  const hostName = container.ssh.hostName;
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
        {ownContainer && sshKeys.missing ? <SshKeyNotice variant="inline" /> : null}
        {!ownContainer ? (
          <p className="text-sm text-muted-foreground">
            这是 {container.ownerName ?? '其他用户'} 的容器。SSH 代理只按公钥持有者自己的容器解析名字，登录命令只对所有者有效。
          </p>
        ) : jumpCommand ? (
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
          <Field label="主机名（经 SSH 代理解析）" value={hostName} mono />
          <Field label="登录用户" value={container.ssh.loginUser} mono />
          <Field label="容器 IP（内网）" value={container.routedIp} mono />
        </FieldGrid>
        {container.ssh.lastError ? <p className="break-all text-xs text-destructive">{sshErrorLabel(container.ssh.lastError)}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={!configSnippet || !ownContainer} onClick={() => setConfigOpen(true)}>
            <FileCode className="h-4 w-4" />一次性 SSH 配置
          </Button>
          <Hint
            content={repairDisabled && !repairPending ? '容器处于创建或删除过程中，暂时无法修复。' : '重新下发你的 SSH 公钥并检查 sshd，适用于登录被拒绝时。'}
            disabled={repairDisabled}
          >
            <Button size="sm" variant="ghost" onClick={() => repairSsh.mutate()} disabled={repairDisabled} data-testid="repair-ssh">
              <KeyRound className="h-4 w-4" />{repairPending ? '修复中…' : '修复 SSH'}
            </Button>
          </Hint>
        </div>
      </div>
      <SshConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        hostName={hostName}
        loginUser={container.ssh.loginUser || 'root'}
        login={login}
      />
    </SectionCard>
  );
}

function SshConfigDialog({
  open,
  onOpenChange,
  hostName,
  loginUser,
  login,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostName: string;
  loginUser: string;
  login: SshLogin;
}) {
  const { configSnippet, copyText } = login;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>一次性 SSH 配置</DialogTitle>
          <DialogDescription>
            加入本机 <code className="font-mono">~/.ssh/config</code> 后，你的所有容器都可以直接
            {' '}<code className="font-mono">ssh {loginUser}@{hostName}</code> 登录，以后新建的容器也不用再配置。
          </DialogDescription>
        </DialogHeader>
        {configSnippet ? (
          <div className="space-y-3">
            <pre className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs" data-testid="ssh-jump-config">{configSnippet}</pre>
            <Button variant="outline" onClick={() => { void copyText(configSnippet, 'SSH 配置已复制'); }}>
              <Copy className="h-4 w-4" />复制
            </Button>
            <p className="text-sm text-muted-foreground">
              想免去首次连接的主机指纹确认，到
              {' '}<Link to="/profile" onClick={() => onOpenChange(false)} className="font-medium underline underline-offset-4">个人资料</Link>
              {' '}复制 known_hosts 行。
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The ways to reach a container over the SSH jump host: the one-line command
 * (null until the proxy address and the container's IP are known) and the
 * one-time `~/.ssh/config` block for all of the owner's containers.
 */
export function useSshLogin(container: ContainerDto) {
  const { settings } = usePublicSettings();
  const authUser = useAuthStore((state) => state.user);
  const username = container.ownerName ?? authUser?.username ?? '<username>';
  const host = container.ssh.proxyHost?.trim() || settings.sshProxy?.host || null;
  const port = container.ssh.proxyPort ?? settings.sshProxy?.port ?? 22;
  // `<name>.<suffix>`, and container names never contain a dot.
  const hostSuffix = container.ssh.hostName.split('.').slice(1).join('.');
  const proxyHost = host ? (port !== 22 ? `${host}:${port}` : host) : null;
  const loginUser = container.ssh.loginUser || 'root';
  // The proxy resolves the name among the owner's containers; no address to copy.
  const jumpCommand = host && container.routedIp
    ? `ssh -J ${formatSshProxyJump({ username, host, port })} ${loginUser}@${container.ssh.hostName}`
    : null;
  const configSnippet = host && hostSuffix
    ? formatSshClientConfig({ username, host, port, hostSuffix })
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

const SSH_ERROR_LABELS: Partial<Record<string, string>> = {
  sshd_not_listening: '容器内 sshd 没有在 22 端口监听，SSH 登录暂不可用',
  key_applied_sshd_missing: '公钥已写入，但容器内没有可用的 sshd',
  authorized_keys_not_a_file: '容器内的 authorized_keys 是符号链接或目录，平台不会改写它；请把它换成普通文件',
};

function sshErrorLabel(code: string): string {
  return SSH_ERROR_LABELS[code] ?? code;
}
