import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, bootstrapAuthSession } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Badge } from '../components/ui/badge.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.js';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '../components/ui/alert-dialog.js';
import { toast } from '../hooks/use-toast.js';
import { Plus, Trash2, Settings2, Server, ImageIcon, KeyRound, RefreshCw } from 'lucide-react';
import { Capability, UserStatus, GpuGrantMode, zCreateUserRequest, zUpdateUserRequest } from '@nyabase/common';
import type {
  AdministrationActionsDto,
  UserAdministrationAvailabilityDto,
  UserDto, GroupDto, ServerGrantDto, EffectiveAccessDto, UserInternalSshKeyDto, ImageGrantDto,
} from '@nyabase/common';
import { formatBytes, formatCpu, resourceVal } from '../lib/utils.js';
import {
  ResourceGrantForm, ResourceFormValue, EMPTY_RESOURCE_FORM,
  grantToForm, formToGrantPayload,
} from '../components/resource-grant-form.js';
import { MountSourceGrantsPanel } from '../components/grants/mount-source-grants-panel.js';
import { queryKeys } from '../lib/query-keys.js';
import { useRequesterAgentTaskBatchFeedback } from '../hooks/use-agent-task-tracker.js';
import { useAuthStore } from '../store/auth.js';
import {
  adminCatalogPaths,
  type AdminCatalogUser,
  type GrantImageCatalogItem,
  type GrantServerCatalogItem,
} from '../lib/admin-catalog.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { imageGrantAction } from '../lib/image-grant-action.js';
import {
  clearLocalSession,
  notifyAccessChangedForSubject,
  notifyGroupMembershipChangedForUser,
} from '../lib/auth-session.js';
import { useAdministrationActions } from '../hooks/use-administration-actions.js';
import { addTrackedTaskIds, retireTrackedTaskIds as retireTaskIds } from '../lib/tracked-task-ids.js';
import { groupMemberActionAvailability } from '../lib/group-member-action.js';

type TaskIdsResponse = { taskIds?: string[] };
type DeleteUserResponse = { deleted: boolean; taskIds: string[] };
type UserListItem = AdminCatalogUser & Partial<Pick<UserDto, 'groups' | 'createdAt'>>;

export default function UsersPage() {
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageUsers = capabilities.includes(Capability.ManageUsers);
  const canManageGroups = capabilities.includes(Capability.ManageGroups);
  const canManageGrants = capabilities.includes(Capability.ManageGrants);
  const [showCreate, setShowCreate] = useState(false);
  const [showGrants, setShowGrants] = useState<UserListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserListItem | null>(null);
  const qc = useQueryClient();
  const [trackedTaskIds, setTrackedTaskIds] = useState<string[]>([]);
  const retireTrackedTaskIds = useCallback((settledIds: readonly string[]) => {
    setTrackedTaskIds((current) => retireTaskIds(current, settledIds));
  }, []);
  const taskFeedback = useRequesterAgentTaskBatchFeedback(trackedTaskIds, {
    invalidateQueryKeys: [
      queryKeys.users.admin,
      queryKeys.groups.admin,
      queryKeys.dataDirs.allUser,
    ],
    onSettledTaskIds: retireTrackedTaskIds,
  });
  useEffect(() => {
    if (taskFeedback.allTerminal) {
      void qc.invalidateQueries({ queryKey: queryKeys.users.admin });
    }
  }, [qc, taskFeedback.allTerminal]);
  const trackTaskIds = (taskIds?: string[]) => {
    if (!taskIds?.length) return;
    setTrackedTaskIds((current) => addTrackedTaskIds(current, taskIds));
  };

  const usersQuery = useQuery({
    queryKey: ['users', canManageUsers ? 'admin' : 'catalog'],
    queryFn: () => canManageUsers
      ? api.get<UserDto[]>('/admin/users')
      : api.get<AdminCatalogUser[]>(adminCatalogPaths.users),
  });
  const administrationQuery = useAdministrationActions(canManageUsers || canManageGroups);
  const users: UserListItem[] = usersQuery.data ?? [];
  const { isFetching, refetch } = usersQuery;

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.delete<DeleteUserResponse>(`/admin/users/${id}`),
    onSuccess: (result, deletedUserId) => {
      trackTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: queryKeys.users.admin });
      qc.invalidateQueries({ queryKey: ['admin-catalog', 'administration-actions'] });
      if (deletedUserId === useAuthStore.getState().user?.id) {
        toast({ title: result.deleted ? '当前账号已删除，请重新登录' : '当前账号删除已开始，会话已结束' });
        clearLocalSession();
        window.location.replace('/login?reason=account-changed');
        return;
      }
      toast({
        title: result.deleted ? '用户已删除' : '用户删除已开始',
        description: result.deleted
          ? undefined
          : `正在执行 ${result.taskIds.length} 个磁盘配额归零任务，全部成功后会自动完成删除`,
      });
    },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  if (usersQuery.isLoading || ((canManageUsers || canManageGroups) && administrationQuery.isLoading)) {
    return <QueryLoadingState label="加载用户..." />;
  }
  if (usersQuery.isError) return (
    <QueryErrorState
      error={usersQuery.error}
      resourceName="用户目录"
      onRetry={() => { void usersQuery.refetch(); }}
    />
  );
  if ((canManageUsers || canManageGroups) && administrationQuery.isError) return (
    <QueryErrorState
      error={administrationQuery.error}
      resourceName="用户操作权限"
      onRetry={() => { void administrationQuery.refetch(); }}
    />
  );

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{canManageUsers ? '用户管理' : '用户授权'}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{users.length} 个账号</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          {canManageUsers && (
            <Button
              onClick={() => setShowCreate(true)}
              disabled={!administrationQuery.data?.createUser.allowed}
              title={administrationQuery.data?.createUser.reason ?? undefined}
            >
              <Plus className="h-4 w-4" />添加用户
            </Button>
          )}
        </div>
      </div>

      <div className="bg-background rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">用户名</th>
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">显示名</th>
              {canManageUsers && <th className="text-left py-3 px-4 font-medium text-muted-foreground">用户组</th>}
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">状态</th>
              {canManageUsers && <th className="text-left py-3 px-4 font-medium text-muted-foreground">创建时间</th>}
              <th className="py-3 px-4" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => {
              const administration = administrationQuery.data?.users[u.id];
              return <tr key={u.id} className="hover:bg-accent/50 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-foreground">{u.username}</td>
                <td className="py-3 px-4 text-muted-foreground">{u.displayName}</td>
                {canManageUsers && <td className="py-3 px-4">
                  <div className="flex flex-wrap gap-1">
                    {(u.groups ?? []).map((g) => (
                      <Badge key={g.id} variant={g.isSystem ? 'default' : 'secondary'} className="text-xs">
                        {g.name}
                      </Badge>
                    ))}
                  </div>
                </td>}
                <td className="py-3 px-4">
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium
                    ${u.status === UserStatus.Active ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${u.status === UserStatus.Active ? 'bg-green-500' : 'bg-red-400'}`} />
                    {u.status === UserStatus.Active
                      ? '正常'
                      : u.status === UserStatus.Deleting ? '删除中' : '禁用'}
                  </span>
                </td>
                {canManageUsers && <td className="py-3 px-4 text-muted-foreground text-xs">
                  {u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '—'}
                </td>}
                <td className="py-3 px-4">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="outline"
                      onClick={() => setShowGrants(u)}>
                      <Settings2 className="h-4 w-4" />权限
                    </Button>
                    {canManageUsers && (
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600"
                        disabled={!administration?.canDelete.allowed}
                        title={administration?.canDelete.reason ?? undefined}
                        onClick={() => setDeleteTarget(u)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      {canManageUsers && showCreate && administrationQuery.data?.createUser.allowed && (
        <CreateUserDialog open onOpenChange={setShowCreate} />
      )}
      {showGrants && (
        <UserGrantsDialog
          user={users.find((u) => u.id === showGrants.id) ?? showGrants}
          onClose={() => setShowGrants(null)}
          onTaskIds={trackTaskIds}
          canManageUsers={canManageUsers}
          canManageGroups={canManageGroups}
          canManageGrants={canManageGrants}
          availability={administrationQuery.data?.users[showGrants.id]}
          administrationActions={administrationQuery.data}
        />
      )}

      <AlertDialog
        open={canManageUsers && !!deleteTarget
          && (administrationQuery.data?.users[deleteTarget.id]?.canDelete.allowed ?? false)}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除用户？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销，将永久删除用户{' '}
              <span className="font-semibold text-foreground">{deleteTarget?.username}</span>。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) deleteUser.mutate(deleteTarget.id); }}
              disabled={deleteUser.isPending}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserGrantsDialog
// ---------------------------------------------------------------------------

function UserGrantsDialog({
  user,
  onClose,
  onTaskIds,
  canManageUsers,
  canManageGroups,
  canManageGrants,
  availability,
  administrationActions,
}: {
  user: UserListItem;
  onClose: () => void;
  onTaskIds: (taskIds?: string[]) => void;
  canManageUsers: boolean;
  canManageGroups: boolean;
  canManageGrants: boolean;
  availability?: UserAdministrationAvailabilityDto;
  administrationActions?: AdministrationActionsDto;
}) {
  const canAdministerUser = availability?.canAdminister.allowed ?? false;
  type Tab = 'effective' | 'groups' | 'overrides' | 'image-grants' | 'mount-source-grants' | 'ssh' | 'password';
  const tabs: { key: Tab; label: string; icon?: typeof KeyRound }[] = [
    ...(canManageGrants ? [
      { key: 'effective' as const, label: '有效权限' },
      { key: 'overrides' as const, label: '服务器授权' },
      { key: 'image-grants' as const, label: '镜像授权' },
      { key: 'mount-source-grants' as const, label: '数据源授权' },
    ] : []),
    ...(canManageGroups && user.groups ? [{ key: 'groups' as const, label: '所属用户组' }] : []),
    ...(canManageUsers && canAdministerUser ? [
      { key: 'ssh' as const, label: 'SSH', icon: KeyRound },
      { key: 'password' as const, label: '密码', icon: KeyRound },
    ] : []),
  ];
  const [activeTab, setActiveTab] = useState<Tab>(() => tabs[0]?.key ?? 'effective');
  useEffect(() => {
    if (!tabs.some((tab) => tab.key === activeTab) && tabs[0]) setActiveTab(tabs[0].key);
  }, [activeTab, tabs]);

  const renderTabButton = (tab: { key: typeof activeTab; label: string; icon?: typeof KeyRound }) => (
    <button
      key={tab.key}
      onClick={() => setActiveTab(tab.key)}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
        activeTab === tab.key
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {tab.icon && <tab.icon className="h-3.5 w-3.5" />}
      {tab.label}
    </button>
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {user.displayName}
            <span className="font-mono text-sm text-muted-foreground font-normal">@{user.username}</span>
          </DialogTitle>
        </DialogHeader>

        {canManageUsers && !canAdministerUser && availability?.canAdminister.reason && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            当前账号不能修改此用户的凭据：{availability.canAdminister.reason}
          </p>
        )}

        <div className="flex items-end gap-1 border-b border-border shrink-0">
          {tabs.map(renderTabButton)}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 py-3">
          {canManageGrants && activeTab === 'effective' && <EffectiveTab userId={user.id} />}
          {canManageGroups && activeTab === 'groups' && user.groups && (
            <GroupsTab
              userId={user.id}
              user={user as UserDto}
              administrationActions={administrationActions}
              onTaskIds={onTaskIds}
            />
          )}
          {canManageGrants && activeTab === 'overrides' && <OverridesTab userId={user.id} onTaskIds={onTaskIds} />}
          {canManageGrants && activeTab === 'image-grants' && <UserImageGrantsTab userId={user.id} />}
          {canManageGrants && activeTab === 'mount-source-grants' && (
            <MountSourceGrantsPanel
              subject={{ type: 'user', id: user.id }}
              description="为该用户独立授权可访问的数据源（与用户组授权取并集，仍需同时拥有对应服务器的访问权限）"
            />
          )}
          {canAdministerUser && activeTab === 'ssh' && <InternalSshKeyTab userId={user.id} />}
          {canAdministerUser && activeTab === 'password' && <AdminChangePasswordTab userId={user.id} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Internal SSH Key Tab
// ---------------------------------------------------------------------------

function InternalSshKeyTab({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [includePrivate, setIncludePrivate] = useState(false);
  const keyQuery = useQuery({
    queryKey: ['user-internal-ssh-key', userId, includePrivate],
    queryFn: () => api.get<UserInternalSshKeyDto>(`/admin/users/${userId}/internal-ssh-key${includePrivate ? '?includePrivate=true' : ''}`),
  });
  const rotate = useMutation({
    mutationFn: () => api.post<UserInternalSshKeyDto>(`/admin/users/${userId}/internal-ssh-key/rotate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-internal-ssh-key', userId] });
      toast({ title: '内部 SSH 密钥已轮换' });
    },
    onError: (e) => toast({ title: '轮换失败', description: (e as Error).message, variant: 'destructive' }),
  });

  if (keyQuery.isLoading) return <QueryLoadingState label="加载 SSH 密钥..." />;
  if (keyQuery.isError) return (
    <QueryErrorState
      error={keyQuery.error}
      resourceName="SSH 密钥"
      onRetry={() => { void keyQuery.refetch(); }}
    />
  );
  const key = keyQuery.data;
  if (!key) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg border border-border p-3">
          <div className="text-muted-foreground mb-1">版本</div>
          <div className="font-semibold text-foreground">{key.generation}</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-muted-foreground mb-1">指纹</div>
          <div className="font-mono text-foreground break-all">{key.fingerprint}</div>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">内部公钥</Label>
        <textarea readOnly value={key.publicKey} rows={3} className="w-full rounded-md border bg-muted px-3 py-2 text-xs font-mono" />
      </div>
      {includePrivate && key.privateKey && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">内部私钥</Label>
          <textarea readOnly value={key.privateKey} rows={8} className="w-full rounded-md border bg-muted px-3 py-2 text-xs font-mono" />
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => setIncludePrivate((value) => !value)}>
          {includePrivate ? '隐藏私钥' : '查看私钥'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
          {rotate.isPending ? '轮换中...' : '轮换内部密钥'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Effective Tab
// ---------------------------------------------------------------------------

function EffectiveTab({ userId }: { userId: string }) {
  const accessQuery = useQuery({
    queryKey: ['user-effective-access', userId],
    queryFn: () => api.get<EffectiveAccessDto>(`/admin/users/${userId}/effective-access`),
  });
  const serversQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-servers'],
    queryFn: () => api.get<GrantServerCatalogItem[]>(adminCatalogPaths.grantServers),
  });
  const imagesQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-images'],
    queryFn: () => api.get<GrantImageCatalogItem[]>(adminCatalogPaths.grantImages),
  });

  const effectiveAccess = accessQuery.data;
  const servers = serversQuery.data ?? [];
  const images = imagesQuery.data ?? [];

  const serverMap = new Map(servers.map((s) => [s.id, s]));
  const imageMap = new Map(images.map((img) => [img.id, img]));

  if (accessQuery.isLoading || serversQuery.isLoading || imagesQuery.isLoading) {
    return <QueryLoadingState label="加载有效权限..." />;
  }
  const queryError = accessQuery.error ?? serversQuery.error ?? imagesQuery.error;
  if (queryError) return (
    <QueryErrorState
      error={queryError}
      resourceName="有效权限"
      onRetry={() => { void Promise.all([accessQuery.refetch(), serversQuery.refetch(), imagesQuery.refetch()]); }}
    />
  );

  if (!effectiveAccess?.servers.length) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <Server className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <p className="text-sm text-muted-foreground">该用户尚未被授予任何服务器访问权限</p>
        <p className="text-xs text-muted-foreground/70 mt-1">可在「所属用户组」中加入有服务器授权的用户组，或在「独立授权」中直接添加</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">最终生效的权限（独立授权优先于用户组授权）</p>
      {effectiveAccess.servers.map((access) => {
        const server = serverMap.get(access.serverId);
        const allowedImages = access.allowedImageIds
          .map((id) => imageMap.get(id))
          .filter((image): image is GrantImageCatalogItem => Boolean(image));

        const gpuText = () => {
          switch (access.gpuMode) {
            case GpuGrantMode.None: return <span className="text-muted-foreground">无</span>;
            case GpuGrantMode.All: return <span className="text-green-600 font-medium">全部</span>;
            case GpuGrantMode.Indices: return <span className="text-purple-600 font-medium">[{access.gpuIndices?.join(', ')}]</span>;
            default: return null;
          }
        };

        return (
          <div key={access.serverId} className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 bg-muted/50 border-b border-border">
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                server?.status === 'online' ? 'bg-green-500' :
                server?.status === 'offline' ? 'bg-red-400' : 'bg-muted-foreground/30'
              }`} />
              <span className="font-semibold text-foreground text-sm">
                {server?.name ?? access.serverId.slice(0, 8)}
              </span>
              {access.accessPhase === 'grace' && (
                <span className="text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                  已到期：已强制停机，可再启动以迁移；窗口至{' '}
                  {access.purgeAt ? new Date(access.purgeAt).toLocaleString() : '未知'}
                </span>
              )}
              {access.expiresAt && access.accessPhase === 'full' && (
                <span className="text-xs text-muted-foreground">
                  到期 {new Date(access.expiresAt).toLocaleString()}
                </span>
              )}
            </div>

            <div className="px-4 py-3 space-y-3">
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div className="bg-blue-500/10 dark:bg-blue-500/15 rounded-lg px-2.5 py-2">
                  <div className="text-muted-foreground mb-0.5">CPU</div>
                  <div className="font-semibold text-blue-700">
                    {access.cpuMillis > 0 ? formatCpu(access.cpuMillis) : <span className="text-green-600">不限</span>}
                  </div>
                </div>
                <div className="bg-indigo-500/10 dark:bg-indigo-500/15 rounded-lg px-2.5 py-2">
                  <div className="text-muted-foreground mb-0.5">内存</div>
                  <div className="font-semibold text-indigo-700">
                    {access.memBytes > 0 ? formatBytes(access.memBytes) : <span className="text-green-600">不限</span>}
                  </div>
                </div>
                <div className="bg-amber-500/10 dark:bg-amber-500/15 rounded-lg px-2.5 py-2">
                  <div className="text-muted-foreground mb-0.5">磁盘</div>
                  <div className="font-semibold text-amber-700">
                    {access.diskBytes > 0 ? formatBytes(access.diskBytes) : <span className="text-green-600">不限</span>}
                  </div>
                </div>
                <div className="bg-purple-500/10 dark:bg-purple-500/15 rounded-lg px-2.5 py-2">
                  <div className="text-muted-foreground mb-0.5">GPU</div>
                  <div className="font-semibold">{gpuText()}</div>
                </div>
              </div>

              <div>
                <div className="text-xs text-muted-foreground flex items-center gap-1 mb-1.5">
                  <ImageIcon className="h-3 w-3" />
                  可用镜像 ({allowedImages.length})
                </div>
                {allowedImages.length === 0 ? (
                  <span className="text-xs text-muted-foreground/50 italic">无镜像授权</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {allowedImages.map((img) => (
                      <span key={img.id} className={`text-xs px-2 py-0.5 rounded border ${
                        img.isActive
                          ? 'bg-background border-border text-foreground'
                          : 'bg-muted/50 border-border text-muted-foreground line-through'
                      }`}>
                        {img.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups Tab
// ---------------------------------------------------------------------------

function GroupsTab({
  userId,
  user,
  administrationActions,
  onTaskIds,
}: {
  userId: string;
  user: UserDto;
  administrationActions?: AdministrationActionsDto;
  onTaskIds: (taskIds?: string[]) => void;
}) {
  const qc = useQueryClient();

  const groupsQuery = useQuery({
    queryKey: queryKeys.groups.admin, queryFn: () => api.get<GroupDto[]>('/admin/groups'),
  });
  const allGroups = groupsQuery.data ?? [];

  const addToGroup = useMutation({
    mutationFn: (groupId: string) => api.post<TaskIdsResponse>(`/admin/groups/${groupId}/members`, { userId }),
    onSuccess: (result, groupId) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: queryKeys.users.admin });
      qc.invalidateQueries({ queryKey: ['admin-catalog', 'administration-actions'] });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      notifyGroupMembershipChangedForUser(userId, groupId, true);
      void bootstrapAuthSession();
      toast({ title: '已加入用户组' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const removeFromGroup = useMutation({
    mutationFn: (groupId: string) => api.delete<TaskIdsResponse>(`/admin/groups/${groupId}/members/${userId}`),
    onSuccess: (result, groupId) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: queryKeys.users.admin });
      qc.invalidateQueries({ queryKey: ['admin-catalog', 'administration-actions'] });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      notifyGroupMembershipChangedForUser(userId, groupId, false);
      void bootstrapAuthSession();
      toast({ title: '已移出用户组' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const userGroupIds = new Set(user.groups.map((g) => g.id));

  if (groupsQuery.isLoading) return <QueryLoadingState label="加载所属用户组..." />;
  if (groupsQuery.isError) return (
    <QueryErrorState
      error={groupsQuery.error}
      resourceName="用户组"
      onRetry={() => { void groupsQuery.refetch(); }}
    />
  );

  return (
    <div className="space-y-2">
      {allGroups.map((g) => {
        const isMember = userGroupIds.has(g.id);
        const groupAvailability = administrationActions?.groups[g.id];
        const availability = groupMemberActionAvailability(groupAvailability, userId, isMember);
        return (
          <div key={g.id} className={`flex items-center justify-between py-2.5 px-3 rounded-lg border ${
            isMember ? 'border-primary/30 bg-primary/5' : 'border-border'
          }`}>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{g.name}</span>
                {g.isSystem && <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">系统组</span>}
                <span className="text-xs text-muted-foreground">优先级 {g.priority}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {g.capabilities.length > 0 ? `${g.capabilities.length} 项管理权限` : '无管理权限'}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className={isMember ? 'text-red-600 border-red-200 hover:bg-red-50' : undefined}
              disabled={addToGroup.isPending || removeFromGroup.isPending || !availability?.allowed}
              title={availability?.reason ?? undefined}
              onClick={() => isMember ? removeFromGroup.mutate(g.id) : addToGroup.mutate(g.id)}
            >
              {isMember ? '移出' : '加入'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Direct image grants
// ---------------------------------------------------------------------------

function UserImageGrantsTab({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
  const imagesQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-images'],
    queryFn: () => api.get<GrantImageCatalogItem[]>(adminCatalogPaths.grantImages),
  });
  const serversQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-servers'],
    queryFn: () => api.get<GrantServerCatalogItem[]>(adminCatalogPaths.grantServers),
  });
  const grantsQuery = useQuery({
    queryKey: ['user-image-grants', userId],
    queryFn: () => api.get<ImageGrantDto[]>(`/admin/users/${userId}/image-grants`),
  });
  const images = imagesQuery.data ?? [];
  const servers = serversQuery.data ?? [];
  const grants = grantsQuery.data ?? [];
  const grantedKeys = new Set(grants.map((grant) => `${grant.imageId}:${grant.serverId}`));
  const imageIds = new Set(images.map((image) => image.id));
  const orphanedImageIds = [...new Set(
    grants.filter((grant) => !imageIds.has(grant.imageId)).map((grant) => grant.imageId),
  )];
  const serverMap = new Map(servers.map((server) => [server.id, server.name]));

  const toggle = useMutation({
    mutationFn: ({ imageId, serverId, granted }: { imageId: string; serverId: string; granted: boolean }) => {
      const action = imageGrantAction({ type: 'user', id: userId }, imageId, serverId, granted);
      return action.method === 'DELETE' ? api.delete(action.path) : api.post(action.path, action.body);
    },
    onMutate: ({ imageId, serverId }) => {
      setPendingKeys((current) => new Set(current).add(`${imageId}:${serverId}`));
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['user-image-grants', userId] }),
        qc.invalidateQueries({ queryKey: ['user-effective-access', userId] }),
      ]);
      notifyAccessChangedForSubject({ type: 'user', id: userId });
      toast({ title: '镜像授权已更新' });
    },
    onError: (error) => toast({ title: '镜像授权失败', description: error.message, variant: 'destructive' }),
    onSettled: (_data, _error, { imageId, serverId }) => {
      const key = `${imageId}:${serverId}`;
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
  });

  const removeOrphan = useMutation({
    mutationFn: (imageId: string) => Promise.all(
      grants
        .filter((grant) => grant.imageId === imageId)
        .map((grant) => api.delete(`/admin/users/${userId}/image-grants/${imageId}/${grant.serverId}`)),
    ),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['user-image-grants', userId] }),
        qc.invalidateQueries({ queryKey: ['user-effective-access', userId] }),
      ]);
      notifyAccessChangedForSubject({ type: 'user', id: userId });
      toast({ title: '残留授权已移除' });
    },
    onError: (error) => toast({ title: '移除残留授权失败', description: error.message, variant: 'destructive' }),
  });

  if (imagesQuery.isLoading || serversQuery.isLoading || grantsQuery.isLoading) {
    return <QueryLoadingState label="加载镜像授权..." />;
  }
  const queryError = imagesQuery.error ?? serversQuery.error ?? grantsQuery.error;
  if (queryError) return (
    <QueryErrorState
      error={queryError}
      resourceName="镜像授权"
      onRetry={() => { void Promise.all([imagesQuery.refetch(), serversQuery.refetch(), grantsQuery.refetch()]); }}
    />
  );

  if ((images.length === 0 || servers.length === 0) && orphanedImageIds.length === 0) {
    return <div className="text-sm text-muted-foreground text-center py-8">暂无可授权的镜像或服务器</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">直接镜像授权与用户组镜像授权取并集，并按服务器生效。</p>
      {(images.length === 0 || servers.length === 0) && (
        <div className="text-sm text-muted-foreground text-center py-4">暂无新的可授权镜像或服务器</div>
      )}
      {images.map((image) => (
        <div key={image.id} className="rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{image.name}</span>
            {!image.isActive && <Badge variant="outline" className="text-xs">已停用</Badge>}
          </div>
          <div className="flex flex-wrap gap-2">
            {servers.map((server) => {
              const key = `${image.id}:${server.id}`;
              const granted = grantedKeys.has(key);
              const pending = pendingKeys.has(key);
              return (
                <button
                  key={server.id}
                  disabled={pending}
                  onClick={() => toggle.mutate({ imageId: image.id, serverId: server.id, granted })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    granted
                      ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                      : 'bg-muted border-border text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {pending ? '处理中...' : server.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {orphanedImageIds.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-red-100">
          <p className="text-xs text-red-500">以下镜像已停用或删除，存在残留授权：</p>
          {orphanedImageIds.map((imageId) => {
            const grantedServers = grants
              .filter((grant) => grant.imageId === imageId)
              .map((grant) => serverMap.get(grant.serverId) ?? grant.serverId);
            return (
              <div key={imageId} className="flex items-center justify-between bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                <div>
                  <span className="text-sm font-mono text-red-700">[不可用] {imageId.slice(0, 8)}…</span>
                  <div className="text-xs text-red-400 mt-0.5">{grantedServers.join('、')}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-500 hover:text-red-700 hover:bg-red-100"
                  disabled={removeOrphan.isPending}
                  onClick={() => removeOrphan.mutate(imageId)}
                >
                  <Trash2 className="h-4 w-4" />移除
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overrides Tab
// ---------------------------------------------------------------------------

function OverridesTab({
  userId,
  onTaskIds,
}: {
  userId: string;
  onTaskIds: (taskIds?: string[]) => void;
}) {
  const qc = useQueryClient();
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [form, setForm] = useState<ResourceFormValue>(EMPTY_RESOURCE_FORM);

  const serversQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-servers'],
    queryFn: () => api.get<GrantServerCatalogItem[]>(adminCatalogPaths.grantServers),
  });
  const grantsQuery = useQuery({
    queryKey: ['user-server-grants', userId],
    queryFn: () => api.get<ServerGrantDto[]>(`/admin/users/${userId}/server-grants`),
  });
  const servers = serversQuery.data ?? [];
  const serverGrants = grantsQuery.data ?? [];

  const getGrant = (sid: string) => serverGrants.find((g) => g.serverId === sid);

  const upsert = useMutation({
    mutationFn: (serverId: string) => {
      const server = servers.find((candidate) => candidate.id === serverId);
      if (!server) throw new Error('服务器目录已变化，请刷新后重试');
      return api.post<ServerGrantDto & TaskIdsResponse>(
        `/admin/users/${userId}/server-grants/${serverId}`,
        formToGrantPayload(form, { availableGpuIndices: server.gpus.map((gpu) => gpu.index) }),
      );
    },
    onSuccess: (result) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: ['user-server-grants', userId] });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      notifyAccessChangedForSubject({ type: 'user', id: userId });
      toast({ title: '授权已更新' });
      setEditingServerId(null);
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (serverId: string) => api.delete<TaskIdsResponse>(`/admin/users/${userId}/server-grants/${serverId}`),
    onSuccess: (result) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: ['user-server-grants', userId] });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      notifyAccessChangedForSubject({ type: 'user', id: userId });
      toast({ title: '授权已移除' });
    },
    onError: (e) => toast({
      title: '失败',
      description: e.message.includes('ACCESS_REVOKE_HAS_RESOURCES') || e.message.includes('still owns')
        ? `${e.message}。可先使用「清理资源」删除该用户在此服务器上的容器与本地数据目录（remote 数据目录不挡移除）。`
        : e.message,
      variant: 'destructive',
    }),
  });

  const purgeResources = useMutation({
    mutationFn: (serverId: string) => api.post<TaskIdsResponse>(
      `/admin/users/${userId}/servers/${serverId}/purge-resources`,
      {},
    ),
    onSuccess: (result) => {
      onTaskIds(result.taskIds);
      toast({
        title: '已提交资源清理',
        description: '将删除容器与本地数据目录；完成后可再次移除授权',
      });
    },
    onError: (e) => toast({ title: '清理失败', description: e.message, variant: 'destructive' }),
  });

  const startEdit = (serverId: string) => {
    const g = getGrant(serverId);
    setForm(g ? grantToForm(g) : EMPTY_RESOURCE_FORM);
    setEditingServerId(serverId);
  };

  if (serversQuery.isLoading || grantsQuery.isLoading) return <QueryLoadingState label="加载服务器授权..." />;
  const queryError = serversQuery.error ?? grantsQuery.error;
  if (queryError) return (
    <QueryErrorState
      error={queryError}
      resourceName="服务器授权"
      onRetry={() => { void Promise.all([serversQuery.refetch(), grantsQuery.refetch()]); }}
    />
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">独立授权会完全覆盖该用户在对应服务器上的用户组授权。CPU / 内存 / 磁盘空字段表示不限制，GPU 空字段表示全部 GPU。</p>
      {servers.map((s) => {
        const g = getGrant(s.id);
        if (editingServerId === s.id) {
          return (
            <div key={s.id} className="border-2 border-primary/30 rounded-lg p-3 space-y-3 bg-primary/5">
              <div className="font-medium text-sm text-foreground">{s.name}</div>
              <ResourceGrantForm
              value={form}
              onChange={setForm}
              emptyHint="（空=不限）"
              showGpu={(s.gpus?.length ?? 0) > 0}
              />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={() => setEditingServerId(null)}>取消</Button>
                <Button size="sm" disabled={upsert.isPending} onClick={() => upsert.mutate(s.id)}>
                  {upsert.isPending ? '保存中...' : '保存'}
                </Button>
              </div>
            </div>
          );
        }

        return (
          <div key={s.id} className={`flex items-center justify-between py-2.5 px-3 rounded-lg border ${
            g ? 'border-amber-500/40 bg-amber-500/10 dark:bg-amber-500/15' : 'border-border'
          }`}>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{s.name}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  s.status === 'online' ? 'bg-green-50 text-green-700' : 'bg-muted text-muted-foreground'
                }`}>{s.status === 'online' ? '在线' : '离线'}</span>
                {g && <span className="text-xs text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">已独立授权</span>}
              </div>
              {g ? (
                <div className="text-xs mt-0.5 space-x-2">
                  <span className="text-muted-foreground">
                    {resourceVal(g.cpuMillis, formatCpu)} CPU
                  </span>
                  <span className="text-muted-foreground">
                    {resourceVal(g.memBytes, formatBytes)} 内存
                  </span>
                  <span className="text-muted-foreground">
                    {resourceVal(g.diskBytes, formatBytes)} 磁盘
                  </span>
                  <span className="text-muted-foreground">
                    GPU: {g.gpuMode ?? 'all'}{g.gpuMode === GpuGrantMode.Indices ? ` [${g.gpuIndices?.join(',')}]` : ''}
                  </span>
                  <span className="text-muted-foreground">
                    到期: {g.expiresAt ? new Date(g.expiresAt).toLocaleString() : '永不'}
                  </span>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground/50 mt-0.5">无独立授权，沿用用户组授权</div>
              )}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={upsert.isPending || remove.isPending} onClick={() => startEdit(s.id)}>
                {g ? '编辑' : '授权'}
              </Button>
              {g && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={purgeResources.isPending}
                    onClick={() => purgeResources.mutate(s.id)}
                  >
                    {purgeResources.isPending ? '清理中...' : '清理资源'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={remove.isPending} className="text-red-400 hover:text-red-600"
                    onClick={() => remove.mutate(s.id)}>
                    移除
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateUserDialog
// ---------------------------------------------------------------------------

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ username: '', password: '', displayName: '' });
  const [errors, setErrors] = useState<Partial<Record<'username' | 'password' | 'displayName', string>>>({});

  const validate = () => {
    const parsed = zCreateUserRequest.safeParse(form);
    if (parsed.success) {
      setErrors({});
      return true;
    }
    const errs: typeof errors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as 'username' | 'password' | 'displayName' | undefined;
      if (key && !errs[key]) errs[key] = issue.message;
    }
    setErrors(errs);
    return false;
  };

  const { mutate, isPending } = useMutation({
    mutationFn: () => {
      const parsed = zCreateUserRequest.safeParse(form);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '用户参数无效');
      return api.post('/admin/users', parsed.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.users.admin });
      qc.invalidateQueries({ queryKey: ['admin-catalog', 'administration-actions'] });
      toast({ title: '用户已创建（已加入 Users 组）' });
      setForm({ username: '', password: '', displayName: '' });
      setErrors({});
      onOpenChange(false);
    },
    onError: (e) => toast({ title: '创建失败', description: e.message, variant: 'destructive' }),
  });

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setForm({ username: '', password: '', displayName: '' });
      setErrors({});
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>添加用户</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm">用户名</Label>
            <Input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
            {errors.username && <p className="text-xs text-destructive">{errors.username}</p>}
            <p className="text-xs text-muted-foreground">只允许小写字母、数字、_ 和 -</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">密码</Label>
            <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            {errors.password && <p className="text-xs text-destructive">{errors.password}</p>}
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">显示名</Label>
            <Input value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} />
            {errors.displayName && <p className="text-xs text-destructive">{errors.displayName}</p>}
          </div>
          <p className="text-xs text-muted-foreground">新用户默认加入 Users 组，可在权限设置中调整所属组</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>取消</Button>
          <Button onClick={() => { if (validate()) mutate(); }} disabled={isPending}>
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AdminChangePasswordTab
// ---------------------------------------------------------------------------

function AdminChangePasswordTab({ userId }: { userId: string }) {
  const [form, setForm] = useState({ newPassword: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Partial<Record<'newPassword' | 'confirmPassword', string>>>({});

  const validate = () => {
    const errs: typeof errors = {};
    const parsed = zUpdateUserRequest.safeParse({ password: form.newPassword });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'password' && !errs.newPassword) errs.newPassword = issue.message;
      }
    }
    if (form.newPassword !== form.confirmPassword) errs.confirmPassword = '两次输入的密码不一致';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.patch(`/admin/users/${userId}`, { password: form.newPassword }),
    onSuccess: () => {
      const isSelf = userId === useAuthStore.getState().user?.id;
      toast({ title: isSelf ? '当前账号密码已修改，请重新登录' : '密码已修改' });
      setForm({ newPassword: '', confirmPassword: '' });
      setErrors({});
      if (isSelf) {
        clearLocalSession();
        window.location.replace('/login?reason=password-changed');
      }
    },
    onError: (e) => toast({ title: '修改失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-xs text-muted-foreground">以管理员身份修改该用户的密码，无需验证原密码。</p>
      <div className="space-y-1.5">
        <Label className="text-sm">新密码</Label>
        <Input
          type="password"
          value={form.newPassword}
          onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
        />
        {errors.newPassword && <p className="text-xs text-destructive">{errors.newPassword}</p>}
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm">确认新密码</Label>
        <Input
          type="password"
          value={form.confirmPassword}
          onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
        />
        {errors.confirmPassword && <p className="text-xs text-destructive">{errors.confirmPassword}</p>}
      </div>
      <Button
        onClick={() => { if (validate()) mutate(); }}
        disabled={isPending}
        className="w-full"
      >
        {isPending ? '修改中...' : '确认修改密码'}
      </Button>
    </div>
  );
}
