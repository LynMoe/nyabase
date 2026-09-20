import { describe, expect, it } from 'vitest';
import { displayNameForCatalog, parseSimplestreamsProducts } from './image-catalog.js';

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
    expect(displayNameForCatalog(entries[0]!)).toBe('Ubuntu 24.04');
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
});
