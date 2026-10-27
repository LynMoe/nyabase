import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, FileCode, KeyRound } from 'lucide-react';
import {
  type ContainerDto,
  type ListScope,
  type SshClientConfigDto,
  type SshProxyLineDto,
  formatSshAgentSetupPrompt,
  formatSshClientConfig,
  formatSshJumpCommand,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.js';
import { SectionCard } from '../layout/section-card.js';
import { Field, FieldGrid, FormField } from '../layout/form-field.js';
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

/** The login commands (quick, or through one line), the SSH state and the repair action. */
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
          <p className="text-sm text-muted-foreground">仅所有者（{container.ownerName ?? '其他用户'}）可登录</p>
        ) : login.ready ? (
          <SshLoginTabs login={login} onOpenSetup={() => setConfigOpen(true)} />
        ) : (
          <p className="text-sm text-muted-foreground">{login.unavailable}</p>
        )}
        <FieldGrid>
          <Field label="登录用户" value={container.ssh.loginUser} mono />
          <Field label="容器 IP（内网）" value={container.routedIp} mono />
        </FieldGrid>
        {container.ssh.lastError ? <p className="break-all text-xs text-destructive">{sshErrorLabel(container.ssh.lastError)}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Hint
            content={repairDisabled && !repairPending ? '容器正在创建或删除' : '重新下发公钥并检查 sshd'}
            disabled={repairDisabled}
          >
            <Button size="sm" variant="ghost" onClick={() => repairSsh.mutate()} disabled={repairDisabled} data-testid="repair-ssh">
              <KeyRound className="h-4 w-4" />{repairPending ? '修复中…' : '修复 SSH'}
            </Button>
          </Hint>
        </div>
      </div>
      {login.ready ? <SshConfigDialog open={configOpen} onOpenChange={setConfigOpen} login={login} /> : null}
    </SectionCard>
  );
}

const QUICK_TAB = 'quick';
const TAB_STORAGE_KEY = 'nyabase.ssh-login-tab';

/**
 * 快速连接 (`ssh <name>.<suffix>`, after the one-time setup) and one `ssh -J`
 * tab per line, each with its note underneath. The tab is remembered per
 * browser, so someone always on the campus line lands on it.
 */
function SshLoginTabs({ login, onOpenSetup }: { login: SshLogin; onOpenSetup: () => void }) {
  const { lines, quickCommand, jumpCommand, copyText } = login;
  const [stored, setStored] = useState(readStoredTab);
  const tab = stored === QUICK_TAB || lines.some((line) => line.id === stored) ? stored : QUICK_TAB;
  const select = (value: string) => {
    setStored(value);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, value);
    } catch {
      // Storage may be unavailable (private window); the tab just is not remembered.
    }
  };
  return (
    <Tabs value={tab} onValueChange={select} className="space-y-2">
      <TabsList className="h-auto w-full flex-nowrap justify-start overflow-x-auto" aria-label="连接方式">
        <TabsTrigger value={QUICK_TAB} data-testid="ssh-tab-quick">快速连接</TabsTrigger>
        {lines.map((line) => (
          <TabsTrigger key={line.id} value={line.id} data-testid="ssh-tab-line">{line.name}</TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={QUICK_TAB} className="mt-0 space-y-1.5">
        <CommandLine command={quickCommand} copyText={copyText} testId="ssh-login-command" />
        <p className="text-xs text-muted-foreground">
          需先在本机完成一次性配置。
          <button
            type="button"
            className="ml-1 inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
            onClick={onOpenSetup}
            data-testid="ssh-setup-open"
          >
            <FileCode className="h-3.5 w-3.5" />配置说明
          </button>
        </p>
      </TabsContent>
      {lines.map((line) => (
        <TabsContent key={line.id} value={line.id} className="mt-0 space-y-1.5">
          <CommandLine command={jumpCommand(line)} copyText={copyText} testId="ssh-jump-command" />
          {line.hint ? <p className="text-xs text-muted-foreground" data-testid="ssh-line-hint">{line.hint}</p> : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function readStoredTab(): string {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) ?? QUICK_TAB;
  } catch {
    return QUICK_TAB;
  }
}

function CommandLine({ command, copyText, testId }: { command: string; copyText: SshLogin['copyText']; testId: string }) {
  return (
    <div className="flex items-stretch gap-2">
      <pre
        className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm"
        data-testid={testId}
      >
        {command}
      </pre>
      <Button
        variant="outline"
        className="h-auto shrink-0"
        onClick={() => { void copyText(command, '登录命令已复制'); }}
        data-testid={`copy-${testId}`}
      >
        <Copy className="h-4 w-4" />复制
      </Button>
    </div>
  );
}

/** The one-time setup, worded for an AI agent; with several lines, the user picks the one it goes through. */
function SshConfigDialog({
  open,
  onOpenChange,
  login,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  login: SshLogin;
}) {
  const { lines, setupPrompt, copyText } = login;
  const [lineId, setLineId] = useState<string | null>(null);
  const line = lines.find((candidate) => candidate.id === lineId) ?? lines[0]!;
  const prompt = setupPrompt(line);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>一次性 SSH 配置</DialogTitle>
          <DialogDescription>复制给本机的 AI agent 执行，之后用「快速连接」的命令登录</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {lines.length > 1 ? (
            <FormField id="ssh-setup-line" label="经由线路">
              <Select value={line.id} onValueChange={setLineId}>
                <SelectTrigger id="ssh-setup-line" data-testid="ssh-setup-line">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {lines.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                      {candidate.hint ? <span className="ml-2 text-muted-foreground">{candidate.hint}</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : null}
          <pre
            className="max-h-80 overflow-auto whitespace-pre rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs"
            data-testid="ssh-agent-setup"
          >
            {prompt}
          </pre>
          <Button variant="outline" onClick={() => { void copyText(prompt, 'SSH 配置说明已复制'); }}>
            <Copy className="h-4 w-4" />复制
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The ways to reach one of your containers: `ssh <name>.<suffix>` once the
 * one-time client setup (worded for an AI agent, through a chosen line) is in
 * place, and `ssh -J` through each line for a client without it. `ready` once
 * there is a line and the container has an IP.
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
  const lines = config?.lines ?? [];
  const username = authUser?.username ?? '';
  const loginUser = container.ssh.loginUser || 'root';
  const hostName = container.ssh.hostName;
  // The client config defaults to root, so only another login user needs naming.
  const target = loginUser === 'root' ? hostName : `${loginUser}@${hostName}`;
  const ready = Boolean(config?.knownHosts && lines.length > 0 && container.routedIp && authUser);
  const jumpCommand = (line: SshProxyLineDto) => formatSshJumpCommand({
    username,
    host: line.host,
    port: line.port,
    loginUser,
    hostName,
  });
  const setupPrompt = (line: SshProxyLineDto) => formatSshAgentSetupPrompt({
    sshConfig: formatSshClientConfig({ username, host: line.host, port: line.port, hostSuffix: config?.hostSuffix ?? '' }),
    knownHosts: config?.knownHosts ?? '',
    hostSuffix: config?.hostSuffix ?? '',
    verifyTarget: target,
  });
  const unavailable = query.isLoading
    ? '正在加载 SSH 配置…'
    : query.isError
      ? 'SSH 配置加载失败'
      : lines.length === 0
        ? 'SSH 代理尚未配置线路'
        : '等待容器 IP';
  const copyText = async (value: string, title: string) => {
    const ok = await copyOneTimeSecret(value);
    toast({
      title: ok ? title : '复制失败',
      description: ok ? undefined : '请手动选中后复制',
      variant: ok ? 'default' : 'destructive',
    });
  };
  return { ready, lines, quickCommand: `ssh ${target}`, jumpCommand, setupPrompt, unavailable, copyText };
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
