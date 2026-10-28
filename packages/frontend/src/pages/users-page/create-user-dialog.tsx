import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Dices, Eye, EyeOff } from 'lucide-react';
import {
  MAX_USER_NOTE_LENGTH,
  Role,
  zCreateUserRequest,
  type CreateUserRequest,
  type UserDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { FormField, SelectField } from '../../components/layout/form-field.js';
import { ROLE_OPTIONS } from '../../lib/display-labels.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { copyOneTimeSecret, generateOneTimePassword } from '../../lib/one-time-secret.js';
import { useHasRole } from '../../lib/use-role.js';

const EMPTY_FORM = { username: '', displayName: '', password: '', note: '', role: Role.User as Role };

/** The initial password: typed, or generated (and then shown so it can be checked). */
function InitialPasswordField({
  value,
  onChange,
  shown,
  onShownChange,
}: {
  value: string;
  onChange: (value: string) => void;
  shown: boolean;
  onShownChange: (shown: boolean) => void;
}) {
  return (
    <FormField id="new-user-password" label="初始密码" hint="创建后显示一次，请转交用户。">
      <div className="flex gap-2">
        <Input
          id="new-user-password"
          type={shown ? 'text' : 'password'}
          className={shown ? 'font-mono' : undefined}
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={shown ? '隐藏密码' : '显示密码'}
          onClick={() => onShownChange(!shown)}
        >
          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          data-testid="new-user-random-password"
          onClick={() => {
            onChange(generateOneTimePassword());
            onShownChange(true);
          }}
        >
          <Dices className="h-4 w-4" />随机
        </Button>
      </div>
    </FormField>
  );
}

export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  // Only an admin hands out a role above user; user admins create plain users.
  const canChooseRole = useHasRole(Role.Admin);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdCreds, setCreatedCreds] = useState<{ username: string; password: string } | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => api.post<UserDto>('/users', body),
    onSuccess: (_user, variables) => {
      toast({ title: '用户已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      setCreatedCreds({ username: variables.username, password: variables.password });
      setForm(EMPTY_FORM);
      setShowPassword(false);
      setError(null);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const submit = () => {
    const parsed = zCreateUserRequest.safeParse({ ...form, note: form.note || null });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查用户信息');
      return;
    }
    create.mutate(parsed.data);
  };
  const update = (key: 'username' | 'displayName' | 'password' | 'note', value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setCreatedCreds(null);
      setForm(EMPTY_FORM);
      setShowPassword(false);
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
                关闭后无法再次查看。
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
              {(['username', 'displayName'] as const).map((key) => {
                const labels = { username: '用户名', displayName: '显示名称' } as const;
                return (
                  <FormField key={key} id={`new-user-${key}`} label={labels[key]}>
                    <Input
                      id={`new-user-${key}`}
                      value={form[key]}
                      onChange={(event) => update(key, event.target.value)}
                    />
                  </FormField>
                );
              })}
              <InitialPasswordField
                value={form.password}
                onChange={(value) => update('password', value)}
                shown={showPassword}
                onShownChange={setShowPassword}
              />
              <FormField id="new-user-note" label="备注（可选）" hint="仅管理员可见">
                <Textarea
                  id="new-user-note"
                  rows={2}
                  maxLength={MAX_USER_NOTE_LENGTH}
                  value={form.note}
                  onChange={(event) => update('note', event.target.value)}
                />
              </FormField>
              {canChooseRole ? (
                <SelectField
                  id="new-user-role"
                  label="角色"
                  value={form.role}
                  onChange={(value) => setForm((current) => ({ ...current, role: value as Role }))}
                  options={ROLE_OPTIONS}
                />
              ) : null}
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
