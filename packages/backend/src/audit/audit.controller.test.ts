import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuditController } from './audit.controller.js';

describe('AuditController request boundaries', () => {
  it.each(['1junk', '1.5', '-1', '01', '9007199254740992'])(
    'rejects non-canonical or unsafe offset %j before querying',
    async (offset) => {
      const repo = repository();
      const controller = new AuditController(repo as never);
      await expect(controller.list('100', offset)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.list).not.toHaveBeenCalled();
    },
  );

  it('rejects offsets beyond the bounded deep-pagination window', async () => {
    const repo = repository();
    const controller = new AuditController(repo as never);
    await expect(controller.list('100', '100001'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('retains the documented limit cap but rejects zero and malformed limits', async () => {
    const repo = repository();
    repo.list.mockResolvedValue({ items: [], total: 0 });
    const controller = new AuditController(repo as never);

    await expect(controller.list('999', '0')).resolves.toEqual({
      items: [], total: 0, limit: 500, offset: 0,
    });
    expect(repo.list).toHaveBeenCalledWith(500, 0, {});
    for (const limit of ['0', '1e2', ' 10', '9007199254740992']) {
      await expect(controller.list(limit, '0')).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects a non-canonical audit id before repository work', async () => {
    const repo = repository();
    const controller = new AuditController(repo as never);
    await expect(controller.detail('../audit')).rejects.toBeDefined();
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('validates and forwards supported filters', async () => {
    const repo = repository();
    repo.list.mockResolvedValue({ items: [], total: 0 });
    const controller = new AuditController(repo as never);

    await controller.list(
      '50',
      '10',
      'group.create',
      'actor-a',
      'group',
      'group-a',
    );

    expect(repo.list).toHaveBeenCalledWith(50, 10, {
      action: 'group.create',
      actorId: 'actor-a',
      targetType: 'group',
      targetId: 'group-a',
    });
    await expect(controller.list(
      '50',
      '0',
      'unknown.action',
    )).rejects.toBeInstanceOf(BadRequestException);
  });
});

function repository() {
  return {
    list: vi.fn(),
    findById: vi.fn(),
  };
}
