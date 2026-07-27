import type {
  AgentTaskKind,
  AgentTaskStatus,
  ImageRuntimeOverrides,
  RemoteFsParams,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';

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

export const AGENT_INVENTORY_FAULT_QUARANTINE_CODE = 'AGENT_INVENTORY_FAULT';
export const AGENT_TASK_FAIL_STOP_QUARANTINE_CODE = 'AGENT_TASK_FAIL_STOP';

export interface ServerRecord {
  id: string;
  name: string;
  slug: string;
  agentTokenHash: string;
  hostFingerprint: string | null;
  agentConfigFingerprint: string | null;
  status: ServerStatus;
  quarantineCode: string | null;
  quarantineMessage: string | null;
  lastSeenAt: Date | null;
  macvlanCidr: string | null;
  macvlanGateway: string | null;
  macvlanReservedIps: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ImageRecord {
  id: string;
  name: string;
  dockerImage: string;
  runtimeOverrides: ImageRuntimeOverrides;
  description: string | null;
  isActive: boolean;
  disableSsh: boolean;
  deleting: boolean;
  cleanupGeneration: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentTaskRecord {
  id: string;
  kind: AgentTaskKind;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  requestJson: unknown | null;
  payloadJson: unknown;
  payloadHash: string;
  admissionClass: 'normal' | 'reconciliation' | 'safety';
  status: AgentTaskStatus;
  failureStage: 'dispatch' | 'agent' | 'finalizer' | null;
  agentResultJson: unknown | null;
  dispatchAttemptCount: number;
  incompleteResultCount: number;
  retryWindowStartedAt: Date | null;
  nextDispatchAt: Date | null;
  finalizerAttemptCount: number;
  finalizerRetryAt: Date | null;
  resultJson: unknown | null;
  errorJson: unknown | null;
  createdAt: Date;
  startedAt: Date | null;
  lastSentAt: Date | null;
  completedAt: Date | null;
}

export interface DataDirectoryRecord {
  id: string;
  userId: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  name: string;
  sourceIdentity: string;
  serverId: string | null;
  uid: number;
  desiredState: 'creating' | 'active' | 'removing' | 'failed';
  generation: number;
  lastTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MountSourceGrantRecord {
  id: string;
  scope: 'user' | 'group';
  scopeId: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  serverId: string | null;
  sourceIdentity: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuotaDesiredRecord {
  id: string;
  serverId: string;
  userId: string;
  numericUserId: number | null;
  limitBytes: number;
  source: string;
  generation: number;
  lastTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RemoteFsMountRecord {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  type: string;
  hostMountPoint: string;
  options: string;
  params: RemoteFsParams;
  desiredState: 'active' | 'removing';
  generation: number;
  lastTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RemoteFsServerAssignmentRecord {
  id: string;
  remoteFsMountId: string;
  serverId: string;
  desiredState: 'ensuring' | 'active' | 'removing' | 'failed';
  generation: number;
  lastTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
