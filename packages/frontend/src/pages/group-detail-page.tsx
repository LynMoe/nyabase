import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, ShieldCheck, Users } from 'lucide-react';
import { Role, type GroupDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { CanonicalGrantPanel } from '../components/grants/canonical-grant-panel.js';
import { useHasRole } from '../lib/use-role.js';
import { queryKeys } from '../lib/query-keys.js';
import { useGroupMembers } from '../lib/group-queries.js';
import { type GroupDetailTab } from '../lib/detail-tabs.js';
import { DeleteGroupAction, GroupOverviewTab } from './group-detail-page/group-identity.js';
import { GroupMembersTab } from './group-detail-page/members-tab.js';

const routeApi = getRouteApi('/groups/$id');

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['members', '成员', Users],
  ['grants', '授权', ShieldCheck],
] as const;

export default function GroupDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/groups/$id' });
  const canManageGrants = useHasRole(Role.Operator);
  const canManageGroups = useHasRole(Role.Admin);
  const groupQuery = useQuery({
    queryKey: queryKeys.groups.detail(id),
    queryFn: () => api.get<GroupDto>(`/admin/groups/${id}`),
  });
  const membersQuery = useGroupMembers(id, canManageGroups);
  const group = groupQuery.data;

  return (
    <Page testId="group-detail">
      <PageHeader
        title={group?.name ?? '用户组'}
        description={
          group
            ? `${membersQuery.data?.length ?? group.memberCount ?? group.members?.length ?? 0} 名成员`
            : undefined
        }
        crumbs={[
          { label: '用户组', to: '/groups' },
          { label: group?.name ?? '…' },
        ]}
        actions={canManageGroups && group ? <DeleteGroupAction groupId={id} /> : undefined}
      />
      <QueryView
        query={groupQuery}
        resourceName="用户组"
        loadingLabel="加载用户组..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <Tabs
            value={tab}
            onValueChange={(value) => {
              void navigate({ search: (prev) => ({ ...prev, tab: value as GroupDetailTab }) });
            }}
            data-testid="group-detail-tabs"
          >
            <TabsList>
              {TAB_ITEMS.map(([key, label, Icon]) => (
                <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`group-tab-${key}`}>
                  <Icon className="h-4 w-4" />{label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview" className="mt-4 space-y-6">
              <GroupOverviewTab group={loaded} />
            </TabsContent>
            <TabsContent value="members" className="mt-4 space-y-6">
              <GroupMembersTab groupId={id} memberFallback={loaded.members ?? []} />
            </TabsContent>
            <TabsContent value="grants" className="mt-4 space-y-6">
              {canManageGrants ? (
                <CanonicalGrantPanel subject={loaded} kind="groups" />
              ) : (
                <p className="text-sm text-muted-foreground">查看与编辑授权需要运维及以上角色。</p>
              )}
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
    </Page>
  );
}
