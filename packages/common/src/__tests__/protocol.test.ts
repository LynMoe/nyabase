import { describe, it, expect } from 'vitest';
import {
  zEnvelope,
  zHelloPayload,
  zContainerSnapshot,
  zContainerSpec,
  zCreateContainerPayload,
  zContainerSetPowerPayload,
  zAgentCommandEnvelope,
  zOperationProgressPayload,
  zReconcileContainerSshPayload,
  zRemoteFsParams,
  zAddSshKeyRequest,
  zCreateImageRequest,
  zUpdateImageRequest,
  zCreateContainerRequest,
  zLoginRequest,
  zCreateServerRequest,
  ContainerStatus,
  OperationKind,
  OperationStatus,
  AgentCommandKind,
  AgentCommandStatus,
  HookKind,
  HookStatus,
  RuntimeDriftKind,
  RemoteFsType,
  LABEL,
  SPEC_VERSION,
  type OperationRefResponse,
  type OperationSummaryDto,
  type HookSummaryDto,
} from '@nyabase/common';

declare const process: {
  cwd(): string;
};

declare const require: {
  (id: 'fs'): {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
};

const { readFileSync } = require('fs');

const VALID_ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3 valid-ed25519@example';
const VALID_RSA_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDs8YEmsGdfwIVB5wvZrdRWPpE64x+g798tiQ9D4xvg7/1XjSAlSaRMTXdUgR5YSH35oMUqfLaLJvZcip7wXyfpgbV/jbC/izdM4KGZqqa+dpjPFkgqfJKSvzcfErHBu5l6oZlHQumhvxn1IGw+IA/P30hhN7Hrgp+YmIpotwZP5SrTsPg/hhOT5WkniMJt+ZL0fAyIqjv3LkX6U7oVjaaiiezAqOwMSPTUwVFYj5xLF5N82KqzkSVJodrx5Q7nUHXfBqUYNl+RnKLiZoUVlOqmF5Lk4sBa0+0OKoyBtO8T1vl8RRgFJy1R40yFIbLGNhfSqIVqg4OUkBQCO/RSTbO/ valid-rsa@example';
const VALID_ECDSA_NISTP256_KEY = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBCd/hpmwc75yKGwmVHTk7TPnhd96ExCFpRgzXxjvaj2HLATMkf6qJhO2MdocBs6D+FcImasH8iEFxo1fhkW7S5Q= valid-ecdsa@example';

function commonSrcPath(relativePath: string): string {
  const cwd = process.cwd();
  const commonRoot = cwd.endsWith('/packages/common') ? cwd : `${cwd}/packages/common`;
  return `${commonRoot}/src/${relativePath}`;
}

describe('zEnvelope', () => {
  it('accepts a minimal envelope', () => {
    expect(zEnvelope.parse({ ts: 1, kind: 'hello', payload: {} })).toMatchObject({
      ts: 1,
      kind: 'hello',
    });
  });

  it('rejects missing required fields', () => {
    expect(() => zEnvelope.parse({ kind: 'hello', payload: {} })).toThrow();
    expect(() => zEnvelope.parse({ ts: 1, payload: {} })).toThrow();
  });
});

describe('durable agent command protocol', () => {
  it('validates agentCommand envelopes with durable correlation fields', () => {
    const parsed = zAgentCommandEnvelope.parse({
      operationId: 'operation-a',
      commandId: 'command-a',
      commandKind: AgentCommandKind.RuntimeContainerPower,
      idempotencyKey: 'container.start:server-a:container-a:operation-a',
      resourceKey: 'container:server-a:container-a',
      desiredGeneration: 7,
      payload: { runtimeId: 'runtime-a', action: 'start' },
    });

    expect(parsed).toEqual({
      operationId: 'operation-a',
      commandId: 'command-a',
      commandKind: AgentCommandKind.RuntimeContainerPower,
      idempotencyKey: 'container.start:server-a:container-a:operation-a',
      resourceKey: 'container:server-a:container-a',
      desiredGeneration: 7,
      payload: { runtimeId: 'runtime-a', action: 'start' },
    });
    expect(() =>
      zAgentCommandEnvelope.parse({
        operationId: 'operation-a',
        commandKind: AgentCommandKind.RuntimeContainerPower,
        idempotencyKey: 'key',
        resourceKey: 'container:server-a:container-a',
        desiredGeneration: null,
        payload: {},
      }),
    ).toThrow();
  });


  it('defaults power payload reconciliation fields for backward-compatible stop payloads', () => {
    expect(zContainerSetPowerPayload.parse({ runtimeId: 'runtime-a', action: 'stop' })).toEqual({
      runtimeId: 'runtime-a',
      action: 'stop',
      mounts: [],
      sshServerEnabled: false,
      sshPublicKeys: [],
    });
  });

  it('accepts desired mounts and SSH keys on start/restart payloads', () => {
    const parsed = zContainerSetPowerPayload.parse({
      runtimeId: 'runtime-a',
      action: 'start',
      mounts: [{
        sourceKind: 'local',
        sourceId: 'disk-a',
        userId: 'owner-a',
        dirName: 'work',
        hostPath: '/mnt/disk-a/work',
        containerPath: '/work',
      }],
      sshServerEnabled: true,
      sshPublicKeys: ['ssh-ed25519 AAAA owner@example'],
    });
    expect(parsed.mounts).toHaveLength(1);
    expect(parsed.sshServerEnabled).toBe(true);
    expect(parsed.sshPublicKeys).toEqual(['ssh-ed25519 AAAA owner@example']);
  });

  it('validates operationProgress payload statuses and terminal error shape', () => {
    expect(zOperationProgressPayload.parse({
      operationId: 'operation-a',
      commandId: 'command-a',
      status: 'waiting_observed',
      step: 'wait-for-runtime-report',
      data: { runtimeId: 'runtime-a' },
      ts: 1,
    })).toMatchObject({
      operationId: 'operation-a',
      commandId: 'command-a',
      status: 'waiting_observed',
      step: 'wait-for-runtime-report',
      data: { runtimeId: 'runtime-a' },
      ts: 1,
    });

    expect(zOperationProgressPayload.parse({
      operationId: 'operation-a',
      commandId: 'command-a',
      status: 'failed',
      step: 'docker-start',
      error: 'Docker refused start',
      ts: 2,
    })).toMatchObject({
      status: 'failed',
      error: 'Docker refused start',
    });
    expect(() =>
      zOperationProgressPayload.parse({
        operationId: 'operation-a',
        commandId: 'command-a',
        status: 'done',
        step: 'docker-start',
        ts: 2,
      }),
    ).toThrow();
  });
});

describe('zHelloPayload', () => {
  it('applies default for localImages', () => {
    const parsed = zHelloPayload.parse({
      serverId: 's',
      hostname: 'h',
      kernelVersion: '6.0',
      cpuCores: 4,
      totalMemBytes: 1,
      disks: [],
      gpus: [],
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanIface: 'eth0',
      agentVersion: '0.1.0',
    });
    expect(parsed.localImages).toEqual([]);
  });

  it('requires int cpuCores', () => {
    expect(() =>
      zHelloPayload.parse({
        serverId: 's',
        hostname: 'h',
        kernelVersion: '6.0',
        cpuCores: 4.5,
        totalMemBytes: 1,
        disks: [],
        gpus: [],
        macvlanCidr: '10.0.0.0/24',
        macvlanGateway: '10.0.0.1',
        macvlanIface: 'eth0',
        agentVersion: '0.1.0',
      }),
    ).toThrow();
  });
});

describe('zCreateContainerPayload', () => {
  const base = {
    containerId: 'container-a',
    ownerId: 'u',
    numericOwnerId: 1000,
    specGeneration: 1,
    imageDockerRef: 'nginx:latest',
    imageId: 'i',
    name: 'c',
    cpuMillis: 1000,
    memBytes: 1024,
    ipCidr: '10.0.0.0/24',
    gateway: '10.0.0.1',
  };

  it('validates a minimal payload and defaults createDirs/mounts/reservedIps/sshServerEnabled/sshPublicKeys', () => {
    const parsed = zCreateContainerPayload.parse(base);
    expect(parsed.createDirs).toEqual([]);
    expect(parsed.mounts).toEqual([]);
    expect(parsed.reservedIps).toEqual([]);
    expect(parsed.sshServerEnabled).toBe(false);
    expect(parsed.sshPublicKeys).toEqual([]);
    expect(parsed.runtimeOverrides).toEqual({ uid: 0, entrypoint: null, cmd: null, init: false });
  });

  it('accepts runtime overrides for Docker create', () => {
    const parsed = zCreateContainerPayload.parse({
      ...base,
      runtimeOverrides: {
        uid: 1000,
        entrypoint: ['/usr/bin/tini', '--'],
        cmd: ['sleep', 'infinity'],
        init: true,
      },
    });

    expect(parsed.runtimeOverrides).toEqual({
      uid: 1000,
      entrypoint: ['/usr/bin/tini', '--'],
      cmd: ['sleep', 'infinity'],
      init: true,
    });
  });

  it('accepts explicit sshServerEnabled, sshPublicKeys, createDirs ownerUid, and mount specs', () => {
    const parsed = zCreateContainerPayload.parse({
      ...base,
      sshServerEnabled: true,
      sshPublicKeys: ['ssh-ed25519 AAAA user@example'],
      createDirs: [
        {
          sourceKind: 'local',
          sourceId: 'disk-1',
          dirName: 'work',
          createIfMissing: true,
          ownerUid: 1234,
        },
      ],
      mounts: [
        {
          sourceKind: 'local',
          sourceId: 'disk-1',
          userId: 'u',
          dirName: 'work',
          containerPath: '/work',
          hostPath: '/data/work',
        },
      ],
    });

    expect(parsed.sshServerEnabled).toBe(true);
    expect(parsed.sshPublicKeys).toEqual(['ssh-ed25519 AAAA user@example']);
    expect(parsed.createDirs).toEqual([
      {
        sourceKind: 'local',
        sourceId: 'disk-1',
        dirName: 'work',
        createIfMissing: true,
        ownerUid: 1234,
      },
    ]);
    expect(parsed.mounts).toEqual([
      {
        sourceKind: 'local',
        sourceId: 'disk-1',
        userId: 'u',
        dirName: 'work',
        containerPath: '/work',
        hostPath: '/data/work',
      },
    ]);
  });

  it('requires createDirs ownerUid and ignores legacy SSH injection fields', () => {
    expect(() =>
      zCreateContainerPayload.parse({
        ...base,
        createDirs: [
          {
            sourceKind: 'local',
            sourceId: 'disk-1',
            dirName: 'work',
            createIfMissing: true,
          },
        ],
      }),
    ).toThrow();

    const parsed = zCreateContainerPayload.parse({
      ...base,
      sshUser: 'legacy',
      sshUid: 1001,
      sshPubKeys: ['ssh-rsa AAAA legacy'],
    });
    expect('sshUser' in parsed).toBe(false);
    expect('sshUid' in parsed).toBe(false);
    expect('sshPubKeys' in parsed).toBe(false);
  });
});

describe('image runtime override REST schemas', () => {
  it('normalizes legacy defaultUid into create runtimeOverrides', () => {
    const parsed = zCreateImageRequest.parse({
      name: 'Alpine',
      dockerImage: 'alpine:latest',
      defaultUid: 1000,
    });

    expect(parsed.runtimeOverrides).toEqual({
      uid: 1000,
      entrypoint: null,
      cmd: null,
      init: false,
    });
  });

  it('accepts explicit runtimeOverrides for image update', () => {
    const parsed = zUpdateImageRequest.parse({
      runtimeOverrides: {
        uid: 1001,
        entrypoint: ['/entry'],
        cmd: ['run'],
        init: true,
      },
    });

    expect(parsed.runtimeOverrides).toEqual({
      uid: 1001,
      entrypoint: ['/entry'],
      cmd: ['run'],
      init: true,
    });
  });

  it('rejects invalid override uid and empty args', () => {
    expect(() =>
      zCreateImageRequest.parse({
        name: 'bad',
        dockerImage: 'bad:latest',
        runtimeOverrides: { uid: -1, entrypoint: null, cmd: null, init: false },
      }),
    ).toThrow();
    expect(() =>
      zUpdateImageRequest.parse({
        runtimeOverrides: { uid: 0, entrypoint: [''], cmd: null, init: false },
      }),
    ).toThrow();
  });
});

describe('Container SSH protocol state', () => {
  const spec = {
    runtimeId: 'runtime-1',
    name: 'c',
    ownerId: 'u',
    imageId: 'i',
    cpuMillis: 1000,
    memBytes: 1024,
    gpuIndices: [],
    ip: '10.0.0.2',
    serverId: 'srv-1',
    sshServerEnabled: true,
    dataDirs: [],
    createdAt: new Date(0).toISOString(),
    specVersion: SPEC_VERSION,
  };

  it('uses sshServerEnabled instead of legacy sshUser/sshUid in ContainerSpec', () => {
    const parsed = zContainerSpec.parse({
      ...spec,
      sshUser: 'legacy',
      sshUid: 1001,
    });

    expect(parsed.sshServerEnabled).toBe(true);
    expect('sshUser' in parsed).toBe(false);
    expect('sshUid' in parsed).toBe(false);
  });

  it('requires runtime SSH server state on snapshots', () => {
    expect(() =>
      zContainerSnapshot.parse({
        spec,
        status: ContainerStatus.Running,
        stats: null,
      }),
    ).toThrow();

    const parsed = zContainerSnapshot.parse({
      spec,
      status: ContainerStatus.Running,
      stats: null,
      sshServer: {
        enabled: true,
        status: 'running',
        user: 'root',
        port: 22,
        pid: 22,
        keyHash: 'abc',
        lastReconciledAt: 1,
      },
    });
    expect(parsed.sshServer).toMatchObject({
      enabled: true,
      status: 'running',
      user: 'root',
      port: 22,
    });
  });

  it('validates reconcileContainerSsh with publicKeys and optional expectedKeyHash', () => {
    const parsed = zReconcileContainerSshPayload.parse({
      runtimeId: 'runtime-1',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
      expectedKeyHash: 'hash',
      sshPubKeys: ['legacy'],
    });

    expect(parsed).toEqual({
      runtimeId: 'runtime-1',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
      expectedKeyHash: 'hash',
    });
    expect(() => zReconcileContainerSshPayload.parse({ runtimeId: 'runtime-1', sshPubKeys: [] })).toThrow();
  });
});

describe('zRemoteFsParams', () => {
  it('discriminates by type (nfs)', () => {
    const parsed = zRemoteFsParams.parse({
      type: RemoteFsType.Nfs,
      nfsServer: 'nfs.example',
      exportPath: '/srv',
      version: '4.2',
    });
    if (parsed.type !== RemoteFsType.Nfs) throw new Error('discriminator failed');
    expect(parsed.nfsServer).toBe('nfs.example');
  });

  it('rejects cephfs without monHosts', () => {
    expect(() =>
      zRemoteFsParams.parse({
        type: RemoteFsType.CephFs,
        monHosts: '',
        exportPath: '/c',
        clientName: 'admin',
        secret: 'x',
      }),
    ).toThrow();
  });
});

describe('REST request schemas', () => {
  it('zLoginRequest rejects empty fields', () => {
    expect(() => zLoginRequest.parse({ username: '', password: 'x' })).toThrow();
  });

  it('zAddSshKeyRequest accepts and normalizes valid one-line OpenSSH public keys', () => {
    expect(zAddSshKeyRequest.parse({
      name: 'ed25519',
      keyText: ` \t ${VALID_ED25519_KEY.replaceAll(' ', '\t  ')} \t `,
    })).toEqual({
      name: 'ed25519',
      keyText: VALID_ED25519_KEY,
    });
    expect(zAddSshKeyRequest.parse({
      name: 'rsa',
      keyText: VALID_RSA_KEY,
    }).keyText).toBe(VALID_RSA_KEY);
    expect(zAddSshKeyRequest.parse({
      name: 'ecdsa',
      keyText: VALID_ECDSA_NISTP256_KEY,
    }).keyText).toBe(VALID_ECDSA_NISTP256_KEY);
  });

  it('zAddSshKeyRequest rejects malformed, multiline, and mismatched OpenSSH public keys', () => {
    const mismatchedBlob = VALID_ED25519_KEY.replace('ssh-ed25519 ', 'ssh-rsa ');

    for (const keyText of [
      'not-an-ssh-public-key',
      `${VALID_ED25519_KEY}\n${VALID_RSA_KEY}`,
      mismatchedBlob,
    ]) {
      expect(() => zAddSshKeyRequest.parse({ name: 'bad', keyText })).toThrow();
    }
  });

  it('zCreateContainerRequest enforces name regex', () => {
    expect(() =>
      zCreateContainerRequest.parse({
        serverId: 's',
        imageId: 'i',
        name: 'Bad Name',
      }),
    ).toThrow();
  });

  it('zCreateContainerRequest accepts sshServerEnabled and ignores legacy SSH request fields', () => {
    const parsed = zCreateContainerRequest.parse({
      serverId: 's',
      imageId: 'i',
      name: 'good-name',
      sshServerEnabled: true,
      sshUser: 'legacy',
      sshUid: 1001,
    });

    expect(parsed.sshServerEnabled).toBe(true);
    expect('sshUser' in parsed).toBe(false);
    expect('sshUid' in parsed).toBe(false);
  });

  it('zCreateContainerRequest strips legacy resource request fields', () => {
    const parsed = zCreateContainerRequest.parse({
      serverId: 's',
      imageId: 'i',
      name: 'good-name',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [0],
      gpuCount: 1,
      dataDirs: [{
        sourceKind: 'local',
        sourceId: 'disk-a',
        dirName: 'data',
        containerPath: '/data',
        createIfMissing: true,
      }],
      sshServerEnabled: true,
    });

    expect(parsed).toEqual({
      serverId: 's',
      imageId: 'i',
      name: 'good-name',
      dataDirs: [{
        sourceKind: 'local',
        sourceId: 'disk-a',
        dirName: 'data',
        containerPath: '/data',
        createIfMissing: true,
      }],
      sshServerEnabled: true,
    });
  });

  it('zCreateServerRequest validates CIDR and IP', () => {
    expect(() =>
      zCreateServerRequest.parse({
        name: 's',
        parentIface: 'eth0',
        ipCidr: 'bogus',
        gateway: '10.0.0.1',
      }),
    ).toThrow();
    expect(() =>
      zCreateServerRequest.parse({
        name: 's',
        parentIface: 'eth0',
        ipCidr: '10.0.0.0/24',
        gateway: 'not-an-ip',
      }),
    ).toThrow();
  });
});

describe('Control-plane REST protocol exports', () => {
  it('exports lifecycle enums and DTO helpers without breaking existing protocol imports', () => {
    const operationRef: OperationRefResponse = {
      ok: true,
      operationId: 'operation-a',
      status: OperationStatus.Queued,
    };
    const operation: OperationSummaryDto = {
      id: 'operation-a',
      kind: OperationKind.ContainerCreate,
      status: OperationStatus.Queued,
      resourceType: 'container',
      resourceId: 'container-a',
      serverId: 'server-a',
      attempts: 0,
      lastError: null,
      createdAt: new Date(0).toISOString(),
      startedAt: null,
      completedAt: null,
    };
    const hook: HookSummaryDto = {
      hook: HookKind.Mounts,
      status: HookStatus.Pending,
      desiredGeneration: 2,
      attempts: 0,
      lastError: null,
      updatedAt: new Date(0).toISOString(),
    };
    expect(operationRef.status).toBe(OperationStatus.Queued);
    expect(operation.kind).toBe(OperationKind.ContainerCreate);
    expect(hook.hook).toBe(HookKind.Mounts);
    expect(RuntimeDriftKind.SpecGenerationMismatch).toBe('spec_generation_mismatch');
    expect(AgentCommandStatus.Pending).toBe('pending');
    expect(zEnvelope.parse({ ts: 1, kind: 'hello', payload: {} }).kind).toBe('hello');
    expect(ContainerStatus.Running).toBe('running');
    expect(RemoteFsType.Nfs).toBe('nfs');

    const barrelSource = readFileSync(commonSrcPath('index.ts'), 'utf8');
    const restSource = readFileSync(commonSrcPath('protocol/rest.ts'), 'utf8');
    expect(barrelSource).toContain("export * from './protocol/rest.js'");
    for (const dtoName of [
      'OperationRefResponse',
      'OperationSummaryDto',
      'HookSummaryDto',
      'RuntimeDriftDto',
      'RuntimeStalenessDto',
    ]) {
      expect(restSource).toContain(`export interface ${dtoName}`);
    }
  });
});

describe('Docker label constants', () => {
  it('uses only V2 identity labels', () => {
    expect(SPEC_VERSION).toBe('3');
    expect(LABEL).toEqual({
      MANAGED: 'nyabase.managed',
      CONTAINER_ID: 'nyabase.container_id',
      SERVER_ID: 'nyabase.server_id',
      SPEC_GENERATION: 'nyabase.spec_generation',
    });
    expect('OWNER_ID' in LABEL).toBe(false);
    expect('CONTAINER_NAME' in LABEL).toBe(false);
    expect('IMAGE_ID' in LABEL).toBe(false);
  });
});
