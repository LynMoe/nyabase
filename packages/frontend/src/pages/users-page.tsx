import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.js';
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
import { UserStatus, GpuGrantMode, zCreateUserRequest, zUpdateUserRequest } from '@nyabase/common';
import type {
  UserDto, GroupDto, ServerDto, ServerGrantDto, ImageDto, EffectiveAccessDto,
} from '@nyabase/common';
import { formatBytes, formatCpu, resourceVal } from '../lib/utils.js';
import {
  ResourceGrantForm, ResourceFormValue, EMPTY_RESOURCE_FORM,
  grantToForm, formToGrantPayload,
} from '../components/resource-grant-form.js';
import { MountSourceGrantsPanel } from '../components/grants/mount-source-grants-panel.js';
import { queryKeys } from '../lib/query-keys.js';

export default function UsersPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [showGrants, setShowGrants] = useState<UserDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserDto | null>(null);
  const qc = useQueryClient();

  const { data: users = [], isFetching, refetch } = useQuery({
    queryKey: queryKeys.users.admin, queryFn: () => api.get<UserDto[]>('/admin/users'),
  });

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: queryKeys.users.admin }); toast({ title: '用户已删除' }); },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-6 w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">用户管理</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{users.length} 个账号</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />添加用户
          </Button>
        </div>
      </div>

      <div className="bg-background rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">用户名</th>
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">显示名</th>
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">用户组</th>
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">状态</th>
              <th className="text-left py-3 px-4 font-medium text-muted-foreground">创建时间</th>
              <th className="py-3 px-4" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-accent/50 transition-colors">
                <td className="py-3 px-4 font-mono font-medium text-foreground">{u.username}</td>
                <td className="py-3 px-4 text-muted-foreground">{u.displayName}</td>
                <td className="py-3 px-4">
                  <div className="flex flex-wrap gap-1">
                    {u.groups.map((g) => (
                      <Badge key={g.id} variant={g.isSystem ? 'default' : 'secondary'} className="text-xs">
                        {g.name}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="py-3 px-4">
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium
                    ${u.status === UserStatus.Active ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${u.status === UserStatus.Active ? 'bg-green-500' : 'bg-red-400'}`} />
                    {u.status === UserStatus.Active ? '正常' : '禁用'}
                  </span>
                </td>
                <td className="py-3 px-4 text-muted-foreground text-xs">
                  {new Date(u.createdAt).toLocaleDateString('zh-CN')}
                </td>
                <td className="py-3 px-4">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="outline" className="h-7 text-xs px-2"
                      onClick={() => setShowGrants(u)}>
                      <Settings2 className="h-3 w-3 mr-1" />权限
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:text-red-600"
                      onClick={() => setDeleteTarget(u)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateUserDialog open={showCreate} onOpenChange={setShowCreate} />
      {showGrants && (
        <UserGrantsDialog
          user={users.find((u) => u.id === showGrants.id) ?? showGrants}
          onClose={() => setShowGrants(null)}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
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

function UserGrantsDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'effective' | 'groups' | 'overrides' | 'mount-source-grants' | 'password'>('effective');

  const userTabs = [
    { key: 'effective' as const, label: '有效权限' },
  ];

  const adminTabs = [
    { key: 'groups' as const, label: '所属用户组' },
    { key: 'overrides' as const, label: '独立授权' },
    { key: 'mount-source-grants' as const, label: '数据源授权' },
    { key: 'password' as const, label: '密码', icon: KeyRound },
  ];

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

        <div className="flex items-end gap-1 border-b border-border shrink-0">
          {userTabs.map(renderTabButton)}
          <span className="w-px h-4 bg-border mb-2.5 mx-1 shrink-0" />
          {adminTabs.map(renderTabButton)}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 py-3">
          {activeTab === 'effective' && <EffectiveTab userId={user.id} />}
          {activeTab === 'groups' && <GroupsTab userId={user.id} user={user} />}
          {activeTab === 'overrides' && <OverridesTab userId={user.id} />}
          {activeTab === 'mount-source-grants' && (
            <MountSourceGrantsPanel
              subject={{ type: 'user', id: user.id }}
              description="为该用户独立授权可访问的数据源（与用户组授权取并集，仍需同时拥有对应服务器的访问权限）"
            />
          )}
          {activeTab === 'password' && <AdminChangePasswordTab userId={user.id} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Effective Tab
// ---------------------------------------------------------------------------

function EffectiveTab({ userId }: { userId: string }) {
  const { data: effectiveAccess, isLoading } = useQuery({
    queryKey: ['user-effective-access', userId],
    queryFn: () => api.get<EffectiveAccessDto>(`/admin/users/${userId}/effective-access`),
  });
  const { data: servers = [] } = useQuery({
    queryKey: queryKeys.servers.admin, queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const { data: images = [] } = useQuery({
    queryKey: queryKeys.images.admin, queryFn: () => api.get<ImageDto[]>('/admin/images'),
  });

  const serverMap = new Map(servers.map((s) => [s.id, s]));
  const imageMap = new Map(images.map((img) => [img.id, img]));

  if (isLoading) return <div className="text-sm text-muted-foreground text-center py-8">加载中...</div>;

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
          .filter(Boolean) as ImageDto[];

        const gpuText = () => {
          switch (access.gpuMode) {
            case GpuGrantMode.None: return <span className="text-muted-foreground">无</span>;
            case GpuGrantMode.All: return <span className="text-green-600 font-medium">全部</span>;
            case GpuGrantMode.Indices: return <span className="text-purple-600 font-medium">[{access.gpuIndices?.join(', ')}]</span>;
            default: return null;
          }
        };

        return (
          <div key={access.serverId} className="border border-border rounded-xl overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 bg-muted/50 border-b border-border">
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                server?.status === 'online' ? 'bg-green-500' :
                server?.status === 'offline' ? 'bg-red-400' : 'bg-muted-foreground/30'
              }`} />
              <span className="font-semibold text-foreground text-sm">
                {server?.name ?? access.serverId.slice(0, 8)}
              </span>
              {server && <span className="text-xs text-muted-foreground font-mono">{server.ipCidr}</span>}
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

function GroupsTab({ userId, user }: { userId: string; user: UserDto }) {
  const qc = useQueryClient();

  const { data: allGroups = [] } = useQuery({
    queryKey: queryKeys.groups.admin, queryFn: () => api.get<GroupDto[]>('/admin/groups'),
  });

  const addToGroup = useMutation({
    mutationFn: (groupId: string) => api.post(`/admin/groups/${groupId}/members`, { userId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.users.admin });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      toast({ title: '已加入用户组' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const removeFromGroup = useMutation({
    mutationFn: (groupId: string) => api.delete(`/admin/groups/${groupId}/members/${userId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.users.admin });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      toast({ title: '已移出用户组' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const userGroupIds = new Set(user.groups.map((g) => g.id));

  return (
    <div className="space-y-2">
      {allGroups.map((g) => {
        const isMember = userGroupIds.has(g.id);
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
              className={`h-7 text-xs ${isMember ? 'text-red-600 border-red-200 hover:bg-red-50' : ''}`}
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
// Overrides Tab
// ---------------------------------------------------------------------------

function OverridesTab({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [form, setForm] = useState<ResourceFormValue>(EMPTY_RESOURCE_FORM);

  const { data: servers = [] } = useQuery({
    queryKey: queryKeys.servers.admin, queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const { data: serverGrants = [] } = useQuery({
    queryKey: ['user-server-grants', userId],
    queryFn: () => api.get<ServerGrantDto[]>(`/admin/users/${userId}/server-grants`),
  });

  const getGrant = (sid: string) => serverGrants.find((g) => g.serverId === sid);

  const upsert = useMutation({
    mutationFn: (serverId: string) => api.post(
      `/admin/users/${userId}/server-grants/${serverId}`,
      formToGrantPayload(form),
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-server-grants', userId] });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      toast({ title: '授权已更新' });
      setEditingServerId(null);
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (serverId: string) => api.delete(`/admin/users/${userId}/server-grants/${serverId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-server-grants', userId] });
      qc.invalidateQueries({ queryKey: ['user-effective-access', userId] });
      toast({ title: '授权已移除' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const startEdit = (serverId: string) => {
    const g = getGrant(serverId);
    setForm(g ? grantToForm(g) : EMPTY_RESOURCE_FORM);
    setEditingServerId(serverId);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">独立授权会完全覆盖该用户在对应服务器上的用户组授权。空字段使用服务器默认值。</p>
      {servers.map((s) => {
        const g = getGrant(s.id);
        if (editingServerId === s.id) {
          return (
            <div key={s.id} className="border-2 border-primary/30 rounded-xl p-3 space-y-3 bg-primary/5">
              <div className="font-medium text-sm text-foreground">{s.name}</div>
              <ResourceGrantForm
              value={form}
              onChange={setForm}
              emptyHint="（空=服务器默认）"
              showGpu={s.isGpuServer}
              serverDefaults={{ cpuMillis: s.defaultCpuMillis, memBytes: s.defaultMemBytes, diskBytes: s.defaultDiskBytes }}
            />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditingServerId(null)}>取消</Button>
                <Button size="sm" className="h-7 text-xs" onClick={() => upsert.mutate(s.id)}>保存</Button>
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
                }`}>{s.status}</span>
                {g && <span className="text-xs text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">已独立授权</span>}
              </div>
              {g ? (
                <div className="text-xs mt-0.5 space-x-2">
                  <span className={g.cpuMillis === null ? 'text-muted-foreground/40' : 'text-muted-foreground'}>
                    {resourceVal(g.cpuMillis, s.defaultCpuMillis, formatCpu)} CPU
                  </span>
                  <span className={g.memBytes === null ? 'text-muted-foreground/40' : 'text-muted-foreground'}>
                    {resourceVal(g.memBytes, s.defaultMemBytes, formatBytes)} 内存
                  </span>
                  <span className={g.diskBytes === null ? 'text-muted-foreground/40' : 'text-muted-foreground'}>
                    {resourceVal(g.diskBytes, s.defaultDiskBytes, formatBytes)} 磁盘
                  </span>
                  <span className="text-muted-foreground">
                    GPU: {g.gpuMode ?? '服务器默认'}{g.gpuMode === GpuGrantMode.Indices ? ` [${g.gpuIndices?.join(',')}]` : ''}
                  </span>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground/50 mt-0.5">无独立授权，沿用用户组授权</div>
              )}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startEdit(s.id)}>
                {g ? '编辑' : '授权'}
              </Button>
              {g && (
                <Button size="sm" variant="ghost" className="h-7 text-xs text-red-400 hover:text-red-600"
                  onClick={() => remove.mutate(s.id)}>
                  移除
                </Button>
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
    mutationFn: () => api.post('/admin/users', form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.users.admin });
      toast({ title: '用户已创建（已加入 Users 组）' });
      onOpenChange(false);
      setForm({ username: '', password: '', displayName: '' });
      setErrors({});
    },
    onError: (e) => toast({ title: '创建失败', description: e.message, variant: 'destructive' }),
  });

  const handleOpenChange = (v: boolean) => {
    if (!v) setErrors({});
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
      toast({ title: '密码已修改' });
      setForm({ newPassword: '', confirmPassword: '' });
      setErrors({});
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
