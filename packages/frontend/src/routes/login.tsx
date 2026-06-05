import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuthStore } from '../store/auth.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import { toast } from '../hooks/use-toast.js';
import { zLoginRequest, type LoginResponse } from '@nyabase/common';

function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErr, setFieldErr] = useState<{ username?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const { setAuth, user } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate({ to: '/', replace: true });
  }, [user, navigate]);

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
      return;
    }
    setFieldErr({});
    setLoading(true);
    try {
      const res = await api.post<LoginResponse>('/auth/login', parsed.data);
      setAuth(res.accessToken, res.refreshToken, res.user);
      navigate({ to: '/', replace: true });
    } catch (err) {
      toast({
        title: '登录失败',
        description: err instanceof Error ? err.message : '用户名或密码错误',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center space-y-1">
          <CardTitle className="text-2xl">nyabase</CardTitle>
          <CardDescription>开发容器管理平台</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
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
                onChange={(e) => setPassword(e.target.value)}
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

export const Route = createFileRoute('/login')({ component: LoginPage });
