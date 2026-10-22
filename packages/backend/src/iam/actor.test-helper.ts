import { Role } from '@nyabase/common';
import type { Actor } from './actor.js';

/** A JWT-authenticated actor with the given role (a plain user by default). */
export function testActor(userId: string, role: Role = Role.User): Actor {
  return {
    userId,
    role,
    authKind: 'jwt',
    authVersion: 1,
  };
}
