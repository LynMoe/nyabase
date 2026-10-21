import { ForbiddenException } from '@nestjs/common';
import type { Capability } from '@nyabase/common';

export type ActorAuthKind = 'jwt' | 'api-token' | 'system';

/**
 * Who is performing an operation. HTTP requests get theirs from
 * `CapabilitiesGuard` (resolved once per request); internal workers use
 * `SYSTEM_ACTOR`.
 */
export interface Actor {
  readonly userId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly authKind: ActorAuthKind;
  readonly authVersion: number;
}

/**
 * Internal workers (grant expiry, ...) act with this identity. It carries no
 * capabilities: services recognise `authKind === 'system'` and skip owner and
 * capability checks. `userId` is empty because the `nyabase-system` user id is
 * generated per database; callers that persist attribution use
 * `systemActor(id)`.
 */
export const SYSTEM_ACTOR: Actor = Object.freeze({
  userId: '',
  capabilities: new Set<Capability>(),
  authKind: 'system',
  authVersion: 0,
});

/** `SYSTEM_ACTOR` attributed to the database id of the `nyabase-system` user. */
export function systemActor(userId: string): Actor {
  return Object.freeze({ ...SYSTEM_ACTOR, userId });
}

export function isSystemActor(actor: Actor): boolean {
  return actor.authKind === 'system';
}

export function holdsAny(actor: Actor, capabilities: readonly Capability[]): boolean {
  return capabilities.some((capability) => actor.capabilities.has(capability));
}

/**
 * `?scope=all` is only for capability holders. `scope=mine` never needs one.
 * Pass several capabilities when any one of them suffices.
 */
export function assertListScope(
  actor: Actor,
  scope: 'mine' | 'all',
  ...anyOf: Capability[]
): void {
  if (scope === 'all' && !isSystemActor(actor) && !holdsAny(actor, anyOf)) {
    throw new ForbiddenException('scope=all requires an administrator capability');
  }
}
