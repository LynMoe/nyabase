import { describe, expect, it } from 'vitest';
import {
  buildDesiredInstanceSpec,
  deriveAttachmentDeviceName,
  deriveInstanceHwaddr,
  deriveInstanceName,
  deriveVolumeName,
  type InstanceSpecInput,
} from './instance-spec.js';
import { compareManagedFields, applyManagedFields } from './compare-managed-fields.js';

const containerId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const volumeId = '33333333-3333-4333-8333-333333333333';
const attachmentId = '44444444-4444-4444-8444-444444444444';

function input(overrides: Partial<InstanceSpecInput['container']> = {}): InstanceSpecInput {
  return {
    container: {
      id: containerId,
      serverId,
      generation: 7,
      imageFingerprint: 'a'.repeat(64),
      imageSource: {
        server: 'https://images.example.test',
        protocol: 'simplestreams',
      },
      cpuMillis: 2500,
      memBytes: 1073741824n,
      nvidiaRuntime: true,
      gpuPciAddresses: ['0000:41:00.0'],
      rootPool: 'default',
      rootSizeBytes: 21474836480n,
      routedIp: '192.0.2.20',
      ...overrides,
    },
    server: {
      id: serverId,
      parentInterface: 'eno1',
    },
    attachments: [
      {
        id: attachmentId,
        volume: {
          id: volumeId,
          incusName: deriveVolumeName(volumeId),
          poolName: 'data',
        },
        containerPath: '/data/work',
        readOnly: true,
      },
    ],
  };
}

describe('buildDesiredInstanceSpec', () => {
  it('builds a complete deterministic macvlan container document', () => {
    const first = buildDesiredInstanceSpec(input());
    const second = buildDesiredInstanceSpec(input());

    expect(first).toEqual(second);
    expect(first.profiles).toEqual([]);
    expect(first.config?.['security.privileged']).toBe('false');
    expect(first.config).not.toHaveProperty('security.syscalls.intercept.mount.allowed');
    expect(JSON.stringify(first.config)).not.toMatch(/intercept\.mount\.allowed/);
    expect(first).toMatchObject({
      name: deriveInstanceName(containerId),
      type: 'container',
      profiles: [],
      source: {
        type: 'image',
        fingerprint: 'a'.repeat(64),
        server: 'https://images.example.test',
        protocol: 'simplestreams',
      },
      config: {
        'limits.cpu': '3',
        'limits.cpu.allowance': '2500ms/3000ms',
        'limits.memory': '1073741824',
        'security.privileged': 'false',
        'security.nesting': 'true',
        'security.syscalls.intercept.mknod': 'true',
        'security.syscalls.intercept.setxattr': 'true',
        'nvidia.runtime': 'true',
        'user.nyabase.managed': 'true',
        'user.nyabase.container_id': containerId.replaceAll('-', ''),
        'user.nyabase.server_id': serverId.replaceAll('-', ''),
        'user.nyabase.generation': '7',
      },
      devices: {
        eth0: {
          type: 'nic',
          nictype: 'macvlan',
          mode: 'bridge',
          parent: 'eno1',
          name: 'eth0',
          hwaddr: deriveInstanceHwaddr(containerId),
        },
        [`gpu0`]: {
          type: 'gpu',
          gputype: 'physical',
          pci: '0000:41:00.0',
        },
        [deriveAttachmentDeviceName(attachmentId)]: {
          type: 'disk',
          pool: 'data',
          source: deriveVolumeName(volumeId),
          path: '/data/work',
          readonly: 'true',
        },
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/runtimeId|docker|routed|169\.254/);
  });

  it('maps millicores to integer limits.cpu plus CFS allowance (never fractional cpu)', () => {
    expect(buildDesiredInstanceSpec(input({ cpuMillis: 500 })).config).toMatchObject({
      'limits.cpu': '1',
      'limits.cpu.allowance': '500ms/1000ms',
    });
    expect(buildDesiredInstanceSpec(input({ cpuMillis: 1500 })).config).toMatchObject({
      'limits.cpu': '2',
      'limits.cpu.allowance': '1500ms/2000ms',
    });
    expect(buildDesiredInstanceSpec(input({ cpuMillis: 1000 })).config).toMatchObject({
      'limits.cpu': '1',
    });
    expect(
      buildDesiredInstanceSpec(input({ cpuMillis: 1000 })).config?.['limits.cpu.allowance'],
    ).toBeUndefined();
    expect(buildDesiredInstanceSpec(input({ cpuMillis: 0 })).config?.['limits.cpu']).toBeUndefined();
  });

  it('emits Incus 4-hex PCI domain while accepting 8-hex product form', () => {
    expect(buildDesiredInstanceSpec(input({
      gpuPciAddresses: ['00000000:41:00.0'],
    })).devices?.gpu0?.pci).toBe('0000:41:00.0');
    expect(buildDesiredInstanceSpec(input({
      gpuPciAddresses: ['0000:a1:00.0'],
    })).devices?.gpu0?.pci).toBe('0000:a1:00.0');
  });

  it('rejects wildcard GPU selectors', () => {
    expect(() =>
      buildDesiredInstanceSpec(input({ gpuPciAddresses: ['0000:41:00.*'] })),
    ).toThrowError('managed Incus GPU selector');
  });

  it('rejects unsupported PCI functions', () => {
    for (const address of ['0000:41:00.8', '00000000:41:00.f']) {
      expect(() => buildDesiredInstanceSpec(input({ gpuPciAddresses: [address] })))
        .toThrowError('managed Incus GPU selector');
    }
  });

  it('keeps attachment add and remove changes in one desired document', () => {
    const one = buildDesiredInstanceSpec(input());
    const two = buildDesiredInstanceSpec({
      ...input(),
      attachments: [
        ...input().attachments,
        {
          id: '55555555-5555-4555-8555-555555555555',
          volume: {
            id: '66666666-6666-4666-8666-666666666666',
            incusName: deriveVolumeName('66666666-6666-4666-8666-666666666666'),
            poolName: 'data',
          },
          containerPath: '/data/cache',
          readOnly: false,
        },
      ],
    });
    const actual = applyManagedFields(
      {
        config: one.config,
        devices: one.devices,
      },
      two,
    );
    expect(actual.devices?.[deriveAttachmentDeviceName(attachmentId)]).toBeDefined();
    expect(actual.devices?.['nyd-55555555555545558555555555555555']).toBeDefined();
    const backToOne = applyManagedFields(actual, one);
    expect(backToOne.devices?.['nyd-55555555555545558555555555555555']).toBeUndefined();
    expect(compareManagedFields(backToOne, one).empty).toBe(true);
  });
});
