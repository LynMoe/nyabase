import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Capability, type GroupDto, type UpdateGroupRequest } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
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

  const groupQuery = useQuery({ queryKey: ['group', id], queryFn: () => api.get<GroupDto>(`/admin/groups/${id}`) });
  const usersQuery = useQuery({
    queryKey: ['catalog', 'users'],
    queryFn: () => api.get<CatalogUser[]>('/admin/catalog/users'),
    enabled: canManageGroups,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['group', id] });
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
      description: error instanceof Error ? error.message : '请稍后重试',
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
      description: error instanceof Error ? error.message : '请稍后重试',
      variant: 'destructive',
    }),
  });

  const memberIds = useMemo(
    () => new Set((groupQuery.data?.members ?? []).map((member) => member.userId)),
    [groupQuery.data?.members],
  );
  const candidateUsers = (usersQuery.data ?? []).filter((user) => !memberIds.has(user.id));

  if (groupQuery.isLoading) return <QueryLoadingState label="加载用户组..." />;
  if (groupQuery.isError) {
    return (
      <QueryErrorState
        error={groupQuery.error}
        resourceName="用户组"
        onRetry={() => { void groupQuery.refetch(); }}
        onBack={() => window.history.back()}
      />
    );
  }
  const group = groupQuery.data;
  if (!group) return null;

  return (
    <div className="space-y-5 px-4 py-4 md:px-6">
      <div className="flex items-start gap-3">
        <Link to="/groups">
          <Button variant="outline" size="icon" aria-label="返回用户组">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{group.name}</h1>
          <p className="text-sm text-muted-foreground">
            {group.description ?? '无描述'} · {group.memberCount ?? group.members?.length ?? 0} 名成员
          </p>
        </div>
      </div>

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
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="group-add-member">添加成员</Label>
                  <select
                    id="group-add-member"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={memberUserId}
                    onChange={(event) => setMemberUserId(event.target.value)}
                    disabled={usersQuery.isLoading || usersQuery.isError || addMember.isPending}
                  >
                    <option value="">
                      {usersQuery.isLoading
                        ? '加载用户…'
                        : usersQuery.isError
                          ? '用户列表不可用'
                          : candidateUsers.length === 0
                            ? '没有可添加的用户'
                            : '选择用户'}
                    </option>
                    {candidateUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName} (@{user.username})
                      </option>
                    ))}
                  </select>
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

      {canManageGrants && <CanonicalGrantPanel subject={group} kind="groups" />}

      <Dialog open={Boolean(removeMember)} onOpenChange={(open) => { if (!open) setRemoveMember(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除成员？</DialogTitle>
            <DialogDescription>
              将把「{removeMember?.label}」移出本组。该用户将立即失去本组带来的授权（若仍有其他授权则不受影响）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveMember(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={removeMemberMutation.isPending}
              onClick={() => {
                if (removeMember) removeMemberMutation.mutate(removeMember.userId);
              }}
            >
              {removeMemberMutation.isPending ? '移除中...' : '确认移除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
      const message = mutationError instanceof Error ? mutationError.message : '请稍后重试';
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

  const toggleCapability = (capability: Capability) => {
    setCapabilities((current) => (
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability]
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
          <div className="space-y-1.5">
            <Label htmlFor="group-description">描述</Label>
            <Input
              id="group-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {!group.isSystem && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">能力</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.values(Capability).map((capability) => (
                  <label key={capability} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={capabilities.includes(capability)}
                      onChange={() => toggleCapability(capability)}
                    />
                    {capabilityLabel(capability)}
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
      <Dialog open={Boolean(confirmRemoval)} onOpenChange={(open) => { if (!open) setConfirmRemoval(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除用户组能力？</DialogTitle>
            <DialogDescription>
              将移除：{(confirmRemoval ?? []).map((capability) => capabilityLabel(capability)).join('、')}。
              该组成员会立即失去这些能力。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemoval(null)}>取消</Button>
            <Button variant="destructive" disabled={save.isPending} onClick={() => submit(true)}>
              {save.isPending ? '保存中...' : '确认移除并保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function capabilitiesChanged(left: readonly Capability[], right: readonly Capability[]): boolean {
  if (left.length !== right.length) return true;
  const rightSet = new Set(right);
  return left.some((capability) => !rightSet.has(capability));
}

