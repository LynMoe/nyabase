import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, UserCircle } from 'lucide-react';
import { zAddSshKeyRequest, zUpdateUserRequest } from '@nyabase/common';
import type { SshPublicKeyDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/auth.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { toast } from '../hooks/use-toast.js';

type PasswordErrors = Partial<Record<'currentPassword' | 'newPassword' | 'confirmPassword', string>>;
type SshKeyErrors = Partial<Record<'name' | 'keyText', string>>;

export default function ProfilePage() {
  const { user } = useAuthStore();

  if (!user) return null;

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full max-w-5xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">用户中心</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            管理账号密码和用于容器 SSH 登录的公钥
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <UserCircle className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{user.displayName}</p>
            <p className="text-xs text-muted-foreground font-mono truncate">@{user.username}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] gap-4">
        <PasswordPanel userId={user.id} />
        <SshKeysPanel userId={user.id} />
      </div>
    </div>
  );
}

function PasswordPanel({ userId }: { userId: string }) {
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
      toast({ title: '密码已修改' });
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setErrors({});
    },
    onError: (e) => toast({ title: '修改失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div className="flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 text-primary mt-1 shrink-0" />
        <div>
          <h2 className="text-base font-semibold text-foreground">修改密码</h2>
          <p className="text-xs text-muted-foreground mt-0.5">修改当前账号密码需要验证旧密码。</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={curId} className="text-sm">当前密码</Label>
          <Input
            id={curId}
            type="password"
            value={form.currentPassword}
            onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
            aria-invalid={!!errors.currentPassword}
            autoComplete="current-password"
          />
          {errors.currentPassword && <p className="text-xs text-destructive">{errors.currentPassword}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={newId} className="text-sm">新密码</Label>
          <Input
            id={newId}
            type="password"
            value={form.newPassword}
            onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
            aria-invalid={!!errors.newPassword}
            autoComplete="new-password"
          />
          {errors.newPassword && <p className="text-xs text-destructive">{errors.newPassword}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={confirmId} className="text-sm">确认新密码</Label>
          <Input
            id={confirmId}
            type="password"
            value={form.confirmPassword}
            onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
            aria-invalid={!!errors.confirmPassword}
            autoComplete="new-password"
          />
          {errors.confirmPassword && <p className="text-xs text-destructive">{errors.confirmPassword}</p>}
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => { if (validate()) mutate(); }} disabled={isPending}>
          {isPending ? '修改中...' : '确认修改'}
        </Button>
      </div>
    </section>
  );
}

function SshKeysPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', keyText: '' });
  const [errors, setErrors] = useState<SshKeyErrors>({});
  const [deleteTarget, setDeleteTarget] = useState<SshPublicKeyDto | null>(null);
  const [nameTouched, setNameTouched] = useState(false);

  const queryKey = ['ssh-keys', userId];
  const { data: keys = [], isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => api.get<SshPublicKeyDto[]>(`/users/${userId}/ssh-keys`),
  });

  const validate = () => {
    const resolvedName = resolveKeyName(form.name, form.keyText);
    const parsed = zAddSshKeyRequest.safeParse({
      name: resolvedName,
      keyText: form.keyText.trim(),
    });
    if (parsed.success) {
      if (form.name.trim() !== resolvedName) setForm((f) => ({ ...f, name: resolvedName }));
      setErrors({});
      return true;
    }

    const errs: SshKeyErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === 'name' && !errs.name) errs.name = issue.message;
      if (field === 'keyText' && !errs.keyText) errs.keyText = issue.message;
    }
    setErrors(errs);
    return false;
  };

  const addKey = useMutation({
    mutationFn: () => api.post<SshPublicKeyDto>(`/users/${userId}/ssh-keys`, {
      name: resolveKeyName(form.name, form.keyText),
      keyText: form.keyText.trim(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      toast({ title: 'SSH 公钥已添加' });
      setForm({ name: '', keyText: '' });
      setErrors({});
      setNameTouched(false);
    },
    onError: (e) => toast({ title: '添加失败', description: e.message, variant: 'destructive' }),
  });

  const deleteKey = useMutation({
    mutationFn: (keyId: string) => api.delete(`/users/${userId}/ssh-keys/${keyId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      toast({ title: 'SSH 公钥已删除' });
      setDeleteTarget(null);
    },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2">
          <KeyRound className="h-4 w-4 text-primary mt-1 shrink-0" />
          <div>
            <h2 className="text-base font-semibold text-foreground">SSH 公钥</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              容器启用 Dropbear SSH 后，会使用这里的公钥以 root 登录容器。
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground self-end sm:self-auto"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="刷新 SSH 公钥"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-background overflow-hidden">
        {keys.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <KeyRound className="h-8 w-8 mx-auto text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground mt-2">暂无 SSH 公钥</p>
            <p className="text-xs text-muted-foreground/70 mt-1">添加公钥后即可用于容器 SSH 登录。</p>
          </div>
        ) : (
          <div className="divide-y divide-border max-h-80 overflow-y-auto">
            {keys.map((key) => (
              <div key={key.id} className="flex items-start justify-between gap-3 px-3 py-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{key.name}</span>
                    <span className="text-xs text-muted-foreground">{formatCreatedAt(key.createdAt)}</span>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground break-all">{previewKey(key.keyText)}</p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-red-400 hover:text-red-600 shrink-0"
                  onClick={() => setDeleteTarget(key)}
                  aria-label={`删除 SSH 公钥 ${key.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-background p-3 space-y-3">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">添加公钥</h3>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ssh-key-text" className="text-sm">公钥内容</Label>
            <textarea
              id="ssh-key-text"
              value={form.keyText}
              onChange={(e) => {
                const keyText = e.target.value;
                setForm((f) => {
                  const inferredName = inferKeyName(keyText);
                  return {
                    ...f,
                    keyText,
                    name: !nameTouched && inferredName ? inferredName : f.name,
                  };
                });
              }}
              placeholder="ssh-ed25519 AAAA..."
              rows={3}
              aria-invalid={!!errors.keyText}
              className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {errors.keyText && <p className="text-xs text-destructive">{errors.keyText}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ssh-key-name" className="text-sm">名称</Label>
            <Input
              id="ssh-key-name"
              value={form.name}
              onChange={(e) => {
                setNameTouched(true);
                setForm((f) => ({ ...f, name: e.target.value }));
              }}
              placeholder="留空则从公钥注释提取，或自动生成"
              aria-invalid={!!errors.name}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => { if (validate()) addKey.mutate(); }}
            disabled={addKey.isPending}
          >
            <Plus className="h-4 w-4" />
            {addKey.isPending ? '添加中...' : '添加公钥'}
          </Button>
        </div>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 SSH 公钥？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除公钥 <span className="font-semibold text-foreground">{deleteTarget?.name}</span>。
              已启用 SSH 的容器会在下次同步后不再接受这把公钥。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) deleteKey.mutate(deleteTarget.id); }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function previewKey(keyText: string) {
  const parts = keyText.trim().split(/\s+/);
  if (parts.length < 2) return keyText.trim();
  const type = parts[0];
  const body = parts[1];
  const suffix = parts.slice(2).join(' ');
  const compact = body.length > 28 ? `${body.slice(0, 18)}...${body.slice(-10)}` : body;
  return [type, compact, suffix].filter(Boolean).join(' ');
}

function inferKeyName(keyText: string) {
  const parts = keyText.trim().split(/\s+/);
  const comment = parts.slice(2).join(' ').trim();
  return comment || '';
}

function resolveKeyName(name: string, keyText: string) {
  const trimmedName = name.trim();
  if (trimmedName) return trimmedName;
  const inferred = inferKeyName(keyText);
  if (inferred) return inferred;

  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    'ssh-key',
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join('-');
}

function formatCreatedAt(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
