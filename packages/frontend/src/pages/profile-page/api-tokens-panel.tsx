import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Copy, KeySquare, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import type { CreateApiTokenRequest } from '@nyabase/common';
import { api } from '../../lib/api.js';
import {
  API_TOKEN_NAME_MAX,
  type ApiTokenDto,
  type ApiTokenFormErrors,
  apiTokenCreateError,
  apiTokenDeleteError,
  type CreatedApiTokenResponse,
  formatTokenTime,
  sortApiTokens,
  validateApiTokenForm,
} from '../../lib/api-tokens.js';
import { copyOneTimeSecret } from '../../lib/one-time-secret.js';
import { queryKeys } from '../../lib/query-keys.js';
import { relativeTime } from '../../lib/utils.js';
import { toast } from '../../hooks/use-toast.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
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
import { FormField } from '../../components/layout/form-field.js';

export function ApiTokensPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiTokenDto | null>(null);

  const queryKey = queryKeys.apiTokens(userId);
  const tokensQuery = useQuery({
    queryKey,
    queryFn: () => api.get<ApiTokenDto[]>('/auth/tokens'),
  });
  const tokens = sortApiTokens(tokensQuery.data ?? []);
  const { isFetching, refetch } = tokensQuery;

  const deleteToken = useMutation({
    mutationFn: (tokenId: string) => api.delete(`/auth/tokens/${tokenId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      toast({ title: 'API 令牌已删除' });
      setDeleteTarget(null);
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey });
      toast({ title: '删除失败', description: apiTokenDeleteError(e), variant: 'destructive' });
    },
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-4" data-testid="api-tokens-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <KeySquare className="h-4 w-4 shrink-0 text-primary mt-1" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">API 令牌</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              供脚本或命令行调用 API，请求时使用 <span className="font-mono">Authorization: Bearer &lt;令牌&gt;</span>。
              令牌拥有与本账号相同的权限；修改密码会吊销全部 API 令牌。
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="刷新 API 令牌"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            disabled={tokensQuery.isError}
            data-testid="api-token-create"
          >
            <Plus className="h-4 w-4" />创建令牌
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-background overflow-hidden">
        {tokensQuery.isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">正在加载 API 令牌...</div>
        ) : tokensQuery.isError ? (
          <div className="px-4 py-6 space-y-2 text-center">
            <p className="text-sm text-destructive">API 令牌加载失败，当前列表不可用</p>
            <Button size="sm" variant="outline" onClick={() => { void refetch(); }}>重试</Button>
          </div>
        ) : tokens.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <KeySquare className="h-8 w-8 mx-auto text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground mt-2">暂无 API 令牌</p>
          </div>
        ) : (
          <div className="divide-y divide-border max-h-80 overflow-y-auto">
            {tokens.map((token) => (
              <div key={token.id} className="flex items-start justify-between gap-3 px-3 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-all text-sm font-medium text-foreground">{token.name}</p>
                  <p className="text-xs text-muted-foreground">
                    创建于 {formatTokenTime(token.createdAt)}
                    <span className="mx-1.5">·</span>
                    <span title={token.lastUsedAt ? formatTokenTime(token.lastUsedAt) : undefined}>
                      最近使用：{relativeTime(token.lastUsedAt)}
                    </span>
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => setDeleteTarget(token)}
                  aria-label={`删除 API 令牌 ${token.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {createOpen ? (
        <CreateApiTokenDialog
          queryKey={queryKey}
          onOpenChange={(open) => { if (!open) setCreateOpen(false); }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 API 令牌？"
        description={
          <>
            将删除令牌「<span className="font-semibold text-foreground">{deleteTarget?.name}</span>」。
            使用它的脚本和工具会立即无法访问 API，此操作不可撤销。
          </>
        }
        confirmLabel="删除"
        pendingLabel="删除中..."
        pending={deleteToken.isPending}
        onConfirm={() => { if (deleteTarget) deleteToken.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </section>
  );
}

function CreateApiTokenDialog({
  queryKey,
  onOpenChange,
}: {
  queryKey: readonly unknown[];
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const nameId = 'api-token-name';
  const passwordId = 'api-token-current-password';
  const [form, setForm] = useState({ name: '', currentPassword: '' });
  const [errors, setErrors] = useState<ApiTokenFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiTokenResponse | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateApiTokenRequest) => api.post<CreatedApiTokenResponse>('/auth/tokens', body),
    onSuccess: (response) => {
      void qc.invalidateQueries({ queryKey });
      toast({ title: 'API 令牌已创建' });
      setForm({ name: '', currentPassword: '' });
      setErrors({});
      setFormError(null);
      setCreated(response);
    },
    onError: (e) => {
      const failure = apiTokenCreateError(e);
      setForm((f) => ({ ...f, currentPassword: '' }));
      if (failure.field) {
        setErrors({ [failure.field]: failure.message });
        setFormError(null);
      } else {
        setErrors({});
        setFormError(failure.message);
      }
    },
  });

  const submit = () => {
    const result = validateApiTokenForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(null);
    create.mutate(result.body);
  };

  const copySecret = async () => {
    if (!created) return;
    const ok = await copyOneTimeSecret(created.secret);
    toast({
      title: ok ? 'API 令牌已复制' : '复制失败',
      description: ok ? undefined : '请手动选中令牌复制',
      variant: ok ? 'default' : 'destructive',
    });
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!(create.isPending && !next)) onOpenChange(next); }}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>API 令牌已创建</DialogTitle>
              <DialogDescription>令牌「{created.token.name}」已生效，请立即复制并妥善保存。</DialogDescription>
            </DialogHeader>
            <Alert variant="warning">
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>
                令牌明文只显示这一次，关闭后无法再次查看；遗失后只能删除并重新创建。
              </AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">令牌（仅此一次）</p>
              <p className="break-all rounded-md border bg-muted/30 p-2 font-mono text-sm" data-testid="api-token-secret">
                {created.secret}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { void copySecret(); }}>
                <Copy className="h-4 w-4" />复制令牌
              </Button>
              <Button onClick={() => onOpenChange(false)}>我已保存，关闭</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>创建 API 令牌</DialogTitle>
              <DialogDescription>
                创建令牌需要验证当前密码。令牌长期有效，直到被删除或修改密码。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <FormField id={nameId} label="名称" error={errors.name}>
                <Input
                  id={nameId}
                  value={form.name}
                  maxLength={API_TOKEN_NAME_MAX}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="例如 ci-deploy"
                  aria-invalid={!!errors.name}
                  autoComplete="off"
                />
              </FormField>
              <FormField id={passwordId} label="当前密码" error={errors.currentPassword}>
                <Input
                  id={passwordId}
                  type="password"
                  value={form.currentPassword}
                  onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !create.isPending) submit(); }}
                  aria-invalid={!!errors.currentPassword}
                  autoComplete="current-password"
                />
              </FormField>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>取消</Button>
              <Button onClick={submit} disabled={create.isPending}>
                {create.isPending ? '创建中...' : '创建'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
