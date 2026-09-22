import type { ServerStatus, UserStatus } from '@nyabase/common';

/**
 * Plain domain records returned by the SQL repositories.
 *
 * These records intentionally describe the service-facing camelCase contract,
 * not a persistence framework. SQL table/column shapes remain in the focused
 * `*-database.types.ts` files.
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

export interface ServerRecord {
  id: string;
  name: string;
  slug: string;
  apiEndpoint: string;
  serverCertFingerprint: string | null;
  incusVersion: string | null;
  apiExtensions: string[];
  systemPoolId: string | null;
  storageOvercommitRatio: number;
  parentInterface: string | null;
  dnsServers: string[];
  status: ServerStatus;
  lastSeenAt: Date | null;
  lastError: string | null;
  revision: number;
  preflightStatus: 'not_run' | 'running' | 'passed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

export interface ImageRecord {
  id: string;
  alias: string;
  fingerprint: string | null;
  description: string | null;
  loginUser: string;
  minRootSizeBytes: number | null;
  networkManagedExternally: boolean;
  isActive: boolean;
  deleting: boolean;
  cleanupGeneration: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}
