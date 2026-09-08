import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { Capability, zCreateUserRequest, type CreateUserRequest, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { userStatusLabel } from '../lib/display-labels.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { copyOneTimeSecret } from '../lib/one-time-secret.js';
import { isPermanentQueryError } from '../lib/query-lifecycle.js';

export default function UsersPage() {
  const currentUserId = useAuthStore((state) => state.user?.id);
  const canManageUsers = useAuthStore((state) => state.user?.capabilities.includes(Capability.ManageUsers) ?? false);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteUser, setDeleteUser] = useState<UserDto | null>(null);
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
  return (
    <Page testId="users-management">
      <PageHeader
        title="用户"
        description={
          usersQuery.data
            ? `${usersQuery.data.length} 个用户 · 点进详情查看身份与授权`
            : '点进详情查看身份与授权'
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
          <SectionCard flush>
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>用户组</TableHead>
                  {canManageUsers ? <TableHead className="text-right">操作</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="whitespace-normal">
                      <Link
                        to="/users/$id"
                        params={{ id: user.id }}
                        search={{ tab: 'overview' }}
                        className="block min-w-0"
                      >
                        <p className="font-medium">{user.displayName}</p>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">@{user.username}</p>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.status === 'active' ? 'success' : 'secondary'}>
                        {userStatusLabel(user.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {user.groups.length === 0
                          ? <span className="text-muted-foreground">无</span>
                          : user.groups.map((group) => (
                            <Link
                              key={group.id}
                              to="/groups/$id"
                              params={{ id: group.id }}
                              search={{ tab: 'overview' }}
                            >
                              <Badge variant="outline">{group.name}</Badge>
                            </Link>
                          ))}
                      </div>
                    </TableCell>
                    {canManageUsers ? (
                      <TableCell className="text-right">
                        {user.id !== currentUserId ? (
                          <Button size="sm" variant="destructive" onClick={() => setDeleteUser(user)}>
                            <Trash2 className="h-4 w-4" />删除
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        )}
      </QueryView>
      {canManageUsers && <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />}
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
              <DialogDescription>创建后可在用户详情中设置授权。</DialogDescription>
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
