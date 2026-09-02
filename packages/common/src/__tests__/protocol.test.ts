import { describe, expect, it } from 'vitest';
import {
  ContainerPowerIntent,
  ContainerPhase,
  ContainerStatus,
  FailureCode,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  NodeMetricsStatus,
  PreflightStatus,
  ResourceLifecyclePhase,
  ServerStatus,
  zBrowserToConsole,
  zCreateContainerRequest,
  zCreateImageRequest,
  zCreateIpPoolRequest,
  zCreateServerRequest,
  zCreateSharedVolumeRequest,
  zCreateVolumeRequest,
  zErrorResponse,
  zCreateExecSessionRequest,
  zIntentAcceptedDto,
  zPatchImageRequest,
  zPatchServerRequest,
  zPreflightReport,
  zPutServerGrantRequest,
  zSshProxyInstanceRouteSnapshot,
  formatSshProxyJumpLogin,
  isActiveSshProxyRoute,
  zSharedVolumeScope,
  zVolumeScope,
} from '@nyabase/common';
import type {
  ContainerDto,
  ErrorResponse,
  IntentAcceptedDto,
  ServerDto,
  SharedVolumeDto,
  VolumeDto,
} from '@nyabase/common';

const id = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const imageId = '33333333-3333-4333-8333-333333333333';

describe('canonical server network contract', () => {
  const server = {
    name: 'Incus one',
    slug: 'incus-one',
    apiEndpoint: 'https://incus.example.test:8443',
    parentInterface: 'eno1',
    dnsServers: ['192.0.2.53'],
  };

  it('accepts server identity fields without per-server CIDR', () => {
    expect(zCreateServerRequest.parse(server)).toMatchObject({
      parentInterface: 'eno1',
      dnsServers: ['192.0.2.53'],
    });
  });

  it('rejects unknown extra server fields', () => {
    const legacyParentField = ['bridge', 'Parent'].join('');
    expect(zPatchServerRequest.safeParse({
      expectedRevision: 1,
      [legacyParentField]: 'eno1',
    }).success).toBe(false);
    expect(zCreateServerRequest.safeParse({ ...server, nictype: 'bridged' }).success).toBe(false);
    const legacyCidrField = ['lan', 'Cidr'].join('');
    expect(zCreateServerRequest.safeParse({
      ...server,
      [legacyCidrField]: '192.0.2.0/24',
    }).success).toBe(false);
  });
});

describe('canonical IP pool contract', () => {
  it('accepts pool CIDR, allocation subnet, gateway, and server membership', () => {
    expect(zCreateIpPoolRequest.parse({
      name: 'lan-a',
      cidr: '10.8.0.0/16',
      allocationCidr: '10.8.100.0/24',
      gateway: '10.8.0.1',
      reservedIps: ['10.8.0.2'],
      serverIds: [serverId],
    })).toMatchObject({
      cidr: '10.8.0.0/16',
      allocationCidr: '10.8.100.0/24',
      gateway: '10.8.0.1',
      serverIds: [serverId],
    });
  });

  it('rejects gateways outside the pool CIDR', () => {
    expect(zCreateIpPoolRequest.safeParse({
      name: 'lan-a',
      cidr: '192.0.2.0/24',
      allocationCidr: '192.0.2.0/24',
      gateway: '198.51.100.1',
      reservedIps: [],
      serverIds: [],
    }).success).toBe(false);
  });

  it('rejects allocationCidr outside the LAN CIDR', () => {
    expect(zCreateIpPoolRequest.safeParse({
      name: 'lan-a',
      cidr: '10.8.0.0/16',
      allocationCidr: '10.9.0.0/24',
      gateway: '10.8.0.1',
      reservedIps: [],
      serverIds: [],
    }).success).toBe(false);
  });
});

describe('canonical container and volume contracts', () => {
  it('requires routed-compatible container creation fields', () => {
    expect(zCreateContainerRequest.parse({
      serverId,
      imageId,
      name: 'work',
      rootSizeBytes: 10_000,
      cpuMillis: 2_000,
      memBytes: 2_000_000_000,
      extensions: {},
      powerIntent: ContainerPowerIntent.Running,
    })).toMatchObject({ extensions: {} });
    expect(zCreateContainerRequest.parse({
      serverId,
      imageId,
      name: 'work',
      rootSizeBytes: 10_000,
      cpuMillis: 2_000,
      memBytes: 2_000_000_000,
            powerIntent: ContainerPowerIntent.Running,
      ownerId: id,
    }).ownerId).toBe(id);
    expect(zCreateContainerRequest.parse({
      serverId,
      imageId,
      name: 'work',
      rootSizeBytes: 10_000,
      cpuMillis: 2_000,
      memBytes: 2_000_000_000,
            powerIntent: ContainerPowerIntent.Running,
      volumes: [{ volumeId: id, containerPath: '/data', readOnly: false }],
    }).volumes).toEqual([{ volumeId: id, containerPath: '/data', readOnly: false }]);
  });

  it('accepts opaque extension bags on grants', () => {
    expect(zPutServerGrantRequest.parse({
      cpuMillis: null,
      memBytes: null,
      diskBytes: null,
      extensionGrants: {},
      expiresAt: null,
    }).extensionGrants).toEqual({});
  });

  it('rejects old physical identity and address fields', () => {
    const legacyIdentityField = ['runtime', 'Id'].join('');
    const legacyAddressField = ['mac', 'vlan', 'Ip'].join('');
    expect(zCreateContainerRequest.safeParse({
      serverId,
      imageId,
      name: 'work',
      rootSizeBytes: 1_024,
      cpuMillis: 1_000,
      memBytes: 1_024,
            powerIntent: ContainerPowerIntent.Stopped,
      [legacyIdentityField]: 'instance',
    }).success).toBe(false);
    expect(zSshProxyInstanceRouteSnapshot.safeParse({
      containerId: id,
      serverId,
      instanceName: 'nyc-11111111111141118111111111111111',
      routedIp: '192.0.2.10',
      status: 'running',
      sshStatus: 'running',
      containerHostKeyFingerprint: null,
      observedAt: '2026-08-07T00:00:00.000Z',
      [legacyAddressField]: '192.0.2.11',
    }).success).toBe(false);
  });

  it('formats jump login and treats active routes without host-key fingerprints', () => {
    expect(formatSshProxyJumpLogin({
      username: 'Alice',
      containerName: 'Work',
    })).toBe('alice.work');
    expect(formatSshProxyJumpLogin({
      username: 'alice',
      containerName: 'work',
      serverSlug: 'cpu-a',
    })).toBe('alice.cpu-a.work');
    expect(isActiveSshProxyRoute({
      containerId: id,
      serverId,
      instanceName: 'nyc-11111111111141118111111111111111',
      routedIp: '192.0.2.10',
      status: ContainerStatus.Running,
      sshStatus: 'running',
      containerHostKeyFingerprint: null,
      observedAt: '2026-08-07T00:00:00.000Z',
    })).toBe(true);
  });

  it('uses local or shared storage scopes without source aliases', () => {
    expect(zVolumeScope.parse({ kind: 'local', serverId, poolId: id })).toEqual({
      kind: 'local',
      serverId,
      poolId: id,
    });
    expect(zSharedVolumeScope.parse({ kind: 'shared', sharedBackendId: id })).toEqual({
      kind: 'shared',
      sharedBackendId: id,
    });
    expect(zSharedVolumeScope.safeParse({
      kind: 'shared',
      sharedBackendId: id,
      poolId: id,
    }).success).toBe(false);
    expect(zCreateVolumeRequest.safeParse({
      name: 'data',
      sizeBytes: 1_024,
      scope: { kind: 'shared', sharedBackendId: id },
    }).success).toBe(false);
    expect(zCreateSharedVolumeRequest.parse({
      name: 'data',
      sizeBytes: 1_024,
      scope: { kind: 'shared', sharedBackendId: id },
    })).toEqual({
      name: 'data',
      sizeBytes: 1_024,
      scope: { kind: 'shared', sharedBackendId: id },
    });
    expect(zCreateSharedVolumeRequest.safeParse({
      name: 'data',
      sizeBytes: 1_024,
      scope: { kind: 'shared', sharedBackendId: id, poolId: id },
    }).success).toBe(false);
    const legacySourceField = ['source', 'Kind'].join('');
    expect(zCreateVolumeRequest.safeParse({
      name: 'data',
      sizeBytes: 1_024,
      scope: { kind: 'shared', sharedBackendId: id, poolId: id },
      [legacySourceField]: 'local',
    }).success).toBe(false);
  });

  it('includes typed volume attachment summaries on VolumeDto', () => {
    const volume: VolumeDto = {
      id,
      ownerId: id,
      poolId: id,
      poolName: 'local-pool',
      serverId,
      name: 'data',
      incusName: 'nyv-data',
      sizeBytes: 1_024,
      usedBytes: 1_024,
      scope: { kind: 'local', serverId, poolId: id },
      capability: {
        growOnline: true,
        shrinkOnline: true,
        shrinkRequiresStop: false,
        shrinkNever: false,
        enforceUsageFloor: true,
      },
      lifecyclePhase: ResourceLifecyclePhase.Active,
      generation: 1,
      observedGeneration: 1,
      needsAttention: false,
      failureCode: null,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
      attachments: [{
        attachmentId: id,
        containerId: id,
        containerName: 'web',
        containerPath: '/data',
        bindState: 'attached',
      }],
    };
    expect(volume.attachments).toEqual([{
      attachmentId: id,
      containerId: id,
      containerName: 'web',
      containerPath: '/data',
      bindState: 'attached',
    }]);
  });

  it('represents a shared volume as a quota reservation without a pool', () => {
    const volume: SharedVolumeDto = {
      id,
      ownerId: id,
      sharedBackendId: id,
      sharedBackendName: 'ceph',
      name: 'data',
      incusName: 'nyv-data',
      sizeBytes: 1_024,
      usedBytes: null,
      capability: {
        growOnline: true,
        shrinkOnline: true,
        shrinkRequiresStop: false,
        shrinkNever: false,
        enforceUsageFloor: true,
      },
      lifecyclePhase: ResourceLifecyclePhase.Active,
      generation: 1,
      observedGeneration: null,
      needsAttention: false,
      failureCode: null,
      dirEnsured: false,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
      attachments: [],
    };
    expect(volume.dirEnsured).toBe(false);
    expect(volume.usedBytes).toBeNull();
  });
});

describe('intent and structured failure contracts', () => {
  it('represents a pending physical mutation by intent identity', () => {
    const accepted: IntentAcceptedDto = {
      intentId: id,
      resourceType: IntentResourceType.Container,
      resourceId: id,
      serverId,
      targetGeneration: 2,
      status: IntentStatus.Pending,
      createdAt: '2026-08-07T00:00:00.000Z',
    };
    expect(accepted).toMatchObject({
      intentId: id,
      resourceType: IntentResourceType.Container,
      status: 'pending',
    });
    expect(zIntentAcceptedDto.parse(accepted)).toEqual(accepted);
    expect(IntentKind.ContainerUpdate).toBe('container.update');
  });

  it('validates bounded error responses without operation references', () => {
    const response: ErrorResponse = {
      statusCode: 409,
      code: FailureCode.ExtensionMutationRequiresStop,
      message: 'The container must be stopped before changing extension devices.',
      requestId: id,
      details: { containerId: id },
    };
    expect(zErrorResponse.parse(response)).toEqual(response);
    const legacyResultField = ['task', 'Id'].join('');
    expect(zErrorResponse.safeParse({ ...response, [legacyResultField]: id }).success).toBe(false);
  });
});

describe('preflight and console contracts', () => {
  it('requires network prerequisite evidence for control readiness', () => {
    const base = {
      status: 'passed' as const,
      controlReady: true,
      checks: {
        api: 'pass' as const,
        parentInterface: 'pass' as const,
        nftables: 'pass' as const,
        ipv4Filtering: 'pass' as const,
        guestCanReachHost: 'pass' as const,
        networkPrerequisites: 'pass' as const,
        storagePool: 'pass' as const,
        simplestreamsImage: 'pass' as const,
        guestAddress: 'pass' as const,
        egress: 'pass' as const,
        nodeMetrics: 'warn' as const,
      },
      failureCode: null,
      checkedAt: '2026-08-07T00:00:00.000Z',
    };
    expect(zPreflightReport.parse(base).controlReady).toBe(true);
    expect(zPreflightReport.safeParse({
      ...base,
      checks: { ...base.checks, networkPrerequisites: 'fail' },
    }).success).toBe(false);
  });

  it('keeps browser console messages separate from control state', () => {
    expect(zCreateExecSessionRequest.parse({})).toMatchObject({
      command: ['/bin/sh', '-l'],
      tty: true,
      cols: 100,
      rows: 30,
    });
    expect(zBrowserToConsole.parse({ type: 'auth', token: 'browser-token' }))
      .toEqual({ type: 'auth', token: 'browser-token' });
    expect(zBrowserToConsole.parse({ type: 'resize', cols: 120, rows: 40 }))
      .toEqual({ type: 'resize', cols: 120, rows: 40 });
    expect(zBrowserToConsole.safeParse({
      type: 'auth',
      token: 'browser-token',
      serverId,
    }).success).toBe(false);
  });
});

describe('canonical DTO shapes', () => {
  it('keeps server, container, and route identities Incus-native', () => {
    const serverDto: ServerDto = {
      id: serverId,
      name: 'Incus one',
      slug: 'incus-one',
      apiEndpoint: 'https://incus.example.test:8443',
      serverCertFingerprint: null,
      incusVersion: null,
      apiExtensions: [],
      systemPoolId: null,
      systemPoolName: null,
      storageOvercommitRatio: 1,
      parentInterface: 'eno1',
      dnsServers: [],
      enabledExtensions: [],
      extensionHealth: {},
      status: ServerStatus.Unknown,
      lastSeenAt: null,
      lastError: null,
      revision: 1,
      preflightStatus: PreflightStatus.NotRun,
      preflightCheckedAt: null,
      preflightReport: null,
      nodeMetrics: {
        endpoint: null,
        serverCertFingerprint: null,
        tokenFingerprint: null,
        health: {
          status: NodeMetricsStatus.Unconfigured,
          lastSuccessAt: null,
          outageSince: null,
          lastError: null,
        },
      },
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    };
    const containerDto: ContainerDto = {
      id,
      serverId,
      serverName: serverDto.name,
      ownerId: id,
      name: 'work',
      instanceName: 'nyc-11111111111141118111111111111111',
      imageId,
      imageFingerprint: 'a'.repeat(64),
      rootPoolId: id,
      rootPoolName: 'system',
      rootSizeBytes: 10_000,
      rootSizePendingBytes: null,
      rootUsedBytes: null,
      rootCapability: {
        growOnline: true,
        shrinkOnline: true,
        shrinkRequiresStop: false,
        shrinkNever: false,
        enforceUsageFloor: true,
      },
      cpuMillis: 2_000,
      memBytes: 2_000_000_000,
      extensions: {},
      powerIntent: ContainerPowerIntent.Running,
      lifecyclePhase: ContainerPhase.Active,
      routedIp: '192.0.2.10',
      actual: {
        instanceName: 'nyc-11111111111141118111111111111111',
        status: ContainerStatus.Running,
        routedIp: '192.0.2.10',
        observedAt: '2026-08-07T00:00:00.000Z',
      },
      ssh: {
        enabled: true,
        status: 'running',
        ready: true,
        loginUser: 'root',
        proxyHost: null,
        proxyPort: null,
        hostKeyFingerprint: null,
        observedAt: null,
        lastError: null,
      },
      volumes: [],
      sharedVolumes: [],
      needsAttention: false,
      failureCode: null,
      failureReason: null,
      generation: 1,
      observedGeneration: 1,
      actions: {} as ContainerDto['actions'],
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    };
    expect(serverDto.parentInterface).toBe('eno1');
    expect(containerDto.actual.instanceName).toBe(containerDto.instanceName);
    expect(zSshProxyInstanceRouteSnapshot.parse({
      containerId: id,
      serverId,
      instanceName: containerDto.instanceName,
      routedIp: containerDto.routedIp,
      status: 'running',
      sshStatus: 'running',
      containerHostKeyFingerprint: null,
      observedAt: '2026-08-07T00:00:00.000Z',
    }).routedIp).toBe('192.0.2.10');
  });

  it('rejects legacy image reference fields', () => {
    const legacyImageField = ['d', 'ocker', 'Image'].join('');
    expect(zCreateImageRequest.safeParse({
      name: 'debian',
      alias: 'debian-12',
      loginUser: 'root',
      networkManagedExternally: true,
      [legacyImageField]: 'debian:12',
    }).success).toBe(false);
  });

  it('accepts admin-filled minRootSizeBytes and rejects non-positive values', () => {
    expect(zCreateImageRequest.safeParse({
      name: 'debian',
      alias: 'debian-12',
      loginUser: 'root',
      networkManagedExternally: false,
      minRootSizeBytes: 1_073_741_824,
    }).success).toBe(true);
    expect(zPatchImageRequest.safeParse({
      expectedRevision: 1,
      minRootSizeBytes: 2_147_483_648,
    }).success).toBe(true);
    expect(zPatchImageRequest.safeParse({
      expectedRevision: 1,
      minRootSizeBytes: 0,
    }).success).toBe(false);
    expect(zPatchImageRequest.safeParse({
      expectedRevision: 1,
      minRootSizeBytes: null,
    }).success).toBe(true);
  });
});
