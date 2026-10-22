import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { Role, zCreateUserRequest, type CreateUserRequest, type UserDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { FormField, SelectField } from '../../components/layout/form-field.js';
import { ROLE_OPTIONS } from '../../lib/display-labels.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';

export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: Role.User as Role });
  const [error, setError] = useState<string | null>(null);
  const [createdCreds, setCreatedCreds] = useState<{ username: string; password: string } | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => api.post<UserDto>('/users', body),
    onSuccess: (_user, variables) => {
      toast({ title: '用户已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      setCreatedCreds({ username: variables.username, password: variables.password });
      setForm({ username: '', displayName: '', password: '', role: Role.User });
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
      setForm({ username: '', displayName: '', password: '', role: Role.User });
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
              <SelectField
                id="new-user-role"
                label="角色"
                value={form.role}
                onChange={(value) => setForm((current) => ({ ...current, role: value as Role }))}
                options={ROLE_OPTIONS}
              />
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
