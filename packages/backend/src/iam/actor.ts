import { ForbiddenException } from '@nestjs/common';
import { Role, roleAtLeast } from '@nyabase/common';

export type UserActorAuthKind = 'jwt' | 'api-token';
export type ActorAuthKind = UserActorAuthKind | 'system';

/** A request authenticated as a user (from `RolesGuard`). */
export interface UserActor {
  readonly userId: string;
  readonly role: Role;
  readonly authKind: UserActorAuthKind;
  readonly authVersion: number;
}

/**
 * Internal workers (grant expiry, ...) act as this actor. It has no user row:
 * `userId` is null, so everything it persists carries NULL attribution (audit
 * `actor_id`, intent `requested_by`, ...). Its role is the lowest one:
 * services recognise `authKind === 'system'` and skip owner and role checks
 * (`hasRole` is always true for it).
 */
export interface SystemActor {
  readonly userId: null;
  readonly role: Role;
  readonly authKind: 'system';
  readonly authVersion: number;
}

/**
 * Who is performing an operation. HTTP requests get theirs from `RolesGuard`
 * (built once per request from the user row); internal workers use
 * `SYSTEM_ACTOR`.
 */
export type Actor = UserActor | SystemActor;

export const SYSTEM_ACTOR: SystemActor = Object.freeze({
  userId: null,
  role: Role.User,
  authKind: 'system',
  authVersion: 0,
});

export function isSystemActor(actor: Actor): actor is SystemActor {
  return actor.authKind === 'system';
}

/** The acting user's id for operations that only a real user can perform (owning, creating). */
export function requireUserId(actor: Actor): string {
  if (actor.userId === null) throw new ForbiddenException('This operation needs a user');
  return actor.userId;
}

/** The actor holds `minimum` or a higher role; the system actor always does. */
export function hasRole(actor: Actor, minimum: Role): boolean {
  return isSystemActor(actor) || roleAtLeast(actor.role, minimum);
}

/** `?scope=all` is only for callers holding `minimum`. `scope=mine` never needs one. */
export function assertListScope(actor: Actor, scope: 'mine' | 'all', minimum: Role): void {
  if (scope === 'all' && !hasRole(actor, minimum)) {
    throw new ForbiddenException(`scope=all requires the ${minimum} role`);
  }
}
