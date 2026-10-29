import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { zUpdateUserRequest } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { ApiError } from '../../lib/api-error.js';
import { setPendingLoginReason, terminateBrowserSession } from '../../lib/auth-session.js';
import { toast } from '../../hooks/use-toast.js';
import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';

type PasswordErrors = Partial<Record<'currentPassword' | 'newPassword' | 'confirmPassword', string>>;

/**
 * Self-service password change. A success ends every browser session, so the
 * user signs in again with the new password.
 *
 * `forced`: an administrator created the account or reset its password. The
 * dialog cannot be dismissed (no close button, Escape or outside click); the
 * only way out besides changing the password is signing out.
 */
export function ChangePasswordDialog({
  userId,
  forced = false,
  onOpenChange,
}: {
  userId: string;
  forced?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const curId = 'profile-current-password';
  const newId = 'profile-new-password';
  const confirmId = 'profile-confirm-password';
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [errors, setErrors] = useState<PasswordErrors>({});

  const validate = () => {
    const errs: PasswordErrors = {};
    if (!form.currentPassword) errs.currentPassword = '请输入当前密码';
    const parsed = zUpdateUserRequest.safeParse({
      password: form.newPassword,
      currentPassword: form.currentPassword,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'password' && !errs.newPassword) errs.newPassword = issue.message;
      }
    }
    if (forced && !errs.newPassword && form.newPassword === form.currentPassword) {
      errs.newPassword = '新密码不能与当前密码相同';
    }
    if (form.newPassword !== form.confirmPassword) errs.confirmPassword = '两次输入的密码不一致';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.patch(`/users/${userId}`, {
      password: form.newPassword,
      currentPassword: form.currentPassword,
    }),
    onSuccess: () => {
      toast({ title: '密码已修改，请使用新密码重新登录' });
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setErrors({});
      setPendingLoginReason('password-changed');
      void terminateBrowserSession().finally(() => {
        window.location.replace('/login?reason=password-changed');
      });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'CURRENT_PASSWORD_INCORRECT') {
        setErrors({ currentPassword: '当前密码不正确' });
        return;
      }
      toast({ title: '修改失败', description: e.message, variant: 'destructive' });
    },
  });

  const blockDismiss = (event: Event) => { if (forced) event.preventDefault(); };

  return (
    <Dialog open onOpenChange={(next) => { if (!forced) onOpenChange?.(next); }}>
      <DialogContent
        hideClose={forced}
        onEscapeKeyDown={blockDismiss}
        onInteractOutside={blockDismiss}
        data-testid={forced ? 'forced-password-change' : undefined}
      >
        <DialogHeader>
          <DialogTitle>{forced ? '请设置新密码' : '修改密码'}</DialogTitle>
          {forced ? (
            <DialogDescription>
              你的密码由管理员设置，继续使用前需要改成只有你知道的新密码。修改后请用新密码重新登录。
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="space-y-3">
          <FormField id={curId} label="当前密码" error={errors.currentPassword}>
            <Input
              id={curId}
              type="password"
              value={form.currentPassword}
              onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
              aria-invalid={!!errors.currentPassword}
              autoComplete="current-password"
            />
          </FormField>
          <FormField id={newId} label="新密码" error={errors.newPassword}>
            <Input
              id={newId}
              type="password"
              value={form.newPassword}
              onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
              aria-invalid={!!errors.newPassword}
              autoComplete="new-password"
            />
          </FormField>
          <FormField id={confirmId} label="确认新密码" error={errors.confirmPassword}>
            <Input
              id={confirmId}
              type="password"
              value={form.confirmPassword}
              onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
              aria-invalid={!!errors.confirmPassword}
              autoComplete="new-password"
            />
          </FormField>
        </div>
        <DialogFooter>
          {forced ? (
            <Button variant="outline" onClick={() => { void terminateBrowserSession(); }} disabled={isPending}>
              退出登录
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange?.(false)}>取消</Button>
          )}
          <Button onClick={() => { if (validate()) mutate(); }} disabled={isPending}>
            {isPending ? '修改中...' : '确认修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
