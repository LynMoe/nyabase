import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { Capability, UserStatus, zCreateUserRequest, type CreateUserRequest, type UpdateUserRequest, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
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
  if (usersQuery.isLoading) return <QueryLoadingState label="加载用户..." />;
  if (usersQuery.isError) return <QueryErrorState error={usersQuery.error} resourceName="用户" onRetry={() => { void usersQuery.refetch(); }} />;
  const users = usersQuery.data ?? [];
  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="users-management">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">用户</h1>
          <p className="text-sm text-muted-foreground">{users.length} 个用户 · 授权按服务器、存储池和共享存储分别管理</p>
        </div>
        {canManageUsers && (
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户</Button>
        )}
      </div>
      {users.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">暂无用户。</p>
            {canManageUsers && (
              <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <Card key={user.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
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
                <div className="flex flex-wrap gap-2">
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
                      <Button size="sm" variant="outline" onClick={() => setResetTarget(user)}>
                        <KeyRound className="h-4 w-4" />重置密码
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeleteUser(user)}>
                        <Trash2 className="h-4 w-4" />删除
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {canManageUsers && <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {grantUser && (
        <Dialog open onOpenChange={(open) => { if (!open) setGrantUser(null); }}>
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>管理 {grantUser.displayName} 的授权</DialogTitle>
              <DialogDescription>按服务器 / 存储池 / 共享存储分别设置额度与到期时间。</DialogDescription>
            </DialogHeader>
            <CanonicalGrantPanel subject={grantUser} kind="users" />
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={Boolean(statusTarget)} onOpenChange={(open) => { if (!open) setStatusTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停用用户？</DialogTitle>
            <DialogDescription>
              将停用「{statusTarget?.displayName}」。该账号将无法登录，已有会话会被终止。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusTarget(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={patchUser.isPending}
              onClick={() => {
                if (statusTarget) patchUser.mutate({ id: statusTarget.id, body: { status: UserStatus.Disabled } });
              }}
            >
              {patchUser.isPending ? '处理中...' : '确认停用'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
      <Dialog open={Boolean(deleteUser)} onOpenChange={(open) => { if (!open) setDeleteUser(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除用户？</DialogTitle>
            <DialogDescription>
              将永久删除用户「{deleteUser?.displayName}」。其登录会话会被终止，组关系与资源授权会一并清理，且不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUser(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteUser) remove.mutate(deleteUser.id); }}
              disabled={remove.isPending}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`new-user-${key}`}>{labels[key]}</Label>
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
                  </div>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
