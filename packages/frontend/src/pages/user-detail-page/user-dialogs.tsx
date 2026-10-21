import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { FormField } from '../../components/layout/form-field.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { toast } from '../../hooks/use-toast.js';

export function UserIdentityDialog({
  displayName,
  pending,
  onSubmit,
  onOpenChange,
}: {
  displayName: string;
  pending: boolean;
  onSubmit: (displayName: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(displayName);
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
          <Button onClick={() => onSubmit(value.trim())} disabled={pending}>
            {pending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function generateOneTimePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

/** Confirm a password reset, then show the new password exactly once. */
export function ResetPasswordDialog({
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
