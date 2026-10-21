import type { Capability } from '@nyabase/common';
import type { Actor } from './actor.js';

/** A JWT-authenticated actor holding exactly `capabilities`. */
export function testActor(userId: string, ...capabilities: Capability[]): Actor {
  return {
    userId,
    capabilities: new Set(capabilities),
    authKind: 'jwt',
    authVersion: 1,
  };
}
