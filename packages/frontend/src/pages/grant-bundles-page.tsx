import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { GrantBundleDto, UserServerDto } from '@nyabase/common';
import { Button } from '../components/ui/button.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { ResourceRef } from '../components/refs/resource-ref.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import { serverName, useGrantBundles, useGrantServers } from '../components/grants/use-grant-panel-data.js';
import { GRANT_BUNDLE_FIELDS, GRANT_FIELD_LABELS, formatQuotaValue } from '../lib/grant-bundle-form.js';
import { BundleCreateDialog, BundleEditDialog } from './grant-bundles-page/bundle-form-dialogs.js';
import { BundleDeleteFlow } from './grant-bundles-page/bundle-delete-flow.js';

/** Bundles grouped by their server, servers by name. */
function groupByServer(bundles: GrantBundleDto[], servers: UserServerDto[]): Array<[string, GrantBundleDto[]]> {
  const byServer = new Map<string, GrantBundleDto[]>();
  for (const bundle of bundles) byServer.set(bundle.serverId, [...(byServer.get(bundle.serverId) ?? []), bundle]);
  return [...byServer.entries()]
    .sort(([a], [b]) => serverName(a, servers).localeCompare(serverName(b, servers), 'zh-CN'))
    .map(([serverId, rows]) => [serverId, rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))]);
}

/** 授权模板: named server quotas per server that users are given on their grant page. */
export default function GrantBundlesPage() {
  const bundlesQuery = useGrantBundles();
  const servers = useGrantServers().data ?? [];
  const [creating, setCreating] = useState<{ serverId: string } | null>(null);
  const [editing, setEditing] = useState<GrantBundleDto | null>(null);
  const [deleting, setDeleting] = useState<GrantBundleDto | null>(null);
  const count = bundlesQuery.data?.length ?? 0;
  const createButton = (
    <Button onClick={() => setCreating({ serverId: '' })} data-testid="grant-bundle-create">
      <Plus className="h-4 w-4" />新建模板
    </Button>
  );
  return (
    <Page testId="grant-bundles">
      <PageHeader
        title="授权模板"
        description={count > 0 ? `${count} 个模板 · 修改模板会立即作用于所有跟随它的用户` : undefined}
        actions={createButton}
      />
      <QueryView
        query={bundlesQuery}
        resourceName="授权模板"
        loadingLabel="加载授权模板..."
        showEmpty={count === 0}
        empty={<EmptyState title="暂无授权模板。" description="模板是一台服务器上的一组额度，在用户的授权页分配。" action={createButton} />}
      >
        {(bundles) => (
          <div className="space-y-6">
            {groupByServer(bundles, servers).map(([serverId, rows]) => (
              <SectionCard
                key={serverId}
                title={<ResourceRef kind="server" id={serverId} name={serverName(serverId, servers)} />}
                actions={(
                  <Button size="sm" variant="outline" onClick={() => setCreating({ serverId })}>
                    <Plus className="h-4 w-4" />新建
                  </Button>
                )}
                flush
                testId={`grant-bundles-${serverId}`}
              >
                <Table className="min-w-[760px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      {GRANT_BUNDLE_FIELDS.map((field) => <TableHead key={field}>{GRANT_FIELD_LABELS[field]}</TableHead>)}
                      <TableHead>用户</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((bundle) => (
                      <TableRow key={bundle.id}>
                        <TableCell className="font-medium">{bundle.name}</TableCell>
                        {GRANT_BUNDLE_FIELDS.map((field) => (
                          <TableCell key={field} className="tabular-nums">
                            {formatQuotaValue(field, bundle[field], servers.find((server) => server.id === serverId) ?? {})}
                          </TableCell>
                        ))}
                        <TableCell className="tabular-nums">{bundle.grantCount}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => setEditing(bundle)}>编辑</Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleting(bundle)}>删除</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </SectionCard>
            ))}
          </div>
        )}
      </QueryView>
      {creating ? <BundleCreateDialog defaultServerId={creating.serverId} onClose={() => setCreating(null)} /> : null}
      {editing ? <BundleEditDialog bundle={editing} onClose={() => setEditing(null)} /> : null}
      <BundleDeleteFlow bundle={deleting} onClose={() => setDeleting(null)} />
    </Page>
  );
}
