import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { FirewallRuleDto, FirewallServerStatusDto } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { SectionCard } from '../layout/section-card.js';
import { Hint } from '../ui/hint.js';
import { StatusBadge } from '../layout/status-badge.js';
import {
  firewallActionLabel,
  firewallActionTone,
  firewallProtocolPortsLabel,
  firewallSyncBadge,
} from '../../lib/firewall-rules.js';

const CIDR_PREVIEW = 3;

export function FirewallActionBadge({ action }: { action: FirewallRuleDto['action'] }) {
  return <Badge variant={firewallActionTone(action)}>{firewallActionLabel(action)}</Badge>;
}

/** The first few target ranges; the rest behind 展开 (and in the hover title). */
export function FirewallCidrList({ cidrs }: { cidrs: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = cidrs.length - CIDR_PREVIEW;
  const shown = expanded || hidden <= 0 ? cidrs : cidrs.slice(0, CIDR_PREVIEW);
  return (
    <div className="space-y-0.5 font-mono text-sm" title={cidrs.join('\n')}>
      {shown.map((cidr) => <div key={cidr}>{cidr}</div>)}
      {hidden > 0 && (
        <button
          type="button"
          className="font-sans text-xs text-primary underline-offset-2 hover:underline"
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((current) => !current);
          }}
        >
          {expanded ? '收起' : `另外 ${hidden} 个，共 ${cidrs.length} 个`}
        </button>
      )}
    </div>
  );
}

function SyncBadge({ status }: { status: FirewallServerStatusDto | undefined }) {
  if (!status) return null;
  const badge = firewallSyncBadge(status.state);
  const content = status.state === 'failed'
    ? (status.error ?? '最近一次下发失败')
    : status.state === 'offline' ? '服务器 Agent 未连接；连上后自动同步' : undefined;
  return (
    <Hint content={content}>
      <span tabIndex={content ? 0 : undefined} className="inline-flex" data-testid={`firewall-sync-${status.serverId}`}>
        <StatusBadge label={badge.label} pending={badge.pending} variant={badge.tone} />
      </span>
    </Hint>
  );
}

/** Each associated server with how far its agent has caught up. */
export function FirewallServerList({
  serverIds,
  statusById,
  serverName,
}: {
  serverIds: string[];
  statusById: Map<string, FirewallServerStatusDto>;
  serverName: (id: string) => string | undefined;
}) {
  if (serverIds.length === 0) return <span className="text-sm text-muted-foreground">未关联（不生效）</span>;
  return (
    <div className="flex flex-col gap-1">
      {serverIds.map((id) => (
        <div key={id} className="flex items-center gap-2 text-sm">
          <span className="truncate">{serverName(id) ?? id}</span>
          <SyncBadge status={statusById.get(id)} />
        </div>
      ))}
    </div>
  );
}

/** The rules in match order; a row opens the editor. */
export function FirewallRulesTable({
  rules,
  statusById,
  serverName,
  onEdit,
  onDelete,
  deleting,
}: {
  rules: FirewallRuleDto[];
  statusById: Map<string, FirewallServerStatusDto>;
  serverName: (id: string) => string | undefined;
  onEdit: (rule: FirewallRuleDto) => void;
  onDelete: (rule: FirewallRuleDto) => void;
  deleting: boolean;
}) {
  return (
    <SectionCard flush>
      <Table className="min-w-[960px]">
        <TableHeader>
          <TableRow>
            <TableHead>优先级</TableHead>
            <TableHead>名称</TableHead>
            <TableHead>动作</TableHead>
            <TableHead>协议 / 端口</TableHead>
            <TableHead>目标网段</TableHead>
            <TableHead>关联服务器</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={rule.id} className="cursor-pointer align-top" onClick={() => onEdit(rule)}>
              <TableCell className="font-mono">{rule.priority}</TableCell>
              <TableCell className="max-w-[16rem] whitespace-normal">
                <div className="font-medium">{rule.name}</div>
                {rule.description && <div className="text-xs text-muted-foreground">{rule.description}</div>}
              </TableCell>
              <TableCell><FirewallActionBadge action={rule.action} /></TableCell>
              <TableCell className="font-mono text-sm">{firewallProtocolPortsLabel(rule)}</TableCell>
              <TableCell><FirewallCidrList cidrs={rule.cidrs} /></TableCell>
              <TableCell className="max-w-[16rem] whitespace-normal">
                <FirewallServerList serverIds={rule.serverIds} statusById={statusById} serverName={serverName} />
              </TableCell>
              <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => onEdit(rule)}>
                    <Pencil className="h-3.5 w-3.5" />编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost-destructive"
                    onClick={() => onDelete(rule)}
                    disabled={deleting}
                  >
                    <Trash2 className="h-3.5 w-3.5" />删除
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
