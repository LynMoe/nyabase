import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Gauge, Pencil, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Capability, type GroupDto, type GroupMemberDto, type UpdateGroupRequest } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { CanonicalGrantPanel } from '../components/grants/canonical-grant-panel.js';
import { useAuthStore } from '../store/auth.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import { capabilityLabel } from '../lib/display-labels.js';
import { relativeTime } from '../lib/utils.js';
import { type GroupDetailTab } from '../lib/group-detail.js';
import {
  buildMinimalGroupEditPayload,
  type GroupEditFormState,
} from '../lib/group-edit-form.js';

type CatalogUser = {
  id: string;
  username: string;
  displayName: string;
  status: string;
};

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
  const queryClient = useQueryClient();
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

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
  };

  const addMember = useMutation({
    mutationFn: (userId: string) => api.post<{ changed: boolean }>(`/admin/groups/${id}/members`, { userId }),
    onSuccess: () => {
      toast({ title: '已添加成员' });
      setAddMemberOpen(false);
      invalidate();
    },
    onError: (error) => toast({
      title: '添加成员失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/admin/groups/${id}/members/${userId}`),
    onSuccess: () => {
      toast({ title: '已移除成员' });
      setRemoveMember(null);
      invalidate();
    },
    onError: (error) => toast({
      title: '移除成员失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });
  const removeGroup = useMutation({
    mutationFn: () => api.delete<unknown>(`/admin/groups/${id}`),
    onSuccess: () => {
      toast({ title: '用户组已删除' });
      setDeleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      void navigate({ to: '/groups' });
    },
    onError: (error) => toast({ title: '删除用户组失败', description: errorMessage(error), variant: 'destructive' }),
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
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-4 w-4" />删除用户组
            </Button>
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
                  ? <GroupIdentityCard key={`${viewed.id}:${viewed.revision}`} group={viewed} onSaved={invalidate} />
                  : <GroupIdentityReadOnly group={viewed} />}
              </TabsContent>
              <TabsContent value="members" className="mt-4 space-y-6">
                <SectionCard
                  title="成员"
                  description={
                    canManageGroups
                      ? undefined
                      : '成员列表只读；需要「管理用户组」权限才能增删成员。'
                  }
                  actions={canManageGroups ? (
                    <Button size="sm" onClick={() => setAddMemberOpen(true)} data-testid="group-add-member-open">
                      <Plus className="h-4 w-4" />添加成员
                    </Button>
                  ) : undefined}
                  flush={members.length > 0}
                  testId="group-members"
                >
                  {members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无成员。</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>用户</TableHead>
                          <TableHead>用户名</TableHead>
                          {canManageGroups ? <TableHead className="text-right">操作</TableHead> : null}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {members.map((member) => (
                          <TableRow key={member.userId}>
                            <TableCell className="whitespace-normal">
                              <Link
                                to="/users/$id"
                                params={{ id: member.userId }}
                                search={{ tab: 'overview' }}
                                className="font-medium"
                              >
                                {member.displayName}
                              </Link>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              @{member.username}
                            </TableCell>
                            {canManageGroups ? (
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setRemoveMember({
                                    userId: member.userId,
                                    label: `${member.displayName} (@${member.username})`,
                                  })}
                                >
                                  移除
                                </Button>
                              </TableCell>
                            ) : null}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </SectionCard>
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
          pending={addMember.isPending}
          onSubmit={(userId) => addMember.mutate(userId)}
          onOpenChange={(open) => { if (!open) setAddMemberOpen(false); }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(removeMember)}
        title="移除成员？"
        description={`将把「${removeMember?.label}」移出本组。该用户将立即失去本组带来的授权（若仍有其他授权则不受影响）。`}
        confirmLabel="确认移除"
        pendingLabel="移除中..."
        pending={removeMemberMutation.isPending}
        onConfirm={() => {
          if (removeMember) removeMemberMutation.mutate(removeMember.userId);
        }}
        onOpenChange={(open) => { if (!open) setRemoveMember(null); }}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除用户组？"
        description="系统组不可删除。删除后成员关系与资源授权会一并清理，且不可恢复。"
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={removeGroup.isPending}
        onConfirm={() => removeGroup.mutate()}
        onOpenChange={setDeleteOpen}
      />
    </Page>
  );
}

function AddGroupMemberDialog({
  candidates,
  usersQuery,
  pending,
  onSubmit,
  onOpenChange,
}: {
  candidates: CatalogUser[];
  usersQuery: { isLoading: boolean; isError: boolean; refetch: () => void };
  pending: boolean;
  onSubmit: (userId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [memberUserId, setMemberUserId] = useState('');
  const canChoose = !usersQuery.isLoading && !usersQuery.isError && candidates.length > 0;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
        </DialogHeader>
        {usersQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">加载用户…</p>
        ) : usersQuery.isError ? (
          <p className="text-sm text-destructive">
            无法加载可选用户列表。
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => { usersQuery.refetch(); }}
            >
              重试
            </button>
          </p>
        ) : canChoose ? (
          <FormField id="group-add-member" label="用户">
            <Select
              key={memberUserId || 'empty'}
              value={memberUserId || undefined}
              onValueChange={setMemberUserId}
              disabled={pending}
            >
              <SelectTrigger id="group-add-member">
                <SelectValue placeholder="选择用户" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.displayName} (@{user.username})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        ) : (
          <p className="text-sm text-muted-foreground">没有可添加的用户。</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{canChoose ? '取消' : '关闭'}</Button>
          {canChoose ? (
            <Button
              onClick={() => onSubmit(memberUserId)}
              disabled={!memberUserId || pending}
            >
              {pending ? '添加中...' : '添加'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupIdentityReadOnly({ group }: { group: GroupDto }) {
  return (
    <>
      <SectionCard title="身份">
        <GroupIdentityFields group={group} />
      </SectionCard>
      <CapabilitiesCard group={group} />
    </>
  );
}

function GroupIdentityCard({ group, onSaved }: { group: GroupDto; onSaved: () => void }) {
  const [identityOpen, setIdentityOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [description, setDescription] = useState(group.description ?? '');
  const [capabilities, setCapabilities] = useState<Capability[]>([...group.capabilities]);
  const [confirmRemoval, setConfirmRemoval] = useState<Capability[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: UpdateGroupRequest & { expectedRevision: number }) =>
      api.patch<GroupDto>(`/admin/groups/${group.id}`, body),
    onSuccess: () => {
      toast({ title: '用户组已更新' });
      setConfirmRemoval(null);
      setError(null);
      setIdentityOpen(false);
      setCapabilitiesOpen(false);
      onSaved();
    },
    onError: (mutationError) => {
      const message = errorMessage(mutationError);
      setError(message);
      toast({ title: '更新用户组失败', description: message, variant: 'destructive' });
    },
  });

  const submit = (skipConfirm = false) => {
    setError(null);
    const form: GroupEditFormState = {
      name: group.name,
      description,
      priority: String(group.priority),
      capabilities,
    };
    const dirty = new Set<(keyof GroupEditFormState)>();
    if (description !== (group.description ?? '')) dirty.add('description');
    if (!group.isSystem && capabilitiesChanged(group.capabilities, capabilities)) dirty.add('capabilities');
    if (dirty.size === 0) {
      toast({ title: '没有需要保存的更改' });
      return;
    }
    const removed = group.isSystem
      ? []
      : group.capabilities.filter((capability) => !capabilities.includes(capability));
    if (!skipConfirm && removed.length > 0) {
      setConfirmRemoval(removed);
      return;
    }
    const payload = buildMinimalGroupEditPayload(form, dirty, {
      isSystem: group.isSystem,
      canEditMetadata: true,
      canEditPriority: false,
    });
    if (!payload.success) {
      setError(payload.error);
      toast({ title: '无法保存', description: payload.error, variant: 'destructive' });
      return;
    }
    save.mutate({ expectedRevision: group.revision, ...payload.data });
  };

  const toggleCapability = (capability: Capability, checked: boolean) => {
    setCapabilities((current) => (
      checked
        ? (current.includes(capability) ? current : [...current, capability])
        : current.filter((item) => item !== capability)
    ));
  };

  return (
    <>
      <SectionCard
        title="身份"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDescription(group.description ?? '');
              setCapabilities([...group.capabilities]);
              setError(null);
              setIdentityOpen(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />编辑
          </Button>
        }
      >
        <GroupIdentityFields group={group} />
      </SectionCard>
      <SectionCard
        title="能力"
        description={group.isSystem ? '内置用户组的能力不可修改。' : '移除能力会立即影响该组成员。'}
        actions={
          !group.isSystem ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDescription(group.description ?? '');
                setCapabilities([...group.capabilities]);
                setError(null);
                setCapabilitiesOpen(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />编辑
            </Button>
          ) : undefined
        }
      >
        <CapabilityBadges capabilities={group.capabilities} />
      </SectionCard>
      {identityOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open) setIdentityOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑用户组</DialogTitle>
            </DialogHeader>
            <FormField id="group-description" label="描述">
              <Input
                id="group-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </FormField>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setIdentityOpen(false)} disabled={save.isPending}>取消</Button>
              <Button onClick={() => submit()} disabled={save.isPending}>
                {save.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {capabilitiesOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open) setCapabilitiesOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑能力</DialogTitle>
              <DialogDescription>移除能力会立即影响该组成员。</DialogDescription>
            </DialogHeader>
            <fieldset className="space-y-2">
              <legend className="sr-only">能力</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.values(Capability).map((capability) => (
                  <label key={capability} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`group-capability-${capability}`}
                      checked={capabilities.includes(capability)}
                      onCheckedChange={(checked) => toggleCapability(capability, checked === true)}
                    />
                    <span>{capabilityLabel(capability)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setCapabilitiesOpen(false)} disabled={save.isPending}>取消</Button>
              <Button onClick={() => submit()} disabled={save.isPending}>
                {save.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={Boolean(confirmRemoval)}
        title="移除用户组能力？"
        description={`将移除：${(confirmRemoval ?? []).map((capability) => capabilityLabel(capability)).join('、')}。该组成员会立即失去这些能力。`}
        confirmLabel="确认移除并保存"
        pendingLabel="保存中..."
        pending={save.isPending}
        onConfirm={() => submit(true)}
        onOpenChange={(open) => { if (!open) setConfirmRemoval(null); }}
      />
    </>
  );
}

function GroupIdentityFields({ group }: { group: GroupDto }) {
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <Info label="名称" value={group.name} />
      <Info label="类型" value={group.isSystem ? '系统组' : '自定义组'} />
      <Info label="优先级" value={String(group.priority)} />
      <Info label="成员" value={`${group.memberCount ?? group.members?.length ?? 0} 人`} />
      <Info label="创建时间" value={relativeTime(group.createdAt)} />
      <Info label="最近更新" value={relativeTime(group.updatedAt)} />
      <div className="sm:col-span-2">
        <Info label="描述" value={group.description ?? '无描述'} />
      </div>
    </div>
  );
}

function CapabilitiesCard({ group }: { group: GroupDto }) {
  return (
    <SectionCard
      title="能力"
      description={group.isSystem ? '内置用户组的能力不可修改。' : '移除能力会立即影响该组成员。'}
    >
      <CapabilityBadges capabilities={group.capabilities} />
    </SectionCard>
  );
}

function CapabilityBadges({ capabilities }: { capabilities: readonly Capability[] }) {
  if (capabilities.length === 0) {
    return <p className="text-sm text-muted-foreground">无。</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {capabilities.map((capability) => (
        <Badge key={capability} variant="outline">{capabilityLabel(capability)}</Badge>
      ))}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-all">{value}</p>
    </div>
  );
}

function capabilitiesChanged(left: readonly Capability[], right: readonly Capability[]): boolean {
  if (left.length !== right.length) return true;
  const rightSet = new Set(right);
  return left.some((capability) => !rightSet.has(capability));
}
