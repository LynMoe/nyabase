import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, FileCode, KeyRound } from 'lucide-react';
import {
  type ContainerDto,
  type ListScope,
  type SshClientConfigDto,
  formatSshAgentSetupPrompt,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';
import { SectionCard } from '../layout/section-card.js';
import { Field, FieldGrid } from '../layout/form-field.js';
import { StatusBadge } from '../layout/status-badge.js';
import { sshStatusLabel } from '../../lib/status-labels.js';
import { SshKeyNotice } from '../ssh/ssh-key-notice.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { useAuthStore } from '../../store/auth.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { api } from '../../lib/api.js';
import { useInvalidateContainer } from '../../lib/container-queries.js';
import { queryKeys } from '../../lib/query-keys.js';
import { scopedPath } from '../../lib/scoped-paths.js';

/** The login command, the one-time client setup, the SSH state and the repair action. */
export function SshLoginCard({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const [configOpen, setConfigOpen] = useState(false);
  const authUser = useAuthStore((state) => state.user);
  const ownContainer = scope !== 'all' || (authUser !== null && container.ownerId === authUser.id);
  const sshKeys = useMySshKeys(ownContainer);
  const login = useSshLogin(container, ownContainer);
  const invalidate = useInvalidateContainer(scope, container.id);
  const repairSsh = useActionMutation({
    mutationFn: () => api.post<{ woken: boolean }>(scopedPath(`/containers/${container.id}/actions/repair-ssh`, scope)),
    successTitle: '已提交 SSH 修复',
    errorTitle: 'SSH 修复失败',
    onSuccess: invalidate,
  });
  const repairPending = repairSsh.isPending;
  const { loginCommand, setupPrompt, unavailable, copyText } = login;
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
        ) : loginCommand ? (
          <div className="flex items-stretch gap-2">
            <pre
              className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm"
              data-testid="ssh-login-command"
            >
              {loginCommand}
            </pre>
            <Button
              variant="outline"
              className="h-auto shrink-0"
              onClick={() => { void copyText(loginCommand, '登录命令已复制'); }}
              data-testid="open-ssh-login"
            >
              <Copy className="h-4 w-4" />复制
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{unavailable}</p>
        )}
        {ownContainer && setupPrompt ? (
          <p className="text-xs text-muted-foreground">
            首次登录前先在本机做一次「一次性 SSH 配置」：复制给本机的 AI agent 即可，以后新建的容器不用再配。
          </p>
        ) : null}
        <FieldGrid>
          <Field label="登录用户" value={container.ssh.loginUser} mono />
          <Field label="容器 IP（内网）" value={container.routedIp} mono />
        </FieldGrid>
        {container.ssh.lastError ? <p className="break-all text-xs text-destructive">{sshErrorLabel(container.ssh.lastError)}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={!setupPrompt || !ownContainer} onClick={() => setConfigOpen(true)}>
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
      <SshConfigDialog open={configOpen} onOpenChange={setConfigOpen} login={login} />
    </SectionCard>
  );
}

function SshConfigDialog({
  open,
  onOpenChange,
  login,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  login: SshLogin;
}) {
  const { setupPrompt, copyText } = login;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>一次性 SSH 配置</DialogTitle>
          <DialogDescription>
            把下面整段交给本机的 AI agent（Claude Code、Codex 等），它会写入
            {' '}<code className="font-mono">~/.ssh/config</code> 和 <code className="font-mono">~/.ssh/known_hosts</code>。
            配置一次后，你的所有容器都能直接登录，也不会再出现主机指纹确认。
          </DialogDescription>
        </DialogHeader>
        {setupPrompt ? (
          <div className="space-y-3">
            <pre
              className="max-h-80 overflow-auto whitespace-pre rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs"
              data-testid="ssh-agent-setup"
            >
              {setupPrompt}
            </pre>
            <Button variant="outline" onClick={() => { void copyText(setupPrompt, 'SSH 配置说明已复制'); }}>
              <Copy className="h-4 w-4" />复制
            </Button>
            <p className="text-xs text-muted-foreground">
              管理员修改主机名后缀、轮换代理主机密钥或重置证书 CA 后需要重新配置。
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The ways to reach one of your containers: `ssh <name>.<suffix>` (null until
 * the proxy address and the container's IP are known) and the one-time client
 * setup, worded for an AI agent, that makes that command work for all of them.
 */
export function useSshLogin(container: ContainerDto, ownContainer: boolean) {
  const authUser = useAuthStore((state) => state.user);
  const userId = authUser?.id ?? null;
  const query = useQuery({
    queryKey: queryKeys.sshClientConfig(userId ?? ''),
    queryFn: () => api.get<SshClientConfigDto>(`/users/${userId}/ssh-client-config`),
    enabled: ownContainer && userId !== null,
    staleTime: 60_000,
  });
  const config = query.data;
  const loginUser = container.ssh.loginUser || 'root';
  // The client config defaults to root, so only another login user needs naming.
  const target = loginUser === 'root' ? container.ssh.hostName : `${loginUser}@${container.ssh.hostName}`;
  const setupPrompt = config?.sshConfig && config.knownHosts
    ? formatSshAgentSetupPrompt({
      sshConfig: config.sshConfig,
      knownHosts: config.knownHosts,
      hostSuffix: config.hostSuffix,
      verifyTarget: target,
    })
    : null;
  const loginCommand = setupPrompt && container.routedIp ? `ssh ${target}` : null;
  const unavailable = query.isLoading
    ? '正在加载 SSH 配置…'
    : query.isError
      ? 'SSH 配置加载失败，请稍后刷新。'
      : !setupPrompt
        ? '管理员尚未配置 SSH 代理的公网地址，暂时无法生成登录命令。'
        : '容器还没有分配 IP，启动后即可登录。';
  const copyText = async (value: string, title: string) => {
    const ok = await copyOneTimeSecret(value);
    toast({
      title: ok ? title : '复制失败',
      description: ok ? undefined : '请手动选中后复制',
      variant: ok ? 'default' : 'destructive',
    });
  };
  return { loginCommand, setupPrompt, unavailable, copyText };
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
