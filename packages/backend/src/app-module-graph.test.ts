import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { ContainerReconciler } from './containers/container-reconciler.service.js';
import { ContainersModule } from './containers/containers.module.js';
import { ImageAssignmentReconciler } from './images/image-assignment-reconciler.service.js';
import { ImagesModule } from './images/images.module.js';
import { ServerHealthService } from './servers/server-health.service.js';
import { ServerPreflightReconciler } from './servers/server-preflight-reconciler.service.js';
import { ServersModule } from './servers/servers.module.js';
import { VolumeReconciler } from './volumes/volume-reconciler.service.js';
import { VolumesModule } from './volumes/volumes.module.js';

type ModuleLike = {
  name?: string;
  module?: ModuleLike;
  forwardRef?: () => ModuleLike;
};

function providersOf(module: object): unknown[] {
  return Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) as unknown[];
}

function unwrapModule(value: ModuleLike): ModuleLike {
  if (typeof value.forwardRef === 'function') return value.forwardRef();
  if (value.module) return value.module;
  return value;
}

describe('production AppModule graph', () => {
  it('contains no undefined imports, including imports hidden by forwardRef', () => {
    const visited = new Set<ModuleLike>();
    const pending: ModuleLike[] = [AppModule as unknown as ModuleLike];

    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, current) as unknown[] | undefined;
      for (const imported of imports ?? []) {
        expect(imported, `${current.name ?? '(anonymous module)'} has an undefined import`).toBeDefined();
        const resolved = unwrapModule(imported as ModuleLike);
        expect(
          resolved,
          `${current.name ?? '(anonymous module)'} has a forwardRef that resolves to undefined`,
        ).toBeDefined();
        pending.push(resolved);
      }
    }

    expect(visited.size).toBeGreaterThan(10);
  });
});

describe('module import rules', () => {
  const collect = () => {
    const edges = new Map<ModuleLike, ModuleLike[]>();
    const pending: ModuleLike[] = [AppModule as unknown as ModuleLike];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (edges.has(current)) continue;
      const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, current) as unknown[] | undefined) ?? [];
      const resolved = imports.map((imported) => {
        const module = imported as ModuleLike;
        expect(
          typeof module.forwardRef,
          `${current.name} imports ${module.name} through forwardRef`,
        ).not.toBe('function');
        return unwrapModule(module);
      });
      edges.set(current, resolved);
      pending.push(...resolved);
    }
    return edges;
  };

  it('has no forwardRef and no import cycles', () => {
    const edges = collect();
    const state = new Map<ModuleLike, 'visiting' | 'done'>();
    const visit = (module: ModuleLike, path: string[]): void => {
      if (state.get(module) === 'done') return;
      expect(state.get(module), `import cycle: ${[...path, module.name].join(' -> ')}`).toBeUndefined();
      state.set(module, 'visiting');
      for (const next of edges.get(module) ?? []) visit(next, [...path, module.name ?? '?']);
      state.set(module, 'done');
    };
    for (const module of edges.keys()) visit(module, []);
  });
});

describe('domain reconciler registration', () => {
  it.each([
    ['ContainersModule', ContainersModule, ContainerReconciler],
    ['VolumesModule', VolumesModule, VolumeReconciler],
    ['ImagesModule', ImagesModule, ImageAssignmentReconciler],
    ['ServersModule', ServersModule, ServerPreflightReconciler],
    ['ServersModule', ServersModule, ServerHealthService],
  ])('%s provides %s', (_name, module, provider) => {
    expect(providersOf(module)).toContain(provider);
  });
});

describe('ImageAssignmentReconciler source', () => {
  const sourceOf = (config: Record<string, string>) => {
    const reconciler = new ImageAssignmentReconciler(
      {} as never,
      { get: (key: string) => config[key] ?? '' } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return (reconciler as unknown as { source: unknown }).source;
  };

  it('uses the preflight source server when no dedicated image source is configured', () => {
    expect(sourceOf({ 'incus.preflightSourceServer': 'https://images.example.test' })).toEqual({
      alias: '',
      fingerprint: null,
      sourceServer: 'https://images.example.test',
    });
  });

  it('prefers the dedicated image source server', () => {
    expect(sourceOf({
      'incus.imageSourceServer': 'https://images.internal.test',
      'incus.preflightSourceServer': 'https://images.example.test',
    })).toEqual({
      alias: '',
      fingerprint: null,
      sourceServer: 'https://images.internal.test',
    });
  });
});
