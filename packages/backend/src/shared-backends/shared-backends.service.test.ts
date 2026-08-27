import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { FailureCode } from '@nyabase/common';
import { SharedBackendsService } from './shared-backends.service.js';

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ceph',
  display_name: null,
  identity_key: 'cephfs:ceph/pool/data',
  ceph_fsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  total_bytes: null,
  used_bytes: null,
  overcommit_ratio: 1,
  revision: 1,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

function createCommittedQuery(rows: Array<{ shared_backend_id: string; used: string }> = []) {
  return {
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue(rows),
  };
}

function createService(
  overrides: Record<string, unknown> = {},
  committedRows: Array<{ shared_backend_id: string; used: string }> = [],
) {
  const repository = {
    findByIdentityForUpdate: vi.fn().mockResolvedValue(undefined),
    findByFsidForUpdate: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(baseRow),
    findByIdForUpdate: vi.fn().mockResolvedValue(baseRow),
    insert: vi.fn().mockImplementation(async (input) => ({
      ...baseRow,
      id: input.id,
      name: input.name,
      display_name: input.displayName,
      identity_key: input.identityKey,
      ceph_fsid: input.cephFsid,
      overcommit_ratio: input.overcommitRatio,
    })),
    patch: vi.fn().mockResolvedValue({ ...baseRow, revision: 2 }),
    list: vi.fn().mockResolvedValue([{ ...baseRow, server_ids: [] }]),
    hasDependencies: vi.fn().mockResolvedValue(false),
    delete: vi.fn().mockResolvedValue({ numDeletedRows: 1n }),
    ...overrides,
  };
  const transactions = {
    run: vi.fn().mockImplementation(async (work) => work({})),
  };
  const committedQuery = createCommittedQuery(committedRows);
  const database = {
    selectFrom: vi.fn().mockReturnValue(committedQuery),
  };
  return {
    service: new SharedBackendsService(
      repository as never,
      transactions as never,
      database as never,
    ),
    repository,
    transactions,
    database,
    committedQuery,
  };
}

describe('SharedBackendsService registration guards', () => {
  it('normalizes registration identity and FSID before persistence', async () => {
    const { service, repository } = createService();

    const result = await service.create({
      name: 'ceph',
      identityKey: '  cephfs:ceph/pool/data ',
      cephFsid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      overcommitRatio: 1,
    });

    expect(result.identityKey).toBe('cephfs:ceph/pool/data');
    expect(result.cephFsid).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        identityKey: 'cephfs:ceph/pool/data',
        cephFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
      expect.anything(),
    );
  });

  it('rejects an identity reused with a different FSID', async () => {
    const { service } = createService({
      findByIdentityForUpdate: vi.fn().mockResolvedValue(baseRow),
    });

    await expect(service.create({
      name: 'other',
      identityKey: baseRow.identity_key,
      cephFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      overcommitRatio: 1,
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: FailureCode.SharedBackendIdentityConflict,
      }),
    });
  });

  it('rejects changing an FSID while pools or volumes reference the backend', async () => {
    const { service } = createService({
      hasDependencies: vi.fn().mockResolvedValue(true),
    });

    await expect(service.patch(baseRow.id, {
      expectedRevision: 1,
      cephFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('exposes committed volume size as usedBytes instead of null DB usage', async () => {
    const { service } = createService(
      {},
      [{ shared_backend_id: baseRow.id, used: '4294967296' }],
    );

    const listed = await service.list();
    expect(listed[0]?.usedBytes).toBe(4_294_967_296);

    const got = await service.get(baseRow.id);
    expect(got.usedBytes).toBe(4_294_967_296);
  });

  it('returns zero usedBytes when no active volumes commit capacity', async () => {
    const { service } = createService();
    const listed = await service.list();
    expect(listed[0]?.usedBytes).toBe(0);
  });
});
