import { Link, useRouterState } from '@tanstack/react-router';
import React, { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Server, Container, Database, HardDrive, Layers, Users, ImageIcon,
  ScrollText, LogOut, Shield, UserCircle, Settings, Cable, Network, Globe, TriangleAlert,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useAuthStore } from '../../store/auth.js';
import { Button } from '../ui/button.js';
import { Separator } from '../ui/separator.js';
import { Capability, type IncusClientCertificateDto } from '@nyabase/common';
import { ThemeToggle } from '../theme-toggle.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';
import { terminateBrowserSession } from '../../lib/session-termination.js';
import { SSH_PROXY_STATUS_CAPABILITIES } from '../../lib/ssh-proxy-access.js';
import { HTTP_PROXY_STATUS_CAPABILITIES } from '../../lib/http-proxy-access.js';
import { api } from '../../lib/api.js';
import { certExpiryBannerText, certExpiryWarning } from '../../lib/cert-expiry.js';

const userNavItems = [
  { to: '/', icon: LayoutDashboard, label: '资源概览' },
  { to: '/containers', icon: Container, label: '容器' },
  { to: '/volumes', icon: Database, label: '数据卷' },
  { to: '/http-proxy', icon: Globe, label: 'HTTP 发布' },
];

const adminNavItems = [
  { to: '/servers', icon: Server, label: '服务器', caps: [Capability.ManageServers] },
  { to: '/ip-pools', icon: Network, label: 'IP 池', caps: [Capability.ManageIpPools] },
  { to: '/storage-pools', icon: HardDrive, label: '存储池', caps: [Capability.ManageStoragePools] },
  { to: '/shared-backends', icon: Database, label: '共享存储', caps: [Capability.ManageSharedBackends] },
  { to: '/images', icon: ImageIcon, label: '镜像', caps: [Capability.ManageImages] },
  { to: '/manage/containers', icon: Layers, label: '容器管理', caps: [Capability.ManageContainersAny] },
  { to: '/manage/volumes', icon: Database, label: '数据卷管理', caps: [Capability.ManageVolumes] },
  { to: '/ssh-proxy', icon: Cable, label: 'SSH 代理', caps: SSH_PROXY_STATUS_CAPABILITIES },
  { to: '/http-proxy-ops', icon: Globe, label: 'HTTP 代理', caps: HTTP_PROXY_STATUS_CAPABILITIES },
  { to: '/users', icon: Users, label: '用户', caps: [Capability.ManageUsers, Capability.ManageGrants] },
  { to: '/groups', icon: Shield, label: '用户组', caps: [Capability.ManageGroups, Capability.ManageGrants] },
  { to: '/audit', icon: ScrollText, label: '审计', caps: [Capability.ViewAudit] },
  { to: '/system-settings', icon: Settings, label: '系统设置', caps: [Capability.ManageSystemSettings] },
];

type NavItemDef = { to: string; icon: React.ComponentType<{ className?: string }>; label: string };

function NavItem({ item, pathname }: { item: NavItemDef; pathname: string }) {
  const isActive = pathname === item.to
    || (item.to !== '/' && (pathname === `${item.to}/` || pathname.startsWith(`${item.to}/`)));
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
  const { user } = useAuthStore();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { settings } = usePublicSettings();

  const handleLogout = async () => {
    await terminateBrowserSession();
  };

  const userCaps = new Set(user?.capabilities ?? []);
  const canManageCertificates = userCaps.has(Capability.ManageCertificates);
  const canViewCertificate = canManageCertificates || userCaps.has(Capability.ManageServers);
  const certificateQuery = useQuery({
    queryKey: ['incus-client-certificate'],
    queryFn: () => api.get<IncusClientCertificateDto>('/admin/incus-client-certificate'),
    enabled: canViewCertificate,
    staleTime: 60_000,
  });
  const certificate = certificateQuery.data;
  const certWarning = certificate ? certExpiryWarning(certificate.notAfter) : null;
  const certBannerServerId = certificate?.servers[0]?.serverId;

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
              <p className="px-3 pb-1 pt-1 text-[11px] font-medium tracking-wide text-muted-foreground">
                管理
              </p>
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
        {certWarning && certificate && (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
            data-testid="cert-expiry-banner"
          >
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span>{certExpiryBannerText(certificate.notAfter)}</span>
            {certBannerServerId ? (
              <Link to="/servers/$id" params={{ id: certBannerServerId }} className="underline">
                前往轮换
              </Link>
            ) : (
              <Link to="/servers" className="underline">前往服务器</Link>
            )}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
