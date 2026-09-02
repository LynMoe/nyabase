import { isIP } from 'node:net';
import type { DesiredInstanceSpec } from './instance-spec.js';
import { IncusError, type IncusErrorDetails, type IncusFailureCode } from './incus-errors.js';

export type ManagedStringMap = Readonly<Record<string, string>>;
export type ManagedDeviceMap = Readonly<Record<string, ManagedStringMap>>;

export interface ManagedInstanceDocument {
  readonly config?: ManagedStringMap;
  readonly devices?: ManagedDeviceMap;
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

export type ManagedDiffError = ManagedFieldFailure;

export interface ManagedFieldsDiff {
  readonly kind: 'empty' | 'diff' | 'managed_failure';
  readonly empty: boolean;
  readonly config: Readonly<Record<string, ManagedValueDiff>>;
  readonly devices: Readonly<Record<string, ManagedDeviceDiff>>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function canonicalCpuAllowance(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.endsWith('%')) {
    const percent = canonicalDecimal(trimmed.slice(0, -1));
    return percent === undefined ? undefined : `${percent}%`;
  }
  // Time-slice form: <limit>ms/<period>ms (e.g. 50ms/100ms)
  const slice = /^([0-9]+(?:\.[0-9]+)?)ms\/([0-9]+(?:\.[0-9]+)?)ms$/.exec(trimmed);
  if (!slice) return undefined;
  const limit = canonicalDecimal(slice[1]);
  const period = canonicalDecimal(slice[2]);
  if (limit === undefined || period === undefined) return undefined;
  return `${limit}ms/${period}ms`;
}

export function normalizeManagedValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (key === 'limits.memory') return parseMemoryBytes(value) ?? value.trim();
  if (key === 'limits.cpu') return canonicalCpu(value) ?? value.trim();
  if (key === 'limits.cpu.allowance') return canonicalCpuAllowance(value) ?? value.trim();
  return value;
}

export interface ManagedFieldOwnership {
  readonly configPrefixes: readonly string[];
  readonly deviceNames: readonly string[];
  readonly devicePrefixes: readonly string[];
}

export const CORE_MANAGED_FIELD_OWNERSHIP: ManagedFieldOwnership = {
  configPrefixes: ['limits.', 'security.', 'user.nyabase.'],
  deviceNames: ['root', 'eth0'],
  devicePrefixes: ['nyd-'],
};

function isManagedConfigKey(key: string, ownership: ManagedFieldOwnership): boolean {
  return ownership.configPrefixes.some((prefix) => key.startsWith(prefix));
}

function isManagedDeviceName(name: string, ownership: ManagedFieldOwnership): boolean {
  return (
    ownership.deviceNames.includes(name)
    || ownership.devicePrefixes.some((prefix) => name.startsWith(prefix))
  );
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
  for (const [key, expected] of Object.entries(desired)) {
    if (actual[key] !== expected) return false;
  }
  return true;
}

function compareDevices(
  actual: ManagedDeviceMap,
  desired: ManagedDeviceMap,
  ownership: ManagedFieldOwnership,
): Readonly<Record<string, ManagedDeviceDiff>> {
  const names = new Set<string>();
  for (const name of Object.keys(actual)) {
    if (isManagedDeviceName(name, ownership)) names.add(name);
  }
  for (const name of Object.keys(desired)) {
    if (isManagedDeviceName(name, ownership)) names.add(name);
  }
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
  const devices = compareDevices(actual.devices, expectedDocument.devices, ownership);
  const empty = Object.keys(config).length === 0 && Object.keys(devices).length === 0;
  return {
    kind: empty ? 'empty' : 'diff',
    empty,
    config,
    devices,
  };
}

export function applyManagedFields(
  actualInput: ManagedInstanceDocument,
  desired: DesiredInstanceSpec,
  ownership: ManagedFieldOwnership,
): ManagedInstanceDocument {
  const actual = asManagedDocument(actualInput);
  const expected = asManagedDocument({
    config: copyStringMap(desired.config),
    devices: copyDeviceMap(desired.devices),
  });
  const config: Record<string, string> = { ...actual.config };
  for (const key of Object.keys(config)) {
    if (isManagedConfigKey(key, ownership) && expected.config[key] === undefined) {
      delete config[key];
    }
  }
  for (const [key, value] of Object.entries(expected.config)) {
    if (isManagedConfigKey(key, ownership)) config[key] = value;
  }

  const devices: Record<string, ManagedStringMap> = {};
  for (const [name, device] of Object.entries(actual.devices)) {
    if (!isManagedDeviceName(name, ownership)) {
      devices[name] = device;
    }
  }
  for (const [name, device] of Object.entries(expected.devices)) {
    if (isManagedDeviceName(name, ownership)) {
      // Replace eth0 wholesale so filter identity is complete and extra keys
      // cannot survive a merge. Other managed devices still merge.
      devices[name] = name === 'eth0'
        ? { ...device }
        : { ...actual.devices[name], ...device };
    }
  }
  return { config, devices };
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
