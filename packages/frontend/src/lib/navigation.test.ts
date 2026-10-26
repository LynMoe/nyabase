import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Role } from '@nyabase/common';
import { activeNavPath, NAV_SECTIONS, visibleNavSections } from './navigation.js';
import { ACCESS } from './route-access.js';

const routesRoot = join(dirname(fileURLToPath(import.meta.url)), '../routes');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full) : [full];
  });
}

describe('sidebar navigation', () => {
  it('shows only the personal workspace to a plain user', () => {
    const sections = visibleNavSections(Role.User);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items.map((item) => item.to)).toEqual([
      '/', '/containers', '/volumes', '/shared-volumes', '/http-proxy', '/usage',
    ]);
  });

  it('offers user admins people and their resources, but no infrastructure', () => {
    const items = visibleNavSections(Role.UserAdmin).flatMap((section) => section.items).map((item) => item.to);
    for (const to of ['/users', '/groups', '/manage/containers', '/manage/volumes', '/ops', '/servers/usage',
      '/ssh-proxy', '/audit']) {
      expect(items).toContain(to);
    }
    for (const to of ['/servers', '/network', '/shared-backends', '/images', '/http-proxy-ops', '/system-settings']) {
      expect(items).not.toContain(to);
    }
  });

  it('offers admins every page', () => {
    const items = visibleNavSections(Role.Admin).flatMap((section) => section.items).map((item) => item.to);
    expect(items).toContain('/network');
    expect(items).toContain('/shared-backends');
    expect(items).toContain('/groups');
  });

  it('never repeats a label or an icon', () => {
    const items = NAV_SECTIONS.flatMap((section) => section.items);
    expect(new Set(items.map((item) => item.label)).size).toBe(items.length);
    expect(new Set(items.map((item) => item.icon)).size).toBe(items.length);
  });

  it('lights the most specific item for nested paths', () => {
    expect(activeNavPath('/servers/usage', NAV_SECTIONS)).toBe('/servers/usage');
    expect(activeNavPath('/servers/srv-1', NAV_SECTIONS)).toBe('/servers');
    expect(activeNavPath('/manage/containers/c1', NAV_SECTIONS)).toBe('/manage/containers');
    expect(activeNavPath('/profile', NAV_SECTIONS)).toBeNull();
    expect(activeNavPath('/', NAV_SECTIONS)).toBe('/');
  });

  it('guards each admin route with the same rule the sidebar uses', () => {
    const guarded = new Map<string, string>();
    for (const file of routeFiles(routesRoot)) {
      const match = readFileSync(file, 'utf8').match(/RequireAccess rule=\{ACCESS\.(\w+)\}/);
      if (match?.[1]) guarded.set(relative(routesRoot, file), match[1]);
    }
    const navSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'navigation.ts'), 'utf8');
    for (const item of NAV_SECTIONS.flatMap((section) => section.items)) {
      if (!item.access) continue;
      const key = navSource.match(new RegExp(`to: '${item.to}'[^\\n]*access: ACCESS\\.(\\w+)`))?.[1];
      expect(key, item.to).toBeDefined();
      expect(ACCESS[key as keyof typeof ACCESS], item.to).toBe(item.access);
      const routeFile = `${item.to.slice(1)}${item.to === '/servers/usage' ? '.tsx' : '/index.tsx'}`;
      expect(guarded.get(routeFile), item.to).toBe(key);
    }
  });
});
