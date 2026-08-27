import { describe, expect, it } from 'vitest';
import {
  ContainerStatus,
  MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH,
  MAX_HTTP_PROXY_DOMAIN_POOLS,
  MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH,
  MAX_HTTP_PROXY_ROUTES,
  MAX_HTTP_PROXY_SNAPSHOT_BYTES,
  MAX_PLATFORM_ACTIVE_USERS,
  MAX_PLATFORM_IMAGES,
  MAX_PLATFORM_SERVERS,
  MAX_SSH_PUBLIC_KEYS_PER_USER,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
  MAX_SSH_PROXY_CONTAINERS,
  MAX_SSH_PROXY_SNAPSHOT_BYTES,
  ServerStatus,
  UserStatus,
  zHttpProxySnapshot,
  zSshProxySnapshot,
} from '../index.js';

const repeated = (character: string, length: number): string => character.repeat(length);
const encodedBytes = (value: unknown): number => new TextEncoder()
  .encode(JSON.stringify(value)).byteLength;
const id = repeated('i', 64);

describe('bounded SSH proxy snapshots', () => {
  it('uses routed address and Incus instance identity', () => {
    const parsed = zSshProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      endpoint: null,
      hostKey: {
        privateKey: 'key',
        publicKey: 'key',
        fingerprint: 'fingerprint',
        generation: 1,
      },
      users: [],
      servers: [{
        id,
        slug: 'incus-one',
        name: 'Incus one',
        status: ServerStatus.Online,
      }],
      images: [{ id, sshEnabled: true }],
      containers: [{
        id,
        ownerId: id,
        serverId: id,
        imageId: id,
        name: 'work',
        instanceName: 'nyc-11111111111141118111111111111111',
      }],
      routes: [{
        containerId: id,
        serverId: id,
        instanceName: 'nyc-11111111111141118111111111111111',
        routedIp: '192.0.2.10',
        status: ContainerStatus.Running,
        sshStatus: 'running',
        containerHostKeyFingerprint: null,
        observedAt: new Date(0).toISOString(),
      }],
    });
    expect(parsed.routes[0]?.routedIp).toBe('192.0.2.10');
    expect(parsed.routes[0]?.instanceName).toMatch(/^nyc-/);
  });

  it('rejects multibyte data from ASCII-bounded snapshot fields', () => {
    expect(() => zSshProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      endpoint: null,
      hostKey: { privateKey: 'key', publicKey: 'key', fingerprint: 'fingerprint', generation: 1 },
      users: [],
      servers: [],
      images: [{ id: '😀'.repeat(32), sshEnabled: true }],
      containers: [],
      routes: [],
    })).toThrow();
  });

  it('keeps the legal snapshot below its wire buffer', () => {
    const snapshot = zSshProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      endpoint: { host: repeated('h', 253), port: 22 },
      hostKey: {
        privateKey: repeated('p', 16 * 1024),
        publicKey: repeated('u', 4 * 1024),
        fingerprint: repeated('f', 128),
        generation: 1,
      },
      users: Array.from({ length: MAX_PLATFORM_ACTIVE_USERS }, () => ({
        id,
        username: repeated('n', 64),
        status: UserStatus.Active,
        publicKeys: Array.from(
          { length: MAX_SSH_PUBLIC_KEYS_PER_USER },
          () => repeated('k', MAX_SSH_PUBLIC_KEY_TEXT_LENGTH),
        ),
      })),
      servers: Array.from({ length: MAX_PLATFORM_SERVERS }, () => ({
        id,
        slug: repeated('s', 64),
        name: 'Incus',
        status: ServerStatus.Online,
      })),
      images: Array.from({ length: MAX_PLATFORM_IMAGES }, () => ({ id, sshEnabled: true })),
      containers: Array.from({ length: MAX_SSH_PROXY_CONTAINERS }, () => ({
        id,
        ownerId: id,
        serverId: id,
        imageId: id,
        name: repeated('c', 64),
        instanceName: 'nyc-11111111111141118111111111111111',
      })),
      routes: Array.from({ length: MAX_SSH_PROXY_CONTAINERS }, () => ({
        containerId: id,
        serverId: id,
        instanceName: 'nyc-11111111111141118111111111111111',
        routedIp: '192.0.2.10',
        status: ContainerStatus.Running,
        sshStatus: 'running',
        containerHostKeyFingerprint: repeated('f', 128),
        observedAt: repeated('o', 64),
      })),
    });
    expect(encodedBytes({ ts: Number.MAX_SAFE_INTEGER, kind: 'snapshot', payload: snapshot }))
      .toBeLessThan(MAX_SSH_PROXY_SNAPSHOT_BYTES);
  });
});

describe('bounded HTTP proxy snapshots', () => {
  it('uses routed IP and instance name in every route', () => {
    expect(zHttpProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      routes: [{
        bindingId: id,
        hostname: 'app.example.test',
        domainPoolId: id,
        routedIp: '192.0.2.10',
        targetPort: 8080,
        ownerId: id,
        containerId: id,
        containerName: 'work',
        instanceName: 'nyc-11111111111141118111111111111111',
        status: ContainerStatus.Running,
      }],
      domainPools: [],
    }).routes[0]?.instanceName).toMatch(/^nyc-/);
  });

  it('keeps the largest legal HTTP snapshot below its wire buffer', () => {
    const snapshot = zHttpProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      routes: Array.from({ length: MAX_HTTP_PROXY_ROUTES }, () => ({
        bindingId: id,
        hostname: repeated('h', 253),
        domainPoolId: id,
        routedIp: '255.255.255.25',
        targetPort: 65_535,
        ownerId: id,
        containerId: id,
        containerName: repeated('c', 64),
        instanceName: 'nyc-11111111111141118111111111111111',
        status: ContainerStatus.Running,
      })),
      domainPools: Array.from({ length: MAX_HTTP_PROXY_DOMAIN_POOLS }, () => ({
        id,
        wildcardDomain: repeated('w', 255),
        enabled: true,
        httpsEnabled: true,
        certificatePem: repeated('x', MAX_HTTP_PROXY_CERTIFICATE_PEM_LENGTH),
        privateKeyPem: repeated('y', MAX_HTTP_PROXY_PRIVATE_KEY_PEM_LENGTH),
        certificateFingerprint: repeated('f', 128),
        certificateNotAfter: repeated('d', 64),
      })),
    });
    expect(encodedBytes({ ts: Number.MAX_SAFE_INTEGER, kind: 'snapshot', payload: snapshot }))
      .toBeLessThan(MAX_HTTP_PROXY_SNAPSHOT_BYTES);
  });
});
