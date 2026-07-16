import { z } from 'zod';
import type { MountSourceGrantTarget } from './mount-sources.service.js';

export const zMountSourceGrantTarget = z.discriminatedUnion('sourceKind', [
  z.object({
    sourceKind: z.literal('local'),
    sourceId: z.string().min(1),
    serverId: z.string().min(1),
  }).strict(),
  z.object({
    sourceKind: z.literal('remote'),
    sourceId: z.string().min(1),
  }).strict(),
]);

export function parseMountSourceGrantTarget(
  sourceKind: unknown,
  sourceId: unknown,
  serverId: unknown,
): MountSourceGrantTarget {
  return zMountSourceGrantTarget.parse({
    sourceKind,
    sourceId,
    ...(serverId === undefined ? {} : { serverId }),
  });
}
