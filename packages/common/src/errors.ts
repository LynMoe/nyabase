import { FailureCode } from './enums.js';

export enum ErrorCode {
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  InvalidCredentials = 'INVALID_CREDENTIALS',
  TokenExpired = 'TOKEN_EXPIRED',
  NotFound = 'NOT_FOUND',
  AlreadyExists = 'ALREADY_EXISTS',
  Conflict = 'CONFLICT',
  ValidationError = 'VALIDATION_ERROR',
  InvalidInput = 'INVALID_INPUT',
  StorageGrantExceeded = FailureCode.StorageGrantExceeded,
  StoragePoolExhausted = FailureCode.StoragePoolExhausted,
  StoragePoolQuotaIneffective = FailureCode.StoragePoolQuotaIneffective,
  NetworkAddressExhausted = FailureCode.NetworkAddressExhausted,
  IpPoolNotConfigured = FailureCode.IpPoolNotConfigured,
  SharedBackendQuotaExceeded = FailureCode.SharedBackendQuotaExceeded,
  VolumeShrinkBelowUsage = FailureCode.VolumeShrinkBelowUsage,
  VolumeShrinkRequiresDetach = FailureCode.VolumeShrinkRequiresDetach,
  VolumeShrinkUnsupported = FailureCode.VolumeShrinkUnsupported,
  VolumeUsageUnknown = FailureCode.VolumeUsageUnknown,
  VolumeRequiresUnbind = FailureCode.VolumeRequiresUnbind,
  VolumeDeleteBackendUnreachable = FailureCode.VolumeDeleteBackendUnreachable,
  VolumeDetachRequiresStop = FailureCode.VolumeDetachRequiresStop,
  RootShrinkBelowUsage = FailureCode.RootShrinkBelowUsage,
  RootShrinkRequiresStop = FailureCode.RootShrinkRequiresStop,
  RootSizeBelowImageMinimum = FailureCode.RootSizeBelowImageMinimum,
  RootUsageUnknown = FailureCode.RootUsageUnknown,
  VolumeCatalogAdoptFailed = FailureCode.VolumeCatalogAdoptFailed,
  VolumePlacementFailed = FailureCode.VolumePlacementFailed,
  ImageManagesOwnNetwork = FailureCode.ImageManagesOwnNetwork,
  ImageNotAvailable = FailureCode.ImageNotAvailable,
  ServerUnreachable = FailureCode.ServerUnreachable,
  InstanceBusy = FailureCode.InstanceBusy,
  InternalError = 'INTERNAL_ERROR',
}

export interface ApiError {
  code: ErrorCode | FailureCode | string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}
