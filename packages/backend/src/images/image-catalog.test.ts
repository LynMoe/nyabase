import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImageCatalogService,
  parseSimplestreamsProducts,
  pickSimplestreamsVersion,
} from './image-catalog.js';

describe('parseSimplestreamsProducts', () => {
  it('reads container aliases and squashfs fingerprints', () => {
    const entries = parseSimplestreamsProducts({
      products: {
        'ubuntu:24.04:amd64:default': {
          aliases: 'ubuntu/24.04,ubuntu/noble',
          os: 'Ubuntu',
          release: '24.04',
          variant: 'default',
          versions: {
            '1': {
              items: {
                'incus.tar.xz': {
                  ftype: 'incus.tar.xz',
                  sha256: 'a'.repeat(64),
                  combined_squashfs_sha256: 'b'.repeat(64),
                },
                'root.squashfs': {
                  ftype: 'squashfs',
                  sha256: 'c'.repeat(64),
                  size: 140283904,
                },
              },
            },
          },
        },
      },
    });
    expect(entries).toEqual([
      expect.objectContaining({
        alias: 'ubuntu/24.04',
        aliases: ['ubuntu/24.04', 'ubuntu/noble'],
        fingerprint: 'b'.repeat(64),
        release: '24.04',
        version: '1',
        sizeBytes: 140283904,
      }),
    ]);
  });

  it('skips products without a squashfs fingerprint', () => {
    expect(parseSimplestreamsProducts({
      products: {
        'vm-only': {
          aliases: 'vm/only',
          versions: { '1': { items: { 'disk.qcow2': { ftype: 'disk-kvm.img' } } } },
        },
      },
    })).toEqual([]);
  });

  it('rejects missing products', () => {
    expect(() => parseSimplestreamsProducts({})).toThrow(BadGatewayException);
    expect(() => parseSimplestreamsProducts({ products: [] })).toThrow(BadGatewayException);
    expect(() => parseSimplestreamsProducts(null)).toThrow(BadGatewayException);
  });

  it('lowercases mixed-case squashfs fingerprints', () => {
    const entries = parseSimplestreamsProducts({
      products: {
        'ubuntu:24.04:amd64:default': {
          aliases: 'ubuntu/24.04',
          os: 'Ubuntu',
          release: '24.04',
          versions: {
            '20260920_07:42': {
              items: {
                'incus.tar.xz': {
                  ftype: 'incus.tar.xz',
                  combined_squashfs_sha256: 'B'.repeat(64),
                },
                'root.squashfs': { ftype: 'squashfs', size: 1 },
              },
            },
          },
        },
      },
    });
    expect(entries[0]?.fingerprint).toBe('b'.repeat(64));
  });

  it('prefers Incus-visible dated versions over short pins', () => {
    expect(pickSimplestreamsVersion(['1', '20240921_07:42', '20260920_07:42'])).toBe('20260920_07:42');
    expect(pickSimplestreamsVersion(['10', '2', '1'])).toBe('10');
    const entries = parseSimplestreamsProducts({
      products: {
        'ubuntu:24.04:amd64:default': {
          aliases: 'ubuntu/24.04',
          os: 'Ubuntu',
          release: '24.04',
          versions: {
            '1': {
              items: {
                'incus.tar.xz': { ftype: 'incus.tar.xz', combined_squashfs_sha256: 'a'.repeat(64) },
                'root.squashfs': { ftype: 'squashfs' },
              },
            },
            '20260920_07:42': {
              items: {
                'incus.tar.xz': { ftype: 'incus.tar.xz', combined_squashfs_sha256: 'b'.repeat(64) },
                'root.squashfs': { ftype: 'squashfs' },
              },
            },
          },
        },
      },
    });
    expect(entries[0]?.version).toBe('20260920_07:42');
    expect(entries[0]?.fingerprint).toBe('b'.repeat(64));
  });
});

describe('ImageCatalogService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function service(url = 'https://images.example.test') {
    return new ImageCatalogService({
      get: () => url,
    } as never);
  }

  it('maps non-JSON catalog bodies to IMAGE_CATALOG_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }));
    try {
      await service().list();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as BadGatewayException).getResponse()).toEqual({
        code: 'IMAGE_CATALOG_INVALID',
        message: 'The image source did not return a simplestreams product catalog',
      });
    }
  });

  it('maps HTTP failures to IMAGE_CATALOG_UNREACHABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    try {
      await service().list();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as BadGatewayException).getResponse()).toMatchObject({
        code: 'IMAGE_CATALOG_UNREACHABLE',
      });
    }
  });

  it('requireAlias 404s when the alias is not published', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: {} }),
    }));
    await expect(service().requireAlias('ubuntu/24.04')).rejects.toBeInstanceOf(NotFoundException);
  });
});
