import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { loginFailureMessage } from '../lib/login-form-error.js';
import { useAuthStore } from '../store/auth.js';
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { FormField } from '../components/layout/form-field.js';
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
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center space-y-1">
          <CardTitle className="text-2xl">{settings.branding.title}</CardTitle>
          <CardDescription>{settings.branding.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {reasonBanner && (
            <Alert className="mb-4 bg-muted/50">
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription>{reasonBanner}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={handleLogin} className="space-y-4">
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <FormField id="username" label="用户名" error={fieldErr.username}>
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
            </FormField>
            <FormField id="password" label="密码" error={fieldErr.password}>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFormError(null);
                }}
                placeholder="请输入密码"
                aria-invalid={!!fieldErr.password}
                required
              />
            </FormField>
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
