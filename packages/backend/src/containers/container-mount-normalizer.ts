import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  MAX_CONTAINER_MOUNTS,
  zContainerMountInput,
  type CreateContainerRequest,
} from '@nyabase/common';

export type ContainerMountInput = NonNullable<CreateContainerRequest['dataDirs']>[number];
export type NormalizedContainerMount = ContainerMountInput & { id: string };

const zPersistedContainerMount = zContainerMountInput.extend({
  // Older rows persisted this derived display key. It is never trusted or
  // reused, but remains an explicitly recognized compatibility field.
  id: z.string().min(1).max(4352).optional(),
}).strict();

/**
 * One defensive parser for both request data and the durable JSON snapshot.
 * Controllers already reject unknown request keys; this layer deliberately
 * selects only consumed fields so legacy persisted `id` metadata is harmless.
 */
export function normalizeContainerMounts(value: unknown): NormalizedContainerMount[] {
  if (!Array.isArray(value)) throw new BadRequestException('Invalid container mount list');
  if (value.length > MAX_CONTAINER_MOUNTS) {
    throw new BadRequestException(`At most ${MAX_CONTAINER_MOUNTS} container mounts are supported`);
  }
  const seenPaths = new Set<string>();
  const seenDirs = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('Invalid container mount');
    }
    const parsed = zPersistedContainerMount.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Invalid container mount');

    const containerPath = canonicalContainerPath(parsed.data.containerPath);
    // Keep this check even though the shared request schema rejects slash-only
    // paths: durable rows can predate that boundary and must never turn into an
    // Agent mount whose target is the container root.
    if (containerPath === '/') {
      throw new BadRequestException('Container mount path must not be root');
    }
    if (seenPaths.has(containerPath)) {
      throw new BadRequestException('Duplicate container mount path');
    }
    seenPaths.add(containerPath);
    const sourceDir = `${parsed.data.sourceKind}:${parsed.data.sourceId}:${parsed.data.dirName}`;
    if (seenDirs.has(sourceDir)) {
      throw new BadRequestException('Duplicate mount source directory');
    }
    seenDirs.add(sourceDir);
    return {
      ...parsed.data,
      containerPath,
      id: `${sourceDir}:${containerPath}`,
    };
  });
}

function canonicalContainerPath(value: string): string {
  // zContainerMountInput has already rejected dot segments, excessive length
  // and controls. Collapse repeated separators for one durable identity, then
  // let the caller reject every spelling that canonicalizes to root.
  return `/${value.split('/').filter(Boolean).join('/')}`;
}
