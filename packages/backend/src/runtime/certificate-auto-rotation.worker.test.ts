import { describe, expect, it, vi } from 'vitest';
import {
  CertificateAutoRotationWorker,
  CERTIFICATE_ROTATION_WARNING_MS,
} from './certificate-auto-rotation.worker.js';

function chain<T>(value: T) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['selectAll', 'select', 'where', 'orderBy']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.executeTakeFirst = vi.fn().mockResolvedValue(value);
  builder.execute = vi.fn().mockResolvedValue(Array.isArray(value) ? value : []);
  return builder;
}

function worker(options: {
  active?: Record<string, unknown> | null;
  staged?: Record<string, unknown> | null;
  pendingIntent?: Record<string, unknown> | null;
  systemUser?: Record<string, unknown> | null;
  now: Date;
  rotateAsSystem?: ReturnType<typeof vi.fn>;
  runsWorker?: boolean;
}) {
  let certificateReads = 0;
  const database = {
    selectFrom: vi.fn((table: string) => {
      if (table === 'system.incus_client_certificates') {
        const builder = chain(null);
        builder.executeTakeFirst = vi.fn(async () => {
          certificateReads += 1;
          return certificateReads === 1 ? (options.active ?? null) : (options.staged ?? null);
        });
        return builder;
      }
      if (table === 'control.intents') return chain(options.pendingIntent ?? null);
      if (table === 'iam.users') return chain(options.systemUser ?? null);
      return chain(null);
    }),
  };
  const rotateAsSystem = options.rotateAsSystem ?? vi.fn().mockResolvedValue({ status: 'pending' });
  const instance = new CertificateAutoRotationWorker(
    database as never,
    { runsWorker: () => options.runsWorker ?? true } as never,
    { get: vi.fn() } as never,
    { now: () => options.now },
    { rotateAsSystem } as never,
  );
  return { instance, rotateAsSystem, database };
}

describe('CertificateAutoRotationWorker', () => {
  const now = new Date('2026-08-13T00:00:00Z');
  const systemUser = { id: '00000000-0000-4000-8000-000000000099' };

  it('enqueues rotateAsSystem when remaining lifetime is within 90 days', async () => {
    const { instance, rotateAsSystem } = worker({
      now,
      active: {
        generation: '1',
        state: 'active',
        not_after: new Date(now.getTime() + CERTIFICATE_ROTATION_WARNING_MS),
      },
      systemUser,
    });

    await instance.tick();

    expect(rotateAsSystem).toHaveBeenCalledWith(systemUser.id, 1);
  });

  it('does not enqueue when more than 90 days remain', async () => {
    const { instance, rotateAsSystem } = worker({
      now,
      active: {
        generation: '1',
        state: 'active',
        not_after: new Date(now.getTime() + CERTIFICATE_ROTATION_WARNING_MS + 1),
      },
    });

    await instance.tick();

    expect(rotateAsSystem).not.toHaveBeenCalled();
  });

  it('skips the tick when nyabase-system is absent', async () => {
    const { instance, rotateAsSystem, database } = worker({
      now,
      active: {
        generation: '1',
        state: 'active',
        not_after: new Date(now.getTime() + CERTIFICATE_ROTATION_WARNING_MS),
      },
      systemUser: null,
    });

    await instance.tick();

    expect(database.selectFrom).toHaveBeenCalledWith('iam.users');
    expect(rotateAsSystem).not.toHaveBeenCalled();
  });

  it('does not start when the process is not a worker role', async () => {
    const { instance, rotateAsSystem } = worker({
      now,
      runsWorker: false,
      active: {
        generation: '1',
        state: 'active',
        not_after: now,
      },
    });

    await instance.tick();
    expect(rotateAsSystem).not.toHaveBeenCalled();
  });
});
