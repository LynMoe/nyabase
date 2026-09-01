import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { canonicalPciAddress } from '@nyabase/common';
import type { IncusSchema } from './incus-client.js';
import { IncusError } from './incus-errors.js';

export type InstanceSpecInteger = string | number | bigint;

export interface InstanceImageSourceInput {
  readonly server?: string;
  readonly protocol?: string;
  readonly project?: string;
}

export interface InstanceSpecContainerInput {
  readonly id: string;
  readonly serverId: string;
  readonly generation: number;
  readonly imageFingerprint: string;
  readonly imageSource?: InstanceImageSourceInput;
  readonly cpuMillis: number;
  readonly memBytes: InstanceSpecInteger;
  readonly nvidiaRuntime: boolean;
  readonly nesting?: boolean;
  readonly syscallIntercept?: boolean;
  readonly gpuPciAddresses: readonly string[];
  readonly rootPool: string;
  readonly rootSizeBytes: InstanceSpecInteger;
  readonly routedIp: string;
}

export interface InstanceSpecServerInput {
  readonly id: string;
  readonly parentInterface: string;
  readonly imageSource?: InstanceImageSourceInput;
}

export interface InstanceSpecVolumeInput {
  readonly id: string;
  readonly incusName: string;
  readonly poolName: string;
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

/**
 * Map product millicores onto Incus 6 CPU limits.
 *
 * Incus rejects fractional `limits.cpu` (integer count / cpuset only). A bare
 * `limits.cpu.allowance` percentage is relative to *all host CPUs*, which would
 * silently over-grant millicores on multi-core hosts. Bind an integer core
 * count and apply a CFS time-slice allowance for the fractional remainder:
 * 500 → cpu=1 + 500ms/1000ms; 2500 → cpu=3 + 2500ms/3000ms; 2000 → cpu=2.
 */
function cpuConfig(cpuMillis: number): Record<string, string> {
  const millis = nonNegativeInteger(cpuMillis, 'cpu_millis');
  if (millis === 0) {
    return {};
  }
  const wholeCores = Math.trunc(millis / 1000);
  const remainder = millis % 1000;
  if (remainder === 0) {
    return { 'limits.cpu': String(wholeCores) };
  }
  const cores = wholeCores + 1;
  return {
    'limits.cpu': String(cores),
    'limits.cpu.allowance': `${millis}ms/${cores * 1000}ms`,
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

export function deriveInstanceHwaddr(containerId: string): string {
  const normalizedId = uuid32(containerId, 'container_id');
  const digest = createHash('sha256').update(normalizedId, 'utf8').digest();
  const bytes = [digest[0], digest[1], digest[2], digest[3], digest[4], digest[5]];
  bytes[0] = (bytes[0] & 0xfc) | 0x02;
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

/** Incus physical GPU `pci` option uses a 4-hex domain (sysfs style), not the 8-hex product form. */
function toIncusPciAddress(canonical: string): string {
  const domainEnd = canonical.indexOf(':');
  if (domainEnd <= 0) return canonical;
  return `${canonical.slice(0, domainEnd).slice(-4)}${canonical.slice(domainEnd)}`;
}

function gpuDevices(
  addresses: readonly string[],
  nvidiaRuntime: boolean,
): Record<string, Record<string, string>> {
  if (addresses.length > 0 && !nvidiaRuntime) {
    fail('INVALID_INSTANCE_SPEC', 'gpu_requires_nvidia_runtime');
  }
  const devices: Record<string, Record<string, string>> = {};
  const seen = new Set<string>();
  addresses.forEach((address, index) => {
    const normalized = canonicalPciAddress(address);
    if (!normalized || address.includes('*')) {
      fail('WILDCARD_GPU_SELECTOR', `gpu_${index}`);
    }
    if (seen.has(normalized)) {
      fail('INVALID_INSTANCE_SPEC', `duplicate_gpu_${normalized}`);
    }
    seen.add(normalized);
    devices[`gpu${index}`] = {
      type: 'gpu',
      gputype: 'physical',
      pci: toIncusPciAddress(normalized),
    };
  });
  return devices;
}

export function buildDesiredInstanceSpec(input: InstanceSpecInput): DesiredInstanceSpec {
  const { container, server } = input;
  const containerId = uuid32(container.id, 'container_id');
  const serverId = uuid32(server.id, 'server_id');
  if (container.serverId.replace(/-/g, '').toLowerCase() !== serverId) {
    fail('INVALID_INSTANCE_SPEC', 'container_server_mismatch');
  }
  const generation = nonNegativeInteger(container.generation, 'generation');
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
    ...cpuConfig(container.cpuMillis),
    'limits.memory': memBytes,
    'security.privileged': 'false',
    'security.nesting': String(container.nesting ?? true),
    'security.syscalls.intercept.mknod': String(container.syscallIntercept ?? true),
    'security.syscalls.intercept.setxattr': String(container.syscallIntercept ?? true),
    'nvidia.runtime': String(container.nvidiaRuntime),
    'user.nyabase.managed': 'true',
    'user.nyabase.container_id': containerId,
    'user.nyabase.server_id': serverId,
    'user.nyabase.generation': String(generation),
  };
  const devices: Record<string, Record<string, string>> = {
    root: {
      type: 'disk',
      path: '/',
      pool: rootPool,
      size: rootSizeBytes,
    },
    eth0: {
      type: 'nic',
      nictype: 'bridged',
      parent: parentInterface,
      name: 'eth0',
      hwaddr: deriveInstanceHwaddr(containerId),
      'ipv4.address': routedIp,
      'security.ipv4_filtering': 'true',
      'security.mac_filtering': 'true',
    },
    ...gpuDevices(container.gpuPciAddresses, container.nvidiaRuntime),
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
