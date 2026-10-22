import type { Role } from '@nyabase/common';
import {
  Activity,
  Box,
  Boxes,
  Cable,
  ChartColumn,
  Database,
  FolderTree,
  Globe,
  HardDrive,
  ImageIcon,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Network,
  ScrollText,
  Server,
  Settings,
  Shield,
  Users,
  Waypoints,
} from 'lucide-react';
import { ACCESS, type AccessRule, canAccess } from './route-access.js';

export type NavItem = {
  to: string;
  icon: LucideIcon;
  label: string;
  /** Omitted for surfaces every signed-in user has. */
  access?: AccessRule;
};

export type NavSection = {
  /** The personal section's label only shows when admin sections follow it. */
  label: string;
  items: NavItem[];
};

/**
 * Sidebar structure. The first section is the personal workspace; admin
 * surfaces are grouped by what the operator is looking after. Every item has
 * its own icon so the collapsed mobile sheet is still scannable.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: '我的',
    items: [
      { to: '/', icon: LayoutDashboard, label: '概览' },
      { to: '/containers', icon: Box, label: '容器' },
      { to: '/volumes', icon: HardDrive, label: '数据卷' },
      { to: '/shared-volumes', icon: FolderTree, label: '共享卷' },
      { to: '/http-proxy', icon: Globe, label: 'HTTP 发布' },
      { to: '/usage', icon: Activity, label: '使用情况' },
    ],
  },
  {
    label: '基础设施',
    items: [
      { to: '/servers', icon: Server, label: '服务器', access: ACCESS.servers },
      { to: '/ip-pools', icon: Network, label: 'IP 池', access: ACCESS.ipPools },
      { to: '/shared-backends', icon: Database, label: '共享存储', access: ACCESS.sharedBackends },
      { to: '/images', icon: ImageIcon, label: '镜像', access: ACCESS.images },
    ],
  },
  {
    label: '运行',
    items: [
      { to: '/manage/containers', icon: Boxes, label: '全平台容器', access: ACCESS.manageContainers },
      { to: '/ops', icon: ListChecks, label: '操作记录', access: ACCESS.ops },
      { to: '/servers/usage', icon: ChartColumn, label: '全平台用量', access: ACCESS.adminUsage },
      { to: '/ssh-proxy', icon: Cable, label: 'SSH 代理', access: ACCESS.sshProxy },
      { to: '/http-proxy-ops', icon: Waypoints, label: 'HTTP 代理', access: ACCESS.httpProxyOps },
    ],
  },
  {
    label: '访问控制',
    items: [
      { to: '/users', icon: Users, label: '用户', access: ACCESS.users },
      { to: '/groups', icon: Shield, label: '用户组', access: ACCESS.groups },
      { to: '/audit', icon: ScrollText, label: '审计日志', access: ACCESS.audit },
      { to: '/system-settings', icon: Settings, label: '系统设置', access: ACCESS.systemSettings },
    ],
  },
];

export function visibleNavSections(role: Role | undefined): NavSection[] {
  return NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.access || canAccess(role, item.access)),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * The item a pathname belongs to: the longest `to` that is the path itself or
 * a parent of it, so `/servers/usage` lights 全平台用量 rather than 服务器.
 */
export function activeNavPath(pathname: string, sections: NavSection[]): string | null {
  let best: string | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      const matches = pathname === item.to || (item.to !== '/' && pathname.startsWith(`${item.to}/`));
      if (matches && (best === null || item.to.length > best.length)) best = item.to;
    }
  }
  return best;
}
