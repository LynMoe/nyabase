import { describe, expect, it } from 'vitest';
import { NODE_METRIC_DEFINITIONS } from '@nyabase/common';
import { CORE_MANAGED_FIELD_OWNERSHIP } from '../incus/compare-managed-fields.js';
import { assertNoPrefixCollision } from './ownership.js';
import { ServerCardExtensionRegistry } from './registry.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { ServerCardExtensionsModule } from './server-card-extensions.module.js';
import { NODE_METRIC_CATALOG, SERVER_CARD_EXTENSIONS, type ServerCardExtension } from './types.js';

function stubExtension(
  overrides: Partial<ServerCardExtension> & Pick<ServerCardExtension, 'id'>,
): ServerCardExtension {
  return {
    displayName: overrides.id,
    ownedIncusConfigKeyPrefixes: ['example.'],
    ownedIncusDeviceNamePrefixes: ['ext'],
    errorFormatter: () => undefined,
    admitCreate: async () => ({ state: {} }),
    mutateContainer: async () => ({ state: {}, requestSummary: {} }),
    requiresStop: () => false,
    contributeInstanceSpec: () => ({ config: {}, devices: {} }),
    contributePreflight: async () => ({ evidence: {}, health: {} }),
    probeSupport: async () => ({ supported: true, checks: [] }),
    refreshHealth: async () => undefined,
    parseGrantPayload: (payload) => payload,
    effectiveGrantDevices: () => [],
    listDevices: async () => ({ items: [] }),
    assertCanDisable: async () => undefined,
    purgeServer: async () => undefined,
    ...overrides,
  };
}

function catalogOf(mod: ReturnType<typeof ServerCardExtensionsModule.register>) {
  const provider = (mod.providers ?? []).find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'provide' in entry &&
      entry.provide === NODE_METRIC_CATALOG,
  ) as { useValue: { definitions: Record<string, unknown> } } | undefined;
  if (!provider) throw new Error('missing NODE_METRIC_CATALOG');
  return provider.useValue;
}

describe('assertNoPrefixCollision', () => {
  it('accepts empty registration and disjoint prefixes', () => {
    expect(() => assertNoPrefixCollision([])).not.toThrow();
    expect(() =>
      assertNoPrefixCollision([
        stubExtension({
          id: 'one',
          ownedIncusConfigKeyPrefixes: ['example.'],
          ownedIncusDeviceNamePrefixes: ['ext'],
        }),
        stubExtension({
          id: 'two',
          ownedIncusConfigKeyPrefixes: ['other.'],
          ownedIncusDeviceNamePrefixes: ['alt'],
        }),
      ]),
    ).not.toThrow();
  });

  it('rejects config prefixes that are mutual prefixes', () => {
    expect(() =>
      assertNoPrefixCollision([
        stubExtension({ id: 'one', ownedIncusConfigKeyPrefixes: ['example.'] }),
        stubExtension({ id: 'two', ownedIncusConfigKeyPrefixes: ['example.foo.'] }),
      ]),
    ).toThrow(/config prefix collision/);
  });

  it('rejects device prefixes that are mutual prefixes', () => {
    expect(() =>
      assertNoPrefixCollision([
        stubExtension({
          id: 'one',
          ownedIncusConfigKeyPrefixes: ['example.'],
          ownedIncusDeviceNamePrefixes: ['ext'],
        }),
        stubExtension({
          id: 'two',
          ownedIncusConfigKeyPrefixes: ['other.'],
          ownedIncusDeviceNamePrefixes: ['ext0'],
        }),
      ]),
    ).toThrow(/device prefix collision/);
  });

  it('rejects prefixes that collide with core ownership', () => {
    expect(() =>
      assertNoPrefixCollision([
        stubExtension({
          id: 'one',
          ownedIncusConfigKeyPrefixes: [CORE_MANAGED_FIELD_OWNERSHIP.configPrefixes[0]],
        }),
      ]),
    ).toThrow(/config prefix collision/);
    expect(() =>
      assertNoPrefixCollision([
        stubExtension({
          id: 'one',
          ownedIncusDeviceNamePrefixes: [CORE_MANAGED_FIELD_OWNERSHIP.devicePrefixes[0]],
        }),
      ]),
    ).toThrow(/device prefix collision/);
    expect(() =>
      assertNoPrefixCollision([
        stubExtension({
          id: 'one',
          ownedIncusDeviceNamePrefixes: [CORE_MANAGED_FIELD_OWNERSHIP.deviceNames[0]],
        }),
      ]),
    ).toThrow(/device prefix collision/);
  });

  it('rejects empty prefixes, duplicate ids, and invalid ids', () => {
    expect(() =>
      assertNoPrefixCollision([stubExtension({ id: 'one', ownedIncusConfigKeyPrefixes: [''] })]),
    ).toThrow(/must not be empty/);
    expect(() =>
      assertNoPrefixCollision([
        stubExtension({ id: 'one' }),
        stubExtension({ id: 'one', ownedIncusConfigKeyPrefixes: ['other.'] }),
      ]),
    ).toThrow(/duplicate server-card extension id/);
    expect(() => assertNoPrefixCollision([stubExtension({ id: '1bad' })])).toThrow(
      /invalid server-card extension id/,
    );
  });
});

describe('ServerCardExtensionsModule.register', () => {
  it('imports RuntimeModule so inventory tokens resolve', () => {
    const mod = ServerCardExtensionsModule.register([]);
    const imported = (mod.imports ?? []).map((entry) => {
      if (entry && typeof entry === 'object' && 'forwardRef' in entry) {
        const ref = (entry as { forwardRef?: () => unknown }).forwardRef;
        return typeof ref === 'function' ? ref() : entry;
      }
      return entry;
    });
    expect(imported).toContain(RuntimeModule);
  });

  it('registers an empty host and merges the core metric catalog', () => {
    const mod = ServerCardExtensionsModule.register([]);
    expect(mod.global).toBe(true);
    const extensions = (mod.providers ?? []).find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'provide' in entry &&
        entry.provide === SERVER_CARD_EXTENSIONS,
    ) as { useValue: unknown[] } | undefined;
    expect(extensions?.useValue).toEqual([]);
    const catalog = catalogOf(mod);
    expect(catalog.definitions.nyabase_node_cpu_usage_ratio).toEqual(
      NODE_METRIC_DEFINITIONS.nyabase_node_cpu_usage_ratio,
    );
  });

  it('merges package metric catalogs and rejects colliding families', () => {
    const mod = ServerCardExtensionsModule.register([
      stubExtension({
        id: 'example',
        metricCatalog: {
          definitions: { example_metric: { type: 'gauge', labels: ['id'] } },
          validators: {},
        },
      }),
    ]);
    expect(catalogOf(mod).definitions.example_metric).toEqual({ type: 'gauge', labels: ['id'] });

    expect(() =>
      ServerCardExtensionsModule.register([
        stubExtension({
          id: 'example',
          metricCatalog: {
            definitions: {
              nyabase_node_cpu_usage_ratio: { type: 'gauge', labels: ['cpu'] },
            },
            validators: {},
          },
        }),
      ]),
    ).toThrow(/node metric catalog collision/);
  });

  it('refuses to register colliding prefixes', () => {
    expect(() =>
      ServerCardExtensionsModule.register([
        stubExtension({ id: 'one', ownedIncusDeviceNamePrefixes: ['ext'] }),
        stubExtension({
          id: 'two',
          ownedIncusConfigKeyPrefixes: ['other.'],
          ownedIncusDeviceNamePrefixes: ['ext'],
        }),
      ]),
    ).toThrow(/device prefix collision/);
  });
});

describe('ServerCardExtensionRegistry', () => {
  it('unions core ownership with registered prefixes', () => {
    const empty = new ServerCardExtensionRegistry([], { definitions: {}, validators: {} });
    expect(empty.managedFieldOwnership()).toEqual(CORE_MANAGED_FIELD_OWNERSHIP);
    expect(empty.all()).toEqual([]);
    expect(empty.get('example')).toBeUndefined();

    const registered = new ServerCardExtensionRegistry([stubExtension({ id: 'example' })], {
      definitions: {},
      validators: {},
    });
    expect(registered.get('example')?.id).toBe('example');
    expect(registered.managedFieldOwnership()).toEqual({
      configPrefixes: [...CORE_MANAGED_FIELD_OWNERSHIP.configPrefixes, 'example.'],
      deviceNames: CORE_MANAGED_FIELD_OWNERSHIP.deviceNames,
      devicePrefixes: [...CORE_MANAGED_FIELD_OWNERSHIP.devicePrefixes, 'ext'],
    });
  });
});
