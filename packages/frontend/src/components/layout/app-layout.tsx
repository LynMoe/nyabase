import { Link, useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ChevronsUpDown, Laptop, LogOut, Menu, Moon, Sun, UserCircle } from 'lucide-react';
import { Capability } from '@nyabase/common';
import { cn } from '../../lib/utils.js';
import { useAuthStore } from '../../store/auth.js';
import { useThemeStore, type ThemeMode } from '../../store/theme.js';
import { Button } from '../ui/button.js';
import { ScrollArea } from '../ui/scroll-area.js';
import { Avatar, AvatarFallback } from '../ui/avatar.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import {
  Sheet, SheetContent, SheetDescription, SheetTitle,
} from '../ui/sheet.js';
import { TooltipProvider } from '../ui/tooltip.js';
import { usePublicSettings } from '../../hooks/use-public-settings.js';
import { terminateBrowserSession } from '../../lib/session-termination.js';
import { activeNavPath, visibleNavSections, type NavSection } from '../../lib/navigation.js';
import { CertExpiryBanner } from './cert-expiry-banner.js';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Laptop },
];

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

function SidebarNav({
  sections,
  pathname,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = activeNavPath(pathname, sections);
  return (
    <nav className="flex flex-col gap-3 p-2 pb-4" aria-label="主导航">
      {sections.map((section) => (
        <div key={section.label} className="space-y-0.5">
          {sections.length > 1 ? (
            <p className="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/80">
              {section.label}
            </p>
          ) : null}
          {section.items.map((item) => {
            const isActive = item.to === active;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors md:py-1',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Account, theme and sign-out live together at the bottom, always in view. */
function AccountMenu({
  displayName,
  username,
  onNavigate,
}: {
  displayName?: string;
  username?: string;
  onNavigate?: () => void;
}) {
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="账号菜单"
          data-testid="account-menu"
        >
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs">{userInitials(displayName, username)}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{displayName || username}</span>
            <span className="block truncate text-xs text-muted-foreground">@{username}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-52">
        <DropdownMenuItem asChild>
          <Link to="/profile" onClick={onNavigate}>
            <UserCircle className="mr-2 h-4 w-4" />用户中心
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">主题</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if (value === 'light' || value === 'dark' || value === 'system') setMode(value);
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <option.icon className="mr-2 h-4 w-4" />{option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { void terminateBrowserSession(); }}>
          <LogOut className="mr-2 h-4 w-4" />退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarPanel({
  brandTitle,
  displayName,
  username,
  pathname,
  sections,
  onNavigate,
  brandClassName,
}: {
  brandTitle: string;
  displayName?: string;
  username?: string;
  pathname: string;
  sections: NavSection[];
  onNavigate?: () => void;
  brandClassName?: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('flex h-14 shrink-0 items-center border-b px-4', brandClassName)}>
        <Link to="/" onClick={onNavigate} className="truncate text-base font-semibold tracking-tight">
          {brandTitle}
        </Link>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <SidebarNav sections={sections} pathname={pathname} onNavigate={onNavigate} />
      </ScrollArea>
      <div className="shrink-0 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <AccountMenu displayName={displayName} username={username} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user } = useAuthStore();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { settings } = usePublicSettings();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const sections = visibleNavSections(user?.capabilities);
  const canManageCertificates = user?.capabilities.includes(Capability.ManageCertificates) ?? false;

  const sidebarProps = {
    brandTitle: settings.branding.title,
    displayName: user?.displayName,
    username: user?.username,
    pathname,
    sections,
  };

  return (
    <TooltipProvider delayDuration={200}>
      {/* Sheet portals; keep it out of the overflow-hidden chrome row. */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="flex h-full w-[min(18rem,calc(100vw-1.5rem))] flex-col gap-0 bg-card p-0 sm:max-w-[18rem]"
        >
          <SheetTitle className="sr-only">{settings.branding.title}</SheetTitle>
          <SheetDescription className="sr-only">主导航</SheetDescription>
          <SidebarPanel {...sidebarProps} onNavigate={() => setMobileNavOpen(false)} brandClassName="pr-12" />
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
            <CertExpiryBanner enabled={canManageCertificates} />
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
