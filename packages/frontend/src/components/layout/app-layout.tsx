import { Link, useRouterState } from '@tanstack/react-router';
import React, { type ReactNode } from 'react';
import {
  LayoutDashboard, Server, Container, Layers, Users, ImageIcon,
  ScrollText, FolderOpen, LogOut, Shield, UserCircle, Network, Settings, Cable, Globe,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useAuthStore } from '../../store/auth.js';
import { api } from '../../lib/api.js';
import { Button } from '../ui/button.js';
import { Separator } from '../ui/separator.js';
import { Capability } from '@nyabase/common';
import { ThemeToggle } from '../theme-toggle.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';

const userNavItems = [
  { to: '/', icon: LayoutDashboard, label: '监控大屏' },
  { to: '/containers', icon: Container, label: '容器' },
  { to: '/http-proxy', icon: Globe, label: 'HTTP 反代' },
  { to: '/data-dirs', icon: FolderOpen, label: '数据目录' },
];

const adminNavItems = [
  { to: '/servers', icon: Server, label: '服务器', caps: [Capability.ManageServers] },
  { to: '/images', icon: ImageIcon, label: '镜像', caps: [Capability.ManageImages] },
  { to: '/manage/containers', icon: Layers, label: '容器管理', caps: [Capability.ManageContainersAny] },
  { to: '/manage/remote-fs', icon: Network, label: '远程文件系统', caps: [Capability.ManageServers] },
  { to: '/ssh-proxy', icon: Cable, label: 'SSH 代理', caps: [Capability.ViewMetricsAll, Capability.ManageSystemSettings] },
  { to: '/users', icon: Users, label: '用户', caps: [Capability.ManageUsers] },
  { to: '/groups', icon: Shield, label: '用户组', caps: [Capability.ManageGroups] },
  { to: '/audit', icon: ScrollText, label: '审计', caps: [Capability.ViewAudit] },
  { to: '/system-settings', icon: Settings, label: '系统设置', caps: [Capability.ManageSystemSettings] },
];

type NavItemDef = { to: string; icon: React.ComponentType<{ className?: string }>; label: string };

function NavItem({ item, pathname }: { item: NavItemDef; pathname: string }) {
  const isActive = pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to));
  return (
    <Link
      to={item.to}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {item.label}
    </Link>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, clearAuth, refreshToken } = useAuthStore();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { settings } = usePublicSettings();

  const handleLogout = async () => {
    try {
      if (refreshToken) await api.post('/auth/logout', { refreshToken });
    } catch {}
    clearAuth();
    // __root.tsx useEffect handles redirect to /login when user becomes null
  };

  const userCaps = new Set(user?.capabilities ?? []);

  const visibleAdminNav = adminNavItems.filter((item) => item.caps.some((capability) => userCaps.has(capability)));

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 border-r bg-card flex flex-col shrink-0">
        {/* Logo */}
        <div className="px-4 h-14 flex items-center">
          <span className="font-semibold text-lg truncate">{settings.branding.title}</span>
        </div>

        <Separator />

        {/* User info */}
        <div className="px-4 py-3">
          <p className="text-sm font-medium truncate">{user?.displayName}</p>
          <p className="text-xs text-muted-foreground truncate">{user?.username}</p>
          <Link
            to="/profile"
            className={cn(
              'mt-1.5 flex items-center gap-1.5 text-xs transition-colors',
              pathname === '/profile'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <UserCircle className="h-3 w-3" />
            用户中心
          </Link>
        </div>

        <Separator />

        {/* Nav */}
        <nav className="flex-1 p-2 overflow-y-auto flex flex-col">
          <div className="space-y-0.5">
            {userNavItems.map((item) => (
              <NavItem key={item.to} item={item} pathname={pathname} />
            ))}
          </div>

          {visibleAdminNav.length > 0 && (
            <>
              <div className="my-2 border-t border-border" />
              <div className="space-y-0.5">
                {visibleAdminNav.map((item) => (
                  <NavItem key={item.to} item={item} pathname={pathname} />
                ))}
              </div>
            </>
          )}
        </nav>

        <Separator />

        {/* Theme + logout */}
        <div className="p-2 space-y-1">
          <ThemeToggle className="w-full justify-start gap-3 text-muted-foreground" />
          <Button
            variant="ghost"
            className="w-full justify-start gap-3 text-muted-foreground"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
