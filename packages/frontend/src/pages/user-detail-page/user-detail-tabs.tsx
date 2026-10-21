import { useState } from 'react';
import { Copy, Gauge, KeyRound, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { Capability, type UpdateUserRequest, type UserDto, UserStatus } from '@nyabase/common';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { CanonicalGrantPanel } from '../../components/grants/canonical-grant-panel.js';
import type { UserDetailTab } from '../../lib/detail-tabs.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Field, FormField } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { capabilityLabel, userStatusLabel } from '../../lib/display-labels.js';
import { userDeleting } from '../../lib/in-progress.js';
import { relativeTime } from '../../lib/utils.js';
import { useAuthStore } from '../../store/auth.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { MoreActions } from '../../components/layout/more-actions.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { toast } from '../../hooks/use-toast.js';

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['grants', '授权', ShieldCheck],
] as const;

export function UserDetailTabs({
  tab,
  user,
  onTab,
}: {
  tab: UserDetailTab;
  user: UserDto;
  onTab: (tab: UserDetailTab) => void;
}) {
  const canManageGrants = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageGrants) ?? false,
  );
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTab(value as UserDetailTab)}
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
        <UserOverviewTab user={user} />
      </TabsContent>
      <TabsContent value="grants" className="mt-4 space-y-6">
        {canManageGrants ? (
          <CanonicalGrantPanel subject={user} kind="users" />
        ) : (
          <p className="text-sm text-muted-foreground">查看与编辑授权需要「管理授权」权限。</p>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Identity, group membership and effective capabilities of a user. */
function UserOverviewTab({ user }: { user: UserDto }) {
  const canManageUsers = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageUsers) ?? false,
  );
  const [identityOpen, setIdentityOpen] = useState(false);
  return (
    <>
      <SectionCard
        title="身份"
        actions={canManageUsers ? (
          <Button size="sm" variant="outline" onClick={() => setIdentityOpen(true)}>
            <Pencil className="h-3.5 w-3.5" />编辑
          </Button>
        ) : undefined}
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="显示名称" value={user.displayName} />
          <Field label="用户名" value={`@${user.username}`} mono />
          <div>
            <p className="text-xs text-muted-foreground">状态</p>
            <div className="mt-1">
              <StatusBadge
                label={userStatusLabel(user.status)}
                pending={userDeleting(user.status)}
                variant={user.status === UserStatus.Active ? 'success' : 'secondary'}
              />
            </div>
          </div>
          <Field label="创建时间" value={relativeTime(user.createdAt)} />
        </div>
      </SectionCard>
      <SectionCard
        title="用户组"
        flush={user.groups.length > 0}
      >
        {user.groups.length === 0 ? (
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
              {user.groups.map((group) => (
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
      <SectionCard title="能力">
        {user.capabilities.length === 0 ? (
          <p className="text-sm text-muted-foreground">无。</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {user.capabilities.map((capability) => (
              <Badge key={capability} variant="outline">{capabilityLabel(capability)}</Badge>
            ))}
          </div>
        )}
      </SectionCard>
      {identityOpen ? <UserIdentityDialog user={user} onClose={() => setIdentityOpen(false)} /> : null}
    </>
  );
}

export function UserIdentityDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const patchUser = useUserPatch(user.id);
  const submit = (next: string) => {
    if (!next) {
      toast({ title: '显示名称不能为空', variant: 'destructive' });
      return;
    }
    if (next === user.displayName) {
      toast({ title: '没有需要保存的更改' });
      return;
    }
    patchUser.mutate({ displayName: next }, { onSuccess: onClose });
  };
  const pending = patchUser.isPending;
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  const [value, setValue] = useState(user.displayName);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
          <DialogDescription>修改显示名称。用户名创建后不可更改。</DialogDescription>
        </DialogHeader>
        <FormField id="user-display-name" label="显示名称">
          <Input
            id="user-display-name"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </FormField>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => submit(value.trim())} disabled={pending}>
            {pending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
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

/** Confirm a password reset, then show the new password exactly once. */
function ResetPasswordDialog({
  open,
  secret,
  username,
  displayName,
  pending,
  onReset,
  onClose,
}: {
  open: boolean;
  secret: string | null;
  username: string | undefined;
  displayName: string | undefined;
  pending: boolean;
  onReset: (password: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open || Boolean(secret)}
      onOpenChange={(next) => { if (!next) onClose(); }}
    >
      <DialogContent>
        {secret ? (
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
                <p className="font-mono text-sm">{username}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">新密码（仅此一次）</p>
                <p className="break-all font-mono text-sm">{secret}</p>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  void copyOneTimeSecret(secret).then((ok) => {
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
              <Button onClick={onClose}>我已保存，关闭</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>重置密码？</DialogTitle>
              <DialogDescription>
                将为「{displayName}」生成一次性新密码。原密码立即失效。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button
                disabled={pending}
                onClick={() => onReset(generateOneTimePassword())}
              >
                {pending ? '重置中...' : '确认重置'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Update mutation of one user; the caller closes its own dialog through `mutate` options. */
export function useUserPatch(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateUserRequest) => api.patch<UserDto>(`/users/${id}`, body),
    onSuccess: (_user, body) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
      if (body.status === UserStatus.Disabled) toast({ title: '用户已停用' });
      else if (body.status === UserStatus.Active) toast({ title: '用户已启用' });
      else if (body.displayName) toast({ title: '用户已更新' });
    },
    onError: (error) => toast({ title: '更新用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
}

/** Enable / disable, reset password and delete — for administrators looking at someone else. */
export function UserHeaderActions({ user }: { user: UserDto }) {
  const navigate = useNavigate({ from: '/users/$id' });
  const queryClient = useQueryClient();
  const [disableOpen, setDisableOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetSecret, setResetSecret] = useState<string | null>(null);
  const patchUser = useUserPatch(user.id);
  const remove = useMutation({
    mutationFn: () => api.delete<unknown>(`/users/${user.id}`),
    onSuccess: () => {
      toast({ title: '用户已删除' });
      setDeleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
      void navigate({ to: '/users' });
    },
    onError: (error) => toast({ title: '删除用户失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return (
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
      <MoreActions actions={[{ label: '删除用户', icon: Trash2, destructive: true, onSelect: () => setDeleteOpen(true) }]} />
      <ConfirmDialog
        open={disableOpen}
        title="停用用户？"
        description={`将停用「${user.displayName}」。该账号将无法登录，已有会话会被终止。`}
        confirmLabel="确认停用"
        pendingLabel="处理中..."
        pending={patchUser.isPending}
        onConfirm={() => patchUser.mutate({ status: UserStatus.Disabled }, { onSuccess: () => setDisableOpen(false) })}
        onOpenChange={setDisableOpen}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除用户？"
        description={`将永久删除用户「${user.displayName}」。其登录会话会被终止，组关系与资源授权会一并清理，且不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onOpenChange={setDeleteOpen}
      />
      <ResetPasswordDialog
        open={resetOpen}
        secret={resetSecret}
        username={user.username}
        displayName={user.displayName}
        pending={patchUser.isPending}
        onReset={(password) => {
          patchUser.mutate({ password }, {
            onSuccess: () => {
              toast({ title: '密码已重置' });
              setResetSecret(password);
              setResetOpen(false);
            },
          });
        }}
        onClose={() => { setResetOpen(false); setResetSecret(null); }}
      />
    </>
  );
}
