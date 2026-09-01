import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, MoreHorizontal, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { Capability, UserStatus, zCreateUserRequest, type CreateUserRequest, type UpdateUserRequest, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { Input } from '../components/ui/input.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ResourceList, ResourceListRow } from '../components/layout/resource-list.js';
import { CanonicalGrantPanel } from '../components/grants/canonical-grant-panel.js';
import { SubjectGrantSummary } from '../components/grants/subject-grant-summary.js';
import { userStatusLabel } from '../lib/display-labels.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { copyOneTimeSecret } from '../lib/one-time-secret.js';
import { isPermanentQueryError } from '../lib/query-lifecycle.js';

export default function UsersPage() {
  const currentUserId = useAuthStore((state) => state.user?.id);
  const canManageUsers = useAuthStore((state) => state.user?.capabilities.includes(Capability.ManageUsers) ?? false);
  const canManageGrants = useAuthStore((state) => state.user?.capabilities.includes(Capability.ManageGrants) ?? false);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [grantUser, setGrantUser] = useState<UserDto | null>(null);
  const [deleteUser, setDeleteUser] = useState<UserDto | null>(null);
  const [statusTarget, setStatusTarget] = useState<UserDto | null>(null);
  const [resetTarget, setResetTarget] = useState<UserDto | null>(null);
  const [resetSecret, setResetSecret] = useState<{ username: string; password: string } | null>(null);
  const usersQuery = useQuery({
    queryKey: queryKeys.users.admin,
    queryFn: () => api.get<UserDto[]>('/admin/users'),
    retry: (count, error) => !isPermanentQueryError(error) && count < 1,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/admin/users/${id}`),
    onSuccess: () => {
      toast({ title: '用户已删除' });
      setDeleteUser(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
    },
    onError: (error) => toast({ title: '删除用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const patchUser = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest }) => api.patch<UserDto>(`/admin/users/${id}`, body),
    onSuccess: (_user, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      if (variables.body.status === UserStatus.Disabled) {
        toast({ title: '用户已停用' });
        setStatusTarget(null);
      } else if (variables.body.status === UserStatus.Active) {
        toast({ title: '用户已启用' });
      } else if (variables.body.password) {
        toast({ title: '密码已重置' });
        setResetTarget(null);
      }
    },
    onError: (error) => toast({ title: '更新用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <Page testId="users-management">
      <PageHeader
        title="用户"
        description={
          usersQuery.data
            ? `${usersQuery.data.length} 个用户 · 授权按服务器、存储池和共享存储分别管理`
            : '授权按服务器、存储池和共享存储分别管理'
        }
        actions={
          canManageUsers ? (
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户</Button>
          ) : undefined
        }
      />
      <QueryView
        query={usersQuery}
        resourceName="用户"
        loadingLabel="加载用户..."
        showEmpty={usersQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无用户。"
            action={
              canManageUsers ? (
                <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户</Button>
              ) : undefined
            }
          />
        }
      >
        {(users) => (
          <ResourceList>
            {users.map((user) => (
              <ResourceListRow key={user.id}>
                <div className="flex min-w-0 items-center gap-3">
                  <UserRound className="h-5 w-5 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {user.displayName}{' '}
                      <span className="font-mono text-xs text-muted-foreground">@{user.username}</span>
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {user.groups.map((group) => <Badge key={group.id} variant="outline">{group.name}</Badge>)}
                      <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>{userStatusLabel(user.status)}</Badge>
                    </div>
                    {canManageGrants && <SubjectGrantSummary kind="users" subjectId={user.id} />}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {canManageGrants && (
                    <Button size="sm" variant="outline" onClick={() => setGrantUser(user)}>
                      <ShieldCheck className="h-4 w-4" />授权
                    </Button>
                  )}
                  {canManageUsers && user.id !== currentUserId && (
                    <>
                      {user.status === UserStatus.Disabled ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={patchUser.isPending}
                          onClick={() => patchUser.mutate({ id: user.id, body: { status: UserStatus.Active } })}
                        >
                          启用
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setStatusTarget(user)}>
                          停用
                        </Button>
                      )}
                      <div className="hidden gap-2 sm:flex">
                        <Button size="sm" variant="outline" onClick={() => setResetTarget(user)}>
                          <KeyRound className="h-4 w-4" />重置密码
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => setDeleteUser(user)}>
                          <Trash2 className="h-4 w-4" />删除
                        </Button>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="outline" className="sm:hidden" aria-label="更多操作">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setResetTarget(user)}>
                            重置密码
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setDeleteUser(user)}
                          >
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </ResourceListRow>
            ))}
          </ResourceList>
        )}
      </QueryView>
      {canManageUsers && <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {grantUser && (
        <Dialog open onOpenChange={(open) => { if (!open) setGrantUser(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>管理「{grantUser.displayName}」的授权</DialogTitle>
              <DialogDescription>按服务器 / 存储池 / 共享存储分别设置额度与到期时间。</DialogDescription>
            </DialogHeader>
            <CanonicalGrantPanel subject={grantUser} kind="users" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setGrantUser(null)}>完成</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={Boolean(statusTarget)}
        title="停用用户？"
        description={`将停用「${statusTarget?.displayName}」。该账号将无法登录，已有会话会被终止。`}
        confirmLabel="确认停用"
        pendingLabel="处理中..."
        pending={patchUser.isPending}
        onConfirm={() => {
          if (statusTarget) patchUser.mutate({ id: statusTarget.id, body: { status: UserStatus.Disabled } });
        }}
        onOpenChange={(open) => { if (!open) setStatusTarget(null); }}
      />
      <Dialog
        open={Boolean(resetTarget) || Boolean(resetSecret)}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null);
            setResetSecret(null);
          }
        }}
      >
        <DialogContent>
          {resetSecret ? (
            <>
              <DialogHeader>
                <DialogTitle>密码已重置</DialogTitle>
                <DialogDescription>
                  请立即复制并妥善交付新密码。关闭此窗口后将无法再次查看明文密码。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">用户名</p>
                  <p className="font-mono text-sm">{resetSecret.username}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">新密码（仅此一次）</p>
                  <p className="break-all font-mono text-sm">{resetSecret.password}</p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    void copyOneTimeSecret(resetSecret.password).then((ok) => {
                      toast({
                        title: ok ? '新密码已复制' : '复制失败',
                        description: ok ? undefined : '请手动选中密码复制',
                        variant: ok ? 'default' : 'destructive',
                      });
                    });
                  }}
                >
                  <Copy className="h-4 w-4" />复制密码
                </Button>
                <Button onClick={() => { setResetTarget(null); setResetSecret(null); }}>我已保存，关闭</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>重置密码？</DialogTitle>
                <DialogDescription>
                  将为「{resetTarget?.displayName}」生成一次性新密码。原密码立即失效。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setResetTarget(null)}>取消</Button>
                <Button
                  disabled={patchUser.isPending}
                  onClick={() => {
                    if (!resetTarget) return;
                    const password = generateOneTimePassword();
                    patchUser.mutate(
                      { id: resetTarget.id, body: { password } },
                      {
                        onSuccess: () => {
                          setResetSecret({ username: resetTarget.username, password });
                        },
                      },
                    );
                  }}
                >
                  {patchUser.isPending ? '重置中...' : '确认重置'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleteUser)}
        title="删除用户？"
        description={`将永久删除用户「${deleteUser?.displayName}」。其登录会话会被终止，组关系与资源授权会一并清理，且不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => { if (deleteUser) remove.mutate(deleteUser.id); }}
        onOpenChange={(open) => { if (!open) setDeleteUser(null); }}
      />
    </Page>
  );
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [createdCreds, setCreatedCreds] = useState<{ username: string; password: string } | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => api.post<UserDto>('/admin/users', body),
    onSuccess: (_user, variables) => {
      toast({ title: '用户已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      setCreatedCreds({ username: variables.username, password: variables.password });
      setForm({ username: '', displayName: '', password: '' });
      setError(null);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const submit = () => {
    const parsed = zCreateUserRequest.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查用户信息');
      return;
    }
    create.mutate(parsed.data);
  };
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setCreatedCreds(null);
      setForm({ username: '', displayName: '', password: '' });
      setError(null);
    }
    onOpenChange(next);
  };
  const copyPassword = async () => {
    if (!createdCreds) return;
    const ok = await copyOneTimeSecret(createdCreds.password);
    toast({
      title: ok ? '初始密码已复制' : '复制失败',
      description: ok ? undefined : '请手动选中密码复制',
      variant: ok ? 'default' : 'destructive',
    });
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {createdCreds ? (
          <>
            <DialogHeader>
              <DialogTitle>用户已创建</DialogTitle>
              <DialogDescription>
                请立即复制并妥善交付初始密码。关闭此窗口后将无法再次查看明文密码。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <div>
                <p className="text-xs text-muted-foreground">用户名</p>
                <p className="font-mono text-sm">{createdCreds.username}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">初始密码（仅此一次）</p>
                <p className="break-all font-mono text-sm">{createdCreds.password}</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { void copyPassword(); }}>
                <Copy className="h-4 w-4" />复制密码
              </Button>
              <Button onClick={() => handleOpenChange(false)}>我已保存，关闭</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>新建用户</DialogTitle>
              <DialogDescription>创建后再通过授权面板绑定服务器、存储池或共享存储。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {(['username', 'displayName', 'password'] as const).map((key) => {
                const labels = { username: '用户名', displayName: '显示名称', password: '初始密码' } as const;
                return (
                  <FormField key={key} id={`new-user-${key}`} label={labels[key]}>
                    <Input
                      id={`new-user-${key}`}
                      type={key === 'password' ? 'password' : 'text'}
                      value={form[key]}
                      onChange={(event) => {
                        const value = event.target.value;
                        setForm((current) => ({ ...current, [key]: value }));
                        setError(null);
                      }}
                    />
                  </FormField>
                );
              })}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>取消</Button>
              <Button onClick={submit} disabled={create.isPending}>{create.isPending ? '创建中...' : '创建'}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function generateOneTimePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
