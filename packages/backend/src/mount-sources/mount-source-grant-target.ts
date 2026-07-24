import { z } from 'zod';
import { zResourceIdentity } from '@nyabase/common';
import type { MountSourceGrantTarget } from './mount-sources.service.js';

export const zMountSourceGrantTarget = z.discriminatedUnion('sourceKind', [
  z.object({
    sourceKind: z.literal('local'),
    sourceId: zResourceIdentity,
    serverId: zResourceIdentity,
  }).strict(),
  z.object({
    sourceKind: z.literal('remote'),
    sourceId: zResourceIdentity,
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
