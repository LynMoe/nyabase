import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Capability } from '@nyabase/common';
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
  it('shows only the personal workspace to a user without admin capabilities', () => {
    const sections = visibleNavSections([]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items.map((item) => item.to)).toEqual([
      '/', '/containers', '/volumes', '/shared-volumes', '/http-proxy', '/usage',
    ]);
  });

  it('lists 全平台用量 for metrics viewers even without ManageServers', () => {
    const items = visibleNavSections([Capability.ViewMetricsAll]).flatMap((section) => section.items);
    expect(items.map((item) => item.to)).toContain('/servers/usage');
    expect(items.map((item) => item.to)).not.toContain('/servers');
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
    for (const item of NAV_SECTIONS.flatMap((section) => section.items)) {
      if (!item.access) continue;
      const key = Object.entries(ACCESS).find(([, rule]) => rule === item.access)?.[0];
      expect(key, item.to).toBeDefined();
      const routeFile = `${item.to.slice(1)}${item.to === '/servers/usage' ? '.tsx' : '/index.tsx'}`;
      expect(guarded.get(routeFile), item.to).toBe(key);
    }
  });
});
