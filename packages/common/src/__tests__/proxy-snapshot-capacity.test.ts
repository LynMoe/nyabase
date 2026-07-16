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
  UserStatus,
  zHttpProxySnapshot,
  zSshProxySnapshot,
} from '../index.js';

const repeated = (char: string, length: number): string => char.repeat(length);
const encodedBytes = (value: unknown): number => new TextEncoder()
  .encode(JSON.stringify(value)).byteLength;

describe('bounded proxy snapshot product capacities', () => {
  it('keeps the largest legal SSH snapshot below its wire buffer', () => {
    const id = repeated('i', 64);
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
        internalPrivateKey: repeated('q', 4 * 1024),
        internalPublicKey: repeated('v', 2 * 1024),
        internalKeyFingerprint: repeated('g', 128),
        internalKeyGeneration: 1,
      })),
      servers: Array.from({ length: MAX_PLATFORM_SERVERS }, () => ({
        id, slug: repeated('s', 64), name: '😀'.repeat(64), online: true,
      })),
      images: Array.from({ length: MAX_PLATFORM_IMAGES }, () => ({ id, disableSsh: false })),
      containers: Array.from({ length: MAX_SSH_PROXY_CONTAINERS }, () => ({
        id,
        ownerId: id,
        serverId: id,
        imageId: id,
        name: repeated('c', 64),
      })),
      routes: Array.from({ length: MAX_SSH_PROXY_CONTAINERS }, () => ({
        containerId: id,
        serverId: id,
        runtimeId: repeated('r', 128),
        macvlanIp: '255.255.255.25',
        runtimeStatus: ContainerStatus.Running,
        sshStatus: 'running',
        appliedInternalKeyGeneration: 1,
        containerHostKeyFingerprint: repeated('f', 128),
        observedAt: repeated('o', 64),
      })),
    });

    expect(encodedBytes({ ts: Number.MAX_SAFE_INTEGER, kind: 'snapshot', payload: snapshot }))
      .toBeLessThan(MAX_SSH_PROXY_SNAPSHOT_BYTES);
  });

  it('rejects multibyte data from fields whose capacity proof assumes one byte per character', () => {
    expect(() => zSshProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      endpoint: null,
      hostKey: {
        privateKey: 'key', publicKey: 'key', fingerprint: 'fingerprint', generation: 1,
      },
      users: [],
      servers: [],
      images: [{ id: '😀'.repeat(32), disableSsh: false }],
      containers: [],
      routes: [],
    })).toThrow();
  });

  it('accepts bounded multiline ASCII key material without weakening byte accounting', () => {
    expect(() => zSshProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      endpoint: null,
      hostKey: {
        privateKey: '-----BEGIN KEY-----\nbody\n-----END KEY-----\n',
        publicKey: 'ssh-ed25519 AAAA\n',
        fingerprint: 'SHA256:fingerprint',
        generation: 1,
      },
      users: [{
        id: 'user-a', username: 'user-a', status: UserStatus.Active, publicKeys: [],
        internalPrivateKey: '-----BEGIN KEY-----\nbody\n-----END KEY-----\n',
        internalPublicKey: 'ssh-ed25519 AAAA\n',
        internalKeyFingerprint: 'fingerprint', internalKeyGeneration: 1,
      }],
      servers: [], images: [], containers: [], routes: [],
    })).not.toThrow();

    expect(() => zHttpProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      routes: [],
      domainPools: [{
        id: 'pool-a', wildcardDomain: '*.example.test', enabled: true, httpsEnabled: true,
        certificatePem: '-----BEGIN CERTIFICATE-----\nbody\n-----END CERTIFICATE-----\n',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\n',
        certificateFingerprint: 'fingerprint', certificateNotAfter: null,
      }],
    })).not.toThrow();
  });

  it('keeps the largest legal HTTP snapshot below its wire buffer', () => {
    const id = repeated('i', 64);
    const snapshot = zHttpProxySnapshot.parse({
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 120_000,
      validUntil: 120_000,
      routes: Array.from({ length: MAX_HTTP_PROXY_ROUTES }, () => ({
        bindingId: id,
        hostname: repeated('h', 253),
        domainPoolId: id,
        targetIp: '255.255.255.25',
        targetPort: 65535,
        ownerId: id,
        containerId: id,
        containerName: repeated('c', 64),
        runtimeId: repeated('r', 128),
        runtimeStatus: ContainerStatus.Running,
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
