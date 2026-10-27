import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, ShieldBan } from 'lucide-react';
import type { FirewallRuleDto, FirewallServerStatusDto, ServerDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { EmptyState } from '../layout/empty-state.js';
import { QueryView } from '../layout/query-view.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import {
  defaultFirewallPriority,
  firewallErrorMessage,
  hasPendingFirewallSync,
} from '../../lib/firewall-rules.js';
import { FirewallRulesTable } from './firewall-table.js';
import { FirewallRuleDialog } from './firewall-rule-dialog.js';

/** While some server is still catching up, check again this often. */
export const FIREWALL_PENDING_POLL_MS = 3_000;

function useFirewallQueries() {
  const rulesQuery = useQuery({
    queryKey: queryKeys.firewall.rules,
    queryFn: () => api.get<FirewallRuleDto[]>('/admin/firewall-rules'),
  });
  const statusQuery = useQuery({
    queryKey: queryKeys.firewall.status,
    queryFn: () => api.get<FirewallServerStatusDto[]>('/admin/firewall-rules/status'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: hasPendingFirewallSync(query.state.data) ? FIREWALL_PENDING_POLL_MS : false,
    }),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
  });
  return { rulesQuery, statusQuery, serversQuery };
}

/** The 网络 page's 防火墙 tab: the guest egress rules, in the order they match. */
export function FirewallTab() {
  const queryClient = useQueryClient();
  const { rulesQuery, statusQuery, serversQuery } = useFirewallQueries();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<FirewallRuleDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FirewallRuleDto | null>(null);

  const rules = useMemo(
    () => [...(rulesQuery.data ?? [])].sort((left, right) => left.priority - right.priority),
    [rulesQuery.data],
  );
  const statusById = useMemo(
    () => new Map((statusQuery.data ?? []).map((status) => [status.serverId, status])),
    [statusQuery.data],
  );
  const serverNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const status of statusQuery.data ?? []) map.set(status.serverId, status.serverName);
    for (const server of serversQuery.data ?? []) map.set(server.id, server.name);
    return map;
  }, [statusQuery.data, serversQuery.data]);
  const serverName = (id: string) => serverNames.get(id);

  const deleteRule = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/firewall-rules/${id}`),
    onSuccess: () => {
      toast({ title: '防火墙规则已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.firewall.all });
    },
    onError: (error) => {
      toast({ title: '删除失败', description: firewallErrorMessage(error, serverName), variant: 'destructive' });
    },
  });
  const openCreate = () => {
    setEditTarget(null);
    setEditorOpen(true);
  };
  const openEdit = (rule: FirewallRuleDto) => {
    setEditTarget(rule);
    setEditorOpen(true);
  };
  const createButton = <Button onClick={openCreate}><Plus className="h-4 w-4" />创建规则</Button>;

  return (
    <div className="space-y-4" data-testid="firewall-rules">
      <div className="flex justify-end">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新防火墙规则"
            onClick={() => {
              void rulesQuery.refetch();
              void statusQuery.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {createButton}
        </div>
      </div>
      <QueryView
        query={rulesQuery}
        resourceName="防火墙规则"
        loadingLabel="加载防火墙规则..."
        showEmpty={rules.length === 0}
        empty={
          <EmptyState
            icon={ShieldBan}
            title="暂无防火墙规则"
            action={createButton}
          />
        }
      >
        {() => (
          <FirewallRulesTable
            rules={rules}
            statusById={statusById}
            serverName={serverName}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            deleting={deleteRule.isPending}
          />
        )}
      </QueryView>
      <FirewallRuleDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        rule={editTarget}
        defaultPriority={defaultFirewallPriority(rules)}
        servers={serversQuery.data ?? []}
        serverName={serverName}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除防火墙规则？"
        description={`将删除「${deleteTarget?.name}」。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deleteRule.isPending}
        testId="firewall-rule-delete-confirm"
        onConfirm={() => { if (deleteTarget) deleteRule.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </div>
  );
}
