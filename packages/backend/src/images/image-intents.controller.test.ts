import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { IntentKind, IntentResourceType, IntentStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { IntentRecord, IntentRepository } from '../reconcile/intent.repository.js';
import { AdminImageIntentsController } from './image-intents.controller.js';
import type { ImagesService } from './images.service.js';

function intent(overrides: Partial<IntentRecord> = {}): IntentRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: IntentKind.ImageAssignmentEnsure,
    resourceType: IntentResourceType.ImageAssignment,
    resourceId: '00000000-0000-4000-8000-000000000002',
    serverId: '00000000-0000-4000-8000-000000000003',
    requestedBy: null,
    request: {},
    targetRevision: 1,
    baseline: null,
    status: IntentStatus.Failed,
    failureCode: 'IMAGE_ENSURE_FAILED',
    failure: { code: 'IMAGE_ENSURE_FAILED', message: 'failed' },
    attemptCount: 1,
    nextAttemptAt: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    settledAt: '2026-08-13T00:00:01.000Z',
    blockedByIntentId: null,
    ...overrides,
  };
}

const imageId = '3f0e8c4e-956a-4484-82ea-5a146db03aac';
const assignmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function imageIntentsController(options: {
  image?: { id: string } | undefined;
  assignments?: readonly { id: string }[];
  list?: ReturnType<typeof vi.fn>;
}) {
  const intents = {
    list: options.list ?? vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const images = {
    listAssignmentIds: vi.fn(async () => {
      if (!options.image) throw new NotFoundException('Image not found');
      return (options.assignments ?? []).map((assignment) => assignment.id);
    }),
  };
  return {
    controller: new AdminImageIntentsController(
      intents as unknown as IntentRepository,
      images as unknown as ImagesService,
    ),
    intents,
  };
}

describe('AdminImageIntentsController', () => {
  it('404s when the image row is missing and does not list intents', async () => {
    const { controller: admin, intents } = imageIntentsController({ image: undefined });
    await expect(admin.list(imageId, { limit: '20' })).rejects.toBeInstanceOf(NotFoundException);
    expect(intents.list).not.toHaveBeenCalled();
  });

  it('returns an empty page without listing when the image has no assignments', async () => {
    const { controller: admin, intents } = imageIntentsController({
      image: { id: imageId },
      assignments: [],
    });
    await expect(admin.list(imageId, { limit: '20' })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(intents.list).not.toHaveBeenCalled();
  });

  it('lists assignment intents and maps them through toDto', async () => {
    const record = intent({
      kind: IntentKind.ImageAssignmentEnsure,
      resourceType: IntentResourceType.ImageAssignment,
      resourceId: assignmentId,
      request: { alias: 'ubuntu/24.04' },
    });
    const { controller: admin, intents } = imageIntentsController({
      image: { id: imageId },
      assignments: [{ id: assignmentId }],
      list: vi.fn().mockResolvedValue({ items: [record], nextCursor: null }),
    });
    const result = await admin.list(imageId, { limit: 20 });
    expect(intents.list).toHaveBeenCalledWith({
      limit: 20,
      cursor: undefined,
      status: undefined,
      kind: undefined,
      resourceType: 'image_assignment',
      resourceIds: [assignmentId],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty('request');
    expect(result.items[0].requestSummary).toEqual({ alias: 'ubuntu/24.04' });
    expect(result.items[0].id).toBe(record.id);
    expect(result.items[0].resourceId).toBe(assignmentId);
    expect(result.nextCursor).toBeNull();
  });

  it('does not re-register image intent list routes on AdminImagesController', () => {
    const source = readFileSync('src/images/admin-images.controller.ts', 'utf8');
    expect(source).not.toMatch(/@Get\(':id\/intents'\)/);
    expect(source).not.toMatch(/@Get\(':id\/assignments\/:serverId\/intents'\)/);
  });
});

