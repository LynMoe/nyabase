import { describe, expect, it } from 'vitest';
import {
  applyManagedFields,
  compareManagedFields,
  observeRootQuotaPending,
} from './compare-managed-fields.js';
import { buildDesiredInstanceSpec, type InstanceSpecInput } from './instance-spec.js';

const baseInput: InstanceSpecInput = {
  container: {
    id: '11111111-1111-4111-8111-111111111111',
    serverId: '22222222-2222-4222-8222-222222222222',
    generation: 3,
    imageFingerprint: 'b'.repeat(64),
    cpuMillis: 2000,
    memBytes: 1073741824n,
    nvidiaRuntime: false,
    gpuPciAddresses: [],
    rootPool: 'default',
    rootSizeBytes: 10737418240n,
    routedIp: '198.51.100.10',
  },
  server: {
    id: '22222222-2222-4222-8222-222222222222',
    parentInterface: 'ens3',
  },
  attachments: [],
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

  it('ignores volatile, image, and operator-owned config fields', () => {
    const result = compareManagedFields(
      actualWith(
        {
          'volatile.eth0.hwaddr': '02:aa:bb:cc:dd:ee',
          'image.os': 'ubuntu',
          'operator.note': 'keep',
        },
      ),
      desired(),
    );
    expect(result.empty).toBe(true);
  });

  it('ignores extra unmanaged devices so write-back can preserve them', () => {
    const operatorDisk = {
      type: 'disk',
      source: 'operator-volume',
      path: '/operator',
    };
    const result = compareManagedFields(
      actualWith({}, { operatorDisk }),
      desired(),
    );
    expect(result.empty).toBe(true);
    expect(result.devices).toEqual({});
  });

  it('reports only exact managed configuration and device differences', () => {
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
      'limits.cpu': { actual: '4', desired: '2' },
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
        'limits.cpu': '2',
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

  it('applies managed fields, preserves operator config, and preserves unmanaged devices', () => {
    const spec = desired();
    const actual = actualWith(
      {
        'volatile.eth0.hwaddr': '02:aa:bb:cc:dd:ee',
        'operator.note': 'preserve',
        'limits.processes': '100',
      },
      {
        gpu0: {
          type: 'gpu',
          gputype: 'physical',
          pci: '0000:41:00.0',
        },
        operatorDisk: {
          type: 'disk',
          source: 'operator-volume',
          path: '/operator',
        },
      },
    );
    const updated = applyManagedFields(actual, spec);
    expect(updated.config?.['volatile.eth0.hwaddr']).toBe('02:aa:bb:cc:dd:ee');
    expect(updated.config?.['operator.note']).toBe('preserve');
    expect(updated.config?.['limits.processes']).toBeUndefined();
    expect(updated.config?.['security.privileged']).toBe('false');
    expect(updated.devices?.operatorDisk).toEqual({
      type: 'disk',
      source: 'operator-volume',
      path: '/operator',
    });
    expect(updated.devices?.gpu0).toBeUndefined();
    expect(updated.devices?.root).toEqual(spec.devices?.root);
    expect(updated.devices?.eth0).toEqual(spec.devices?.eth0);
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
