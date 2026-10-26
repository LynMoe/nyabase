import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { GUEST_IPV6_DISABLE_SYSCTLS, MANAGED_NIC_HOST_NAME_PREFIX } from '@nyabase/common';
import type { IncusSchema } from './incus-client-types.js';
import { IncusError, type IncusErrorDetails, type IncusFailureCode } from './incus-errors.js';
import { isRecord } from '../platform/domain-utils.js';

export type InstanceSpecInteger = string | number | bigint;

export interface InstanceImageSourceInput {
  readonly server?: string;
  readonly protocol?: string;
  readonly project?: string;
}

export interface InstanceSpecContainerInput {
  readonly id: string;
  /** The user-facing name, shown in the guest's shell prompt. */
  readonly name: string;
  readonly serverId: string;
  readonly revision: number;
  readonly imageFingerprint: string;
  readonly imageSource?: InstanceImageSourceInput;
  /** Logical CPUs the instance is pinned to (the owner's CPU set). */
  readonly cpus: readonly number[];
  readonly memBytes: InstanceSpecInteger;
  readonly nesting?: boolean;
  readonly syscallIntercept?: boolean;
  readonly rootPool: string;
  readonly rootSizeBytes: InstanceSpecInteger;
  readonly routedIp: string;
}

/** The platform-wide per-container limits (system settings). */
export interface ContainerRuntimeLimits {
  readonly processes: number;
  readonly networkIngressMbit: number;
  readonly networkEgressMbit: number;
  readonly diskReadMBps: number;
  readonly diskWriteMBps: number;
}

export interface InstanceSpecServerInput {
  readonly id: string;
  /** The display name, shown in the guest's shell prompt. */
  readonly name: string;
  readonly parentInterface: string;
  readonly imageSource?: InstanceImageSourceInput;
}

export interface InstanceSpecVolumeInput {
  readonly id: string;
  readonly incusName: string;
  readonly poolName: string;
  /** False for network filesystems (CephFS), which cgroup I/O limits cannot reach. */
  readonly throttled: boolean;
}

export interface InstanceSpecAttachmentInput {
  readonly id: string;
  readonly volume: InstanceSpecVolumeInput;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

export interface InstanceSpecInput {
  readonly container: InstanceSpecContainerInput;
  readonly server: InstanceSpecServerInput;
  readonly attachments: readonly InstanceSpecAttachmentInput[];
  readonly limits: ContainerRuntimeLimits;
}

export type DesiredInstanceSpec = IncusSchema<'InstancesPost'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID32_PATTERN = /^[0-9a-f]{32}$/i;
const IMAGE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;

function fail(code: ConstructorParameters<typeof IncusError>[0], reason: string): never {
  throw new IncusError(code, 'managed_failure', { reason });
}

function uuid32(value: string, label: string): string {
  if (!UUID_PATTERN.test(value) && !UUID32_PATTERN.test(value)) {
    fail('INVALID_INSTANCE_ID', label);
  }
  return value.replace(/-/g, '').toLowerCase();
}

function positiveInteger(
  value: InstanceSpecInteger,
  code: 'INVALID_INSTANCE_SPEC' | 'INVALID_VOLUME_NAME',
  label: string,
): string {
  const text = typeof value === 'bigint' ? value.toString(10) : String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || BigInt(text) <= 0n) {
    fail(code, label);
  }
  return text;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_INSTANCE_SPEC', label);
  }
  return value;
}

function validateName(value: string, label: string): string {
  if (!value || /[\u0000-\u001f\u007f/\\]/.test(value)) {
    fail('INVALID_INSTANCE_SPEC', label);
  }
  return value;
}

function validateSourceValue(value: string, label: string): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_INSTANCE_SPEC', label);
  }
  return value;
}

function validateIpv4(value: string, label: string): string {
  if (isIP(value) !== 4 || value.includes('/')) {
    fail('INVALID_INSTANCE_SPEC', label);
  }
  return value;
}

/** Incus `limits.cpu` for an explicit set: ranges only, so a single CPU is never read as a count. */
export function formatCpuSet(cpus: readonly number[]): string {
  const sorted = [...new Set(cpus)].sort((left, right) => left - right);
  if (sorted.length === 0 || sorted.some((cpu) => !Number.isSafeInteger(cpu) || cpu < 0)) {
    fail('INVALID_INSTANCE_SPEC', 'cpu_set');
  }
  const ranges: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (const cpu of sorted.slice(1)) {
    if (cpu === previous + 1) {
      previous = cpu;
      continue;
    }
    ranges.push(`${start}-${previous}`);
    start = cpu;
    previous = cpu;
  }
  ranges.push(`${start}-${previous}`);
  return ranges.join(',');
}

/** The sysctls that keep guest IPv6 off; the host's nft guard is what enforces it. */
export const GUEST_IPV6_SYSCTL_CONFIG: Readonly<Record<string, string>> = Object.fromEntries(
  GUEST_IPV6_DISABLE_SYSCTLS.map((key) => [key, '1']),
);

function limitsConfig(limits: ContainerRuntimeLimits): Record<string, string> {
  return { 'limits.processes': String(nonNegativeInteger(limits.processes, 'limits_processes')) };
}

function diskLimits(limits: ContainerRuntimeLimits): Record<string, string> {
  return {
    'limits.read': `${nonNegativeInteger(limits.diskReadMBps, 'disk_read')}MB`,
    'limits.write': `${nonNegativeInteger(limits.diskWriteMBps, 'disk_write')}MB`,
  };
}

function imageSource(
  container: InstanceSpecContainerInput,
  server: InstanceSpecServerInput,
): Record<string, string> {
  if (!IMAGE_FINGERPRINT_PATTERN.test(container.imageFingerprint)) {
    fail('INVALID_IMAGE_FINGERPRINT', 'image_fingerprint');
  }
  const source: Record<string, string> = {
    type: 'image',
    fingerprint: container.imageFingerprint.toLowerCase(),
  };
  const sourceInput = container.imageSource ?? server.imageSource;
  if (sourceInput?.server !== undefined) {
    source.server = validateSourceValue(sourceInput.server, 'image_source_server');
  }
  if (sourceInput?.protocol !== undefined) {
    source.protocol = validateSourceValue(sourceInput.protocol, 'image_source_protocol');
  } else if (source.server !== undefined) {
    source.protocol = 'simplestreams';
  }
  if (sourceInput?.project !== undefined) {
    source.project = validateSourceValue(sourceInput.project, 'image_source_project');
  }
  return source;
}

export function deriveInstanceName(containerId: string): string {
  return `nyc-${uuid32(containerId, 'container_id')}`;
}

export function deriveVolumeName(volumeId: string): string {
  return `nyv-${uuid32(volumeId, 'volume_id')}`;
}

export function deriveAttachmentDeviceName(attachmentId: string): string {
  return `nyd-${uuid32(attachmentId, 'attachment_id')}`;
}

/** Host-side veth name of the instance NIC; the agent's IPv6 guard matches its prefix. */
export function deriveNicHostName(instanceId: string): string {
  const digest = createHash('sha256').update(uuid32(instanceId, 'instance_id'), 'utf8').digest('hex');
  return `${MANAGED_NIC_HOST_NAME_PREFIX}${digest.slice(0, 12)}`;
}

/** Locally administered unicast prefix of every guest MAC (Docker uses 02:42). */
const GUEST_HWADDR_PREFIX = [0x02, 0x6e] as const;

/**
 * Guest MAC = fixed prefix + the four IPv4 bytes. IPv4 claims are reused after
 * the drain, but peers (proxies, gateways) keep IP→MAC neighbor entries far
 * longer, so an address must always resolve to the same MAC.
 */
export function deriveGuestHwaddr(ipv4Address: string): string {
  const address = validateIpv4(ipv4Address, 'guest_ipv4_address');
  const bytes = [...GUEST_HWADDR_PREFIX, ...address.split('.').map(Number)];
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

/**
 * The one guest NIC of every nyabase instance (containers and the preflight
 * probe): bridged onto the server's LAN bridge, IPv4 / MAC filtered to its
 * address, port-isolated from the other guests and named for the IPv6 guard.
 * The agent policy refuses any eth0 without these.
 */
export function buildGuestNicDevice(input: {
  readonly parentInterface: string;
  /** The id the host-side veth name derives from. */
  readonly hardwareId: string;
  /** The guest's address; also determines its MAC (see `deriveGuestHwaddr`). */
  readonly ipv4Address: string;
}): Record<string, string> {
  return {
    type: 'nic',
    nictype: 'bridged',
    parent: input.parentInterface,
    name: 'eth0',
    hwaddr: deriveGuestHwaddr(input.ipv4Address),
    host_name: deriveNicHostName(input.hardwareId),
    'ipv4.address': input.ipv4Address,
    'security.ipv4_filtering': 'true',
    'security.mac_filtering': 'true',
    'security.port_isolation': 'true',
  };
}

export interface InstanceSpecContribution {
  readonly config: Readonly<Record<string, string>>;
  readonly devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export function mergeInstanceSpecContributions(
  base: DesiredInstanceSpec,
  contributions: readonly InstanceSpecContribution[],
): DesiredInstanceSpec {
  const config: Record<string, string> = { ...(base.config ?? {}) };
  const devices: Record<string, Record<string, string>> = {};
  for (const [name, device] of Object.entries(base.devices ?? {})) {
    devices[name] = { ...device };
  }
  for (const contribution of contributions) {
    for (const [key, value] of Object.entries(contribution.config)) {
      if (Object.prototype.hasOwnProperty.call(config, key)) {
        fail('INVALID_INSTANCE_SPEC', `config_collision_${key}`);
      }
      config[key] = value;
    }
    for (const [name, device] of Object.entries(contribution.devices)) {
      if (Object.prototype.hasOwnProperty.call(devices, name)) {
        fail('INVALID_INSTANCE_SPEC', `device_collision_${name}`);
      }
      devices[name] = { ...device };
    }
  }
  return { ...base, config, devices };
}

export const DISPLAY_CONTAINER_NAME_KEY = 'user.nyabase.display.container';
export const DISPLAY_SERVER_NAME_KEY = 'user.nyabase.display.server';

/** Labels that only change what the guest shows; rewriting them is not drift worth auditing. */
export function isDisplayConfigKey(key: string): boolean {
  return key === DISPLAY_CONTAINER_NAME_KEY || key === DISPLAY_SERVER_NAME_KEY;
}

export function buildDesiredInstanceSpec(input: InstanceSpecInput): DesiredInstanceSpec {
  const { container, server } = input;
  const containerId = uuid32(container.id, 'container_id');
  const serverId = uuid32(server.id, 'server_id');
  if (container.serverId.replace(/-/g, '').toLowerCase() !== serverId) {
    fail('INVALID_INSTANCE_SPEC', 'container_server_mismatch');
  }
  const revision = nonNegativeInteger(container.revision, 'revision');
  const rootSizeBytes = positiveInteger(
    container.rootSizeBytes,
    'INVALID_INSTANCE_SPEC',
    'root_size_bytes',
  );
  const memBytes = positiveInteger(container.memBytes, 'INVALID_INSTANCE_SPEC', 'mem_bytes');
  const rootPool = validateName(container.rootPool, 'root_pool');
  const parentInterface = validateName(server.parentInterface, 'parent_interface');
  // ipv4.address is nft filter identity on bridged NICs, not guest config.
  // Guest addressing is still applied by exec. Validate the claim is bare IPv4.
  const routedIp = validateIpv4(container.routedIp, 'routed_ip');
  const name = `nyc-${containerId}`;
  const config: Record<string, string> = {
    'limits.cpu': formatCpuSet(container.cpus),
    'limits.memory': memBytes,
    ...limitsConfig(input.limits),
    'security.privileged': 'false',
    'security.idmap.isolated': 'true',
    ...GUEST_IPV6_SYSCTL_CONFIG,
    'security.nesting': String(container.nesting ?? true),
    'security.syscalls.intercept.mknod': String(container.syscallIntercept ?? true),
    'security.syscalls.intercept.setxattr': String(container.syscallIntercept ?? true),
    'user.nyabase.managed': 'true',
    'user.nyabase.container_id': containerId,
    'user.nyabase.server_id': serverId,
    'user.nyabase.revision': String(revision),
    // Read by the image's shell prompt through /dev/incus; the instance name stays nyc-<id>.
    [DISPLAY_CONTAINER_NAME_KEY]: container.name,
    [DISPLAY_SERVER_NAME_KEY]: server.name,
  };
  const devices: Record<string, Record<string, string>> = {
    root: {
      type: 'disk',
      path: '/',
      pool: rootPool,
      size: rootSizeBytes,
      ...diskLimits(input.limits),
    },
    eth0: {
      ...buildGuestNicDevice({ parentInterface, hardwareId: containerId, ipv4Address: routedIp }),
      'limits.ingress': `${nonNegativeInteger(input.limits.networkIngressMbit, 'network_ingress')}Mbit`,
      'limits.egress': `${nonNegativeInteger(input.limits.networkEgressMbit, 'network_egress')}Mbit`,
    },
  };

  for (const attachment of input.attachments) {
    const attachmentId = uuid32(attachment.id, 'attachment_id');
    const volumeId = uuid32(attachment.volume.id, 'volume_id');
    const expectedVolumeName = `nyv-${volumeId}`;
    if (attachment.volume.incusName !== expectedVolumeName) {
      fail('INVALID_VOLUME_NAME', `volume_name_${attachment.volume.id}`);
    }
    const volumePool = validateName(attachment.volume.poolName, 'volume_pool');
    const path = attachment.containerPath;
    if (
      !path.startsWith('/') ||
      path === '/' ||
      /[\u0000-\u001f\u007f]/.test(path) ||
      path.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      fail('INVALID_ATTACHMENT_PATH', `attachment_${attachmentId}`);
    }
    // Custom storage volumes use volume config security.shifted=true (set by the
    // volume reconciler). Device-level "shift" is rejected by modern Incus.
    const device: Record<string, string> = {
      type: 'disk',
      pool: volumePool,
      source: attachment.volume.incusName,
      path,
    };
    if (attachment.readOnly) {
      device.readonly = 'true';
    }
    if (attachment.volume.throttled) {
      Object.assign(device, diskLimits(input.limits));
    }
    devices[`nyd-${attachmentId}`] = device;
  }

  return {
    name,
    type: 'container',
    profiles: [],
    source: imageSource(container, server),
    config,
    devices,
  };
}

export type ManagedStringMap = Readonly<Record<string, string>>;
export type ManagedDeviceMap = Readonly<Record<string, ManagedStringMap>>;

export interface ManagedInstanceDocument {
  readonly config?: ManagedStringMap;
  readonly devices?: ManagedDeviceMap;
  readonly profiles?: readonly string[];
}

export interface ManagedValueDiff {
  readonly actual?: string;
  readonly desired?: string;
}

export interface ManagedDeviceDiff {
  readonly actual?: ManagedStringMap;
  readonly desired?: ManagedStringMap;
}

export interface ManagedFieldFailure {
  readonly code: IncusFailureCode;
  readonly details: IncusErrorDetails;
  readonly error: IncusError;
}

export interface ManagedFieldsDiff {
  readonly kind: 'empty' | 'diff' | 'managed_failure';
  readonly empty: boolean;
  readonly config: Readonly<Record<string, ManagedValueDiff>>;
  readonly devices: Readonly<Record<string, ManagedDeviceDiff>>;
  /** True when the instance picked up a profile; the platform never uses profiles. */
  readonly profiles?: boolean;
  readonly error?: ManagedFieldFailure;
}

export interface RootQuotaObservation {
  readonly pending: boolean;
  readonly applyQuota?: string;
  readonly pendingSizeBytes?: string;
}

const MEMORY_UNITS: Readonly<Record<string, bigint>> = {
  b: 1n,
  kb: 1000n,
  kib: 1024n,
  mb: 1000n ** 2n,
  mib: 1024n ** 2n,
  gb: 1000n ** 3n,
  gib: 1024n ** 3n,
  tb: 1000n ** 4n,
  tib: 1024n ** 4n,
};

function copyStringMap(value: unknown): ManagedStringMap {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      result[key] = child;
    }
  }
  return result;
}

function copyDeviceMap(value: unknown): ManagedDeviceMap {
  if (!isRecord(value)) return {};
  const result: Record<string, ManagedStringMap> = {};
  for (const [name, device] of Object.entries(value)) {
    result[name] = copyStringMap(device);
  }
  return result;
}

function asManagedDocument(value: ManagedInstanceDocument): {
  readonly config: ManagedStringMap;
  readonly devices: ManagedDeviceMap;
} {
  return {
    config: copyStringMap(value.config),
    devices: copyDeviceMap(value.devices),
  };
}

function parseMemoryBytes(value: string): string | undefined {
  const match = /^([0-9]+)(?:\s*)(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = BigInt(match[1]);
  const multiplier = MEMORY_UNITS[(match[2] ?? 'b').toLowerCase()];
  return (amount * multiplier).toString(10);
}

function canonicalDecimal(value: string): string | undefined {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return undefined;
  const [whole, fraction = ''] = value.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function canonicalCpu(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  const decimal = canonicalDecimal(trimmed);
  if (decimal !== undefined) return decimal;
  if (trimmed.endsWith('%')) {
    const percent = canonicalDecimal(trimmed.slice(0, -1));
    return percent === undefined ? undefined : `${percent}%`;
  }

  const tokens = trimmed.split(',').filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  const cpus = new Set<number>();
  for (const token of tokens) {
    const range = /^([0-9]+)(?:-([0-9]+))?$/.exec(token);
    if (!range) return undefined;
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
      return undefined;
    }
    if (end - start > 4096) return undefined;
    for (let cpu = start; cpu <= end; cpu += 1) cpus.add(cpu);
  }
  const sorted = [...cpus].sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const cpu of sorted.slice(1)) {
    if (cpu === previous + 1) {
      previous = cpu;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = cpu;
    previous = cpu;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(',');
}

export function normalizeManagedValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (key === 'limits.memory') return parseMemoryBytes(value) ?? value.trim();
  if (key === 'limits.cpu') return canonicalCpu(value) ?? value.trim();
  return value;
}

/**
 * Which parts of an instance document the platform owns. Everything is owned
 * except config Incus maintains itself (volatile state, image metadata):
 * an unknown config key, an extra device or a profile is drift to remove.
 */
export interface ManagedFieldOwnership {
  readonly unmanagedConfigPrefixes: readonly string[];
}

export const CORE_MANAGED_FIELD_OWNERSHIP: ManagedFieldOwnership = {
  unmanagedConfigPrefixes: ['volatile.', 'image.'],
};

function isManagedConfigKey(key: string, ownership: ManagedFieldOwnership): boolean {
  return !ownership.unmanagedConfigPrefixes.some((prefix) => key.startsWith(prefix));
}

function managedFailure(code: IncusFailureCode, details: IncusErrorDetails): ManagedFieldsDiff {
  const error = new IncusError(code, 'managed_failure', details);
  return {
    kind: 'managed_failure',
    empty: false,
    config: {},
    devices: {},
    error: { code, details, error },
  };
}

function compareConfig(
  actual: ManagedStringMap,
  desired: ManagedStringMap,
  ownership: ManagedFieldOwnership,
): Readonly<Record<string, ManagedValueDiff>> {
  const keys = new Set<string>();
  for (const key of Object.keys(actual)) {
    if (isManagedConfigKey(key, ownership)) keys.add(key);
  }
  for (const key of Object.keys(desired)) {
    if (isManagedConfigKey(key, ownership)) keys.add(key);
  }
  const result: Record<string, ManagedValueDiff> = {};
  for (const key of [...keys].sort()) {
    const actualValue = actual[key];
    const desiredValue = desired[key];
    if (normalizeManagedValue(key, actualValue) !== normalizeManagedValue(key, desiredValue)) {
      result[key] = { actual: actualValue, desired: desiredValue };
    }
  }
  return result;
}

function deviceMatches(
  actual: ManagedStringMap | undefined,
  desired: ManagedStringMap | undefined,
): boolean {
  if (!actual || !desired) return actual === desired;
  const keys = new Set([...Object.keys(actual), ...Object.keys(desired)]);
  for (const key of keys) {
    if (actual[key] !== desired[key]) return false;
  }
  return true;
}

function compareDevices(
  actual: ManagedDeviceMap,
  desired: ManagedDeviceMap,
): Readonly<Record<string, ManagedDeviceDiff>> {
  const names = new Set([...Object.keys(actual), ...Object.keys(desired)]);
  const result: Record<string, ManagedDeviceDiff> = {};
  for (const name of [...names].sort()) {
    const actualDevice = actual[name];
    const desiredDevice = desired[name];
    if (
      (actualDevice === undefined && desiredDevice !== undefined) ||
      (actualDevice !== undefined && desiredDevice === undefined) ||
      !deviceMatches(actualDevice, desiredDevice)
    ) {
      result[name] = { actual: actualDevice, desired: desiredDevice };
    }
  }
  return result;
}

function validateEth0(
  devices: ManagedDeviceMap,
  source: 'actual' | 'desired',
): ManagedFieldsDiff | undefined {
  const eth0 = devices.eth0;
  if (!eth0 || eth0.type !== 'nic') {
    return managedFailure('MISSING_MANAGED_NETWORK_ADDRESS', {
      source,
      device: 'eth0',
    });
  }
  if (eth0.nictype !== 'bridged') {
    return managedFailure('INVALID_MANAGED_NETWORK_TYPE', {
      source,
      device: 'eth0',
      nictype: eth0.nictype ?? '',
    });
  }
  if (source !== 'desired') return undefined;
  if (!eth0.parent) {
    return managedFailure('INVALID_MANAGED_NETWORK_TYPE', {
      source,
      device: 'eth0',
      key: 'parent',
    });
  }
  if (eth0.name !== 'eth0') {
    return managedFailure('INVALID_MANAGED_NETWORK_TYPE', {
      source,
      device: 'eth0',
      key: 'name',
    });
  }
  if (!eth0.hwaddr) {
    return managedFailure('INVALID_MANAGED_NETWORK_TYPE', {
      source,
      device: 'eth0',
      key: 'hwaddr',
    });
  }
  const address = eth0['ipv4.address'];
  if (!address || isIP(address) !== 4 || address.includes('/')) {
    return managedFailure('INVALID_MANAGED_FILTER_IDENTITY', {
      source,
      device: 'eth0',
      key: 'ipv4.address',
    });
  }
  if (eth0['security.ipv4_filtering'] !== 'true') {
    return managedFailure('INVALID_MANAGED_FILTER_IDENTITY', {
      source,
      device: 'eth0',
      key: 'security.ipv4_filtering',
    });
  }
  if (eth0['security.mac_filtering'] !== 'true') {
    return managedFailure('INVALID_MANAGED_FILTER_IDENTITY', {
      source,
      device: 'eth0',
      key: 'security.mac_filtering',
    });
  }
  return undefined;
}

export function compareManagedFields(
  actualInput: ManagedInstanceDocument,
  desired: DesiredInstanceSpec,
  ownership: ManagedFieldOwnership,
): ManagedFieldsDiff {
  const actual = asManagedDocument(actualInput);
  const expected: ManagedInstanceDocument = {
    config: copyStringMap(desired.config),
    devices: copyDeviceMap(desired.devices),
  };
  const expectedDocument = asManagedDocument(expected);
  const actualNetworkFailure = validateEth0(actual.devices, 'actual');
  if (actualNetworkFailure) return actualNetworkFailure;
  const desiredNetworkFailure = validateEth0(expectedDocument.devices, 'desired');
  if (desiredNetworkFailure) return desiredNetworkFailure;

  const config = compareConfig(actual.config, expectedDocument.config, ownership);
  const devices = compareDevices(actual.devices, expectedDocument.devices);
  const profiles = (actualInput.profiles ?? []).length > 0;
  const empty = Object.keys(config).length === 0 && Object.keys(devices).length === 0 && !profiles;
  return {
    kind: empty ? 'empty' : 'diff',
    empty,
    config,
    devices,
    profiles,
  };
}

/** The document to PUT: Incus-owned config kept, everything else exactly as desired, no profiles. */
export function applyManagedFields(
  actualInput: ManagedInstanceDocument,
  desired: DesiredInstanceSpec,
  ownership: ManagedFieldOwnership,
): ManagedInstanceDocument {
  const actual = asManagedDocument(actualInput);
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(actual.config)) {
    if (!isManagedConfigKey(key, ownership)) config[key] = value;
  }
  for (const [key, value] of Object.entries(copyStringMap(desired.config))) {
    if (isManagedConfigKey(key, ownership)) config[key] = value;
  }
  const devices: Record<string, ManagedStringMap> = {};
  for (const [name, device] of Object.entries(copyDeviceMap(desired.devices))) {
    devices[name] = { ...device };
  }
  return { config, devices, profiles: [] };
}

export function observeRootQuotaPending(
  actualInput: ManagedInstanceDocument,
  pendingSizeBytes?: string | number | bigint,
): RootQuotaObservation {
  const applyQuota = actualInput.config?.['volatile.root.apply_quota'];
  const pending = applyQuota?.trim().toLowerCase() === 'true';
  return {
    pending,
    applyQuota,
    pendingSizeBytes:
      pending && pendingSizeBytes !== undefined ? String(pendingSizeBytes) : undefined,
  };
}
