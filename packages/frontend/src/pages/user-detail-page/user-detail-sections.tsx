import { useState } from 'react';
import { Copy, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { MAX_USER_NOTE_LENGTH, Role, type UpdateUserRequest, type UserDto, UserStatus } from '@nyabase/common';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CanonicalGrantPanel } from '../../components/grants/canonical-grant-panel.js';
import { Button } from '../../components/ui/button.js';
import { Field, FieldGrid, FormField, SelectField } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { ROLE_OPTIONS, roleLabel, userStatusLabel } from '../../lib/display-labels.js';
import { userDeleting } from '../../lib/in-progress.js';
import { relativeTime } from '../../lib/utils.js';
import { useHasRole } from '../../lib/use-role.js';
import { useUserAvailability } from '../../lib/use-user-availability.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { MoreActions } from '../../components/layout/more-actions.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { copyOneTimeSecret, generateOneTimePassword } from '../../lib/one-time-secret.js';
import { toast } from '../../hooks/use-toast.js';
import { useAuthStore } from '../../store/auth.js';

/** One page: who the user is (with the administrators' note), then their grants. */
export function UserDetailSections({ user }: { user: UserDto }) {
  const canManageGrants = useHasRole(Role.UserAdmin);
  return (
    <div className="space-y-6" data-testid="user-detail-sections">
      <UserIdentityCard user={user} />
      {canManageGrants ? <CanonicalGrantPanel user={user} /> : null}
    </div>
  );
}

/** Identity, role and the administrators' note on the user. */
function UserIdentityCard({ user }: { user: UserDto }) {
  const canManageUsers = useUserAvailability(user).edit.allowed;
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
        <div className="space-y-3 text-sm">
          <FieldGrid>
            <Field label="显示名称" value={user.displayName} />
            <Field label="用户名" value={`@${user.username}`} mono />
            <Field
              label="状态"
              value={(
                <StatusBadge
                  label={userStatusLabel(user.status)}
                  pending={userDeleting(user.status)}
                  variant={user.status === UserStatus.Active ? 'success' : 'secondary'}
                />
              )}
            />
            <Field label="角色" value={roleLabel(user.role)} />
            <Field label="创建时间" value={relativeTime(user.createdAt)} />
          </FieldGrid>
          {user.note !== undefined ? (
            <Field
              label="备注（仅管理员可见）"
              value={user.note ? <span className="whitespace-pre-wrap">{user.note}</span> : null}
            />
          ) : null}
        </div>
      </SectionCard>
      {identityOpen ? <UserIdentityDialog user={user} onClose={() => setIdentityOpen(false)} /> : null}
    </>
  );
}

export function UserIdentityDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const patchUser = useUserPatch(user.id);
  const roleAvailability = useUserAvailability(user).changeRole;
  const [role, setRole] = useState<Role>(user.role);
  const [note, setNote] = useState(user.note ?? '');
  // Your own record goes through self-service, which leaves the note alone; only an admin annotates themselves.
  const viewer = useAuthStore((state) => state.user);
  const canEditNote = user.id !== viewer?.id || viewer?.role === Role.Admin;
  const submit = (next: string) => {
    if (!next) {
      toast({ title: '显示名称不能为空', variant: 'destructive' });
      return;
    }
    const body: UpdateUserRequest = {};
    if (next !== user.displayName) body.displayName = next;
    if (role !== user.role) body.role = role;
    const nextNote = note.trim() || null;
    if (canEditNote && nextNote !== (user.note ?? null)) body.note = nextNote;
    if (Object.keys(body).length === 0) {
      toast({ title: '没有需要保存的更改' });
      return;
    }
    patchUser.mutate(body, { onSuccess: onClose });
  };
  const pending = patchUser.isPending;
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  const [value, setValue] = useState(user.displayName);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
        </DialogHeader>
        <FormField id="user-display-name" label="显示名称">
          <Input
            id="user-display-name"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </FormField>
        <SelectField
          id="user-role"
          label="角色"
          value={role}
          onChange={(next) => setRole(next as Role)}
          options={ROLE_OPTIONS}
          disabled={!roleAvailability.allowed}
          hint={roleAvailability.reason ?? undefined}
        />
        {canEditNote ? (
          <FormField
            id="user-note"
            label="备注"
            hint={`仅管理员可见，最多 ${MAX_USER_NOTE_LENGTH} 字`}
          >
            <Textarea
              id="user-note"
              value={note}
              rows={3}
              maxLength={MAX_USER_NOTE_LENGTH}
              onChange={(event) => setNote(event.target.value)}
            />
          </FormField>
        ) : null}
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
                关闭后无法再次查看。
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
                将为「{displayName}」生成新密码，原密码和登录会话立即失效。
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
      if (body.status === UserStatus.Disabled) toast({ title: '用户已停用' });
      else if (body.status === UserStatus.Active) toast({ title: '用户已启用' });
      else if (body.displayName || body.role || body.note !== undefined) toast({ title: '用户已更新' });
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
  const availability = useUserAvailability(user);
  const remove = useMutation({
    mutationFn: () => api.delete<unknown>(`/users/${user.id}`),
    onSuccess: () => {
      toast({ title: '用户已删除' });
      setDeleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      void navigate({ to: '/users' });
    },
    onError: (error) => toast({ title: '删除用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  if (!availability.edit.allowed) return null;

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
        <Button
          variant="outline"
          disabled={!availability.disable.allowed}
          title={availability.disable.reason ?? undefined}
          onClick={() => setDisableOpen(true)}
        >
          停用
        </Button>
      )}
      <Button variant="outline" onClick={() => { setResetSecret(null); setResetOpen(true); }}>
        <KeyRound className="h-4 w-4" />重置密码
      </Button>
      <MoreActions actions={[{
        label: '删除用户',
        icon: Trash2,
        destructive: true,
        disabled: !availability.delete.allowed,
        description: availability.delete.reason ?? undefined,
        onSelect: () => setDeleteOpen(true),
      }]} />
      <ConfirmDialog
        open={disableOpen}
        title="停用用户？"
        description={`将停用「${user.displayName}」，其容器立即停止，14 天后清除其容器和数据卷。`}
        confirmLabel="确认停用"
        pendingLabel="处理中..."
        pending={patchUser.isPending}
        onConfirm={() => patchUser.mutate({ status: UserStatus.Disabled }, { onSuccess: () => setDisableOpen(false) })}
        onOpenChange={setDisableOpen}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除用户？"
        description={`将永久删除用户「${user.displayName}」，不可恢复。`}
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
