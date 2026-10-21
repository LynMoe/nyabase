import type { UserStatus } from '@nyabase/common';

/**
 * The authenticated principal attached to a request. It describes the
 * service-facing camelCase contract; SQL table/column shapes remain in the
 * focused `*-database.types.ts` files.
 */

export interface UserRecord {
  id: string;
  numericId: number;
  username: string;
  passwordHash: string;
  displayName: string;
  status: UserStatus;
  authVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
