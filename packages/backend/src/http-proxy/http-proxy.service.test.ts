import { BadRequestException } from '@nestjs/common';
import {
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
} from '@nyabase/common';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpProxyService } from './http-proxy.service.js';

describe('HttpProxyService request boundaries', () => {
  const service = makeService();

  it('rejects unknown and empty partial mutation fields before persistence', async () => {
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

  it.each([
    '*.apps.example.test',
    'bad host.apps.example.test',
    'https://a.apps.example.test',
    'a.apps.example.test:443',
  ])('maps invalid binding hostname %s to the stable 400 contract', async (hostname) => {
    await expect(service.createBinding('user-a', {
      hostname,
      containerId: 'container-a',
      targetPort: 80,
    })).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'INVALID_HTTP_PROXY_HOSTNAME' }),
    });
  });

  it.each([
    'apps..example.test',
    '*.*.example.test',
    'https://*.apps.example.test',
  ])('maps invalid wildcard %s to the stable 400 contract', async (wildcardDomain) => {
    await expect(service.createDomainPool('actor-a', {
      wildcardDomain,
      enabled: true,
      httpsEnabled: false,
    })).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'INVALID_HTTP_PROXY_WILDCARD_DOMAIN',
      }),
    });
  });

  it.each([0, 65_536, 1.5, '80'])(
    'rejects invalid target port %j',
    async (targetPort) => {
      await expect(service.createBinding('user-a', {
        hostname: 'a.apps.example.test',
        containerId: 'container-a',
        targetPort,
      })).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});

describe('HttpProxyService TLS admission', () => {
  let pair: { certificatePem: string; privateKeyPem: string };

  beforeAll(() => {
    pair = selfSignedPair('*.apps.example.test', 2);
  });

  it('accepts a currently valid matching wildcard key pair', () => {
    const fields = certFields(makeService(), pair, '*.apps.example.test');
    expect(fields.certificate_pem).toBe(pair.certificatePem);
    expect(fields.encrypted_private_key_pem).toMatch(/^v1\./);
    expect(fields.certificate_fingerprint).toMatch(
      /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/,
    );
    expect(fields.certificate_not_after).toBeInstanceOf(Date);
  });

  it('rejects mismatched keys and certificates outside the wildcard', () => {
    const otherKey = selfSignedPair('*.other.example.test', 2);
    expect(() => certFields(makeService(), {
      certificatePem: pair.certificatePem,
      privateKeyPem: otherKey.privateKeyPem,
    }, '*.apps.example.test')).toThrow('Certificate and private key do not match');
    expect(() => certFields(
      makeService(),
      pair,
      '*.other.example.test',
    )).toThrow('Certificate does not cover wildcard domain');
  });

  it('rejects a certificate that cannot outlive a complete snapshot lease', () => {
    const shortPair = selfSignedPair('*.apps.example.test', 1);
    const expiresAt = Date.parse(new X509Certificate(shortPair.certificatePem).validTo);
    const leaseWindow =
      HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS;
    vi.useFakeTimers();
    vi.setSystemTime(expiresAt - Math.floor(leaseWindow / 2));
    try {
      expect(() => certFields(
        makeService(),
        shortPair,
        '*.apps.example.test',
      )).toThrow('Certificate expires before the proxy snapshot lease can safely drain');
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires certificate and private key together', () => {
    expect(() => privateMethods(makeService()).certFields(
      pair.certificatePem,
      undefined,
      '*.apps.example.test',
    )).toThrow('Both certificatePem and privateKeyPem are required');
  });
});

function makeService(): HttpProxyService {
  return new HttpProxyService(
    {} as never,
    { run: vi.fn() } as never,
    {
      get: vi.fn((key: string) =>
        key === 'ssh.keyEncryptionSecret' ? 'test-secret' : 'jwt-secret'),
    } as never,
    { assertActorCapabilitiesInTransaction: vi.fn() } as never,
    { isServerBlocked: vi.fn().mockReturnValue(false) } as never,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
  );
}

function privateMethods(service: HttpProxyService): {
  certFields(
    certificatePem: string | null | undefined,
    privateKeyPem: string | null | undefined,
    wildcardDomain: string,
  ): {
    certificate_pem: string | null;
    encrypted_private_key_pem: string | null;
    certificate_fingerprint: string | null;
    certificate_not_after: Date | null;
  };
} {
  return service as unknown as {
    certFields(
      certificatePem: string | null | undefined,
      privateKeyPem: string | null | undefined,
      wildcardDomain: string,
    ): {
      certificate_pem: string | null;
      encrypted_private_key_pem: string | null;
      certificate_fingerprint: string | null;
      certificate_not_after: Date | null;
    };
  };
}

function certFields(
  service: HttpProxyService,
  pair: { certificatePem: string; privateKeyPem: string },
  wildcardDomain: string,
) {
  return privateMethods(service).certFields(
    pair.certificatePem,
    pair.privateKeyPem,
    wildcardDomain,
  );
}

function selfSignedPair(
  wildcardDomain: string,
  days: number,
): { certificatePem: string; privateKeyPem: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nyabase-http-proxy-cert-'));
  const certificatePath = join(dir, 'certificate.pem');
  const privateKeyPath = join(dir, 'private-key.pem');
  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      privateKeyPath,
      '-out',
      certificatePath,
      '-days',
      String(days),
      '-subj',
      `/CN=${wildcardDomain}`,
      '-addext',
      `subjectAltName=DNS:${wildcardDomain}`,
    ], { stdio: 'ignore' });
    return {
      certificatePem: readFileSync(certificatePath, 'utf8'),
      privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
