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
      expect(repo.findAndCount).not.toHaveBeenCalled();
      expect(repo.find).not.toHaveBeenCalled();
    },
  );

  it('retains the documented limit cap but rejects zero and malformed limits', async () => {
    const repo = repository();
    repo.findAndCount.mockResolvedValue([[], 0]);
    const controller = new AuditController(repo as never);

    await expect(controller.list('999', '0')).resolves.toEqual({
      items: [], total: 0, limit: 500, offset: 0,
    });
    expect(repo.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ take: 500, skip: 0 }));
    for (const limit of ['0', '1e2', ' 10', '9007199254740992']) {
      await expect(controller.list(limit, '0')).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects a non-canonical audit id before repository work', async () => {
    const repo = repository();
    const controller = new AuditController(repo as never);
    await expect(controller.detail('../audit')).rejects.toBeDefined();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

function repository() {
  return {
    find: vi.fn(),
    findAndCount: vi.fn(),
    findOne: vi.fn(),
  };
}
