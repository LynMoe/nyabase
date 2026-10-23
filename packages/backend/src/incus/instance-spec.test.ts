import { describe, expect, it } from 'vitest';
import {
  buildDesiredInstanceSpec,
  deriveAttachmentDeviceName,
  deriveGuestHwaddr,
  deriveNicHostName,
  formatCpuSet,
  deriveInstanceName,
  deriveVolumeName,
  type InstanceSpecInput,
  applyManagedFields,
  compareManagedFields,
  CORE_MANAGED_FIELD_OWNERSHIP,
} from './instance-spec.js';

const containerId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const volumeId = '33333333-3333-4333-8333-333333333333';
const attachmentId = '44444444-4444-4444-8444-444444444444';

function input(overrides: Partial<InstanceSpecInput['container']> = {}): InstanceSpecInput {
  return {
    container: {
      id: containerId,
      serverId,
      revision: 7,
      imageFingerprint: 'a'.repeat(64),
      imageSource: {
        server: 'https://images.example.test',
        protocol: 'simplestreams',
      },
      cpus: [2, 3, 8],
      memBytes: 1073741824n,
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
          throttled: true,
        },
        containerPath: '/data/work',
        readOnly: true,
      },
    ],
    limits: {
      processes: 4096,
      networkIngressMbit: 1000,
      networkEgressMbit: 500,
      diskReadMBps: 300,
      diskWriteMBps: 200,
    },
  };
}

describe('buildDesiredInstanceSpec', () => {
  it('builds a complete deterministic bridged container document', () => {
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
        'limits.cpu': '2-3,8-8',
        'limits.memory': '1073741824',
        'limits.processes': '4096',
        'security.privileged': 'false',
        'security.idmap.isolated': 'true',
        'linux.sysctl.net.ipv6.conf.all.disable_ipv6': '1',
        'linux.sysctl.net.ipv6.conf.default.disable_ipv6': '1',
        'security.nesting': 'true',
        'security.syscalls.intercept.mknod': 'true',
        'security.syscalls.intercept.setxattr': 'true',
        'user.nyabase.managed': 'true',
        'user.nyabase.container_id': containerId.replaceAll('-', ''),
        'user.nyabase.server_id': serverId.replaceAll('-', ''),
        'user.nyabase.revision': '7',
      },
      devices: {
        root: {
          type: 'disk',
          path: '/',
          pool: 'default',
          size: '21474836480',
          'limits.read': '300MB',
          'limits.write': '200MB',
        },
        eth0: {
          type: 'nic',
          nictype: 'bridged',
          parent: 'eno1',
          name: 'eth0',
          hwaddr: '02:6e:c0:00:02:14',
          host_name: deriveNicHostName(containerId),
          'ipv4.address': '192.0.2.20',
          'security.ipv4_filtering': 'true',
          'security.mac_filtering': 'true',
          'security.port_isolation': 'true',
          'limits.ingress': '1000Mbit',
          'limits.egress': '500Mbit',
        },
        [deriveAttachmentDeviceName(attachmentId)]: {
          type: 'disk',
          pool: 'data',
          source: deriveVolumeName(volumeId),
          path: '/data/work',
          readonly: 'true',
          'limits.read': '300MB',
          'limits.write': '200MB',
        },
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/runtimeId|docker|routed|169\.254/);
  });

  it('pins to an explicit CPU set and never emits a CPU count', () => {
    expect(formatCpuSet([5])).toBe('5-5');
    expect(formatCpuSet([0, 1, 2, 3])).toBe('0-3');
    expect(buildDesiredInstanceSpec(input({ cpus: [4] })).config?.['limits.cpu']).toBe('4-4');
    expect(buildDesiredInstanceSpec(input()).config).not.toHaveProperty('limits.cpu.allowance');
    expect(() => buildDesiredInstanceSpec(input({ cpus: [] }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INSTANCE_SPEC' }),
    );
  });

  it('puts every managed NIC behind the IPv6 guard prefix', () => {
    expect(deriveNicHostName(containerId)).toMatch(/^nyh[0-9a-f]{12}$/);
    expect(deriveNicHostName(containerId)).not.toBe(deriveNicHostName(serverId));
  });

  it('derives the guest MAC from its IPv4 address, not the container', () => {
    expect(deriveGuestHwaddr('10.8.255.75')).toBe('02:6e:0a:08:ff:4b');
    const other = '55555555-5555-4555-8555-555555555555';
    const nic = (id: string, address: string) =>
      buildDesiredInstanceSpec(input({ id, routedIp: address })).devices?.eth0?.hwaddr;
    expect(nic(containerId, '192.0.2.20')).toBe(nic(other, '192.0.2.20'));
    expect(nic(containerId, '192.0.2.20')).not.toBe(nic(containerId, '192.0.2.21'));
    expect(deriveGuestHwaddr('0.0.0.1')).not.toBe(deriveGuestHwaddr('1.0.0.0'));
    for (const address of ['192.0.2.20', '255.255.255.255', '0.0.0.0']) {
      const first = Number.parseInt(deriveGuestHwaddr(address).slice(0, 2), 16);
      expect(first & 0x01).toBe(0);
      expect(first & 0x02).toBe(0x02);
      expect(deriveGuestHwaddr(address)).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    }
    for (const bad of ['', '10.0.0', '10.0.0.256', '10.0.0.1/24', '::1', '010.0.0.1', containerId]) {
      expect(() => deriveGuestHwaddr(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_INSTANCE_SPEC' }),
      );
    }
  });

  it('does not throttle network filesystem attachments', () => {
    const spec = buildDesiredInstanceSpec({
      ...input(),
      attachments: [{ ...input().attachments[0]!, volume: { ...input().attachments[0]!.volume, throttled: false } }],
    });
    expect(spec.devices?.[deriveAttachmentDeviceName(attachmentId)]).not.toHaveProperty('limits.read');
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
            throttled: true,
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
      CORE_MANAGED_FIELD_OWNERSHIP,
    );
    expect(actual.devices?.[deriveAttachmentDeviceName(attachmentId)]).toBeDefined();
    expect(actual.devices?.['nyd-55555555555545558555555555555555']).toBeDefined();
    const backToOne = applyManagedFields(actual, one, CORE_MANAGED_FIELD_OWNERSHIP);
    expect(backToOne.devices?.['nyd-55555555555545558555555555555555']).toBeUndefined();
    expect(compareManagedFields(backToOne, one, CORE_MANAGED_FIELD_OWNERSHIP).empty).toBe(true);
  });
});
