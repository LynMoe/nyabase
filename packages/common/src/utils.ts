import {
  INCUS_DEVICE_NAME_PREFIX,
  INCUS_INSTANCE_NAME_PREFIX,
  INCUS_VOLUME_NAME_PREFIX,
} from './constants.js';

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;
const MAX_MATERIALIZED_CIDR_HOSTS = 65_534;
const UUID32_REGEX = /^[0-9a-f]{32}$/;

export function ipToNum(ip: string): number {
  const match = IPV4_REGEX.exec(ip);
  if (!match) throw new Error(`Invalid IPv4 address: ${ip}`);
  let value = 0;
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(match[index]);
    if (octet < 0 || octet > 255) throw new Error(`Invalid IPv4 octet in ${ip}`);
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

export function numToIp(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`Invalid IPv4 number: ${value}`);
  }
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

export function parseCidr(cidr: string): { base: string; prefixLen: number } {
  const match = CIDR_REGEX.exec(cidr);
  if (!match) throw new Error(`Invalid CIDR: ${cidr}`);
  const prefixLen = Number(match[2]);
  if (prefixLen < 0 || prefixLen > 32) {
    throw new Error(`Invalid CIDR prefix length: ${cidr}`);
  }
  ipToNum(match[1]!);
  return { base: match[1]!, prefixLen };
}

export function canonicalIpv4Address(ip: string): string {
  return numToIp(ipToNum(ip));
}

export function canonicalIpv4Cidr(cidr: string): string {
  const { base, prefixLen } = parseCidr(cidr);
  const { networkAddr } = cidrBounds(base, prefixLen);
  return `${numToIp(networkAddr)}/${prefixLen}`;
}

export function ipv4CidrsOverlap(left: string, right: string): boolean {
  const leftParsed = parseCidr(left);
  const rightParsed = parseCidr(right);
  const leftBounds = cidrBounds(leftParsed.base, leftParsed.prefixLen);
  const rightBounds = cidrBounds(rightParsed.base, rightParsed.prefixLen);
  return leftBounds.networkAddr <= rightBounds.broadcastAddr
    && rightBounds.networkAddr <= leftBounds.broadcastAddr;
}

/** True when `inner` is entirely contained in `outer` (equal CIDRs count as contained). */
export function ipv4CidrContains(outer: string, inner: string): boolean {
  const outerParsed = parseCidr(outer);
  const innerParsed = parseCidr(inner);
  if (innerParsed.prefixLen < outerParsed.prefixLen) return false;
  const outerBounds = cidrBounds(outerParsed.base, outerParsed.prefixLen);
  const innerBounds = cidrBounds(innerParsed.base, innerParsed.prefixLen);
  return innerBounds.networkAddr >= outerBounds.networkAddr
    && innerBounds.broadcastAddr <= outerBounds.broadcastAddr;
}

export function cidrToIps(cidr: string, reservedIps: string[] = []): string[] {
  const { base, prefixLen } = parseCidr(cidr);
  const { networkAddr, broadcastAddr, usableHosts } = cidrBounds(base, prefixLen);
  if (usableHosts === 0) return [];
  if (usableHosts > MAX_MATERIALIZED_CIDR_HOSTS) {
    throw new Error(`CIDR is too large to materialize safely: ${cidr}`);
  }

  const reserved = new Set<string>();
  for (const ip of reservedIps) {
    const canonical = canonicalIpv4Address(ip);
    reserved.add(canonical);
  }

  const ips: string[] = [];
  for (let value = networkAddr + 1; value < broadcastAddr; value += 1) {
    const ip = numToIp(value);
    if (!reserved.has(ip)) ips.push(ip);
  }
  return ips;
}

export function allocateNextIp(
  cidr: string,
  usedIps: Set<string>,
  reservedIps: string[] = [],
): string | null {
  const { base, prefixLen } = parseCidr(cidr);
  const { networkAddr, broadcastAddr, usableHosts } = cidrBounds(base, prefixLen);
  if (usableHosts > MAX_MATERIALIZED_CIDR_HOSTS) {
    throw new Error(`CIDR is too large for bounded allocation: ${cidr}`);
  }
  const reserved = new Set(reservedIps.map(canonicalIpv4Address));
  const used = new Set([...usedIps].map(canonicalIpv4Address));
  for (let value = networkAddr + 1; value < broadcastAddr; value += 1) {
    const ip = numToIp(value);
    if (!reserved.has(ip) && !used.has(ip)) return ip;
  }
  return null;
}

export function isUsableHostInCidr(cidr: string, ip: string): boolean {
  try {
    const { base, prefixLen } = parseCidr(cidr);
    const { networkAddr, broadcastAddr } = cidrBounds(base, prefixLen);
    const numeric = ipToNum(ip);
    return numeric > networkAddr && numeric < broadcastAddr;
  } catch {
    return false;
  }
}

export function deriveIncusInstanceName(resourceId: string): string {
  return `${INCUS_INSTANCE_NAME_PREFIX}${uuid32(resourceId)}`;
}

export function deriveIncusVolumeName(resourceId: string): string {
  return `${INCUS_VOLUME_NAME_PREFIX}${uuid32(resourceId)}`;
}

export function deriveIncusDeviceName(resourceId: string): string {
  return `${INCUS_DEVICE_NAME_PREFIX}${uuid32(resourceId)}`;
}

export function isIncusInstanceName(value: string): boolean {
  return /^nyc-[0-9a-f]{32}$/.test(value);
}

export function isIncusVolumeName(value: string): boolean {
  return /^nyv-[0-9a-f]{32}$/.test(value);
}

export function isIncusDeviceName(value: string): boolean {
  return /^nyd-[0-9a-f]{32}$/.test(value);
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
  const base = 1024;
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(base)));
  return `${parseFloat((bytes / Math.pow(base, index)).toFixed(decimals))} ${units[index]}`;
}

export function generateToken(byteLength = 16): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error('generateToken: byteLength must be a positive integer');
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function uuid32(value: string): string {
  const compact = value.replaceAll('-', '').toLowerCase();
  if (!UUID32_REGEX.test(compact)) {
    throw new Error('Expected a UUID resource identity');
  }
  return compact;
}

function cidrBounds(base: string, prefixLen: number): {
  networkAddr: number;
  broadcastAddr: number;
  usableHosts: number;
} {
  const baseNum = ipToNum(base);
  const hostBits = 32 - prefixLen;
  const size = 2 ** hostBits;
  const networkAddr = Math.floor(baseNum / size) * size;
  const broadcastAddr = networkAddr + size - 1;
  return {
    networkAddr,
    broadcastAddr,
    usableHosts: hostBits <= 1 ? 0 : size - 2,
  };
}
