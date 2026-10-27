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
  zConsoleToBrowser,
  zCreateContainerRequest,
  zAttachVolumeRequest,
  isForbiddenContainerMountPath,
  zAddCatalogImageRequest,
  zCreateImageRequest,
  zCreateIpPoolRequest,
  zCreateServerRequest,
  zCreateSharedVolumeRequest,
  zCreateVolumeRequest,
  zErrorResponse,
  zCreateExecSessionRequest,
  zIntentAcceptedDto,
  zListContainersQuery,
  zListScope,
  zIntentListQuery,
  zListVolumesQuery,
  zPatchImageRequest,
  zPatchServerRequest,
  zPatchStoragePoolRequest,
  zPreflightReport,
  zPutServerGrantRequest,
  zSshProxyInstanceRouteSnapshot,
  zSshProxyPauseAdmitCommand,
  formatSshAgentSetupPrompt,
  formatSshClientConfig,
  formatSshKnownHosts,
  zCreateSshProxyLineRequest,
  zPatchSshProxyLineRequest,
  formatSshJumpCommand,
  formatSshProxyJump,
  sshContainerHostName,
  zSharedVolumeScope,
  zVolumeScope,
  ADMIN_INTENT_LIST_MAX,
  MAX_INTENT_LIST_PAGE_SIZE,
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
      memBytes: 2_000_000_000,
      gpuPciAddresses: [],
      powerIntent: ContainerPowerIntent.Running,
    })).toMatchObject({ gpuPciAddresses: [] });
    expect(zCreateContainerRequest.safeParse({
      serverId,
      imageId,
      name: 'work',
      rootSizeBytes: 10_000,
      memBytes: 2_000_000_000,
      powerIntent: ContainerPowerIntent.Running,
      ownerId: id,
    }).success).toBe(false);
    expect(zCreateContainerRequest.parse({
      serverId,
      imageId,
      name: 'work',
      rootSizeBytes: 10_000,
      memBytes: 2_000_000_000,
            powerIntent: ContainerPowerIntent.Running,
      volumes: [{ volumeId: id, containerPath: '/data', readOnly: false }],
    }).volumes).toEqual([{ volumeId: id, containerPath: '/data', readOnly: false }]);
  });

  it('refuses volume mounts over kernel pseudo-filesystems', () => {
    const attach = (containerPath: string) => zAttachVolumeRequest.safeParse({
      volumeId: '11111111-1111-4111-8111-111111111111',
      containerPath,
      readOnly: false,
    }).success;
    for (const path of ['/proc', '/proc/self', '/sys', '/sys/fs/cgroup', '/dev', '/dev/shm', '//proc', '/dev/', '/sys//kernel']) {
      expect(attach(path), path).toBe(false);
    }
    for (const path of ['/data', '/procfs', '/srv/proc', '/device', '/system']) {
      expect(attach(path), path).toBe(true);
    }
    expect(isForbiddenContainerMountPath('/./proc')).toBe(true);
  });

  it('canonicalizes GPU PCI addresses on grants and defaults to none', () => {
    expect(zPutServerGrantRequest.parse({
      cpuCores: null,
      memBytes: null,
      diskBytes: null,
      expiresAt: null,
    }).gpuPciAddresses).toEqual([]);
    expect(zPutServerGrantRequest.parse({
      cpuCores: null,
      memBytes: null,
      diskBytes: null,
      gpuPciAddresses: ['0000:41:00.0'],
      expiresAt: null,
    }).gpuPciAddresses).toEqual(['00000000:41:00.0']);
    expect(zPutServerGrantRequest.safeParse({
      cpuCores: null,
      memBytes: null,
      diskBytes: null,
      gpuPciAddresses: ['0000:41:00.*'],
      expiresAt: null,
    }).success).toBe(false);
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
      observedAt: '2026-08-07T00:00:00.000Z',
      [legacyAddressField]: '192.0.2.11',
    }).success).toBe(false);
  });

  it('formats container host names and client configuration', () => {
    expect(sshContainerHostName('Work', 'nya')).toBe('work.nya');
    expect(formatSshProxyJump({ username: 'alice', host: 'ssh.example.com', port: 22 }))
      .toBe('alice@ssh.example.com');
    expect(formatSshJumpCommand({
      username: 'alice', host: 'ssh.example.com', port: 2222, loginUser: 'root', hostName: 'work.nya',
    })).toBe('ssh -J alice@ssh.example.com:2222 root@work.nya');
    expect(formatSshJumpCommand({
      username: 'alice', host: '2001:db8::1', port: 22, loginUser: 'ubuntu', hostName: 'work.nya',
    })).toBe('ssh -J alice@[2001:db8::1] ubuntu@work.nya');
    expect(formatSshClientConfig({ username: 'alice', host: 'ssh.example.com', port: 2222, hostSuffix: 'nya' }))
      .toBe('Host *.nya\n  User root\n  ProxyJump alice@ssh.example.com:2222');
    expect(formatSshKnownHosts({
      endpoints: [
        { host: 'ssh.example.com', port: 2222 },
        { host: '10.0.0.1', port: 22 },
        { host: 'ssh.example.com', port: 2222 },
      ],
      hostSuffix: 'nya',
      proxyHostKey: 'ssh-ed25519 AAAAproxy nyabase-ssh-proxy',
      hostCertificateAuthority: 'ssh-ed25519 AAAAca alice',
    })).toBe([
      '[ssh.example.com]:2222 ssh-ed25519 AAAAproxy',
      '10.0.0.1 ssh-ed25519 AAAAproxy',
      '@cert-authority *.nya ssh-ed25519 AAAAca',
    ].join('\n'));
    const prompt = formatSshAgentSetupPrompt({
      sshConfig: 'Host *.nya\n  User root',
      knownHosts: '@cert-authority *.nya ssh-ed25519 AAAAca',
      hostSuffix: 'nya',
      verifyTarget: 'work.nya',
    });
    expect(prompt.split('\n')[0]).toBe('帮我把下面的 SSH 配置配置到本机，不要改动其他已有条目：');
    expect(prompt).toContain('\nHost *.nya\n  User root\n');
    expect(prompt).toContain('\n@cert-authority *.nya ssh-ed25519 AAAAca\n');
    expect(prompt).toContain('`ssh -o BatchMode=yes work.nya true`');
  });

  it('validates SSH proxy lines', () => {
    expect(zCreateSshProxyLineRequest.parse({ name: ' 校园网 ', host: 'SSH.Example.com', port: 52515, hint: '  ' }))
      .toEqual({ name: '校园网', host: 'ssh.example.com', port: 52515, hint: null });
    expect(zCreateSshProxyLineRequest.parse({ name: '广州', host: '2001:DB8::1', port: 22 }).host).toBe('2001:db8::1');
    expect(zCreateSshProxyLineRequest.parse({ name: '广州', host: '2001:db8:0:0::1', port: 22 }).host).toBe('2001:db8::1');
    expect(zCreateSshProxyLineRequest.parse({ name: '内网', host: '10.8.16.31', port: 22 }).host).toBe('10.8.16.31');
    for (const host of [
      'ssh example.com', 'user@host', '-host', 'host:22', 'a..b', '',
      '1.2.3.4:22', '1:2', ':', '::::', 'a:b:c', '[::1]', 'fe80::1%eth0', '300.1.1.1', '1.2.3', '01.2.3.4',
    ]) {
      expect(zCreateSshProxyLineRequest.safeParse({ name: 'x', host, port: 22 }).success, host).toBe(false);
    }
    expect(zCreateSshProxyLineRequest.safeParse({ name: '一二三四五六七八九', host: 'h', port: 22 }).success).toBe(false);
    expect(zCreateSshProxyLineRequest.safeParse({ name: 'x', host: 'h', port: 22, hint: 'a\nb' }).success).toBe(false);
    expect(zPatchSshProxyLineRequest.safeParse({}).success).toBe(false);
    expect(zPatchSshProxyLineRequest.parse({ hint: '' })).toEqual({ hint: null });
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
    expect(zCreateVolumeRequest.safeParse({
      ownerId: id,
      name: 'data',
      sizeBytes: 1_024,
      scope: { kind: 'local', serverId, poolId: id },
    }).success).toBe(false);
    expect(zCreateSharedVolumeRequest.safeParse({
      ownerId: id,
      name: 'data',
      sizeBytes: 1_024,
      scope: { kind: 'shared', sharedBackendId: id },
    }).success).toBe(false);
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
      revision: 1,
      observedRevision: 1,
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
      revision: 1,
      observedRevision: null,
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
      targetRevision: 2,
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
      code: FailureCode.GpuMutationRequiresStop,
      message: 'The container must be stopped before changing GPU assignment.',
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
        networkPrerequisites: 'pass' as const,
        storagePool: 'pass' as const,
        simplestreamsImage: 'pass' as const,
        guestAddress: 'pass' as const,
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
      command: ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash -l; exec sh -l'],
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
    expect(zConsoleToBrowser.parse({ type: 'reauthenticate' })).toEqual({ type: 'reauthenticate' });
    expect(zConsoleToBrowser.safeParse({ type: 'reauthenticate', token: 'x' }).success).toBe(false);
  });
});

describe('storage pool patch', () => {
  it('accepts remark-only and register-only bodies', () => {
    expect(zPatchStoragePoolRequest.parse({
      expectedRevision: 2,
      displayName: '系统盘',
    })).toMatchObject({ displayName: '系统盘' });
    expect(zPatchStoragePoolRequest.parse({
      expectedRevision: 2,
      displayName: null,
    }).displayName).toBeNull();
    expect(zPatchStoragePoolRequest.parse({
      expectedRevision: 2,
      registered: true,
    }).registered).toBe(true);
  });

  it('rejects empty patches and unknown keys', () => {
    expect(zPatchStoragePoolRequest.safeParse({ expectedRevision: 2 }).success).toBe(false);
    expect(zPatchStoragePoolRequest.safeParse({
      expectedRevision: 2,
      registered: true,
      extra: 1,
    }).success).toBe(false);
    expect(zPatchStoragePoolRequest.safeParse({
      expectedRevision: 2,
      displayName: 'x'.repeat(129),
    }).success).toBe(false);
    expect(zPatchStoragePoolRequest.safeParse({
      expectedRevision: 2,
      source: '/data1/incus',
    }).success).toBe(false);
  });
});

describe('ssh proxy pauseAdmit', () => {
  it('accepts an optional ASCII reason', () => {
    expect(zSshProxyPauseAdmitCommand.parse({})).toEqual({});
    expect(zSshProxyPauseAdmitCommand.parse({ reason: 'backend shutting down' })).toEqual({
      reason: 'backend shutting down',
    });
  });

  it('rejects overlong or non-ASCII reasons', () => {
    expect(zSshProxyPauseAdmitCommand.safeParse({ reason: 'x'.repeat(513) }).success).toBe(false);
    expect(zSshProxyPauseAdmitCommand.safeParse({ reason: '暂停' }).success).toBe(false);
    expect(zSshProxyPauseAdmitCommand.safeParse({ extra: true }).success).toBe(false);
  });
});

describe('canonical DTO shapes', () => {
  it('keeps server, container, and route identities Incus-native', () => {
    const serverDto: ServerDto = {
      id: serverId,
      name: 'Incus one',
      slug: 'incus-one',
      incusVersion: null,
      apiExtensions: [],
      systemPoolId: null,
      systemPoolName: null,
      storageOvercommitRatio: 1,
      parentInterface: 'eno1',
      dnsServers: [],
      gpuEnabled: false,
      gpuHealth: {},
      status: ServerStatus.Unknown,
      lastSeenAt: null,
      lastError: null,
      revision: 1,
      preflightStatus: PreflightStatus.NotRun,
      preflightCheckedAt: null,
      preflightReport: null,
      agent: {
        connected: false,
        enrolled: false,
        version: null,
        hostname: null,
        connectedAt: null,
        enrollmentExpiresAt: null,
        ipv6Guard: null,
        firewall: null,
      },
      metricsHealth: {
        status: NodeMetricsStatus.Unknown,
        lastSuccessAt: null,
        outageSince: null,
        lastError: null,
      },
      reservedCpus: [],
      cpuTopology: null,
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
      cpuSet: [0, 1],
      memBytes: 2_000_000_000,
      gpu: null,
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
        hostName: 'work.nya',
        observedAt: null,
        lastError: null,
      },
      volumes: [],
      sharedVolumes: [],
      needsAttention: false,
      failureCode: null,
      failureReason: null,
      revision: 1,
      observedRevision: 1,
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
      observedAt: '2026-08-07T00:00:00.000Z',
    }).routedIp).toBe('192.0.2.10');
  });

  it('rejects legacy image reference fields', () => {
    const legacyImageField = ['d', 'ocker', 'Image'].join('');
    expect(zCreateImageRequest.safeParse({
      alias: 'debian-12',
      loginUser: 'root',
      networkManagedExternally: true,
      [legacyImageField]: 'debian:12',
    }).success).toBe(false);
    expect(zAddCatalogImageRequest.safeParse({ alias: 'ubuntu/24.04' }).success).toBe(true);
    expect(zCreateImageRequest.safeParse({
      alias: 'ubuntu/24.04',
      loginUser: 'root',
      networkManagedExternally: true,
    }).success).toBe(true);
    expect(zCreateImageRequest.safeParse({
      name: 'Ubuntu 24.04',
      alias: 'ubuntu/24.04',
      loginUser: 'root',
      networkManagedExternally: true,
    }).success).toBe(false);
  });

  it('accepts admin-filled minRootSizeBytes and rejects non-positive values', () => {
    expect(zCreateImageRequest.safeParse({
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
    expect(zPatchImageRequest.safeParse({
      expectedRevision: 1,
      alias: 'ubuntu/24.04',
    }).success).toBe(false);
    expect(zPatchImageRequest.safeParse({
      expectedRevision: 1,
      loginUser: 'root',
    }).success).toBe(false);
    expect(zPatchImageRequest.safeParse({
      expectedRevision: 1,
      name: 'Ubuntu 24.04',
    }).success).toBe(false);
  });
});

describe('intent list query', () => {
  it('accepts optional resourceType and serverId', () => {
    expect(zIntentListQuery.parse({
      resourceType: IntentResourceType.Volume,
      serverId,
    })).toMatchObject({
      resourceType: IntentResourceType.Volume,
      serverId,
    });
    expect(zIntentListQuery.parse({
      status: IntentStatus.Pending,
      kind: IntentKind.ContainerCreate,
    })).toMatchObject({
      status: IntentStatus.Pending,
      kind: IntentKind.ContainerCreate,
    });
  });

  it('rejects unknown keys', () => {
    expect(zIntentListQuery.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(zIntentListQuery.safeParse({
      resourceType: IntentResourceType.Volume,
      extra: true,
    }).success).toBe(false);
  });

  it('keeps scope=mine max at 100 and scope=all max at 500', () => {
    expect(MAX_INTENT_LIST_PAGE_SIZE).toBe(100);
    expect(ADMIN_INTENT_LIST_MAX).toBe(500);
    expect(zIntentListQuery.parse({}).scope).toBe('mine');
    expect(zIntentListQuery.parse({}).limit).toBeUndefined();
    expect(zIntentListQuery.safeParse({ limit: 100 }).success).toBe(true);
    expect(zIntentListQuery.safeParse({ limit: 500 }).success).toBe(false);
    expect(zIntentListQuery.safeParse({ scope: 'all', limit: 50 }).success).toBe(true);
    expect(zIntentListQuery.safeParse({ scope: 'all', limit: 500 }).success).toBe(true);
    expect(zIntentListQuery.safeParse({ scope: 'all', limit: 501 }).success).toBe(false);
  });

  it('accepts a resourceId filter and only the mine/all scopes', () => {
    expect(zIntentListQuery.parse({ resourceType: IntentResourceType.Container, resourceId: serverId }))
      .toMatchObject({ scope: 'mine', resourceId: serverId });
    expect(zListScope.parse(undefined)).toBe('mine');
    expect(zListScope.safeParse('admin').success).toBe(false);
  });
});

describe('local volume list query', () => {
  it('defaults to scope=mine and accepts a resource identity serverId only with scope=all', () => {
    expect(zListVolumesQuery.parse({})).toEqual({ scope: 'mine' });
    expect(zListVolumesQuery.parse({ scope: 'all' })).toEqual({ scope: 'all' });
    expect(zListVolumesQuery.parse({ scope: 'all', serverId: 'srv-1' }))
      .toEqual({ scope: 'all', serverId: 'srv-1' });
    expect(zListVolumesQuery.parse({ scope: 'all', serverId })).toEqual({ scope: 'all', serverId });
    expect(zListVolumesQuery.safeParse({ serverId: 'srv-1' }).success).toBe(false);
    expect(zListVolumesQuery.safeParse({ scope: 'mine', serverId }).success).toBe(false);
    expect(zListVolumesQuery.safeParse({ scope: 'mine', serverId }).error?.issues)
      .toEqual([expect.objectContaining({ path: ['serverId'], message: 'serverId is only available with scope=all' })]);
  });

  it('rejects extra keys, an unknown scope and empty serverId', () => {
    expect(zListVolumesQuery.safeParse({ scope: 'all', serverId: 'srv-1', extra: 'x' }).success).toBe(false);
    expect(zListVolumesQuery.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(zListVolumesQuery.safeParse({ scope: 'admin' }).success).toBe(false);
    expect(zListVolumesQuery.safeParse({ scope: 'all', serverId: '' }).success).toBe(false);
    expect(zListVolumesQuery.safeParse({ scope: 'all', serverId: 'not a uuid' }).success).toBe(false);
  });
});

describe('container list query', () => {
  it('defaults to scope=mine, keeps serverId for both scopes, and ignores unknown keys', () => {
    expect(zListContainersQuery.parse({})).toEqual({ scope: 'mine' });
    expect(zListContainersQuery.parse({ serverId: 'srv-1' })).toEqual({ scope: 'mine', serverId: 'srv-1' });
    expect(zListContainersQuery.parse({ scope: 'all', serverId: 'srv-1' }))
      .toEqual({ scope: 'all', serverId: 'srv-1' });
    expect(zListContainersQuery.parse({ cacheBust: '1' })).toEqual({ scope: 'mine' });
    expect(zListContainersQuery.safeParse({ scope: 'everyone' }).success).toBe(false);
  });
});
