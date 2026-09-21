import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ImagesService } from './images.service.js';

const catalogEntry = {
  alias: 'ubuntu/24.04',
  aliases: ['ubuntu/24.04', 'ubuntu/noble'],
  fingerprint: 'b'.repeat(64),
  os: 'Ubuntu',
  release: '24.04',
  variant: 'default',
  version: '20260920_07:42',
  sizeBytes: 1,
  description: 'Ubuntu 24.04 v20260920_07:42',
};

function service(existing: { id: string; deleting: boolean } | undefined) {
  const database = {
    selectFrom: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue(existing),
    })),
  };
  const catalog = {
    requireAlias: vi.fn().mockResolvedValue(catalogEntry),
    list: vi.fn(),
  };
  return new ImagesService(
    database as never,
    { run: vi.fn() } as never,
    { assertActorCapabilitiesInTransaction: vi.fn() } as never,
    { append: vi.fn() } as never,
    { ensurePending: vi.fn() } as never,
    { wake: vi.fn() } as never,
    undefined,
    catalog as never,
  );
}

describe('ImagesService.addFromCatalog conflicts', () => {
  it('rejects an alias that is already in the catalog', async () => {
    const images = service({ id: 'img-1', deleting: false });
    try {
      await images.addFromCatalog('actor', { alias: 'ubuntu/24.04' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'IMAGE_ALIAS_EXISTS',
      });
    }
  });

  it('rejects re-adding an alias while the previous row is still deleting', async () => {
    const images = service({ id: 'img-1', deleting: true });
    try {
      await images.addFromCatalog('actor', { alias: 'ubuntu/24.04' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'IMAGE_ALIAS_DELETING',
      });
    }
  });
});
