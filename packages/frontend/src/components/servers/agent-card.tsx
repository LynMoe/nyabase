import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, PlugZap, Unplug } from 'lucide-react';
import type { RotateServerEnrollmentRequest, ServerDto, ServerEnrollmentDto } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { Field } from '../layout/form-field.js';
import { TechnicalId } from '../refs/technical-id.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { useInvalidateServer } from '../../lib/server-queries.js';
import { relativeTime } from '../../lib/utils.js';
import { agentFirewallBadge } from '../../lib/firewall-rules.js';
import { StatusBadge } from '../layout/status-badge.js';
import { toast } from '../../hooks/use-toast.js';
import { EnrollmentInstructions } from './agent-enrollment.js';

/** Connected / enrolled / waiting-for-enrollment, as one word for lists and badges. */
export function agentStateLabel(agent: ServerDto['agent']): string {
  if (agent.connected) return '已连接';
  if (agent.enrolled) return '已断开';
  return '待接入';
}

export function AgentStateBadge({ agent }: { agent: ServerDto['agent'] }) {
  const Icon = agent.connected ? PlugZap : Unplug;
  return (
    <Badge variant={agent.connected ? 'success' : agent.enrolled ? 'destructive' : 'secondary'}>
      <Icon className="h-3 w-3" />{agentStateLabel(agent)}
    </Badge>
  );
}

/** 防火墙 sync as the connected agent reports it; null (disconnected) reads as 离线. */
function AgentFirewallBadge({ firewall }: { firewall: ServerDto['agent']['firewall'] }) {
  const badge = agentFirewallBadge(firewall);
  return (
    <StatusBadge
      label={badge.label}
      raw={firewall?.error ?? undefined}
      pending={badge.pending}
      variant={badge.tone}
    />
  );
}

/**
 * The host agent that dials the backend for this server: whether it holds its
 * control connection, what it reported, and re-issuing its enrollment token.
 */
export function AgentCard({ server }: { server: ServerDto }) {
  const { agent } = server;
  const invalidate = useInvalidateServer(server.id);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [issued, setIssued] = useState<ServerEnrollmentDto | null>(null);
  const rotate = useMutation({
    mutationFn: () => {
      const body: RotateServerEnrollmentRequest = { expectedRevision: server.revision };
      return api.post<ServerEnrollmentDto>(`/servers/${server.id}/agent-enrollment`, body);
    },
    onSuccess: (enrollment) => {
      setConfirmOpen(false);
      setIssued(enrollment);
      invalidate();
    },
    onError: (error) => toast({ title: '签发接入令牌失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const pendingExpiry = agent.enrollmentExpiresAt ? new Date(agent.enrollmentExpiresAt) : null;

  return (
    <Card data-testid="server-agent">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" />主机 Agent</CardTitle>
          <CardDescription>服务器上的 nyabase-agent 主动连接控制面，Incus 操作与节点指标都经由这条连接。</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)} data-testid="server-agent-enrollment">
          重新签发接入令牌
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <AgentStateBadge agent={agent} />
          <Badge variant="outline">{agent.enrolled ? '已登记凭据' : '尚未登记'}</Badge>
          {agent.ipv6Guard && (
            <Badge variant={agent.ipv6Guard.present ? 'outline' : 'destructive'} data-testid="server-agent-ipv6-guard">
              {agent.ipv6Guard.present ? 'IPv6 拦截已就绪' : 'IPv6 拦截缺失'}
            </Badge>
          )}
          {agent.enrolled && <AgentFirewallBadge firewall={agent.firewall} />}
        </div>
        {agent.ipv6Guard && !agent.ipv6Guard.present && (
          <p className="break-all text-xs text-destructive">
            主机上的 nft 表 nyabase_guard 不在位{agent.ipv6Guard.error ? `（${agent.ipv6Guard.error}）` : ''}：
            Agent 在它恢复前拒绝启动容器或给运行中的容器接入网卡，恢复后自动重试。
          </p>
        )}
        {agent.firewall?.state === 'failed' && (
          <p className="break-all text-xs text-destructive" data-testid="server-agent-firewall-error">
            出站防火墙规则同步失败{agent.firewall.error ? `（${agent.firewall.error}）` : ''}：
            同步完成前 Agent 拒绝启动容器或给运行中的容器接入网卡，控制面会自动重试。
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Agent 版本" value={agent.version ?? '—'} />
          <Field
            label="主机名"
            value={agent.hostname ? <TechnicalId label="主机名" value={agent.hostname} kind="text" /> : '—'}
          />
          <Field
            label="本次连接时间"
            value={agent.connectedAt ? new Date(agent.connectedAt).toLocaleString('zh-CN') : '—'}
            title={agent.connectedAt ? relativeTime(agent.connectedAt) : undefined}
          />
          <Field label="Incus 版本" value={server.incusVersion ?? '尚未上报'} />
          <Field
            label="待使用的接入令牌"
            value={pendingExpiry
              ? `${pendingExpiry.getTime() < Date.now() ? '已过期' : '有效至'} ${pendingExpiry.toLocaleString('zh-CN')}`
              : '无'}
          />
        </div>
        {server.lastError && <p className="break-all text-xs text-destructive">{server.lastError}</p>}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="重新签发接入令牌？"
        description={(
          <div className="space-y-2">
            <p>将生成新的一次性接入令牌，之前未使用的令牌立即作废。</p>
            <p>当前正在运行的 Agent 不会断开；只有新的 Agent 用这枚令牌接入后，才会替换旧凭据。</p>
          </div>
        )}
        confirmLabel="签发"
        pendingLabel="签发中..."
        confirmVariant="default"
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
      {issued ? (
        <Dialog open onOpenChange={(next) => { if (!next) setIssued(null); }}>
          <DialogContent className="sm:max-w-2xl" onInteractOutside={(event) => event.preventDefault()}>
            <DialogHeader>
              <DialogTitle>新的接入令牌</DialogTitle>
              <DialogDescription>请立即复制；关闭此窗口后无法再次查看。</DialogDescription>
            </DialogHeader>
            <EnrollmentInstructions enrollment={issued} />
            <DialogFooter>
              <Button onClick={() => setIssued(null)}>我已保存，关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
