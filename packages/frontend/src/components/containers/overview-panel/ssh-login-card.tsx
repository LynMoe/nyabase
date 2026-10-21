import { Copy, FileCode, KeyRound } from 'lucide-react';
import type { ContainerDto } from '@nyabase/common';
import { Button } from '../../ui/button.js';
import { Hint } from '../../ui/hint.js';
import { SectionCard } from '../../layout/section-card.js';
import { Field, FieldGrid } from '../../layout/field.js';
import { StatusBadge } from '../../layout/status-badge.js';
import { sshStatusLabel } from '../../../lib/status-labels.js';
import { SshKeyNotice } from '../../ssh/ssh-key-notice.js';
import type { SshLogin } from './use-ssh-login.js';

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
