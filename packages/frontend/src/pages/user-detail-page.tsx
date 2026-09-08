import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Copy, Gauge, KeyRound, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { Capability, UserStatus, type UpdateUserRequest, type UserDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { SectionCard } from '../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { CanonicalGrantPanel } from '../components/grants/canonical-grant-panel.js';
import { capabilityLabel, userStatusLabel } from '../lib/display-labels.js';
import { copyOneTimeSecret } from '../lib/one-time-secret.js';
import { queryKeys } from '../lib/query-keys.js';
import { relativeTime } from '../lib/utils.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { type UserDetailTab } from '../lib/user-detail.js';

const routeApi = getRouteApi('/users/$id');

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['grants', '授权', ShieldCheck],
] as const;

export default function UserDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/users/$id' });
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore((state) => state.user?.id);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageUsers = capabilities.includes(Capability.ManageUsers);
  const canManageGrants = capabilities.includes(Capability.ManageGrants);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetSecret, setResetSecret] = useState<string | null>(null);

  const selectTab = (next: UserDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const userQuery = useQuery({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => api.get<UserDto>(`/admin/users/${id}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
  };

  const patchUser = useMutation({
    mutationFn: (body: UpdateUserRequest) => api.patch<UserDto>(`/admin/users/${id}`, body),
    onSuccess: (_user, body) => {
      invalidate();
      if (body.status === UserStatus.Disabled) {
        toast({ title: '用户已停用' });
        setDisableOpen(false);
      } else if (body.status === UserStatus.Active) {
        toast({ title: '用户已启用' });
      } else if (body.displayName) {
        toast({ title: '用户已更新' });
        setEditingIdentity(false);
      }
    },
    onError: (error) => toast({ title: '更新用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete<unknown>(`/admin/users/${id}`),
    onSuccess: () => {
      toast({ title: '用户已删除' });
      setDeleteOpen(false);
      invalidate();
      void navigate({ to: '/users' });
    },
    onError: (error) => toast({ title: '删除用户失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const user = userQuery.data;
  const isSelf = user?.id === currentUserId;
  const canOperate = canManageUsers && Boolean(user) && !isSelf;

  return (
    <Page testId="user-detail">
      <PageHeader
        title={user?.displayName ?? '用户'}
        description={user ? `@${user.username}` : undefined}
        crumbs={[
          { label: '用户', to: '/users' },
          { label: user?.displayName ?? '…' },
        ]}
        actions={
          canOperate && user ? (
            <>
              {user.status === UserStatus.Disabled ? (
                <Button
                  variant="outline"
                  disabled={patchUser.isPending}
                  onClick={() => patchUser.mutate({ status: UserStatus.Active })}
                >
                  启用
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setDisableOpen(true)}>停用</Button>
              )}
              <Button variant="outline" onClick={() => { setResetSecret(null); setResetOpen(true); }}>
                <KeyRound className="h-4 w-4" />重置密码
              </Button>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" />删除用户
              </Button>
            </>
          ) : undefined
        }
      />
      <QueryView
        query={userQuery}
        resourceName="用户"
        loadingLabel="加载用户..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <Tabs
            value={tab}
            onValueChange={(value) => selectTab(value as UserDetailTab)}
            data-testid="user-detail-tabs"
          >
            <TabsList>
              {TAB_ITEMS.map(([key, label, Icon]) => (
                <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`user-tab-${key}`}>
                  <Icon className="h-4 w-4" />{label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview" className="mt-4 space-y-6">
              <Card>
                <CardHeader className="flex flex-row items-start justify-between space-y-0">
                  <CardTitle className="text-base">身份</CardTitle>
                  {canManageUsers && !editingIdentity ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDisplayName(loaded.displayName);
                        setEditingIdentity(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />编辑
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                  {editingIdentity ? (
                    <FormField id="user-display-name" label="显示名称">
                      <Input
                        id="user-display-name"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </FormField>
                  ) : (
                    <Info label="显示名称" value={loaded.displayName} />
                  )}
                  <Info label="用户名" value={`@${loaded.username}`} mono />
                  <div>
                    <p className="text-xs text-muted-foreground">状态</p>
                    <div className="mt-1">
                      <Badge variant={loaded.status === UserStatus.Active ? 'success' : 'secondary'}>
                        {userStatusLabel(loaded.status)}
                      </Badge>
                    </div>
                  </div>
                  <Info label="创建时间" value={relativeTime(loaded.createdAt)} />
                  {editingIdentity ? (
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <Button
                        onClick={() => {
                          const next = displayName.trim();
                          if (!next) {
                            toast({ title: '显示名称不能为空', variant: 'destructive' });
                            return;
                          }
                          if (next === loaded.displayName) {
                            toast({ title: '没有需要保存的更改' });
                            return;
                          }
                          patchUser.mutate({ displayName: next });
                        }}
                        disabled={patchUser.isPending}
                      >
                        {patchUser.isPending ? '保存中...' : '保存'}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={patchUser.isPending}
                        onClick={() => {
                          setDisplayName(loaded.displayName);
                          setEditingIdentity(false);
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
              <SectionCard
                title="用户组"
                description="点名称打开用户组详情。组成员身份会立即改变有效授权。"
                flush={loaded.groups.length > 0}
              >
                {loaded.groups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">未加入任何用户组。</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>类型</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loaded.groups.map((group) => (
                        <TableRow key={group.id}>
                          <TableCell>
                            <Link
                              to="/groups/$id"
                              params={{ id: group.id }}
                              search={{ tab: 'overview' }}
                              className="font-medium"
                            >
                              {group.name}
                            </Link>
                          </TableCell>
                          <TableCell>{group.isSystem ? '系统组' : '自定义组'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>
              <SectionCard title="能力" description="来自所属用户组，在用户组详情中修改。">
                {loaded.capabilities.length === 0 ? (
                  <p className="text-sm text-muted-foreground">无。</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {loaded.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline">{capabilityLabel(capability)}</Badge>
                    ))}
                  </div>
                )}
              </SectionCard>
            </TabsContent>
            <TabsContent value="grants" className="mt-4 space-y-6">
              {canManageGrants ? (
                <CanonicalGrantPanel subject={loaded} kind="users" />
              ) : (
                <p className="text-sm text-muted-foreground">查看与编辑授权需要「管理授权」权限。</p>
              )}
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
      <ConfirmDialog
        open={disableOpen}
        title="停用用户？"
        description={`将停用「${user?.displayName}」。该账号将无法登录，已有会话会被终止。`}
        confirmLabel="确认停用"
        pendingLabel="处理中..."
        pending={patchUser.isPending}
        onConfirm={() => patchUser.mutate({ status: UserStatus.Disabled })}
        onOpenChange={setDisableOpen}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除用户？"
        description={`将永久删除用户「${user?.displayName}」。其登录会话会被终止，组关系与资源授权会一并清理，且不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onOpenChange={setDeleteOpen}
      />
      <Dialog
        open={resetOpen || Boolean(resetSecret)}
        onOpenChange={(open) => {
          if (!open) {
            setResetOpen(false);
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
                  <p className="font-mono text-sm">{user?.username}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">新密码（仅此一次）</p>
                  <p className="break-all font-mono text-sm">{resetSecret}</p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    void copyOneTimeSecret(resetSecret).then((ok) => {
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
                <Button onClick={() => { setResetOpen(false); setResetSecret(null); }}>我已保存，关闭</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>重置密码？</DialogTitle>
                <DialogDescription>
                  将为「{user?.displayName}」生成一次性新密码。原密码立即失效。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setResetOpen(false)}>取消</Button>
                <Button
                  disabled={patchUser.isPending}
                  onClick={() => {
                    const password = generateOneTimePassword();
                    patchUser.mutate(
                      { password },
                      {
                        onSuccess: () => {
                          toast({ title: '密码已重置' });
                          setResetSecret(password);
                          setResetOpen(false);
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
    </Page>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'mt-1 break-all font-mono text-xs' : 'mt-1 break-all'}>{value}</p>
    </div>
  );
}

function generateOneTimePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
