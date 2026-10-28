import { MODULE_METADATA } from '@nestjs/common/constants';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntentRecord } from './intent.repository.js';
import type { ManagedReconciler, ServerHealthPort } from './managed-reconciler.js';
import { ReconcileModule } from './reconcile.module.js';
import { ReconcilerRegistry } from './reconciler-registry.service.js';

function providersOf(module: object): unknown[] {
  return Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) as unknown[];
}

const DOMAIN_DIRECTORIES = [
  'containers', 'volumes', 'servers', 'images', 'gpu', 'access', 'users', 'grants',
  'storage-pools', 'shared-backends', 'ssh', 'http-proxy', 'ip-pools', 'metrics',
  'system-settings', 'proxy-snapshots', 'audit', 'health', 'firewall',
];

describe('ReconcileModule boundaries', () => {
  it('does not import any domain module in non-test sources', () => {
    const importPattern = new RegExp(
      `from '\\.\\./(${DOMAIN_DIRECTORIES.join('|')})/`,
    );
    const offenders = readdirSync(__dirname)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .filter((name) => importPattern.test(readFileSync(join(__dirname, name), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('provides the engine and its registry', () => {
    expect(providersOf(ReconcileModule)).toEqual(expect.arrayContaining([ReconcilerRegistry]));
  });
});

describe('ReconcilerRegistry', () => {
  it('registers one reconciler per resource type', () => {
    const registry = new ReconcilerRegistry();
    const reconciler = (resourceType: ManagedReconciler['resourceType']) => ({
      resourceType,
      supports: (intent: IntentRecord) => intent.resourceType === resourceType,
    }) as unknown as ManagedReconciler;
    registry.register(reconciler('container'));
    registry.register(reconciler('volume'));

    expect(registry.all()).toHaveLength(2);
    expect(registry.forResource('volume')?.resourceType).toBe('volume');
    expect(registry.forIntent({ resourceType: 'container' } as IntentRecord)?.resourceType)
      .toBe('container');
    expect(registry.forResource('server')).toBeUndefined();
    expect(() => registry.register(reconciler('volume'))).toThrow(/already registered/);
  });

  it('requires the servers module to register its health port', () => {
    const registry = new ReconcilerRegistry();
    expect(() => registry.serverHealth()).toThrow(/No server health port/);
    const port = {} as ServerHealthPort;
    registry.registerServerHealth(port);
    expect(registry.serverHealth()).toBe(port);
    expect(() => registry.registerServerHealth(port)).toThrow(/already registered/);
  });
});
