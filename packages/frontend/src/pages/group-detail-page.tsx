import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Capability, type GroupDto, type UpdateGroupRequest } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ResourceGrid } from '../components/layout/resource-grid.js';
import { CanonicalGrantPanel } from '../components/grants/canonical-grant-panel.js';
import { useAuthStore } from '../store/auth.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import { capabilityLabel } from '../lib/display-labels.js';
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

export default function GroupDetailPage() {
  const { id } = routeApi.useParams();
  const queryClient = useQueryClient();
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageGrants = capabilities.includes(Capability.ManageGrants);
  const canManageGroups = capabilities.includes(Capability.ManageGroups);
  const [memberUserId, setMemberUserId] = useState('');
  const [removeMember, setRemoveMember] = useState<{ userId: string; label: string } | null>(null);

  const groupQuery = useQuery({ queryKey: queryKeys.groups.detail(id), queryFn: () => api.get<GroupDto>(`/admin/groups/${id}`) });
  const usersQuery = useQuery({
    queryKey: queryKeys.catalog.users,
    queryFn: () => api.get<CatalogUser[]>('/admin/catalog/users'),
    enabled: canManageGroups,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
  };

  const addMember = useMutation({
    mutationFn: (userId: string) => api.post<{ changed: boolean }>(`/admin/groups/${id}/members`, { userId }),
    onSuccess: () => {
      toast({ title: '已添加成员' });
      setMemberUserId('');
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

  const memberIds = useMemo(
    () => new Set((groupQuery.data?.members ?? []).map((member) => member.userId)),
    [groupQuery.data?.members],
  );
  const candidateUsers = (usersQuery.data ?? []).filter((user) => !memberIds.has(user.id));

  return (
    <Page>
      <PageHeader
        title={groupQuery.data?.name ?? '用户组'}
        description={
          groupQuery.data
            ? `${groupQuery.data.description ?? '无描述'} · ${groupQuery.data.memberCount ?? groupQuery.data.members?.length ?? 0} 名成员`
            : undefined
        }
        crumbs={[
          { label: '用户组', to: '/groups' },
          { label: groupQuery.data?.name ?? '…' },
        ]}
      />
      <QueryView
        query={groupQuery}
        resourceName="用户组"
        loadingLabel="加载用户组..."
        onBack={() => window.history.back()}
      >
        {(group) => (
          <>
            {canManageGrants && <CanonicalGrantPanel subject={group} kind="groups" />}

            <ResourceGrid>
            {canManageGroups && <GroupEditCard key={`${group.id}:${group.revision}`} group={group} onSaved={invalidate} />}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">成员</CardTitle>
                <CardDescription>
                  {canManageGroups
                    ? '添加或移除成员后，其有效授权会按组成员身份立即变化。'
                    : '成员列表只读；需要「管理用户组」权限才能增删成员。'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {canManageGroups && (
                  <div className="space-y-2">
                    {usersQuery.isError && (
                      <p className="text-sm text-destructive">
                        无法加载可选用户列表。
                        <button
                          type="button"
                          className="ml-2 underline"
                          onClick={() => { void usersQuery.refetch(); }}
                        >
                          重试
                        </button>
                      </p>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1">
                        <FormField id="group-add-member" label="添加成员">
                          <Select
                            key={memberUserId || 'empty'}
                            value={memberUserId || undefined}
                            onValueChange={setMemberUserId}
                            disabled={usersQuery.isLoading || usersQuery.isError || addMember.isPending}
                          >
                            <SelectTrigger id="group-add-member">
                              <SelectValue
                                placeholder={
                                  usersQuery.isLoading
                                    ? '加载用户…'
                                    : usersQuery.isError
                                      ? '用户列表不可用'
                                      : candidateUsers.length === 0
                                        ? '没有可添加的用户'
                                        : '选择用户'
                                }
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {candidateUsers.map((user) => (
                                <SelectItem key={user.id} value={user.id}>
                                  {user.displayName} (@{user.username})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormField>
                      </div>
                      <Button
                        onClick={() => addMember.mutate(memberUserId)}
                        disabled={!memberUserId || addMember.isPending || usersQuery.isError}
                      >
                        {addMember.isPending ? '添加中...' : '添加'}
                      </Button>
                    </div>
                  </div>
                )}

                {group.members?.length ? (
                  <div className="divide-y rounded-md border">
                    {group.members.map((member) => (
                      <div key={member.userId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <p>{member.displayName}</p>
                          <p className="font-mono text-xs text-muted-foreground">@{member.username}</p>
                        </div>
                        {canManageGroups && (
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
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {canManageGroups ? '暂无成员。请从上方选择用户添加。' : '暂无成员。'}
                  </p>
                )}
              </CardContent>
            </Card>
            </ResourceGrid>
          </>
        )}
      </QueryView>
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
    </Page>
  );
}

function GroupEditCard({ group, onSaved }: { group: GroupDto; onSaved: () => void }) {
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
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
          <CardDescription>
            {group.isSystem ? '内置用户组仅允许修改描述。' : '可修改描述与能力；移除能力会立即影响该组成员。'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <FormField id="group-description" label="描述">
            <Input
              id="group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
          {!group.isSystem && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">能力</legend>
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
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button onClick={() => submit()} disabled={save.isPending}>
              {save.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </CardContent>
      </Card>
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

function capabilitiesChanged(left: readonly Capability[], right: readonly Capability[]): boolean {
  if (left.length !== right.length) return true;
  const rightSet = new Set(right);
  return left.some((capability) => !rightSet.has(capability));
}

