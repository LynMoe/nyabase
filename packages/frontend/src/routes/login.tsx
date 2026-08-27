import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { loginFailureMessage } from '../lib/login-form-error.js';
import { useAuthStore } from '../store/auth.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { zLoginRequest } from '@nyabase/common';
import { usePublicSettings } from '../hooks/use-public-settings.js';
import { sanitizeInternalRedirect } from '../lib/internal-redirect.js';

function loginReasonBanner(reason: string | undefined): string | null {
  switch (reason) {
    case 'password-changed':
      return '密码已变更，原会话已安全结束。请使用新密码登录。';
    case 'account-changed':
      return '账号状态已变更，原会话已安全结束。请重新登录。';
    case 'session-expired':
      return '登录已过期，请重新登录。';
    default:
      return null;
  }
}

function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErr, setFieldErr] = useState<{ username?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { user, status } = useAuthStore();
  const { redirect, reason } = Route.useSearch();
  const safeRedirect = sanitizeInternalRedirect(redirect);
  const { settings } = usePublicSettings();
  const reasonBanner = loginReasonBanner(reason);

  useEffect(() => {
    if (user && status === 'authenticated') window.location.replace(safeRedirect);
  }, [user, status, safeRedirect]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = zLoginRequest.safeParse({ username, password });
    if (!parsed.success) {
      const errs: typeof fieldErr = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as 'username' | 'password' | undefined;
        if (key && !errs[key]) errs[key] = issue.message;
      }
      setFieldErr(errs);
      setFormError(null);
      return;
    }
    setFieldErr({});
    setFormError(null);
    setLoading(true);
    try {
      await api.login(parsed.data);
      window.location.replace(safeRedirect);
    } catch (err) {
        setFormError(loginFailureMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center space-y-1">
          <CardTitle className="text-2xl">{settings.branding.title}</CardTitle>
          <CardDescription>{settings.branding.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {reasonBanner && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {reasonBanner}
            </div>
          )}
          <form onSubmit={handleLogin} className="space-y-4">
            {formError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                {formError}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setFormError(null);
                }}
                placeholder="请输入用户名"
                aria-invalid={!!fieldErr.username}
                required
                autoFocus
              />
              {fieldErr.username && <p className="text-xs text-destructive">{fieldErr.username}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFormError(null);
                }}
                placeholder="••••••••"
                aria-invalid={!!fieldErr.password}
                required
              />
              {fieldErr.password && <p className="text-xs text-destructive">{fieldErr.password}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '登录中...' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: sanitizeInternalRedirect(search.redirect),
    reason: search.reason === 'password-changed'
      || search.reason === 'account-changed'
      || search.reason === 'session-expired'
      ? search.reason
      : undefined,
  }),
  component: LoginPage,
});
