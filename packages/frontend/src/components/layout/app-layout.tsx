import { Link, useRouterState } from '@tanstack/react-router';
import React, { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Server, Container, Database, HardDrive, Layers, Users, ImageIcon,
  ScrollText, LogOut, Shield, UserCircle, Settings, Cable, Network, Globe, TriangleAlert,
  Menu,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useAuthStore } from '../../store/auth.js';
import { Button } from '../ui/button.js';
import { Separator } from '../ui/separator.js';
import { ScrollArea } from '../ui/scroll-area.js';
import { Avatar, AvatarFallback } from '../ui/avatar.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import {
  Sheet, SheetContent, SheetDescription, SheetTitle,
} from '../ui/sheet.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';
import { Capability, type IncusClientCertificateDto } from '@nyabase/common';
import { ThemeToggle } from '../theme-toggle.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';
import { terminateBrowserSession } from '../../lib/session-termination.js';
import { SSH_PROXY_STATUS_CAPABILITIES } from '../../lib/ssh-proxy-access.js';
import { HTTP_PROXY_STATUS_CAPABILITIES } from '../../lib/http-proxy-access.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { certExpiryBannerText, certExpiryWarning } from '../../lib/cert-expiry.js';

const userNavItems = [
  { to: '/', icon: LayoutDashboard, label: '资源概览' },
  { to: '/containers', icon: Container, label: '容器' },
  { to: '/volumes', icon: Database, label: '数据卷' },
  { to: '/shared-volumes', icon: HardDrive, label: '共享卷' },
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
  { to: '/manage/shared-volumes', icon: HardDrive, label: '共享卷管理', caps: [Capability.ManageSharedVolumes] },
  { to: '/ssh-proxy', icon: Cable, label: 'SSH 代理', caps: SSH_PROXY_STATUS_CAPABILITIES },
  { to: '/http-proxy-ops', icon: Globe, label: 'HTTP 代理', caps: HTTP_PROXY_STATUS_CAPABILITIES },
  { to: '/users', icon: Users, label: '用户', caps: [Capability.ManageUsers, Capability.ManageGrants] },
  { to: '/groups', icon: Shield, label: '用户组', caps: [Capability.ManageGroups, Capability.ManageGrants] },
  { to: '/audit', icon: ScrollText, label: '审计', caps: [Capability.ViewAudit] },
  { to: '/system-settings', icon: Settings, label: '系统设置', caps: [Capability.ManageSystemSettings] },
];

type NavItemDef = { to: string; icon: React.ComponentType<{ className?: string }>; label: string };

function userInitials(displayName?: string, username?: string): string {
  const source = (displayName ?? '').trim() || (username ?? '').trim();
  if (!source) return '?';
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = Array.from(words[0] ?? '')[0] ?? '';
    const second = Array.from(words[1] ?? '')[0] ?? '';
    return `${first}${second}`.toUpperCase();
  }
  return Array.from(source).slice(0, 2).join('').toUpperCase();
}

function NavItem({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItemDef;
  pathname: string;
  onNavigate?: () => void;
}) {
  const isActive = pathname === item.to
    || (item.to !== '/' && (pathname === `${item.to}/` || pathname.startsWith(`${item.to}/`)));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={item.to}
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            isActive
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <item.icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{item.label}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function SidebarPanel({
  brandTitle,
  displayName,
  username,
  pathname,
  visibleAdminNav,
  onLogout,
  onNavigate,
  brandClassName,
}: {
  brandTitle: string;
  displayName?: string;
  username?: string;
  pathname: string;
  visibleAdminNav: NavItemDef[];
  onLogout: () => void;
  onNavigate?: () => void;
  brandClassName?: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('flex h-14 items-center px-4', brandClassName)}>
        <span className="truncate text-lg font-semibold">{brandTitle}</span>
      </div>

      <Separator />

      <div className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs">
              {userInitials(displayName, username)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{username}</p>
          </div>
        </div>
        <Link
          to="/profile"
          onClick={onNavigate}
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

      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col p-2 pb-3">
          <div className="space-y-0.5">
            {userNavItems.map((item) => (
              <NavItem key={item.to} item={item} pathname={pathname} onNavigate={onNavigate} />
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
                  <NavItem key={item.to} item={item} pathname={pathname} onNavigate={onNavigate} />
                ))}
              </div>
            </>
          )}

          <div className="my-2 border-t border-border" />
          <div className="space-y-0.5">
            <ThemeToggle className="w-full justify-start gap-3 text-muted-foreground" />
            <Button
              variant="ghost"
              className="w-full justify-start gap-3 text-muted-foreground"
              onClick={onLogout}
            >
              <LogOut className="h-4 w-4" />
              退出登录
            </Button>
          </div>
        </nav>
      </ScrollArea>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user } = useAuthStore();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { settings } = usePublicSettings();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleLogout = async () => {
    await terminateBrowserSession();
  };

  const closeMobileNav = () => setMobileNavOpen(false);

  const userCaps = new Set(user?.capabilities ?? []);
  const canManageCertificates = userCaps.has(Capability.ManageCertificates);
  const canViewCertificate = canManageCertificates || userCaps.has(Capability.ManageServers);
  const certificateQuery = useQuery({
    queryKey: queryKeys.certificate,
    queryFn: () => api.get<IncusClientCertificateDto>('/admin/incus-client-certificate'),
    enabled: canViewCertificate,
    staleTime: 60_000,
  });
  const certificate = certificateQuery.data;
  const certWarning = certificate ? certExpiryWarning(certificate.notAfter) : null;
  const certBannerServerId = certificate?.servers[0]?.serverId;

  const visibleAdminNav = adminNavItems.filter((item) => item.caps.some((capability) => userCaps.has(capability)));

  const sidebarProps = {
    brandTitle: settings.branding.title,
    displayName: user?.displayName,
    username: user?.username,
    pathname,
    visibleAdminNav,
    onLogout: () => { void handleLogout(); },
  };

  return (
    <TooltipProvider>
      {/* Sheet portals; keep it out of the overflow-hidden chrome row. */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="flex h-full w-[min(18rem,calc(100vw-1.5rem))] flex-col gap-0 bg-card p-0 sm:max-w-[18rem]"
        >
          <SheetTitle className="sr-only">{settings.branding.title}</SheetTitle>
          <SheetDescription className="sr-only">主导航</SheetDescription>
          <SidebarPanel {...sidebarProps} onNavigate={closeMobileNav} brandClassName="pr-12" />
        </SheetContent>
      </Sheet>

      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-56 shrink-0 flex-col border-r bg-card md:flex">
          <SidebarPanel {...sidebarProps} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b bg-card px-3 pt-[env(safe-area-inset-top)] md:hidden">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="打开导航"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <span className="truncate font-semibold">{settings.branding.title}</span>
          </header>

          <main className="flex-1 overflow-auto">
            {certWarning && certificate && (
              <Alert
                variant="destructive"
                className="rounded-none border-x-0 border-t-0 px-4 py-3"
                data-testid="cert-expiry-banner"
              >
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <span>{certExpiryBannerText(certificate.notAfter)}</span>
                  {certBannerServerId ? (
                    <Link to="/servers/$id" params={{ id: certBannerServerId }} className="underline">
                      前往轮换
                    </Link>
                  ) : (
                    <Link to="/servers" className="underline">前往服务器</Link>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
