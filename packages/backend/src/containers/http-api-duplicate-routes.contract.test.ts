import { describe, expect, it } from 'vitest';
import { declaredRoutes } from '../http-api-routes.test-helper.js';

describe('HTTP API route uniqueness', () => {
  it('does not declare the same METHOD+path-pattern on two controllers', async () => {
    const declared = new Map<string, string[]>();
    for (const route of await declaredRoutes()) {
      const owners = declared.get(route.key) ?? [];
      owners.push(route.owner);
      declared.set(route.key, owners);
    }

    const duplicates = [...declared.entries()]
      .filter(([, owners]) => new Set(owners).size > 1)
      .map(([key, owners]) => `${key} -> ${[...new Set(owners)].join(', ')}`);

    expect(duplicates).toEqual([]);
  });

  it('mounts no resource under both /x and /admin/x', async () => {
    const adminResources = new Map<string, string>();
    const userResources = new Map<string, string>();
    for (const route of await declaredRoutes()) {
      const [first, second] = route.pattern.split('/');
      if (first === 'admin') {
        if (second) adminResources.set(second, route.owner);
      } else if (first) {
        userResources.set(first, route.owner);
      }
    }
    const both = [...adminResources.keys()].filter((resource) => userResources.has(resource));
    expect(both.map((resource) =>
      `${resource}: /${resource} (${userResources.get(resource)}) and /admin/${resource} (${adminResources.get(resource)})`))
      .toEqual([]);
  });

  it('keeps /admin/ only for resources that have no user counterpart', async () => {
    const adminResources = new Set<string>();
    for (const route of await declaredRoutes()) {
      const [first, second] = route.pattern.split('/');
      if (first === 'admin' && second) adminResources.add(second);
    }
    expect([...adminResources].sort()).toEqual([
      'catalog',
      'groups',
      'incus-client-certificate',
      'ip-pools',
      'metrics',
      'ssh-proxy',
      'system-settings',
    ]);
  });
});
