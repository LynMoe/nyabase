import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Capability, type GroupDto, type GroupMemberDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page-header.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { MoreActions } from '../components/layout/more-actions.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { CanonicalGrantPanel } from '../components/grants/canonical-grant-panel.js';
import { useAuthStore } from '../store/auth.js';
import { queryKeys } from '../lib/query-keys.js';
import { type GroupDetailTab } from '../lib/detail-tabs.js';
import { GroupIdentityCard, GroupIdentityReadOnly } from './group-detail-page/group-identity.js';
import {
  AddGroupMemberDialog,
  GroupMembersTab,
  type CatalogUser,
} from './group-detail-page/members-tab.js';
import { useGroupActions } from './group-detail-page/use-group-actions.js';

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
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageGrants = capabilities.includes(Capability.ManageGrants);
  const canManageGroups = capabilities.includes(Capability.ManageGroups);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [removeMember, setRemoveMember] = useState<{ userId: string; label: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selectTab = (next: GroupDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const groupQuery = useQuery({
    queryKey: queryKeys.groups.detail(id),
    queryFn: () => api.get<GroupDto>(`/admin/groups/${id}`),
  });
  const usersQuery = useQuery({
    queryKey: queryKeys.catalog.users,
    queryFn: () => api.get<CatalogUser[]>('/admin/catalog/users'),
    enabled: canManageGroups && (tab === 'members' || addMemberOpen),
  });
  const membersQuery = useQuery({
    queryKey: [...queryKeys.groups.detail(id), 'members'] as const,
    queryFn: () => api.get<GroupMemberDto[]>(`/admin/groups/${id}/members`),
    enabled: canManageGroups,
  });
  const actions = useGroupActions({
    id,
    onMemberAdded: () => setAddMemberOpen(false),
    onMemberRemoved: () => setRemoveMember(null),
    onGroupDeleted: () => setDeleteOpen(false),
  });

  const memberIds = useMemo(
    () => new Set((membersQuery.data ?? groupQuery.data?.members ?? []).map((member) => member.userId)),
    [membersQuery.data, groupQuery.data?.members],
  );
  const candidateUsers = (usersQuery.data ?? []).filter((user) => !memberIds.has(user.id));
  const group = groupQuery.data;

  return (
    <Page testId="group-detail">
      <PageHeader
        title={group?.name ?? '用户组'}
        description={
          group
            ? `${group.isSystem ? '系统组' : '自定义组'} · ${membersQuery.data?.length ?? group.memberCount ?? group.members?.length ?? 0} 名成员`
            : undefined
        }
        crumbs={[
          { label: '用户组', to: '/groups' },
          { label: group?.name ?? '…' },
        ]}
        actions={
          canManageGroups && group && !group.isSystem ? (
            <MoreActions actions={[{ label: '删除用户组', icon: Trash2, destructive: true, onSelect: () => setDeleteOpen(true) }]} />
          ) : undefined
        }
      />
      <QueryView
        query={groupQuery}
        resourceName="用户组"
        loadingLabel="加载用户组..."
        onBack={() => window.history.back()}
      >
        {(loaded) => {
          const members = membersQuery.data ?? loaded.members ?? [];
          const viewed = {
            ...loaded,
            members,
            memberCount: membersQuery.data?.length ?? loaded.memberCount ?? loaded.members?.length ?? 0,
          };
          return (
            <Tabs
              value={tab}
              onValueChange={(value) => selectTab(value as GroupDetailTab)}
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
                {canManageGroups
                  ? <GroupIdentityCard key={`${viewed.id}:${viewed.revision}`} group={viewed} onSaved={actions.invalidate} />
                  : <GroupIdentityReadOnly group={viewed} />}
              </TabsContent>
              <TabsContent value="members" className="mt-4 space-y-6">
                <GroupMembersTab
                  members={members}
                  canManage={canManageGroups}
                  onAdd={() => setAddMemberOpen(true)}
                  onRemove={setRemoveMember}
                />
              </TabsContent>
              <TabsContent value="grants" className="mt-4 space-y-6">
                {canManageGrants ? (
                  <CanonicalGrantPanel subject={viewed} kind="groups" />
                ) : (
                  <p className="text-sm text-muted-foreground">查看与编辑授权需要「管理授权」权限。</p>
                )}
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>
      {addMemberOpen ? (
        <AddGroupMemberDialog
          candidates={candidateUsers}
          usersQuery={{
            isLoading: usersQuery.isLoading,
            isError: usersQuery.isError,
            refetch: () => { void usersQuery.refetch(); },
          }}
          pending={actions.addMember.isPending}
          onSubmit={(userId) => actions.addMember.mutate(userId)}
          onOpenChange={(open) => { if (!open) setAddMemberOpen(false); }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(removeMember)}
        title="移除成员？"
        description={`将把「${removeMember?.label}」移出本组。该用户将立即失去本组带来的授权（若仍有其他授权则不受影响）。`}
        confirmLabel="确认移除"
        pendingLabel="移除中..."
        pending={actions.removeMember.isPending}
        onConfirm={() => {
          if (removeMember) actions.removeMember.mutate(removeMember.userId);
        }}
        onOpenChange={(open) => { if (!open) setRemoveMember(null); }}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除用户组？"
        description="系统组不可删除。删除后成员关系与资源授权会一并清理，且不可恢复。"
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={actions.removeGroup.isPending}
        onConfirm={() => actions.removeGroup.mutate()}
        onOpenChange={setDeleteOpen}
      />
    </Page>
  );
}
