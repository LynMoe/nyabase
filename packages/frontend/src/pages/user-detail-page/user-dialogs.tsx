import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { UserStatus, type UpdateUserRequest, type UserDto } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { FormField } from '../../components/layout/form-field.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { MoreActions } from '../../components/layout/more-actions.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { toast } from '../../hooks/use-toast.js';

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
