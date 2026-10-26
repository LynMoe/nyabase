import { describe, expect, it } from 'vitest';
import {
  applyManagedFields as applyManagedFieldsOwned,
  compareManagedFields as compareManagedFieldsOwned,
  CORE_MANAGED_FIELD_OWNERSHIP,
  observeRootQuotaPending,
  type ManagedFieldOwnership,
  type ManagedInstanceDocument,
  buildDesiredInstanceSpec,
  type DesiredInstanceSpec,
  type InstanceSpecInput,
} from './instance-spec.js';

const ownership = CORE_MANAGED_FIELD_OWNERSHIP;

function compareManagedFields(
  actual: ManagedInstanceDocument,
  desired: DesiredInstanceSpec,
  owned: ManagedFieldOwnership = ownership,
) {
  return compareManagedFieldsOwned(actual, desired, owned);
}

function applyManagedFields(
  actual: ManagedInstanceDocument,
  desired: DesiredInstanceSpec,
  owned: ManagedFieldOwnership = ownership,
) {
  return applyManagedFieldsOwned(actual, desired, owned);
}

const baseInput: InstanceSpecInput = {
  container: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'dev',
    serverId: '22222222-2222-4222-8222-222222222222',
    revision: 3,
    imageFingerprint: 'b'.repeat(64),
    cpus: [0, 1],
    memBytes: 1073741824n,
    rootPool: 'default',
    rootSizeBytes: 10737418240n,
    routedIp: '198.51.100.10',
  },
  server: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'lab-a',
    parentInterface: 'ens3',
  },
  attachments: [],
  limits: {
    processes: 4096,
    networkIngressMbit: 1000,
    networkEgressMbit: 1000,
    diskReadMBps: 500,
    diskWriteMBps: 500,
  },
};

function desired() {
  return buildDesiredInstanceSpec(baseInput);
}

function actualWith(
  config: Record<string, string> = {},
  devices: Record<string, Record<string, string>> = {},
) {
  const spec = desired();
  return {
    config: { ...spec.config, ...config },
    devices: { ...spec.devices, ...devices },
  };
}

describe('compareManagedFields', () => {
  it('returns an exact empty result for equivalent managed state', () => {
    const result = compareManagedFields(actualWith(), desired());
    expect(result.kind).toBe('empty');
    expect(result.empty).toBe(true);
    expect(result.config).toEqual({});
    expect(result.devices).toEqual({});
  });

  it('ignores only the config Incus maintains itself', () => {
    const result = compareManagedFields(
      actualWith({
        'volatile.eth0.hwaddr': '02:aa:bb:cc:dd:ee',
        'volatile.idmap.next': '[]',
        'image.os': 'ubuntu',
      }),
      desired(),
    );
    expect(result.empty).toBe(true);
  });

  it('treats any other config key as drift, raw.lxc included', () => {
    const result = compareManagedFields(
      actualWith({ 'raw.lxc': 'lxc.apparmor.profile=unconfined', 'operator.note': 'x' }),
      desired(),
    );
    expect(result.kind).toBe('diff');
    expect(result.config).toEqual({
      'operator.note': { actual: 'x', desired: undefined },
      'raw.lxc': { actual: 'lxc.apparmor.profile=unconfined', desired: undefined },
    });
  });

  it('treats an extra device as drift', () => {
    const hostDisk = { type: 'disk', source: '/', path: '/host' };
    const result = compareManagedFields(actualWith({}, { hostDisk }), desired());
    expect(result.devices).toEqual({ hostDisk: { actual: hostDisk, desired: undefined } });
  });

  it('compares device keys both ways', () => {
    const result = compareManagedFields(
      actualWith({}, { eth0: { ...desired().devices?.eth0, 'ipv4.routes': '0.0.0.0/0' } }),
      desired(),
    );
    expect(Object.keys(result.devices)).toEqual(['eth0']);
  });

  it('treats a profile as drift', () => {
    const result = compareManagedFields({ ...actualWith(), profiles: ['default'] }, desired());
    expect(result.kind).toBe('diff');
    expect(result.profiles).toBe(true);
  });

  it('reports exact configuration and device differences', () => {
    const result = compareManagedFields(
      actualWith(
        {
          'limits.cpu': '4',
          'security.nesting': 'false',
        },
        {
          eth0: {
            ...desired().devices?.eth0,
            parent: 'ens4',
          },
        },
      ),
      desired(),
    );
    expect(result.kind).toBe('diff');
    expect(result.config).toEqual({
      'limits.cpu': { actual: '4', desired: '0-1' },
      'security.nesting': { actual: 'false', desired: 'true' },
    });
    expect(result.devices).toEqual({
      eth0: {
        actual: {
          ...desired().devices?.eth0,
          parent: 'ens4',
        },
        desired: desired().devices?.eth0,
      },
    });
  });

  it('normalizes equivalent memory and CPU forms', () => {
    const result = compareManagedFields(
      actualWith({
        'limits.memory': '1GiB',
        'limits.cpu': '0,1',
      }),
      desired(),
    );
    expect(result.empty).toBe(true);

    const cpuSet = compareManagedFields(
      {
        config: { ...desired().config, 'limits.cpu': '0,1,2,3' },
        devices: desired().devices,
      },
      {
        ...desired(),
        config: { ...desired().config, 'limits.cpu': '0-3' },
      },
    );
    expect(cpuSet.empty).toBe(true);
  });

  it('returns a typed managed failure for unsafe managed networking', () => {
    const withoutEth0 = {
      config: desired().config,
      devices: Object.fromEntries(
        Object.entries(desired().devices ?? {}).filter(([name]) => name !== 'eth0'),
      ),
    };
    const missing = compareManagedFields(withoutEth0, desired());
    expect(missing.kind).toBe('managed_failure');
    expect(missing.error?.code).toBe('MISSING_MANAGED_NETWORK_ADDRESS');

    const leftoverMacvlan = compareManagedFields(
      actualWith(
        {},
        {
          eth0: {
            type: 'nic',
            nictype: 'macvlan',
            mode: 'bridge',
            parent: 'ens3',
            name: 'eth0',
          },
        },
      ),
      desired(),
    );
    expect(leftoverMacvlan.kind).toBe('managed_failure');
    expect(leftoverMacvlan.error?.code).toBe('INVALID_MANAGED_NETWORK_TYPE');
    expect(leftoverMacvlan.empty).toBe(false);

    const leftoverRouted = compareManagedFields(
      actualWith(
        {},
        {
          eth0: {
            type: 'nic',
            nictype: 'routed',
            parent: 'ens3',
            name: 'eth0',
          },
        },
      ),
      desired(),
    );
    expect(leftoverRouted.kind).toBe('managed_failure');
    expect(leftoverRouted.error?.code).toBe('INVALID_MANAGED_NETWORK_TYPE');

    const missingHwaddr = compareManagedFields(
      actualWith(
        {},
        {
          eth0: {
            type: 'nic',
            nictype: 'bridged',
            parent: 'ens3',
            name: 'eth0',
            'ipv4.address': '198.51.100.10',
            'security.ipv4_filtering': 'true',
            'security.mac_filtering': 'true',
          },
        },
      ),
      desired(),
    );
    expect(missingHwaddr.kind).toBe('diff');
    expect(missingHwaddr.error).toBeUndefined();

    const missingFilterOnActual = compareManagedFields(
      actualWith(
        {},
        {
          eth0: {
            type: 'nic',
            nictype: 'bridged',
            parent: 'ens3',
            name: 'eth0',
            hwaddr: desired().devices?.eth0?.hwaddr ?? '',
          },
        },
      ),
      desired(),
    );
    expect(missingFilterOnActual.kind).toBe('diff');
    expect(missingFilterOnActual.error).toBeUndefined();

    const desiredWithoutHwaddr = {
      ...desired(),
      devices: {
        ...desired().devices,
        eth0: {
          type: 'nic',
          nictype: 'bridged',
          parent: 'ens3',
          name: 'eth0',
          'ipv4.address': '198.51.100.10',
          'security.ipv4_filtering': 'true',
          'security.mac_filtering': 'true',
        },
      },
    };
    const desiredHwaddrOmit = compareManagedFields(actualWith(), desiredWithoutHwaddr);
    expect(desiredHwaddrOmit.kind).toBe('managed_failure');
    expect(desiredHwaddrOmit.error?.code).toBe('INVALID_MANAGED_NETWORK_TYPE');
    expect(desiredHwaddrOmit.error?.details).toMatchObject({ key: 'hwaddr' });

    const desiredWithoutFilter = {
      ...desired(),
      devices: {
        ...desired().devices,
        eth0: {
          type: 'nic',
          nictype: 'bridged',
          parent: 'ens3',
          name: 'eth0',
          hwaddr: desired().devices?.eth0?.hwaddr ?? '',
        },
      },
    };
    const desiredFilterOmit = compareManagedFields(actualWith(), desiredWithoutFilter);
    expect(desiredFilterOmit.kind).toBe('managed_failure');
    expect(desiredFilterOmit.error?.code).toBe('INVALID_MANAGED_FILTER_IDENTITY');
  });

  it('writes back exactly the desired document, keeping only Incus-owned config', () => {
    const spec = desired();
    const actual = {
      ...actualWith(
        {
          'volatile.eth0.hwaddr': '02:aa:bb:cc:dd:ee',
          'image.os': 'ubuntu',
          'operator.note': 'drop',
          'raw.idmap': 'both 0 0',
        },
        {
          ext0: { type: 'unix-char', path: '/dev/ext0' },
          root: { ...spec.devices?.root, 'limits.read': '1MB', extra: 'x' },
        },
      ),
      profiles: ['default'],
    };
    const updated = applyManagedFields(actual, spec);
    expect(updated.config?.['volatile.eth0.hwaddr']).toBe('02:aa:bb:cc:dd:ee');
    expect(updated.config?.['image.os']).toBe('ubuntu');
    expect(updated.config?.['operator.note']).toBeUndefined();
    expect(updated.config?.['raw.idmap']).toBeUndefined();
    expect(updated.devices).toEqual(spec.devices);
    expect(updated.profiles).toEqual([]);
    expect(compareManagedFields(updated, spec).empty).toBe(true);
  });

  it('observes root quota application independently of managed diff', () => {
    const pending = observeRootQuotaPending(
      actualWith({ 'volatile.root.apply_quota': 'true' }),
      21474836480n,
    );
    expect(pending).toEqual({
      pending: true,
      applyQuota: 'true',
      pendingSizeBytes: '21474836480',
    });
    expect(observeRootQuotaPending(actualWith(), 1n).pending).toBe(false);
  });
});
