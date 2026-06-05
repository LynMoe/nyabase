export enum ErrorCode {
  // Auth
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  InvalidCredentials = 'INVALID_CREDENTIALS',
  TokenExpired = 'TOKEN_EXPIRED',

  // Resource
  NotFound = 'NOT_FOUND',
  AlreadyExists = 'ALREADY_EXISTS',
  Conflict = 'CONFLICT',

  // Validation
  ValidationError = 'VALIDATION_ERROR',
  InvalidInput = 'INVALID_INPUT',

  // Quota
  QuotaExceeded = 'QUOTA_EXCEEDED',
  QuotaBelowUsage = 'QUOTA_BELOW_USAGE',

  // Agent
  AgentOffline = 'AGENT_OFFLINE',
  AgentTimeout = 'AGENT_TIMEOUT',
  AgentError = 'AGENT_ERROR',

  // Container
  ContainerNotFound = 'CONTAINER_NOT_FOUND',
  ContainerNotRunning = 'CONTAINER_NOT_RUNNING',
  ContainerAlreadyExists = 'CONTAINER_ALREADY_EXISTS',

  // Network
  NoIpAvailable = 'NO_IP_AVAILABLE',

  // Disk
  DataDirInUse = 'DATA_DIR_IN_USE',
  DataDirNotFound = 'DATA_DIR_NOT_FOUND',
  DiskFull = 'DISK_FULL',

  // Internal
  InternalError = 'INTERNAL_ERROR',
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
