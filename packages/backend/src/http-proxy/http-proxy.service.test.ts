import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ContainerStatus,
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  MAX_HTTP_PROXY_DOMAIN_POOLS,
  MAX_HTTP_PROXY_ROUTES,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerEntity } from '../entities/container.entity.js';
import { HttpDomainPoolEntity } from '../entities/http-domain-pool.entity.js';
import { HttpProxyBindingEntity } from '../entities/http-proxy-binding.entity.js';
import { HttpHostnameReservationEntity } from '../entities/http-hostname-reservation.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import {
  HttpProxyService,
  MAX_HTTP_HOSTNAME_RESERVATIONS,
} from './http-proxy.service.js';

describe('HttpProxyService authorization boundaries', () => {
  it('rejects a new binding at the fixed route capacity inside the transaction', async () => {
    const service = makeService({
      bindingsRepo: { count: vi.fn().mockResolvedValue(MAX_HTTP_PROXY_ROUTES) },
    });

    await expect(service.createBinding('user-a', {
      hostname: 'overflow.apps.example.test',
      containerId: 'container-a',
      targetPort: 80,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'HTTP_PROXY_BINDING_CAPACITY_REACHED' }),
    });
  });

  it('rejects a new domain pool at the fixed pool capacity inside the transaction', async () => {
    const service = makeService({
      domainPoolsRepo: { count: vi.fn().mockResolvedValue(MAX_HTTP_PROXY_DOMAIN_POOLS) },
    });

    await expect(service.createDomainPool('actor-a', {
      wildcardDomain: '*.overflow.example.test',
      enabled: true,
      httpsEnabled: false,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'HTTP_PROXY_DOMAIN_POOL_CAPACITY_REACHED' }),
    });
  });

  it('rejects a canonical duplicate wildcard owner before create or update', async () => {
    const service = makeService();
    await expect(service.createDomainPool('actor-a', {
      wildcardDomain: ' APPS.EXAMPLE.TEST. ',
      enabled: true,
      httpsEnabled: false,
    })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'HTTP_PROXY_DOMAIN_POOL_EXISTS' }),
    });

    const current = { ...makePool(), id: 'pool-current', wildcardDomain: '*.old.example.test' };
    const occupied = { ...makePool(), id: 'pool-owner' };
    const updateService = makeService({
      domainPoolsRepo: {
        findOneBy: vi.fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(occupied),
      },
    });
    await expect(updateService.updateDomainPool('actor-a', current.id, {
      wildcardDomain: 'APPS.EXAMPLE.TEST',
    })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'HTTP_PROXY_DOMAIN_POOL_EXISTS' }),
    });
  });

  it.each([
    [{ code: '23505' }],
    [{ driverError: { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE failed' } }],
  ])('maps a concurrent wildcard unique violation to 409 (%j)', async (dbError) => {
    const service = makeService({
      domainPoolsRepo: {
        findOneBy: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockRejectedValue(dbError),
      },
    });

    await expect(service.createDomainPool('actor-a', {
      wildcardDomain: '*.race.example.test',
      enabled: true,
      httpsEnabled: false,
    })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'HTTP_PROXY_DOMAIN_POOL_EXISTS' }),
    });
  });

  it('maps a concurrent wildcard collision during update to 409', async () => {
    const current = { ...makePool(), wildcardDomain: '*.old.example.test' };
    const service = makeService({
      domainPoolsRepo: {
        findOneBy: vi.fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(null),
        save: vi.fn().mockRejectedValue({ code: '23505' }),
      },
    });

    await expect(service.updateDomainPool('actor-a', current.id, {
      wildcardDomain: '*.race.example.test',
    })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'HTTP_PROXY_DOMAIN_POOL_EXISTS' }),
    });
  });

  it('does not persist a domain pool after the actor capability is revoked', async () => {
    const save = vi.fn();
    const service = makeService({
      domainPoolsRepo: { save },
      accessResolver: {
        assertActorCapabilitiesInTransaction: vi.fn()
          .mockRejectedValue(new ForbiddenException('authority revoked')),
      },
    });

    await expect(service.createDomainPool('actor-a', {
      wildcardDomain: '*.revoked.example.test',
      enabled: true,
      httpsEnabled: false,
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects unique hostname churn at the fixed active-plus-draining capacity', async () => {
    const service = makeService({
      hostnameReservationsRepo: {
        count: vi.fn().mockResolvedValue(MAX_HTTP_HOSTNAME_RESERVATIONS),
      },
    });

    await expect(service.createBinding('user-a', {
      hostname: 'bounded.apps.example.test',
      containerId: 'container-a',
      targetPort: 80,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'HTTP_HOSTNAME_RESERVATION_CAPACITY_REACHED' }),
    });
  });

  it('rejects unknown or empty partial mutation fields', async () => {
    const service = makeService();
    await expect(service.createBinding('user-a', {
      hostname: 'a.apps.example.test',
      containerId: 'container-a',
      targetPort: 80,
      typo: true,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateBinding('user-a', 'binding-a', {}))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateDomainPool('actor-a', 'pool-a', { typo: true }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps invalid binding hostnames to stable 400 errors on create and update', async () => {
    const service = makeService({
      bindingsRepo: {
        findOneBy: vi.fn().mockResolvedValue(makeBinding({
          id: 'binding-a', ownerId: 'user-a', hostname: 'a.apps.example.test',
        })),
      },
    });

    for (const operation of [
      () => service.createBinding('user-a', {
        hostname: '*.apps.example.test',
        containerId: 'container-a',
        targetPort: 80,
      }),
      () => service.updateBinding('user-a', 'binding-a', {
        hostname: 'bad host.apps.example.test',
      }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: 'INVALID_HTTP_PROXY_HOSTNAME' }),
      });
    }
  });

  it('maps invalid wildcard domains to stable 400 errors on create and update', async () => {
    const service = makeService();

    for (const operation of [
      () => service.createDomainPool('actor-a', {
        wildcardDomain: 'apps..example.test',
        enabled: true,
        httpsEnabled: false,
      }),
      () => service.updateDomainPool('actor-a', 'pool-a', {
        wildcardDomain: '*.*.example.test',
      }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: 'INVALID_HTTP_PROXY_WILDCARD_DOMAIN' }),
      });
    }
  });

  it('rechecks that the binding owner is active inside task admission', async () => {
    const bindingsRepo = { save: vi.fn() };
    const service = makeService({
      bindingsRepo,
      usersRepo: { findOneBy: vi.fn().mockResolvedValue(null) },
    });
    await expect(service.createBinding('user-a', {
      hostname: 'a.apps.example.test',
      containerId: 'container-a',
      targetPort: 80,
    })).rejects.toMatchObject({ status: 403 });
    expect(bindingsRepo.save).not.toHaveBeenCalled();
  });

  it('publishes every authoritative snapshot with the required lease TTL', async () => {
    const manager = {
      find: vi.fn()
        .mockResolvedValueOnce([{
          containerId: 'container-a',
          serverId: 'server-a',
          macvlanIp: '10.0.0.2',
          runtimeStatus: ContainerStatus.Running,
          runtimeId: 'runtime-a',
          observedAt: new Date(),
        }])
        .mockResolvedValueOnce([makeBinding({
          id: 'binding-a', ownerId: 'user-a', hostname: 'a.apps.example.test',
        })])
        .mockResolvedValueOnce([makePool()])
        .mockResolvedValueOnce([makeContainer('container-a', 'user-a')])
        .mockResolvedValueOnce([{
          containerId: 'container-a',
          phase: 'active',
          activeTaskId: null,
          boundRuntimeId: 'runtime-a',
        }])
        .mockResolvedValueOnce([{
          containerId: 'container-a',
          powerIntent: 'running',
        }])
        .mockResolvedValueOnce([{ id: 'user-a', status: UserStatus.Active }])
        .mockResolvedValueOnce([{
          id: 'server-a', status: ServerStatus.Online, macvlanCidr: '10.0.0.0/24',
        }])
        .mockResolvedValueOnce([{
          address: '10.0.0.2',
          ownerKind: 'container',
          ownerId: 'container-a',
          serverId: 'server-a',
          state: 'active',
        }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_level: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
    };
    const service = makeService({ dataSource });

    const snapshot = await service.buildSnapshot();

    expect(snapshot.staleAfterMs).toBe(HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS);
    expect(snapshot.routes).toHaveLength(1);
    expect(manager.find).toHaveBeenCalledWith(NetworkAddressClaimEntity, {
      where: { state: 'active', address: expect.anything() },
    });
  });

  it('never publishes routes owned by a disabled user', async () => {
    const manager = snapshotManager(UserStatus.Disabled);
    const service = makeService({ dataSource: transactionDataSource(manager) });

    const snapshot = await service.buildSnapshot();

    expect(snapshot.routes).toEqual([]);
  });

  it('never publishes a retained route after its Agent server is offline', async () => {
    const manager = snapshotManager(UserStatus.Active, ServerStatus.Offline);
    const service = makeService({ dataSource: transactionDataSource(manager) });

    const snapshot = await service.buildSnapshot();

    expect(snapshot.routes).toEqual([]);
  });

  it('omits TLS material before its certificate can expire inside the next lease', async () => {
    const nearExpiryPool = {
      ...makePool(),
      httpsEnabled: true,
      certificatePem: 'certificate',
      encryptedPrivateKeyPem: 'encrypted-private-key',
      certificateFingerprint: 'fingerprint',
      certificateNotAfter: new Date(
        Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
      ),
    };
    const manager = snapshotManager(UserStatus.Active, ServerStatus.Online, nearExpiryPool);
    const service = makeService({ dataSource: transactionDataSource(manager) });

    const snapshot = await service.buildSnapshot();

    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.domainPools).toEqual([]);
  });

  it('reports lease-unsafe HTTPS material as an explicit binding warning', async () => {
    const nearExpiryPool = {
      ...makePool(),
      httpsEnabled: true,
      certificatePem: 'certificate',
      encryptedPrivateKeyPem: 'encrypted-private-key',
      certificateNotAfter: new Date(
        Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
      ),
    };
    const service = makeService({
      bindingsRepo: { find: vi.fn().mockResolvedValue([makeBinding({
        id: 'binding-a', ownerId: 'user-a', hostname: 'a.apps.example.test',
      })]) },
      domainPoolsRepo: { find: vi.fn().mockResolvedValue([nearExpiryPool]) },
    });

    const [binding] = await service.listBindings('user-a', true);

    expect(binding?.warningReasons).toContain('https_not_configured');
  });

  it('serializes snapshot reads so generations cannot overtake older database views', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let transactionNumber = 0;
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_level: string, work: (value: unknown) => Promise<unknown>) => {
        transactionNumber += 1;
        if (transactionNumber === 1) await firstGate;
        return work({ find: vi.fn().mockResolvedValue([]) });
      }),
    };
    const service = makeService({ dataSource });

    const first = service.buildSnapshot();
    const second = service.buildSnapshot();
    await vi.waitFor(() => expect(dataSource.transaction).toHaveBeenCalledOnce());

    releaseFirst();
    const snapshots = await Promise.all([first, second]);

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(snapshots.map((snapshot) => snapshot.generation)).toEqual([1, 2]);
  });

  it('lists only bindings owned by the requester', async () => {
    const ownBinding = makeBinding({ id: 'binding-a', ownerId: 'user-a', hostname: 'a.apps.example.test' });
    const otherBinding = makeBinding({ id: 'binding-b', ownerId: 'user-b', hostname: 'b.apps.example.test' });
    const bindingsRepo = {
      find: vi.fn().mockResolvedValue([ownBinding, otherBinding]),
    };
    const service = makeService({ bindingsRepo });

    const result = await service.listBindings('user-a', true);

    expect(bindingsRepo.find).toHaveBeenCalledWith({
      where: { ownerId: 'user-a' },
      order: { hostname: 'ASC' },
    });
    expect(result.map((binding) => binding.id)).toEqual(['binding-a']);
    expect(result[0]).toEqual(expect.objectContaining({
      mine: true,
      ownerId: 'user-a',
      ownerUsername: 'alice',
      hostname: 'a.apps.example.test',
    }));
  });

  it('hides disabled-owner bindings from list DTOs', async () => {
    const binding = makeBinding({ id: 'binding-a', ownerId: 'user-a', hostname: 'a.apps.example.test' });
    const service = makeService({
      bindingsRepo: { find: vi.fn().mockResolvedValue([binding]) },
      usersRepo: {
        find: vi.fn().mockResolvedValue([{
          id: 'user-a', username: 'alice', status: UserStatus.Disabled,
        }]),
      },
    });

    await expect(service.listBindings('user-a', true)).resolves.toEqual([]);
  });

  it('does not expose the occupying owner when a hostname is taken', async () => {
    const bindingsRepo = {
      findOneBy: vi.fn().mockResolvedValue(makeBinding({
        id: 'binding-existing',
        ownerId: 'user-b',
        hostname: 'taken.apps.example.test',
      })),
      save: vi.fn(),
    };
    const service = makeService({ bindingsRepo });

    try {
      await service.createBinding('user-a', {
        hostname: 'taken.apps.example.test',
        containerId: 'container-a',
        targetPort: 80,
      });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(expect.objectContaining({
        message: 'Hostname is already occupied or draining',
      }));
      expect((error as ConflictException).getResponse()).not.toHaveProperty('occupiedBy');
    }
  });

  it('does not resurrect an A binding as B when A cascade-delete wins the transaction order', async () => {
    const staleBinding = makeBinding({
      id: 'binding-a', ownerId: 'user-a', hostname: 'a.apps.example.test',
    });
    const bindingsRepo = { findOneBy: vi.fn().mockResolvedValue(staleBinding) };
    const manager = {
      findOneBy: vi.fn(async (entity: unknown) => {
        if (entity === HttpProxyBindingEntity) return null;
        if (entity === ContainerEntity) return makeContainer('container-b', 'user-a');
        return null;
      }),
      save: vi.fn(),
    };
    const dataSource = transactionDataSource(manager);
    const service = makeService({ bindingsRepo, dataSource });

    await expect(service.updateBinding('user-a', 'binding-a', { containerId: 'container-b' }))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(bindingsRepo.findOneBy).not.toHaveBeenCalled();
    expect(dataSource.transaction).toHaveBeenCalledOnce();
    expect(manager.findOneBy).toHaveBeenCalledWith(HttpProxyBindingEntity, { id: 'binding-a' });
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('does not recreate a domain pool when delete wins before a concurrent stale update', async () => {
    const domainPoolsRepo = { findOneBy: vi.fn().mockResolvedValue(makePool()) };
    const manager = {
      findOneBy: vi.fn(async (entity: unknown) => entity === HttpDomainPoolEntity ? null : null),
      save: vi.fn(),
    };
    const dataSource = transactionDataSource(manager);
    const service = makeService({ domainPoolsRepo, dataSource });

    await expect(service.updateDomainPool('actor-a', 'pool-a', { enabled: false }))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(domainPoolsRepo.findOneBy).not.toHaveBeenCalled();
    expect(dataSource.transaction).toHaveBeenCalledOnce();
    expect(manager.findOneBy).toHaveBeenCalledWith(HttpDomainPoolEntity, { id: 'pool-a' });
    expect(manager.save).not.toHaveBeenCalled();
  });
});

describe('HttpProxyService TLS admission', () => {
  let matching: { certificatePem: string; privateKeyPem: string };
  let other: { certificatePem: string; privateKeyPem: string };

  beforeAll(() => {
    matching = selfSignedPair('*.apps.example.test');
    other = selfSignedPair('*.other.example.test');
  });

  it('accepts a currently valid matching key pair covering the whole wildcard pool', () => {
    const service = makeService();
    const fields = (service as unknown as {
      certFields(cert: string, key: string, wildcard: string): Partial<HttpDomainPoolEntity>;
    }).certFields(
      matching.certificatePem,
      matching.privateKeyPem,
      '*.apps.example.test',
    );

    expect(fields).toMatchObject({
      certificatePem: matching.certificatePem,
      certificateFingerprint: expect.any(String),
      certificateNotAfter: expect.any(Date),
      encryptedPrivateKeyPem: expect.stringMatching(/^v1\./),
    });
  });

  it('rejects mismatched keys and certificates that do not cover the wildcard', () => {
    const service = makeService() as unknown as {
      certFields(cert: string, key: string, wildcard: string): Partial<HttpDomainPoolEntity>;
    };
    expect(() => service.certFields(
      matching.certificatePem,
      other.privateKeyPem,
      '*.apps.example.test',
    )).toThrow('do not match');
    expect(() => service.certFields(
      other.certificatePem,
      other.privateKeyPem,
      '*.apps.example.test',
    )).toThrow('does not cover wildcard domain');
  });

  it('rejects a certificate that cannot outlive a complete proxy lease', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60_000);
      const service = makeService() as unknown as {
        certFields(cert: string, key: string, wildcard: string): Partial<HttpDomainPoolEntity>;
      };
      expect(() => service.certFields(
        matching.certificatePem,
        matching.privateKeyPem,
        '*.apps.example.test',
      )).toThrow(/expires|currently valid/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires certificate and private key updates in the same transaction', async () => {
    const service = makeService();
    await expect(service.updateDomainPool('actor-a', 'pool-a', {
      certificatePem: matching.certificatePem,
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});

function makeService(overrides: {
  bindingsRepo?: Record<string, unknown>;
  domainPoolsRepo?: Record<string, unknown>;
  hostnameReservationsRepo?: Record<string, unknown>;
  usersRepo?: Record<string, unknown>;
  dataSource?: Record<string, unknown>;
  accessResolver?: Record<string, unknown>;
} = {}): HttpProxyService {
  const domainPoolsRepo = {
    find: vi.fn().mockResolvedValue([makePool()]),
    findOneBy: vi.fn(async (where: { id?: string; wildcardDomain?: string }) => {
      const pool = makePool();
      if (where.id === pool.id || where.wildcardDomain === pool.wildcardDomain) return pool;
      return null;
    }),
    save: vi.fn(async (row: unknown) => row),
    delete: vi.fn(),
    ...overrides.domainPoolsRepo,
  };
  const bindingsRepo = {
    find: vi.fn().mockResolvedValue([]),
    findOneBy: vi.fn().mockResolvedValue(null),
    save: vi.fn(),
    delete: vi.fn(),
    countBy: vi.fn(),
    ...overrides.bindingsRepo,
  };
  const hostnameReservationsRepo = {
    find: vi.fn().mockResolvedValue([]),
    findOneBy: vi.fn().mockResolvedValue(null),
    save: vi.fn(async (row: unknown) => row),
    delete: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    ...overrides.hostnameReservationsRepo,
  };
  const containersRepo = {
    find: vi.fn().mockResolvedValue([makeContainer('container-a', 'user-a')]),
    findOneBy: vi.fn().mockResolvedValue(makeContainer('container-a', 'user-a')),
  };
  const routesRepo = {
    find: vi.fn().mockResolvedValue([{
      containerId: 'container-a',
      serverId: 'server-a',
      macvlanIp: '10.0.0.2',
      runtimeStatus: ContainerStatus.Running,
      runtimeId: 'runtime-a',
      observedAt: new Date(),
    }]),
  };
  const lifecyclesRepo = {
    find: vi.fn().mockResolvedValue([{
      containerId: 'container-a',
      phase: 'active',
      activeTaskId: null,
      boundRuntimeId: 'runtime-a',
    }]),
  };
  const desiredSpecsRepo = {
    find: vi.fn().mockResolvedValue([{
      containerId: 'container-a',
      powerIntent: 'running',
    }]),
  };
  const usersRepo = {
    find: vi.fn().mockResolvedValue([
      { id: 'user-a', username: 'alice', status: UserStatus.Active },
      { id: 'user-b', username: 'bob', status: UserStatus.Active },
    ]),
    findOneBy: vi.fn(async (where: { id?: string }) => ({
      id: where.id ?? 'user-a',
      username: where.id === 'user-b' ? 'bob' : 'alice',
      status: UserStatus.Active,
    })),
    ...overrides.usersRepo,
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'ssh.keyEncryptionSecret') return 'test-secret';
      if (key === 'auth.jwtSecret') return 'jwt-secret';
      return undefined;
    }),
  };
  const manager = {
    find: vi.fn((entity: unknown, options: unknown) => callRepository(entity, 'find', options)),
    findOneBy: vi.fn((entity: unknown, where: unknown) => callRepository(entity, 'findOneBy', where)),
    create: vi.fn((_entity: unknown, row: unknown) => row),
    save: vi.fn((entity: unknown, row: unknown) => callRepository(entity, 'save', row)),
    delete: vi.fn((entity: unknown, where: unknown) => callRepository(entity, 'delete', where)),
    count: vi.fn((entity: unknown, options: unknown) => callRepository(entity, 'count', options, 0)),
  };
  function callRepository(
    entity: unknown,
    method: string,
    argument: unknown,
    fallback?: unknown,
  ): unknown {
    const repository = repositoryFor(entity);
    const operation = repository[method];
    return typeof operation === 'function'
      ? (operation as (value: unknown) => unknown)(argument)
      : fallback;
  }
  function repositoryFor(entity: unknown): Record<string, unknown> {
    if (entity === HttpDomainPoolEntity) return domainPoolsRepo;
    if (entity === HttpProxyBindingEntity) return bindingsRepo;
    if (entity === ContainerEntity) return containersRepo;
    if (entity === UserEntity) return usersRepo;
    if (entity === HttpHostnameReservationEntity) return hostnameReservationsRepo;
    throw new Error('Unexpected entity in fake transaction manager');
  }
  const dataSource = overrides.dataSource ?? transactionDataSource(manager);
  return new HttpProxyService(
    domainPoolsRepo as never,
    bindingsRepo as never,
    containersRepo as never,
    lifecyclesRepo as never,
    desiredSpecsRepo as never,
    routesRepo as never,
    usersRepo as never,
    config as never,
    dataSource as never,
    {
      assertActorCapabilitiesInTransaction: vi.fn().mockResolvedValue(new Set()),
      ...overrides.accessResolver,
    } as never,
  );
}

function snapshotManager(
  status: UserStatus,
  serverStatus: ServerStatus = ServerStatus.Online,
  pool: HttpDomainPoolEntity = makePool() as HttpDomainPoolEntity,
) {
  return {
    find: vi.fn()
      .mockResolvedValueOnce([{
        containerId: 'container-a',
        serverId: 'server-a',
        macvlanIp: '10.0.0.2',
        runtimeStatus: ContainerStatus.Running,
        runtimeId: 'runtime-a',
        observedAt: new Date(),
      }])
      .mockResolvedValueOnce([makeBinding({
        id: 'binding-a', ownerId: 'user-a', hostname: 'a.apps.example.test',
      })])
      .mockResolvedValueOnce([pool])
      .mockResolvedValueOnce([makeContainer('container-a', 'user-a')])
      .mockResolvedValueOnce([{
        containerId: 'container-a', phase: 'active', activeTaskId: null, boundRuntimeId: 'runtime-a',
      }])
      .mockResolvedValueOnce([{
        containerId: 'container-a', powerIntent: 'running',
      }])
      .mockResolvedValueOnce(status === UserStatus.Active ? [{ id: 'user-a', status }] : [])
      .mockResolvedValueOnce([{
        id: 'server-a', status: serverStatus, macvlanCidr: '10.0.0.0/24',
      }])
      .mockResolvedValueOnce([{
        address: '10.0.0.2',
        ownerKind: 'container',
        ownerId: 'container-a',
        serverId: 'server-a',
        state: 'active',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]),
  };
}

function transactionDataSource(manager: object) {
  return {
    options: { type: 'postgres' },
    transaction: vi.fn(async (_level: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
  };
}

function makeBinding(input: { id: string; ownerId: string; hostname: string }) {
  return {
    id: input.id,
    ownerId: input.ownerId,
    hostname: input.hostname,
    domainPoolId: 'pool-a',
    containerId: 'container-a',
    targetPort: 80,
    createdAt: new Date('2026-06-29T00:00:00.000Z'),
    updatedAt: new Date('2026-06-29T00:00:00.000Z'),
  };
}

function makePool() {
  return {
    id: 'pool-a',
    wildcardDomain: '*.apps.example.test',
    enabled: true,
    httpsEnabled: false,
    certificatePem: null,
    encryptedPrivateKeyPem: null,
    certificateFingerprint: null,
    certificateNotAfter: null,
    createdAt: new Date('2026-06-29T00:00:00.000Z'),
    updatedAt: new Date('2026-06-29T00:00:00.000Z'),
  };
}

function makeContainer(id: string, ownerId: string) {
  return {
    id,
    ownerId,
    name: 'container-a',
    serverId: 'server-a',
  };
}

function selfSignedPair(wildcardDomain: string): {
  certificatePem: string;
  privateKeyPem: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'nyabase-http-proxy-cert-'));
  const certificatePath = join(dir, 'certificate.pem');
  const privateKeyPath = join(dir, 'private-key.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', privateKeyPath,
      '-out', certificatePath,
      '-days', '2',
      '-subj', `/CN=${wildcardDomain}`,
      '-addext', `subjectAltName=DNS:${wildcardDomain}`,
    ], { stdio: 'ignore' });
    return {
      certificatePem: readFileSync(certificatePath, 'utf8'),
      privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
