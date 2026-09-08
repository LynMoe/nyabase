import { z } from 'zod';
import {
  Capability,
  CertificateRotationStatus,
  CertificateState,
  CertificateTrustState,
  ContainerPhase,
  ContainerPowerIntent,
  FailureCode,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  NodeMetricsStatus,
  PreflightStatus,
  ResourceLifecyclePhase,
  ServerStatus,
  StoragePoolDriver,
  StoragePoolResizeFamily,
  UserStatus,
} from '../enums.js';
import {
  CONSOLE_DEFAULT_COLS,
  CONSOLE_DEFAULT_ROWS,
  ADMIN_INTENT_LIST_MAX,
  MAX_CONSOLE_COMMAND_ARGUMENT_BYTES,
  MAX_CONSOLE_COMMAND_ARGUMENTS,
  MAX_GROUP_PRIORITY,
  MAX_INTENT_LIST_PAGE_SIZE,
  MAX_PLATFORM_SERVERS,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_CPU_MILLIS,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
  MAX_STORAGE_OVERCOMMIT_RATIO,
} from '../constants.js';
import {
  canonicalIpv4Address,
  canonicalIpv4Cidr,
  ipToNum,
  ipv4CidrContains,
  isUsableHostInCidr,
  parseCidr,
} from '../utils.js';
import { normalizeOpenSshPublicKey } from './ssh-public-key.js';
import { SERVER_CARD_EXTENSION_ID_RE } from './server-card-extensions.js';

const USERNAME_RE = /^[a-z0-9_-]+$/;
const RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SERVER_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NETWORK_INTERFACE_RE = /^[A-Za-z0-9_.:-]+$/;
const LOGIN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FINGERPRINT_RE = /^[0-9A-Fa-f:]{32,95}$/;

export const zUserStatus = z.nativeEnum(UserStatus);
export const zServerStatus = z.nativeEnum(ServerStatus);
export const zContainerPhase = z.nativeEnum(ContainerPhase);
export const zContainerPowerIntent = z.nativeEnum(ContainerPowerIntent);
export const zIntentStatus = z.nativeEnum(IntentStatus);
export const zIntentKind = z.nativeEnum(IntentKind);
export const zIntentResourceType = z.nativeEnum(IntentResourceType);
export const zResourceLifecyclePhase = z.nativeEnum(ResourceLifecyclePhase);
export const zNodeMetricsStatus = z.nativeEnum(NodeMetricsStatus);
export const zPreflightStatus = z.nativeEnum(PreflightStatus);
export const zCertificateState = z.nativeEnum(CertificateState);
export const zCertificateTrustState = z.nativeEnum(CertificateTrustState);
export const zCertificateRotationStatus = z.nativeEnum(CertificateRotationStatus);
export const zStoragePoolDriver = z.nativeEnum(StoragePoolDriver);
export const zStoragePoolResizeFamily = z.nativeEnum(StoragePoolResizeFamily);
export const zCapability = z.nativeEnum(Capability);
export const zFailureCode = z.nativeEnum(FailureCode);

export const zExpectedRevision = z.number().int().positive().safe();
export const zExpectedGeneration = z.number().int().positive().safe();
export const zConfigSnapshotToken = z.string().length(64).regex(SHA256_RE);
export const zResourceIdentity = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const zUuid = z.string().uuid();
export const zPositiveBytes = z.number().int().positive().safe().max(MAX_RESOURCE_BYTES);
export const zNonNegativeBytes = z.number().int().nonnegative().safe().max(MAX_RESOURCE_BYTES);
export const zCpuMillis = z.number().int().nonnegative().safe().max(MAX_RESOURCE_CPU_MILLIS);
export const zIsoDateTime = z.string().datetime({ offset: true });
export const zOpaqueExtensionMap = z.record(z.unknown());
export const zPatchContainerExtensionRequest = z.record(z.unknown());
export const zPatchServerExtensionRequest = z.object({
  enabled: z.boolean(),
}).strict();

export const zIpv4Address = z.string().superRefine((value, context) => {
  try {
    ipToNum(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an IPv4 address' });
  }
}).transform(canonicalIpv4Address);

export const zIpv4Cidr = z.string().superRefine((value, context) => {
  try {
    parseCidr(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an IPv4 CIDR' });
  }
}).transform(canonicalIpv4Cidr);

const zHttpsUrl = (label: string) => z.string().url().superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must use HTTPS` });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be an HTTPS URL` });
  }
});

export const zApiEndpoint = zHttpsUrl('apiEndpoint');
export const zServerCertFingerprint = z.string().regex(FINGERPRINT_RE);
export const zMetricsEndpoint = z.string().url().superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/metrics'
      || parsed.search !== '' || parsed.hash !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Node metrics endpoint must be an HTTPS /metrics URL without query parameters',
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Node metrics endpoint must be an HTTPS /metrics URL',
    });
  }
});

const zName = z.string().trim().min(1).max(128);
const zResourceName = z.string().min(1).max(63).regex(RESOURCE_NAME_RE);
const zServerSlug = z.string().min(1).max(64).regex(SERVER_SLUG_RE);
const zNetworkInterface = z.string().min(1).max(64).regex(NETWORK_INTERFACE_RE);
const zOptionalText = (max: number) => z.string().max(max).nullable().optional();

function assertIpPoolNetworkFields(
  value: {
    cidr: string;
    allocationCidr: string;
    gateway: string;
    reservedIps: string[];
  },
  context: z.RefinementCtx,
): void {
  if (!isUsableHostInCidr(value.cidr, value.gateway)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gateway'],
      message: 'gateway must be a usable host inside cidr',
    });
  }
  try {
    if (!ipv4CidrContains(value.cidr, value.allocationCidr)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocationCidr'],
        message: 'allocationCidr must be entirely contained in cidr',
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allocationCidr'],
      message: 'allocationCidr must be a valid IPv4 CIDR contained in cidr',
    });
  }
  const seen = new Set<string>();
  for (const address of value.reservedIps) {
    if (!isUsableHostInCidr(value.cidr, address)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservedIps'],
        message: 'reservedIps must contain usable hosts inside cidr',
      });
    }
    if (seen.has(address)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservedIps'],
        message: 'reservedIps must be unique',
      });
    }
    seen.add(address);
  }
}

function assertPatchIpPoolNetworkFields(
  value: {
    cidr?: string;
    allocationCidr?: string;
    gateway?: string;
    reservedIps?: string[];
  },
  context: z.RefinementCtx,
): void {
  if (value.cidr !== undefined && value.gateway !== undefined
    && !isUsableHostInCidr(value.cidr, value.gateway)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gateway'],
      message: 'gateway must be a usable host inside cidr',
    });
  }
  if (value.cidr !== undefined && value.allocationCidr !== undefined) {
    try {
      if (!ipv4CidrContains(value.cidr, value.allocationCidr)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocationCidr'],
          message: 'allocationCidr must be entirely contained in cidr',
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocationCidr'],
        message: 'allocationCidr must be a valid IPv4 CIDR contained in cidr',
      });
    }
  }
  if (value.cidr !== undefined && value.reservedIps !== undefined) {
    const seen = new Set<string>();
    for (const address of value.reservedIps) {
      if (!isUsableHostInCidr(value.cidr, address) || seen.has(address)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reservedIps'],
          message: 'reservedIps must be unique usable hosts inside cidr',
        });
      }
      seen.add(address);
    }
  }
}

// Authentication and account management.
export const zLoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
}).strict();

export const zRefreshTokenRequest = z.object({
  refreshToken: z.string().min(1).max(256),
}).strict();

export const zRotateRefreshTokenRequest = z.object({
  refreshToken: z.string().min(1).max(256),
  requestId: z.string().length(64).regex(SHA256_RE),
}).strict();

export const zCreateApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(128),
}).strict();

export const zCreateUserRequest = z.object({
  username: z.string().min(2).max(64).regex(USERNAME_RE),
  password: z.string().min(8).max(256),
  displayName: z.string().trim().min(1).max(128),
}).strict();

export const zUpdateUserRequest = z.object({
  displayName: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(8).max(256).optional(),
  currentPassword: z.string().max(1024).optional(),
  status: z.enum([UserStatus.Active, UserStatus.Disabled]).optional(),
}).strict().refine(
  (value) => value.displayName !== undefined
    || value.password !== undefined
    || value.status !== undefined,
  'At least one mutable user field is required',
);

export const zAddSshKeyRequest = z.object({
  name: z.string().trim().min(1).max(128),
  keyText: z.string().min(1).max(MAX_SSH_PUBLIC_KEY_TEXT_LENGTH).transform((value, context) => {
    const normalized = normalizeOpenSshPublicKey(value);
    if (!normalized) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid OpenSSH public key' });
      return z.NEVER;
    }
    return normalized;
  }),
}).strict();

// Server registration, connection, and bootstrap.
export const zNodeMetricsCreateConfig = z.object({
  endpoint: zMetricsEndpoint,
  serverCertFingerprint: zServerCertFingerprint,
  token: z.string().min(32).max(1024),
}).strict();

export const zNodeMetricsPatchConfig = z.object({
  endpoint: zMetricsEndpoint,
  serverCertFingerprint: zServerCertFingerprint,
  token: z.string().min(32).max(1024).optional(),
}).strict();

export const zServerNetworkFields = z.object({
  parentInterface: zNetworkInterface,
  dnsServers: z.array(zIpv4Address).max(8),
}).strict();

export const zCreateServerRequest = z.object({
  name: zName,
  slug: zServerSlug,
  apiEndpoint: zApiEndpoint,
  parentInterface: zNetworkInterface,
  dnsServers: z.array(zIpv4Address).max(8),
  nodeMetrics: zNodeMetricsCreateConfig.nullable().optional(),
}).strict();

export const zPatchServerRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: zName.optional(),
  slug: zServerSlug.optional(),
  parentInterface: zNetworkInterface.optional(),
  dnsServers: z.array(zIpv4Address).max(8).optional(),
  systemPoolId: zResourceIdentity.nullable().optional(),
  storageOvercommitRatio: z.number().finite()
    .min(1)
    .max(MAX_STORAGE_OVERCOMMIT_RATIO)
    .optional(),
  nodeMetrics: zNodeMetricsPatchConfig.nullable().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one server field is required',
);

export const zConnectServerRequest = z.object({
  trustToken: z.string().min(1).max(16_384),
  expectedServerCertFingerprint: zServerCertFingerprint,
}).strict();

export const zRunPreflightRequest = z.object({
  expectedServerRevision: zExpectedRevision,
  poolId: zResourceIdentity,
  probeAddress: zIpv4Address,
}).strict();

// Storage pools, shared backends, volumes, and attachments.
export const zPatchStoragePoolRequest = z.object({
  expectedRevision: zExpectedRevision,
  registered: z.boolean(),
  displayName: zOptionalText(128),
}).strict();

export const zPatchSharedBackendExecutorRequest = z.object({
  expectedRevision: zExpectedRevision,
  registered: z.boolean(),
}).strict();

export const zDiscoverSharedExecutorsRequest = z.object({
  serverId: zUuid.optional(),
}).strict();

export const zStorageDiscoverIssueDto = z.object({
  code: z.enum([
    FailureCode.SharedBackendIdentityConflict,
    FailureCode.StoragePoolInUse,
    FailureCode.ServerUnreachable,
  ]),
  message: z.string(),
  identityKey: z.string().nullable(),
  expectedFsid: z.string().nullable(),
  discoveredFsid: z.string().nullable(),
  existingIdentityKey: z.string().nullable(),
  serverId: z.string().nullable(),
  incusName: z.string().nullable(),
  poolId: z.string().nullable(),
}).strict();

export const zStoragePoolDiscoverResult = z.object({
  pools: z.array(z.record(z.unknown())),
  identityConflicts: z.array(zStorageDiscoverIssueDto),
}).strict();

export const zSharedBackendExecutorDiscoverResult = z.object({
  executors: z.array(z.record(z.unknown())),
  identityConflicts: z.array(zStorageDiscoverIssueDto),
}).strict();

export const zCreateSharedBackendRequest = z.object({
  name: zName,
  displayName: zOptionalText(128),
  identityKey: z.string().trim().min(1).max(512),
  cephFsid: z.string().regex(/^[0-9a-f-]{36}$/i),
  overcommitRatio: z.number().finite().min(1).max(MAX_STORAGE_OVERCOMMIT_RATIO),
}).strict();

export const zPatchSharedBackendRequest = z.object({
  expectedRevision: zExpectedRevision,
  displayName: zOptionalText(128),
  cephFsid: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
  overcommitRatio: z.number().finite().min(1).max(MAX_STORAGE_OVERCOMMIT_RATIO).optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one shared backend field is required',
);

export const zCreateIpPoolRequest = z.object({
  name: zName,
  cidr: zIpv4Cidr,
  allocationCidr: zIpv4Cidr,
  gateway: zIpv4Address,
  reservedIps: z.array(zIpv4Address).max(4_096).default([]),
  serverIds: z.array(zResourceIdentity).max(MAX_PLATFORM_SERVERS).default([]),
}).strict().superRefine(assertIpPoolNetworkFields).superRefine((value, context) => {
  if (new Set(value.serverIds).size !== value.serverIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serverIds'],
      message: 'serverIds must be unique',
    });
  }
});

export const zPatchIpPoolRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: zName.optional(),
  cidr: zIpv4Cidr.optional(),
  allocationCidr: zIpv4Cidr.optional(),
  gateway: zIpv4Address.optional(),
  reservedIps: z.array(zIpv4Address).max(4_096).optional(),
  serverIds: z.array(zResourceIdentity).max(MAX_PLATFORM_SERVERS).optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one IP pool field is required',
).superRefine(assertPatchIpPoolNetworkFields).superRefine((value, context) => {
  if (value.serverIds !== undefined && new Set(value.serverIds).size !== value.serverIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serverIds'],
      message: 'serverIds must be unique',
    });
  }
});

export const zLocalVolumeScope = z.object({
  kind: z.literal('local'),
  serverId: zResourceIdentity,
  poolId: zResourceIdentity,
}).strict();

export const zSharedVolumeScope = z.object({
  kind: z.literal('shared'),
  sharedBackendId: zResourceIdentity,
}).strict();

export const zVolumeScope = z.discriminatedUnion('kind', [
  zLocalVolumeScope,
  zSharedVolumeScope,
]);

export const zCreateVolumeRequest = z.object({
  name: zName,
  sizeBytes: zPositiveBytes,
  scope: zLocalVolumeScope,
}).strict();

export const zCreateSharedVolumeRequest = z.object({
  name: zName,
  sizeBytes: zPositiveBytes,
  scope: zSharedVolumeScope,
}).strict();

export const zListSharedVolumesQuery = z.object({
  attachableOnServerId: zResourceIdentity.optional(),
}).strict();

export const zListVolumesQuery = z.object({
  serverId: zResourceIdentity.optional(),
}).strict();

export const zPatchVolumeRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: zName.optional(),
  sizeBytes: zPositiveBytes.optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one volume field is required',
);

export const zAttachVolumeRequest = z.object({
  volumeId: zResourceIdentity,
  containerPath: z.string().trim().min(2).max(4_096)
    .startsWith('/')
    .refine((value) => value !== '/', 'Container path must not be root')
    .refine((value) => !value.split('/').some((part) => part === '.' || part === '..'),
      'Container path must not contain dot segments')
    .refine((value) => !/[\0\r\n]/.test(value), 'Container path contains invalid control characters'),
  readOnly: z.boolean(),
}).strict();

// Container desired state and console session requests.
export const zCreateContainerRequest = z.object({
  serverId: zResourceIdentity,
  imageId: zResourceIdentity,
  name: zResourceName,
  rootSizeBytes: zPositiveBytes,
  cpuMillis: zCpuMillis,
  memBytes: zNonNegativeBytes,
  extensions: z.record(
    z.string().regex(SERVER_CARD_EXTENSION_ID_RE),
    z.unknown(),
  ).default({}),
  powerIntent: z.nativeEnum(ContainerPowerIntent),
  volumes: z.array(zAttachVolumeRequest).max(32).optional(),
}).strict();

export const zPatchContainerLimitsRequest = z.object({
  cpuMillis: zCpuMillis,
  memBytes: zNonNegativeBytes,
}).strict();

export const zPatchContainerRootSizeRequest = z.object({
  sizeBytes: zPositiveBytes,
}).strict();

export const zCreateExecSessionRequest = z.object({
  command: z.array(z.string().min(1).max(MAX_CONSOLE_COMMAND_ARGUMENT_BYTES))
    .max(MAX_CONSOLE_COMMAND_ARGUMENTS)
    .refine((parts) => parts.every((part) => !part.includes('\0')),
      'Command arguments must not contain NUL')
    .default(['/bin/sh', '-l']),
  tty: z.boolean().default(true),
  cols: z.number().int().min(1).max(1_000).default(CONSOLE_DEFAULT_COLS),
  rows: z.number().int().min(1).max(1_000).default(CONSOLE_DEFAULT_ROWS),
}).strict();

export const zEmptyRequest = z.object({}).strict();

// Images and per-server image assignments.
export const zCreateImageRequest = z.object({
  name: zName,
  alias: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  description: z.string().max(4_096).nullable().optional(),
  loginUser: z.string().regex(LOGIN_USER_RE),
  minRootSizeBytes: zPositiveBytes.nullable().optional(),
  networkManagedExternally: z.boolean(),
}).strict();

export const zPatchImageRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: zName.optional(),
  alias: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  description: z.string().max(4_096).nullable().optional(),
  loginUser: z.string().regex(LOGIN_USER_RE).optional(),
  minRootSizeBytes: zPositiveBytes.nullable().optional(),
  networkManagedExternally: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one image field is required',
);

export const zPutImageAssignmentRequest = z.object({
  expectedGeneration: zExpectedGeneration.optional(),
}).strict();

// Grant mutations use complete canonical bodies and PCI identity.
const zNullableCpuMillis = zCpuMillis.nullable();
const zNullableBytes = zNonNegativeBytes.nullable();

export const zPutServerGrantRequest = z.object({
  cpuMillis: zNullableCpuMillis,
  memBytes: zNullableBytes,
  diskBytes: zNullableBytes,
  extensionGrants: z.record(
    z.string().regex(SERVER_CARD_EXTENSION_ID_RE),
    z.unknown(),
  ).default({}),
  expiresAt: zIsoDateTime.nullable(),
}).strict();

export const zPutStoragePoolGrantRequest = z.object({
  expiresAt: zIsoDateTime.nullable(),
}).strict();

export const zPutSharedBackendGrantRequest = z.object({
  limitBytes: zNonNegativeBytes,
  expiresAt: zIsoDateTime.nullable(),
}).strict();

// Intents, errors, certificates, and preflight reports.
export const zIntentListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_INTENT_LIST_PAGE_SIZE).default(50),
  cursor: z.string().min(1).max(512).optional(),
  status: z.nativeEnum(IntentStatus).optional(),
  kind: z.nativeEnum(IntentKind).optional(),
  resourceType: z.nativeEnum(IntentResourceType).optional(),
  serverId: zResourceIdentity.optional(),
}).strict();

export const zAdminIntentListQuery = zIntentListQuery.extend({
  limit: z.coerce.number().int().min(1).max(ADMIN_INTENT_LIST_MAX).default(ADMIN_INTENT_LIST_MAX),
}).strict();

export const zRetryIntentRequest = zEmptyRequest;

export const zNodeMetricsHealth = z.object({
  status: z.nativeEnum(NodeMetricsStatus),
  lastSuccessAt: zIsoDateTime.nullable(),
  outageSince: zIsoDateTime.nullable(),
  lastError: z.string().max(4_096).nullable(),
}).strict();
export const zNodeMetricsHealthDto = zNodeMetricsHealth;

export const zIntentFailureDto = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4_096),
  details: z.record(z.unknown()),
}).strict();

export const zIntentAcceptedDto = z.object({
  intentId: zResourceIdentity,
  resourceType: z.nativeEnum(IntentResourceType),
  resourceId: zResourceIdentity,
  serverId: zResourceIdentity.nullable(),
  targetGeneration: zExpectedGeneration,
  status: z.literal(IntentStatus.Pending),
  createdAt: zIsoDateTime,
}).strict();

export const zIntentBatchAcceptedDto = z.object({
  intents: z.array(zIntentAcceptedDto),
}).strict();

export const zIntentDto = z.object({
  id: zResourceIdentity,
  kind: z.nativeEnum(IntentKind),
  resourceType: z.nativeEnum(IntentResourceType),
  resourceId: zResourceIdentity,
  serverId: zResourceIdentity.nullable(),
  requestedBy: zResourceIdentity.nullable(),
  requestSummary: z.record(z.unknown()),
  targetGeneration: zExpectedGeneration,
  baseline: z.record(z.unknown()).nullable(),
  status: z.nativeEnum(IntentStatus),
  failureCode: z.string().max(128).nullable(),
  failure: zIntentFailureDto.nullable(),
  attemptCount: z.number().int().nonnegative().safe(),
  nextAttemptAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  settledAt: zIsoDateTime.nullable(),
  blockedByIntentId: zResourceIdentity.nullable().optional(),
}).strict();

export const zPreflightReport = z.object({
  status: z.enum([PreflightStatus.Running, PreflightStatus.Passed, PreflightStatus.Failed]),
  controlReady: z.boolean(),
  checks: z.object({
    api: z.enum(['pass', 'fail']),
    parentInterface: z.enum(['pass', 'fail']),
    nftables: z.enum(['pass', 'fail']),
    ipv4Filtering: z.enum(['pass', 'fail']),
    guestCanReachHost: z.enum(['pass', 'fail']),
    networkPrerequisites: z.enum(['pass', 'fail']),
    storagePool: z.enum(['pass', 'fail']),
    simplestreamsImage: z.enum(['pass', 'fail']),
    guestAddress: z.enum(['pass', 'fail']),
    egress: z.enum(['pass', 'fail']),
    nodeMetrics: z.enum(['pass', 'warn', 'fail']),
  }).strict(),
  failureCode: z.nativeEnum(FailureCode).nullable(),
  checkedAt: zIsoDateTime.nullable(),
  extensions: z.record(z.unknown()).optional(),
}).strict().superRefine((report, context) => {
  if (report.controlReady && report.checks.networkPrerequisites !== 'pass') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['controlReady'],
      message: 'Control readiness requires network prerequisites',
    });
  }
});

export const zCertificateTrust = z.object({
  serverId: zResourceIdentity,
  trustState: z.nativeEnum(CertificateTrustState),
  observedAt: zIsoDateTime.nullable(),
  lastError: z.string().max(4_096).nullable(),
}).strict();

export const zIncusClientCertificateDto = z.object({
  generation: z.number().int().positive().safe(),
  fingerprint: zServerCertFingerprint,
  notBefore: zIsoDateTime,
  notAfter: zIsoDateTime,
  state: z.nativeEnum(CertificateState),
  servers: z.array(zCertificateTrust),
}).strict();

export const zRotateIncusClientCertificateRequest = z.object({
  expectedGeneration: zExpectedGeneration,
}).strict();

export const zCertificateRotationDto = z.object({
  rotationId: zResourceIdentity,
  generation: z.number().int().positive().safe(),
  status: z.nativeEnum(CertificateRotationStatus),
  certificate: zIncusClientCertificateDto,
  failureCode: z.string().max(128).nullable(),
}).strict();

export const zErrorResponse = z.object({
  statusCode: z.number().int().min(400).max(599),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4_096),
  details: z.record(z.unknown()).optional(),
  requestId: z.string().min(1).max(128),
}).strict();

// User, group, and settings metadata requests remain database-only.
export const zCreateGroupRequest = z.object({
  name: zName,
  description: z.string().max(4_096).optional(),
  priority: z.number().int().nonnegative().safe().max(MAX_GROUP_PRIORITY).optional(),
  capabilities: z.array(zCapability)
    .max(Object.values(Capability).length)
    .refine((values) => new Set(values).size === values.length, 'Capabilities must be unique')
    .optional(),
}).strict();

export const zUpdateGroupRequest = z.object({
  name: zName.optional(),
  description: z.string().max(4_096).nullable().optional(),
  priority: z.number().int().nonnegative().safe().max(MAX_GROUP_PRIORITY).optional(),
  capabilities: z.array(zCapability)
    .max(Object.values(Capability).length)
    .refine((values) => new Set(values).size === values.length, 'Capabilities must be unique')
    .optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one group field is required');

export const zPatchAdminGroupRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: zName.optional(),
  description: z.string().max(4_096).nullable().optional(),
  priority: z.number().int().nonnegative().safe().max(MAX_GROUP_PRIORITY).optional(),
  capabilities: z.array(zCapability)
    .max(Object.values(Capability).length)
    .refine((values) => new Set(values).size === values.length, 'Capabilities must be unique')
    .optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one group field is required',
);

export const zAddGroupMemberRequest = z.object({
  userId: zResourceIdentity,
}).strict();

export const zPatchSystemSettingsRequest = z.object({
  expectedRevision: zExpectedRevision,
  expectedSnapshotToken: zConfigSnapshotToken,
  values: z.record(z.unknown())
    .refine((values) => Object.keys(values).length > 0, 'At least one setting is required')
    .refine((values) => Object.keys(values).length <= 64, 'At most 64 settings may be updated at once'),
}).strict();

export type LoginRequest = z.infer<typeof zLoginRequest>;
export type RefreshTokenRequest = z.infer<typeof zRefreshTokenRequest>;
export type RotateRefreshTokenRequest = z.infer<typeof zRotateRefreshTokenRequest>;
export type CreateApiTokenRequest = z.infer<typeof zCreateApiTokenRequest>;
export type CreateUserRequest = z.infer<typeof zCreateUserRequest>;
export type UpdateUserRequest = z.infer<typeof zUpdateUserRequest>;
export type AddSshKeyRequest = z.infer<typeof zAddSshKeyRequest>;
export type NodeMetricsCreateConfig = z.infer<typeof zNodeMetricsCreateConfig>;
export type NodeMetricsPatchConfig = z.infer<typeof zNodeMetricsPatchConfig>;
export type ServerNetworkFields = z.infer<typeof zServerNetworkFields>;
export type CreateServerRequest = z.infer<typeof zCreateServerRequest>;
export type PatchServerRequest = z.infer<typeof zPatchServerRequest>;
export type ConnectServerRequest = z.infer<typeof zConnectServerRequest>;
export type RunPreflightRequest = z.infer<typeof zRunPreflightRequest>;
export type PatchStoragePoolRequest = z.infer<typeof zPatchStoragePoolRequest>;
export type PatchSharedBackendExecutorRequest = z.infer<typeof zPatchSharedBackendExecutorRequest>;
export type DiscoverSharedExecutorsRequest = z.infer<typeof zDiscoverSharedExecutorsRequest>;
export type CreateSharedBackendRequest = z.infer<typeof zCreateSharedBackendRequest>;
export type PatchSharedBackendRequest = z.infer<typeof zPatchSharedBackendRequest>;
export type CreateIpPoolRequest = z.infer<typeof zCreateIpPoolRequest>;
export type PatchIpPoolRequest = z.infer<typeof zPatchIpPoolRequest>;
export type LocalVolumeScope = z.infer<typeof zLocalVolumeScope>;
export type SharedVolumeScope = z.infer<typeof zSharedVolumeScope>;
export type VolumeScope = z.infer<typeof zVolumeScope>;
export type CreateVolumeRequest = z.infer<typeof zCreateVolumeRequest>;
export type CreateSharedVolumeRequest = z.infer<typeof zCreateSharedVolumeRequest>;
export type ListSharedVolumesQuery = z.infer<typeof zListSharedVolumesQuery>;
export type ListVolumesQuery = z.infer<typeof zListVolumesQuery>;
export type PatchVolumeRequest = z.infer<typeof zPatchVolumeRequest>;
export type AttachVolumeRequest = z.infer<typeof zAttachVolumeRequest>;
export type CreateContainerRequest = z.infer<typeof zCreateContainerRequest>;
export type PatchContainerLimitsRequest = z.infer<typeof zPatchContainerLimitsRequest>;
export type PatchContainerRootSizeRequest = z.infer<typeof zPatchContainerRootSizeRequest>;
export type PatchContainerExtensionRequest = z.infer<typeof zPatchContainerExtensionRequest>;
export type PatchServerExtensionRequest = z.infer<typeof zPatchServerExtensionRequest>;
export type CreateExecSessionRequest = z.infer<typeof zCreateExecSessionRequest>;
export type CreateImageRequest = z.infer<typeof zCreateImageRequest>;
export type PatchImageRequest = z.infer<typeof zPatchImageRequest>;
export type PutImageAssignmentRequest = z.infer<typeof zPutImageAssignmentRequest>;
export type PutServerGrantRequest = z.infer<typeof zPutServerGrantRequest>;
export type PutStoragePoolGrantRequest = z.infer<typeof zPutStoragePoolGrantRequest>;
export type PutSharedBackendGrantRequest = z.infer<typeof zPutSharedBackendGrantRequest>;
export type IntentListQuery = z.infer<typeof zIntentListQuery>;
export type AdminIntentListQuery = z.infer<typeof zAdminIntentListQuery>;
export type RetryIntentRequest = z.infer<typeof zRetryIntentRequest>;
export type NodeMetricsHealth = z.infer<typeof zNodeMetricsHealth>;
export type PreflightReport = z.infer<typeof zPreflightReport>;
export type CertificateTrust = z.infer<typeof zCertificateTrust>;
export type RotateIncusClientCertificateRequest = z.infer<typeof zRotateIncusClientCertificateRequest>;
export type ErrorResponse = z.infer<typeof zErrorResponse>;
export type CreateGroupRequest = z.infer<typeof zCreateGroupRequest>;
export type UpdateGroupRequest = z.infer<typeof zUpdateGroupRequest>;
export type PatchAdminGroupRequest = z.infer<typeof zPatchAdminGroupRequest>;
export type AddGroupMemberRequest = z.infer<typeof zAddGroupMemberRequest>;
export type PatchSystemSettingsRequest = z.infer<typeof zPatchSystemSettingsRequest>;
